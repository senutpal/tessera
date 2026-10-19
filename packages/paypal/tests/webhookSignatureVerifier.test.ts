import { describe, expect, it, vi } from "vitest";
import {
  CertificateManager,
  computeCrc32,
  computeCrc32Hex,
  InMemoryWebhookIdempotencyStore,
  type PayPalClient,
  UntrustedCertificateUrlError,
  WebhookSignatureVerifier,
  WebhookVerificationError,
} from "../index.js";
import {
  createSignedWebhookRequest,
  signWebhookPayload,
  TEST_CERT_PEM,
  TEST_CERT_URL,
  TEST_WEBHOOK_ID,
} from "./testCryptoHelpers.js";

describe("WebhookSignatureVerifier", () => {
  const createMockCertificateManager = () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(() => new Response(TEST_CERT_PEM, { status: 200 }));
    return new CertificateManager({
      customFetch: mockFetch as unknown as typeof fetch,
    });
  };

  describe("CRC32 calculation helpers", () => {
    it("computes unsigned 32-bit decimal integer string by default", () => {
      const payload = '{"status":"APPROVED"}';
      const crc = computeCrc32(payload);
      expect(crc).toMatch(/^\d+$/);
      // Value should be positive integer
      const num = Number(crc);
      expect(num).toBeGreaterThan(0);
      expect(num).toBeLessThanOrEqual(0xffffffff);
    });

    it("computes lowercase hexadecimal string when requested", () => {
      const payload = '{"status":"APPROVED"}';
      const hex = computeCrc32Hex(payload);
      expect(hex).toMatch(/^[0-9a-f]+$/);
      expect(parseInt(hex, 16)).toBe(Number(computeCrc32(payload)));
    });

    it("handles Buffer and string inputs identically", () => {
      const str = '{"event_type":"PAYMENT.AUTHORIZATION.CREATED"}';
      const buf = Buffer.from(str, "utf8");
      expect(computeCrc32(str)).toBe(computeCrc32(buf));
      expect(computeCrc32Hex(str)).toBe(computeCrc32Hex(buf));
    });
  });

  describe("Local Cryptographic Verification", () => {
    it("verifies an authentic signed webhook request with authentic headers", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      const body = JSON.stringify({
        id: "WH-12345",
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource: { id: "AUTH-999" },
      });

      const req = createSignedWebhookRequest({ rawBody: body });
      const result = await verifier.verify(req);

      expect(result.isValid).toBe(true);
      expect(result.isDuplicate).toBe(false);
      expect(result.method).toBe("LOCAL_ASYMMETRIC");
      expect(result.transmissionId).toBe(req.headers["paypal-transmission-id"]);
      expect(result.algorithm).toBe("SHA256withRSA");
    });

    it("rejects signatures generated with hex CRC32 format per PayPal specification", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      const body = '{"status":"COMPLETED"}';
      const transmissionId = "tx-hex-test-123";
      const timestamp = new Date().toISOString();

      const hexSig = signWebhookPayload({
        transmissionId,
        timestamp,
        webhookId: TEST_WEBHOOK_ID,
        rawBody: body,
        format: "hex",
      });

      const result = await verifier.verify({
        headers: {
          "paypal-auth-algo": "SHA256withRSA",
          "paypal-cert-url": TEST_CERT_URL,
          "paypal-transmission-id": transmissionId,
          "paypal-transmission-sig": hexSig,
          "paypal-transmission-time": timestamp,
        },
        rawBody: body,
        webhookId: TEST_WEBHOOK_ID,
      });

      expect(result.isValid).toBe(false);
      expect(result.failureReason).toContain("Cryptographic signature mismatch");
    });

    it("rejects payload if body was altered by even a single byte", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      const originalBody = '{"amount":"100.00"}';
      const req = createSignedWebhookRequest({ rawBody: originalBody });

      // Tamper the body
      const tamperedBody = '{"amount":"999.00"}';
      const result = await verifier.verify({
        headers: req.headers,
        rawBody: tamperedBody,
        webhookId: req.webhookId,
      });

      expect(result.isValid).toBe(false);
      expect(result.failureReason).toContain("Cryptographic signature mismatch");
    });

    it("rejects payload if JSON whitespace is modified after signing", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      const originalBody = '{"auth": "ok"}';
      const req = createSignedWebhookRequest({ rawBody: originalBody });

      // Whitespace modification alters CRC32
      const modifiedBody = '{"auth":"ok"}';
      const result = await verifier.verify({
        headers: req.headers,
        rawBody: modifiedBody,
        webhookId: req.webhookId,
      });

      expect(result.isValid).toBe(false);
    });

    it("rejects payload if timestamp is tampered", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      const body = '{"status":"OK"}';
      const req = createSignedWebhookRequest({ rawBody: body });

      // Alter the transmission time header
      req.headers["paypal-transmission-time"] = new Date(Date.now() - 60_000).toISOString();

      const result = await verifier.verify(req);
      expect(result.isValid).toBe(false);
    });

    it("rejects payload if transmission ID is altered", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      const body = '{"status":"OK"}';
      const req = createSignedWebhookRequest({ rawBody: body });

      req.headers["paypal-transmission-id"] = "different-transmission-id";

      const result = await verifier.verify(req);
      expect(result.isValid).toBe(false);
    });

    it("rejects payload if webhook ID does not match signed message", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      const body = '{"status":"OK"}';
      const req = createSignedWebhookRequest({ rawBody: body });

      const result = await verifier.verify({
        ...req,
        webhookId: "DIFFERENT_WEBHOOK_ID",
      });

      expect(result.isValid).toBe(false);
    });

    it("rejects untrusted certificate URLs immediately without fetching", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      const body = '{"status":"OK"}';
      const req = createSignedWebhookRequest({
        rawBody: body,
        certUrl: "https://evil.attacker.com/cert.pem",
      });

      await expect(verifier.verify(req)).rejects.toThrow(UntrustedCertificateUrlError);
    });

    it("throws WebhookVerificationError when required headers are missing", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      await expect(
        verifier.verify({
          headers: {
            "paypal-transmission-id": "123",
          },
          rawBody: "{}",
        }),
      ).rejects.toThrow(WebhookVerificationError);
    });

    it("throws WebhookVerificationError when headers is null or undefined", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      // @ts-expect-error Testing invalid runtime headers
      await expect(verifier.verify({ headers: null, rawBody: "{}" })).rejects.toThrow(
        WebhookVerificationError,
      );
    });

    it("throws WebhookVerificationError when rawBody is null or undefined", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      const req = createSignedWebhookRequest({ rawBody: "{}" });
      // @ts-expect-error Testing invalid runtime rawBody
      await expect(verifier.verify({ ...req, rawBody: null })).rejects.toThrow(
        WebhookVerificationError,
      );
    });

    it("normalizes headers with leading/trailing whitespace and proxy duplicates", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      const body = '{"status":"APPROVED"}';
      const req = createSignedWebhookRequest({ rawBody: body });

      // Add whitespace and reverse-proxy duplicate comma-separated values
      const proxyHeaders = {
        "paypal-auth-algo": `  ${req.headers["paypal-auth-algo"]}  `,
        "paypal-cert-url": `${req.headers["paypal-cert-url"]}, ${req.headers["paypal-cert-url"]}`,
        "paypal-transmission-id": `  ${req.headers["paypal-transmission-id"]}  `,
        "paypal-transmission-sig": req.headers["paypal-transmission-sig"],
        "paypal-transmission-time": `  ${req.headers["paypal-transmission-time"]}  `,
      };

      const result = await verifier.verify({
        headers: proxyHeaders,
        rawBody: body,
      });

      expect(result.isValid).toBe(true);
      expect(result.transmissionId).toBe(req.headers["paypal-transmission-id"]);
    });
  });

  describe("Replay Protection & Idempotency", () => {
    it("flags duplicate transmission ID within replay window as isDuplicate: true", async () => {
      const certManager = createMockCertificateManager();
      const idempotencyStore = new InMemoryWebhookIdempotencyStore();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        idempotencyStore,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      const body = '{"event":"duplicate_test"}';
      const req = createSignedWebhookRequest({ rawBody: body });

      // First call
      const res1 = await verifier.verify(req);
      expect(res1.isValid).toBe(true);
      expect(res1.isDuplicate).toBe(false);

      // Replay identical transmission ID
      const res2 = await verifier.verify(req);
      expect(res2.isValid).toBe(true);
      expect(res2.isDuplicate).toBe(true);
      expect(res2.failureReason).toContain("Duplicate transmission ID");
    });

    it("rejects replayed transmission ID when signature is tampered (does not bypass verification)", async () => {
      const certManager = createMockCertificateManager();
      const idempotencyStore = new InMemoryWebhookIdempotencyStore();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        idempotencyStore,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      const body = '{"event":"legit"}';
      const req = createSignedWebhookRequest({ rawBody: body });

      // First call is authentic
      const res1 = await verifier.verify(req);
      expect(res1.isValid).toBe(true);

      // Attacker replays same transmission ID but tampers the body/signature
      const tamperedReq = {
        ...req,
        rawBody: '{"event":"forged"}',
      };
      const res2 = await verifier.verify(tamperedReq);

      expect(res2.isValid).toBe(false);
      expect(res2.isDuplicate).toBe(false);
      expect(res2.failureReason).toContain("signature mismatch");
    });

    it("rejects replayed transmission ID when certUrl is untrusted", async () => {
      const certManager = createMockCertificateManager();
      const idempotencyStore = new InMemoryWebhookIdempotencyStore();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        idempotencyStore,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      const body = '{"event":"legit"}';
      const req = createSignedWebhookRequest({ rawBody: body });

      const res1 = await verifier.verify(req);
      expect(res1.isValid).toBe(true);

      const attackerReq = {
        ...req,
        headers: {
          ...req.headers,
          "paypal-cert-url": "https://attacker.evil.com/cert.pem",
        },
      };

      await expect(verifier.verify(attackerReq)).rejects.toThrow(UntrustedCertificateUrlError);
    });

    it("allows bypassing replay check when checkReplay is false", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      const body = '{"event":"duplicate_test"}';
      const req = createSignedWebhookRequest({ rawBody: body });

      await verifier.verify(req);
      const res2 = await verifier.verify({
        ...req,
        options: { checkReplay: false },
      });

      expect(res2.isValid).toBe(true);
      expect(res2.isDuplicate).toBe(false);
    });
  });

  describe("Clock Skew Validation", () => {
    it("rejects timestamps older than maxClockSkewMs", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
        maxClockSkewMs: 60_000, // 1 minute allowed
      });

      const body = '{"status":"OK"}';
      // 10 minutes in the past
      const oldTime = new Date(Date.now() - 10 * 60_000).toISOString();
      const req = createSignedWebhookRequest({
        rawBody: body,
        timestamp: oldTime,
      });

      const result = await verifier.verify(req);
      expect(result.isValid).toBe(false);
      expect(result.failureReason).toContain("clock skew");
    });

    it("rejects malformed timestamps", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
        maxClockSkewMs: 60_000,
      });

      const body = '{"status":"OK"}';
      const req = createSignedWebhookRequest({
        rawBody: body,
        timestamp: "not-a-valid-date",
      });

      const result = await verifier.verify(req);
      expect(result.isValid).toBe(false);
      expect(result.failureReason).toContain("Malformed transmission timestamp");
    });

    it("rejects timestamps older than default 5-minute clock skew bound without explicit config", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
      });

      const body = '{"status":"OK"}';
      // 6 minutes in the past
      const oldTime = new Date(Date.now() - 6 * 60_000).toISOString();
      const req = createSignedWebhookRequest({
        rawBody: body,
        timestamp: oldTime,
      });

      const result = await verifier.verify(req);
      expect(result.isValid).toBe(false);
      expect(result.failureReason).toContain("exceeds maximum allowable clock skew of 300000ms");
    });

    it("allows disabling clock skew check by explicitly passing maxClockSkewMs: 0", async () => {
      const certManager = createMockCertificateManager();
      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        defaultWebhookId: TEST_WEBHOOK_ID,
        maxClockSkewMs: 0,
      });

      const body = '{"status":"OK"}';
      // 1 hour in the past
      const oldTime = new Date(Date.now() - 60 * 60_000).toISOString();
      const req = createSignedWebhookRequest({
        rawBody: body,
        timestamp: oldTime,
      });

      const result = await verifier.verify(req);
      expect(result.isValid).toBe(true);
    });
  });

  describe("Remote Postback Fallback", () => {
    it("falls back to PayPal REST API when local check fails and fallbackToRemote is enabled", async () => {
      const certManager = createMockCertificateManager();
      const mockPayPalClient = {
        verifyWebhookSignature: vi.fn().mockResolvedValue(true),
      } as unknown as PayPalClient;

      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        payPalClient: mockPayPalClient,
        defaultWebhookId: TEST_WEBHOOK_ID,
        fallbackToRemote: true,
      });

      const body = JSON.stringify({
        id: "WH-REMOTE-TEST",
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
      });

      // Deliberately tamper local signature to force fallback
      const req = createSignedWebhookRequest({
        rawBody: body,
        tamperSignature: true,
      });

      const result = await verifier.verify(req);

      expect(mockPayPalClient.verifyWebhookSignature).toHaveBeenCalledTimes(1);
      expect(result.isValid).toBe(true);
      expect(result.method).toBe("REMOTE_POSTBACK");
    });

    it("returns invalid when both local check and remote fallback fail", async () => {
      const certManager = createMockCertificateManager();
      const mockPayPalClient = {
        verifyWebhookSignature: vi.fn().mockResolvedValue(false),
      } as unknown as PayPalClient;

      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        payPalClient: mockPayPalClient,
        defaultWebhookId: TEST_WEBHOOK_ID,
        fallbackToRemote: true,
      });

      const body = '{"test":"fail"}';
      const req = createSignedWebhookRequest({
        rawBody: body,
        tamperSignature: true,
      });

      const result = await verifier.verify(req);

      expect(mockPayPalClient.verifyWebhookSignature).toHaveBeenCalledTimes(1);
      expect(result.isValid).toBe(false);
      expect(result.method).toBe("REMOTE_POSTBACK");
    });

    it("captures remote failure reason when PayPal API throws server error", async () => {
      const certManager = createMockCertificateManager();
      const mockPayPalClient = {
        verifyWebhookSignature: vi
          .fn()
          .mockRejectedValue(new Error("PayPal API 500 Internal Error")),
      } as unknown as PayPalClient;

      const verifier = new WebhookSignatureVerifier({
        certificateManager: certManager,
        payPalClient: mockPayPalClient,
        defaultWebhookId: TEST_WEBHOOK_ID,
        fallbackToRemote: true,
      });

      const body = '{"status":"ERR"}';
      const req = createSignedWebhookRequest({
        rawBody: body,
        tamperSignature: true,
      });

      const result = await verifier.verify(req);

      expect(result.isValid).toBe(false);
      expect(result.method).toBe("REMOTE_POSTBACK");
      expect(result.failureReason).toContain("PayPal API 500 Internal Error");
    });
  });
});
