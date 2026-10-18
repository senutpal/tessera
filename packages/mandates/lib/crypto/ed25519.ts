import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  sign,
  verify,
} from "node:crypto";
import { canonicalizeToBuffer } from "@tessera/core";
import { InvalidMandateSignatureError } from "../errors.js";

const ED25519_RAW_PUBLIC_KEY_LENGTH = 32;
const ED25519_RAW_PRIVATE_SEED_LENGTH = 32;
const ED25519_SIGNATURE_LENGTH = 64;

// SPKI header for Ed25519 public key (OID: 1.3.101.112)
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// PKCS#8 header for Ed25519 private key seed (OID: 1.3.101.112)
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export interface Ed25519KeyPair {
  publicKey: string; // 32-byte raw key in base64url
  privateKey: string; // 32-byte raw seed in base64url
}

/**
 * Generates a new cryptographically secure Ed25519 keypair.
 * Returns public and private keys encoded in base64url format.
 */
export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" });
  const privJwk = privateKey.export({ format: "jwk" });

  if (!pubJwk.x || !privJwk.d) {
    throw new InvalidMandateSignatureError("Failed to extract Ed25519 raw key coordinates");
  }

  return {
    publicKey: pubJwk.x,
    privateKey: privJwk.d,
  };
}

/**
 * Converts an Ed25519 public key (base64url, PEM string, Buffer, or KeyObject)
 * into a Node.js crypto KeyObject. Rejects non-Ed25519 keys.
 */
export function parsePublicKey(publicKeyInput: string | Buffer | KeyObject): KeyObject {
  if (!publicKeyInput) {
    throw new InvalidMandateSignatureError("Ed25519 public key is required");
  }

  if (publicKeyInput instanceof KeyObject) {
    if (publicKeyInput.type !== "public") {
      throw new InvalidMandateSignatureError("KeyObject must be a public key");
    }
    if (publicKeyInput.asymmetricKeyType !== "ed25519") {
      throw new InvalidMandateSignatureError(
        `KeyObject must be an Ed25519 key, received "${publicKeyInput.asymmetricKeyType}"`,
      );
    }
    return publicKeyInput;
  }

  let rawBytes: Buffer;
  if (typeof publicKeyInput === "string") {
    if (publicKeyInput.includes("-----BEGIN")) {
      try {
        const keyObj = createPublicKey(publicKeyInput);
        if (keyObj.asymmetricKeyType !== "ed25519") {
          throw new InvalidMandateSignatureError(
            `PEM key must be an Ed25519 key, received "${keyObj.asymmetricKeyType}"`,
          );
        }
        return keyObj;
      } catch (err) {
        if (err instanceof InvalidMandateSignatureError) throw err;
        throw new InvalidMandateSignatureError(
          `Failed to parse Ed25519 PEM public key: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    rawBytes = Buffer.from(publicKeyInput, "base64url");
  } else if (Buffer.isBuffer(publicKeyInput)) {
    rawBytes = publicKeyInput;
  } else {
    throw new InvalidMandateSignatureError(
      "Ed25519 public key must be a base64url string, PEM string, Buffer, or KeyObject",
    );
  }

  if (rawBytes.length !== ED25519_RAW_PUBLIC_KEY_LENGTH) {
    throw new InvalidMandateSignatureError(
      `Ed25519 public key must be exactly ${ED25519_RAW_PUBLIC_KEY_LENGTH} bytes, received ${rawBytes.length}`,
    );
  }

  try {
    const spkiDer = Buffer.concat([ED25519_SPKI_PREFIX, rawBytes]);
    return createPublicKey({ key: spkiDer, format: "der", type: "spki" });
  } catch (err) {
    throw new InvalidMandateSignatureError(
      `Failed to parse Ed25519 public key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Converts an Ed25519 private key seed (base64url, PEM string, Buffer, or KeyObject)
 * into a Node.js crypto KeyObject. Rejects non-Ed25519 keys.
 */
export function parsePrivateKey(privateKeyInput: string | Buffer | KeyObject): KeyObject {
  if (!privateKeyInput) {
    throw new InvalidMandateSignatureError("Ed25519 private key is required");
  }

  if (privateKeyInput instanceof KeyObject) {
    if (privateKeyInput.type !== "private") {
      throw new InvalidMandateSignatureError("KeyObject must be a private key");
    }
    if (privateKeyInput.asymmetricKeyType !== "ed25519") {
      throw new InvalidMandateSignatureError(
        `KeyObject must be an Ed25519 key, received "${privateKeyInput.asymmetricKeyType}"`,
      );
    }
    return privateKeyInput;
  }

  let rawBytes: Buffer;
  if (typeof privateKeyInput === "string") {
    if (privateKeyInput.includes("-----BEGIN")) {
      try {
        const keyObj = createPrivateKey(privateKeyInput);
        if (keyObj.asymmetricKeyType !== "ed25519") {
          throw new InvalidMandateSignatureError(
            `PEM key must be an Ed25519 key, received "${keyObj.asymmetricKeyType}"`,
          );
        }
        return keyObj;
      } catch (err) {
        if (err instanceof InvalidMandateSignatureError) throw err;
        throw new InvalidMandateSignatureError(
          `Failed to parse Ed25519 PEM private key: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    rawBytes = Buffer.from(privateKeyInput, "base64url");
  } else if (Buffer.isBuffer(privateKeyInput)) {
    rawBytes = privateKeyInput;
  } else {
    throw new InvalidMandateSignatureError(
      "Ed25519 private key seed must be a base64url string, PEM string, Buffer, or KeyObject",
    );
  }

  if (rawBytes.length !== ED25519_RAW_PRIVATE_SEED_LENGTH) {
    throw new InvalidMandateSignatureError(
      `Ed25519 private key seed must be exactly ${ED25519_RAW_PRIVATE_SEED_LENGTH} bytes, received ${rawBytes.length}`,
    );
  }

  try {
    const pkcs8Der = Buffer.concat([ED25519_PKCS8_PREFIX, rawBytes]);
    return createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
  } catch (err) {
    throw new InvalidMandateSignatureError(
      `Failed to parse Ed25519 private key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Signs an arbitrary payload with an Ed25519 private key over RFC 8785 canonical JSON bytes.
 * Returns base64url-encoded 64-byte signature.
 */
export function signPayloadEd25519(
  payload: unknown,
  privateKeyInput: string | Buffer | KeyObject,
): string {
  const privKeyObj = parsePrivateKey(privateKeyInput);
  const canonicalBytes = canonicalizeToBuffer(payload);
  const signatureBytes = sign(null, canonicalBytes, privKeyObj);
  return signatureBytes.toString("base64url");
}

/**
 * Verifies an Ed25519 signature over RFC 8785 canonical JSON bytes.
 * Uses timing-safe constant-time verification.
 *
 * @throws {InvalidMandateSignatureError} If key or signature format is malformed.
 * @returns boolean True if signature is valid; false if invalid or payload was modified.
 */
export function verifyPayloadEd25519(
  payload: unknown,
  signatureBase64Url: string,
  publicKeyInput: string | Buffer | KeyObject,
): boolean {
  if (typeof signatureBase64Url !== "string") {
    throw new InvalidMandateSignatureError("Signature must be a string");
  }

  const sigBytes = Buffer.from(signatureBase64Url, "base64url");
  if (sigBytes.length !== ED25519_SIGNATURE_LENGTH) {
    throw new InvalidMandateSignatureError(
      `Ed25519 signature must be exactly ${ED25519_SIGNATURE_LENGTH} bytes, received ${sigBytes.length}`,
    );
  }

  const pubKeyObj = parsePublicKey(publicKeyInput);
  const canonicalBytes = canonicalizeToBuffer(payload);

  try {
    return verify(null, canonicalBytes, pubKeyObj, sigBytes);
  } catch {
    return false;
  }
}

/**
 * Computes base64url SHA-256 hash of an arbitrary payload over RFC 8785 canonical JSON bytes.
 */
export function computeCanonicalMandateHash(mandate: unknown): string {
  const canonicalBytes = canonicalizeToBuffer(mandate);
  return createHash("sha256").update(canonicalBytes).digest("base64url");
}
