import { describe, expect, it } from "vitest";
import {
  generateEd25519KeyPair,
  InvalidMandateSignatureError,
  signPayloadEd25519,
  verifyPayloadEd25519,
} from "../index.js";

describe("Ed25519 Cryptographic Signer & Verifier", () => {
  it("generates a valid Ed25519 keypair with 32-byte raw keys (base64url encoded)", () => {
    const keyPair = generateEd25519KeyPair();
    expect(keyPair).toBeDefined();
    expect(keyPair.publicKey).toBeDefined();
    expect(keyPair.privateKey).toBeDefined();

    const pubBytes = Buffer.from(keyPair.publicKey, "base64url");
    const privBytes = Buffer.from(keyPair.privateKey, "base64url");
    expect(pubBytes.length).toBe(32);
    expect(privBytes.length).toBe(32);
  });

  it("verifies valid Ed25519 signature over canonical RFC 8785 JSON", () => {
    const keyPair = generateEd25519KeyPair();
    const payload = {
      vct: "mandate.payment.1",
      transaction_id: "test-transaction-123",
      payment_amount: {
        currency: "USD",
        amount: 24999,
      },
      iat: 1718000000,
      exp: 1718003600,
    };

    const signature = signPayloadEd25519(payload, keyPair.privateKey);
    expect(typeof signature).toBe("string");
    expect(Buffer.from(signature, "base64url").length).toBe(64);

    const isValid = verifyPayloadEd25519(payload, signature, keyPair.publicKey);
    expect(isValid).toBe(true);
  });

  it("produces identical signatures regardless of object key order (RFC 8785 canonicalization)", () => {
    const keyPair = generateEd25519KeyPair();
    const payload1 = {
      b: 2,
      a: 1,
      nested: { z: 9, y: 8 },
    };
    const payload2 = {
      a: 1,
      nested: { y: 8, z: 9 },
      b: 2,
    };

    const sig1 = signPayloadEd25519(payload1, keyPair.privateKey);
    const sig2 = signPayloadEd25519(payload2, keyPair.privateKey);

    expect(sig1).toBe(sig2);
    expect(verifyPayloadEd25519(payload1, sig2, keyPair.publicKey)).toBe(true);
    expect(verifyPayloadEd25519(payload2, sig1, keyPair.publicKey)).toBe(true);
  });

  it("rejects verification if any byte in payload is tampered with", () => {
    const keyPair = generateEd25519KeyPair();
    const payload = {
      vct: "mandate.payment.1",
      payment_amount: {
        currency: "USD",
        amount: 24999,
      },
    };

    const signature = signPayloadEd25519(payload, keyPair.privateKey);

    const tamperedPayload = {
      vct: "mandate.payment.1",
      payment_amount: {
        currency: "USD",
        amount: 24998, // 1 cent less
      },
    };

    const isValid = verifyPayloadEd25519(tamperedPayload, signature, keyPair.publicKey);
    expect(isValid).toBe(false);
  });

  it("rejects verification if signature is corrupted or mutated", () => {
    const keyPair = generateEd25519KeyPair();
    const payload = { test: true };
    const signature = signPayloadEd25519(payload, keyPair.privateKey);

    const sigBytes = Buffer.from(signature, "base64url");
    sigBytes[0] = (sigBytes[0] ?? 0) ^ 0xff; // flip bits
    const corruptedSig = sigBytes.toString("base64url");

    const isValid = verifyPayloadEd25519(payload, corruptedSig, keyPair.publicKey);
    expect(isValid).toBe(false);
  });

  it("rejects verification with a different public key", () => {
    const keyPair1 = generateEd25519KeyPair();
    const keyPair2 = generateEd25519KeyPair();

    const payload = { vct: "mandate.payment.1" };
    const signature = signPayloadEd25519(payload, keyPair1.privateKey);

    const isValid = verifyPayloadEd25519(payload, signature, keyPair2.publicKey);
    expect(isValid).toBe(false);
  });

  it("throws InvalidMandateSignatureError for malformed key or signature lengths", () => {
    const keyPair = generateEd25519KeyPair();
    const payload = { vct: "mandate.payment.1" };

    expect(() => verifyPayloadEd25519(payload, "short-sig", keyPair.publicKey)).toThrow(
      InvalidMandateSignatureError,
    );

    const validSig = signPayloadEd25519(payload, keyPair.privateKey);
    expect(() => verifyPayloadEd25519(payload, validSig, "short-key")).toThrow(
      InvalidMandateSignatureError,
    );
  });
});
