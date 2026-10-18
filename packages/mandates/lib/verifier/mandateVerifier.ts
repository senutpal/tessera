import { parsePrivateKey, signPayloadEd25519, verifyPayloadEd25519 } from "../crypto/ed25519.js";
import {
  DuplicateMandateNonceError,
  ExpiredMandateError,
  InvalidMandateSignatureError,
  MandateBindingMismatchError,
  MandateSchemaValidationError,
} from "../errors.js";
import { type CheckoutMandate, CheckoutMandateSchema } from "../schemas/checkoutMandate.js";
import { type PaymentMandate, PaymentMandateSchema } from "../schemas/paymentMandate.js";
import type { NonceStore } from "../store/nonceStore.js";

const DEFAULT_CLOCK_SKEW_TOLERANCE_SECONDS = 60;
const DEFAULT_NONCE_TTL_SECONDS = 3600;

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
  // Validate private key exists and is valid
  parsePrivateKey(privateKey);
  const signature = signPayloadEd25519(mandate, privateKey);
  return {
    mandate,
    signature,
    ...(signerPublicKey !== undefined ? { signerPublicKey } : {}),
  };
}

/**
 * Internal helper to validate temporal validity (expiration and clock skew).
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

  // 2. Check premature issue time (beyond skew tolerance)
  if (iat !== undefined && iat > nowEpoch + toleranceSeconds) {
    throw new MandateSchemaValidationError(
      `Mandate iat ${iat} is in the future beyond skew tolerance (${nowEpoch} + ${toleranceSeconds}s)`,
      { iat, nowEpoch, toleranceSeconds },
    );
  }
}

/**
 * Internal helper to evaluate anti-replay nonce protection.
 */
async function consumeAntiReplayNonce(
  nonce: string | undefined,
  exp: number | undefined,
  nowEpoch: number,
  nonceStore?: NonceStore,
): Promise<void> {
  if (!nonceStore || !nonce) {
    return;
  }

  const ttl = exp !== undefined ? exp - nowEpoch : DEFAULT_NONCE_TTL_SECONDS;
  const ok = await nonceStore.consumeNonce(nonce, Math.max(1, ttl));

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

  // 1. Parse and validate schema
  const mandate = CheckoutMandateSchema.parse(signed.mandate);

  const nowEpoch = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.clockSkewToleranceSeconds ?? DEFAULT_CLOCK_SKEW_TOLERANCE_SECONDS;

  // 2. Validate timestamps
  validateTimestamps(mandate.iat, mandate.exp, nowEpoch, tolerance);

  // 3. Anti-replay verification
  await consumeAntiReplayNonce(mandate.nonce, mandate.exp, nowEpoch, options.nonceStore);

  // 4. Verify Ed25519 signature
  const isValid = verifyPayloadEd25519(mandate, signed.signature, options.publicKey);
  if (!isValid) {
    throw new InvalidMandateSignatureError(
      "Ed25519 signature verification failed for Checkout Mandate",
    );
  }

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

  // 1. Parse and validate schema
  const mandate = PaymentMandateSchema.parse(signed.mandate);

  const nowEpoch = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.clockSkewToleranceSeconds ?? DEFAULT_CLOCK_SKEW_TOLERANCE_SECONDS;

  // 2. Validate timestamps
  validateTimestamps(mandate.iat, mandate.exp, nowEpoch, tolerance);

  // 3. Anti-replay verification
  await consumeAntiReplayNonce(mandate.nonce, mandate.exp, nowEpoch, options.nonceStore);

  // 4. Verify Ed25519 signature
  const isValid = verifyPayloadEd25519(mandate, signed.signature, options.publicKey);
  if (!isValid) {
    throw new InvalidMandateSignatureError(
      "Ed25519 signature verification failed for Payment Mandate",
    );
  }

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
 * Asserts that paymentMandate.transaction_id matches checkoutMandate.checkout_hash.
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

  if (checkoutMandate.checkout_hash !== paymentMandate.transaction_id) {
    throw new MandateBindingMismatchError(
      `Mandate hash binding mismatch: payment mandate transaction_id "${paymentMandate.transaction_id}" does not match checkout_hash "${checkoutMandate.checkout_hash}"`,
      {
        checkoutHash: checkoutMandate.checkout_hash,
        paymentTransactionId: paymentMandate.transaction_id,
      },
    );
  }

  return true;
}
