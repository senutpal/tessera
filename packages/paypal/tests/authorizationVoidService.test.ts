import {
  asAuthorizationId,
  asOrderId,
  ConflictError,
  EscrowVoidError,
  Money,
  NotFoundError,
} from "@tessera/core";
import { describe, expect, it, vi } from "vitest";
import {
  AuthorizationVoidService,
  type EscrowEventSink,
  type EscrowHoldVoidedEvent,
  PayPalAuthClient,
  PayPalClient,
} from "../index.js";

function createMockTokenResponse() {
  return {
    access_token: "MOCK_TOKEN_VOID",
    token_type: "Bearer",
    expires_in: 3600,
  };
}

function createMockVoidResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "0VF52814937998046",
    status: "VOIDED",
    amount: {
      currency_code: "USD",
      value: "249.99",
    },
    expiration_time: "2026-11-17T12:00:00Z",
    create_time: "2026-10-19T12:00:00Z",
    update_time: "2026-10-19T12:05:00Z",
    links: [
      {
        href: "https://api-m.sandbox.paypal.com/v2/payments/authorizations/0VF52814937998046",
        rel: "self",
        method: "GET",
      },
    ],
    ...overrides,
  };
}

describe("AuthorizationVoidService (Escrow Release/Void Engine)", () => {
  it("dispatches POST /v2/payments/authorizations/{id}/void and confirms VOIDED status (200 response)", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Headers | undefined;

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }

      capturedUrl = urlStr;
      capturedMethod = init?.method ?? "";
      capturedHeaders = new Headers(init?.headers);

      return new Response(JSON.stringify(createMockVoidResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const emittedEvents: EscrowHoldVoidedEvent[] = [];
    const mockEventSink: EscrowEventSink = {
      emit: (event) => {
        emittedEvents.push(event);
      },
    };

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const voidService = new AuthorizationVoidService(auth, {
      eventSink: mockEventSink,
    });

    const result = await voidService.voidAuthorization({
      authorizationId: "0VF52814937998046",
      requestId: "void-req-123",
      reason: "Mandate budget exceeded",
      orderId: "ORDER-456",
      amount: Money.fromCents(24999, "USD"),
    });

    expect(capturedUrl).toBe(
      "https://api-m.sandbox.paypal.com/v2/payments/authorizations/0VF52814937998046/void",
    );
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders?.get("PayPal-Request-Id")).toBe("void-req-123");
    expect(capturedHeaders?.get("Prefer")).toBe("return=representation");

    expect(result.authorizationId).toBe("0VF52814937998046");
    expect(result.status).toBe("VOIDED");
    expect(result.reason).toBe("Mandate budget exceeded");

    // Confirms event dispatch
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]?.type).toBe("ESCROW_HOLD_VOIDED");
    expect(emittedEvents[0]?.authorizationId).toBe("0VF52814937998046");
    expect(emittedEvents[0]?.orderId).toBe("ORDER-456");
    expect(emittedEvents[0]?.amount?.toDecimalString()).toBe("249.99");
    expect(emittedEvents[0]?.reason).toBe("Mandate budget exceeded");
  });

  it("handles HTTP 204 No Content response as successful void", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }

      return new Response(null, { status: 204 });
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const voidService = new AuthorizationVoidService(auth);

    const result = await voidService.voidAuthorization({
      authorizationId: "0VF52814937998046",
    });

    expect(result.status).toBe("VOIDED");
    expect(result.authorizationId).toBe("0VF52814937998046");
  });

  it("maps 404 response to NotFoundError", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          name: "RESOURCE_NOT_FOUND",
          message: "The specified authorization does not exist.",
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const voidService = new AuthorizationVoidService(auth);

    await expect(
      voidService.voidAuthorization({ authorizationId: "NON_EXISTENT_AUTH" }),
    ).rejects.toThrow(NotFoundError);
  });

  it("maps 409 Conflict response to ConflictError / EscrowVoidError", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          name: "PREVIOUS_REQUEST_IN_PROGRESS",
          message: "A previous call for the given resource is in progress.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const voidService = new AuthorizationVoidService(auth);

    await expect(
      voidService.voidAuthorization({ authorizationId: "AUTH_CONFLICT" }),
    ).rejects.toThrow(ConflictError);
  });

  it("voids through unified PayPalClient facade and emits event to configured sink", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }
      return new Response(JSON.stringify(createMockVoidResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const events: EscrowHoldVoidedEvent[] = [];
    const client = new PayPalClient(
      {
        clientId: "client-id",
        clientSecret: "client-secret",
        customFetch: mockFetch as unknown as typeof fetch,
      },
      {
        eventSink: {
          emit: (event) => {
            events.push(event);
          },
        },
      },
    );

    const result = await client.voidAuthorization({
      authorizationId: asAuthorizationId("0VF52814937998046"),
      orderId: asOrderId("ORDER-001"),
      amount: Money.fromCents(24999, "USD"),
      reason: "SLA timeout breached",
    });

    expect(result.status).toBe("VOIDED");
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("SLA timeout breached");
  });

  it("maps 422 Unprocessable to EscrowVoidError", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          name: "UNPROCESSABLE_ENTITY",
          message: "Authorization cannot be voided.",
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      );
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const voidService = new AuthorizationVoidService(auth);

    await expect(
      voidService.voidAuthorization({ authorizationId: "AUTH_UNPROCESSABLE" }),
    ).rejects.toThrow(EscrowVoidError);
  });
});
