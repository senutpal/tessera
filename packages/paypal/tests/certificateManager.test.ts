import { describe, expect, it, vi } from "vitest";
import {
  CertificateManager,
  PayPalApiError,
  UntrustedCertificateUrlError,
  WebhookVerificationError,
} from "../index.js";
import { TEST_CERT_PEM, TEST_CERT_URL } from "./testCryptoHelpers.js";

describe("CertificateManager", () => {
  describe("validateCertificateUrl", () => {
    const manager = new CertificateManager();

    it("accepts valid PayPal API and Sandbox endpoints", () => {
      const validUrls = [
        "https://api.paypal.com/v1/notifications/certs/CERT-123",
        "https://api-m.paypal.com/v1/notifications/certs/CERT-123",
        "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-123",
        "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-123",
        "https://api.sandbox.paypal.com:443/v1/notifications/certs/CERT-123",
      ];

      for (const url of validUrls) {
        expect(manager.validateCertificateUrl(url)).toBe(true);
      }
    });

    it("rejects non-HTTPS URLs", () => {
      expect(() =>
        manager.validateCertificateUrl("http://api.paypal.com/v1/notifications/certs/CERT-123"),
      ).toThrow(UntrustedCertificateUrlError);
    });

    it("rejects attacker domains and spoofed subdomains", () => {
      const maliciousUrls = [
        "https://attacker.com/v1/notifications/certs/CERT-123",
        "https://api.sandbox.paypal.com.attacker.com/cert.pem",
        "https://api.paypal.com.evil.org/cert.pem",
        "https://evil-api.paypal.com/cert.pem",
        "https://paypal.com/cert.pem", // Must be api. or api-m.
        "https://api.paypal.com:8443/cert.pem", // Non-standard port
        "javascript:alert(1)",
        "https://127.0.0.1/cert.pem",
      ];

      for (const url of maliciousUrls) {
        expect(() => manager.validateCertificateUrl(url)).toThrow(UntrustedCertificateUrlError);
      }
    });

    it("rejects empty or malformed input", () => {
      expect(() => manager.validateCertificateUrl("")).toThrow(UntrustedCertificateUrlError);
      // @ts-expect-error Testing invalid runtime input
      expect(() => manager.validateCertificateUrl(null)).toThrow(UntrustedCertificateUrlError);
    });
  });

  describe("Caching and Fetching", () => {
    it("fetches certificate and serves subsequent requests from memory cache", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(TEST_CERT_PEM, {
          status: 200,
          headers: { "Content-Type": "application/x-pem-file" },
        }),
      );

      const manager = new CertificateManager({
        customFetch: mockFetch as unknown as typeof fetch,
      });

      expect(manager.has(TEST_CERT_URL)).toBe(false);
      expect(manager.size).toBe(0);

      const cert1 = await manager.getCertificate(TEST_CERT_URL);
      expect(cert1).toBe(TEST_CERT_PEM);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(manager.has(TEST_CERT_URL)).toBe(true);
      expect(manager.size).toBe(1);

      // Second call must hit cache without network fetch
      const cert2 = await manager.getCertificate(TEST_CERT_URL);
      expect(cert2).toBe(TEST_CERT_PEM);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("deduplicates concurrent in-flight requests for the same URL", async () => {
      let resolveFetch!: (res: Response) => void;
      const fetchPromise = new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
      const mockFetch = vi.fn().mockImplementation(() => fetchPromise);

      const manager = new CertificateManager({
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const p1 = manager.getCertificate(TEST_CERT_URL);
      const p2 = manager.getCertificate(TEST_CERT_URL);
      const p3 = manager.getCertificate(TEST_CERT_URL);

      resolveFetch(new Response(TEST_CERT_PEM, { status: 200 }));

      const [res1, res2, res3] = await Promise.all([p1, p2, p3]);
      expect(res1).toBe(TEST_CERT_PEM);
      expect(res2).toBe(TEST_CERT_PEM);
      expect(res3).toBe(TEST_CERT_PEM);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("respects TTL expiration and re-fetches when expired", async () => {
      const mockFetch = vi.fn().mockImplementation(
        () =>
          new Response(TEST_CERT_PEM, {
            status: 200,
          }),
      );

      const manager = new CertificateManager({
        ttlMs: 50, // 50ms TTL for testing
        customFetch: mockFetch as unknown as typeof fetch,
      });

      await manager.getCertificate(TEST_CERT_URL);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(manager.has(TEST_CERT_URL)).toBe(false);

      await manager.getCertificate(TEST_CERT_URL);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("evicts least recently used entry when maxSize is reached", async () => {
      const mockFetch = vi
        .fn()
        .mockImplementation(() => new Response(TEST_CERT_PEM, { status: 200 }));
      const manager = new CertificateManager({
        maxSize: 2,
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const url1 = "https://api.sandbox.paypal.com/certs/cert-1";
      const url2 = "https://api.sandbox.paypal.com/certs/cert-2";
      const url3 = "https://api.sandbox.paypal.com/certs/cert-3";

      await manager.getCertificate(url1);
      await manager.getCertificate(url2);
      expect(manager.size).toBe(2);

      // url3 should trigger eviction of url1
      await manager.getCertificate(url3);
      expect(manager.size).toBe(2);
      expect(manager.has(url1)).toBe(false);
      expect(manager.has(url2)).toBe(true);
      expect(manager.has(url3)).toBe(true);
    });

    it("clears cache and cancels in-flight state", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(TEST_CERT_PEM, { status: 200 }));
      const manager = new CertificateManager({
        customFetch: mockFetch as unknown as typeof fetch,
      });

      await manager.getCertificate(TEST_CERT_URL);
      expect(manager.size).toBe(1);

      manager.clear();
      expect(manager.size).toBe(0);
      expect(manager.has(TEST_CERT_URL)).toBe(false);
    });
  });

  describe("Error Handling", () => {
    it("throws PayPalApiError on non-200 response", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("Not Found", {
          status: 404,
          statusText: "Not Found",
        }),
      );

      const manager = new CertificateManager({
        customFetch: mockFetch as unknown as typeof fetch,
      });

      await expect(manager.getCertificate(TEST_CERT_URL)).rejects.toThrow(PayPalApiError);
    });

    it("throws PayPalApiError on network failure", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

      const manager = new CertificateManager({
        customFetch: mockFetch as unknown as typeof fetch,
      });

      await expect(manager.getCertificate(TEST_CERT_URL)).rejects.toThrow(PayPalApiError);
    });

    it("throws WebhookVerificationError if response is not valid PEM", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response("<html>Invalid body</html>", {
          status: 200,
        }),
      );

      const manager = new CertificateManager({
        customFetch: mockFetch as unknown as typeof fetch,
      });

      await expect(manager.getCertificate(TEST_CERT_URL)).rejects.toThrow(WebhookVerificationError);
    });
  });

  describe("getPublicKey", () => {
    it("returns KeyObject from valid certificate", async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(TEST_CERT_PEM, { status: 200 }));
      const manager = new CertificateManager({
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const keyObject = await manager.getPublicKey(TEST_CERT_URL);
      expect(keyObject).toBeDefined();
      expect(keyObject.asymmetricKeyType).toBe("rsa");
    });
  });
});
