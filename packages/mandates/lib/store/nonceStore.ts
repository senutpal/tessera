export interface NonceStore {
  /**
   * Attempts to atomically consume a nonce for the duration of ttlSeconds.
   *
   * @param nonce - Unique identifier or cryptographic nonce string.
   * @param ttlSeconds - Time-to-live in seconds before the nonce expires.
   * @returns true if successfully consumed; false if nonce has already been consumed (replay).
   */
  consumeNonce(nonce: string, ttlSeconds: number): Promise<boolean> | boolean;

  /**
   * Checks whether a nonce is currently active in the store.
   */
  hasNonce(nonce: string): Promise<boolean> | boolean;
}

export class InMemoryNonceStore implements NonceStore {
  private readonly nonces = new Map<string, number>();

  /**
   * Atomically records a nonce with an expiration timestamp.
   * Returns false if the nonce already exists and has not expired.
   */
  public consumeNonce(nonce: string, ttlSeconds: number): boolean {
    if (typeof nonce !== "string" || nonce.trim().length === 0) {
      throw new RangeError("Nonce must be a non-empty string");
    }
    if (typeof ttlSeconds !== "number" || ttlSeconds <= 0 || !Number.isFinite(ttlSeconds)) {
      throw new RangeError("ttlSeconds must be a positive finite number");
    }

    const now = Date.now();
    const existingExpiresAt = this.nonces.get(nonce);

    if (existingExpiresAt !== undefined && existingExpiresAt > now) {
      return false; // Replay detected
    }

    const expiresAt = now + ttlSeconds * 1000;
    this.nonces.set(nonce, expiresAt);
    return true;
  }

  /**
   * Checks if the nonce is recorded and unexpired.
   */
  public hasNonce(nonce: string): boolean {
    if (typeof nonce !== "string" || nonce.trim().length === 0) {
      return false;
    }
    const now = Date.now();
    const existingExpiresAt = this.nonces.get(nonce);

    if (existingExpiresAt === undefined) {
      return false;
    }

    if (existingExpiresAt <= now) {
      this.nonces.delete(nonce);
      return false;
    }

    return true;
  }

  /**
   * Prunes all expired nonces from memory to avoid unbounded growth.
   * Returns the count of purged nonces.
   */
  public pruneExpired(): number {
    const now = Date.now();
    let purged = 0;

    for (const [nonce, expiresAt] of this.nonces.entries()) {
      if (expiresAt <= now) {
        this.nonces.delete(nonce);
        purged++;
      }
    }

    return purged;
  }

  /**
   * Clears all stored nonces.
   */
  public clear(): void {
    this.nonces.clear();
  }
}

/**
 * Compatible Redis client interface covering standard ioredis and node-redis methods.
 */
export interface RedisClientLike {
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  exists(key: string): Promise<number | boolean>;
}

/**
 * Distributed Redis-backed NonceStore enforcing atomic SET NX EX replay protection.
 */
export class RedisNonceStore implements NonceStore {
  constructor(
    private readonly client: RedisClientLike,
    private readonly keyPrefix = "tessera:nonce:",
  ) {}

  public async consumeNonce(nonce: string, ttlSeconds: number): Promise<boolean> {
    if (typeof nonce !== "string" || nonce.trim().length === 0) {
      throw new RangeError("Nonce must be a non-empty string");
    }
    if (typeof ttlSeconds !== "number" || ttlSeconds <= 0 || !Number.isFinite(ttlSeconds)) {
      throw new RangeError("ttlSeconds must be a positive finite number");
    }

    const key = `${this.keyPrefix}${nonce}`;
    const ttl = Math.ceil(ttlSeconds);

    let result: unknown;
    try {
      result = await this.client.set(key, "1", "EX", ttl, "NX");
    } catch {
      result = await this.client.set(key, "1", { EX: ttl, NX: true });
    }

    return result === "OK" || result === true || result === 1;
  }

  public async hasNonce(nonce: string): Promise<boolean> {
    if (typeof nonce !== "string" || nonce.trim().length === 0) {
      return false;
    }
    const key = `${this.keyPrefix}${nonce}`;
    const existsResult = await this.client.exists(key);
    return existsResult === 1 || existsResult === true;
  }
}
