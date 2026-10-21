import type { AP2Amount, MandateId, Money, TransactionId } from "@tessera/core";
import { z } from "zod";
import { PayPalAmountSchema, PayPalLinkSchema, type PayPalLinkWire } from "./orders.js";

// ==========================================
// 1. PayPal Customer Disputes REST Wire Schemas
// ==========================================

export const PayPalDisputeStatusSchema = z.enum([
  "OPEN",
  "WAITING_FOR_BUYER_RESPONSE",
  "WAITING_FOR_SELLER_RESPONSE",
  "UNDER_REVIEW",
  "RESOLVED",
  "OTHER",
]);
export type PayPalDisputeStatus = z.infer<typeof PayPalDisputeStatusSchema>;

export const PayPalDisputeStateSchema = z.enum([
  "OPEN_INQUIRIES",
  "REQUIRED_ACTION",
  "REQUIRED_OTHER_PARTY_ACTION",
  "UNDER_PAYPAL_REVIEW",
  "APPEALABLE",
  "RESOLVED",
]);
export type PayPalDisputeState = z.infer<typeof PayPalDisputeStateSchema>;

export const PayPalDisputeReasonSchema = z.enum([
  "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  "UNAUTHORISED",
  "CREDIT_NOT_PROCESSED",
  "DUPLICATE_TRANSACTION",
  "INCORRECT_AMOUNT",
  "PAYMENT_BY_OTHER_MEANS",
  "CANCELED_RECURRING_BILLING",
  "PROBLEM_WITH_REMITTANCE",
  "OTHER",
]);
export type PayPalDisputeReason = z.infer<typeof PayPalDisputeReasonSchema>;

export const PayPalDisputeLifecycleStageSchema = z.enum([
  "INQUIRY",
  "CHARGEBACK",
  "PRE_ARBITRATION",
  "ARBITRATION",
]);
export type PayPalDisputeLifecycleStage = z.infer<typeof PayPalDisputeLifecycleStageSchema>;

export const PayPalDisputeChannelSchema = z.enum(["INTERNAL", "EXTERNAL", "ALERT"]);
export type PayPalDisputeChannel = z.infer<typeof PayPalDisputeChannelSchema>;

export const PayPalEvidenceTypeSchema = z.enum([
  "PROOF_OF_FULFILLMENT",
  "PROOF_OF_REFUND",
  "PROOF_OF_DELIVERY_SIGNATURE",
  "PROOF_OF_RECEIPT_COPY",
  "RETURN_POLICY",
  "BILLING_AGREEMENT",
  "PROOF_OF_RESHIPMENT",
  "ITEM_DESCRIPTION",
  "POLICE_REPORT",
  "AFFIDAVIT",
  "PAID_WITH_OTHER_METHOD",
  "COPY_OF_CONTRACT",
  "TERMINAL_ATM_RECEIPT",
  "PRICE_DIFFERENCE_REASON",
  "SOURCE_CONVERSION_RATE",
  "BANK_STATEMENT",
  "CREDIT_DUE_REASON",
  "REQUEST_CREDIT_RECEIPT",
  "PROOF_OF_RETURN",
  "CREATE",
  "CHANGE_REASON",
  "PROOF_OF_REFUND_OUTSIDE_PAYPAL",
  "RECEIPT_OF_MERCHANDISE",
  "CUSTOMS_DOCUMENT",
  "CUSTOMS_FEE_RECEIPT",
  "INFORMATION_ON_RESOLUTION",
  "ADDITIONAL_INFORMATION_OF_ITEM",
  "DETAILS_OF_PURCHASE",
  "PROOF_OF_SIGNIFICANT_DIFFERENCE",
  "PROOF_OF_SOFTWARE_OR_SERVICE_NOT_AS_DESCRIBED",
  "PROOF_OF_CONFISCATION",
  "PROOF_OF_DAMAGE",
  "COPY_OF_LAW_ENFORCEMENT_AGENCY_REPORT",
  "ADDITIONAL_PROOF_OF_SHIPMENT",
  "PROOF_OF_DENIAL_BY_CARRIER",
  "THIRDPARTY_PROOF_FOR_DAMAGE_OR_SIGNIFICANT_DIFFERENCE",
  "VALID_SUPPORTING_DOCUMENT",
  "LEGIBLE_SUPPORTING_DOCUMENT",
  "RETURN_TRACKING_INFORMATION",
  "DELIVERY_RECEIPT",
  "PROOF_OF_INSTORE_RECEIPT",
  "ADDITIONAL_TRACKING_INFORMATION",
  "PROOF_OF_SHIPMENT_POSTAGE",
  "ONLINE_TRACKING_INFORMATION",
  "PROOF_OF_INSTORE_REFUND",
  "PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED",
  "RETURN_ADDRESS_FOR_SHIPPING",
  "COPY_OF_THE_EPARCEL_MANIFEST",
  "COPY_OF_SHIPPING_MANIFEST",
  "APPEAL_AFFIDAVIT",
  "RECEIPT_OF_REPLACEMENT",
  "COPY_OF_DRIVERS_LICENSE",
  "ACCOUNT_CHANGE_INFORMATION",
  "DELIVERY_ADDRESS",
  "CONFIRMATION_OF_RESOLUTION",
  "MERCHANT_RESPONSE",
  "PERMISSION_DESCRIPTION",
  "STATUS_OF_MERCHANDISE",
  "LOST_CARD_DETAILS",
  "LAST_VALID_TRANSACTION_DETAILS",
  "ADDITIONAL_PROOF_OF_RETURN",
  "DECLARATION",
  "PROOF_OF_MISSING_ITEMS",
  "PROOF_OF_EMPTY_PACKAGE_OR_DIFFERENT_ITEM",
  "PROOF_OF_ITEM_NOT_RECEIVED",
  "ORDER_DETAILS",
  "LISTING_URL",
  "SHIPPING_INSURANCE",
  "BUYER_RESPONSE",
  "PHOTOS_OF_SHIPPED_ITEM",
  "OTHER",
  "CANCELLATION_DETAILS",
  "MERCHANT_CONTACT_DETAILS",
  "ITEM_DETAILS",
  "CORRECT_RECIPIENT_INFORMATION",
  "EXPLANATION_OF_FUNDS_NOT_DELIVERED",
]);
export type PayPalEvidenceType = z.infer<typeof PayPalEvidenceTypeSchema>;

export const PayPalAcceptClaimTypeSchema = z.enum([
  "REFUND",
  "REFUND_WITH_RETURN",
  "PARTIAL_REFUND",
  "REFUND_WITH_RETURN_SHIPMENT_LABEL",
]);
export type PayPalAcceptClaimType = z.infer<typeof PayPalAcceptClaimTypeSchema>;

export const PayPalDisputeOutcomeCodeSchema = z.enum([
  "RESOLVED_BUYER_FAVOUR",
  "RESOLVED_SELLER_FAVOUR",
  "RESOLVED_WITH_PAYOUT",
  "CANCELED_BY_BUYER",
  "ACCEPTED",
  "DENIED",
  "NONE",
]);
export type PayPalDisputeOutcomeCode = z.infer<typeof PayPalDisputeOutcomeCodeSchema>;

export const PayPalDisputeOutcomeWireSchema = z
  .object({
    outcome_code: z.string().optional(),
    outcome_reason: z.string().optional(),
    amount_refunded: PayPalAmountSchema.optional(),
  })
  .passthrough();
export type PayPalDisputeOutcomeWire = z.infer<typeof PayPalDisputeOutcomeWireSchema>;

export const PayPalDisputedTransactionWireSchema = z
  .object({
    buyer_transaction_id: z.string().optional(),
    seller_transaction_id: z.string().optional(),
    reference_id: z.string().optional(),
    create_time: z.string().optional(),
    transaction_status: z.string().optional(),
    gross_amount: PayPalAmountSchema.optional(),
    invoice_number: z.string().optional(),
    custom: z.string().optional(),
  })
  .passthrough();
export type PayPalDisputedTransactionWire = z.infer<typeof PayPalDisputedTransactionWireSchema>;

export const PayPalDisputeInfoWireSchema = z
  .object({
    dispute_id: z.string(),
    create_time: z.string().optional(),
    update_time: z.string().optional(),
    reason: z.string().optional(),
    status: z.string().optional(),
    dispute_state: z.string().optional(),
    dispute_amount: PayPalAmountSchema.optional(),
    dispute_life_cycle_stage: z.string().optional(),
    dispute_channel: z.string().optional(),
    buyer_response_due_date: z.string().optional(),
    seller_response_due_date: z.string().optional(),
    links: z.array(PayPalLinkSchema).optional(),
  })
  .passthrough();
export type PayPalDisputeInfoWire = z.infer<typeof PayPalDisputeInfoWireSchema>;

export const PayPalDisputeWireSchema = z
  .object({
    dispute_id: z.string(),
    create_time: z.string().optional(),
    update_time: z.string().optional(),
    disputed_transactions: z.array(PayPalDisputedTransactionWireSchema).optional(),
    reason: z.string().optional(),
    status: z.string().optional(),
    dispute_state: z.string().optional(),
    dispute_amount: PayPalAmountSchema.optional(),
    dispute_life_cycle_stage: z.string().optional(),
    dispute_channel: z.string().optional(),
    dispute_outcome: PayPalDisputeOutcomeWireSchema.optional(),
    evidences: z.array(z.record(z.unknown())).optional(),
    buyer_response_due_date: z.string().optional(),
    seller_response_due_date: z.string().optional(),
    links: z.array(PayPalLinkSchema).optional(),
  })
  .passthrough();
export type PayPalDisputeWire = z.infer<typeof PayPalDisputeWireSchema>;

export const PayPalDisputeSearchResponseSchema = z
  .object({
    items: z.array(PayPalDisputeInfoWireSchema).optional().default([]),
    links: z.array(PayPalLinkSchema).optional().default([]),
    total_items: z.number().int().nonnegative().optional(),
    total_pages: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type PayPalDisputeSearchResponseWire = z.infer<typeof PayPalDisputeSearchResponseSchema>;

export const PayPalSubsequentActionResponseSchema = z
  .object({
    links: z.array(PayPalLinkSchema).optional().default([]),
  })
  .passthrough();
export type PayPalSubsequentActionResponseWire = z.infer<
  typeof PayPalSubsequentActionResponseSchema
>;

export const PayPalTrackingInfoWireSchema = z
  .object({
    carrier_name: z.string(),
    carrier_name_other: z.string().optional(),
    tracking_number: z.string(),
    tracking_url: z.string().optional(),
  })
  .passthrough();
export type PayPalTrackingInfoWire = z.infer<typeof PayPalTrackingInfoWireSchema>;

export const PayPalProvideEvidenceWireSchema = z
  .object({
    evidence_type: z.string(),
    evidence_info: z
      .object({
        tracking_info: z.array(PayPalTrackingInfoWireSchema).optional(),
        refund_ids: z.array(z.string()).optional(),
      })
      .optional(),
    notes: z.string().max(2000).optional(),
    item_id: z.string().optional(),
  })
  .passthrough();
export type PayPalProvideEvidenceWire = z.infer<typeof PayPalProvideEvidenceWireSchema>;

export const PayPalProvideEvidencePayloadWireSchema = z
  .object({
    evidences: z.array(PayPalProvideEvidenceWireSchema).min(1),
  })
  .passthrough();
export type PayPalProvideEvidencePayloadWire = z.infer<
  typeof PayPalProvideEvidencePayloadWireSchema
>;

export const PayPalAcceptClaimWireSchema = z
  .object({
    note: z.string().max(2000).optional(),
    accept_claim_type: PayPalAcceptClaimTypeSchema.optional().default("REFUND"),
    refund_amount: PayPalAmountSchema.optional(),
  })
  .passthrough();
export type PayPalAcceptClaimWire = z.infer<typeof PayPalAcceptClaimWireSchema>;

export const PayPalEscalateWireSchema = z
  .object({
    note: z.string().min(1).max(2000),
    buyer_escalation_reason: z.string().optional(),
  })
  .passthrough();
export type PayPalEscalateWire = z.infer<typeof PayPalEscalateWireSchema>;

// ==========================================
// 2. Clearinghouse Dispute Domain Models
// ==========================================

export enum ClearinghouseDisputeStatus {
  OPEN = "OPEN",
  WAITING_FOR_BUYER = "WAITING_FOR_BUYER",
  WAITING_FOR_SELLER = "WAITING_FOR_SELLER",
  UNDER_REVIEW = "UNDER_REVIEW",
  RESOLVED = "RESOLVED",
  OTHER = "OTHER",
}

export enum DisputeAction {
  PROVIDE_EVIDENCE = "PROVIDE_EVIDENCE",
  ACCEPT_CLAIM = "ACCEPT_CLAIM",
  ESCALATE = "ESCALATE",
  APPEAL = "APPEAL",
  SEND_MESSAGE = "SEND_MESSAGE",
}

export interface ClearinghouseDisputeOutcome {
  outcomeCode: string;
  outcomeReason?: string | undefined;
  amountRefunded?: Money | undefined;
}

export interface ClearinghouseDispute {
  disputeId: string;
  transactionId: TransactionId;
  status: ClearinghouseDisputeStatus;
  state: string;
  stage: string;
  reason: string;
  disputeAmount: Money;
  createTime: string;
  updateTime: string;
  sellerResponseDueDate?: string | undefined;
  buyerResponseDueDate?: string | undefined;
  outcome?: ClearinghouseDisputeOutcome | undefined;
  allowedActions: DisputeAction[];
  raw: PayPalDisputeWire | PayPalDisputeInfoWire;
}

export interface DisputeSearchResult {
  disputes: ClearinghouseDispute[];
  totalItems?: number | undefined;
  totalPages?: number | undefined;
  links: PayPalLinkWire[];
  nextPageToken?: string | undefined;
}

export interface ListDisputesOptions {
  disputedTransactionId?: string | TransactionId | undefined;
  disputeState?: PayPalDisputeState | string | undefined;
  disputeLifeCycleStage?: PayPalDisputeLifecycleStage | string | undefined;
  pageSize?: number | undefined;
  nextPageToken?: string | undefined;
  startTime?: string | undefined;
  updateTimeBefore?: string | undefined;
  updateTimeAfter?: string | undefined;
}

// ==========================================
// 3. Evidence Packaging & Submission Types
// ==========================================

export interface CarrierTrackingEvidence {
  carrierName: string;
  carrierNameOther?: string | undefined;
  trackingNumber: string;
  trackingUrl?: string | undefined;
  deliveryProofTimestamp?: string | Date | undefined;
  milestoneStatus?: string | undefined;
}

export interface SignedMandateEvidence {
  mandateId: string | MandateId;
  signature: string;
  publicKey?: string | undefined;
  payloadHash?: string | undefined;
  amount?: Money | AP2Amount | string | undefined;
  payeeDomain?: string | undefined;
  buyerId?: string | undefined;
  signedAt?: string | undefined;
}

export interface Channel3QuoteEvidence {
  quoteId: string;
  merchantDomain?: string | undefined;
  productId?: string | undefined;
  productTitle?: string | undefined;
  total?: Money | AP2Amount | string | undefined;
  price?: Money | AP2Amount | string | undefined;
  shipping?: Money | AP2Amount | string | undefined;
  estimatedDeliveryDays?: number | undefined;
  validUntil?: string | undefined;
}

export interface EvidenceDocument {
  name: string;
  content: Buffer | Uint8Array | string;
  contentType: string;
}

export interface EvidenceBundleInput {
  disputeId: string;
  transactionId?: string | TransactionId | undefined;
  evidenceType?: PayPalEvidenceType | string | undefined;
  tracking?: CarrierTrackingEvidence | undefined;
  mandate?: SignedMandateEvidence | undefined;
  quote?: Channel3QuoteEvidence | undefined;
  notes?: string | undefined;
  documents?: EvidenceDocument[] | undefined;
  itemId?: string | undefined;
}

export interface EvidenceSubmissionResult {
  disputeId: string;
  status: "EVIDENCE_SUBMITTED";
  evidenceHash: string;
  submittedAt: string;
  links?: PayPalLinkWire[] | undefined;
}

// ==========================================
// 4. Dispute Resolution & Escalation Types
// ==========================================

export interface AcceptClaimOptions {
  disputeId: string;
  note?: string | undefined;
  acceptClaimType?: PayPalAcceptClaimType | undefined;
  refundAmount?: Money | undefined;
}

export interface DisputeResolutionResult {
  disputeId: string;
  status: "CLAIM_ACCEPTED";
  resolvedAt: string;
  refundAmount?: Money | undefined;
  links?: PayPalLinkWire[] | undefined;
}

export interface EscalateDisputeOptions {
  disputeId: string;
  note: string;
  buyerEscalationReason?: string | undefined;
}

export interface DisputeEscalationResult {
  disputeId: string;
  status: "ESCALATED";
  escalatedAt: string;
  note: string;
  links?: PayPalLinkWire[] | undefined;
}

export interface DisputeResolutionPolicy {
  /** If true, claims for items confirmed non-deliverable will be automatically accepted */
  autoAcceptNonDeliverable?: boolean | undefined;
  /** If true, claims for items verified damaged/defective will be automatically accepted */
  autoAcceptDamaged?: boolean | undefined;
  /** Max milliseconds before escalating an unresolvable dispute to PayPal review */
  autoEscalateAfterSlaMs?: number | undefined;
}

export interface DisputeEvaluationContext {
  reason?: "NON_DELIVERABLE" | "DEFECTIVE_OR_DAMAGED" | "BUYER_REMORSE" | "OTHER" | undefined;
  supervisorOverride?: boolean | undefined;
  isDeliveredWithProof?: boolean | undefined;
  buyerUnresponsiveSlaExpired?: boolean | undefined;
  trackingAvailable?: boolean | undefined;
}

export type DisputePolicyDecision =
  | {
      action: "ACCEPT_CLAIM";
      reason: string;
      result: DisputeResolutionResult;
    }
  | {
      action: "ESCALATE";
      reason: string;
      result: DisputeEscalationResult;
    }
  | {
      action: "SUBMIT_EVIDENCE";
      reason: string;
    }
  | {
      action: "NONE";
      reason: string;
    };

// ==========================================
// 5. Domain Events & Event Sink
// ==========================================

export interface DisputeEvidenceSubmittedEvent {
  type: "dispute.evidence_submitted";
  disputeId: string;
  transactionId: TransactionId;
  evidenceType: string;
  evidenceHash: string;
  submittedAt: string;
  trackingNumber?: string | undefined;
  carrierName?: string | undefined;
  mandateId?: MandateId | undefined;
  quoteId?: string | undefined;
}

export interface DisputeResolvedEvent {
  type: "dispute.resolved";
  disputeId: string;
  transactionId: TransactionId;
  resolutionAction: "ACCEPT_CLAIM" | "RESOLVED_BY_PAYPAL" | "SETTLED";
  resolvedAt: string;
  refundAmount?: Money | undefined;
  note?: string | undefined;
}

export interface DisputeEscalatedEvent {
  type: "dispute.escalated";
  disputeId: string;
  transactionId: TransactionId;
  escalatedAt: string;
  note: string;
  reason?: string | undefined;
}

export interface DisputeEventSink {
  emitEvidenceSubmitted?(event: DisputeEvidenceSubmittedEvent): Promise<void> | void;
  emitResolved?(event: DisputeResolvedEvent): Promise<void> | void;
  emitEscalated?(event: DisputeEscalatedEvent): Promise<void> | void;
}
