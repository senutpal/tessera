// Public entry point for @tessera/paypal
// Deep module exposing PayPal Orders v2 escrow authorization, void engine,
// and Webhooks cryptographic verification & domain event routing.

// Core Client & Auth Engine
export { PayPalAuthClient } from "./lib/client/paypalAuthClient.js";
export { PayPalClient } from "./lib/client/paypalClient.js";
export { DisputeResolutionHandler } from "./lib/disputes/disputeResolutionHandler.js";
// Customer Disputes & Autonomous Resolution Engine
export {
  DisputesService,
  normalizePayPalDispute,
} from "./lib/disputes/disputesService.js";
export {
  buildDisputeEvidenceAuditNote,
  computeEvidenceHash,
  EvidencePackager,
} from "./lib/disputes/evidencePackager.js";
// Escrow Services
export { AuthorizationVoidService } from "./lib/orders/authorizationVoidService.js";
export { EscrowCaptureService } from "./lib/orders/escrowCaptureService.js";
export { OrdersEscrowService } from "./lib/orders/ordersEscrowService.js";
export { ShipmentTrackingService } from "./lib/tracking/shipmentTrackingService.js";
export {
  DEFAULT_TRACKING_SLA_WINDOW_MS,
  TrackingStateMachine,
  type TrackingStateMachineOptions,
} from "./lib/tracking/trackingStateMachine.js";
export {
  type AcceptClaimOptions,
  type CarrierTrackingEvidence,
  type Channel3QuoteEvidence,
  type ClearinghouseDispute,
  type ClearinghouseDisputeOutcome,
  ClearinghouseDisputeStatus,
  DisputeAction,
  type DisputeEscalatedEvent,
  type DisputeEscalationResult,
  type DisputeEvaluationContext,
  type DisputeEventSink,
  type DisputeEvidenceSubmittedEvent,
  type DisputePolicyDecision,
  type DisputeResolutionPolicy,
  type DisputeResolutionResult,
  type DisputeResolvedEvent,
  type DisputeSearchResult,
  type EscalateDisputeOptions,
  type EvidenceBundleInput,
  type EvidenceDocument,
  type EvidenceSubmissionResult,
  type ListDisputesOptions,
  type PayPalAcceptClaimType,
  PayPalAcceptClaimTypeSchema,
  type PayPalAcceptClaimWire,
  PayPalAcceptClaimWireSchema,
  type PayPalDisputeChannel,
  PayPalDisputeChannelSchema,
  type PayPalDisputedTransactionWire,
  PayPalDisputedTransactionWireSchema,
  type PayPalDisputeInfoWire,
  PayPalDisputeInfoWireSchema,
  type PayPalDisputeLifecycleStage,
  PayPalDisputeLifecycleStageSchema,
  type PayPalDisputeOutcomeCode,
  PayPalDisputeOutcomeCodeSchema,
  type PayPalDisputeOutcomeWire,
  PayPalDisputeOutcomeWireSchema,
  type PayPalDisputeReason,
  PayPalDisputeReasonSchema,
  PayPalDisputeSearchResponseSchema,
  type PayPalDisputeSearchResponseWire,
  type PayPalDisputeState,
  PayPalDisputeStateSchema,
  type PayPalDisputeStatus,
  PayPalDisputeStatusSchema,
  type PayPalDisputeWire,
  PayPalDisputeWireSchema,
  type PayPalEscalateWire,
  PayPalEscalateWireSchema,
  type PayPalEvidenceType,
  PayPalEvidenceTypeSchema,
  type PayPalProvideEvidenceWire,
  PayPalProvideEvidenceWireSchema,
  PayPalSubsequentActionResponseSchema,
  type PayPalSubsequentActionResponseWire,
  type PayPalTrackingInfoWire,
  PayPalTrackingInfoWireSchema,
  type SignedMandateEvidence,
} from "./lib/types/disputes.js";
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
// Tracking & Capture Types, Schemas & Domain Events
export {
  type BatchTrackersInput,
  type BatchTrackersResult,
  type CaptureEventSink,
  type CreateTrackerInput,
  type EscrowCaptureOptions,
  type EscrowCaptureResult,
  type EscrowReleasedEvent,
  type PayPalBatchTrackerCollection,
  PayPalBatchTrackerCollectionSchema,
  type PayPalCaptureResponse,
  PayPalCaptureResponseSchema,
  type PayPalCaptureStatus,
  PayPalCaptureStatusSchema,
  type PayPalShipmentDirection,
  PayPalShipmentDirectionSchema,
  type PayPalShipmentUploader,
  PayPalShipmentUploaderSchema,
  type PayPalTrackerIdentifier,
  PayPalTrackerIdentifierSchema,
  type PayPalTrackerItem,
  PayPalTrackerItemSchema,
  type PayPalTrackingNumberType,
  PayPalTrackingNumberTypeSchema,
  type PayPalTrackingStatus,
  PayPalTrackingStatusSchema,
  type ShipmentDeliveredEvent,
  type ShipmentMilestone,
  type SlaStatusResult,
  type SupervisorOverride,
  type TrackingEventSink,
} from "./lib/types/tracking.js";
// Webhook Types, Schemas & Domain Errors
export {
  type ClearinghouseAuthorizationCreatedEvent,
  type ClearinghouseAuthorizationVoidedEvent,
  type ClearinghouseWebhookEvent,
  extractWebhookHeaders,
  PAYPAL_CERT_URL_REGEX,
  type PayPalAuthorizationCreatedResource,
  PayPalAuthorizationCreatedResourceSchema,
  type PayPalAuthorizationVoidedResource,
  PayPalAuthorizationVoidedResourceSchema,
  type PayPalVerifyWebhookSignatureRequest,
  PayPalVerifyWebhookSignatureRequestSchema,
  type PayPalVerifyWebhookSignatureResponse,
  PayPalVerifyWebhookSignatureResponseSchema,
  type PayPalWebhookAmount,
  PayPalWebhookAmountSchema,
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
  DEFAULT_MAX_CLOCK_SKEW_MS,
  type VerifyWebhookParams,
  WebhookSignatureVerifier,
  type WebhookSignatureVerifierConfig,
} from "./lib/webhooks/webhookSignatureVerifier.js";

import { PayPalClient } from "./lib/client/paypalClient.js";
import type {
  AcceptClaimOptions,
  ClearinghouseDispute,
  DisputeEscalationResult,
  DisputeEvaluationContext,
  DisputeEventSink,
  DisputePolicyDecision,
  DisputeResolutionPolicy,
  DisputeResolutionResult,
  DisputeSearchResult,
  EscalateDisputeOptions,
  EvidenceBundleInput,
  EvidenceSubmissionResult,
  ListDisputesOptions,
} from "./lib/types/disputes.js";
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
  BatchTrackersInput,
  BatchTrackersResult,
  CaptureEventSink,
  EscrowCaptureOptions,
  EscrowCaptureResult,
  ShipmentMilestone,
  TrackingEventSink,
} from "./lib/types/tracking.js";
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
 * High-level helper to register batch shipment tracking info with PayPal Tracking v1.
 */
export async function registerShipmentTracking(
  config: PayPalConfig,
  input: BatchTrackersInput,
  clientOptions?: { trackingEventSink?: TrackingEventSink | undefined },
): Promise<BatchTrackersResult> {
  const client = new PayPalClient(config, clientOptions);
  return client.registerShipmentTracking(input);
}

/**
 * High-level helper to query shipment tracking milestone info from PayPal Tracking v1.
 */
export async function getShipmentTracking(
  config: PayPalConfig,
  transactionIdOrTrackerId: string,
  trackingNumber?: string,
  clientOptions?: { trackingEventSink?: TrackingEventSink | undefined },
): Promise<ShipmentMilestone> {
  const client = new PayPalClient(config, clientOptions);
  return client.getShipmentTracking(transactionIdOrTrackerId, trackingNumber);
}

/**
 * High-level helper to capture an authorized payment hold from escrow, strictly gated on delivery.
 */
export async function captureEscrow(
  config: PayPalConfig,
  options: EscrowCaptureOptions,
  clientOptions?: { captureEventSink?: CaptureEventSink | undefined },
): Promise<EscrowCaptureResult> {
  const client = new PayPalClient(config, clientOptions);
  return client.captureEscrow(options);
}

let defaultVerifier: WebhookSignatureVerifier | undefined;

/**
 * Returns the module-level shared WebhookSignatureVerifier instance.
 * Reuses the certificate cache and replay protection idempotency store across invocations.
 */
export function getDefaultWebhookVerifier(): WebhookSignatureVerifier {
  if (!defaultVerifier) {
    defaultVerifier = new WebhookSignatureVerifier();
  }
  return defaultVerifier;
}

/**
 * Resets the shared WebhookSignatureVerifier instance (useful for test isolation).
 */
export function resetDefaultWebhookVerifier(): void {
  defaultVerifier = undefined;
  WebhookRouter.clearInFlightDispatches();
}

/**
 * Verifies a PayPal webhook notification signature cryptographically.
 *
 * Reuses a long-lived module-level verifier with certificate caching and
 * replay protection store by default. When custom configuration is passed,
 * any unspecified stores (idempotencyStore, certificateManager) default
 * to the shared instance to maintain replay protection and certificate caching.
 */
export async function verifyWebhookSignature(
  params: VerifyWebhookParams,
  config?: WebhookSignatureVerifierConfig,
): Promise<WebhookVerificationResult> {
  const verifier = config
    ? new WebhookSignatureVerifier({
        ...config,
        idempotencyStore: config.idempotencyStore ?? getDefaultWebhookVerifier().idempotencyStore,
        certificateManager:
          config.certificateManager ?? getDefaultWebhookVerifier().certificateManager,
      })
    : getDefaultWebhookVerifier();
  return verifier.verify(params);
}

/**
 * Verifies and routes a PayPal webhook request to clearinghouse domain event sinks and listeners.
 *
 * Reuses a long-lived default verifier when none is explicitly provided, ensuring
 * certificate caching and replay deduplication are preserved across invocations.
 */
export async function routeWebhook(
  request: WebhookRequest,
  config: WebhookRouterConfig,
): Promise<WebhookProcessingResult> {
  const verifier = config.verifier ?? getDefaultWebhookVerifier();
  const router = new WebhookRouter({ ...config, verifier });
  return router.handleWebhook(request);
}

/**
 * High-level helper to query customer disputes from PayPal Customer Disputes API v1.
 */
export async function listDisputes(
  config: PayPalConfig,
  options?: ListDisputesOptions,
): Promise<DisputeSearchResult> {
  const client = new PayPalClient(config);
  return client.listDisputes(options);
}

/**
 * High-level helper to query details for a specific customer dispute.
 */
export async function getDispute(
  config: PayPalConfig,
  disputeId: string,
): Promise<ClearinghouseDispute> {
  const client = new PayPalClient(config);
  return client.getDispute(disputeId);
}

/**
 * High-level helper to assemble cryptographic evidence bundle and submit to PayPal.
 */
export async function provideDisputeEvidence(
  config: PayPalConfig,
  input: EvidenceBundleInput,
  clientOptions?: { disputeEventSink?: DisputeEventSink | undefined },
): Promise<EvidenceSubmissionResult> {
  const client = new PayPalClient(config, clientOptions);
  return client.provideDisputeEvidence(input);
}

/**
 * High-level helper to accept liability for a customer dispute and issue a buyer refund.
 */
export async function acceptDisputeClaim(
  config: PayPalConfig,
  options: AcceptClaimOptions,
  clientOptions?: { disputeEventSink?: DisputeEventSink | undefined },
): Promise<DisputeResolutionResult> {
  const client = new PayPalClient(config, clientOptions);
  return client.acceptDisputeClaim(options);
}

/**
 * High-level helper to escalate a dispute to a PayPal claim.
 */
export async function escalateDispute(
  config: PayPalConfig,
  options: EscalateDisputeOptions,
  clientOptions?: { disputeEventSink?: DisputeEventSink | undefined },
): Promise<DisputeEscalationResult> {
  const client = new PayPalClient(config, clientOptions);
  return client.escalateDispute(options);
}

/**
 * High-level helper to evaluate clearinghouse dispute policy and execute automated actions.
 */
export async function evaluateDisputePolicy(
  config: PayPalConfig,
  dispute: ClearinghouseDispute,
  context?: DisputeEvaluationContext,
  clientOptions?: {
    disputeEventSink?: DisputeEventSink | undefined;
    disputePolicy?: DisputeResolutionPolicy | undefined;
  },
): Promise<DisputePolicyDecision> {
  const client = new PayPalClient(config, clientOptions);
  return client.evaluateDisputePolicy(dispute, context);
}
