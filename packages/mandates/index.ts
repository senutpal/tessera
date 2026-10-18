// Public entry point for @tessera/mandates
// Deep module exposing high-level cryptographic verification and AP2 schemas

// Cryptographic primitives
export {
  type Ed25519KeyPair,
  generateEd25519KeyPair,
  parsePrivateKey,
  parsePublicKey,
  signPayloadEd25519,
  verifyPayloadEd25519,
} from "./lib/crypto/ed25519.js";
// Mandate domain errors
export {
  DuplicateMandateNonceError,
  ExpiredMandateError,
  InvalidMandateSignatureError,
  MandateBindingMismatchError,
  MandateSchemaValidationError,
} from "./lib/errors.js";
// AP2 Checkout Mandate schemas and types
export {
  type CheckoutMandate,
  CheckoutMandateSchema,
  computeCheckoutHash,
} from "./lib/schemas/checkoutMandate.js";
// AP2 Payment Mandate schemas and types
export {
  type Amount,
  AmountSchema,
  type MerchantIdentifier,
  MerchantIdentifierSchema,
  type PaymentInstrument,
  PaymentInstrumentSchema,
  type PaymentMandate,
  PaymentMandateSchema,
  type PispIdentifier,
  PispIdentifierSchema,
} from "./lib/schemas/paymentMandate.js";
// Anti-replay Nonce Store
export {
  InMemoryNonceStore,
  type NonceStore,
} from "./lib/store/nonceStore.js";
// Verification pipeline
export {
  type MandateVerificationOptions,
  type SignedMandate,
  signMandate,
  verifyCheckoutMandate,
  verifyMandate,
  verifyMandateBinding,
  verifyPaymentMandate,
} from "./lib/verifier/mandateVerifier.js";
