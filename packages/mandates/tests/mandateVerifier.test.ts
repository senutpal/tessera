import { Money } from "@tessera/core";
import { describe, expect, it } from "vitest";
import {
  amountToMoney,
  CheckoutMandateSchema,
  computeCheckoutHash,
  DuplicateMandateNonceError,
  ExpiredMandateError,
  generateEd25519KeyPair,
  InMemoryNonceStore,
  InvalidMandateSignatureError,
  MandateBindingMismatchError,
  MandateSchemaValidationError,
  type MandateVerificationOptions,
  moneyToAmount,
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

  describe("Schema Validation", () => {
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

    it("converts between AP2 Amount and @tessera/core Money", () => {
      const amount = { amount: 19999, currency: "USD" };
      const money = amountToMoney(amount);
      expect(money).toBeInstanceOf(Money);
      expect(money.amount).toBe(19999);
      expect(money.currency).toBe("USD");

      const convertedBack = moneyToAmount(money);
      expect(convertedBack).toEqual(amount);
    });
  });

  describe("Full Mandate Verification Pipeline", () => {
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

    it("rejects mandates with exp <= iat (inverted timestamps)", async () => {
      const invertedPayload = {
        ...validPaymentPayload,
        iat: now,
        exp: now - 10,
      };
      const signed = signMandate(invertedPayload, agentKeys.privateKey, agentKeys.publicKey);

      await expect(
        verifyPaymentMandate(signed, {
          publicKey: agentKeys.publicKey,
          nowEpochSeconds: now - 20,
        }),
      ).rejects.toThrow(MandateSchemaValidationError);
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

    it("leaves nonce unused if mandate signature is forged / invalid", async () => {
      const nonceStore = new InMemoryNonceStore();
      const forgedSigned: SignedMandate<typeof validPaymentPayload> = {
        mandate: {
          ...validPaymentPayload,
          nonce: "forged-nonce-999",
        },
        signature: Buffer.alloc(64, 0xbb).toString("base64url"), // Invalid signature
      };

      await expect(
        verifyPaymentMandate(forgedSigned, {
          publicKey: agentKeys.publicKey,
          nonceStore,
        }),
      ).rejects.toThrow(InvalidMandateSignatureError);

      // Verify the nonce was NOT consumed
      expect(await nonceStore.hasNonce("forged-nonce-999")).toBe(false);
    });

    it("requires nonce and exp when replay protection is enabled via nonceStore", async () => {
      const nonceStore = new InMemoryNonceStore();
      const payloadMissingNonce = {
        ...validPaymentPayload,
        nonce: undefined,
      };
      const signed = signMandate(payloadMissingNonce, agentKeys.privateKey);

      await expect(
        verifyPaymentMandate(signed, {
          publicKey: agentKeys.publicKey,
          nonceStore,
        }),
      ).rejects.toThrow(MandateSchemaValidationError);

      const payloadMissingExp = {
        ...validPaymentPayload,
        exp: undefined,
      };
      const signedNoExp = signMandate(payloadMissingExp, agentKeys.privateKey);

      await expect(
        verifyPaymentMandate(signedNoExp, {
          publicKey: agentKeys.publicKey,
          nonceStore,
        }),
      ).rejects.toThrow(MandateSchemaValidationError);
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

    it("verifies signatures over original mandate preserving additional SD-JWT claims", async () => {
      const extraClaimsPayload = {
        ...validPaymentPayload,
        _sd_alg: "sha-256",
        custom_claim: "audited",
      };

      const signed = signMandate(extraClaimsPayload, agentKeys.privateKey);
      const verified = await verifyPaymentMandate(signed, {
        publicKey: agentKeys.publicKey,
      });

      expect(verified).toBeDefined();
      expect((verified as Record<string, unknown>)._sd_alg).toBe("sha-256");
    });

    it("rejects missing public key options with InvalidMandateSignatureError", async () => {
      const signed = signMandate(validPaymentPayload, agentKeys.privateKey);
      await expect(
        verifyPaymentMandate(signed, null as unknown as MandateVerificationOptions),
      ).rejects.toThrow(InvalidMandateSignatureError);
      await expect(
        verifyPaymentMandate(signed, {} as unknown as MandateVerificationOptions),
      ).rejects.toThrow(InvalidMandateSignatureError);
    });
  });

  describe("SD-JWT Hash Chaining & Transaction Binding", () => {
    it("confirms cryptographic binding between Checkout Mandate and Payment Mandate", () => {
      const isBound = verifyMandateBinding(validCheckoutPayload, validPaymentPayload);
      expect(isBound).toBe(true);
    });

    it("rejects Checkout Mandate when checkout_hash does not match hash of checkout_jwt", async () => {
      const badCheckoutPayload = {
        ...validCheckoutPayload,
        checkout_hash: "wrong-checkout-hash",
      };
      const signed = signMandate(badCheckoutPayload, agentKeys.privateKey);

      await expect(
        verifyCheckoutMandate(signed, { publicKey: agentKeys.publicKey }),
      ).rejects.toThrow(MandateBindingMismatchError);
    });

    it("throws MandateBindingMismatchError in verifyMandateBinding when checkout_hash is invalid", () => {
      const badCheckoutPayload = {
        ...validCheckoutPayload,
        checkout_hash: "wrong-checkout-hash",
      };
      const badPaymentPayload = {
        ...validPaymentPayload,
        transaction_id: "wrong-checkout-hash",
      };

      expect(() => verifyMandateBinding(badCheckoutPayload, badPaymentPayload)).toThrow(
        MandateBindingMismatchError,
      );
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
