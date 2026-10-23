import {
  asAuthorizationId,
  asMandateId,
  asTransactionId,
  CarrierTrackingError,
  ConflictError,
  ShipmentMilestoneStatus,
} from "@tessera/core";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TRACKING_SLA_WINDOW_MS,
  type PayPalTrackingStatus,
  type ShipmentMilestone,
  type TrackingEventSink,
  TrackingStateMachine,
} from "../index.js";

function makeMilestone(
  status: ShipmentMilestoneStatus,
  overrides: Partial<ShipmentMilestone> = {},
): ShipmentMilestone {
  return {
    transactionId: asTransactionId("TX_12345"),
    trackingNumber: "1Z9999999999",
    carrier: "UPS",
    status,
    rawStatus: status as unknown as PayPalTrackingStatus,
    carrierProofTimestamp: "2026-10-20T12:00:00Z",
    ...overrides,
  };
}

describe("TrackingStateMachine", () => {
  describe("Milestone State Machine Transitions", () => {
    it("allows valid forward transitions (SHIPPED -> IN_TRANSIT -> DELIVERED)", async () => {
      const sm = new TrackingStateMachine();

      const initial = makeMilestone(ShipmentMilestoneStatus.SHIPPED);
      const inTransit = makeMilestone(ShipmentMilestoneStatus.IN_TRANSIT);
      const delivered = makeMilestone(ShipmentMilestoneStatus.DELIVERED);

      const res1 = await sm.transition(undefined, initial);
      expect(res1.status).toBe(ShipmentMilestoneStatus.SHIPPED);

      const res2 = await sm.transition(res1, inTransit);
      expect(res2.status).toBe(ShipmentMilestoneStatus.IN_TRANSIT);

      const res3 = await sm.transition(res2, delivered);
      expect(res3.status).toBe(ShipmentMilestoneStatus.DELIVERED);
    });

    it("allows direct transition from SHIPPED to DELIVERED", async () => {
      const sm = new TrackingStateMachine();
      const shipped = makeMilestone(ShipmentMilestoneStatus.SHIPPED);
      const delivered = makeMilestone(ShipmentMilestoneStatus.DELIVERED);

      const res = await sm.transition(shipped, delivered);
      expect(res.status).toBe(ShipmentMilestoneStatus.DELIVERED);
    });

    it("allows transitions from SHIPPED or IN_TRANSIT to CANCELLED or RETURNED", async () => {
      const sm = new TrackingStateMachine();
      const shipped = makeMilestone(ShipmentMilestoneStatus.SHIPPED);
      const cancelled = makeMilestone(ShipmentMilestoneStatus.CANCELLED);
      const returned = makeMilestone(ShipmentMilestoneStatus.RETURNED);

      await expect(sm.transition(shipped, cancelled)).resolves.toMatchObject({
        status: ShipmentMilestoneStatus.CANCELLED,
      });

      const inTransit = makeMilestone(ShipmentMilestoneStatus.IN_TRANSIT);
      await expect(sm.transition(inTransit, returned)).resolves.toMatchObject({
        status: ShipmentMilestoneStatus.RETURNED,
      });
    });

    it("rejects illegal backward transition from DELIVERED with ConflictError", async () => {
      const sm = new TrackingStateMachine();
      const delivered = makeMilestone(ShipmentMilestoneStatus.DELIVERED);
      const inTransit = makeMilestone(ShipmentMilestoneStatus.IN_TRANSIT);
      const shipped = makeMilestone(ShipmentMilestoneStatus.SHIPPED);
      const cancelled = makeMilestone(ShipmentMilestoneStatus.CANCELLED);

      await expect(sm.transition(delivered, inTransit)).rejects.toThrow(ConflictError);
      await expect(sm.transition(delivered, shipped)).rejects.toThrow(ConflictError);
      await expect(sm.transition(delivered, cancelled)).rejects.toThrow(ConflictError);
    });

    it("rejects transition from terminal CANCELLED or RETURNED states", async () => {
      const sm = new TrackingStateMachine();
      const cancelled = makeMilestone(ShipmentMilestoneStatus.CANCELLED);
      const returned = makeMilestone(ShipmentMilestoneStatus.RETURNED);
      const inTransit = makeMilestone(ShipmentMilestoneStatus.IN_TRANSIT);

      await expect(sm.transition(cancelled, inTransit)).rejects.toThrow(ConflictError);
      await expect(sm.transition(returned, inTransit)).rejects.toThrow(ConflictError);
    });

    it("handles idempotent transitions without error", async () => {
      const sm = new TrackingStateMachine();
      const delivered = makeMilestone(ShipmentMilestoneStatus.DELIVERED);

      const res = await sm.transition(delivered, delivered);
      expect(res.status).toBe(ShipmentMilestoneStatus.DELIVERED);
    });

    it("rejects transition when current and incoming shipment identity mismatch", async () => {
      const sm = new TrackingStateMachine();
      const current = makeMilestone(ShipmentMilestoneStatus.SHIPPED, {
        transactionId: asTransactionId("TX_A"),
        trackingNumber: "TRACK_A",
      });
      const incomingDiffTx = makeMilestone(ShipmentMilestoneStatus.IN_TRANSIT, {
        transactionId: asTransactionId("TX_B"),
        trackingNumber: "TRACK_A",
      });
      const incomingDiffTrack = makeMilestone(ShipmentMilestoneStatus.IN_TRANSIT, {
        transactionId: asTransactionId("TX_A"),
        trackingNumber: "TRACK_B",
      });

      await expect(sm.transition(current, incomingDiffTx)).rejects.toThrow(ConflictError);
      await expect(sm.transition(current, incomingDiffTrack)).rejects.toThrow(ConflictError);
    });
  });

  describe("Delivery Event Emission", () => {
    it("emits ShipmentDeliveredEvent with carrier proof timestamp upon reaching DELIVERED", async () => {
      const mockSink: TrackingEventSink = {
        emit: vi.fn(),
      };
      const sm = new TrackingStateMachine({ eventSink: mockSink });

      const inTransit = makeMilestone(ShipmentMilestoneStatus.IN_TRANSIT);
      const delivered = makeMilestone(ShipmentMilestoneStatus.DELIVERED, {
        carrierProofTimestamp: "2026-10-21T09:15:00Z",
      });

      const context = {
        mandateId: asMandateId("mandate-xyz-123"),
        authorizationId: asAuthorizationId("auth-abc-999"),
      };

      await sm.transition(inTransit, delivered, context);

      expect(mockSink.emit).toHaveBeenCalledTimes(1);
      expect(mockSink.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SHIPMENT_DELIVERED",
          transactionId: "TX_12345",
          trackingNumber: "1Z9999999999",
          carrier: "UPS",
          status: ShipmentMilestoneStatus.DELIVERED,
          carrierProofTimestamp: "2026-10-21T09:15:00Z",
          mandateId: "mandate-xyz-123",
          authorizationId: "auth-abc-999",
        }),
      );
    });

    it("does not emit duplicate event on idempotent DELIVERED transition", async () => {
      const mockSink: TrackingEventSink = {
        emit: vi.fn(),
      };
      const sm = new TrackingStateMachine({ eventSink: mockSink });

      const delivered = makeMilestone(ShipmentMilestoneStatus.DELIVERED);
      await sm.transition(delivered, delivered);

      expect(mockSink.emit).not.toHaveBeenCalled();
    });

    it("does not emit ShipmentDeliveredEvent for non-delivered transitions", async () => {
      const mockSink: TrackingEventSink = {
        emit: vi.fn(),
      };
      const sm = new TrackingStateMachine({ eventSink: mockSink });

      const shipped = makeMilestone(ShipmentMilestoneStatus.SHIPPED);
      const inTransit = makeMilestone(ShipmentMilestoneStatus.IN_TRANSIT);

      await sm.transition(shipped, inTransit);
      expect(mockSink.emit).not.toHaveBeenCalled();
    });
  });

  describe("SLA Window and Timeout Tracking", () => {
    it("defaults to 48-hour SLA window", () => {
      expect(DEFAULT_TRACKING_SLA_WINDOW_MS).toBe(48 * 60 * 60 * 1000);
      const sm = new TrackingStateMachine();
      const status = sm.checkSlaStatus({
        shipmentCreatedAt: Date.now(),
      });
      expect(status.slaWindowMs).toBe(48 * 60 * 60 * 1000);
      expect(status.isBreached).toBe(false);
      expect(status.recommendation).toBe("PROCEED");
    });

    it("detects breached SLA and recommends authorization void when elapsed > SLA window", () => {
      const sm = new TrackingStateMachine({ slaWindowMs: 24 * 60 * 60 * 1000 }); // 24 hours
      const shipmentCreatedAt = new Date("2026-10-01T00:00:00Z");
      const currentTimestamp = new Date("2026-10-02T01:00:00Z"); // 25 hours later

      const result = sm.checkSlaStatus({
        shipmentCreatedAt,
        currentTimestamp,
        lastMilestone: ShipmentMilestoneStatus.IN_TRANSIT,
      });

      expect(result.isBreached).toBe(true);
      expect(result.warningIssued).toBe(true);
      expect(result.recommendation).toBe("SLA_BREACH_VOID_REQUIRED");
      expect(result.remainingMs).toBe(0);
      expect(result.elapsedMs).toBe(25 * 60 * 60 * 1000);
    });

    it("considers already DELIVERED shipments non-breached even if elapsed > SLA window", () => {
      const sm = new TrackingStateMachine({ slaWindowMs: 48 * 60 * 60 * 1000 });
      const shipmentCreatedAt = new Date("2026-10-01T00:00:00Z");
      const currentTimestamp = new Date("2026-10-05T00:00:00Z"); // 96 hours later

      const result = sm.checkSlaStatus({
        shipmentCreatedAt,
        currentTimestamp,
        lastMilestone: ShipmentMilestoneStatus.DELIVERED,
      });

      expect(result.isBreached).toBe(false);
      expect(result.warningIssued).toBe(false);
      expect(result.recommendation).toBe("PROCEED");
    });

    it("throws CarrierTrackingError if an invalid date string is provided for shipmentCreatedAt", () => {
      const sm = new TrackingStateMachine();
      expect(() =>
        sm.checkSlaStatus({
          shipmentCreatedAt: "THIS_IS_NOT_A_VALID_DATE",
        }),
      ).toThrow(CarrierTrackingError);
    });

    it("throws CarrierTrackingError if an invalid date string is provided for currentTimestamp", () => {
      const sm = new TrackingStateMachine();
      expect(() =>
        sm.checkSlaStatus({
          shipmentCreatedAt: Date.now(),
          currentTimestamp: "THIS_IS_NOT_A_VALID_DATE",
        }),
      ).toThrow(CarrierTrackingError);
    });

    it("preserves numeric currentTimestamp of 0 without treating it as undefined", () => {
      const sm = new TrackingStateMachine({ slaWindowMs: 1000 });
      // shipmentCreatedAt: 0, currentTimestamp: 0 -> elapsed: 0, not breached
      const result = sm.checkSlaStatus({
        shipmentCreatedAt: 0,
        currentTimestamp: 0,
      });
      expect(result.elapsedMs).toBe(0);
      expect(result.isBreached).toBe(false);

      // shipmentCreatedAt: 0, currentTimestamp: 2000 -> elapsed: 2000 > 1000 -> breached
      const breachedResult = sm.checkSlaStatus({
        shipmentCreatedAt: 0,
        currentTimestamp: 2000,
        lastMilestone: ShipmentMilestoneStatus.IN_TRANSIT,
      });
      expect(breachedResult.elapsedMs).toBe(2000);
      expect(breachedResult.isBreached).toBe(true);
      expect(breachedResult.recommendation).toBe("SLA_BREACH_VOID_REQUIRED");
    });
  });
});
