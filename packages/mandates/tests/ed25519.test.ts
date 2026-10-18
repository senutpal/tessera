import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeCanonicalMandateHash,
  generateEd25519KeyPair,
  InvalidMandateSignatureError,
  parsePrivateKey,
  parsePublicKey,
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

  it("verifies known RFC 8032 test vectors", () => {
    // RFC 8032 Section 7.1 Test Vector 1
    const privHex = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
    const pubHex = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    const privBase64Url = Buffer.from(privHex, "hex").toString("base64url");
    const pubBase64Url = Buffer.from(pubHex, "hex").toString("base64url");

    const payload = { test: "rfc8032" };
    const sig = signPayloadEd25519(payload, privBase64Url);
    expect(verifyPayloadEd25519(payload, sig, pubBase64Url)).toBe(true);
  });

  it("rejects non-Ed25519 KeyObjects (e.g. RSA or EC) with InvalidMandateSignatureError", () => {
    const { publicKey: rsaPub, privateKey: rsaPriv } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });

    expect(() => parsePublicKey(rsaPub)).toThrow(InvalidMandateSignatureError);
    expect(() => parsePrivateKey(rsaPriv)).toThrow(InvalidMandateSignatureError);
  });

  it("rejects null or non-string/non-buffer key inputs with InvalidMandateSignatureError", () => {
    expect(() => parsePublicKey(null as unknown as string)).toThrow(InvalidMandateSignatureError);
    expect(() => parsePublicKey(123 as unknown as string)).toThrow(InvalidMandateSignatureError);
    expect(() => parsePrivateKey(null as unknown as string)).toThrow(InvalidMandateSignatureError);
    expect(() => parsePrivateKey(false as unknown as string)).toThrow(InvalidMandateSignatureError);
  });

  it("supports PEM-encoded Ed25519 keys", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const privPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

    const payload = { pemTest: true };
    const sig = signPayloadEd25519(payload, privPem);
    expect(verifyPayloadEd25519(payload, sig, pubPem)).toBe(true);
  });

  it("computes deterministic canonical mandate hash", () => {
    const mandate1 = { b: 2, a: 1 };
    const mandate2 = { a: 1, b: 2 };
    const hash1 = computeCanonicalMandateHash(mandate1);
    const hash2 = computeCanonicalMandateHash(mandate2);

    expect(hash1).toBe(hash2);
    expect(typeof hash1).toBe("string");
    expect(hash1.length).toBeGreaterThan(20);
  });
});
