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
  private connected = false;
  private channelHandlers = new Map<string, Set<MessageHandler>>();

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

  async connect(): Promise<void> {
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

      // Connect with timeout guard
      await Promise.race([
        Promise.all([this.pubClient.connect(), this.subClient.connect()]),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Redis connection timed out after ${connectTimeoutMs}ms`)),
            connectTimeoutMs,
          ),
        ),
      ]);

      this.subClient.on("message", (channel, message) => {
        const handlers = this.channelHandlers.get(channel);
        if (handlers) {
          for (const handler of handlers) {
            try {
              void handler(message);
            } catch (err) {
              console.error(
                `[RedisTransport] Error dispatching message on channel ${channel}:`,
                err,
              );
            }
          }
        }
      });

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
    if (this.fallbackActive) return;
    this.fallbackActive = true;
    this.connected = false;

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
      for (const handler of handlers) {
        await this.memoryFallback.subscribe(channel, handler);
      }
    }
  }

  async publish(channel: string, message: string): Promise<void> {
    if (this.fallbackActive && this.memoryFallback) {
      return this.memoryFallback.publish(channel, message);
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

    if (this.fallbackActive && this.memoryFallback) {
      return this.memoryFallback.subscribe(channel, handler);
    }

    if (this.connected && this.subClient) {
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
    };
  }

  async close(): Promise<void> {
    this.connected = false;
    this.channelHandlers.clear();

    if (this.memoryFallback) {
      await this.memoryFallback.close();
      this.memoryFallback = undefined;
    }

    if (this.pubClient) {
      try {
        await this.pubClient.quit();
      } catch {
        this.pubClient.disconnect(false);
      }
      this.pubClient = undefined;
    }

    if (this.subClient) {
      try {
        await this.subClient.quit();
      } catch {
        this.subClient.disconnect(false);
      }
      this.subClient = undefined;
    }
  }
}
