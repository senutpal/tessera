// Public entry point for @tessera/core

// RFC 8785 Canonical JSON Serialization
export {
  canonicalize,
  canonicalizeToBuffer,
} from "./lib/crypto/canonicalJson.js";
// Domain error hierarchy
export {
  CanonicalJsonError,
  CarrierTrackingError,
  ConflictError,
  DisputeError,
  DomainError,
  type DomainErrorJson,
  EscrowAuthorizationError,
  EscrowCaptureError,
  EscrowVoidError,
  isDomainError,
  MandateExpiredError,
  MandateSignatureError,
  MandateValidationError,
  NonceReplayError,
  NotFoundError,
  PolicyViolationError,
  UnauthorizedError,
} from "./lib/errors/domainErrors.js";
// Clearinghouse domain models and states
export {
  type AuthorizationId,
  asAuthorizationId,
  asCaptureId,
  asCarrierTrackingId,
  asMandateId,
  asOrderId,
  asTransactionId,
  type Brand,
  type CaptureId,
  type CarrierTrackingId,
  ClearinghouseState,
  EscrowHoldStatus,
  HITLStatus,
  type MandateId,
  type MandateItem,
  type MandatePayee,
  MandateType,
  type OrderId,
  RiskTier,
  ShipmentMilestoneStatus,
  type TransactionId,
} from "./lib/types/clearinghouse.js";
// Money value object and currency interfaces
export {
  type AP2Amount,
  Money,
  type PayPalAmount,
} from "./lib/types/money.js";
