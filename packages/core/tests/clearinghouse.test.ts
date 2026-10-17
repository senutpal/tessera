import { describe, expect, it } from "vitest";
import {
  type AuthorizationId,
  asAuthorizationId,
  asCaptureId,
  asCarrierTrackingId,
  asMandateId,
  asOrderId,
  asTransactionId,
  type CaptureId,
  type CarrierTrackingId,
  ClearinghouseState,
  EscrowHoldStatus,
  HITLStatus,
  type MandateId,
  MandateType,
  type OrderId,
  RiskTier,
  ShipmentMilestoneStatus,
  type TransactionId,
} from "../index.js";

describe("Clearinghouse Domain Types & Branded Identifiers", () => {
  describe("Branded Type Constructors", () => {
    it("creates branded identifiers that preserve string value semantics", () => {
      const txId: TransactionId = asTransactionId("tx_abc123");
      const mandateId: MandateId = asMandateId("mandate_def456");
      const orderId: OrderId = asOrderId("ord_789ghi");
      const authId: AuthorizationId = asAuthorizationId("auth_012jkl");
      const captureId: CaptureId = asCaptureId("cap_345mno");
      const trackingId: CarrierTrackingId = asCarrierTrackingId("track_678pqr");

      expect(txId).toBe("tx_abc123");
      expect(mandateId).toBe("mandate_def456");
      expect(orderId).toBe("ord_789ghi");
      expect(authId).toBe("auth_012jkl");
      expect(captureId).toBe("cap_345mno");
      expect(trackingId).toBe("track_678pqr");

      // Verify strings can be concatenated and formatted
      expect(`Transaction: ${txId}`).toBe("Transaction: tx_abc123");
      expect(typeof txId).toBe("string");
    });
  });

  describe("Clearinghouse State Enums", () => {
    it("defines valid lifecycle states", () => {
      expect(ClearinghouseState.PENDING_AUTHORIZATION).toBe("PENDING_AUTHORIZATION");
      expect(ClearinghouseState.AUTHORIZED_IN_ESCROW).toBe("AUTHORIZED_IN_ESCROW");
      expect(ClearinghouseState.AWAITING_FULFILLMENT).toBe("AWAITING_FULFILLMENT");
      expect(ClearinghouseState.FULFILLED_DELIVERED).toBe("FULFILLED_DELIVERED");
      expect(ClearinghouseState.SETTLED).toBe("SETTLED");
      expect(ClearinghouseState.VOIDED).toBe("VOIDED");
      expect(ClearinghouseState.DISPUTED).toBe("DISPUTED");
      expect(ClearinghouseState.REFUNDED).toBe("REFUNDED");
      expect(ClearinghouseState.FAILED).toBe("FAILED");
    });

    it("defines escrow hold statuses", () => {
      expect(EscrowHoldStatus.HELD).toBe("HELD");
      expect(EscrowHoldStatus.RELEASED).toBe("RELEASED");
      expect(EscrowHoldStatus.VOIDED).toBe("VOIDED");
      expect(EscrowHoldStatus.EXPIRED).toBe("EXPIRED");
    });

    it("defines shipment milestone statuses", () => {
      expect(ShipmentMilestoneStatus.SHIPPED).toBe("SHIPPED");
      expect(ShipmentMilestoneStatus.IN_TRANSIT).toBe("IN_TRANSIT");
      expect(ShipmentMilestoneStatus.DELIVERED).toBe("DELIVERED");
      expect(ShipmentMilestoneStatus.CANCELLED).toBe("CANCELLED");
      expect(ShipmentMilestoneStatus.RETURNED).toBe("RETURNED");
    });

    it("defines mandate types matching AP2 specifications", () => {
      expect(MandateType.CHECKOUT).toBe("mandate.checkout.1");
      expect(MandateType.PAYMENT).toBe("mandate.payment.1");
    });

    it("defines HITL and Risk tier enums", () => {
      expect(HITLStatus.NOT_REQUIRED).toBe("NOT_REQUIRED");
      expect(HITLStatus.PENDING_APPROVAL).toBe("PENDING_APPROVAL");
      expect(HITLStatus.APPROVED).toBe("APPROVED");
      expect(HITLStatus.REJECTED).toBe("REJECTED");

      expect(RiskTier.LOW).toBe("LOW");
      expect(RiskTier.ELEVATED).toBe("ELEVATED");
      expect(RiskTier.CRITICAL_HITL).toBe("CRITICAL_HITL");
    });
  });
});
