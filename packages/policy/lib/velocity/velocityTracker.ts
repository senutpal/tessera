import { Money } from "@tessera/core";

export const ONE_HOUR_MS = 60 * 60 * 1000;
export const TWENTY_FOUR_HOURS_MS = 24 * ONE_HOUR_MS;
export const THIRTY_DAYS_MS = 30 * TWENTY_FOUR_HOURS_MS;

interface SpendEntry {
  readonly timestamp: number;
  readonly amount: number; // minor units
}

interface TimeBucket {
  readonly bucketStart: number;
  amount: number; // minor units
  count: number;
}

interface AgentCurrencyLedger {
  // Recent individual transactions for sub-millisecond precision
  recentEntries: SpendEntry[];
  // Compressed sliding buckets for older events (bounded memory)
  buckets: Map<number, TimeBucket>;
  lastActive: number;
}

export interface VelocityTrackerOptions {
  /** Maximum retention window in ms (default: 30 days) */
  readonly maxRetentionMs?: number;
  /** Granularity of compressed buckets in ms (default: 60 seconds) */
  readonly bucketSizeMs?: number;
  /** Threshold of uncompressed recent entries before compressing older ones (default: 500) */
  readonly compressionThreshold?: number;
  /** Maximum number of tracked agent-currency ledgers before LRU eviction (default: 10,000) */
  readonly maxAgents?: number;
}

/**
 * Sliding-window spend velocity tracker for autonomous agents.
 * Tracks rolling velocity over 1-hour, 24-hour, and custom windows with
 * exact millisecond precision for recent transactions and automatic
 * sliding bucket compression to prevent unbounded memory growth.
 */
export class VelocityTracker {
  private readonly maxRetentionMs: number;
  private readonly bucketSizeMs: number;
  private readonly compressionThreshold: number;
  private readonly maxAgents: number;
  // Map key: `${agentId}::${currency}`
  private readonly ledgers = new Map<string, AgentCurrencyLedger>();

  constructor(options: VelocityTrackerOptions = {}) {
    this.maxRetentionMs = options.maxRetentionMs ?? THIRTY_DAYS_MS;
    this.bucketSizeMs = options.bucketSizeMs ?? 60_000; // 1 minute
    this.compressionThreshold = options.compressionThreshold ?? 500;
    this.maxAgents = options.maxAgents ?? 10_000;
  }

  private getLedgerKey(agentId: string, currency: string): string {
    return `${agentId}::${currency.toUpperCase()}`;
  }

  private getOrCreateLedger(
    agentId: string,
    currency: string,
    timestamp: number,
  ): AgentCurrencyLedger {
    const key = this.getLedgerKey(agentId, currency);
    let ledger = this.ledgers.get(key);
    if (!ledger) {
      // Evict least-recently-active ledger if capacity reached
      if (this.ledgers.size >= this.maxAgents) {
        this.evictOldestLedger(timestamp);
      }
      ledger = {
        recentEntries: [],
        buckets: new Map(),
        lastActive: timestamp,
      };
      this.ledgers.set(key, ledger);
    }
    ledger.lastActive = timestamp;
    return ledger;
  }

  private evictOldestLedger(now: number): void {
    const retentionCutoff = now - this.maxRetentionMs;
    let oldestKey: string | undefined;
    let oldestTimestamp = Number.POSITIVE_INFINITY;

    for (const [key, ledger] of this.ledgers) {
      const isExpired = ledger.lastActive < retentionCutoff;
      const isEmpty = ledger.buckets.size === 0 && ledger.recentEntries.length === 0;
      if ((isExpired || isEmpty) && ledger.lastActive < oldestTimestamp) {
        oldestTimestamp = ledger.lastActive;
        oldestKey = key;
      }
    }

    if (!oldestKey) {
      throw new Error(
        "VelocityTracker capacity reached: refusing to evict active ledgers with in-window spend",
      );
    }

    this.ledgers.delete(oldestKey);
  }

  /**
   * Records a spend event for an agent.
   */
  public recordSpend(agentId: string, amount: Money, timestamp = Date.now()): void {
    if (!agentId || typeof agentId !== "string") {
      throw new Error("agentId must be a non-empty string");
    }
    if (!(amount instanceof Money)) {
      throw new Error("amount must be an instance of Money");
    }
    if (amount.isNegative()) {
      throw new Error("Cannot record negative spend amount");
    }

    const ledger = this.getOrCreateLedger(agentId, amount.currency, timestamp);
    const newEntry: SpendEntry = {
      timestamp,
      amount: amount.toMinorUnits(),
    };

    // Maintain sorted order by timestamp
    const len = ledger.recentEntries.length;
    if (len === 0 || timestamp >= (ledger.recentEntries[len - 1] as SpendEntry).timestamp) {
      ledger.recentEntries.push(newEntry);
    } else {
      // Out-of-order insertion
      let insertIdx = 0;
      while (
        insertIdx < len &&
        (ledger.recentEntries[insertIdx] as SpendEntry).timestamp <= timestamp
      ) {
        insertIdx++;
      }
      ledger.recentEntries.splice(insertIdx, 0, newEntry);
    }

    // Compress older entries if uncompressed list exceeds threshold
    if (ledger.recentEntries.length > this.compressionThreshold) {
      this.compressLedger(ledger, timestamp);
    }

    // Prune entries older than max retention window
    this.pruneLedger(ledger, timestamp);
  }

  /**
   * Gets cumulative spend for an agent within the specified rolling window (in ms).
   */
  public getVelocity(agentId: string, currency: string, windowMs: number, now = Date.now()): Money {
    const key = this.getLedgerKey(agentId, currency);
    const ledger = this.ledgers.get(key);
    if (!ledger) {
      return Money.zero(currency);
    }

    const windowCutoff = now - windowMs;
    let totalMinorUnits = 0;

    // 1. Sum recent individual entries within the window
    for (const entry of ledger.recentEntries) {
      if (entry.timestamp >= windowCutoff && entry.timestamp <= now) {
        totalMinorUnits += entry.amount;
      }
    }

    // 2. Sum compressed buckets within the window
    for (const [bucketStart, bucket] of ledger.buckets) {
      const bucketEnd = bucketStart + this.bucketSizeMs;
      if (bucketEnd <= windowCutoff || bucketStart > now) {
        continue;
      }
      if (bucketStart >= windowCutoff) {
        totalMinorUnits += bucket.amount;
      } else {
        // Partial overlap: prorate fraction of bucket inside the window
        const overlap = bucketEnd - windowCutoff;
        const ratio = Math.max(0, Math.min(1, overlap / this.bucketSizeMs));
        totalMinorUnits += Math.round(bucket.amount * ratio);
      }
    }

    return Money.fromMinorUnits(totalMinorUnits, currency);
  }

  /**
   * Convenience method to get rolling 1-hour spend velocity.
   */
  public getVelocity1h(agentId: string, currency = "USD", now = Date.now()): Money {
    return this.getVelocity(agentId, currency, ONE_HOUR_MS, now);
  }

  /**
   * Convenience method to get rolling 24-hour spend velocity.
   */
  public getVelocity24h(agentId: string, currency = "USD", now = Date.now()): Money {
    return this.getVelocity(agentId, currency, TWENTY_FOUR_HOURS_MS, now);
  }

  /**
   * Convenience method to get rolling 30-day spend velocity.
   */
  public getVelocity30d(agentId: string, currency = "USD", now = Date.now()): Money {
    return this.getVelocity(agentId, currency, THIRTY_DAYS_MS, now);
  }

  /**
   * Counts the number of transactions recorded for an agent in the given window.
   */
  public getTransactionCount(
    agentId: string,
    currency = "USD",
    windowMs = ONE_HOUR_MS,
    now = Date.now(),
  ): number {
    const key = this.getLedgerKey(agentId, currency);
    const ledger = this.ledgers.get(key);
    if (!ledger) {
      return 0;
    }

    const windowCutoff = now - windowMs;
    let count = 0;

    for (const entry of ledger.recentEntries) {
      if (entry.timestamp >= windowCutoff && entry.timestamp <= now) {
        count += 1;
      }
    }

    for (const [bucketStart, bucket] of ledger.buckets) {
      const bucketEnd = bucketStart + this.bucketSizeMs;
      if (bucketEnd <= windowCutoff || bucketStart > now) {
        continue;
      }
      count += bucket.count;
    }

    return count;
  }

  /**
   * Checks whether an additional candidate amount would violate a rolling spend limit.
   * Returns true if allowed (current + amount <= limit), false if limit exceeded.
   */
  public checkSpendLimit(
    agentId: string,
    candidateAmount: Money,
    limit: Money,
    windowMs: number,
    now = Date.now(),
  ): boolean {
    if (candidateAmount.currency !== limit.currency) {
      return false;
    }
    const currentVelocity = this.getVelocity(agentId, candidateAmount.currency, windowMs, now);
    const projectedTotal = currentVelocity.add(candidateAmount);
    return projectedTotal.lessThanOrEqual(limit);
  }

  /**
   * Compresses recent entries older than 1 hour into fixed-interval time buckets.
   */
  private compressLedger(ledger: AgentCurrencyLedger, now: number): void {
    const compressCutoff = now - ONE_HOUR_MS;
    const remainingEntries: SpendEntry[] = [];

    for (const entry of ledger.recentEntries) {
      if (entry.timestamp < compressCutoff) {
        const bucketStart = Math.floor(entry.timestamp / this.bucketSizeMs) * this.bucketSizeMs;
        let bucket = ledger.buckets.get(bucketStart);
        if (!bucket) {
          bucket = {
            bucketStart,
            amount: 0,
            count: 0,
          };
          ledger.buckets.set(bucketStart, bucket);
        }
        bucket.amount += entry.amount;
        bucket.count += 1;
      } else {
        remainingEntries.push(entry);
      }
    }

    ledger.recentEntries = remainingEntries;
  }

  /**
   * Prunes all entries and buckets older than the maximum retention window.
   */
  private pruneLedger(ledger: AgentCurrencyLedger, now: number): void {
    const retentionCutoff = now - this.maxRetentionMs;

    ledger.recentEntries = ledger.recentEntries.filter(
      (entry) => entry.timestamp >= retentionCutoff,
    );

    for (const [bucketStart] of ledger.buckets) {
      if (bucketStart + this.bucketSizeMs < retentionCutoff) {
        ledger.buckets.delete(bucketStart);
      }
    }
  }

  /**
   * Runs maintenance pruning across all agent ledgers and evicts dormant ledgers.
   */
  public prune(now = Date.now()): void {
    const retentionCutoff = now - this.maxRetentionMs;
    for (const [key, ledger] of this.ledgers) {
      this.pruneLedger(ledger, now);
      // Evict completely dormant ledgers with no active entries or buckets
      if (
        ledger.recentEntries.length === 0 &&
        ledger.buckets.size === 0 &&
        ledger.lastActive < retentionCutoff
      ) {
        this.ledgers.delete(key);
      }
    }
  }

  /**
   * Clears state for a specific agent or all agents.
   */
  public reset(agentId?: string): void {
    if (agentId) {
      const prefix = `${agentId}::`;
      for (const key of Array.from(this.ledgers.keys())) {
        if (key.startsWith(prefix)) {
          this.ledgers.delete(key);
        }
      }
    } else {
      this.ledgers.clear();
    }
  }
}

/**
 * Shared module-level singleton instance for convenience.
 */
export const defaultVelocityTracker = new VelocityTracker();

/**
 * Standalone helper to record spend on a VelocityTracker instance or default tracker.
 */
export function recordSpend(
  tracker: VelocityTracker,
  agentId: string,
  amount: Money,
  timestamp?: number,
): void;
export function recordSpend(agentId: string, amount: Money, timestamp?: number): void;
export function recordSpend(
  trackerOrAgentId: VelocityTracker | string,
  agentIdOrAmount: string | Money,
  amountOrTimestamp?: Money | number,
  timestamp?: number,
): void {
  if (trackerOrAgentId instanceof VelocityTracker) {
    trackerOrAgentId.recordSpend(agentIdOrAmount as string, amountOrTimestamp as Money, timestamp);
  } else {
    defaultVelocityTracker.recordSpend(
      trackerOrAgentId,
      agentIdOrAmount as Money,
      amountOrTimestamp as number | undefined,
    );
  }
}
