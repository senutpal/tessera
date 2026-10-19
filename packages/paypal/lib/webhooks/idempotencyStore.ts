export interface IWebhookIdempotencyStore {
  has(transmissionId: string): boolean | Promise<boolean>;
  record(transmissionId: string, ttlMs?: number): boolean | Promise<boolean>;
  clear(): void | Promise<void>;
  size(): number | Promise<number>;
}

export interface InMemoryWebhookIdempotencyStoreConfig {
  defaultTtlMs?: number | undefined;
  maxEntries?: number | undefined;
}

/**
 * In-memory idempotency store tracking observed `PAYPAL-TRANSMISSION-ID` headers
 * to prevent replay attacks across sliding time windows.
 */
export class InMemoryWebhookIdempotencyStore implements IWebhookIdempotencyStore {
  private readonly store = new Map<string, number>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;

  constructor(config: InMemoryWebhookIdempotencyStoreConfig = {}) {
    this.defaultTtlMs = config.defaultTtlMs ?? 24 * 60 * 60 * 1000; // 24 hours
    this.maxEntries = config.maxEntries ?? 50_000;
  }

  public has(transmissionId: string): boolean {
    const expiresAt = this.store.get(transmissionId);
    if (expiresAt === undefined) {
      return false;
    }
    if (Date.now() >= expiresAt) {
      this.store.delete(transmissionId);
      return false;
    }
    return true;
  }

  /**
   * Records a transmission ID. Returns `true` if newly recorded, or `false`
   * if it was already recorded and has not expired (replay detected).
   */
  public record(transmissionId: string, ttlMs?: number): boolean {
    if (this.has(transmissionId)) {
      return false;
    }

    this.ensureCapacity();
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;
    this.store.set(transmissionId, Date.now() + effectiveTtl);
    return true;
  }

  public clear(): void {
    this.store.clear();
  }

  public size(): number {
    this.pruneExpired();
    return this.store.size;
  }

  public pruneExpired(): void {
    const now = Date.now();
    for (const [id, expiresAt] of this.store.entries()) {
      if (now >= expiresAt) {
        this.store.delete(id);
      }
    }
  }

  private ensureCapacity(): void {
    if (this.store.size < this.maxEntries) {
      return;
    }
    this.pruneExpired();
    if (this.store.size >= this.maxEntries) {
      // Evict oldest inserted entry (first item in map iterator)
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
  }
}
