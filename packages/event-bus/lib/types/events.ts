import { z } from "zod";

export const MandateVerifiedDataSchema = z.object({
  transactionId: z.string(),
  mandateId: z.string(),
  agentId: z.string(),
  merchantDomain: z.string(),
  amount: z.number().int().nonnegative(),
  currency: z.string().default("USD"),
  riskScore: z.number().min(0).max(100),
  riskTier: z.enum(["LOW", "ELEVATED", "CRITICAL_HITL"]),
  hitlStatus: z
    .enum(["NOT_REQUIRED", "PENDING_APPROVAL", "APPROVED", "REJECTED"])
    .default("NOT_REQUIRED"),
  metadata: z.record(z.unknown()).optional(),
});
export type MandateVerifiedData = z.infer<typeof MandateVerifiedDataSchema>;

export const MandateVerifiedEventSchema = z.object({
  eventId: z.string(),
  type: z.literal("MandateVerified"),
  timestamp: z.string(),
  sequenceNumber: z.number().optional(),
  data: MandateVerifiedDataSchema,
});
export type MandateVerifiedEvent = z.infer<typeof MandateVerifiedEventSchema>;

export const EscrowLockedDataSchema = z.object({
  transactionId: z.string(),
  mandateId: z.string(),
  orderId: z.string(),
  authorizationId: z.string(),
  amount: z.number().int().nonnegative(),
  currency: z.string().default("USD"),
  heldAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type EscrowLockedData = z.infer<typeof EscrowLockedDataSchema>;

export const EscrowLockedEventSchema = z.object({
  eventId: z.string(),
  type: z.literal("EscrowLocked"),
  timestamp: z.string(),
  sequenceNumber: z.number().optional(),
  data: EscrowLockedDataSchema,
});
export type EscrowLockedEvent = z.infer<typeof EscrowLockedEventSchema>;

export const TrackingUpdatedDataSchema = z.object({
  transactionId: z.string(),
  trackingId: z.string(),
  carrier: z.string(),
  status: z.enum(["SHIPPED", "IN_TRANSIT", "DELIVERED", "CANCELLED", "RETURNED"]),
  estimatedDelivery: z.string().optional(),
  actualDelivery: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type TrackingUpdatedData = z.infer<typeof TrackingUpdatedDataSchema>;

export const TrackingUpdatedEventSchema = z.object({
  eventId: z.string(),
  type: z.literal("TrackingUpdated"),
  timestamp: z.string(),
  sequenceNumber: z.number().optional(),
  data: TrackingUpdatedDataSchema,
});
export type TrackingUpdatedEvent = z.infer<typeof TrackingUpdatedEventSchema>;

export const DisputeOpenedDataSchema = z.object({
  transactionId: z.string(),
  disputeId: z.string(),
  reason: z.string(),
  amount: z.number().int().nonnegative(),
  currency: z.string().default("USD"),
  status: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type DisputeOpenedData = z.infer<typeof DisputeOpenedDataSchema>;

export const DisputeOpenedEventSchema = z.object({
  eventId: z.string(),
  type: z.literal("DisputeOpened"),
  timestamp: z.string(),
  sequenceNumber: z.number().optional(),
  data: DisputeOpenedDataSchema,
});
export type DisputeOpenedEvent = z.infer<typeof DisputeOpenedEventSchema>;

export const DisputeResolvedDataSchema = z.object({
  transactionId: z.string(),
  disputeId: z.string(),
  outcome: z.enum(["REFUNDED", "RESOLVED", "MERCHANT_FAVOR", "BUYER_FAVOR", "CLAIM_ACCEPTED"]),
  resolutionDate: z.string().optional(),
  refundAmount: z.number().int().nonnegative().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type DisputeResolvedData = z.infer<typeof DisputeResolvedDataSchema>;

export const DisputeResolvedEventSchema = z.object({
  eventId: z.string(),
  type: z.literal("DisputeResolved"),
  timestamp: z.string(),
  sequenceNumber: z.number().optional(),
  data: DisputeResolvedDataSchema,
});
export type DisputeResolvedEvent = z.infer<typeof DisputeResolvedEventSchema>;

export type DomainEvent =
  | MandateVerifiedEvent
  | EscrowLockedEvent
  | TrackingUpdatedEvent
  | DisputeOpenedEvent
  | DisputeResolvedEvent;

export type DomainEventType = DomainEvent["type"];
