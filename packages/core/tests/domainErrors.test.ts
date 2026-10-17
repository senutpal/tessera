import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  DomainError,
  EscrowAuthorizationError,
  EscrowCaptureError,
  EscrowVoidError,
  isDomainError,
  MandateExpiredError,
  MandateSignatureError,
  MandateValidationError,
  NonceReplayError,
  PolicyViolationError,
} from "../index.js";

describe("Domain Error Hierarchy", () => {
  it("serializes DomainError cleanly to JSON with unique codes and HTTP status", () => {
    const error = new MandateValidationError("Mandate payload is missing merchant domain", {
      field: "merchant.domain",
    });

    expect(isDomainError(error)).toBe(true);
    expect(error.code).toBe("MANDATE_VALIDATION_ERROR");
    expect(error.httpStatus).toBe(400);
    expect(error.message).toBe("Mandate payload is missing merchant domain");
    expect(error.details).toEqual({ field: "merchant.domain" });

    const json = error.toJSON();
    expect(json.name).toBe("MandateValidationError");
    expect(json.code).toBe("MANDATE_VALIDATION_ERROR");
    expect(json.httpStatus).toBe(400);
    expect(json.message).toBe("Mandate payload is missing merchant domain");
    expect(json.details).toEqual({ field: "merchant.domain" });
    expect(typeof json.timestamp).toBe("string");
  });

  it("assigns appropriate status codes across specialized subclasses", () => {
    const expired = new MandateExpiredError("Mandate exp has passed");
    expect(expired.httpStatus).toBe(410);
    expect(expired.code).toBe("MANDATE_EXPIRED");

    const signature = new MandateSignatureError("Signature mismatch");
    expect(signature.httpStatus).toBe(401);
    expect(signature.code).toBe("MANDATE_SIGNATURE_INVALID");

    const replay = new NonceReplayError("Nonce already consumed");
    expect(replay.httpStatus).toBe(409);
    expect(replay.code).toBe("NONCE_ALREADY_USED");

    const policy = new PolicyViolationError("Budget cap exceeded");
    expect(policy.httpStatus).toBe(403);
    expect(policy.code).toBe("POLICY_VIOLATION");

    const escrowAuth = new EscrowAuthorizationError("PayPal authorization declined");
    expect(escrowAuth.httpStatus).toBe(402);
    expect(escrowAuth.code).toBe("ESCROW_AUTHORIZATION_FAILED");

    const escrowCapture = new EscrowCaptureError("Escrow capture release failed");
    expect(escrowCapture.httpStatus).toBe(409);
    expect(escrowCapture.code).toBe("ESCROW_CAPTURE_FAILED");

    const escrowVoid = new EscrowVoidError("Escrow void failed");
    expect(escrowVoid.httpStatus).toBe(409);
    expect(escrowVoid.code).toBe("ESCROW_VOID_FAILED");

    const cjson = new CanonicalJsonError("Non-finite number found");
    expect(cjson.httpStatus).toBe(400);
    expect(cjson.code).toBe("CANONICAL_JSON_ERROR");
  });

  it("isDomainError identifies domain errors and rejects standard errors", () => {
    const custom = new DomainError("generic error", "GENERIC_ERROR", 500);
    expect(isDomainError(custom)).toBe(true);

    const standard = new Error("standard error");
    expect(isDomainError(standard)).toBe(false);

    expect(isDomainError(null)).toBe(false);
    expect(isDomainError({ code: "FOO" })).toBe(false);
  });
});
