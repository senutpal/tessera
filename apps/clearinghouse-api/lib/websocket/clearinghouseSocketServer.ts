import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type EventBus,
  type GridDeltaBatch,
  type GridDeltaTransformer,
  getMicrosecondTimestamp,
} from "@tessera/event-bus";
import { WebSocket, WebSocketServer } from "ws";
import { type ClientSession, SessionManager } from "./sessionManager.js";

export interface AuthenticateResult {
  authenticated: boolean;
  userId?: string;
}

export type AuthenticateFunction = (
  req: IncomingMessage,
  token?: string,
) => Promise<boolean | AuthenticateResult> | boolean | AuthenticateResult;

export interface ClearinghouseSocketServerOptions {
  port?: number;
  host?: string;
  server?: Server;
  path?: string;
  heartbeatIntervalMs?: number;
  highWaterMark?: number;
  transformer?: GridDeltaTransformer;
  eventBus?: EventBus;
  authenticate?: AuthenticateFunction;
}

export class ClearinghouseSocketServer extends EventEmitter {
  private wss: WebSocketServer | undefined = undefined;
  private httpServer: Server | undefined = undefined;
  private ownsHttpServer = false;
  private sessionManager = new SessionManager();
  private heartbeatTimer: NodeJS.Timeout | undefined = undefined;
  private transformerUnsubscribe: (() => void) | undefined = undefined;
  private eventBusUnsubscribe: (() => void) | undefined = undefined;
  private portNum = 0;

  constructor(private readonly options: ClearinghouseSocketServerOptions = {}) {
    super();
  }

  get port(): number {
    return this.portNum;
  }

  get clientCount(): number {
    return this.sessionManager.count;
  }

  getSessions(): Map<string, ClientSession> {
    const map = new Map<string, ClientSession>();
    for (const session of this.sessionManager.getAllSessions()) {
      map.set(session.id, session);
    }
    return map;
  }

  async start(): Promise<void> {
    const path = this.options.path ?? "/ws/clearinghouse";
    const heartbeatIntervalMs = this.options.heartbeatIntervalMs ?? 30000;

    if (this.options.server) {
      this.httpServer = this.options.server;
      this.ownsHttpServer = false;
      const addr = this.httpServer.address();
      if (addr && typeof addr === "object") {
        this.portNum = (addr as AddressInfo).port;
      }
    } else {
      this.httpServer = createServer();
      this.ownsHttpServer = true;
      const port = this.options.port ?? 3001;
      const host = this.options.host ?? "0.0.0.0";

      await new Promise<void>((resolve, reject) => {
        if (!this.httpServer) {
          reject(new Error("HTTP server not initialized"));
          return;
        }
        this.httpServer.listen(port, host, () => {
          const addr = this.httpServer?.address() as AddressInfo;
          this.portNum = addr.port;
          resolve();
        });
        this.httpServer.once("error", reject);
      });
    }

    this.wss = new WebSocketServer({
      server: this.httpServer,
      path,
      maxPayload: 64 * 1024,
    });

    this.wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
      this.handleConnection(socket, req).catch((err) => {
        console.error("[ClearinghouseSocketServer] Connection handling error:", err);
        socket.terminate();
      });
    });

    // Start 30s heartbeat interval
    this.heartbeatTimer = setInterval(() => {
      this.runHeartbeat();
    }, heartbeatIntervalMs);

    // If a GridDeltaTransformer is provided, stream deltas to clients
    if (this.options.transformer) {
      this.transformerUnsubscribe = this.options.transformer.onBatch((batch) => {
        this.broadcastBatch("ledger", batch);
      });
    }

    // If an EventBus is provided, wire it to the transformer automatically
    if (this.options.eventBus && this.options.transformer) {
      this.eventBusUnsubscribe = this.options.transformer.attachToBus(this.options.eventBus);
    }
  }

  private sendToSocket(socket: WebSocket, message: string): boolean {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(message);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private async handleConnection(socket: WebSocket, req: IncomingMessage): Promise<void> {
    const earlyMessages: unknown[] = [];
    const earlyMsgHandler = (raw: unknown) => {
      earlyMessages.push(raw);
    };
    socket.on("message", earlyMsgHandler);

    const url = new URL(req.url ?? "", "http://localhost");
    const token =
      url.searchParams.get("token") || req.headers.authorization?.replace(/^Bearer\s+/i, "");

    let authenticated = true;
    let userId: string | undefined;

    if (this.options.authenticate) {
      try {
        const authResult = await this.options.authenticate(req, token ?? undefined);
        if (typeof authResult === "boolean") {
          authenticated = authResult;
        } else {
          authenticated = authResult.authenticated;
          userId = authResult.userId;
        }
      } catch {
        authenticated = false;
      }

      if (!authenticated) {
        socket.off("message", earlyMsgHandler);
        socket.close(4001, "Unauthorized");
        return;
      }
    }

    socket.off("message", earlyMsgHandler);

    const sessionId = `sess-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const session: ClientSession = {
      id: sessionId,
      socket,
      ip: req.socket.remoteAddress || "127.0.0.1",
      connectedAt: new Date().toISOString(),
      channels: new Set(["ledger"]),
      isAlive: true,
      lastPing: Date.now(),
      lastPong: Date.now(),
      authenticated,
      userId,
    };

    // Immediately hydrate client with state snapshot before subscribing to broadcast channel
    this.sendSnapshot(session);

    this.sessionManager.addSession(session);
    this.emit("client_connected", session);

    // Native pong frame handler
    socket.on("pong", () => {
      session.isAlive = true;
      session.lastPong = Date.now();
    });

    // Incoming messages
    socket.on("message", (raw) => {
      try {
        const parsed = JSON.parse(raw.toString());
        this.handleClientMessage(session, parsed);
      } catch (_err) {
        // Non-JSON or invalid frame
      }
    });

    socket.on("close", () => {
      const removed = this.sessionManager.removeSession(sessionId);
      if (removed) {
        this.emit("client_disconnected", session);
      }
    });

    socket.on("error", (err) => {
      if (this.listenerCount("client_error") > 0) {
        this.emit("client_error", err, session);
      } else if (this.listenerCount("error") > 0) {
        this.emit("error", err, session);
      } else {
        console.error("[ClearinghouseSocketServer] Client socket error:", err);
      }
      const removed = this.sessionManager.removeSession(sessionId);
      if (removed) {
        this.emit("client_disconnected", session);
      }
      socket.terminate();
    });

    // Replay any early messages received during authentication
    for (const raw of earlyMessages) {
      try {
        const parsed = JSON.parse(String(raw));
        this.handleClientMessage(session, parsed);
      } catch {}
    }
  }

  private handleClientMessage(session: ClientSession, msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const message = msg as Record<string, unknown>;

    switch (message.type) {
      case "subscribe": {
        if (typeof message.channel === "string") {
          const chan = message.channel;
          this.sessionManager.subscribe(session.id, chan);
          if (message.ack === true) {
            this.sendToSocket(
              session.socket,
              JSON.stringify({ type: "subscribed", channel: chan }),
            );
          }
          if (chan.startsWith("tx:")) {
            this.sendSnapshot(session, chan);
          }
        }
        break;
      }

      case "unsubscribe": {
        if (typeof message.channel === "string") {
          const chan = message.channel;
          this.sessionManager.unsubscribe(session.id, chan);
          if (message.ack === true) {
            this.sendToSocket(
              session.socket,
              JSON.stringify({ type: "unsubscribed", channel: chan }),
            );
          }
        }
        break;
      }

      case "get_snapshot": {
        const chan = typeof message.channel === "string" ? message.channel : "ledger";
        this.sendSnapshot(session, chan);
        break;
      }

      case "ping": {
        this.sendToSocket(session.socket, JSON.stringify({ type: "pong", timestamp: Date.now() }));
        break;
      }

      case "pong": {
        session.isAlive = true;
        session.lastPong = Date.now();
        break;
      }
    }
  }

  private sendSnapshot(session: ClientSession, channel = "ledger"): void {
    if (session.socket.readyState !== WebSocket.OPEN) return;

    if (this.options.transformer) {
      if (channel.startsWith("tx:")) {
        const txId = channel.substring(3);
        const record = this.options.transformer.getRecord(txId);
        const records = record ? [record] : [];
        this.sendToSocket(
          session.socket,
          JSON.stringify({
            type: "snapshot",
            channel,
            sequenceNumber: record?.sequenceNumber ?? 0,
            timestampMicros: record?.timestampMicros ?? getMicrosecondTimestamp(),
            data: records,
          }),
        );
        return;
      }

      const snapshot = this.options.transformer.getSnapshotBatch();
      const payload = JSON.stringify({
        type: "snapshot",
        channel: "ledger",
        sequenceNumber: snapshot.sequenceNumber,
        timestampMicros: snapshot.timestampMicros,
        data: snapshot.records,
      });
      this.sendToSocket(session.socket, payload);
    } else {
      this.sendToSocket(
        session.socket,
        JSON.stringify({
          type: "snapshot",
          channel,
          sequenceNumber: 0,
          timestampMicros: Date.now() * 1000,
          data: [],
        }),
      );
    }
  }

  private runHeartbeat(): void {
    const sessions = this.sessionManager.getAllSessions();
    for (const session of sessions) {
      if (!session.isAlive) {
        // Did not respond to ping in last cycle
        const removed = this.sessionManager.removeSession(session.id);
        try {
          session.socket.terminate();
        } catch {}
        if (removed) {
          this.emit("client_disconnected", session);
        }
      } else {
        session.isAlive = false;
        session.lastPing = Date.now();
        if (session.socket.readyState === WebSocket.OPEN) {
          try {
            session.socket.ping();
          } catch {}
        }
      }
    }
  }

  broadcastBatch(channel: string, batch: GridDeltaBatch): void {
    const payload = JSON.stringify({
      type: "delta",
      channel,
      sequenceNumber: batch.sequenceNumber,
      timestampMicros: batch.timestampMicros,
      timestamp: batch.timestamp,
      deltas: batch.deltas,
      transaction: batch.transaction,
    });

    this.sendRawToChannel(channel, payload);

    // Also route transaction-specific deltas to subscribers of tx:<transactionId>
    for (const item of batch.deltas) {
      const txChannel = `tx:${item.data.transactionId}`;
      const sessions = this.sessionManager.getSessionsForChannel(txChannel);
      if (sessions.length > 0) {
        const itemBatch: GridDeltaBatch = {
          sequenceNumber: item.data.sequenceNumber,
          timestampMicros: item.data.timestampMicros,
          timestamp: batch.timestamp,
          deltas: [item],
          transaction: {
            add: item.type === "add" ? [item.data] : [],
            update: item.type === "update" ? [item.data] : [],
            remove: item.type === "remove" ? [item.data] : [],
          },
        };
        const itemPayload = JSON.stringify({
          type: "delta",
          channel: txChannel,
          sequenceNumber: itemBatch.sequenceNumber,
          timestampMicros: itemBatch.timestampMicros,
          timestamp: itemBatch.timestamp,
          deltas: itemBatch.deltas,
          transaction: itemBatch.transaction,
        });
        this.sendRawToChannel(txChannel, itemPayload);
      }
    }
  }

  broadcast(channel: string, data: unknown): void {
    const payload = JSON.stringify(data);
    this.sendRawToChannel(channel, payload);
  }

  private sendRawToChannel(channel: string, message: string): void {
    const sessions = this.sessionManager.getSessionsForChannel(channel);
    const highWaterMark = this.options.highWaterMark ?? 1048576; // 1 MB

    for (const session of sessions) {
      if (session.socket.readyState === WebSocket.OPEN) {
        if (session.socket.bufferedAmount > highWaterMark) {
          this.emit("backpressure", session);
          this.sessionManager.removeSession(session.id);
          try {
            session.socket.terminate();
          } catch {}
          continue;
        }
        this.sendToSocket(session.socket, message);
      }
    }
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    if (this.transformerUnsubscribe) {
      this.transformerUnsubscribe();
      this.transformerUnsubscribe = undefined;
    }

    if (this.eventBusUnsubscribe) {
      this.eventBusUnsubscribe();
      this.eventBusUnsubscribe = undefined;
    }

    const sessions = this.sessionManager.getAllSessions();
    for (const session of sessions) {
      try {
        session.socket.close(1001, "Server shutting down");
      } catch {}
    }
    this.sessionManager.clear();

    if (this.wss) {
      const wss = this.wss;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          for (const client of wss.clients) {
            try {
              client.terminate();
            } catch {}
          }
          resolve();
        }, 500);

        wss.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
      this.wss = undefined;
    }

    if (this.ownsHttpServer && this.httpServer) {
      const server = this.httpServer;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      this.httpServer = undefined;
    }
  }
}

export function createClearinghouseSocketServer(
  options: ClearinghouseSocketServerOptions = {},
): ClearinghouseSocketServer {
  return new ClearinghouseSocketServer(options);
}
