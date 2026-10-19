import * as crypto from "node:crypto";
import { PayPalApiError } from "../types/orders.js";
import {
  PAYPAL_CERT_URL_REGEX,
  UntrustedCertificateUrlError,
  WebhookVerificationError,
} from "../types/webhooks.js";

export interface CertificateManagerConfig {
  ttlMs?: number | undefined;
  maxSize?: number | undefined;
  fetchTimeoutMs?: number | undefined;
  customFetch?: typeof fetch | undefined;
}

interface CertCacheEntry {
  cert: string;
  expiresAt: number;
  lastAccessed: number;
}

const TRUSTED_HOSTNAMES = new Set([
  "api.paypal.com",
  "api-m.paypal.com",
  "api.sandbox.paypal.com",
  "api-m.sandbox.paypal.com",
]);

/**
 * X.509 Certificate Manager for PayPal Webhook Verification.
 *
 * Enforces strict PayPal hostname whitelisting to prevent SSRF attacks,
 * provides in-memory TTL caching with LRU eviction, and deduplicates
 * concurrent in-flight fetches for the same certificate URL.
 */
export class CertificateManager {
  private readonly cache = new Map<string, CertCacheEntry>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly fetchTimeoutMs: number;
  private readonly customFetch: typeof fetch;

  constructor(config: CertificateManagerConfig = {}) {
    this.ttlMs = config.ttlMs ?? 24 * 60 * 60 * 1000; // 24 hours
    this.maxSize = Math.max(1, config.maxSize ?? 100);
    this.fetchTimeoutMs = config.fetchTimeoutMs ?? 10_000;
    this.customFetch = config.customFetch ?? globalThis.fetch;
  }

  /**
   * Validates that the provided certificate URL strictly conforms to PayPal's
   * API endpoints and HTTPS transport.
   *
   * @throws {UntrustedCertificateUrlError} if URL fails the hostname whitelist or structure.
   */
  public validateCertificateUrl(certUrl: string): boolean {
    if (!certUrl || typeof certUrl !== "string") {
      throw new UntrustedCertificateUrlError(String(certUrl), {
        reason: "Certificate URL must be a non-empty string",
      });
    }

    const trimmedUrl = certUrl.trim();
    if (!PAYPAL_CERT_URL_REGEX.test(trimmedUrl)) {
      throw new UntrustedCertificateUrlError(trimmedUrl, {
        reason: "URL does not match trusted PayPal pattern",
      });
    }

    let parsed: URL;
    try {
      parsed = new URL(trimmedUrl);
    } catch (err) {
      throw new UntrustedCertificateUrlError(trimmedUrl, {
        reason: "Malformed certificate URL",
        error: (err as Error).message,
      });
    }

    if (parsed.protocol !== "https:") {
      throw new UntrustedCertificateUrlError(trimmedUrl, {
        reason: "Certificate URL must use HTTPS",
      });
    }

    if (parsed.username || parsed.password) {
      throw new UntrustedCertificateUrlError(trimmedUrl, {
        reason: "Certificate URL must not contain user credentials",
      });
    }

    const hostname = parsed.hostname.toLowerCase();
    if (!TRUSTED_HOSTNAMES.has(hostname)) {
      throw new UntrustedCertificateUrlError(trimmedUrl, {
        reason: `Hostname "${hostname}" is not an authorized PayPal API endpoint`,
      });
    }

    if (parsed.port && parsed.port !== "443") {
      throw new UntrustedCertificateUrlError(trimmedUrl, {
        reason: `Non-standard port "${parsed.port}" is not permitted for PayPal certificates`,
      });
    }

    return true;
  }

  /**
   * Retrieves an X.509 certificate PEM string for the given URL, serving from
   * memory cache if unexpired, or fetching securely from PayPal.
   */
  public async getCertificate(certUrl: string): Promise<string> {
    this.validateCertificateUrl(certUrl);
    const normalizedUrl = certUrl.trim();

    const now = Date.now();
    const cached = this.cache.get(normalizedUrl);
    if (cached) {
      if (now < cached.expiresAt) {
        cached.lastAccessed = now;
        return cached.cert;
      }
      this.cache.delete(normalizedUrl);
    }

    const pending = this.inFlight.get(normalizedUrl);
    if (pending) {
      return pending;
    }

    const fetchPromise = this.fetchAndCache(normalizedUrl);
    this.inFlight.set(normalizedUrl, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.inFlight.delete(normalizedUrl);
    }
  }

  /**
   * Retrieves the public key object directly from the cached or fetched certificate.
   */
  public async getPublicKey(certUrl: string): Promise<crypto.KeyObject> {
    const certPem = await this.getCertificate(certUrl);
    try {
      return crypto.createPublicKey(certPem);
    } catch (err) {
      throw new WebhookVerificationError(
        `Failed to parse public key from PayPal certificate at "${certUrl}": ${(err as Error).message}`,
        { certUrl, originalError: (err as Error).message },
      );
    }
  }

  /**
   * Checks whether an unexpired certificate for `certUrl` is currently cached.
   */
  public has(certUrl: string): boolean {
    const entry = this.cache.get(certUrl);
    if (!entry) return false;
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(certUrl);
      return false;
    }
    return true;
  }

  /**
   * Returns the count of currently cached entries.
   */
  public get size(): number {
    return this.cache.size;
  }

  /**
   * Clears all cached certificates and cancels active state.
   */
  public clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  /**
   * Manually evicts expired certificates from the cache.
   */
  public evictExpired(): void {
    const now = Date.now();
    for (const [url, entry] of this.cache.entries()) {
      if (now >= entry.expiresAt) {
        this.cache.delete(url);
      }
    }
  }

  private async fetchAndCache(certUrl: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

    let res: Response;
    try {
      res = await this.customFetch(certUrl, {
        method: "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/x-pem-file, text/plain, */*",
        },
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new PayPalApiError(
          `Timed out fetching PayPal certificate after ${this.fetchTimeoutMs}ms: "${certUrl}"`,
          { httpStatus: 504, details: { certUrl } },
        );
      }
      throw new PayPalApiError(
        `Network error fetching PayPal certificate from "${certUrl}": ${(err as Error).message}`,
        { httpStatus: 502, details: { certUrl, originalError: (err as Error).message } },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new PayPalApiError(
        `PayPal certificate endpoint responded with HTTP ${res.status}: "${certUrl}"`,
        { httpStatus: res.status, details: { certUrl, statusText: res.statusText } },
      );
    }

    const certText = await res.text();
    if (
      !certText ||
      (!certText.includes("-----BEGIN CERTIFICATE-----") &&
        !certText.includes("-----BEGIN PUBLIC KEY-----"))
    ) {
      throw new WebhookVerificationError(
        `Certificate fetched from "${certUrl}" does not contain a valid PEM certificate header`,
        { certUrl, receivedPayload: certText.slice(0, 100) },
      );
    }

    this.ensureCapacity();
    const now = Date.now();
    this.cache.set(certUrl, {
      cert: certText,
      expiresAt: now + this.ttlMs,
      lastAccessed: now,
    });

    return certText;
  }

  private ensureCapacity(): void {
    this.evictExpired();
    if (this.cache.size < this.maxSize) {
      return;
    }

    // LRU eviction: remove entry with lowest lastAccessed
    let oldestUrl: string | undefined;
    let oldestTime = Infinity;

    for (const [url, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestUrl = url;
      }
    }

    if (oldestUrl) {
      this.cache.delete(oldestUrl);
    }
  }
}
