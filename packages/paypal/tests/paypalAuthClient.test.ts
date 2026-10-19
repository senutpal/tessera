import { UnauthorizedError } from "@tessera/core";
import { describe, expect, it, vi } from "vitest";
import { PayPalApiError, PayPalAuthClient, PayPalAuthError, PayPalTimeoutError } from "../index.js";

function createMockTokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    scope: "https://uri.paypal.com/services/payments/payment",
    access_token: "A21AAK_MOCK_ACCESS_TOKEN_ABC123",
    token_type: "Bearer",
    app_id: "APP-80W284485P519543T",
    expires_in: 32400,
    nonce: "2026-10-19T00:00:00Z",
    ...overrides,
  };
}

describe("PayPalAuthClient OAuth2 Engine", () => {
  it("acquires bearer token with basic auth and url-encoded client_credentials", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Headers | undefined;
    let capturedBody = "";

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedMethod = init?.method ?? "GET";
      capturedHeaders = new Headers(init?.headers);
      capturedBody = String(init?.body ?? "");

      return new Response(JSON.stringify(createMockTokenResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new PayPalAuthClient({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });

    const token = await client.getAccessToken();

    expect(token).toBe("A21AAK_MOCK_ACCESS_TOKEN_ABC123");
    expect(capturedUrl).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders?.get("Content-Type")).toBe("application/x-www-form-urlencoded");

    const expectedCredentials = Buffer.from("test-client-id:test-client-secret").toString("base64");
    expect(capturedHeaders?.get("Authorization")).toBe(`Basic ${expectedCredentials}`);

    const params = new URLSearchParams(capturedBody);
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("caches and reuses non-expired token without repeat HTTP round-trips", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify(createMockTokenResponse({ expires_in: 3600 })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new PayPalAuthClient({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });

    const token1 = await client.getAccessToken();
    const token2 = await client.getAccessToken();
    const token3 = await client.getAccessToken();

    expect(token1).toBe("A21AAK_MOCK_ACCESS_TOKEN_ABC123");
    expect(token2).toBe("A21AAK_MOCK_ACCESS_TOKEN_ABC123");
    expect(token3).toBe("A21AAK_MOCK_ACCESS_TOKEN_ABC123");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes transparently when cached token is expired or within renewal margin", async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount++;
      return new Response(
        JSON.stringify(
          createMockTokenResponse({
            access_token: `TOKEN_V${callCount}`,
            expires_in: callCount === 1 ? 50 : 3600, // 50s is within 60s margin
          }),
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    const client = new PayPalAuthClient({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      tokenRenewalMarginMs: 60_000,
      customFetch: mockFetch as unknown as typeof fetch,
    });

    const token1 = await client.getAccessToken();
    expect(token1).toBe("TOKEN_V1");

    // Next call triggers proactive renewal because 50s < 60s margin
    const token2 = await client.getAccessToken();
    expect(token2).toBe("TOKEN_V2");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent in-flight token requests", async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(
        JSON.stringify(createMockTokenResponse({ access_token: `TOKEN_CONCURRENT_${callCount}` })),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    const client = new PayPalAuthClient({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });

    const [t1, t2, t3] = await Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
    ]);

    expect(t1).toBe("TOKEN_CONCURRENT_1");
    expect(t2).toBe("TOKEN_CONCURRENT_1");
    expect(t3).toBe("TOKEN_CONCURRENT_1");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws UnauthorizedError when client credentials are invalid", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "invalid_client",
          error_description: "Client Authentication failed",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    const client = new PayPalAuthClient({
      clientId: "bad-id",
      clientSecret: "bad-secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });

    await expect(client.getAccessToken()).rejects.toThrow(UnauthorizedError);
  });

  it("throws PayPalApiError for non-401/403 HTTP errors on token endpoint preserving status and details", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "server_error",
          error_description: "PayPal Internal Server Error",
          debug_id: "dbg_token_500",
        }),
        {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    const client = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });

    const promise = client.getAccessToken();
    await expect(promise).rejects.toThrow(PayPalApiError);
    await expect(promise).rejects.toMatchObject({
      httpStatus: 500,
      code: "PAYPAL_API_ERROR",
      debugId: "dbg_token_500",
    });
  });

  it("handles fetchAuthenticated with automatic Bearer injection and 401 token refresh retry", async () => {
    let authAttempts = 0;
    let resourceAttempts = 0;

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        authAttempts++;
        return new Response(
          JSON.stringify(createMockTokenResponse({ access_token: `BEARER_${authAttempts}` })),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (urlStr.includes("/v2/checkout/orders")) {
        resourceAttempts++;
        const headers = new Headers(init?.headers);
        const token = headers.get("Authorization");

        if (token === "Bearer BEARER_1") {
          // Simulate expired token resulting in 401
          return new Response(
            JSON.stringify({
              name: "AUTHENTICATION_FAILURE",
              message: "Token expired",
            }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }

        // Retry with BEARER_2 succeeds
        return new Response(JSON.stringify({ id: "ORDER_OK", status: "CREATED" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      throw new Error(`Unhandled URL: ${urlStr}`);
    });

    const client = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });

    const res = await client.fetchAuthenticated("/v2/checkout/orders");
    const json = await res.json();

    expect(json.id).toBe("ORDER_OK");
    expect(authAttempts).toBe(2);
    expect(resourceAttempts).toBe(2);
  });

  it("aborts when request times out", async () => {
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }
      });
    });

    const client = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      timeoutMs: 30,
      customFetch: mockFetch as unknown as typeof fetch,
    });

    await expect(client.getAccessToken()).rejects.toThrow(PayPalTimeoutError);
  });

  it("rethrows caller cancellation without converting to PayPalTimeoutError and cleans up listener", async () => {
    const callerController = new AbortController();

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }

      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Caller aborted request", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new DOMException("Caller aborted request", "AbortError"));
        });
      });
    });

    const client = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      timeoutMs: 10_000,
      customFetch: mockFetch as unknown as typeof fetch,
    });

    // Populate token first
    await client.getAccessToken();

    const fetchPromise = client.fetchAuthenticated("/v2/checkout/orders", {
      signal: callerController.signal,
    });

    // Cancel from caller side
    callerController.abort();

    await expect(fetchPromise).rejects.toThrow("Caller aborted request");
    await expect(fetchPromise).rejects.not.toThrow(PayPalTimeoutError);
  });

  it("supports clearing cached token explicitly", async () => {
    let count = 0;
    const mockFetch = vi.fn(async () => {
      count++;
      return new Response(
        JSON.stringify(createMockTokenResponse({ access_token: `TOKEN_${count}` })),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });

    const t1 = await client.getAccessToken();
    expect(t1).toBe("TOKEN_1");

    client.clearToken();

    const t2 = await client.getAccessToken();
    expect(t2).toBe("TOKEN_2");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws PayPalAuthError when clientId or clientSecret are missing", () => {
    expect(() => new PayPalAuthClient({ clientId: "", clientSecret: "secret" })).toThrow(
      PayPalAuthError,
    );
    expect(() => new PayPalAuthClient({ clientId: "id", clientSecret: "" })).toThrow(
      PayPalAuthError,
    );
  });

  it("deduplicates token refresh when concurrent requests encounter 401", async () => {
    let tokenFetches = 0;
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        tokenFetches++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(
          JSON.stringify(createMockTokenResponse({ access_token: `TOKEN_${tokenFetches}` })),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      const headers = new Headers(init?.headers);
      const authHeader = headers.get("Authorization");
      if (authHeader === "Bearer TOKEN_1") {
        return new Response(JSON.stringify({ message: "Revoked" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true, tokenUsed: authHeader }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new PayPalAuthClient({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });

    // Initial token
    await client.getAccessToken();
    expect(tokenFetches).toBe(1);

    // Concurrent requests all receiving 401 on expired/revoked TOKEN_1
    const results = await Promise.all([
      client.fetchAuthenticated("/resource-1"),
      client.fetchAuthenticated("/resource-2"),
      client.fetchAuthenticated("/resource-3"),
    ]);

    for (const res of results) {
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean; tokenUsed: string };
      expect(data.ok).toBe(true);
      expect(data.tokenUsed).toBe("Bearer TOKEN_2");
    }

    // Only one new token request was executed across the concurrent 401s
    expect(tokenFetches).toBe(2);
  });
});
