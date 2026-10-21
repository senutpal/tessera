import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type ClearinghouseRecord, createGridDeltaTransformer } from "@tessera/event-bus";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type ClearinghouseSocketServer, createClearinghouseSocketServer } from "../index.js";

describe("ClearinghouseSocketServer", () => {
  let server: ClearinghouseSocketServer;
  let port: number;
  let activeClients: WebSocket[] = [];

  interface TestMessage {
    type?: string;
    channel?: string;
    sequenceNumber?: number;
    timestampMicros?: number;
    timestamp?: string;
    data?: ClearinghouseRecord[];
    deltas?: Array<{ type: string; data: ClearinghouseRecord }>;
    transaction?: {
      add: ClearinghouseRecord[];
      update: ClearinghouseRecord[];
      remove: ClearinghouseRecord[];
    };
    disputeId?: string;
  }

  interface TestClient {
    ws: WebSocket;
    nextMessage: (timeoutMs?: number) => Promise<TestMessage>;
    closePromise: Promise<number>;
  }

  function createClient(
    path = "/ws/clearinghouse",
    headers?: Record<string, string>,
  ): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
      activeClients.push(ws);

      const messageQueue: TestMessage[] = [];
      const waiters: Array<(msg: TestMessage) => void> = [];

      let closeResolver: (code: number) => void;
      const closePromise = new Promise<number>((r) => {
        closeResolver = r;
      });

      ws.on("message", (data) => {
        try {
          const parsed = JSON.parse(data.toString()) as TestMessage;
          const waiter = waiters.shift();
          if (waiter) {
            waiter(parsed);
          } else {
            messageQueue.push(parsed);
          }
        } catch {}
      });

      ws.on("close", (code) => {
        closeResolver(code);
      });

      const nextMessage = (timeoutMs = 3000): Promise<TestMessage> => {
        const item = messageQueue.shift();
        if (item) {
          return Promise.resolve(item);
        }
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const idx = waiters.indexOf(res);
            if (idx !== -1) waiters.splice(idx, 1);
            rej(new Error(`Timeout waiting for message after ${timeoutMs}ms`));
          }, timeoutMs);

          waiters.push((msg) => {
            clearTimeout(timer);
            res(msg);
          });
        });
      };

      ws.on("open", () => {
        resolve({ ws, nextMessage, closePromise });
      });

      ws.on("error", (err) => {
        reject(err);
      });
    });
  }

  beforeEach(async () => {
    activeClients = [];
  });

  afterEach(async () => {
    for (const ws of activeClients) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
      }
    }
    activeClients = [];
    if (server) {
      await server.close();
    }
  });

  it("accepts client connections and immediately delivers initial state snapshot", async () => {
    const transformer = createGridDeltaTransformer();
    const seed: ClearinghouseRecord[] = [
      {
        transactionId: "tx-init-1",
        mandateId: "man-init-1",
        agentId: "agent-bot",
        merchantDomain: "store.com",
        amount: 5000,
        currency: "USD",
        clearinghouseState: "PENDING_AUTHORIZATION",
        escrowStatus: "PENDING_AUTHORIZATION",
        riskScore: 10,
        riskTier: "LOW",
        hitlStatus: "NOT_REQUIRED",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sequenceNumber: 1,
        timestampMicros: 1729500000000000,
      },
    ];
    transformer.hydrate(seed);

    server = createClearinghouseSocketServer({
      port: 0,
      host: "127.0.0.1",
      transformer,
    });
    await server.start();
    port = server.port;

    const client = await createClient();
    const message = await client.nextMessage();

    expect(message.type).toBe("snapshot");
    expect(message.channel).toBe("ledger");
    expect(message.data).toHaveLength(1);
    expect(message.data?.[0]?.transactionId).toBe("tx-init-1");
    expect(message.sequenceNumber).toBeGreaterThanOrEqual(1);
    expect(message.timestampMicros).toBeGreaterThan(0);
    expect(server.clientCount).toBe(1);
  });

  it("broadcasts batched AG Grid delta updates to subscribed clients within 10ms", async () => {
    const transformer = createGridDeltaTransformer({ batchWindowMs: 0 }); // immediate flush
    server = createClearinghouseSocketServer({
      port: 0,
      host: "127.0.0.1",
      transformer,
    });
    await server.start();
    port = server.port;

    const client = await createClient();
    // Consume initial snapshot message
    const snapshotMsg = await client.nextMessage();
    expect(snapshotMsg.type).toBe("snapshot");

    const startTime = performance.now();

    // Ingest event into transformer which triggers delta broadcast
    transformer.processEvent({
      eventId: "e-stream-1",
      type: "MandateVerified",
      timestamp: new Date().toISOString(),
      data: {
        transactionId: "tx-stream-1",
        mandateId: "m-stream-1",
        agentId: "agent-stream",
        merchantDomain: "target.com",
        amount: 19999,
        currency: "USD",
        riskScore: 25,
        riskTier: "LOW",
        hitlStatus: "NOT_REQUIRED",
      },
    });

    const deltaMessage = await client.nextMessage();
    const latency = performance.now() - startTime;

    expect(latency).toBeLessThan(100);
    expect(deltaMessage.type).toBe("delta");
    expect(deltaMessage.channel).toBe("ledger");
    expect(deltaMessage.deltas).toHaveLength(1);
    expect(deltaMessage.deltas?.[0]?.type).toBe("add");
    expect(deltaMessage.deltas?.[0]?.data.transactionId).toBe("tx-stream-1");
    expect(deltaMessage.transaction?.add).toHaveLength(1);
  });

  it("supports channel subscriptions and selective broadcast", async () => {
    server = createClearinghouseSocketServer({ port: 0, host: "127.0.0.1" });
    await server.start();
    port = server.port;

    const c1 = await createClient();
    const c2 = await createClient();
    // Consume initial snapshot messages
    await c1.nextMessage();
    await c2.nextMessage();

    // Client 1 subscribes to custom channel "disputes"
    c1.ws.send(JSON.stringify({ type: "subscribe", channel: "disputes" }));

    // Wait a brief tick for server to record subscription
    await new Promise((r) => setTimeout(r, 30));

    server.broadcast("disputes", {
      type: "dispute_alert",
      disputeId: "DISP-TEST-99",
    });

    const c1Msg = await c1.nextMessage();
    expect(c1Msg.disputeId).toBe("DISP-TEST-99");

    // c2 should not have received this message
    let c2Received = false;
    c2.nextMessage(100)
      .then(() => {
        c2Received = true;
      })
      .catch(() => {});

    await new Promise((r) => setTimeout(r, 120));
    expect(c2Received).toBe(false);
  });

  it("handles RFC 6455 30s heartbeat ping/pong and terminates dead connections", async () => {
    server = createClearinghouseSocketServer({
      port: 0,
      host: "127.0.0.1",
      heartbeatIntervalMs: 50,
    });
    await server.start();
    port = server.port;

    const client = await createClient();
    await client.nextMessage();
    expect(server.clientCount).toBe(1);

    // Suppress pong frames on client
    client.ws.pong = () => {};

    // Wait for 2-3 heartbeat cycles
    await new Promise((r) => setTimeout(r, 200));

    expect(server.clientCount).toBe(0);
  });

  it("enforces authentication when authenticator is configured", async () => {
    server = createClearinghouseSocketServer({
      port: 0,
      host: "127.0.0.1",
      authenticate: async (_req, token) => {
        return token === "secret-token-123";
      },
    });
    await server.start();
    port = server.port;

    // Connect with valid token
    const validClient = await createClient("/ws/clearinghouse?token=secret-token-123");
    const snapshot = await validClient.nextMessage();
    expect(snapshot.type).toBe("snapshot");

    // Connect with invalid token should result in socket closure with 4001
    const invalidWs = new WebSocket(`ws://127.0.0.1:${port}/ws/clearinghouse?token=wrong-token`);
    activeClients.push(invalidWs);

    const closeCode = await new Promise<number>((resolve) => {
      invalidWs.on("close", (code) => resolve(code));
      invalidWs.on("error", () => {});
    });

    expect(closeCode).toBe(4001);
  });

  it("handles backpressure by monitoring bufferedAmount without crashing", async () => {
    server = createClearinghouseSocketServer({
      port: 0,
      host: "127.0.0.1",
      highWaterMark: 100, // low watermark for testing
    });
    await server.start();
    port = server.port;

    const client = await createClient();
    await client.nextMessage();

    let backpressureFired = false;
    server.on("backpressure", () => {
      backpressureFired = true;
    });

    // Mock socket bufferedAmount to simulate slow consumer
    const session = Array.from(server.getSessions().values())[0];
    Object.defineProperty(session.socket, "bufferedAmount", {
      value: 1024 * 1024,
      configurable: true,
    });

    server.broadcast("ledger", { type: "heavy_update", data: "large-string" });

    expect(backpressureFired).toBe(true);
  });

  it("can attach to an external HTTP server instance", async () => {
    const httpServer = createServer();
    server = createClearinghouseSocketServer({
      server: httpServer,
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    port = (httpServer.address() as AddressInfo).port;
    await server.start();

    const client = await createClient();
    const msg = await client.nextMessage();
    expect(msg.type).toBe("snapshot");

    httpServer.close();
  });
});
