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

    it("accepts signatures generated with hex CRC32 format via defensive fallback", async () => {
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

      expect(result.isValid).toBe(true);
      expect(result.method).toBe("LOCAL_ASYMMETRIC");
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
  });
});
