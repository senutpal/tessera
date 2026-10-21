import { z } from "zod";

export const ClearinghouseRecordSchema = z.object({
  transactionId: z.string(),
  mandateId: z.string(),
  agentId: z.string(),
  merchantDomain: z.string(),
  amount: z.number().int().nonnegative(),
  currency: z.string().default("USD"),
  clearinghouseState: z.enum([
    "PENDING_AUTHORIZATION",
    "AUTHORIZED_IN_ESCROW",
    "AWAITING_FULFILLMENT",
    "FULFILLED_DELIVERED",
    "SETTLED",
    "VOIDED",
    "DISPUTED",
    "REFUNDED",
    "FAILED",
  ]),
  escrowStatus: z.enum([
    "PENDING_AUTHORIZATION",
    "AUTHORIZED_HOLD",
    "IN_TRANSIT",
    "DELIVERED_CAPTURED",
    "SLA_BREACH_VOIDED",
    "DISPUTED",
    "REFUNDED",
    "SETTLED",
  ]),
  riskScore: z.number().min(0).max(100),
  riskTier: z.enum(["LOW", "ELEVATED", "CRITICAL_HITL"]),
  hitlStatus: z
    .enum(["NOT_REQUIRED", "PENDING_APPROVAL", "APPROVED", "REJECTED"])
    .default("NOT_REQUIRED"),
  authorizationId: z.string().optional(),
  orderId: z.string().optional(),
  captureId: z.string().optional(),
  trackingId: z.string().optional(),
  carrier: z.string().optional(),
  disputeId: z.string().optional(),
  disputeReason: z.string().optional(),
  disputeOutcome: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sequenceNumber: z.number().int().nonnegative(),
  timestampMicros: z.number().int().nonnegative(),
});

export type ClearinghouseRecord = z.infer<typeof ClearinghouseRecordSchema>;

export type GridDeltaType = "add" | "update" | "remove";

export interface GridDeltaItem {
  type: GridDeltaType;
  data: ClearinghouseRecord;
}

export interface GridTransaction {
  add: ClearinghouseRecord[];
  update: ClearinghouseRecord[];
  remove: ClearinghouseRecord[];
}

export interface GridDeltaBatch {
  sequenceNumber: number;
  timestampMicros: number;
  timestamp: string;
  deltas: GridDeltaItem[];
  transaction: GridTransaction;
}

/**
 * Returns epoch timestamp in microseconds with high precision.
 */
export function getMicrosecondTimestamp(): number {
  const nowMs = Date.now();
  const hrMicros = Number((process.hrtime.bigint() / 1000n) % 1000n);
  return nowMs * 1000 + hrMicros;
}
