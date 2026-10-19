import { type AuthorizationId, DomainError, type Money, type OrderId } from "@tessera/core";
import { z } from "zod";

// ==========================================
// 1. PayPal REST Wire Schemas
// ==========================================

export const PayPalOAuthTokenSchema = z
  .object({
    scope: z.string().optional(),
    access_token: z.string(),
    token_type: z.string().default("Bearer"),
    app_id: z.string().optional(),
    expires_in: z.number(),
    nonce: z.string().optional(),
  })
  .passthrough();
export type PayPalOAuthToken = z.infer<typeof PayPalOAuthTokenSchema>;

export const PayPalAmountSchema = z
  .object({
    currency_code: z.string(),
    value: z.string(),
  })
  .passthrough();
export type PayPalAmountWire = z.infer<typeof PayPalAmountSchema>;

export const PayPalItemSchema = z
  .object({
    name: z.string(),
    quantity: z.string(),
    unit_amount: PayPalAmountSchema,
    description: z.string().optional(),
    sku: z.string().optional(),
    category: z.enum(["DIGITAL_GOODS", "PHYSICAL_GOODS", "DONATION"]).optional(),
  })
  .passthrough();
export type PayPalItemWire = z.infer<typeof PayPalItemSchema>;

export const PayPalAmountBreakdownSchema = z
  .object({
    item_total: PayPalAmountSchema.optional(),
    shipping: PayPalAmountSchema.optional(),
    handling: PayPalAmountSchema.optional(),
    tax_total: PayPalAmountSchema.optional(),
    insurance: PayPalAmountSchema.optional(),
    shipping_discount: PayPalAmountSchema.optional(),
    discount: PayPalAmountSchema.optional(),
  })
  .passthrough();
export type PayPalAmountBreakdownWire = z.infer<typeof PayPalAmountBreakdownSchema>;

export const PayPalPurchaseUnitSchema = z
  .object({
    reference_id: z.string().optional(),
    description: z.string().optional(),
    custom_id: z.string().optional(),
    invoice_id: z.string().optional(),
    soft_descriptor: z.string().optional(),
    amount: z
      .object({
        currency_code: z.string(),
        value: z.string(),
        breakdown: PayPalAmountBreakdownSchema.optional(),
      })
      .passthrough(),
    items: z.array(PayPalItemSchema).optional(),
    payee: z
      .object({
        email_address: z.string().optional(),
        merchant_id: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();
export type PayPalPurchaseUnitWire = z.infer<typeof PayPalPurchaseUnitSchema>;

export const PayPalLinkSchema = z
  .object({
    href: z.string(),
    rel: z.string(),
    method: z.string().optional(),
  })
  .passthrough();
export type PayPalLinkWire = z.infer<typeof PayPalLinkSchema>;

export const PayPalAuthorizationRecordSchema = z
  .object({
    id: z.string(),
    status: z.enum([
      "CREATED",
      "CAPTURED",
      "DENIED",
      "PARTIALLY_CAPTURED",
      "VOIDED",
      "PENDING",
      "EXPIRED",
    ]),
    amount: PayPalAmountSchema,
    seller_protection: z
      .object({
        status: z.string().optional(),
        dispute_categories: z.array(z.string()).optional(),
      })
      .optional(),
    expiration_time: z.string().optional(),
    create_time: z.string().optional(),
    update_time: z.string().optional(),
    links: z.array(PayPalLinkSchema).optional(),
  })
  .passthrough();
export type PayPalAuthorizationRecord = z.infer<typeof PayPalAuthorizationRecordSchema>;

export const PayPalOrderResponseSchema = z
  .object({
    id: z.string(),
    status: z.enum([
      "CREATED",
      "SAVED",
      "APPROVED",
      "VOIDED",
      "COMPLETED",
      "PAYER_ACTION_REQUIRED",
    ]),
    intent: z.string().optional(),
    purchase_units: z
      .array(
        z
          .object({
            reference_id: z.string().optional(),
            amount: PayPalAmountSchema.optional(),
            payments: z
              .object({
                authorizations: z.array(PayPalAuthorizationRecordSchema).optional(),
              })
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    links: z.array(PayPalLinkSchema).optional(),
    create_time: z.string().optional(),
    update_time: z.string().optional(),
  })
  .passthrough();
export type PayPalOrderResponse = z.infer<typeof PayPalOrderResponseSchema>;

export const PayPalErrorIssueSchema = z
  .object({
    field: z.string().optional(),
    value: z.unknown().optional(),
    issue: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

export const PayPalErrorResponseSchema = z
  .object({
    name: z.string().optional(),
    message: z.string().optional(),
    debug_id: z.string().optional(),
    details: z.array(PayPalErrorIssueSchema).optional(),
    links: z.array(PayPalLinkSchema).optional(),
  })
  .passthrough();
export type PayPalErrorResponse = z.infer<typeof PayPalErrorResponseSchema>;

// ==========================================
// 2. Configuration & Options
// ==========================================

export type PayPalEnvironment = "sandbox" | "production" | "mock";

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  environment?: PayPalEnvironment | undefined;
  baseUrl?: string | undefined;
  customFetch?: typeof fetch | undefined;
  tokenRenewalMarginMs?: number | undefined;
  timeoutMs?: number | undefined;
}

export interface EscrowItemInput {
  name: string;
  quantity: number | string;
  unitAmount: Money | { currency_code: string; value: string };
  description?: string | undefined;
  sku?: string | undefined;
  category?: "DIGITAL_GOODS" | "PHYSICAL_GOODS" | "DONATION" | undefined;
}

export interface CreateEscrowOrderOptions {
  amount: Money | { currency_code: string; value: string };
  referenceId?: string | undefined;
  description?: string | undefined;
  customId?: string | undefined;
  invoiceId?: string | undefined;
  items?: EscrowItemInput[] | undefined;
  payee?:
    | {
        email?: string | undefined;
        merchantId?: string | undefined;
      }
    | undefined;
  requestId?: string | undefined;
  returnUrl?: string | undefined;
  cancelUrl?: string | undefined;
}

export interface AuthorizeOrderOptions {
  orderId: string | OrderId;
  requestId?: string | undefined;
  paymentSource?: Record<string, unknown> | undefined;
}

export interface VoidAuthorizationOptions {
  authorizationId: string | AuthorizationId;
  requestId?: string | undefined;
  reason?: string | undefined;
  orderId?: string | OrderId | undefined;
  amount?: Money | undefined;
}

// ==========================================
// 3. Domain Model Outputs & Events
// ==========================================

export type PayPalOrderStatus =
  | "CREATED"
  | "SAVED"
  | "APPROVED"
  | "VOIDED"
  | "COMPLETED"
  | "PAYER_ACTION_REQUIRED";

export type PayPalAuthorizationStatus =
  | "CREATED"
  | "CAPTURED"
  | "DENIED"
  | "PARTIALLY_CAPTURED"
  | "VOIDED"
  | "PENDING"
  | "EXPIRED";

export interface EscrowOrder {
  orderId: OrderId;
  status: PayPalOrderStatus;
  amount: Money;
  referenceId?: string | undefined;
  customId?: string | undefined;
  links: PayPalLinkWire[];
  rawResponse: PayPalOrderResponse;
}

export interface EscrowAuthorization {
  authorizationId: AuthorizationId;
  orderId: OrderId;
  status: PayPalAuthorizationStatus;
  amount: Money;
  expirationTime?: string | undefined;
  createTime?: string | undefined;
  rawResponse: PayPalOrderResponse;
}

export interface EscrowVoidResult {
  authorizationId: AuthorizationId;
  status: "VOIDED";
  voidedAt: string;
  reason?: string | undefined;
  rawResponse?: Record<string, unknown> | undefined;
}

export interface EscrowHoldVoidedEvent {
  type: "ESCROW_HOLD_VOIDED";
  authorizationId: AuthorizationId;
  orderId?: OrderId | undefined;
  amount?: Money | undefined;
  reason?: string | undefined;
  timestamp: string;
}

export interface EscrowEventSink {
  emit: (event: EscrowHoldVoidedEvent) => Promise<void> | void;
}

// ==========================================
// 4. Domain Errors
// ==========================================

export class PayPalApiError extends DomainError {
  public readonly debugId?: string | undefined;
  public readonly paypalErrorName?: string | undefined;

  constructor(
    message: string,
    options: {
      httpStatus?: number | undefined;
      debugId?: string | undefined;
      paypalErrorName?: string | undefined;
      details?: Record<string, unknown> | undefined;
    } = {},
  ) {
    super(message, "PAYPAL_API_ERROR", options.httpStatus ?? 400, options.details ?? {});
    this.debugId = options.debugId;
    this.paypalErrorName = options.paypalErrorName;
  }
}

export class PayPalAuthError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "PAYPAL_AUTH_ERROR", 401, details);
  }
}

export class PayPalTimeoutError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "PAYPAL_TIMEOUT", 504, details);
  }
}
