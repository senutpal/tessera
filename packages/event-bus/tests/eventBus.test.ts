import { describe, expect, it, vi } from "vitest";
import {
  createEventBus,
  type DisputeOpenedEvent,
  type DisputeResolvedEvent,
  type DomainEvent,
  type EscrowLockedEvent,
  EventBus,
  type MandateVerifiedEvent,
  MemoryTransport,
  RedisTransport,
  type TrackingUpdatedEvent,
} from "../index.js";

describe("MemoryTransport", () => {
  it("delivers messages across published channels", async () => {
    const transport = new MemoryTransport();
    await transport.connect();

    const received: string[] = [];
    const unsubscribe = await transport.subscribe("test-channel", (msg) => {
      received.push(msg);
    });

    await transport.publish("test-channel", "message-1");
    await transport.publish("test-channel", "message-2");

    expect(received).toEqual(["message-1", "message-2"]);

    await unsubscribe();
    await transport.publish("test-channel", "message-3");
    expect(received).toHaveLength(2);

    await transport.close();
    expect(transport.isConnected).toBe(false);
  });

  it("supports multiple subscribers on the same channel", async () => {
    const transport = new MemoryTransport();
    await transport.connect();

    const sub1: string[] = [];
    const sub2: string[] = [];

    const unsub1 = await transport.subscribe("multi-channel", (m) => {
      sub1.push(m);
    });
    const unsub2 = await transport.subscribe("multi-channel", (m) => {
      sub2.push(m);
    });

    await transport.publish("multi-channel", "hello-all");

    expect(sub1).toEqual(["hello-all"]);
    expect(sub2).toEqual(["hello-all"]);

    await unsub1();
    await unsub2();
    await transport.close();
  });
});

describe("EventBus with In-Memory Transport", () => {
  it("publishes and subscribes to typed domain events", async () => {
    const bus = createEventBus({ fallbackToMemory: true });
    await bus.connect();

    const mandateEvents: MandateVerifiedEvent[] = [];
    const escrowEvents: EscrowLockedEvent[] = [];
    const trackingEvents: TrackingUpdatedEvent[] = [];
    const disputeOpenedEvents: DisputeOpenedEvent[] = [];
    const disputeResolvedEvents: DisputeResolvedEvent[] = [];

    const unsubMandate = bus.subscribe("MandateVerified", (e) => {
      mandateEvents.push(e);
    });
    const unsubEscrow = bus.subscribe("EscrowLocked", (e) => {
      escrowEvents.push(e);
    });
    const unsubTracking = bus.subscribe("TrackingUpdated", (e) => {
      trackingEvents.push(e);
    });
    const unsubDisputeOpen = bus.subscribe("DisputeOpened", (e) => {
      disputeOpenedEvents.push(e);
    });
    const unsubDisputeResolve = bus.subscribe("DisputeResolved", (e) => {
      disputeResolvedEvents.push(e);
    });

    const mandateEvent: MandateVerifiedEvent = {
      eventId: "evt-01",
      type: "MandateVerified",
      timestamp: new Date().toISOString(),
      data: {
        transactionId: "tx-100",
        mandateId: "man-100",
        agentId: "agent-alpha",
        merchantDomain: "store.example.com",
        amount: 24999,
        currency: "USD",
        riskScore: 15,
        riskTier: "LOW",
        hitlStatus: "NOT_REQUIRED",
      },
    };

    const escrowEvent: EscrowLockedEvent = {
      eventId: "evt-02",
      type: "EscrowLocked",
      timestamp: new Date().toISOString(),
      data: {
        transactionId: "tx-100",
        mandateId: "man-100",
        orderId: "order-paypal-1",
        authorizationId: "auth-paypal-1",
        amount: 24999,
        currency: "USD",
      },
    };

    const trackingEvent: TrackingUpdatedEvent = {
      eventId: "evt-03",
      type: "TrackingUpdated",
      timestamp: new Date().toISOString(),
      data: {
        transactionId: "tx-100",
        trackingId: "TRACK-9999",
        carrier: "FEDEX",
        status: "DELIVERED",
      },
    };

    const disputeOpenEvent: DisputeOpenedEvent = {
      eventId: "evt-04",
      type: "DisputeOpened",
      timestamp: new Date().toISOString(),
      data: {
        transactionId: "tx-100",
        disputeId: "DISP-555",
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        amount: 24999,
        currency: "USD",
      },
    };

    const disputeResolveEvent: DisputeResolvedEvent = {
      eventId: "evt-05",
      type: "DisputeResolved",
      timestamp: new Date().toISOString(),
      data: {
        transactionId: "tx-100",
        disputeId: "DISP-555",
        outcome: "REFUNDED",
        refundAmount: 24999,
      },
    };

    await bus.publish(mandateEvent);
    await bus.publish(escrowEvent);
    await bus.publish(trackingEvent);
    await bus.publish(disputeOpenEvent);
    await bus.publish(disputeResolveEvent);

    expect(mandateEvents).toHaveLength(1);
    expect(mandateEvents[0].data.transactionId).toBe("tx-100");
    expect(mandateEvents[0].sequenceNumber).toBeGreaterThan(0);

    expect(escrowEvents).toHaveLength(1);
    expect(escrowEvents[0].data.authorizationId).toBe("auth-paypal-1");
    const mandateSeq = mandateEvents[0]?.sequenceNumber ?? 0;
    const escrowSeq = escrowEvents[0]?.sequenceNumber ?? 0;
    expect(escrowSeq).toBeGreaterThan(mandateSeq);

    expect(trackingEvents).toHaveLength(1);
    expect(trackingEvents[0].data.status).toBe("DELIVERED");

    expect(disputeOpenedEvents).toHaveLength(1);
    expect(disputeOpenedEvents[0].data.disputeId).toBe("DISP-555");

    expect(disputeResolvedEvents).toHaveLength(1);
    expect(disputeResolvedEvents[0].data.outcome).toBe("REFUNDED");

    unsubMandate();
    unsubEscrow();
    unsubTracking();
    unsubDisputeOpen();
    unsubDisputeResolve();

    await bus.close();
  });

  it("delivers all events to wildcard subscription with monotonic sequence numbers", async () => {
    const bus = new EventBus({ fallbackToMemory: true });
    await bus.connect();

    const allEvents: DomainEvent[] = [];
    bus.subscribe("*", (e) => {
      allEvents.push(e);
    });

    await bus.publish({
      eventId: "e1",
      type: "MandateVerified",
      timestamp: new Date().toISOString(),
      data: {
        transactionId: "tx-1",
        mandateId: "m1",
        agentId: "agent-1",
        merchantDomain: "store.com",
        amount: 1000,
        currency: "USD",
        riskScore: 10,
        riskTier: "LOW",
        hitlStatus: "NOT_REQUIRED",
      },
    });

    await bus.publish({
      eventId: "e2",
      type: "EscrowLocked",
      timestamp: new Date().toISOString(),
      data: {
        transactionId: "tx-1",
        mandateId: "m1",
        orderId: "ord-1",
        authorizationId: "auth-1",
        amount: 1000,
        currency: "USD",
      },
    });

    expect(allEvents).toHaveLength(2);
    expect(allEvents[0].sequenceNumber).toBe(1);
    expect(allEvents[1].sequenceNumber).toBe(2);

    await bus.close();
  });

  it("isolates subscriber errors so other handlers still execute", async () => {
    const bus = createEventBus();
    await bus.connect();

    const received: string[] = [];
    const throwingHandler = vi.fn().mockImplementation(() => {
      throw new Error("handler failure");
    });

    bus.subscribe("MandateVerified", throwingHandler);
    bus.subscribe("MandateVerified", (e) => {
      received.push(e.eventId);
    });

    await bus.publish({
      eventId: "e-fail",
      type: "MandateVerified",
      timestamp: new Date().toISOString(),
      data: {
        transactionId: "tx-1",
        mandateId: "m1",
        agentId: "a1",
        merchantDomain: "a.com",
        amount: 500,
        currency: "USD",
        riskScore: 5,
        riskTier: "LOW",
        hitlStatus: "NOT_REQUIRED",
      },
    });

    expect(throwingHandler).toHaveBeenCalled();
    expect(received).toEqual(["e-fail"]);

    await bus.close();
  });
});

describe("RedisTransport & Graceful Fallback", () => {
  it("falls back gracefully to memory transport when Redis is unavailable", async () => {
    // Point to non-routable host / port that will immediately fail or be offline
    const redisTransport = new RedisTransport({
      redisUrl: "redis://127.0.0.1:54321",
      connectTimeoutMs: 150,
      maxRetries: 0,
      fallbackToMemory: true,
    });

    // Should not throw; falls back to memory
    await redisTransport.connect();

    expect(redisTransport.isFallbackActive).toBe(true);
    expect(redisTransport.type).toBe("memory");

    const messages: string[] = [];
    const unsub = await redisTransport.subscribe("fallback-chan", (m) => {
      messages.push(m);
    });

    await redisTransport.publish("fallback-chan", "fallback-message");
    expect(messages).toEqual(["fallback-message"]);

    await unsub();
    await redisTransport.close();
  });

  it("provides status reporting through EventBus", async () => {
    const bus = createEventBus({
      redisUrl: "redis://127.0.0.1:54321",
      connectTimeoutMs: 100,
      maxRetries: 0,
      fallbackToMemory: true,
    });

    await bus.connect();
    const status = bus.getStatus();

    expect(status.isConnected).toBe(true);
    expect(status.transportType).toBe("memory");
    expect(status.fallbackActive).toBe(true);

    await bus.close();
  });
});
