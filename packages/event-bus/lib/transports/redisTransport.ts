import { Redis, type RedisOptions } from "ioredis";
import { MemoryTransport } from "./memoryTransport.js";
import type { EventBusTransport, MessageHandler } from "./transport.js";

export interface RedisTransportOptions {
  redisUrl?: string;
  redisOptions?: RedisOptions;
  connectTimeoutMs?: number;
  maxRetries?: number;
  fallbackToMemory?: boolean;
}

export class RedisTransport implements EventBusTransport {
  private pubClient: Redis | undefined = undefined;
  private subClient: Redis | undefined = undefined;
  private memoryFallback: MemoryTransport | undefined = undefined;
  private fallbackActive = false;
  private fallbackPromise: Promise<void> | undefined = undefined;
  private connectPromise: Promise<void> | undefined = undefined;
  private connected = false;
  private channelHandlers = new Map<string, Set<MessageHandler>>();
  private memoryUnsubs = new Map<string, Map<MessageHandler, () => Promise<void>>>();

  constructor(private readonly options: RedisTransportOptions = {}) {}

  get type(): "redis" | "memory" {
    return this.fallbackActive ? "memory" : "redis";
  }

  get isConnected(): boolean {
    if (this.fallbackActive && this.memoryFallback) {
      return this.memoryFallback.isConnected;
    }
    return this.connected;
  }

  get isFallbackActive(): boolean {
    return this.fallbackActive;
  }

  connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.connectPromise = (async () => {
      try {
        await this.doConnect();
      } finally {
        this.connectPromise = undefined;
      }
    })();
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    if (this.isConnected) {
      return;
    }
    const fallbackToMemory = this.options.fallbackToMemory ?? true;
    const redisUrl = this.options.redisUrl || process.env.REDIS_URL;

    // If no redisUrl and fallbackToMemory is requested, or if Redis is explicitly disabled
    if (!redisUrl && fallbackToMemory) {
      await this.activateMemoryFallback(
        "No Redis URL provided; operating in memory fallback mode.",
      );
      return;
    }

    const connectTimeoutMs = this.options.connectTimeoutMs ?? 2000;
    const maxRetries = this.options.maxRetries ?? 1;

    try {
      const clientOptions: RedisOptions = {
        connectTimeout: connectTimeoutMs,
        maxRetriesPerRequest: maxRetries,
        retryStrategy: () => null, // Do not auto-reconnect indefinitely if server is offline during initial test
        lazyConnect: true,
        enableOfflineQueue: false,
        ...this.options.redisOptions,
      };

      const url = redisUrl || "redis://127.0.0.1:6379";
      const RedisCtor = Redis as unknown as new (url: string, opts?: unknown) => Redis;
      this.pubClient = new RedisCtor(url, clientOptions);
      this.subClient = new RedisCtor(url, clientOptions);

      // Handle redis error events to prevent unhandled node process exceptions
      this.pubClient.on("error", (err) => {
        if (!this.fallbackActive && fallbackToMemory) {
          this.activateMemoryFallback(`Redis publisher error: ${err.message}`).catch(() => {});
        }
      });
      this.subClient.on("error", (err) => {
        if (!this.fallbackActive && fallbackToMemory) {
          this.activateMemoryFallback(`Redis subscriber error: ${err.message}`).catch(() => {});
        }
      });

      // Connect with timeout guard and proper cleanup
      let timerId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerId = setTimeout(
          () => reject(new Error(`Redis connection timed out after ${connectTimeoutMs}ms`)),
          connectTimeoutMs,
        );
      });

      const redisConnectPromise = Promise.all([this.pubClient.connect(), this.subClient.connect()]);
      redisConnectPromise.catch(() => {});

      try {
        await Promise.race([redisConnectPromise, timeoutPromise]);
      } finally {
        if (timerId) clearTimeout(timerId);
      }

      if (this.fallbackActive || !this.subClient) {
        return;
      }

      this.subClient.on("message", (channel, message) => {
        const handlers = this.channelHandlers.get(channel);
        if (handlers) {
          for (const handler of handlers) {
            try {
              const res = handler(message);
              if (res && typeof (res as Promise<void>).catch === "function") {
                (res as Promise<void>).catch((err) => {
                  console.error(
                    `[RedisTransport] Error dispatching message on channel ${channel}:`,
                    err,
                  );
                });
              }
            } catch (err) {
              console.error(
                `[RedisTransport] Error dispatching message on channel ${channel}:`,
                err,
              );
            }
          }
        }
      });

      // Subscribe to any pre-registered channels
      for (const channel of this.channelHandlers.keys()) {
        await this.subClient.subscribe(channel);
      }

      this.connected = true;
    } catch (err) {
      if (fallbackToMemory) {
        await this.activateMemoryFallback(
          `Failed to connect to Redis (${(err as Error).message}); activating in-memory fallback.`,
        );
      } else {
        throw err;
      }
    }
  }

  private async activateMemoryFallback(_reason: string): Promise<void> {
    if (this.fallbackActive) {
      if (this.fallbackPromise) {
        await this.fallbackPromise;
      }
      return;
    }
    this.fallbackActive = true;
    this.connected = false;

    this.fallbackPromise = (async () => {
      // Disconnect any hanging redis sockets cleanly
      if (this.pubClient) {
        try {
          this.pubClient.disconnect(false);
        } catch {}
        this.pubClient = undefined;
      }
      if (this.subClient) {
        try {
          this.subClient.disconnect(false);
        } catch {}
        this.subClient = undefined;
      }

      this.memoryFallback = new MemoryTransport();
      await this.memoryFallback.connect();

      // Re-register any existing channel handlers in memory transport
      for (const [channel, handlers] of this.channelHandlers.entries()) {
        let chanMap = this.memoryUnsubs.get(channel);
        if (!chanMap) {
          chanMap = new Map();
          this.memoryUnsubs.set(channel, chanMap);
        }
        for (const handler of handlers) {
          if (!chanMap.has(handler)) {
            const unsub = await this.memoryFallback.subscribe(channel, handler);
            chanMap.set(handler, unsub);
          }
        }
      }
    })();

    try {
      await this.fallbackPromise;
    } finally {
      this.fallbackPromise = undefined;
    }
  }

  async publish(channel: string, message: string): Promise<void> {
    if (this.fallbackActive) {
      if (this.fallbackPromise) {
        await this.fallbackPromise;
      }
      if (this.memoryFallback) {
        return this.memoryFallback.publish(channel, message);
      }
    }

    if (!this.connected || !this.pubClient) {
      if (this.options.fallbackToMemory ?? true) {
        await this.activateMemoryFallback(
          "Redis publisher disconnected during publish; switching to memory.",
        );
        if (this.memoryFallback) {
          return this.memoryFallback.publish(channel, message);
        }
        return;
      }
      throw new Error("RedisTransport is not connected");
    }

    try {
      await this.pubClient.publish(channel, message);
    } catch (err) {
      if (this.options.fallbackToMemory ?? true) {
        await this.activateMemoryFallback(`Redis publish error: ${(err as Error).message}`);
        if (this.memoryFallback) {
          return this.memoryFallback.publish(channel, message);
        }
        return;
      }
      throw err;
    }
  }

  async subscribe(channel: string, handler: MessageHandler): Promise<() => Promise<void>> {
    let handlers = this.channelHandlers.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.channelHandlers.set(channel, handlers);
    }
    handlers.add(handler);

    if (this.fallbackActive) {
      if (this.fallbackPromise) {
        await this.fallbackPromise;
      }
      if (this.memoryFallback) {
        let chanMap = this.memoryUnsubs.get(channel);
        if (!chanMap) {
          chanMap = new Map();
          this.memoryUnsubs.set(channel, chanMap);
        }
        const unsub = await this.memoryFallback.subscribe(channel, handler);
        chanMap.set(handler, unsub);
      }
    } else if (this.connected && this.subClient) {
      await this.subClient.subscribe(channel);
    }

    return async () => {
      const set = this.channelHandlers.get(channel);
      if (set) {
        set.delete(handler);
        if (set.size === 0) {
          this.channelHandlers.delete(channel);
          if (this.connected && this.subClient) {
            try {
              await this.subClient.unsubscribe(channel);
            } catch {}
          }
        }
      }
      const chanMap = this.memoryUnsubs.get(channel);
      if (chanMap) {
        const memUnsub = chanMap.get(handler);
        if (memUnsub) {
          chanMap.delete(handler);
          if (chanMap.size === 0) {
            this.memoryUnsubs.delete(channel);
          }
          await memUnsub();
        }
      }
    };
  }

  async close(): Promise<void> {
    this.connected = false;
    this.channelHandlers.clear();
    this.memoryUnsubs.clear();

    if (this.memoryFallback) {
      await this.memoryFallback.close();
      this.memoryFallback = undefined;
    }

    const closeClient = async (client?: Redis) => {
      if (!client) return;
      try {
        const quitPromise = client.quit();
        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 300));
        await Promise.race([quitPromise, timeoutPromise]);
      } catch {
        client.disconnect(false);
      }
    };

    const pub = this.pubClient;
    const sub = this.subClient;
    this.pubClient = undefined;
    this.subClient = undefined;

    await Promise.all([closeClient(pub), closeClient(sub)]);
  }
}
