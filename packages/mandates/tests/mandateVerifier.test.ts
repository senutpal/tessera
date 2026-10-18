import { describe, expect, it } from "vitest";
import {
  CheckoutMandateSchema,
  computeCheckoutHash,
  DuplicateMandateNonceError,
  ExpiredMandateError,
  generateEd25519KeyPair,
  InMemoryNonceStore,
  InvalidMandateSignatureError,
  MandateBindingMismatchError,
  MandateSchemaValidationError,
  PaymentMandateSchema,
  type SignedMandate,
  signMandate,
  verifyCheckoutMandate,
  verifyMandate,
  verifyMandateBinding,
  verifyPaymentMandate,
} from "../index.js";

describe("AP2 Mandate Verifier Engine", () => {
  const agentKeys = generateEd25519KeyPair();
  const now = Math.floor(Date.now() / 1000);

  const sampleCheckoutJwt =
    "eyJhbGciOiJFUzI1NiJ9.eyJtZXJjaGFudF9pZCI6Im1lcmNoLTEiLCJsaW5lX2l0ZW1zIjpbXX0.sig";
  const sampleCheckoutHash = computeCheckoutHash(sampleCheckoutJwt);

  const validCheckoutPayload = {
    vct: "mandate.checkout.1" as const,
    checkout_jwt: sampleCheckoutJwt,
    checkout_hash: sampleCheckoutHash,
    iat: now - 10,
    exp: now + 3600,
    nonce: "chk-nonce-001",
  };

  const validPaymentPayload = {
    vct: "mandate.payment.1" as const,
    transaction_id: sampleCheckoutHash,
    payee: {
      id: "merch-1",
      name: "Acme Retailer",
      website: "https://acme.example.com",
    },
    payment_amount: {
      currency: "USD",
      amount: 24999, // $249.99 in cents
    },
    payment_instrument: {
      id: "instr-paypal-01",
      type: "PAYPAL_WALLET",
      description: "User PayPal Balance",
    },
    iat: now - 10,
    exp: now + 3600,
    nonce: "pay-nonce-001",
  };

  describe("Schema Validation (Ticket 02.1)", () => {
    it("validates compliant Checkout Mandate payload", () => {
      const parsed = CheckoutMandateSchema.parse(validCheckoutPayload);
      expect(parsed.vct).toBe("mandate.checkout.1");
      expect(parsed.checkout_hash).toBe(sampleCheckoutHash);
    });

    it("rejects Checkout Mandate with invalid VCT", () => {
      const invalid = { ...validCheckoutPayload, vct: "mandate.checkout.2" };
      expect(() => CheckoutMandateSchema.parse(invalid)).toThrow(MandateSchemaValidationError);
    });

    it("validates compliant Payment Mandate payload", () => {
      const parsed = PaymentMandateSchema.parse(validPaymentPayload);
      expect(parsed.vct).toBe("mandate.payment.1");
      expect(parsed.payment_amount.amount).toBe(24999);
    });

    it("rejects float/decimal amounts in payment mandate", () => {
      const invalid = {
        ...validPaymentPayload,
        payment_amount: {
          currency: "USD",
          amount: 249.99, // Float instead of integer minor units
        },
      };
      expect(() => PaymentMandateSchema.parse(invalid)).toThrow(MandateSchemaValidationError);
    });

    it("rejects invalid currency codes", () => {
      const invalid = {
        ...validPaymentPayload,
        payment_amount: {
          currency: "US", // Must be 3-letter ISO-4217
          amount: 1000,
        },
      };
      expect(() => PaymentMandateSchema.parse(invalid)).toThrow(MandateSchemaValidationError);
    });

    it("rejects negative amounts in payment mandate", () => {
      const invalid = {
        ...validPaymentPayload,
        payment_amount: {
          currency: "USD",
          amount: -500,
        },
      };
      expect(() => PaymentMandateSchema.parse(invalid)).toThrow(MandateSchemaValidationError);
    });
  });

  describe("Full Mandate Verification Pipeline (Ticket 02.2 & 02.3)", () => {
    it("verifies valid signed Checkout Mandate", async () => {
      const signed = signMandate(validCheckoutPayload, agentKeys.privateKey, agentKeys.publicKey);
      const verified = await verifyCheckoutMandate(signed, {
        publicKey: agentKeys.publicKey,
      });

      expect(verified.vct).toBe("mandate.checkout.1");
      expect(verified.checkout_jwt).toBe(sampleCheckoutJwt);
    });

    it("verifies valid signed Payment Mandate", async () => {
      const signed = signMandate(validPaymentPayload, agentKeys.privateKey, agentKeys.publicKey);
      const verified = await verifyPaymentMandate(signed, {
        publicKey: agentKeys.publicKey,
      });

      expect(verified.vct).toBe("mandate.payment.1");
      expect(verified.payment_amount.amount).toBe(24999);
    });

    it("rejects expired mandates before cryptographic evaluation", async () => {
      const expiredPayload = {
        ...validPaymentPayload,
        iat: now - 3600,
        exp: now - 60, // expired 60 seconds ago
      };
      const signed = signMandate(expiredPayload, agentKeys.privateKey, agentKeys.publicKey);

      await expect(
        verifyPaymentMandate(signed, {
          publicKey: agentKeys.publicKey,
          nowEpochSeconds: now,
        }),
      ).rejects.toThrow(ExpiredMandateError);
    });

    it("rejects mandates issued in the future beyond tolerance skew", async () => {
      const futurePayload = {
        ...validPaymentPayload,
        iat: now + 500, // 500 seconds in future
        exp: now + 3600,
      };
      const signed = signMandate(futurePayload, agentKeys.privateKey, agentKeys.publicKey);

      await expect(
        verifyPaymentMandate(signed, {
          publicKey: agentKeys.publicKey,
          nowEpochSeconds: now,
          clockSkewToleranceSeconds: 60,
        }),
      ).rejects.toThrow(MandateSchemaValidationError);
    });

    it("rejects duplicate mandate nonces via NonceStore", async () => {
      const nonceStore = new InMemoryNonceStore();
      const signed = signMandate(validPaymentPayload, agentKeys.privateKey, agentKeys.publicKey);

      const first = await verifyPaymentMandate(signed, {
        publicKey: agentKeys.publicKey,
        nonceStore,
      });
      expect(first).toBeDefined();

      await expect(
        verifyPaymentMandate(signed, {
          publicKey: agentKeys.publicKey,
          nonceStore,
        }),
      ).rejects.toThrow(DuplicateMandateNonceError);
    });

    it("rejects mutated payload with InvalidMandateSignatureError", async () => {
      const signed = signMandate(validPaymentPayload, agentKeys.privateKey, agentKeys.publicKey);

      // Mutate amount after signing
      const tampered = {
        ...signed,
        mandate: {
          ...signed.mandate,
          payment_amount: {
            currency: "USD",
            amount: 1000,
          },
        },
      };

      await expect(
        verifyPaymentMandate(tampered, {
          publicKey: agentKeys.publicKey,
        }),
      ).rejects.toThrow(InvalidMandateSignatureError);
    });
  });

  describe("SD-JWT Hash Chaining & Transaction Binding", () => {
    it("confirms cryptographic binding between Checkout Mandate and Payment Mandate", () => {
      const isBound = verifyMandateBinding(validCheckoutPayload, validPaymentPayload);
      expect(isBound).toBe(true);
    });

    it("throws MandateBindingMismatchError when transaction_id does not match checkout_hash", () => {
      const mismatchedPayment = {
        ...validPaymentPayload,
        transaction_id: "mismatched-hash-xyz",
      };

      expect(() => verifyMandateBinding(validCheckoutPayload, mismatchedPayment)).toThrow(
        MandateBindingMismatchError,
      );
    });

    it("computes deterministic SHA-256 base64url checkout hash", () => {
      const hash1 = computeCheckoutHash("sample.jwt.token");
      const hash2 = computeCheckoutHash("sample.jwt.token");
      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe("string");
      expect(hash1.length).toBeGreaterThan(20);
    });
  });

  describe("Generic verifyMandate Dispatcher", () => {
    it("dispatches and validates Checkout Mandate", async () => {
      const signed = signMandate(validCheckoutPayload, agentKeys.privateKey, agentKeys.publicKey);
      const result = await verifyMandate(signed, { publicKey: agentKeys.publicKey });
      expect(result.vct).toBe("mandate.checkout.1");
    });

    it("dispatches and validates Payment Mandate", async () => {
      const signed = signMandate(validPaymentPayload, agentKeys.privateKey, agentKeys.publicKey);
      const result = await verifyMandate(signed, { publicKey: agentKeys.publicKey });
      expect(result.vct).toBe("mandate.payment.1");
    });

    it("rejects unrecognized VCT with MandateSchemaValidationError", async () => {
      const invalidVct = {
        mandate: { vct: "mandate.unknown.99" },
        signature: "invalid",
      };
      await expect(verifyMandate(invalidVct, { publicKey: agentKeys.publicKey })).rejects.toThrow(
        MandateSchemaValidationError,
      );
    });

    it("rejects null or non-object signed mandate", async () => {
      await expect(
        verifyMandate(null as unknown as SignedMandate<unknown>, {
          publicKey: agentKeys.publicKey,
        }),
      ).rejects.toThrow(MandateSchemaValidationError);
    });
  });
});
