import { DisputeError, MandateValidationError, Money } from "@tessera/core";
import { describe, expect, it, vi } from "vitest";
import {
  acceptDisputeClaim,
  type DisputeEscalatedEvent,
  type DisputeEventSink,
  DisputeResolutionHandler,
  type DisputeResolvedEvent,
  escalateDispute,
  evaluateDisputePolicy,
  normalizePayPalDispute,
  PayPalAuthClient,
  PayPalClient,
} from "../index.js";

function createMockTokenResponse() {
  return {
    access_token: "MOCK_TOKEN_RESOLUTION",
    token_type: "Bearer",
    expires_in: 3600,
  };
}

function createMockSubsequentActionResponse(overrides: Record<string, unknown> = {}) {
  return {
    links: [
      {
        href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-77889",
        rel: "self",
        method: "GET",
      },
    ],
    ...overrides,
  };
}

function createMockDisputeDomain(overrides: Record<string, unknown> = {}) {
  return normalizePayPalDispute({
    dispute_id: "PP-D-77889",
    create_time: "2026-10-20T10:00:00Z",
    status: "WAITING_FOR_SELLER_RESPONSE",
    dispute_amount: {
      currency_code: "USD",
      value: "89.50",
    },
    disputed_transactions: [
      {
        seller_transaction_id: "TX-SELLER-77889",
      },
    ],
    ...overrides,
  });
}

describe("DisputeResolutionHandler", () => {
  const dummyConfig = {
    clientId: "CLIENT_ID",
    clientSecret: "CLIENT_SECRET",
    environment: "sandbox" as const,
  };

  describe("acceptClaim", () => {
    it("successfully accepts dispute claim and issues refund", async () => {
      const fetchSpy = vi.fn();
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockSubsequentActionResponse()), { status: 200 }),
      );

      const capturedEvents: DisputeResolvedEvent[] = [];
      const eventSink: DisputeEventSink = {
        emitResolved: (e) => {
          capturedEvents.push(e);
        },
      };

      const auth = new PayPalAuthClient({
        ...dummyConfig,
        customFetch: fetchSpy as unknown as typeof fetch,
      });
      const handler = new DisputeResolutionHandler(auth, { eventSink });

      const refundAmount = Money.fromDecimalString("89.50", "USD");
      const result = await handler.acceptClaim({
        disputeId: "PP-D-77889",
        transactionId: "TX-SELLER-77889",
        note: "Accepting buyer claim due to carrier lost package",
        acceptClaimType: "REFUND",
        refundAmount,
      });

      expect(result.disputeId).toBe("PP-D-77889");
      expect(result.status).toBe("CLAIM_ACCEPTED");
      expect(result.refundAmount?.toDecimalString()).toBe("89.50");
      expect(result.resolvedAt).toBeDefined();

      // Verify endpoint and payload
      const call = fetchSpy.mock.calls[1];
      const calledUrl = call?.[0] as string;
      const calledOptions = call?.[1] as RequestInit;
      expect(calledUrl).toBe(
        "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-77889/accept-claim",
      );
      expect(calledOptions.method).toBe("POST");

      const body = JSON.parse(calledOptions.body as string);
      expect(body.note).toBe("Accepting buyer claim due to carrier lost package");
      expect(body.accept_claim_type).toBe("REFUND");
      expect(body.refund_amount).toEqual({
        currency_code: "USD",
        value: "89.50",
      });

      // Verify domain event
      expect(capturedEvents).toHaveLength(1);
      const ev = capturedEvents[0];
      expect(ev).toBeDefined();
      if (!ev) throw new Error("Expected event");
      expect(ev.type).toBe("dispute.resolved");
      expect(ev.disputeId).toBe("PP-D-77889");
      expect(ev.transactionId).toBe("TX-SELLER-77889");
      expect(ev.resolutionAction).toBe("ACCEPT_CLAIM");
      expect(ev.refundAmount?.toDecimalString()).toBe("89.50");
    });

    it("throws MandateValidationError when disputeId is missing", async () => {
      const auth = new PayPalAuthClient(dummyConfig);
      const handler = new DisputeResolutionHandler(auth);

      await expect(handler.acceptClaim({ disputeId: "" })).rejects.toThrow(MandateValidationError);
    });

    it("throws DisputeError when PayPal rejects claim acceptance", async () => {
      const fetchSpy = vi.fn();
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "ACTION_NOT_ALLOWED",
            message: "Dispute already closed",
          }),
          { status: 422 },
        ),
      );

      const auth = new PayPalAuthClient({
        ...dummyConfig,
        customFetch: fetchSpy as unknown as typeof fetch,
      });
      const handler = new DisputeResolutionHandler(auth);

      await expect(handler.acceptClaim({ disputeId: "PP-D-77889" })).rejects.toThrow(DisputeError);
    });
  });

  describe("escalateDispute", () => {
    it("successfully escalates dispute to PayPal claim for adjudication", async () => {
      const fetchSpy = vi.fn();
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockSubsequentActionResponse()), { status: 200 }),
      );

      const capturedEvents: DisputeEscalatedEvent[] = [];
      const eventSink: DisputeEventSink = {
        emitEscalated: (e) => {
          capturedEvents.push(e);
        },
      };

      const auth = new PayPalAuthClient({
        ...dummyConfig,
        customFetch: fetchSpy as unknown as typeof fetch,
      });
      const handler = new DisputeResolutionHandler(auth, { eventSink });

      const result = await handler.escalateDispute({
        disputeId: "PP-D-77889",
        transactionId: "TX-SELLER-77889",
        note: "Delivery confirmed by carrier tracking; buyer dispute unresolved beyond SLA",
        buyerEscalationReason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      });

      expect(result.disputeId).toBe("PP-D-77889");
      expect(result.status).toBe("ESCALATED");
      expect(result.escalatedAt).toBeDefined();

      const call = fetchSpy.mock.calls[1];
      const calledUrl = call?.[0] as string;
      const calledOptions = call?.[1] as RequestInit;
      expect(calledUrl).toBe(
        "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-77889/escalate",
      );
      expect(calledOptions.method).toBe("POST");

      const body = JSON.parse(calledOptions.body as string);
      expect(body.note).toBe(
        "Delivery confirmed by carrier tracking; buyer dispute unresolved beyond SLA",
      );
      expect(body.buyer_escalation_reason).toBe("MERCHANDISE_OR_SERVICE_NOT_RECEIVED");

      // Verify domain event
      expect(capturedEvents).toHaveLength(1);
      const ev = capturedEvents[0];
      expect(ev).toBeDefined();
      if (!ev) throw new Error("Expected event");
      expect(ev.type).toBe("dispute.escalated");
      expect(ev.disputeId).toBe("PP-D-77889");
      expect(ev.transactionId).toBe("TX-SELLER-77889");
      expect(ev.reason).toBe("MERCHANDISE_OR_SERVICE_NOT_RECEIVED");
    });

    it("throws MandateValidationError when escalation note is empty or exceeds 2000 characters", async () => {
      const auth = new PayPalAuthClient(dummyConfig);
      const handler = new DisputeResolutionHandler(auth);

      await expect(
        handler.escalateDispute({ disputeId: "PP-D-77889", note: "   " }),
      ).rejects.toThrow(MandateValidationError);

      const tooLongNote = "A".repeat(2001);
      await expect(
        handler.escalateDispute({ disputeId: "PP-D-77889", note: tooLongNote }),
      ).rejects.toThrow(MandateValidationError);
    });

    it("throws DisputeError when PayPal rejects dispute escalation", async () => {
      const fetchSpy = vi.fn();
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "ACTION_NOT_ALLOWED",
            message: "Dispute cannot be escalated at this stage",
          }),
          { status: 400 },
        ),
      );

      const auth = new PayPalAuthClient({
        ...dummyConfig,
        customFetch: fetchSpy as unknown as typeof fetch,
      });
      const handler = new DisputeResolutionHandler(auth);

      await expect(
        handler.escalateDispute({ disputeId: "PP-D-77889", note: "Escalating" }),
      ).rejects.toThrow(DisputeError);
    });

    it("does not fail claim acceptance when event sink throws an error", async () => {
      const fetchSpy = vi.fn();
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockSubsequentActionResponse()), { status: 200 }),
      );

      const eventSink: DisputeEventSink = {
        emitResolved: () => {
          throw new Error("Sink persistence failure");
        },
      };

      const auth = new PayPalAuthClient({
        ...dummyConfig,
        customFetch: fetchSpy as unknown as typeof fetch,
      });
      const handler = new DisputeResolutionHandler(auth, { eventSink });

      const result = await handler.acceptClaim({ disputeId: "PP-D-77889" });
      expect(result.status).toBe("CLAIM_ACCEPTED");
    });
  });

  describe("evaluatePolicyAndResolve", () => {
    it("accepts claim immediately when supervisor override is present", async () => {
      const fetchSpy = vi.fn();
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockSubsequentActionResponse()), { status: 200 }),
      );

      const auth = new PayPalAuthClient({
        ...dummyConfig,
        customFetch: fetchSpy as unknown as typeof fetch,
      });
      const handler = new DisputeResolutionHandler(auth);

      const dispute = createMockDisputeDomain();
      const decision = await handler.evaluatePolicyAndResolve(dispute, {
        supervisorOverride: true,
      });

      expect(decision.action).toBe("ACCEPT_CLAIM");
      expect(decision.reason).toContain("Supervisor override");
      if (decision.action === "ACCEPT_CLAIM") {
        expect(decision.result.status).toBe("CLAIM_ACCEPTED");
        expect(decision.result.refundAmount?.toDecimalString()).toBe("89.50");
      }
    });

    it("accepts claim autonomously when item is confirmed non-deliverable", async () => {
      const fetchSpy = vi.fn();
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockSubsequentActionResponse()), { status: 200 }),
      );

      const auth = new PayPalAuthClient({
        ...dummyConfig,
        customFetch: fetchSpy as unknown as typeof fetch,
      });
      const handler = new DisputeResolutionHandler(auth, {
        policy: { autoAcceptNonDeliverable: true },
      });

      const dispute = createMockDisputeDomain();
      const decision = await handler.evaluatePolicyAndResolve(dispute, {
        reason: "NON_DELIVERABLE",
      });

      expect(decision.action).toBe("ACCEPT_CLAIM");
      expect(decision.reason).toContain("non-deliverable");
    });

    it("accepts claim autonomously when item is verified damaged and autoAcceptDamaged is enabled", async () => {
      const fetchSpy = vi.fn();
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockSubsequentActionResponse()), { status: 200 }),
      );

      const auth = new PayPalAuthClient({
        ...dummyConfig,
        customFetch: fetchSpy as unknown as typeof fetch,
      });
      const handler = new DisputeResolutionHandler(auth, {
        policy: { autoAcceptDamaged: true },
      });

      const dispute = createMockDisputeDomain();
      const decision = await handler.evaluatePolicyAndResolve(dispute, {
        reason: "DEFECTIVE_OR_DAMAGED",
      });

      expect(decision.action).toBe("ACCEPT_CLAIM");
      expect(decision.reason).toContain("damaged");
    });

    it("escalates to PayPal review when item was delivered with proof and buyer SLA expired", async () => {
      const fetchSpy = vi.fn();
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockSubsequentActionResponse()), { status: 200 }),
      );

      const auth = new PayPalAuthClient({
        ...dummyConfig,
        customFetch: fetchSpy as unknown as typeof fetch,
      });
      const handler = new DisputeResolutionHandler(auth);

      const dispute = createMockDisputeDomain();
      const decision = await handler.evaluatePolicyAndResolve(dispute, {
        isDeliveredWithProof: true,
        buyerUnresponsiveSlaExpired: true,
      });

      expect(decision.action).toBe("ESCALATE");
      expect(decision.reason).toContain("Delivered with proof");
      if (decision.action === "ESCALATE") {
        expect(decision.result.status).toBe("ESCALATED");
      }
    });

    it("escalates using autoEscalateAfterSlaMs policy when dispute createTime exceeds threshold", async () => {
      const fetchSpy = vi.fn();
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockSubsequentActionResponse()), { status: 200 }),
      );

      const auth = new PayPalAuthClient({
        ...dummyConfig,
        customFetch: fetchSpy as unknown as typeof fetch,
      });
      const handler = new DisputeResolutionHandler(auth, {
        policy: { autoEscalateAfterSlaMs: 3600_000 },
      });

      const oldCreateTime = new Date(Date.now() - 7200_000).toISOString();
      const dispute = createMockDisputeDomain({
        create_time: oldCreateTime,
      });

      const decision = await handler.evaluatePolicyAndResolve(dispute, {
        isDeliveredWithProof: true,
      });

      expect(decision.action).toBe("ESCALATE");
    });

    it("does not serialize zero USD refund_amount when dispute amount is zero", async () => {
      const fetchSpy = vi.fn();
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockSubsequentActionResponse()), { status: 200 }),
      );

      const auth = new PayPalAuthClient({
        ...dummyConfig,
        customFetch: fetchSpy as unknown as typeof fetch,
      });
      const handler = new DisputeResolutionHandler(auth);

      const dispute = createMockDisputeDomain({
        dispute_amount: { currency_code: "USD", value: "0.00" },
      });
      await handler.evaluatePolicyAndResolve(dispute, {
        supervisorOverride: true,
      });

      const call = fetchSpy.mock.calls[1];
      const calledOptions = call?.[1] as RequestInit;
      const body = JSON.parse(calledOptions.body as string);
      expect(body.refund_amount).toBeUndefined();
    });

    it("recommends evidence submission when seller response is pending and tracking proof is available", async () => {
      const fetchSpy = vi.fn();
      const auth = new PayPalAuthClient({
        ...dummyConfig,
        customFetch: fetchSpy as unknown as typeof fetch,
      });
      const handler = new DisputeResolutionHandler(auth);

      const dispute = createMockDisputeDomain({
        status: "WAITING_FOR_SELLER_RESPONSE",
      });

      const decision = await handler.evaluatePolicyAndResolve(dispute, {
        trackingAvailable: true,
      });

      expect(decision.action).toBe("SUBMIT_EVIDENCE");
      expect(decision.reason).toContain("Tracking proof available");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns NONE when dispute does not match automated action criteria", async () => {
      const fetchSpy = vi.fn();
      const auth = new PayPalAuthClient({
        ...dummyConfig,
        customFetch: fetchSpy as unknown as typeof fetch,
      });
      const handler = new DisputeResolutionHandler(auth);

      const dispute = createMockDisputeDomain({
        status: "OPEN",
      });

      const decision = await handler.evaluatePolicyAndResolve(dispute);
      expect(decision.action).toBe("NONE");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("High-level API helpers and PayPalClient integration", () => {
    it("acceptDisputeClaim, escalateDispute, and evaluateDisputePolicy helpers delegate correctly", async () => {
      const fetchSpy = vi.fn();
      const testConfig = {
        ...dummyConfig,
        customFetch: fetchSpy as unknown as typeof fetch,
      };

      // Token + Accept Claim
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockSubsequentActionResponse()), { status: 200 }),
      );

      const resAccept = await acceptDisputeClaim(testConfig, {
        disputeId: "PP-D-77889",
      });
      expect(resAccept.status).toBe("CLAIM_ACCEPTED");

      // Token + Escalate
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockSubsequentActionResponse()), { status: 200 }),
      );

      const resEscalate = await escalateDispute(testConfig, {
        disputeId: "PP-D-77889",
        note: "Escalating dispute due to unresolved dispute",
      });
      expect(resEscalate.status).toBe("ESCALATED");

      // Token + Evaluate Policy
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockSubsequentActionResponse()), { status: 200 }),
      );

      const dispute = createMockDisputeDomain();
      const decision = await evaluateDisputePolicy(testConfig, dispute, {
        supervisorOverride: true,
      });
      expect(decision.action).toBe("ACCEPT_CLAIM");
    });

    it("PayPalClient exposes disputeResolution handler and evaluateDisputePolicy method", () => {
      const client = new PayPalClient(dummyConfig);
      expect(client.disputeResolution).toBeInstanceOf(DisputeResolutionHandler);
    });
  });
});
