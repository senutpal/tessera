import { signPayloadEd25519, verifyPayloadEd25519 } from "../crypto/ed25519.js";
import {
  DuplicateMandateNonceError,
  ExpiredMandateError,
  InvalidMandateSignatureError,
  MandateBindingMismatchError,
  MandateSchemaValidationError,
} from "../errors.js";
import {
  type CheckoutMandate,
  CheckoutMandateSchema,
  computeCheckoutHash,
} from "../schemas/checkoutMandate.js";
import { type PaymentMandate, PaymentMandateSchema } from "../schemas/paymentMandate.js";
import type { NonceStore } from "../store/nonceStore.js";

const DEFAULT_CLOCK_SKEW_TOLERANCE_SECONDS = 60;

export interface SignedMandate<T = unknown> {
  mandate: T;
  signature: string;
  signerPublicKey?: string | undefined;
}

export interface MandateVerificationOptions {
  publicKey: string | Buffer;
  nonceStore?: NonceStore;
  clockSkewToleranceSeconds?: number;
  nowEpochSeconds?: number;
}

/**
 * Signs an AP2 mandate object and returns a SignedMandate container.
 */
export function signMandate<T extends object>(
  mandate: T,
  privateKey: string | Buffer,
  signerPublicKey?: string,
): SignedMandate<T> {
  if (!mandate || typeof mandate !== "object") {
    throw new MandateSchemaValidationError("Mandate must be a non-null object");
  }
  const signature = signPayloadEd25519(mandate, privateKey);
  return {
    mandate,
    signature,
    ...(signerPublicKey !== undefined ? { signerPublicKey } : {}),
  };
}

/**
 * Internal helper to validate temporal validity (expiration, sequence, and clock skew).
 */
function validateTimestamps(
  iat: number | undefined,
  exp: number | undefined,
  nowEpoch: number,
  toleranceSeconds: number,
): void {
  // 1. Check expiration strictly first
  if (exp !== undefined && nowEpoch > exp) {
    throw new ExpiredMandateError(`Mandate expired at epoch ${exp}, current epoch is ${nowEpoch}`, {
      exp,
      nowEpoch,
    });
  }

  // 2. Reject inverted timestamps where exp <= iat
  if (exp !== undefined && iat !== undefined && exp <= iat) {
    throw new MandateSchemaValidationError(
      `Mandate exp (${exp}) must be strictly greater than iat (${iat})`,
      { exp, iat },
    );
  }

  // 3. Check premature issue time (beyond skew tolerance)
  if (iat !== undefined && iat > nowEpoch + toleranceSeconds) {
    throw new MandateSchemaValidationError(
      `Mandate iat ${iat} is in the future beyond skew tolerance (${nowEpoch} + ${toleranceSeconds}s)`,
      { iat, nowEpoch, toleranceSeconds },
    );
  }
}

/**
 * Internal helper to evaluate anti-replay nonce protection.
 * Requires both nonce and exp when a nonceStore is provided, ensuring nonce retention
 * lasts through the entire mandate validity window (exp - nowEpoch).
 */
async function consumeAntiReplayNonce(
  nonce: string | undefined,
  exp: number | undefined,
  nowEpoch: number,
  nonceStore?: NonceStore,
): Promise<void> {
  if (!nonceStore) {
    return;
  }

  if (!nonce || typeof nonce !== "string" || nonce.trim().length === 0) {
    throw new MandateSchemaValidationError(
      "Mandate nonce is required when replay protection is enabled",
    );
  }

  if (exp === undefined) {
    throw new MandateSchemaValidationError(
      "Mandate exp is required when replay protection is enabled",
    );
  }

  const ttl = exp - nowEpoch;
  if (ttl <= 0) {
    throw new ExpiredMandateError(`Mandate expired at epoch ${exp}, current epoch is ${nowEpoch}`, {
      exp,
      nowEpoch,
    });
  }

  const ok = await nonceStore.consumeNonce(nonce, ttl);
  if (!ok) {
    throw new DuplicateMandateNonceError(
      `Mandate nonce "${nonce}" has already been consumed (replay attempt detected)`,
      { nonce },
    );
  }
}

/**
 * Validates and cryptographically verifies an AP2 Checkout Mandate.
 */
export async function verifyCheckoutMandate(
  signed: SignedMandate<unknown>,
  options: MandateVerificationOptions,
): Promise<CheckoutMandate> {
  if (!signed || typeof signed !== "object") {
    throw new MandateSchemaValidationError("Signed mandate container must be an object");
  }
  if (!options || typeof options !== "object" || !options.publicKey) {
    throw new InvalidMandateSignatureError("Public key is required for mandate verification");
  }

  // 1. Parse and validate schema
  const mandate = CheckoutMandateSchema.parse(signed.mandate);

  // 2. Verify hash binding between checkout_jwt and checkout_hash
  const computedHash = computeCheckoutHash(mandate.checkout_jwt);
  if (mandate.checkout_hash !== computedHash) {
    throw new MandateBindingMismatchError(
      `Checkout Mandate checkout_hash mismatch: expected "${computedHash}", received "${mandate.checkout_hash}"`,
      {
        expectedHash: computedHash,
        receivedHash: mandate.checkout_hash,
      },
    );
  }

  const nowEpoch = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.clockSkewToleranceSeconds ?? DEFAULT_CLOCK_SKEW_TOLERANCE_SECONDS;

  // 3. Validate timestamps
  validateTimestamps(mandate.iat, mandate.exp, nowEpoch, tolerance);

  // 4. Verify Ed25519 signature over original signed.mandate before consuming nonce
  const isValid = verifyPayloadEd25519(signed.mandate, signed.signature, options.publicKey);
  if (!isValid) {
    throw new InvalidMandateSignatureError(
      "Ed25519 signature verification failed for Checkout Mandate",
    );
  }

  // 5. Anti-replay verification only after signature is authenticated
  await consumeAntiReplayNonce(mandate.nonce, mandate.exp, nowEpoch, options.nonceStore);

  return mandate;
}

/**
 * Validates and cryptographically verifies an AP2 Payment Mandate.
 */
export async function verifyPaymentMandate(
  signed: SignedMandate<unknown>,
  options: MandateVerificationOptions,
): Promise<PaymentMandate> {
  if (!signed || typeof signed !== "object") {
    throw new MandateSchemaValidationError("Signed mandate container must be an object");
  }
  if (!options || typeof options !== "object" || !options.publicKey) {
    throw new InvalidMandateSignatureError("Public key is required for mandate verification");
  }

  // 1. Parse and validate schema
  const mandate = PaymentMandateSchema.parse(signed.mandate);

  const nowEpoch = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.clockSkewToleranceSeconds ?? DEFAULT_CLOCK_SKEW_TOLERANCE_SECONDS;

  // 2. Validate timestamps
  validateTimestamps(mandate.iat, mandate.exp, nowEpoch, tolerance);

  // 3. Verify Ed25519 signature over original signed.mandate before consuming nonce
  const isValid = verifyPayloadEd25519(signed.mandate, signed.signature, options.publicKey);
  if (!isValid) {
    throw new InvalidMandateSignatureError(
      "Ed25519 signature verification failed for Payment Mandate",
    );
  }

  // 4. Anti-replay verification only after signature is authenticated
  await consumeAntiReplayNonce(mandate.nonce, mandate.exp, nowEpoch, options.nonceStore);

  return mandate;
}

/**
 * Generic entry point verifying either Checkout or Payment Mandate based on its VCT claim.
 */
export async function verifyMandate(
  signed: SignedMandate<unknown>,
  options: MandateVerificationOptions,
): Promise<CheckoutMandate | PaymentMandate> {
  if (!signed?.mandate || typeof signed.mandate !== "object") {
    throw new MandateSchemaValidationError("Signed mandate missing mandate object");
  }

  const vct = (signed.mandate as { vct?: unknown }).vct;
  if (vct === "mandate.checkout.1") {
    return verifyCheckoutMandate(signed, options);
  }
  if (vct === "mandate.payment.1") {
    return verifyPaymentMandate(signed, options);
  }

  throw new MandateSchemaValidationError(
    `Unsupported or unrecognized mandate VCT claim: "${String(vct)}"`,
  );
}

/**
 * Cryptographically verifies SD-JWT hash binding between a Checkout Mandate and a Payment Mandate.
 * Asserts that checkout_hash matches computed hash of checkout_jwt, and that paymentMandate.transaction_id
 * matches checkoutMandate.checkout_hash.
 */
export function verifyMandateBinding(
  checkoutMandate: CheckoutMandate,
  paymentMandate: PaymentMandate,
): boolean {
  if (!checkoutMandate || !paymentMandate) {
    throw new MandateBindingMismatchError(
      "Both checkout and payment mandates are required for binding check",
    );
  }

  const checkout = CheckoutMandateSchema.parse(checkoutMandate);
  const payment = PaymentMandateSchema.parse(paymentMandate);

  // 1. Recompute and verify checkout_hash from checkout_jwt
  const computedCheckoutHash = computeCheckoutHash(checkout.checkout_jwt);
  if (checkout.checkout_hash !== computedCheckoutHash) {
    throw new MandateBindingMismatchError(
      `Checkout Mandate checkout_hash mismatch: expected "${computedCheckoutHash}", received "${checkout.checkout_hash}"`,
      {
        expectedHash: computedCheckoutHash,
        receivedHash: checkout.checkout_hash,
      },
    );
  }

  // 2. Verify binding between checkout_hash and payment transaction_id
  if (checkout.checkout_hash !== payment.transaction_id) {
    throw new MandateBindingMismatchError(
      `Mandate hash binding mismatch: payment mandate transaction_id "${payment.transaction_id}" does not match checkout_hash "${checkout.checkout_hash}"`,
      {
        checkoutHash: checkout.checkout_hash,
        paymentTransactionId: payment.transaction_id,
      },
    );
  }

  return true;
}
