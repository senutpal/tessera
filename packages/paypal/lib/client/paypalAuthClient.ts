import { UnauthorizedError } from "@tessera/core";
import {
  PayPalApiError,
  PayPalAuthError,
  type PayPalConfig,
  PayPalOAuthTokenSchema,
  PayPalTimeoutError,
} from "../types/orders.js";

const DEFAULT_SANDBOX_URL = "https://api-m.sandbox.paypal.com";
const DEFAULT_PRODUCTION_URL = "https://api-m.paypal.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RENEWAL_MARGIN_MS = 60_000;

interface CachedToken {
  accessToken: string;
  tokenType: string;
  expiresAt: number;
}

export class PayPalAuthClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly tokenRenewalMarginMs: number;

  private cachedToken: CachedToken | null = null;
  private inFlightTokenPromise: Promise<string> | null = null;

  constructor(config: PayPalConfig) {
    if (!config.clientId || !config.clientSecret) {
      throw new PayPalAuthError("PayPal credentials (clientId, clientSecret) are required.");
    }
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;

    if (config.baseUrl) {
      this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    } else if (config.environment === "production") {
      this.baseUrl = DEFAULT_PRODUCTION_URL;
    } else {
      this.baseUrl = DEFAULT_SANDBOX_URL;
    }

    this.fetchFn = config.customFetch ?? globalThis.fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.tokenRenewalMarginMs = config.tokenRenewalMarginMs ?? DEFAULT_RENEWAL_MARGIN_MS;
  }

  /**
   * Returns a valid OAuth2 Bearer token, reusing the cached token or refreshing if expired.
   */
  public async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt - now > this.tokenRenewalMarginMs) {
      return this.cachedToken.accessToken;
    }

    if (this.inFlightTokenPromise) {
      return this.inFlightTokenPromise;
    }

    const p = this.requestNewToken().finally(() => {
      if (this.inFlightTokenPromise === p) {
        this.inFlightTokenPromise = null;
      }
    });
    this.inFlightTokenPromise = p;

    return this.inFlightTokenPromise;
  }

  /**
   * Clears the cached token.
   */
  public clearToken(): void {
    this.cachedToken = null;
    this.inFlightTokenPromise = null;
  }

  /**
   * Returns configured base URL.
   */
  public getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Executes an authenticated HTTP request with automatic Bearer token injection
   * and single-retry transparent recovery if 401 is encountered.
   */
  public async fetchAuthenticated(pathOrUrl: string, init?: RequestInit): Promise<Response> {
    const token = await this.getAccessToken();
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;

    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);

    const res = await this.executeFetch(url, { ...init, headers });

    // If 401 unauthorized, token may have been revoked on the server; clear and retry once
    if (res.status === 401) {
      if (this.cachedToken?.accessToken === token) {
        this.cachedToken = null;
      }
      const freshToken = await this.getAccessToken();
      const retryHeaders = new Headers(init?.headers);
      retryHeaders.set("Authorization", `Bearer ${freshToken}`);
      return this.executeFetch(url, { ...init, headers: retryHeaders });
    }

    return res;
  }

  private async requestNewToken(): Promise<string> {
    const url = `${this.baseUrl}/v1/oauth2/token`;
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");

    const headers = new Headers();
    headers.set("Authorization", `Basic ${basicAuth}`);
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    headers.set("Accept", "application/json");

    const body = new URLSearchParams({ grant_type: "client_credentials" });

    const res = await this.executeFetch(url, {
      method: "POST",
      headers,
      body: body.toString(),
    });

    if (!res.ok) {
      const errorText = await res.text();
      let errorDetails: Record<string, unknown> = {};
      try {
        errorDetails = JSON.parse(errorText) as Record<string, unknown>;
      } catch {
        errorDetails = { rawBody: errorText };
      }

      if (res.status === 401 || res.status === 403) {
        throw new UnauthorizedError("PayPal authentication failed: invalid client credentials", {
          httpStatus: res.status,
          ...errorDetails,
        });
      }

      const debugId = typeof errorDetails.debug_id === "string" ? errorDetails.debug_id : undefined;
      const errorName = typeof errorDetails.name === "string" ? errorDetails.name : undefined;

      throw new PayPalApiError(
        `Failed to acquire PayPal OAuth token (HTTP ${res.status}): ${res.statusText}`,
        {
          httpStatus: res.status,
          debugId,
          paypalErrorName: errorName,
          details: errorDetails,
        },
      );
    }

    const json = await res.json();
    const parseResult = PayPalOAuthTokenSchema.safeParse(json);
    if (!parseResult.success) {
      throw new UnauthorizedError("PayPal token response violates expected OAuth schema", {
        validationErrors: parseResult.error.format(),
      });
    }

    const { access_token, expires_in, token_type } = parseResult.data;
    const expiresAt = Date.now() + expires_in * 1000;

    this.cachedToken = {
      accessToken: access_token,
      tokenType: token_type,
      expiresAt,
    };

    return access_token;
  }

  private async executeFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    const signal: AbortSignal = controller.signal;
    if (init.signal) {
      const outerSignal = init.signal;
      if (outerSignal.aborted) {
        clearTimeout(timeout);
        controller.abort();
      } else {
        outerSignal.addEventListener("abort", () => {
          clearTimeout(timeout);
          controller.abort();
        });
      }
    }

    try {
      const response = await this.fetchFn(url, {
        ...init,
        signal,
      });
      return response;
    } catch (err: unknown) {
      if (
        (err instanceof DOMException && err.name === "AbortError") ||
        (err as Error)?.name === "AbortError"
      ) {
        throw new PayPalTimeoutError(
          `PayPal request to ${url} timed out after ${this.timeoutMs}ms`,
          { url, timeoutMs: this.timeoutMs },
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
