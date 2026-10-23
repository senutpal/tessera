import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  createRateLimitMiddleware,
  extractClientIdentifier,
  RateLimiter,
  type RedisClientLike,
} from "../index.js";

describe("Rate Limiter Middleware", () => {
  it("enforces in-memory sliding window rate limits", async () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 3 });

    const r1 = await limiter.checkLimit("client-1");
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await limiter.checkLimit("client-1");
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await limiter.checkLimit("client-1");
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    const r4 = await limiter.checkLimit("client-1");
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.retryAfterSeconds).toBeGreaterThan(0);

    // Another client is not throttled
    const other = await limiter.checkLimit("client-2");
    expect(other.allowed).toBe(true);
    expect(other.remaining).toBe(2);
  });

  it("resets counters after sliding window duration expires", async () => {
    const limiter = new RateLimiter({ windowMs: 50, max: 2 });

    await limiter.checkLimit("client-fast");
    await limiter.checkLimit("client-fast");
    const blocked = await limiter.checkLimit("client-fast");
    expect(blocked.allowed).toBe(false);

    // Wait for window to slide
    await new Promise((resolve) => setTimeout(resolve, 60));

    const resetResult = await limiter.checkLimit("client-fast");
    expect(resetResult.allowed).toBe(true);
    expect(resetResult.remaining).toBe(1);
  });

  it("delegates to Redis sliding window sorted set when provided", async () => {
    const calls: string[] = [];
    let count = 0;

    const mockRedis: RedisClientLike = {
      zremrangebyscore: async (_k, _min, _max) => {
        calls.push("zremrangebyscore");
        return 0;
      },
      zcard: async (_k) => {
        calls.push("zcard");
        return count;
      },
      zadd: async (_k, _s, _m) => {
        calls.push("zadd");
        count++;
        return 1;
      },
      pexpire: async (_k, _ms) => {
        calls.push("pexpire");
        return 1;
      },
    };

    const limiter = new RateLimiter({ redis: mockRedis, windowMs: 5000, max: 2 });

    const r1 = await limiter.checkLimit("redis-client");
    expect(r1.allowed).toBe(true);
    expect(calls).toContain("zremrangebyscore");
    expect(calls).toContain("zcard");
    expect(calls).toContain("zadd");
    expect(calls).toContain("pexpire");

    const r2 = await limiter.checkLimit("redis-client");
    expect(r2.allowed).toBe(true);

    const r3 = await limiter.checkLimit("redis-client");
    expect(r3.allowed).toBe(false);
    expect(r3.retryAfterSeconds).toBe(5);
  });

  it("falls back to in-memory store if Redis throws error", async () => {
    const failingRedis: RedisClientLike = {
      zremrangebyscore: async () => {
        throw new Error("Redis connection refused");
      },
      zcard: async () => {
        throw new Error("Redis connection refused");
      },
      zadd: async () => {
        throw new Error("Redis connection refused");
      },
      pexpire: async () => {
        throw new Error("Redis connection refused");
      },
    };

    const limiter = new RateLimiter({ redis: failingRedis, windowMs: 2000, max: 2 });

    const r1 = await limiter.checkLimit("resilient-client");
    expect(r1.allowed).toBe(true);
    const r2 = await limiter.checkLimit("resilient-client");
    expect(r2.allowed).toBe(true);
    const r3 = await limiter.checkLimit("resilient-client");
    expect(r3.allowed).toBe(false);
  });

  it("extracts client identifiers accurately with anti-spoofing proxy hop controls", () => {
    // 1. By default (trustProxyHops = 0), proxy headers are untrusted and ignored
    const reqSpoofed = {
      headers: { "x-forwarded-for": "203.0.113.195, 70.41.3.18", "x-real-ip": "1.2.3.4" },
      socket: { remoteAddress: "192.0.2.1" },
    } as unknown as IncomingMessage;
    expect(extractClientIdentifier(reqSpoofed)).toBe("192.0.2.1");
    expect(extractClientIdentifier(reqSpoofed, 0)).toBe("192.0.2.1");

    // 2. When trustProxyHops = 1, reads the rightmost trusted proxy hop
    expect(extractClientIdentifier(reqSpoofed, 1)).toBe("70.41.3.18");

    // 3. When trustProxyHops = 2, reads the second hop from the right
    expect(extractClientIdentifier(reqSpoofed, 2)).toBe("203.0.113.195");

    // 4. Array-based X-Forwarded-For headers
    const reqArrayForwarded = {
      headers: { "x-forwarded-for": ["198.51.100.99, 10.0.0.1"] },
      socket: { remoteAddress: "192.0.2.1" },
    } as unknown as IncomingMessage;
    expect(extractClientIdentifier(reqArrayForwarded, 1)).toBe("10.0.0.1");
    expect(extractClientIdentifier(reqArrayForwarded, 2)).toBe("198.51.100.99");

    // 5. When hop count exceeds entry count, falls back to socket address
    expect(extractClientIdentifier(reqSpoofed, 5)).toBe("192.0.2.1");

    // 6. Direct socket connection without proxy headers
    const reqDirect = {
      headers: {},
      socket: { remoteAddress: "192.0.2.1" },
    } as unknown as IncomingMessage;
    expect(extractClientIdentifier(reqDirect)).toBe("192.0.2.1");
  });

  it("sets HTTP 429 and Retry-After headers when rate limit is exceeded in middleware", async () => {
    const middleware = createRateLimitMiddleware({ windowMs: 1000, max: 1 });

    const headersMap = new Map<string, string>();
    let statusCode = 200;
    let responseBody = "";

    const createMockRes = () =>
      ({
        setHeader: (k: string, v: string) => headersMap.set(k, v),
        writeHead: (code: number) => {
          statusCode = code;
        },
        end: (body: string) => {
          responseBody = body;
        },
      }) as unknown as ServerResponse;

    const mockReq = {
      headers: { "x-forwarded-for": "10.0.0.1" },
    } as unknown as IncomingMessage;

    // First request - allowed
    const ok = await middleware(mockReq, createMockRes());
    expect(ok).toBe(true);
    expect(headersMap.get("X-RateLimit-Limit")).toBe("1");
    expect(headersMap.get("X-RateLimit-Remaining")).toBe("0");

    // Second request - rejected with 429
    const blocked = await middleware(mockReq, createMockRes());
    expect(blocked).toBe(false);
    expect(statusCode).toBe(429);
    expect(headersMap.get("Retry-After")).toBeDefined();
    const json = JSON.parse(responseBody);
    expect(json.error).toBe("TOO_MANY_REQUESTS");
  });
});
