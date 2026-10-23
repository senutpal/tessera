import type { IncomingMessage, ServerResponse } from "node:http";

export interface RedisClientLike {
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number | string>;
  zcard(key: string): Promise<number>;
  pexpire(key: string, milliseconds: number): Promise<number>;
}

export interface RateLimiterOptions {
  redis?: RedisClientLike | undefined;
  windowMs?: number | undefined; // Window duration in milliseconds (default: 60,000ms)
  max?: number | undefined; // Max allowed requests per window (default: 100)
  keyPrefix?: string | undefined; // Key prefix (default: "rl:")
  trustProxyHops?: number | undefined; // Number of trusted reverse proxy hops (default: 0)
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetTimeMs: number;
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly redis?: RedisClientLike | undefined;
  private readonly windowMs: number;
  private readonly max: number;
  private readonly keyPrefix: string;
  private readonly memoryBuckets = new Map<string, number[]>();

  constructor(options: RateLimiterOptions = {}) {
    this.redis = options.redis;
    this.windowMs = options.windowMs ?? 60000;
    this.max = options.max ?? 100;
    this.keyPrefix = options.keyPrefix ?? "rl:";
  }

  public async checkLimit(identifier: string): Promise<RateLimitResult> {
    const key = `${this.keyPrefix}${identifier}`;
    const now = Date.now();
    const windowStart = now - this.windowMs;

    if (this.redis) {
      try {
        await this.redis.zremrangebyscore(key, 0, windowStart);
        const count = await this.redis.zcard(key);

        if (count >= this.max) {
          const resetTimeMs = now + this.windowMs;
          const retryAfterSeconds = Math.max(1, Math.ceil(this.windowMs / 1000));
          return {
            allowed: false,
            limit: this.max,
            remaining: 0,
            resetTimeMs,
            retryAfterSeconds,
          };
        }

        const member = `${now}-${Math.random().toString(36).substring(2, 9)}`;
        await this.redis.zadd(key, now, member);
        await this.redis.pexpire(key, this.windowMs);

        const remaining = Math.max(0, this.max - (count + 1));
        const resetTimeMs = now + this.windowMs;

        return {
          allowed: true,
          limit: this.max,
          remaining,
          resetTimeMs,
          retryAfterSeconds: 0,
        };
      } catch {
        // Fallback gracefully to in-memory sliding window if Redis call fails
        return this.checkMemoryLimit(identifier, now, windowStart);
      }
    }

    return this.checkMemoryLimit(identifier, now, windowStart);
  }

  private checkMemoryLimit(identifier: string, now: number, windowStart: number): RateLimitResult {
    let timestamps = this.memoryBuckets.get(identifier) ?? [];
    // Prune timestamps outside sliding window
    timestamps = timestamps.filter((t) => t > windowStart);

    // Periodic cleanup of stale client buckets if map exceeds threshold
    if (this.memoryBuckets.size > 2000) {
      for (const [key, list] of this.memoryBuckets.entries()) {
        const active = list.filter((t) => t > windowStart);
        if (active.length === 0) {
          this.memoryBuckets.delete(key);
        } else {
          this.memoryBuckets.set(key, active);
        }
      }
    }

    if (timestamps.length >= this.max) {
      const oldestInWindow = timestamps[0] ?? now;
      const resetTimeMs = oldestInWindow + this.windowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((resetTimeMs - now) / 1000));

      this.memoryBuckets.set(identifier, timestamps);
      return {
        allowed: false,
        limit: this.max,
        remaining: 0,
        resetTimeMs,
        retryAfterSeconds,
      };
    }

    timestamps.push(now);
    this.memoryBuckets.set(identifier, timestamps);

    const remaining = Math.max(0, this.max - timestamps.length);
    const resetTimeMs = now + this.windowMs;

    return {
      allowed: true,
      limit: this.max,
      remaining,
      resetTimeMs,
      retryAfterSeconds: 0,
    };
  }

  public reset(identifier?: string): void {
    if (identifier) {
      this.memoryBuckets.delete(identifier);
    } else {
      this.memoryBuckets.clear();
    }
  }
}

/**
 * Extracts a client identifier from HTTP request headers or socket address.
 * Proxy headers (X-Forwarded-For) are only evaluated when trustProxyHops > 0,
 * reading from the rightmost proxy hop to prevent spoofing.
 */
export function extractClientIdentifier(req: IncomingMessage, trustProxyHops = 0): string {
  if (trustProxyHops > 0) {
    const forwarded = req.headers["x-forwarded-for"];
    let entries: string[] = [];

    if (typeof forwarded === "string" && forwarded.trim().length > 0) {
      entries = forwarded
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (Array.isArray(forwarded) && forwarded.length > 0) {
      entries = forwarded.flatMap((item) =>
        item
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      );
    }

    if (entries.length >= trustProxyHops) {
      const selected = entries[entries.length - trustProxyHops];
      if (selected) return selected;
    }
  }

  return req.socket?.remoteAddress || "127.0.0.1";
}

/**
 * Creates sliding window rate limiter middleware.
 * Returns true if request is permitted to proceed, or false if rejected with HTTP 429.
 */
export function createRateLimitMiddleware(options: RateLimiterOptions = {}) {
  const limiter = new RateLimiter(options);
  const trustProxyHops = options.trustProxyHops ?? 0;

  return async (req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<boolean> => {
    const id = extractClientIdentifier(req, trustProxyHops);
    const result = await limiter.checkLimit(id);

    res.setHeader("X-RateLimit-Limit", String(result.limit));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(result.resetTimeMs / 1000)));

    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "TOO_MANY_REQUESTS",
          message: "Rate limit exceeded. Please retry after specified delay.",
          retryAfter: result.retryAfterSeconds,
        }),
      );
      return false;
    }

    if (next) {
      next();
    }
    return true;
  };
}
