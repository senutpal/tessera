import { type Money, PolicyViolationError, type RiskTier } from "@tessera/core";
import type { PaymentMandate } from "@tessera/mandates";

export type PolicyRuleViolationCode =
  | "LIMIT_EXCEEDED"
  | "MERCHANT_DISALLOWED"
  | "MERCHANT_SPOOFING_DETECTED"
  | "CATEGORY_DISALLOWED"
  | "VELOCITY_LIMIT_EXCEEDED"
  | "SUPERVISOR_SIGNATURE_INVALID"
  | "UNAUTHORIZED_SUPERVISOR"
  | "INVALID_QUEUE_STATE"
  | "QUEUE_ITEM_EXPIRED";

export class PolicyRuleViolationError extends PolicyViolationError {
  constructor(
    message: string,
    code: PolicyRuleViolationCode,
    details: Record<string, unknown> = {},
  ) {
    super(message, { code, ...details });
    (this as { code: string }).code = code;
  }
}

export class SpendingLimitExceededError extends PolicyRuleViolationError {
  constructor(
    message = "Transaction amount exceeds configured policy limit",
    details: Record<string, unknown> = {},
  ) {
    super(message, "LIMIT_EXCEEDED", details);
  }
}

export class VelocityLimitExceededError extends PolicyRuleViolationError {
  constructor(
    message = "Rolling spend velocity limit exceeded",
    details: Record<string, unknown> = {},
  ) {
    super(message, "VELOCITY_LIMIT_EXCEEDED", details);
  }
}

export class MerchantDisallowedError extends PolicyRuleViolationError {
  constructor(
    message = "Merchant domain is not in the authorized whitelist",
    details: Record<string, unknown> = {},
  ) {
    super(message, "MERCHANT_DISALLOWED", details);
  }
}

export class MerchantSpoofingError extends PolicyRuleViolationError {
  constructor(
    message = "Merchant domain failed spoofing / homograph validation checks",
    details: Record<string, unknown> = {},
  ) {
    super(message, "MERCHANT_SPOOFING_DETECTED", details);
  }
}

export class DisallowedCategoryError extends PolicyRuleViolationError {
  constructor(
    message = "Procurement category is disallowed by organizational policy",
    details: Record<string, unknown> = {},
  ) {
    super(message, "CATEGORY_DISALLOWED", details);
  }
}

export class InvalidSupervisorSignatureError extends PolicyRuleViolationError {
  constructor(
    message = "Cryptographic supervisor approval signature is invalid",
    details: Record<string, unknown> = {},
  ) {
    super(message, "SUPERVISOR_SIGNATURE_INVALID", details);
  }
}

export class UnauthorizedSupervisorError extends PolicyRuleViolationError {
  constructor(
    message = "Supervisor key is not authorized for policy approval",
    details: Record<string, unknown> = {},
  ) {
    super(message, "UNAUTHORIZED_SUPERVISOR", details);
  }
}

export class InvalidQueueStateError extends PolicyRuleViolationError {
  constructor(
    message = "HITL queue item is not in a valid state for this operation",
    details: Record<string, unknown> = {},
  ) {
    super(message, "INVALID_QUEUE_STATE", details);
  }
}

export class QueueItemExpiredError extends PolicyRuleViolationError {
  constructor(
    message = "HITL approval request has expired",
    details: Record<string, unknown> = {},
  ) {
    super(message, "QUEUE_ITEM_EXPIRED", details);
  }
}

export interface ShippingDestination {
  readonly streetAddress?: string;
  readonly locality?: string;
  readonly region?: string;
  readonly postalCode?: string;
  readonly country: string;
}

export interface PolicyConfig {
  readonly maxAmountPerTransaction: Money;
  readonly maxVelocity24h: Money;
  readonly maxVelocity1h?: Money;
  readonly maxMonthlySpend?: Money;
  readonly autoApprovalLimit: Money;
  readonly hitlRiskThreshold: number;
  readonly allowedMerchantDomains: readonly string[];
  readonly disallowedCategories?: readonly string[];
  readonly authorizedSupervisorPublicKeys: readonly string[];
  readonly queueItemTtlMs?: number;
}

export interface SpendContext {
  readonly agentId: string;
  readonly mandate: PaymentMandate;
  readonly category?: string;
  readonly shippingAddress?: ShippingDestination;
  readonly priorShippingAddresses?: readonly ShippingDestination[];
  readonly isFirstTimeMerchant?: boolean;
  readonly timestamp?: number;
}

export enum HITLDecisionStatus {
  APPROVED = "APPROVED",
  PENDING_HUMAN_APPROVAL = "PENDING_HUMAN_APPROVAL",
  REJECTED = "REJECTED",
}

export interface PolicyViolationDetail {
  readonly code: PolicyRuleViolationCode;
  readonly message: string;
  readonly field?: string;
  readonly details?: Record<string, unknown>;
}

export interface PolicyEvaluationResult {
  readonly approved: boolean;
  readonly requiresHITL: boolean;
  readonly status: HITLDecisionStatus;
  readonly riskScore: number;
  readonly riskTier: RiskTier;
  readonly rationale: readonly string[];
  readonly violations: readonly PolicyViolationDetail[];
  readonly queueId?: string;
}

export enum HITLQueueStatus {
  PENDING_HUMAN_APPROVAL = "PENDING_HUMAN_APPROVAL",
  APPROVED_BY_SUPERVISOR = "APPROVED_BY_SUPERVISOR",
  REJECTED_BY_SUPERVISOR = "REJECTED_BY_SUPERVISOR",
  EXPIRED = "EXPIRED",
}

export interface SupervisorApprovalSubmission {
  readonly queueId: string;
  readonly supervisorPublicKey: string;
  readonly signature: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly timestamp: number;
  readonly comment?: string;
}

export interface SupervisorApprovalPayload {
  readonly queueId: string;
  readonly transactionId: string;
  readonly mandateHash: string;
  readonly decision: "APPROVE" | "REJECT";
  readonly timestamp: number;
  readonly comment?: string;
}

export interface HITLQueueItem {
  readonly id: string;
  readonly agentId: string;
  readonly mandate: PaymentMandate;
  readonly transactionAmount: Money;
  readonly riskScore: number;
  readonly riskTier: RiskTier;
  readonly rationale: readonly string[];
  readonly status: HITLQueueStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly resolvedAt?: number;
  readonly supervisorDecision?: SupervisorApprovalSubmission;
}
