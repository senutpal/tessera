import { describe, expect, it } from "vitest";
import {
  type ClearinghouseRecord,
  createEventBus,
  createGridDeltaTransformer,
  type DisputeOpenedEvent,
  type DisputeResolvedEvent,
  type EscrowLockedEvent,
  type GridDeltaBatch,
  GridDeltaTransformer,
  type MandateVerifiedEvent,
  type TrackingUpdatedEvent,
  transformEventToDelta,
} from "../index.js";

describe("transformEventToDelta (Pure Function)", () => {
  const baseMandate: MandateVerifiedEvent = {
    eventId: "evt-01",
    type: "MandateVerified",
    timestamp: "2026-10-21T10:00:00.000Z",
    data: {
      transactionId: "tx-abc-123",
      mandateId: "man-001",
      agentId: "agent-shopping-bot",
      merchantDomain: "store.example.com",
      amount: 14999,
      currency: "USD",
      riskScore: 22,
      riskTier: "LOW",
      hitlStatus: "NOT_REQUIRED",
    },
  };

  it("transforms MandateVerified into an 'add' delta with microsecond timestamp", () => {
    const delta = transformEventToDelta(baseMandate, undefined, 1);
    expect(delta).not.toBeNull();
    expect(delta?.type).toBe("add");
    expect(delta?.data.transactionId).toBe("tx-abc-123");
    expect(delta?.data.clearinghouseState).toBe("PENDING_AUTHORIZATION");
    expect(delta?.data.escrowStatus).toBe("PENDING_AUTHORIZATION");
    expect(delta?.data.amount).toBe(14999);
    expect(delta?.data.currency).toBe("USD");
    expect(delta?.data.merchantDomain).toBe("store.example.com");
    expect(delta?.data.sequenceNumber).toBe(1);
    expect(delta?.data.timestampMicros).toBeGreaterThan(0);
  });

  it("transforms EscrowLocked into an 'update' delta updating escrowStatus to AUTHORIZED_HOLD", () => {
    const initialDelta = transformEventToDelta(baseMandate, undefined, 1);
    expect(initialDelta).not.toBeNull();
    if (!initialDelta) throw new Error("initialDelta is required");

    const escrowEvent: EscrowLockedEvent = {
      eventId: "evt-02",
      type: "EscrowLocked",
      timestamp: "2026-10-21T10:01:00.000Z",
      data: {
        transactionId: "tx-abc-123",
        mandateId: "man-001",
        orderId: "ord-paypal-999",
        authorizationId: "auth-paypal-999",
        amount: 14999,
        currency: "USD",
      },
    };

    const updateDelta = transformEventToDelta(escrowEvent, initialDelta.data, 2);
    expect(updateDelta).not.toBeNull();
    expect(updateDelta?.type).toBe("update");
    expect(updateDelta?.data.clearinghouseState).toBe("AUTHORIZED_IN_ESCROW");
    expect(updateDelta?.data.escrowStatus).toBe("AUTHORIZED_HOLD");
    expect(updateDelta?.data.authorizationId).toBe("auth-paypal-999");
    expect(updateDelta?.data.orderId).toBe("ord-paypal-999");
    expect(updateDelta?.data.sequenceNumber).toBe(2);
  });

  it("transforms TrackingUpdated DELIVERED status into FULFILLED_DELIVERED and DELIVERED_CAPTURED", () => {
    const initialDelta = transformEventToDelta(baseMandate, undefined, 1);
    expect(initialDelta).not.toBeNull();
    if (!initialDelta) throw new Error("initialDelta is required");

    const trackingEvent: TrackingUpdatedEvent = {
      eventId: "evt-03",
      type: "TrackingUpdated",
      timestamp: "2026-10-21T10:05:00.000Z",
      data: {
        transactionId: "tx-abc-123",
        trackingId: "FEDEX-8888",
        carrier: "FEDEX",
        status: "DELIVERED",
      },
    };

    const updateDelta = transformEventToDelta(trackingEvent, initialDelta.data, 3);
    expect(updateDelta?.type).toBe("update");
    expect(updateDelta?.data.clearinghouseState).toBe("FULFILLED_DELIVERED");
    expect(updateDelta?.data.escrowStatus).toBe("DELIVERED_CAPTURED");
    expect(updateDelta?.data.trackingId).toBe("FEDEX-8888");
    expect(updateDelta?.data.carrier).toBe("FEDEX");
  });

  it("transforms DisputeOpened into DISPUTED state and dispute metadata", () => {
    const initialDelta = transformEventToDelta(baseMandate, undefined, 1);
    expect(initialDelta).not.toBeNull();
    if (!initialDelta) throw new Error("initialDelta is required");

    const disputeEvent: DisputeOpenedEvent = {
      eventId: "evt-04",
      type: "DisputeOpened",
      timestamp: "2026-10-21T10:10:00.000Z",
      data: {
        transactionId: "tx-abc-123",
        disputeId: "DISP-111",
        reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
        amount: 14999,
        currency: "USD",
      },
    };

    const delta = transformEventToDelta(disputeEvent, initialDelta.data, 4);
    expect(delta?.type).toBe("update");
    expect(delta?.data.clearinghouseState).toBe("DISPUTED");
    expect(delta?.data.escrowStatus).toBe("DISPUTED");
    expect(delta?.data.disputeId).toBe("DISP-111");
    expect(delta?.data.disputeReason).toBe("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED");
  });

  it("transforms DisputeResolved REFUNDED outcome into REFUNDED state", () => {
    const initialDelta = transformEventToDelta(baseMandate, undefined, 1);
    expect(initialDelta).not.toBeNull();
    if (!initialDelta) throw new Error("initialDelta is required");

    const disputeResolved: DisputeResolvedEvent = {
      eventId: "evt-05",
      type: "DisputeResolved",
      timestamp: "2026-10-21T10:20:00.000Z",
      data: {
        transactionId: "tx-abc-123",
        disputeId: "DISP-111",
        outcome: "REFUNDED",
        refundAmount: 14999,
      },
    };

    const delta = transformEventToDelta(disputeResolved, initialDelta.data, 5);
    expect(delta?.type).toBe("update");
    expect(delta?.data.clearinghouseState).toBe("REFUNDED");
    expect(delta?.data.escrowStatus).toBe("REFUNDED");
    expect(delta?.data.disputeOutcome).toBe("REFUNDED");
  });
});

describe("GridDeltaTransformer (Stateful Hydrator & Batcher)", () => {
  it("provides initial state snapshot upon client hydration", () => {
    const transformer = createGridDeltaTransformer();
    const seedRecords: ClearinghouseRecord[] = [
      {
        transactionId: "tx-1",
        mandateId: "man-1",
        agentId: "agent-1",
        merchantDomain: "store1.com",
        amount: 5000,
        currency: "USD",
        clearinghouseState: "AUTHORIZED_IN_ESCROW",
        escrowStatus: "AUTHORIZED_HOLD",
        riskScore: 20,
        riskTier: "LOW",
        hitlStatus: "NOT_REQUIRED",
        createdAt: "2026-10-21T09:00:00Z",
        updatedAt: "2026-10-21T09:05:00Z",
        sequenceNumber: 1,
        timestampMicros: 1729500000000000,
      },
    ];

    transformer.hydrate(seedRecords);

    const snapshot = transformer.getSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].transactionId).toBe("tx-1");

    const batchSnapshot = transformer.getSnapshotBatch();
    expect(batchSnapshot.records).toHaveLength(1);
    expect(batchSnapshot.sequenceNumber).toBeGreaterThanOrEqual(1);
  });

  it("batches streaming deltas and formats for AG Grid applyTransactionAsync", async () => {
    const transformer = new GridDeltaTransformer({
      batchWindowMs: 20,
      maxBatchSize: 10,
    });

    const batchesReceived: GridDeltaBatch[] = [];
    transformer.onBatch((batch) => {
      batchesReceived.push(batch);
    });

    transformer.processEvent({
      eventId: "e1",
      type: "MandateVerified",
      timestamp: new Date().toISOString(),
      data: {
        transactionId: "tx-1",
        mandateId: "m1",
        agentId: "a1",
        merchantDomain: "amazon.com",
        amount: 9999,
        currency: "USD",
        riskScore: 10,
        riskTier: "LOW",
        hitlStatus: "NOT_REQUIRED",
      },
    });

    transformer.processEvent({
      eventId: "e2",
      type: "EscrowLocked",
      timestamp: new Date().toISOString(),
      data: {
        transactionId: "tx-1",
        mandateId: "m1",
        orderId: "ord-1",
        authorizationId: "auth-1",
        amount: 9999,
        currency: "USD",
      },
    });

    // Wait for the batch window timer to flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(batchesReceived.length).toBeGreaterThanOrEqual(1);
    const firstBatch = batchesReceived[0];

    expect(firstBatch.deltas).toHaveLength(2);
    expect(firstBatch.deltas[0].type).toBe("add");
    expect(firstBatch.deltas[1].type).toBe("update");

    // AG Grid applyTransaction structure:
    expect(firstBatch.transaction.add).toHaveLength(1);
    expect(firstBatch.transaction.add[0].transactionId).toBe("tx-1");
    expect(firstBatch.transaction.update).toHaveLength(1);
    expect(firstBatch.transaction.update[0].authorizationId).toBe("auth-1");
    expect(firstBatch.transaction.remove).toHaveLength(0);

    transformer.close();
  });

  it("flushes immediately when maxBatchSize is reached without waiting for batchWindowMs", async () => {
    const transformer = new GridDeltaTransformer({
      batchWindowMs: 5000, // long window
      maxBatchSize: 2, // flush every 2 items
    });

    const batches: GridDeltaBatch[] = [];
    transformer.onBatch((b) => batches.push(b));

    transformer.processEvent({
      eventId: "e1",
      type: "MandateVerified",
      timestamp: new Date().toISOString(),
      data: {
        transactionId: "tx-1",
        mandateId: "m1",
        agentId: "a1",
        merchantDomain: "store.com",
        amount: 1000,
        currency: "USD",
        riskScore: 5,
        riskTier: "LOW",
        hitlStatus: "NOT_REQUIRED",
      },
    });

    expect(batches).toHaveLength(0);

    transformer.processEvent({
      eventId: "e2",
      type: "MandateVerified",
      timestamp: new Date().toISOString(),
      data: {
        transactionId: "tx-2",
        mandateId: "m2",
        agentId: "a2",
        merchantDomain: "store.com",
        amount: 2000,
        currency: "USD",
        riskScore: 5,
        riskTier: "LOW",
        hitlStatus: "NOT_REQUIRED",
      },
    });

    // Should have flushed immediately upon hitting maxBatchSize 2
    expect(batches).toHaveLength(1);
    expect(batches[0].deltas).toHaveLength(2);

    transformer.close();
  });

  it("integrates seamlessly with EventBus subscriptions", async () => {
    const bus = createEventBus({ fallbackToMemory: true });
    await bus.connect();

    const transformer = createGridDeltaTransformer({ batchWindowMs: 0 }); // synchronous flush
    const detach = transformer.attachToBus(bus);

    const receivedBatches: GridDeltaBatch[] = [];
    transformer.onBatch((b) => receivedBatches.push(b));

    await bus.publish({
      eventId: "e-bus-1",
      type: "MandateVerified",
      timestamp: new Date().toISOString(),
      data: {
        transactionId: "tx-bus-1",
        mandateId: "m-bus-1",
        agentId: "agent-x",
        merchantDomain: "bestbuy.com",
        amount: 35000,
        currency: "USD",
        riskScore: 75,
        riskTier: "CRITICAL_HITL",
        hitlStatus: "PENDING_APPROVAL",
      },
    });

    expect(receivedBatches).toHaveLength(1);
    expect(receivedBatches[0].deltas[0].data.riskTier).toBe("CRITICAL_HITL");
    expect(transformer.getRecord("tx-bus-1")?.hitlStatus).toBe("PENDING_APPROVAL");

    detach();
    transformer.close();
    await bus.close();
  });
});
