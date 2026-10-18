export enum ClearinghouseState {
  PENDING_AUTHORIZATION = "PENDING_AUTHORIZATION",
  AUTHORIZED_IN_ESCROW = "AUTHORIZED_IN_ESCROW",
  AWAITING_FULFILLMENT = "AWAITING_FULFILLMENT",
  FULFILLED_DELIVERED = "FULFILLED_DELIVERED",
  SETTLED = "SETTLED",
  VOIDED = "VOIDED",
  DISPUTED = "DISPUTED",
  REFUNDED = "REFUNDED",
  FAILED = "FAILED",
}

export enum EscrowHoldStatus {
  HELD = "HELD",
  RELEASED = "RELEASED",
  VOIDED = "VOIDED",
  EXPIRED = "EXPIRED",
}

export enum ShipmentMilestoneStatus {
  SHIPPED = "SHIPPED",
  IN_TRANSIT = "IN_TRANSIT",
  DELIVERED = "DELIVERED",
  CANCELLED = "CANCELLED",
  RETURNED = "RETURNED",
}

export enum MandateType {
  CHECKOUT = "mandate.checkout.1",
  PAYMENT = "mandate.payment.1",
}

export enum HITLStatus {
  NOT_REQUIRED = "NOT_REQUIRED",
  PENDING_APPROVAL = "PENDING_APPROVAL",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
}

export enum RiskTier {
  LOW = "LOW",
  ELEVATED = "ELEVATED",
  CRITICAL_HITL = "CRITICAL_HITL",
}

declare const BrandSymbol: unique symbol;
export type Brand<T, B extends string> = T & { readonly [BrandSymbol]: B };

export type TransactionId = Brand<string, "TransactionId">;
export type MandateId = Brand<string, "MandateId">;
export type OrderId = Brand<string, "OrderId">;
export type AuthorizationId = Brand<string, "AuthorizationId">;
export type CaptureId = Brand<string, "CaptureId">;
export type CarrierTrackingId = Brand<string, "CarrierTrackingId">;

/** Casts an arbitrary string to a nominal TransactionId. */
export function asTransactionId(id: string): TransactionId {
  return id as TransactionId;
}

/** Casts an arbitrary string to a nominal MandateId. */
export function asMandateId(id: string): MandateId {
  return id as MandateId;
}

/** Casts an arbitrary string to a nominal OrderId. */
export function asOrderId(id: string): OrderId {
  return id as OrderId;
}

/** Casts an arbitrary string to a nominal AuthorizationId. */
export function asAuthorizationId(id: string): AuthorizationId {
  return id as AuthorizationId;
}

/** Casts an arbitrary string to a nominal CaptureId. */
export function asCaptureId(id: string): CaptureId {
  return id as CaptureId;
}

/** Casts an arbitrary string to a nominal CarrierTrackingId. */
export function asCarrierTrackingId(id: string): CarrierTrackingId {
  return id as CarrierTrackingId;
}

export interface MandatePayee {
  domain: string;
  id?: string;
  name?: string;
}

export interface MandateItem {
  id: string;
  name: string;
  quantity: number;
  unitAmount: number;
  totalAmount: number;
}
