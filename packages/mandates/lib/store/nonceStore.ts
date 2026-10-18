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
    const now = Date.now();
    const existingExpiresAt = this.nonces.get(nonce);

    if (existingExpiresAt !== undefined && existingExpiresAt > now) {
      return false; // Replay detected
    }

    if (ttlSeconds <= 0) {
      // Expired immediately; do not keep active
      this.nonces.delete(nonce);
      return true;
    }

    const expiresAt = now + ttlSeconds * 1000;
    this.nonces.set(nonce, expiresAt);
    return true;
  }

  /**
   * Checks if the nonce is recorded and unexpired.
   */
  public hasNonce(nonce: string): boolean {
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
