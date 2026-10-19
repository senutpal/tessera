import { type AuthorizationId, DomainError, type Money, type OrderId } from "@tessera/core";
import { z } from "zod";
import { PayPalLinkSchema } from "./orders.js";

// ==========================================
// 1. Webhook Wire Schemas & Headers
// ==========================================

export const PAYPAL_CERT_URL_REGEX = /^https:\/\/api(-m)?\.(sandbox\.)?paypal\.com(?::443)?\//i;

export const PayPalWebhookHeadersSchema = z.object({
  authAlgo: z.string().trim().min(1, "Missing PAYPAL-AUTH-ALGO header"),
  certUrl: z.string().trim().url("Invalid PAYPAL-CERT-URL format"),
  transmissionId: z.string().trim().min(1, "Missing PAYPAL-TRANSMISSION-ID header"),
  transmissionSig: z.string().trim().min(1, "Missing PAYPAL-TRANSMISSION-SIG header"),
  transmissionTime: z.string().trim().min(1, "Missing PAYPAL-TRANSMISSION-TIME header"),
});
export type PayPalWebhookHeaders = z.infer<typeof PayPalWebhookHeadersSchema>;

export const PayPalWebhookEventSchema = z
  .object({
    id: z.string(),
    create_time: z.string().optional(),
    resource_type: z.string().optional(),
    event_version: z.string().optional(),
    event_type: z.string(),
    summary: z.string().optional(),
    resource_version: z.string().optional(),
    resource: z.record(z.unknown()),
    links: z.array(PayPalLinkSchema).optional(),
  })
  .passthrough();
export type PayPalWebhookEvent = z.infer<typeof PayPalWebhookEventSchema>;

export const PayPalVerifyWebhookSignatureRequestSchema = z.object({
  auth_algo: z.string(),
  cert_url: z.string(),
  transmission_id: z.string(),
  transmission_sig: z.string(),
  transmission_time: z.string(),
  webhook_id: z.string(),
  webhook_event: z.record(z.unknown()),
});
export type PayPalVerifyWebhookSignatureRequest = z.infer<
  typeof PayPalVerifyWebhookSignatureRequestSchema
>;

export const PayPalVerifyWebhookSignatureResponseSchema = z.object({
  verification_status: z.enum(["SUCCESS", "FAILURE"]),
});
export type PayPalVerifyWebhookSignatureResponse = z.infer<
  typeof PayPalVerifyWebhookSignatureResponseSchema
>;

// ==========================================
// 2. Domain Events for Clearinghouse
// ==========================================

export interface ClearinghouseAuthorizationCreatedEvent {
  type: "PAYMENT.AUTHORIZATION.CREATED";
  authorizationId: AuthorizationId;
  orderId?: OrderId | undefined;
  amount: Money;
  status: string;
  createTime: string;
  expirationTime?: string | undefined;
  parentPayment?: string | undefined;
  rawResource: Record<string, unknown>;
  transmissionId: string;
  timestamp: string;
}

export interface ClearinghouseAuthorizationVoidedEvent {
  type: "PAYMENT.AUTHORIZATION.VOIDED";
  authorizationId: AuthorizationId;
  orderId?: OrderId | undefined;
  amount?: Money | undefined;
  reason?: string | undefined;
  status: "VOIDED";
  updateTime?: string | undefined;
  rawResource: Record<string, unknown>;
  transmissionId: string;
  timestamp: string;
}

export type ClearinghouseWebhookEvent =
  | ClearinghouseAuthorizationCreatedEvent
  | ClearinghouseAuthorizationVoidedEvent;

export interface WebhookEventSink {
  emit: (event: ClearinghouseWebhookEvent) => Promise<void> | void;
}

// ==========================================
// 3. Verification & Processing Models
// ==========================================

export interface WebhookVerificationOptions {
  webhookId?: string | undefined;
  maxClockSkewMs?: number | undefined;
  checkReplay?: boolean | undefined;
  fallbackToRemote?: boolean | undefined;
}

export interface WebhookVerificationResult {
  isValid: boolean;
  isDuplicate: boolean;
  method: "LOCAL_ASYMMETRIC" | "REMOTE_POSTBACK";
  transmissionId: string;
  algorithm: string;
  certUrl: string;
  failureReason?: string | undefined;
}

export type WebhookProcessingStatus =
  | "PROCESSED"
  | "DUPLICATE"
  | "IGNORED"
  | "INVALID_SIGNATURE"
  | "MALFORMED_PAYLOAD"
  | "DISPATCH_ERROR";

export interface WebhookProcessingResult {
  status: WebhookProcessingStatus;
  httpStatus: number;
  message: string;
  transmissionId?: string | undefined;
  eventType?: string | undefined;
  domainEvent?: ClearinghouseWebhookEvent | undefined;
  error?: string | undefined;
}

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined> | Headers | PayPalWebhookHeaders;
  rawBody: Buffer | Uint8Array | string;
  webhookId?: string | undefined;
}

// ==========================================
// 4. Domain Errors
// ==========================================

export class WebhookVerificationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "WEBHOOK_VERIFICATION_FAILED", 400, details);
  }
}

export class UntrustedCertificateUrlError extends DomainError {
  public readonly certUrl: string;

  constructor(certUrl: string, details?: Record<string, unknown>) {
    super(
      `Untrusted certificate URL rejected: "${certUrl}". Must match PayPal hostname whitelist.`,
      "UNTRUSTED_CERTIFICATE_URL",
      400,
      { certUrl, ...details },
    );
    this.certUrl = certUrl;
  }
}

export class WebhookReplayError extends DomainError {
  public readonly transmissionId: string;

  constructor(transmissionId: string, details?: Record<string, unknown>) {
    super(
      `Webhook transmission "${transmissionId}" has already been processed within the replay window.`,
      "WEBHOOK_REPLAY_DETECTED",
      409,
      { transmissionId, ...details },
    );
    this.transmissionId = transmissionId;
  }
}

export class WebhookRoutingError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "WEBHOOK_ROUTING_FAILED", 500, details);
  }
}

// ==========================================
// 5. Header Normalization Utility
// ==========================================

/**
 * Case-insensitively extracts mandatory PayPal webhook headers from a headers object,
 * Node IncomingHttpHeaders, or a Web API Headers object.
 */
export function extractWebhookHeaders(
  rawHeaders: Record<string, string | string[] | undefined> | Headers | PayPalWebhookHeaders,
): PayPalWebhookHeaders {
  if (!rawHeaders || typeof rawHeaders !== "object") {
    throw new WebhookVerificationError(
      "Missing required PayPal webhook headers: headers argument must be an object",
    );
  }

  // If already normalized object
  if (
    "authAlgo" in rawHeaders &&
    "certUrl" in rawHeaders &&
    "transmissionId" in rawHeaders &&
    "transmissionSig" in rawHeaders &&
    "transmissionTime" in rawHeaders
  ) {
    const normalized = rawHeaders as PayPalWebhookHeaders;
    return PayPalWebhookHeadersSchema.parse({
      authAlgo:
        typeof normalized.authAlgo === "string" ? normalized.authAlgo.trim() : normalized.authAlgo,
      certUrl:
        typeof normalized.certUrl === "string" ? normalized.certUrl.trim() : normalized.certUrl,
      transmissionId:
        typeof normalized.transmissionId === "string"
          ? normalized.transmissionId.trim()
          : normalized.transmissionId,
      transmissionSig:
        typeof normalized.transmissionSig === "string"
          ? normalized.transmissionSig.trim()
          : normalized.transmissionSig,
      transmissionTime:
        typeof normalized.transmissionTime === "string"
          ? normalized.transmissionTime.trim()
          : normalized.transmissionTime,
    });
  }

  const lookup = (key: string): string | undefined => {
    let rawVal: string | undefined;
    if (typeof (rawHeaders as Headers).get === "function") {
      rawVal = (rawHeaders as Headers).get(key) ?? undefined;
    } else {
      const record = rawHeaders as Record<string, string | string[] | undefined>;
      const target = key.toLowerCase();
      for (const [k, v] of Object.entries(record)) {
        if (k.toLowerCase() === target) {
          if (Array.isArray(v)) {
            const firstNonEmpty = v.find((x) => typeof x === "string" && x.trim().length > 0);
            rawVal = firstNonEmpty;
          } else if (typeof v === "string") {
            rawVal = v;
          }
          break;
        }
      }
    }

    if (!rawVal) return undefined;
    const trimmed = rawVal.trim();
    if (!trimmed) return undefined;

    // Handle proxies that combine duplicated headers with commas (e.g. "sig1, sig2" or "url, url")
    if (trimmed.includes(",")) {
      const parts = trimmed
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      return parts[0] ?? undefined;
    }
    return trimmed;
  };

  const authAlgo = lookup("paypal-auth-algo");
  const certUrl = lookup("paypal-cert-url");
  const transmissionId = lookup("paypal-transmission-id");
  const transmissionSig = lookup("paypal-transmission-sig");
  const transmissionTime = lookup("paypal-transmission-time");

  const missing: string[] = [];
  if (!authAlgo) missing.push("PAYPAL-AUTH-ALGO");
  if (!certUrl) missing.push("PAYPAL-CERT-URL");
  if (!transmissionId) missing.push("PAYPAL-TRANSMISSION-ID");
  if (!transmissionSig) missing.push("PAYPAL-TRANSMISSION-SIG");
  if (!transmissionTime) missing.push("PAYPAL-TRANSMISSION-TIME");

  if (missing.length > 0) {
    throw new WebhookVerificationError(
      `Missing required PayPal webhook headers: ${missing.join(", ")}`,
      { missingHeaders: missing },
    );
  }

  return PayPalWebhookHeadersSchema.parse({
    authAlgo,
    certUrl,
    transmissionId,
    transmissionSig,
    transmissionTime,
  });
}
