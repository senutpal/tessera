import { describe, expect, it } from "vitest";
import { InMemoryNonceStore } from "../index.js";

describe("Anti-Replay Nonce Store", () => {
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

  it("permits reusing a nonce after its TTL has expired", async () => {
    const store = new InMemoryNonceStore();
    const nonce = "expiring-nonce-789";

    // Insert with negative TTL so it is already expired
    await store.consumeNonce(nonce, -1);
    expect(await store.hasNonce(nonce)).toBe(false);

    // Can be consumed again since it expired
    const second = await store.consumeNonce(nonce, 60);
    expect(second).toBe(true);
  });

  it("evicts expired nonces during prune cycle", async () => {
    const store = new InMemoryNonceStore();
    await store.consumeNonce("expired-1", -10);
    await store.consumeNonce("active-1", 60);

    store.pruneExpired();

    expect(await store.hasNonce("expired-1")).toBe(false);
    expect(await store.hasNonce("active-1")).toBe(true);
  });

  it("clears all stored nonces upon clear()", async () => {
    const store = new InMemoryNonceStore();
    await store.consumeNonce("nonce-1", 60);
    await store.consumeNonce("nonce-2", 60);

    store.clear();

    expect(await store.hasNonce("nonce-1")).toBe(false);
    expect(await store.hasNonce("nonce-2")).toBe(false);
  });
});
