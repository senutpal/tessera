import type { EventBus } from "../bus/eventBus.js";
import type { DomainEvent } from "../types/events.js";
import {
  type ClearinghouseRecord,
  type GridDeltaBatch,
  type GridDeltaItem,
  type GridTransaction,
  getMicrosecondTimestamp,
} from "../types/records.js";

/**
 * Pure function converting a domain event into an AG Grid delta item.
 */
export function transformEventToDelta(
  event: DomainEvent,
  currentState?: ClearinghouseRecord,
  sequenceNumber = 1,
): GridDeltaItem | null {
  const timestampMicros = getMicrosecondTimestamp();
  const nowIso = new Date().toISOString();

  switch (event.type) {
    case "MandateVerified": {
      const isExisting = Boolean(currentState);
      const record: ClearinghouseRecord = {
        transactionId: event.data.transactionId,
        mandateId: event.data.mandateId,
        agentId: event.data.agentId,
        merchantDomain: event.data.merchantDomain,
        amount: event.data.amount,
        currency: event.data.currency,
        clearinghouseState: currentState?.clearinghouseState ?? "PENDING_AUTHORIZATION",
        escrowStatus: currentState?.escrowStatus ?? "PENDING_AUTHORIZATION",
        riskScore: event.data.riskScore,
        riskTier: event.data.riskTier,
        hitlStatus: event.data.hitlStatus,
        authorizationId: currentState?.authorizationId,
        orderId: currentState?.orderId,
        captureId: currentState?.captureId,
        trackingId: currentState?.trackingId,
        carrier: currentState?.carrier,
        disputeId: currentState?.disputeId,
        disputeReason: currentState?.disputeReason,
        disputeOutcome: currentState?.disputeOutcome,
        createdAt: currentState?.createdAt ?? nowIso,
        updatedAt: nowIso,
        sequenceNumber,
        timestampMicros,
      };

      return {
        type: isExisting ? "update" : "add",
        data: record,
      };
    }

    case "EscrowLocked": {
      const base: ClearinghouseRecord = currentState ?? {
        transactionId: event.data.transactionId,
        mandateId: event.data.mandateId,
        agentId: "unknown",
        merchantDomain: "unknown",
        amount: event.data.amount,
        currency: event.data.currency,
        clearinghouseState: "AUTHORIZED_IN_ESCROW",
        escrowStatus: "AUTHORIZED_HOLD",
        riskScore: 0,
        riskTier: "LOW",
        hitlStatus: "NOT_REQUIRED",
        createdAt: nowIso,
        updatedAt: nowIso,
        sequenceNumber,
        timestampMicros,
      };

      const updated: ClearinghouseRecord = {
        ...base,
        orderId: event.data.orderId,
        authorizationId: event.data.authorizationId,
        clearinghouseState: "AUTHORIZED_IN_ESCROW",
        escrowStatus: "AUTHORIZED_HOLD",
        updatedAt: nowIso,
        sequenceNumber,
        timestampMicros,
      };

      return {
        type: currentState ? "update" : "add",
        data: updated,
      };
    }

    case "TrackingUpdated": {
      const base: ClearinghouseRecord = currentState ?? {
        transactionId: event.data.transactionId,
        mandateId: "unknown",
        agentId: "unknown",
        merchantDomain: "unknown",
        amount: 0,
        currency: "USD",
        clearinghouseState: "AWAITING_FULFILLMENT",
        escrowStatus: "IN_TRANSIT",
        riskScore: 0,
        riskTier: "LOW",
        hitlStatus: "NOT_REQUIRED",
        createdAt: nowIso,
        updatedAt: nowIso,
        sequenceNumber,
        timestampMicros,
      };

      let state = base.clearinghouseState;
      let escrow = base.escrowStatus;

      if (event.data.status === "DELIVERED") {
        state = "FULFILLED_DELIVERED";
        escrow = "DELIVERED_CAPTURED";
      } else if (event.data.status === "IN_TRANSIT" || event.data.status === "SHIPPED") {
        state = "AWAITING_FULFILLMENT";
        escrow = "IN_TRANSIT";
      } else if (event.data.status === "CANCELLED" || event.data.status === "RETURNED") {
        state = "VOIDED";
        escrow = "SLA_BREACH_VOIDED";
      }

      const captureId =
        (typeof event.data.metadata?.captureId === "string"
          ? event.data.metadata.captureId
          : undefined) ?? base.captureId;

      const updated: ClearinghouseRecord = {
        ...base,
        trackingId: event.data.trackingId,
        carrier: event.data.carrier,
        captureId,
        clearinghouseState: state,
        escrowStatus: escrow,
        updatedAt: nowIso,
        sequenceNumber,
        timestampMicros,
      };

      return {
        type: currentState ? "update" : "add",
        data: updated,
      };
    }

    case "DisputeOpened": {
      const base: ClearinghouseRecord = currentState ?? {
        transactionId: event.data.transactionId,
        mandateId: "unknown",
        agentId: "unknown",
        merchantDomain: "unknown",
        amount: event.data.amount,
        currency: event.data.currency,
        clearinghouseState: "DISPUTED",
        escrowStatus: "DISPUTED",
        riskScore: 0,
        riskTier: "LOW",
        hitlStatus: "NOT_REQUIRED",
        createdAt: nowIso,
        updatedAt: nowIso,
        sequenceNumber,
        timestampMicros,
      };

      const updated: ClearinghouseRecord = {
        ...base,
        disputeId: event.data.disputeId,
        disputeReason: event.data.reason,
        clearinghouseState: "DISPUTED",
        escrowStatus: "DISPUTED",
        updatedAt: nowIso,
        sequenceNumber,
        timestampMicros,
      };

      return {
        type: currentState ? "update" : "add",
        data: updated,
      };
    }

    case "DisputeResolved": {
      const isRefunded =
        event.data.outcome === "REFUNDED" ||
        event.data.outcome === "CLAIM_ACCEPTED" ||
        event.data.outcome === "BUYER_FAVOR";

      const base: ClearinghouseRecord = currentState ?? {
        transactionId: event.data.transactionId,
        mandateId: "unknown",
        agentId: "unknown",
        merchantDomain: "unknown",
        amount: event.data.refundAmount ?? 0,
        currency: "USD",
        clearinghouseState: isRefunded ? "REFUNDED" : "SETTLED",
        escrowStatus: isRefunded ? "REFUNDED" : "SETTLED",
        riskScore: 0,
        riskTier: "LOW",
        hitlStatus: "NOT_REQUIRED",
        createdAt: nowIso,
        updatedAt: nowIso,
        sequenceNumber,
        timestampMicros,
      };

      const updated: ClearinghouseRecord = {
        ...base,
        disputeOutcome: event.data.outcome,
        clearinghouseState: isRefunded ? "REFUNDED" : "SETTLED",
        escrowStatus: isRefunded ? "REFUNDED" : "SETTLED",
        updatedAt: nowIso,
        sequenceNumber,
        timestampMicros,
      };

      return {
        type: currentState ? "update" : "add",
        data: updated,
      };
    }

    default:
      return null;
  }
}

export interface GridDeltaTransformerOptions {
  batchWindowMs?: number;
  maxBatchSize?: number;
  coalesce?: boolean;
}

export class GridDeltaTransformer {
  private records = new Map<string, ClearinghouseRecord>();
  private buffer: GridDeltaItem[] = [];
  private batchWindowMs: number;
  private maxBatchSize: number;
  private coalesce: boolean;
  private flushTimer: NodeJS.Timeout | undefined = undefined;
  private sequenceCounter = 0;
  private batchListeners = new Set<(batch: GridDeltaBatch) => void>();

  constructor(options: GridDeltaTransformerOptions = {}) {
    this.batchWindowMs = options.batchWindowMs ?? 50;
    this.maxBatchSize = options.maxBatchSize ?? 100;
    this.coalesce = options.coalesce ?? true;
  }

  hydrate(records: ClearinghouseRecord[]): void {
    for (const record of records) {
      this.records.set(record.transactionId, { ...record });
      if (record.sequenceNumber > this.sequenceCounter) {
        this.sequenceCounter = record.sequenceNumber;
      }
    }
  }

  getRecord(transactionId: string): ClearinghouseRecord | undefined {
    return this.records.get(transactionId);
  }

  getSnapshot(): ClearinghouseRecord[] {
    return Array.from(this.records.values());
  }

  getSnapshotBatch(): {
    sequenceNumber: number;
    timestampMicros: number;
    records: ClearinghouseRecord[];
  } {
    this.flush();
    return {
      sequenceNumber: this.sequenceCounter,
      timestampMicros: getMicrosecondTimestamp(),
      records: this.getSnapshot(),
    };
  }

  onBatch(listener: (batch: GridDeltaBatch) => void): () => void {
    this.batchListeners.add(listener);
    return () => {
      this.batchListeners.delete(listener);
    };
  }

  processEvent(event: DomainEvent): GridDeltaItem | null {
    this.sequenceCounter = Math.max(
      this.sequenceCounter + 1,
      typeof event.sequenceNumber === "number" && event.sequenceNumber > 0
        ? event.sequenceNumber
        : this.sequenceCounter + 1,
    );
    const currentState = this.records.get(event.data.transactionId);
    const delta = transformEventToDelta(event, currentState, this.sequenceCounter);

    if (!delta) {
      return null;
    }

    // Update state store
    if (delta.type === "remove") {
      this.records.delete(delta.data.transactionId);
    } else {
      this.records.set(delta.data.transactionId, delta.data);
    }

    this.buffer.push(delta);

    if (this.batchWindowMs <= 0) {
      this.flush();
    } else if (this.buffer.length >= this.maxBatchSize) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flush();
      }, this.batchWindowMs);
    }

    return delta;
  }

  removeRecord(transactionId: string): GridDeltaItem | null {
    const existing = this.records.get(transactionId);
    if (!existing) {
      return null;
    }

    this.sequenceCounter += 1;
    this.records.delete(transactionId);

    const delta: GridDeltaItem = {
      type: "remove",
      data: {
        ...existing,
        sequenceNumber: this.sequenceCounter,
        timestampMicros: getMicrosecondTimestamp(),
        updatedAt: new Date().toISOString(),
      },
    };

    this.buffer.push(delta);

    if (this.batchWindowMs <= 0 || this.buffer.length >= this.maxBatchSize) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        this.flush();
      }, this.batchWindowMs);
    }

    return delta;
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    if (this.buffer.length === 0) {
      return;
    }

    const items = [...this.buffer];
    this.buffer = [];

    let transaction: GridTransaction;

    if (this.coalesce) {
      // Coalesce changes per transactionId for AG Grid Enterprise applyTransactionAsync
      const addedMap = new Map<string, ClearinghouseRecord>();
      const updatedMap = new Map<string, ClearinghouseRecord>();
      const removedMap = new Map<string, ClearinghouseRecord>();

      for (const item of items) {
        const txId = item.data.transactionId;
        if (item.type === "add") {
          if (removedMap.has(txId)) {
            removedMap.delete(txId);
            updatedMap.set(txId, item.data);
          } else {
            addedMap.set(txId, item.data);
          }
        } else if (item.type === "update") {
          if (addedMap.has(txId)) {
            addedMap.set(txId, item.data);
          } else {
            updatedMap.set(txId, item.data);
          }
        } else if (item.type === "remove") {
          if (addedMap.has(txId)) {
            addedMap.delete(txId);
          } else {
            updatedMap.delete(txId);
            removedMap.set(txId, item.data);
          }
        }
      }

      transaction = {
        add: Array.from(addedMap.values()),
        update: Array.from(updatedMap.values()),
        remove: Array.from(removedMap.values()),
      };
    } else {
      transaction = {
        add: [],
        update: [],
        remove: [],
      };

      for (const item of items) {
        if (item.type === "add") {
          transaction.add.push(item.data);
        } else if (item.type === "update") {
          transaction.update.push(item.data);
        } else if (item.type === "remove") {
          transaction.remove.push(item.data);
        }
      }
    }

    const batch: GridDeltaBatch = {
      sequenceNumber: this.sequenceCounter,
      timestampMicros: getMicrosecondTimestamp(),
      timestamp: new Date().toISOString(),
      deltas: items,
      transaction,
    };

    for (const listener of this.batchListeners) {
      try {
        listener(batch);
      } catch (err) {
        console.error("[GridDeltaTransformer] Error in batch listener:", err);
      }
    }
  }

  attachToBus(bus: EventBus): () => void {
    return bus.subscribe("*", (event) => {
      this.processEvent(event);
    });
  }

  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flush();
    this.batchListeners.clear();
    this.buffer = [];
  }
}

export function createGridDeltaTransformer(
  options: GridDeltaTransformerOptions = {},
): GridDeltaTransformer {
  return new GridDeltaTransformer(options);
}
