import { describe, expect, it, vi } from "vitest";
import { InMemoryNonceStore, type RedisClientLike, RedisNonceStore } from "../index.js";

describe("Anti-Replay Nonce Store", () => {
  describe("InMemoryNonceStore", () => {
    it("allows registering an unused nonce and consumes it atomically", async () => {
      const store = new InMemoryNonceStore();
      const nonce = "nonce-abc-123";

      expect(await store.hasNonce(nonce)).toBe(false);
      const consumedFirst = await store.consumeNonce(nonce, 60);
      expect(consumedFirst).toBe(true);

      expect(await store.hasNonce(nonce)).toBe(true);
    });

    it("rejects duplicate registration of the same nonce within its TTL", async () => {
      const store = new InMemoryNonceStore();
      const nonce = "replay-nonce-456";

      const first = await store.consumeNonce(nonce, 60);
      expect(first).toBe(true);

      const second = await store.consumeNonce(nonce, 60);
      expect(second).toBe(false);
    });

    it("permits reusing a nonce after its TTL has expired via simulated clock advance", async () => {
      const store = new InMemoryNonceStore();
      const nonce = "expiring-nonce-789";

      const initialTime = 1700000000000;
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(initialTime);

      const first = await store.consumeNonce(nonce, 60);
      expect(first).toBe(true);
      expect(await store.hasNonce(nonce)).toBe(true);

      // Advance clock past TTL (61 seconds)
      nowSpy.mockReturnValue(initialTime + 61000);

      expect(await store.hasNonce(nonce)).toBe(false);
      const second = await store.consumeNonce(nonce, 60);
      expect(second).toBe(true);

      nowSpy.mockRestore();
    });

    it("evicts expired nonces during prune cycle", async () => {
      const store = new InMemoryNonceStore();
      const initialTime = 1700000000000;
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(initialTime);

      await store.consumeNonce("expired-1", 10);
      await store.consumeNonce("active-1", 60);

      // Advance clock past 10 seconds but before 60 seconds
      nowSpy.mockReturnValue(initialTime + 15000);

      const pruned = store.pruneExpired();
      expect(pruned).toBe(1);

      expect(await store.hasNonce("expired-1")).toBe(false);
      expect(await store.hasNonce("active-1")).toBe(true);

      nowSpy.mockRestore();
    });

    it("clears all stored nonces upon clear()", async () => {
      const store = new InMemoryNonceStore();
      await store.consumeNonce("nonce-1", 60);
      await store.consumeNonce("nonce-2", 60);

      store.clear();

      expect(await store.hasNonce("nonce-1")).toBe(false);
      expect(await store.hasNonce("nonce-2")).toBe(false);
    });

    it("rejects empty nonce or non-positive ttlSeconds with RangeError", async () => {
      const store = new InMemoryNonceStore();

      expect(() => store.consumeNonce("", 60)).toThrow(RangeError);
      expect(() => store.consumeNonce("   ", 60)).toThrow(RangeError);
      expect(() => store.consumeNonce("valid-nonce", 0)).toThrow(RangeError);
      expect(() => store.consumeNonce("valid-nonce", -10)).toThrow(RangeError);
    });

    it("handles high-concurrency race condition on identical nonce with exactly 1 success", async () => {
      const store = new InMemoryNonceStore();
      const nonce = "concurrent-race-nonce";

      const attempts = await Promise.all(
        Array.from({ length: 50 }, () => Promise.resolve(store.consumeNonce(nonce, 60))),
      );

      const successes = attempts.filter((res) => res === true);
      const failures = attempts.filter((res) => res === false);

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(49);
    });
  });

  describe("RedisNonceStore", () => {
    it("consumes an unused nonce and delegates to Redis SET NX EX", async () => {
      const memoryDb = new Map<string, string>();
      const mockClient: RedisClientLike = {
        async set(key: string, value: string, ...args: unknown[]) {
          // Check for NX
          if (args.includes("NX") && memoryDb.has(key)) {
            return null;
          }
          memoryDb.set(key, value);
          return "OK";
        },
        async exists(key: string) {
          return memoryDb.has(key) ? 1 : 0;
        },
      };

      const redisStore = new RedisNonceStore(mockClient);
      const nonce = "redis-nonce-001";

      expect(await redisStore.hasNonce(nonce)).toBe(false);
      const consumed = await redisStore.consumeNonce(nonce, 120);
      expect(consumed).toBe(true);
      expect(await redisStore.hasNonce(nonce)).toBe(true);

      // Second attempt must fail (replay)
      const second = await redisStore.consumeNonce(nonce, 120);
      expect(second).toBe(false);
    });

    it("rejects invalid nonces and non-positive TTLs with RangeError", async () => {
      const mockClient: RedisClientLike = {
        set: vi.fn(),
        exists: vi.fn(),
      };
      const redisStore = new RedisNonceStore(mockClient);

      await expect(redisStore.consumeNonce("", 60)).rejects.toThrow(RangeError);
      await expect(redisStore.consumeNonce("valid", 0)).rejects.toThrow(RangeError);
      await expect(redisStore.consumeNonce("valid", -5)).rejects.toThrow(RangeError);
    });
  });
});
