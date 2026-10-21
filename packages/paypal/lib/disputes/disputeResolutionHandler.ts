import { asTransactionId, DisputeError, MandateValidationError } from "@tessera/core";
import type { PayPalAuthClient } from "../client/paypalAuthClient.js";
import { throwPayPalError } from "../client/paypalErrors.js";
import {
  type AcceptClaimOptions,
  type ClearinghouseDispute,
  ClearinghouseDisputeStatus,
  type DisputeEscalatedEvent,
  type DisputeEscalationResult,
  type DisputeEvaluationContext,
  type DisputeEventSink,
  type DisputePolicyDecision,
  type DisputeResolutionPolicy,
  type DisputeResolutionResult,
  type DisputeResolvedEvent,
  type EscalateDisputeOptions,
  PayPalAcceptClaimWireSchema,
  PayPalEscalateWireSchema,
  PayPalSubsequentActionResponseSchema,
} from "../types/disputes.js";

const DEFAULT_POLICY: DisputeResolutionPolicy = {
  autoAcceptNonDeliverable: true,
  autoAcceptDamaged: false,
};

export class DisputeResolutionHandler {
  private readonly policy: DisputeResolutionPolicy;

  constructor(
    private readonly authClient: PayPalAuthClient,
    private readonly options: {
      eventSink?: DisputeEventSink | undefined;
      policy?: DisputeResolutionPolicy | undefined;
    } = {},
  ) {
    this.policy = { ...DEFAULT_POLICY, ...options.policy };
  }

  /**
   * Accepts liability for a customer dispute via POST /v1/customer/disputes/{dispute_id}/accept-claim,
   * issuing an immediate buyer refund from the merchant account and emitting DisputeResolvedEvent.
   */
  public async acceptClaim(options: AcceptClaimOptions): Promise<DisputeResolutionResult> {
    const disputeId = String(options.disputeId ?? "").trim();
    if (!disputeId) {
      throw new MandateValidationError("Dispute ID is required to accept claim");
    }

    const note =
      options.note?.trim() ||
      "Accepting claim in accordance with autonomous clearinghouse resolution policy";

    const payload = PayPalAcceptClaimWireSchema.parse({
      note,
      accept_claim_type: options.acceptClaimType ?? "REFUND",
      refund_amount: options.refundAmount
        ? {
            currency_code: options.refundAmount.currency,
            value: options.refundAmount.toDecimalString(),
          }
        : undefined,
    });

    const endpoint = `/v1/customer/disputes/${encodeURIComponent(disputeId)}/accept-claim`;
    const res = await this.authClient.fetchAuthenticated(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      await throwPayPalError(
        res,
        `Failed to accept claim for dispute ${disputeId}`,
        (msg, d) => new DisputeError(msg, d),
      );
    }

    const rawData = (await res.json()) as unknown;
    const parsed = PayPalSubsequentActionResponseSchema.safeParse(rawData);
    const links = parsed.success ? parsed.data.links : [];

    const resolvedAt = new Date().toISOString();

    const event: DisputeResolvedEvent = {
      type: "dispute.resolved",
      disputeId,
      transactionId: asTransactionId(disputeId),
      resolutionAction: "ACCEPT_CLAIM",
      resolvedAt,
      refundAmount: options.refundAmount,
      note,
    };

    if (this.options.eventSink?.emitResolved) {
      await this.options.eventSink.emitResolved(event);
    }

    return {
      disputeId,
      status: "CLAIM_ACCEPTED",
      resolvedAt,
      refundAmount: options.refundAmount,
      links,
    };
  }

  /**
   * Escalates a customer dispute to a PayPal claim via POST /v1/customer/disputes/{dispute_id}/escalate
   * for PayPal adjudication, and emits DisputeEscalatedEvent.
   */
  public async escalateDispute(options: EscalateDisputeOptions): Promise<DisputeEscalationResult> {
    const disputeId = String(options.disputeId ?? "").trim();
    if (!disputeId) {
      throw new MandateValidationError("Dispute ID is required to escalate dispute");
    }

    const note = String(options.note ?? "").trim();
    if (!note) {
      throw new MandateValidationError("Escalation note is required", { options });
    }
    if (note.length > 2000) {
      throw new MandateValidationError(
        `Escalation note exceeds maximum allowed length of 2000 characters: received ${note.length}`,
        { length: note.length },
      );
    }

    const payload = PayPalEscalateWireSchema.parse({
      note,
      buyer_escalation_reason: options.buyerEscalationReason,
    });

    const endpoint = `/v1/customer/disputes/${encodeURIComponent(disputeId)}/escalate`;
    const res = await this.authClient.fetchAuthenticated(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      await throwPayPalError(
        res,
        `Failed to escalate dispute ${disputeId} to PayPal`,
        (msg, d) => new DisputeError(msg, d),
      );
    }

    const rawData = (await res.json()) as unknown;
    const parsed = PayPalSubsequentActionResponseSchema.safeParse(rawData);
    const links = parsed.success ? parsed.data.links : [];

    const escalatedAt = new Date().toISOString();

    const event: DisputeEscalatedEvent = {
      type: "dispute.escalated",
      disputeId,
      transactionId: asTransactionId(disputeId),
      escalatedAt,
      note,
      reason: options.buyerEscalationReason,
    };

    if (this.options.eventSink?.emitEscalated) {
      await this.options.eventSink.emitEscalated(event);
    }

    return {
      disputeId,
      status: "ESCALATED",
      escalatedAt,
      note,
      links,
    };
  }

  /**
   * Evaluates clearinghouse dispute policy and autonomously executes claim acceptance,
   * escalation to PayPal review, or recommends evidence submission.
   */
  public async evaluatePolicyAndResolve(
    dispute: ClearinghouseDispute,
    context: DisputeEvaluationContext = {},
  ): Promise<DisputePolicyDecision> {
    // 1. Supervisor override always takes precedence
    if (context.supervisorOverride) {
      const result = await this.acceptClaim({
        disputeId: dispute.disputeId,
        note: "Supervisor override approved dispute claim acceptance",
        refundAmount: dispute.disputeAmount,
      });
      return {
        action: "ACCEPT_CLAIM",
        reason: "Supervisor override triggered immediate claim acceptance",
        result,
      };
    }

    // 2. Non-deliverable item confirmed
    if (context.reason === "NON_DELIVERABLE" && this.policy.autoAcceptNonDeliverable !== false) {
      const result = await this.acceptClaim({
        disputeId: dispute.disputeId,
        note: "Autonomous resolution: product confirmed non-deliverable by carrier logs",
        refundAmount: dispute.disputeAmount,
      });
      return {
        action: "ACCEPT_CLAIM",
        reason: "Confirmed non-deliverable triggers automated claim acceptance and refund",
        result,
      };
    }

    // 3. Damaged or defective item confirmed
    if (context.reason === "DEFECTIVE_OR_DAMAGED" && this.policy.autoAcceptDamaged === true) {
      const result = await this.acceptClaim({
        disputeId: dispute.disputeId,
        note: "Autonomous resolution: item verified damaged or defective",
        refundAmount: dispute.disputeAmount,
      });
      return {
        action: "ACCEPT_CLAIM",
        reason: "Item verified damaged triggers automated claim acceptance",
        result,
      };
    }

    // 4. Delivery proved but buyer remains unresponsive or dispute exceeded SLA
    if (context.isDeliveredWithProof && context.buyerUnresponsiveSlaExpired) {
      const result = await this.escalateDispute({
        disputeId: dispute.disputeId,
        note: "Merchant confirmed delivery with carrier tracking proof; buyer dispute unresolved beyond SLA window",
      });
      return {
        action: "ESCALATE",
        reason: "Delivered with proof and SLA expired triggers PayPal adjudication escalation",
        result,
      };
    }

    // 5. Evidence submission recommended if seller action is required and tracking is available
    if (
      context.trackingAvailable &&
      dispute.status === ClearinghouseDisputeStatus.WAITING_FOR_SELLER
    ) {
      return {
        action: "SUBMIT_EVIDENCE",
        reason: "Tracking proof available to submit as fulfillment evidence",
      };
    }

    return {
      action: "NONE",
      reason: "Dispute state does not qualify for autonomous acceptance or escalation",
    };
  }
}
