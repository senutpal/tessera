import type {
  AuthorizationId,
  CaptureId,
  ClearinghouseState,
  MandateId,
  Money,
  ShipmentMilestoneStatus,
  TransactionId,
} from "@tessera/core";
import { z } from "zod";
import { PayPalAmountSchema, PayPalLinkSchema, type PayPalLinkWire } from "./orders.js";

// ==========================================
// 1. PayPal Tracking Wire Schemas (OpenAPI v1)
// ==========================================

export const PayPalTrackingStatusSchema = z.enum([
  "CANCELLED",
  "DELIVERED",
  "LOCAL_PICKUP",
  "ON_HOLD",
  "SHIPPED",
  "SHIPMENT_CREATED",
  "DROPPED_OFF",
  "IN_TRANSIT",
  "RETURNED",
  "LABEL_PRINTED",
  "ERROR",
  "UNCONFIRMED",
  "PICKUP_FAILED",
  "DELIVERY_DELAYED",
  "DELIVERY_SCHEDULED",
  "DELIVERY_FAILED",
  "INRETURN",
  "IN_PROCESS",
  "NEW",
  "VOID",
  "PROCESSED",
  "NOT_SHIPPED",
  "COMPLETED",
]);
export type PayPalTrackingStatus = z.infer<typeof PayPalTrackingStatusSchema>;

export const PayPalTrackingNumberTypeSchema = z.enum(["CARRIER_PROVIDED", "EPOSTAGE"]);
export type PayPalTrackingNumberType = z.infer<typeof PayPalTrackingNumberTypeSchema>;

export const PayPalShipmentDirectionSchema = z.enum(["FORWARD", "RETURN"]);
export type PayPalShipmentDirection = z.infer<typeof PayPalShipmentDirectionSchema>;

export const PayPalShipmentUploaderSchema = z.enum(["MERCHANT", "CONSUMER", "PARTNER"]);
export type PayPalShipmentUploader = z.infer<typeof PayPalShipmentUploaderSchema>;

export const PayPalTrackerItemSchema = z
  .object({
    transaction_id: z.string().trim().min(1, "transaction_id is required"),
    tracking_number: z.string().trim().min(1).optional(),
    tracking_number_type: PayPalTrackingNumberTypeSchema.optional(),
    status: PayPalTrackingStatusSchema,
    shipment_date: z.string().optional(),
    carrier: z.string().trim().min(1).optional(),
    carrier_name_other: z.string().trim().min(1).optional(),
    postage_payment_id: z.string().optional(),
    notify_buyer: z.boolean().optional(),
    quantity: z.number().int().positive().optional(),
    tracking_number_validated: z.boolean().optional(),
    last_updated_time: z.string().optional(),
    shipment_direction: PayPalShipmentDirectionSchema.optional(),
    shipment_uploader: PayPalShipmentUploaderSchema.optional(),
    account_id: z.string().optional(),
    tracking_url: z.string().url().optional(),
    links: z.array(PayPalLinkSchema).optional(),
  })
  .passthrough();
export type PayPalTrackerItem = z.infer<typeof PayPalTrackerItemSchema>;

export const PayPalTrackerIdentifierSchema = z
  .object({
    transaction_id: z.string().trim().min(1),
    tracking_number: z.string().optional(),
    links: z.array(PayPalLinkSchema).optional(),
  })
  .passthrough();
export type PayPalTrackerIdentifier = z.infer<typeof PayPalTrackerIdentifierSchema>;

export const PayPalBatchTrackerCollectionSchema = z
  .object({
    tracker_identifiers: z.array(PayPalTrackerIdentifierSchema).optional(),
    errors: z.array(z.record(z.unknown())).optional(),
    links: z.array(PayPalLinkSchema).optional(),
  })
  .passthrough();
export type PayPalBatchTrackerCollection = z.infer<typeof PayPalBatchTrackerCollectionSchema>;

// ==========================================
// 2. PayPal Capture Wire Schemas (OpenAPI v2)
// ==========================================

export const PayPalCaptureStatusSchema = z.enum([
  "COMPLETED",
  "DECLINED",
  "PARTIALLY_REFUNDED",
  "PENDING",
  "REFUNDED",
  "FAILED",
]);
export type PayPalCaptureStatus = z.infer<typeof PayPalCaptureStatusSchema>;

export const PayPalCaptureResponseSchema = z
  .object({
    id: z.string().trim().min(1),
    status: PayPalCaptureStatusSchema,
    status_details: z
      .object({
        reason: z.string().optional(),
      })
      .passthrough()
      .optional(),
    amount: PayPalAmountSchema,
    final_capture: z.boolean().optional(),
    seller_protection: z
      .object({
        status: z.string().optional(),
        dispute_categories: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    seller_receivable_breakdown: z.record(z.unknown()).optional(),
    invoice_id: z.string().optional(),
    custom_id: z.string().optional(),
    create_time: z.string().optional(),
    update_time: z.string().optional(),
    links: z.array(PayPalLinkSchema).optional(),
  })
  .passthrough();
export type PayPalCaptureResponse = z.infer<typeof PayPalCaptureResponseSchema>;

// ==========================================
// 3. Domain Models & Inputs
// ==========================================

export interface CreateTrackerInput {
  transactionId: string | TransactionId;
  trackingNumber?: string | undefined;
  carrier?: string | undefined;
  carrierNameOther?: string | undefined;
  status?: PayPalTrackingStatus | undefined;
  shipmentDate?: string | undefined;
  trackingNumberType?: PayPalTrackingNumberType | undefined;
  notifyBuyer?: boolean | undefined;
  quantity?: number | undefined;
  trackingUrl?: string | undefined;
}

export interface BatchTrackersInput {
  trackers: CreateTrackerInput[];
}

export interface BatchTrackersResult {
  trackerIdentifiers: Array<{
    transactionId: TransactionId;
    trackingNumber?: string | undefined;
    trackerId: string;
    links: PayPalLinkWire[];
  }>;
  errors?: Array<Record<string, unknown>> | undefined;
  rawResponse: PayPalBatchTrackerCollection;
}

export interface ShipmentMilestone {
  transactionId: TransactionId;
  trackingNumber: string;
  carrier: string;
  carrierNameOther?: string | undefined;
  status: ShipmentMilestoneStatus;
  rawStatus: PayPalTrackingStatus;
  carrierProofTimestamp?: string | undefined;
  trackingUrl?: string | undefined;
  trackingNumberValidated?: boolean | undefined;
  rawTracker?: Record<string, unknown> | undefined;
}

export interface SlaStatusResult {
  isBreached: boolean;
  elapsedMs: number;
  remainingMs: number;
  slaWindowMs: number;
  warningIssued: boolean;
  recommendation: "PROCEED" | "SLA_BREACH_VOID_REQUIRED";
}

export interface SupervisorOverride {
  authorizedBy: string;
  reason: string;
  signature?: string | undefined;
  approvedAt?: string | undefined;
}

export interface EscrowCaptureOptions {
  authorizationId: string | AuthorizationId;
  milestone?: ShipmentMilestone | undefined;
  deliveryProof?: ShipmentDeliveredEvent | undefined;
  supervisorOverride?: SupervisorOverride | undefined;
  amount?: Money | undefined;
  mandateId?: string | MandateId | undefined;
  transactionId?: string | TransactionId | undefined;
  invoiceId?: string | undefined;
  noteToPayer?: string | undefined;
  softDescriptor?: string | undefined;
  requestId?: string | undefined;
  finalCapture?: boolean | undefined;
}

export interface EscrowCaptureResult {
  authorizationId: AuthorizationId;
  captureId: CaptureId;
  status: "COMPLETED" | "SETTLED" | "PENDING";
  amount: Money;
  capturedAt: string;
  requestId: string;
  releaseTrigger: "CARRIER_DELIVERY_PROOF" | "SUPERVISOR_OVERRIDE";
  clearinghouseState: ClearinghouseState.SETTLED;
  rawResponse: PayPalCaptureResponse;
  eventEmitError?: string | undefined;
}

// ==========================================
// 4. Clearinghouse Domain Events & Sinks
// ==========================================

export interface ShipmentDeliveredEvent {
  type: "SHIPMENT_DELIVERED";
  transactionId: TransactionId;
  trackingNumber: string;
  carrier: string;
  status: ShipmentMilestoneStatus.DELIVERED;
  carrierProofTimestamp: string;
  mandateId?: MandateId | undefined;
  authorizationId?: AuthorizationId | undefined;
  rawTracker?: Record<string, unknown> | undefined;
  timestamp: string;
}

export interface EscrowReleasedEvent {
  type: "ESCROW_RELEASED";
  authorizationId: AuthorizationId;
  captureId: CaptureId;
  transactionId?: TransactionId | undefined;
  mandateId?: MandateId | undefined;
  amount: Money;
  status: "SETTLED" | "COMPLETED";
  capturedAt: string;
  requestId: string;
  releaseTrigger: "CARRIER_DELIVERY_PROOF" | "SUPERVISOR_OVERRIDE";
  supervisorSignature?: string | undefined;
  rawCapture?: Record<string, unknown> | undefined;
  timestamp: string;
}

export interface TrackingEventSink {
  emit: (event: ShipmentDeliveredEvent) => Promise<void> | void;
}

export interface CaptureEventSink {
  emit: (event: EscrowReleasedEvent) => Promise<void> | void;
}
