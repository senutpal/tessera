import {
  ConflictError,
  EscrowAuthorizationError,
  MandateValidationError,
  Money,
  NotFoundError,
  UnauthorizedError,
} from "@tessera/core";
import { describe, expect, it, vi } from "vitest";
import { OrdersEscrowService, PayPalAuthClient, PayPalClient } from "../index.js";

function createMockOrderResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "4SP74185RW2405200",
    status: "CREATED",
    intent: "AUTHORIZE",
    purchase_units: [
      {
        reference_id: "unit-001",
        amount: {
          currency_code: "USD",
          value: "249.99",
        },
        description: "Autonomous procurement escrow item",
      },
    ],
    links: [
      {
        href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/4SP74185RW2405200",
        rel: "self",
        method: "GET",
      },
      {
        href: "https://www.sandbox.paypal.com/checkoutnow?token=4SP74185RW2405200",
        rel: "approve",
        method: "GET",
      },
      {
        href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/4SP74185RW2405200/authorize",
        rel: "authorize",
        method: "POST",
      },
    ],
    ...overrides,
  };
}

function createMockAuthorizeResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "4SP74185RW2405200",
    status: "COMPLETED",
    payment_source: {
      paypal: {
        account_id: "BUYER_TEST_123",
      },
    },
    purchase_units: [
      {
        reference_id: "unit-001",
        custom_id: undefined as string | undefined,
        payments: {
          authorizations: [
            {
              id: "0AW2184448108334S",
              status: "CREATED",
              amount: {
                currency_code: "USD",
                value: "249.99",
              },
              seller_protection: {
                status: "ELIGIBLE",
                dispute_categories: ["ITEM_NOT_RECEIVED", "UNAUTHORIZED_TRANSACTION"],
              },
              expiration_time: "2026-11-17T12:00:00Z",
              create_time: "2026-10-19T12:00:00Z",
              update_time: "2026-10-19T12:00:00Z",
              links: [
                {
                  href: "https://api-m.sandbox.paypal.com/v2/payments/authorizations/0AW2184448108334S",
                  rel: "self",
                  method: "GET",
                },
                {
                  href: "https://api-m.sandbox.paypal.com/v2/payments/authorizations/0AW2184448108334S/capture",
                  rel: "capture",
                  method: "POST",
                },
                {
                  href: "https://api-m.sandbox.paypal.com/v2/payments/authorizations/0AW2184448108334S/void",
                  rel: "void",
                  method: "POST",
                },
              ],
            },
          ],
        },
      },
    ],
    ...overrides,
  };
}

function createMockTokenResponse() {
  return {
    access_token: "MOCK_TOKEN_ORDERS",
    token_type: "Bearer",
    expires_in: 3600,
  };
}

interface CapturedOrderPayload {
  intent?: string;
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    invoice_id?: string;
    amount: {
      currency_code: string;
      value: string;
      breakdown?: {
        item_total?: {
          currency_code: string;
          value: string;
        };
      };
    };
    items?: Array<{
      name: string;
      quantity: string;
      unit_amount: {
        currency_code: string;
        value: string;
      };
    }>;
  }>;
}

describe("OrdersEscrowService (Orders v2 Authorize Engine)", () => {
  it("creates escrow order with intent: AUTHORIZE, 2-decimal money format, and idempotency header", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Headers | undefined;
    let capturedBody: CapturedOrderPayload | undefined;

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      capturedUrl = urlStr;
      capturedMethod = init?.method ?? "";
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body ?? "{}"));

      return new Response(JSON.stringify(createMockOrderResponse()), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    const money = Money.fromMinorUnits(24999, "USD"); // $249.99
    const order = await service.createEscrowOrder({
      amount: money,
      referenceId: "unit-001",
      description: "Autonomous procurement escrow item",
      requestId: "custom-idempotency-key-001",
    });

    expect(capturedUrl).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders");
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders?.get("PayPal-Request-Id")).toBe("custom-idempotency-key-001");
    expect(capturedHeaders?.get("Prefer")).toBe("return=representation");

    expect(capturedBody).toBeDefined();
    expect(capturedBody?.intent).toBe("AUTHORIZE");
    expect(capturedBody?.purchase_units).toHaveLength(1);
    expect(capturedBody?.purchase_units?.[0]?.amount.currency_code).toBe("USD");
    expect(capturedBody?.purchase_units?.[0]?.amount.value).toBe("249.99");
    expect(capturedBody?.purchase_units?.[0]?.reference_id).toBe("unit-001");

    expect(order.orderId).toBe("4SP74185RW2405200");
    expect(order.status).toBe("CREATED");
    expect(order.amount.toDecimalString()).toBe("249.99");
    expect(order.links.some((l) => l.rel === "approve")).toBe(true);
  });

  it("supports order creation with detailed line items and validates breakdown", async () => {
    let capturedBody: CapturedOrderPayload | undefined;
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify(createMockOrderResponse()), { status: 201 });
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    const item1Price = Money.fromCents(2000, "USD");
    const item2Price = Money.fromCents(22999, "USD");
    const total = item1Price.add(item2Price);

    await service.createEscrowOrder({
      amount: total,
      items: [
        {
          name: "Item 1",
          quantity: 1,
          unitAmount: item1Price,
          sku: "SKU-1",
          category: "PHYSICAL_GOODS",
        },
        {
          name: "Item 2",
          quantity: 1,
          unitAmount: item2Price,
          sku: "SKU-2",
          category: "PHYSICAL_GOODS",
        },
      ],
      customId: "TESSERA-TXN-999",
      invoiceId: "INV-999",
    });

    expect(capturedBody).toBeDefined();
    expect(capturedBody?.purchase_units?.[0]?.items).toHaveLength(2);
    expect(capturedBody?.purchase_units?.[0]?.items?.[0]?.unit_amount.value).toBe("20.00");
    expect(capturedBody?.purchase_units?.[0]?.items?.[0]?.quantity).toBe("1");
    expect(capturedBody?.purchase_units?.[0]?.items?.[1]?.unit_amount.value).toBe("229.99");
    expect(capturedBody?.purchase_units?.[0]?.amount.breakdown?.item_total?.value).toBe("249.99");
    expect(capturedBody?.purchase_units?.[0]?.custom_id).toBe("TESSERA-TXN-999");
    expect(capturedBody?.purchase_units?.[0]?.invoice_id).toBe("INV-999");
  });

  it("executes authorization hold via POST /v2/checkout/orders/{id}/authorize and extracts authorization_id", async () => {
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

      return new Response(JSON.stringify(createMockAuthorizeResponse()), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    const authorization = await service.authorizeOrder({
      orderId: "4SP74185RW2405200",
      requestId: "auth-request-key-999",
    });

    expect(capturedUrl).toBe(
      "https://api-m.sandbox.paypal.com/v2/checkout/orders/4SP74185RW2405200/authorize",
    );
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders?.get("PayPal-Request-Id")).toBe("auth-request-key-999");

    expect(authorization.authorizationId).toBe("0AW2184448108334S");
    expect(authorization.orderId).toBe("4SP74185RW2405200");
    expect(authorization.status).toBe("CREATED");
    expect(authorization.amount.toDecimalString()).toBe("249.99");
    expect(authorization.expirationTime).toBe("2026-11-17T12:00:00Z");
  });

  it("retrieves order state via getOrder", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }
      return new Response(JSON.stringify(createMockOrderResponse({ status: "APPROVED" })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    const order = await service.getOrder("4SP74185RW2405200");
    expect(order.orderId).toBe("4SP74185RW2405200");
    expect(order.status).toBe("APPROVED");
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
          message: "The specified resource does not exist.",
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    await expect(service.getOrder("NON_EXISTENT_ORDER")).rejects.toThrow(NotFoundError);
  });

  it("maps 422 PAYMENT_DENIED to EscrowAuthorizationError", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed.",
          details: [
            {
              issue: "PAYMENT_DENIED",
              description: "The payment was denied by PayPal.",
            },
          ],
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      );
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    await expect(service.authorizeOrder({ orderId: "DENIED_ORDER_ID" })).rejects.toThrow(
      EscrowAuthorizationError,
    );
  });

  it("integrates seamlessly through PayPalClient unified facade", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }
      if (urlStr.endsWith("/authorize")) {
        return new Response(JSON.stringify(createMockAuthorizeResponse()), {
          status: 201,
        });
      }
      return new Response(JSON.stringify(createMockOrderResponse()), { status: 201 });
    });

    const client = new PayPalClient({
      clientId: "facade-client-id",
      clientSecret: "facade-secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });

    const order = await client.createEscrowOrder({
      amount: Money.fromCents(10000, "USD"),
      referenceId: "ref-facade",
    });
    expect(order.orderId).toBe("4SP74185RW2405200");

    const auth = await client.authorizeOrder({ orderId: order.orderId });
    expect(auth.authorizationId).toBe("0AW2184448108334S");
  });

  it("maps 409 Conflict to ConflictError", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          name: "ORDER_ALREADY_CAPTURED",
          message: "Order has already been captured.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    await expect(service.authorizeOrder({ orderId: "ALREADY_DONE" })).rejects.toThrow(
      ConflictError,
    );
  });

  it("maps 401 Unauthorized during order creation to UnauthorizedError", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          name: "AUTHENTICATION_FAILURE",
          message: "Caller is not authorized.",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    await expect(
      service.createEscrowOrder({
        amount: Money.fromCents(5000, "USD"),
      }),
    ).rejects.toThrow(UnauthorizedError);
  });

  it("throws MandateValidationError when item sum does not equal order total amount", async () => {
    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: vi.fn() as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    await expect(
      service.createEscrowOrder({
        amount: Money.fromCents(5000, "USD"), // $50.00
        items: [
          {
            name: "Item A",
            quantity: 1,
            unitAmount: Money.fromCents(4000, "USD"), // $40.00 != $50.00
          },
        ],
      }),
    ).rejects.toThrow(MandateValidationError);
  });

  it("throws MandateValidationError when item quantity is not a valid positive integer string", async () => {
    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: vi.fn() as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    await expect(
      service.createEscrowOrder({
        amount: Money.fromCents(5000, "USD"),
        items: [
          {
            name: "Item Decimal Qty",
            quantity: "2.5",
            unitAmount: Money.fromCents(2000, "USD"),
          },
        ],
      }),
    ).rejects.toThrow(MandateValidationError);

    await expect(
      service.createEscrowOrder({
        amount: Money.fromCents(5000, "USD"),
        items: [
          {
            name: "Item Non-numeric",
            quantity: "10abc",
            unitAmount: Money.fromCents(500, "USD"),
          },
        ],
      }),
    ).rejects.toThrow(MandateValidationError);
  });

  it("throws MandateValidationError when item unit amount is zero or negative", async () => {
    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: vi.fn() as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    await expect(
      service.createEscrowOrder({
        amount: Money.fromCents(0, "USD"),
      }),
    ).rejects.toThrow(MandateValidationError);

    await expect(
      service.createEscrowOrder({
        amount: Money.fromCents(1000, "USD"),
        items: [
          {
            name: "Zero Item",
            quantity: 1,
            unitAmount: Money.zero("USD"),
          },
        ],
      }),
    ).rejects.toThrow(MandateValidationError);
  });

  it("throws MandateValidationError when orderId is empty, blank, or null", async () => {
    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: vi.fn() as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    await expect(service.authorizeOrder({ orderId: "" })).rejects.toThrow(MandateValidationError);
    await expect(service.authorizeOrder({ orderId: "   " })).rejects.toThrow(
      MandateValidationError,
    );
    await expect(service.authorizeOrder({ orderId: null as unknown as string })).rejects.toThrow(
      MandateValidationError,
    );
    await expect(service.getOrder("")).rejects.toThrow(MandateValidationError);
    await expect(service.getOrder(null as unknown as string)).rejects.toThrow(
      MandateValidationError,
    );
  });

  it("auto-generates PayPal-Request-Id UUID header when requestId is omitted", async () => {
    let capturedHeaderRequestId: string | null = null;
    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }
      const headers = new Headers(init?.headers);
      capturedHeaderRequestId = headers.get("PayPal-Request-Id");
      return new Response(JSON.stringify(createMockAuthorizeResponse()), { status: 201 });
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    await service.authorizeOrder({ orderId: "ORDER-AUTO-UUID" });
    expect(capturedHeaderRequestId).toBeDefined();
    expect(capturedHeaderRequestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("throws EscrowAuthorizationError when authorization status is DENIED or EXPIRED", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }
      const deniedResponse = createMockAuthorizeResponse({
        purchase_units: [
          {
            reference_id: "unit-001",
            payments: {
              authorizations: [
                {
                  id: "0AW2184448108334S",
                  status: "DENIED",
                  amount: {
                    currency_code: "USD",
                    value: "249.99",
                  },
                },
              ],
            },
          },
        ],
      });
      return new Response(JSON.stringify(deniedResponse), { status: 201 });
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    await expect(service.authorizeOrder({ orderId: "ORDER-DENIED" })).rejects.toThrow(
      EscrowAuthorizationError,
    );
  });

  it("maps PENDING status and statusDetails reason on authorization hold", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }
      const pendingResponse = createMockAuthorizeResponse({
        purchase_units: [
          {
            reference_id: "unit-001",
            payments: {
              authorizations: [
                {
                  id: "0AW2184448108334S",
                  status: "PENDING",
                  status_details: { reason: "PENDING_REVIEW" },
                  amount: {
                    currency_code: "USD",
                    value: "249.99",
                  },
                },
              ],
            },
          },
        ],
      });
      return new Response(JSON.stringify(pendingResponse), { status: 201 });
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    const authorization = await service.authorizeOrder({ orderId: "ORDER-PENDING" });
    expect(authorization.status).toBe("PENDING");
    expect(authorization.statusDetails?.reason).toBe("PENDING_REVIEW");
  });

  it("getOrder extracts customId and authorizationId when present", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }
      const response = createMockAuthorizeResponse({
        purchase_units: [
          {
            reference_id: "unit-001",
            custom_id: "CUSTOM-TRACK-777",
            payments: {
              authorizations: [
                {
                  id: "0AW2184448108334S",
                  status: "CREATED",
                  amount: {
                    currency_code: "USD",
                    value: "249.99",
                  },
                },
              ],
            },
          },
        ],
      });
      return new Response(JSON.stringify(response), { status: 200 });
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    const order = await service.getOrder("ORDER-WITH-AUTH");
    expect(order.customId).toBe("CUSTOM-TRACK-777");
    expect(order.authorizationId).toBe("0AW2184448108334S");
  });

  it("enriches error messages with PayPal issues and descriptions", async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed.",
          details: [
            {
              issue: "ORDER_NOT_APPROVED",
              description: "Payer has not approved the Order for payment.",
            },
          ],
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      );
    });

    const auth = new PayPalAuthClient({
      clientId: "id",
      clientSecret: "secret",
      customFetch: mockFetch as unknown as typeof fetch,
    });
    const service = new OrdersEscrowService(auth);

    await expect(service.authorizeOrder({ orderId: "UNAPPROVED_ORDER" })).rejects.toThrow(
      /ORDER_NOT_APPROVED: Payer has not approved the Order for payment/,
    );
  });
});
