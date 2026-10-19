// Public entry point for @tessera/paypal
// Deep module exposing PayPal Orders v2 escrow authorization, void engine,
// and Webhooks cryptographic verification & domain event routing.

// Core Client & Auth Engine
export { PayPalAuthClient } from "./lib/client/paypalAuthClient.js";
export { PayPalClient } from "./lib/client/paypalClient.js";

// Escrow Services
export { AuthorizationVoidService } from "./lib/orders/authorizationVoidService.js";
export { OrdersEscrowService } from "./lib/orders/ordersEscrowService.js";
// Schemas & Types
export {
  type AuthorizeOrderOptions,
  type CreateEscrowOrderOptions,
  type EscrowAuthorization,
  type EscrowEventSink,
  type EscrowHoldVoidedEvent,
  type EscrowItemInput,
  type EscrowOrder,
  type EscrowVoidResult,
  PayPalAmountBreakdownSchema,
  type PayPalAmountBreakdownWire,
  PayPalAmountSchema,
  type PayPalAmountWire,
  PayPalApiError,
  PayPalAuthError,
  type PayPalAuthorizationRecord,
  PayPalAuthorizationRecordSchema,
  type PayPalAuthorizationStatus,
  type PayPalConfig,
  type PayPalEnvironment,
  type PayPalErrorResponse,
  PayPalErrorResponseSchema,
  PayPalItemSchema,
  type PayPalItemWire,
  PayPalLinkSchema,
  type PayPalLinkWire,
  type PayPalOAuthToken,
  PayPalOAuthTokenSchema,
  type PayPalOrderResponse,
  PayPalOrderResponseSchema,
  type PayPalOrderStatus,
  PayPalPurchaseUnitSchema,
  type PayPalPurchaseUnitWire,
  PayPalTimeoutError,
  type VoidAuthorizationOptions,
} from "./lib/types/orders.js";
// Webhook Types, Schemas & Domain Errors
export {
  type ClearinghouseAuthorizationCreatedEvent,
  type ClearinghouseAuthorizationVoidedEvent,
  type ClearinghouseWebhookEvent,
  extractWebhookHeaders,
  PAYPAL_CERT_URL_REGEX,
  type PayPalVerifyWebhookSignatureRequest,
  PayPalVerifyWebhookSignatureRequestSchema,
  type PayPalVerifyWebhookSignatureResponse,
  PayPalVerifyWebhookSignatureResponseSchema,
  type PayPalWebhookEvent,
  PayPalWebhookEventSchema,
  type PayPalWebhookHeaders,
  PayPalWebhookHeadersSchema,
  UntrustedCertificateUrlError,
  type WebhookEventSink,
  type WebhookProcessingResult,
  type WebhookProcessingStatus,
  WebhookReplayError,
  type WebhookRequest,
  WebhookRoutingError,
  WebhookVerificationError,
  type WebhookVerificationOptions,
  type WebhookVerificationResult,
} from "./lib/types/webhooks.js";
// Webhook Cryptographic Verification & Ingestion Engine
export {
  CertificateManager,
  type CertificateManagerConfig,
} from "./lib/webhooks/certificateManager.js";
export {
  InMemoryWebhookIdempotencyStore,
  type InMemoryWebhookIdempotencyStoreConfig,
  type IWebhookIdempotencyStore,
} from "./lib/webhooks/idempotencyStore.js";
export {
  type WebhookEventHandler,
  WebhookRouter,
  type WebhookRouterConfig,
} from "./lib/webhooks/webhookRouter.js";
export {
  buildVerificationMessage,
  computeCrc32,
  computeCrc32Hex,
  type VerifyWebhookParams,
  WebhookSignatureVerifier,
  type WebhookSignatureVerifierConfig,
} from "./lib/webhooks/webhookSignatureVerifier.js";

import { PayPalClient } from "./lib/client/paypalClient.js";
import type {
  AuthorizeOrderOptions,
  CreateEscrowOrderOptions,
  EscrowAuthorization,
  EscrowEventSink,
  EscrowOrder,
  EscrowVoidResult,
  PayPalConfig,
  VoidAuthorizationOptions,
} from "./lib/types/orders.js";
import type {
  WebhookProcessingResult,
  WebhookRequest,
  WebhookVerificationResult,
} from "./lib/types/webhooks.js";
import { WebhookRouter, type WebhookRouterConfig } from "./lib/webhooks/webhookRouter.js";
import {
  type VerifyWebhookParams,
  WebhookSignatureVerifier,
  type WebhookSignatureVerifierConfig,
} from "./lib/webhooks/webhookSignatureVerifier.js";

/**
 * High-level helper to create an escrow order with `intent: "AUTHORIZE"`.
 *
 * NOTE: Each call creates a new `PayPalClient` instance without a shared token cache.
 * In production or high-throughput workflows, create and reuse a single long-lived `PayPalClient`
 * to avoid requesting a new OAuth token on every call.
 */
export async function createEscrowOrder(
  config: PayPalConfig,
  options: CreateEscrowOrderOptions,
): Promise<EscrowOrder> {
  const client = new PayPalClient(config);
  return client.createEscrowOrder(options);
}

/**
 * High-level helper to execute an authorization hold on an approved order.
 *
 * NOTE: Each call creates a new `PayPalClient` instance without a shared token cache.
 * In production or high-throughput workflows, create and reuse a single long-lived `PayPalClient`
 * to avoid requesting a new OAuth token on every call.
 */
export async function authorizeOrder(
  config: PayPalConfig,
  options: AuthorizeOrderOptions,
): Promise<EscrowAuthorization> {
  const client = new PayPalClient(config);
  return client.authorizeOrder(options);
}

/**
 * High-level helper to void an authorization hold and unlock buyer funds.
 *
 * NOTE: Each call creates a new `PayPalClient` instance without a shared token cache.
 * In production or high-throughput workflows, create and reuse a single long-lived `PayPalClient`
 * to avoid requesting a new OAuth token on every call.
 */
export async function voidAuthorization(
  config: PayPalConfig,
  options: VoidAuthorizationOptions,
  clientOptions?: { eventSink?: EscrowEventSink | undefined },
): Promise<EscrowVoidResult> {
  const client = new PayPalClient(config, clientOptions);
  return client.voidAuthorization(options);
}

/**
 * Verifies a PayPal webhook notification signature cryptographically.
 */
export async function verifyWebhookSignature(
  params: VerifyWebhookParams,
  config?: WebhookSignatureVerifierConfig,
): Promise<WebhookVerificationResult> {
  const verifier = new WebhookSignatureVerifier(config);
  return verifier.verify(params);
}

/**
 * Verifies and routes a PayPal webhook request to clearinghouse domain event sinks and listeners.
 */
export async function routeWebhook(
  request: WebhookRequest,
  config: WebhookRouterConfig,
): Promise<WebhookProcessingResult> {
  const router = new WebhookRouter(config);
  return router.handleWebhook(request);
}
