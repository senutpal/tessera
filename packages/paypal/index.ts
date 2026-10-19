// Public entry point for @tessera/paypal
// Deep module exposing PayPal Orders v2 escrow authorization and void engine

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

/**
 * High-level helper to create an escrow order with `intent: "AUTHORIZE"`.
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
 */
export async function voidAuthorization(
  config: PayPalConfig,
  options: VoidAuthorizationOptions,
  clientOptions?: { eventSink?: EscrowEventSink | undefined },
): Promise<EscrowVoidResult> {
  const client = new PayPalClient(config, clientOptions);
  return client.voidAuthorization(options);
}
