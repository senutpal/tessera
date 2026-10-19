import * as crypto from "node:crypto";
import * as zlib from "node:zlib";
import type { PayPalClient } from "../client/paypalClient.js";
import {
  extractWebhookHeaders,
  type PayPalVerifyWebhookSignatureRequest,
  type PayPalWebhookHeaders,
  UntrustedCertificateUrlError,
  WebhookVerificationError,
  type WebhookVerificationOptions,
  type WebhookVerificationResult,
} from "../types/webhooks.js";
import { CertificateManager } from "./certificateManager.js";
import {
  InMemoryWebhookIdempotencyStore,
  type IWebhookIdempotencyStore,
} from "./idempotencyStore.js";

const ALGORITHM_MAP: Record<string, string> = {
  SHA256withRSA: "RSA-SHA256",
  SHA1withRSA: "RSA-SHA1",
  SHA384withRSA: "RSA-SHA384",
  SHA512withRSA: "RSA-SHA512",
};

/**
 * Computes the IEEE 802.3 CRC32 checksum over raw payload bytes,
 * formatted as an unsigned 32-bit base-10 decimal integer string.
 */
export function computeCrc32(rawBody: Buffer | Uint8Array | string): string {
  if (rawBody === null || rawBody === undefined) {
    throw new WebhookVerificationError("rawBody cannot be null or undefined for CRC32 computation");
  }
  const buf = Buffer.isBuffer(rawBody)
    ? rawBody
    : typeof rawBody === "string"
      ? Buffer.from(rawBody, "utf8")
      : Buffer.from(rawBody);
  const crc = zlib.crc32(buf) >>> 0;
  return crc.toString(10);
}

/**
 * Computes the IEEE 802.3 CRC32 checksum over raw payload bytes
 * formatted as a lowercase hexadecimal string.
 */
export function computeCrc32Hex(rawBody: Buffer | Uint8Array | string): string {
  if (rawBody === null || rawBody === undefined) {
    throw new WebhookVerificationError("rawBody cannot be null or undefined for CRC32 computation");
  }
  const buf = Buffer.isBuffer(rawBody)
    ? rawBody
    : typeof rawBody === "string"
      ? Buffer.from(rawBody, "utf8")
      : Buffer.from(rawBody);
  const crc = zlib.crc32(buf) >>> 0;
  return crc.toString(16);
}

/**
 * Constructs the PayPal webhook verification signature payload:
 * `<transmission_id>|<timestamp>|<webhook_id>|<crc32>`
 */
export function buildVerificationMessage(
  transmissionId: string,
  timestamp: string,
  webhookId: string,
  crc32: string,
): string {
  return `${transmissionId}|${timestamp}|${webhookId}|${crc32}`;
}

export const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes default clock skew bound

export interface WebhookSignatureVerifierConfig {
  certificateManager?: CertificateManager | undefined;
  idempotencyStore?: IWebhookIdempotencyStore | undefined;
  payPalClient?: PayPalClient | undefined;
  defaultWebhookId?: string | undefined;
  maxClockSkewMs?: number | undefined;
  fallbackToRemote?: boolean | undefined;
}

export interface VerifyWebhookParams {
  headers: Record<string, string | string[] | undefined> | Headers | PayPalWebhookHeaders;
  rawBody: Buffer | Uint8Array | string;
  webhookId?: string | undefined;
  options?: WebhookVerificationOptions | undefined;
}

/**
 * High-performance, secure PayPal Webhook Signature Verifier.
 *
 * Performs local cryptographic verification using raw-buffer CRC32 and RSA
 * asymmetric public key validation against whitelisted X.509 certificates.
 * Features automatic 24-hour replay protection via transmission ID caching
 * and optional remote fallback to PayPal's `/v1/notifications/verify-webhook-signature` API.
 */
export class WebhookSignatureVerifier {
  public readonly certificateManager: CertificateManager;
  public readonly idempotencyStore: IWebhookIdempotencyStore;
  private readonly payPalClient?: PayPalClient | undefined;
  private readonly defaultWebhookId?: string | undefined;
  private readonly maxClockSkewMs: number;
  private readonly fallbackToRemote: boolean;

  constructor(config: WebhookSignatureVerifierConfig = {}) {
    this.certificateManager = config.certificateManager ?? new CertificateManager();
    this.idempotencyStore = config.idempotencyStore ?? new InMemoryWebhookIdempotencyStore();
    this.payPalClient = config.payPalClient;
    this.defaultWebhookId = config.defaultWebhookId;
    this.maxClockSkewMs = config.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
    this.fallbackToRemote = config.fallbackToRemote ?? false;
  }

  /**
   * Verifies the authenticity of an incoming PayPal webhook notification.
   */
  public async verify(params: VerifyWebhookParams): Promise<WebhookVerificationResult> {
    if (!params || typeof params !== "object") {
      throw new WebhookVerificationError("VerifyWebhookParams must be a non-null object");
    }

    if (params.rawBody === null || params.rawBody === undefined) {
      throw new WebhookVerificationError(
        "Webhook rawBody is required and cannot be null or undefined",
      );
    }

    const headers = extractWebhookHeaders(params.headers);
    const webhookId = params.webhookId ?? params.options?.webhookId ?? this.defaultWebhookId;

    if (!webhookId) {
      throw new WebhookVerificationError(
        "Webhook ID must be provided either in verifier configuration or per-verification call.",
      );
    }

    // Always validate certUrl against whitelist before any local or remote processing
    this.certificateManager.validateCertificateUrl(headers.certUrl);

    // Clock skew validation
    const maxClockSkewMs = params.options?.maxClockSkewMs ?? this.maxClockSkewMs;
    if (maxClockSkewMs !== undefined && maxClockSkewMs > 0) {
      const txTime = Date.parse(headers.transmissionTime);
      if (Number.isNaN(txTime)) {
        return {
          isValid: false,
          isDuplicate: false,
          method: "LOCAL_ASYMMETRIC",
          transmissionId: headers.transmissionId,
          algorithm: headers.authAlgo,
          certUrl: headers.certUrl,
          failureReason: "Malformed transmission timestamp",
        };
      }
      if (Math.abs(Date.now() - txTime) > maxClockSkewMs) {
        return {
          isValid: false,
          isDuplicate: false,
          method: "LOCAL_ASYMMETRIC",
          transmissionId: headers.transmissionId,
          algorithm: headers.authAlgo,
          certUrl: headers.certUrl,
          failureReason: `Transmission time "${headers.transmissionTime}" exceeds maximum allowable clock skew of ${maxClockSkewMs}ms`,
        };
      }
    }

    const shouldCheckReplay = params.options?.checkReplay ?? true;

    let localCheckPassed = false;
    let localError: Error | null = null;

    try {
      localCheckPassed = await this.verifyLocally(headers, params.rawBody, webhookId);
    } catch (err) {
      if (err instanceof UntrustedCertificateUrlError) {
        throw err;
      }
      localError = err as Error;
      localCheckPassed = false;
    }

    if (localCheckPassed) {
      if (shouldCheckReplay) {
        const isNewlyRecorded = await this.idempotencyStore.record(headers.transmissionId);
        if (!isNewlyRecorded) {
          return {
            isValid: true,
            isDuplicate: true,
            method: "LOCAL_ASYMMETRIC",
            transmissionId: headers.transmissionId,
            algorithm: headers.authAlgo,
            certUrl: headers.certUrl,
            failureReason: "Duplicate transmission ID detected within replay window",
          };
        }
      }
      return {
        isValid: true,
        isDuplicate: false,
        method: "LOCAL_ASYMMETRIC",
        transmissionId: headers.transmissionId,
        algorithm: headers.authAlgo,
        certUrl: headers.certUrl,
      };
    }

    // Remote fallback gate
    const shouldFallback = params.options?.fallbackToRemote ?? this.fallbackToRemote;
    if (shouldFallback && this.payPalClient) {
      try {
        const remoteValid = await this.verifyRemotely(headers, params.rawBody, webhookId);
        if (remoteValid) {
          if (shouldCheckReplay) {
            const isNewlyRecorded = await this.idempotencyStore.record(headers.transmissionId);
            if (!isNewlyRecorded) {
              return {
                isValid: true,
                isDuplicate: true,
                method: "REMOTE_POSTBACK",
                transmissionId: headers.transmissionId,
                algorithm: headers.authAlgo,
                certUrl: headers.certUrl,
                failureReason: "Duplicate transmission ID detected within replay window",
              };
            }
          }
          return {
            isValid: true,
            isDuplicate: false,
            method: "REMOTE_POSTBACK",
            transmissionId: headers.transmissionId,
            algorithm: headers.authAlgo,
            certUrl: headers.certUrl,
          };
        }
        return {
          isValid: false,
          isDuplicate: false,
          method: "REMOTE_POSTBACK",
          transmissionId: headers.transmissionId,
          algorithm: headers.authAlgo,
          certUrl: headers.certUrl,
          failureReason: "Remote signature verification rejected by PayPal API",
        };
      } catch (remoteErr) {
        return {
          isValid: false,
          isDuplicate: false,
          method: "REMOTE_POSTBACK",
          transmissionId: headers.transmissionId,
          algorithm: headers.authAlgo,
          certUrl: headers.certUrl,
          failureReason: `Remote signature verification failed: ${(remoteErr as Error).message}`,
        };
      }
    }

    return {
      isValid: false,
      isDuplicate: false,
      method: "LOCAL_ASYMMETRIC",
      transmissionId: headers.transmissionId,
      algorithm: headers.authAlgo,
      certUrl: headers.certUrl,
      failureReason: localError
        ? `Local verification error: ${localError.message}`
        : "Cryptographic signature mismatch",
    };
  }

  private async verifyLocally(
    headers: PayPalWebhookHeaders,
    rawBody: Buffer | Uint8Array | string,
    webhookId: string,
  ): Promise<boolean> {
    const nodeAlgo = ALGORITHM_MAP[headers.authAlgo];
    if (!nodeAlgo) {
      throw new WebhookVerificationError(
        `Unsupported PayPal auth algorithm: "${headers.authAlgo}". Expected one of: ${Object.keys(ALGORITHM_MAP).join(", ")}`,
      );
    }

    const certPem = await this.certificateManager.getCertificate(headers.certUrl);
    const sigBuffer = Buffer.from(headers.transmissionSig, "base64");
    if (sigBuffer.length === 0) {
      return false;
    }

    // Decimal representation of CRC32 (as specified by PayPal documentation)
    const crcDecimal = computeCrc32(rawBody);
    const decimalMessage = buildVerificationMessage(
      headers.transmissionId,
      headers.transmissionTime,
      webhookId,
      crcDecimal,
    );

    const verifier = crypto.createVerify(nodeAlgo);
    verifier.update(decimalMessage, "utf8");
    return verifier.verify(certPem, sigBuffer);
  }

  private async verifyRemotely(
    headers: PayPalWebhookHeaders,
    rawBody: Buffer | Uint8Array | string,
    webhookId: string,
  ): Promise<boolean> {
    if (!this.payPalClient) {
      return false;
    }

    const rawString = Buffer.isBuffer(rawBody)
      ? rawBody.toString("utf8")
      : typeof rawBody === "string"
        ? rawBody
        : Buffer.from(rawBody).toString("utf8");

    let eventPayload: Record<string, unknown>;
    try {
      eventPayload = JSON.parse(rawString);
    } catch (err) {
      throw new WebhookVerificationError(
        `Cannot execute remote fallback: rawBody is not valid JSON (${(err as Error).message})`,
      );
    }

    const requestPayload: PayPalVerifyWebhookSignatureRequest = {
      auth_algo: headers.authAlgo,
      cert_url: headers.certUrl,
      transmission_id: headers.transmissionId,
      transmission_sig: headers.transmissionSig,
      transmission_time: headers.transmissionTime,
      webhook_id: webhookId,
      webhook_event: eventPayload,
    };

    return this.payPalClient.verifyWebhookSignature(requestPayload);
  }
}
