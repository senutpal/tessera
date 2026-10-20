import {
  asAuthorizationId,
  asMandateId,
  asTransactionId,
  ClearinghouseState,
  EscrowCaptureError,
  MandateValidationError,
  Money,
  ShipmentMilestoneStatus,
} from "@tessera/core";
import { describe, expect, it, vi } from "vitest";
import {
  type CaptureEventSink,
  captureEscrow,
  EscrowCaptureService,
  type EscrowReleasedEvent,
  PayPalAuthClient,
  PayPalClient,
  type ShipmentDeliveredEvent,
  type ShipmentMilestone,
} from "../index.js";

function createMockTokenResponse() {
  return {
    access_token: "MOCK_TOKEN_CAPTURE",
    token_type: "Bearer",
    expires_in: 3600,
  };
}

function createMockCaptureResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "2GG279541U471931P",
    status: "COMPLETED",
    amount: {
      currency_code: "USD",
      value: "149.99",
    },
    final_capture: true,
    seller_protection: {
      status: "ELIGIBLE",
      dispute_categories: ["ITEM_NOT_RECEIVED"],
    },
    create_time: "2026-10-20T16:00:00Z",
    update_time: "2026-10-20T16:00:00Z",
    links: [
      {
        href: "https://api-m.sandbox.paypal.com/v2/payments/captures/2GG279541U471931P",
        rel: "self",
        method: "GET",
      },
    ],
    ...overrides,
  };
}

function createDeliveredMilestone(overrides: Partial<ShipmentMilestone> = {}): ShipmentMilestone {
  return {
    transactionId: asTransactionId("TX_98765"),
    trackingNumber: "1Z9999999999",
    carrier: "UPS",
    status: ShipmentMilestoneStatus.DELIVERED,
    rawStatus: "DELIVERED",
    carrierProofTimestamp: "2026-10-20T15:30:00Z",
    trackingNumberValidated: true,
    ...overrides,
  };
}

function createDeliveredEvent(
  overrides: Partial<ShipmentDeliveredEvent> = {},
): ShipmentDeliveredEvent {
  return {
    type: "SHIPMENT_DELIVERED",
    transactionId: asTransactionId("TX_98765"),
    trackingNumber: "1Z9999999999",
    carrier: "UPS",
    status: ShipmentMilestoneStatus.DELIVERED,
    carrierProofTimestamp: "2026-10-20T15:30:00Z",
    mandateId: asMandateId("mandate-procure-1"),
    authorizationId: asAuthorizationId("0VF52814937998046"),
    timestamp: "2026-10-20T15:30:00Z",
    ...overrides,
  };
}

describe("EscrowCaptureService (Ticket 07.3)", () => {
  describe("Milestone Delivery Gating & Refusal", () => {
    it("refuses capture when shipment is in transit without supervisor override", async () => {
      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });
      const service = new EscrowCaptureService(authClient);

      const inTransitMilestone: ShipmentMilestone = {
        transactionId: asTransactionId("TX_1"),
        trackingNumber: "TR_1",
        carrier: "UPS",
        status: ShipmentMilestoneStatus.IN_TRANSIT,
        rawStatus: "IN_TRANSIT",
        carrierProofTimestamp: "2026-10-20T10:00:00Z",
      };

      await expect(
        service.captureEscrow({
          authorizationId: "0VF52814937998046",
          milestone: inTransitMilestone,
        }),
      ).rejects.toThrow(EscrowCaptureError);
    });

    it("refuses capture when no milestone or proof is provided at all", async () => {
      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });
      const service = new EscrowCaptureService(authClient);

      await expect(
        service.captureEscrow({
          authorizationId: "0VF52814937998046",
        }),
      ).rejects.toThrow(EscrowCaptureError);
    });

    it("rejects supervisor override with empty authorizedBy or reason", async () => {
      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });
      const service = new EscrowCaptureService(authClient);

      await expect(
        service.captureEscrow({
          authorizationId: "0VF52814937998046",
          supervisorOverride: {
            authorizedBy: "",
            reason: "Valid reason",
          },
        }),
      ).rejects.toThrow(EscrowCaptureError);

      await expect(
        service.captureEscrow({
          authorizationId: "0VF52814937998046",
          supervisorOverride: {
            authorizedBy: "supervisor-1",
            reason: "   ",
          },
        }),
      ).rejects.toThrow(EscrowCaptureError);
    });

    it("validates authorizationId is non-empty", async () => {
      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });
      const service = new EscrowCaptureService(authClient);

      await expect(
        service.captureEscrow({
          authorizationId: "   ",
          milestone: createDeliveredMilestone(),
        }),
      ).rejects.toThrow(MandateValidationError);
    });

    it("refuses capture when options.transactionId is omitted with delivered milestone", async () => {
      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });
      const service = new EscrowCaptureService(authClient);

      await expect(
        service.captureEscrow({
          authorizationId: "0VF52814937998046",
          milestone: createDeliveredMilestone(),
        }),
      ).rejects.toThrow(EscrowCaptureError);
    });

    it("refuses capture when milestone transactionId mismatches options.transactionId", async () => {
      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });
      const service = new EscrowCaptureService(authClient);

      await expect(
        service.captureEscrow({
          authorizationId: "0VF52814937998046",
          transactionId: asTransactionId("WRONG_TX_ID"),
          milestone: createDeliveredMilestone({ transactionId: asTransactionId("TX_98765") }),
        }),
      ).rejects.toThrow(EscrowCaptureError);
    });

    it("refuses capture when deliveryProof authorizationId mismatches capture authorizationId", async () => {
      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });
      const service = new EscrowCaptureService(authClient);

      await expect(
        service.captureEscrow({
          authorizationId: "AUTH_EXPECTED",
          transactionId: asTransactionId("TX_98765"),
          deliveryProof: createDeliveredEvent({
            authorizationId: asAuthorizationId("AUTH_DIFFERENT"),
          }),
        }),
      ).rejects.toThrow(EscrowCaptureError);
    });

    it("refuses capture when milestone tracking number is not validated", async () => {
      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });
      const service = new EscrowCaptureService(authClient);

      await expect(
        service.captureEscrow({
          authorizationId: "0VF52814937998046",
          transactionId: asTransactionId("TX_98765"),
          milestone: createDeliveredMilestone({ trackingNumberValidated: false }),
        }),
      ).rejects.toThrow(EscrowCaptureError);
    });
  });

  describe("Successful Escrow Capture Execution", () => {
    it("captures authorization hold when milestone is DELIVERED", async () => {
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedHeaders: Headers | undefined;
      let capturedBody: Record<string, unknown> | undefined;

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v2/payments/authorizations/0VF52814937998046/capture")) {
          capturedUrl = urlStr;
          capturedMethod = init?.method ?? "";
          capturedHeaders = new Headers(init?.headers);
          capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify(createMockCaptureResponse()), { status: 201 });
        }
        return new Response("Not found", { status: 404 });
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const service = new EscrowCaptureService(authClient);
      const result = await service.captureEscrow({
        authorizationId: "0VF52814937998046",
        transactionId: asTransactionId("TX_98765"),
        milestone: createDeliveredMilestone(),
        amount: Money.fromDecimalString("149.99", "USD"),
        invoiceId: "INV-2026-001",
        noteToPayer: "Released upon verified delivery",
        softDescriptor: "TesseraEscrow",
        mandateId: asMandateId("mandate-order-88"),
      });

      expect(capturedUrl).toContain("/v2/payments/authorizations/0VF52814937998046/capture");
      expect(capturedMethod).toBe("POST");
      expect(capturedHeaders?.get("Content-Type")).toBe("application/json");
      expect(capturedHeaders?.get("Prefer")).toBe("return=representation");
      expect(capturedHeaders?.get("PayPal-Request-Id")).toBe(
        "capture-0VF52814937998046-mandate-order-88",
      );
      expect(capturedBody).toMatchObject({
        final_capture: true,
        amount: {
          currency_code: "USD",
          value: "149.99",
        },
        invoice_id: "INV-2026-001",
        note_to_payer: "Released upon verified delivery",
        soft_descriptor: "TesseraEscrow",
      });

      expect(result.authorizationId).toBe("0VF52814937998046");
      expect(result.captureId).toBe("2GG279541U471931P");
      expect(result.status).toBe("SETTLED");
      expect(result.clearinghouseState).toBe(ClearinghouseState.SETTLED);
      expect(result.releaseTrigger).toBe("CARRIER_DELIVERY_PROOF");
      expect(result.amount.toDecimalString()).toBe("149.99");
    });

    it("captures authorization hold when deliveryProof event is provided", async () => {
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v2/payments/authorizations/")) {
          return new Response(JSON.stringify(createMockCaptureResponse()), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const service = new EscrowCaptureService(authClient);
      const result = await service.captureEscrow({
        authorizationId: "0VF52814937998046",
        transactionId: asTransactionId("TX_98765"),
        deliveryProof: createDeliveredEvent(),
      });

      expect(result.status).toBe("SETTLED");
      expect(result.releaseTrigger).toBe("CARRIER_DELIVERY_PROOF");
    });

    it("allows capture via supervisor override even if shipment is in transit", async () => {
      let capturedHeaderRequestId: string | null = null;

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v2/payments/authorizations/")) {
          const headers = new Headers(init?.headers);
          capturedHeaderRequestId = headers.get("PayPal-Request-Id");
          return new Response(JSON.stringify(createMockCaptureResponse()), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const inTransitMilestone: ShipmentMilestone = {
        transactionId: asTransactionId("TX_1"),
        trackingNumber: "TR_1",
        carrier: "FEDEX",
        status: ShipmentMilestoneStatus.IN_TRANSIT,
        rawStatus: "IN_TRANSIT",
        carrierProofTimestamp: "2026-10-20T10:00:00Z",
      };

      const service = new EscrowCaptureService(authClient);
      const result = await service.captureEscrow({
        authorizationId: "0VF52814937998046",
        milestone: inTransitMilestone,
        supervisorOverride: {
          authorizedBy: "ops-director@tessera.org",
          reason: "Customer confirmed delivery in person at distribution depot",
          signature: "ed25519-sig-mock-9988",
        },
        requestId: "custom-req-id-12345",
      });

      expect(result.status).toBe("SETTLED");
      expect(result.releaseTrigger).toBe("SUPERVISOR_OVERRIDE");
      expect(capturedHeaderRequestId).toBe("custom-req-id-12345");
    });
  });

  describe("Clearinghouse Ledger Event Emission", () => {
    it("emits EscrowReleasedEvent to CaptureEventSink upon successful capture", async () => {
      const mockSink: CaptureEventSink = {
        emit: vi.fn(),
      };

      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v2/payments/authorizations/")) {
          return new Response(JSON.stringify(createMockCaptureResponse()), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const service = new EscrowCaptureService(authClient, { eventSink: mockSink });
      await service.captureEscrow({
        authorizationId: "0VF52814937998046",
        milestone: createDeliveredMilestone({ transactionId: asTransactionId("tx-77") }),
        mandateId: asMandateId("mandate-99"),
        transactionId: asTransactionId("tx-77"),
      });

      expect(mockSink.emit).toHaveBeenCalledTimes(1);
      const emitted = vi.mocked(mockSink.emit).mock.calls[0][0] as EscrowReleasedEvent;

      expect(emitted.type).toBe("ESCROW_RELEASED");
      expect(emitted.authorizationId).toBe("0VF52814937998046");
      expect(emitted.captureId).toBe("2GG279541U471931P");
      expect(emitted.mandateId).toBe("mandate-99");
      expect(emitted.transactionId).toBe("tx-77");
      expect(emitted.releaseTrigger).toBe("CARRIER_DELIVERY_PROOF");
      expect(emitted.amount.toDecimalString()).toBe("149.99");
      expect(emitted.status).toBe("SETTLED");
    });

    it("handles PENDING capture status without emitting ESCROW_RELEASED and sets FULFILLED_DELIVERED", async () => {
      const mockSink: CaptureEventSink = {
        emit: vi.fn(),
      };

      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v2/payments/authorizations/")) {
          return new Response(JSON.stringify(createMockCaptureResponse({ status: "PENDING" })), {
            status: 200,
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const service = new EscrowCaptureService(authClient, { eventSink: mockSink });
      const result = await service.captureEscrow({
        authorizationId: "0VF52814937998046",
        transactionId: asTransactionId("TX_98765"),
        milestone: createDeliveredMilestone(),
      });

      expect(result.status).toBe("PENDING");
      expect(result.clearinghouseState).toBe(ClearinghouseState.FULFILLED_DELIVERED);
      expect(mockSink.emit).not.toHaveBeenCalled();
    });

    it("gracefully catches sink emit failures without failing the PayPal capture", async () => {
      const failingSink: CaptureEventSink = {
        emit: vi.fn().mockRejectedValue(new Error("Clearinghouse DB connection timed out")),
      };

      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v2/payments/authorizations/")) {
          return new Response(JSON.stringify(createMockCaptureResponse()), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const service = new EscrowCaptureService(authClient, { eventSink: failingSink });
      const result = await service.captureEscrow({
        authorizationId: "0VF52814937998046",
        transactionId: asTransactionId("TX_98765"),
        milestone: createDeliveredMilestone(),
      });

      expect(result.status).toBe("SETTLED");
      expect(result.eventEmitError).toContain("Clearinghouse DB connection timed out");
    });
  });

  describe("Deterministic Idempotency Key & Partial Captures", () => {
    it("rejects partial capture when requestId is omitted", async () => {
      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });
      const service = new EscrowCaptureService(authClient);

      await expect(
        service.captureEscrow({
          authorizationId: "0VF52814937998046",
          transactionId: asTransactionId("TX_98765"),
          milestone: createDeliveredMilestone(),
          finalCapture: false,
        }),
      ).rejects.toThrow(MandateValidationError);
    });

    it("allows partial capture when requestId is explicitly provided", async () => {
      let capturedRequestId: string | null = null;
      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v2/payments/authorizations/")) {
          capturedRequestId = new Headers(init?.headers).get("PayPal-Request-Id");
          return new Response(JSON.stringify(createMockCaptureResponse()), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const service = new EscrowCaptureService(authClient);
      const result = await service.captureEscrow({
        authorizationId: "0VF52814937998046",
        transactionId: asTransactionId("TX_98765"),
        milestone: createDeliveredMilestone(),
        finalCapture: false,
        requestId: "partial-req-custom-99",
      });

      expect(result.status).toBe("SETTLED");
      expect(capturedRequestId).toBe("partial-req-custom-99");
    });
  });

  describe("Terminal Capture Failures and Error Handling", () => {
    it("throws EscrowCaptureError when PayPal returns terminal status DECLINED", async () => {
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v2/payments/authorizations/")) {
          return new Response(JSON.stringify(createMockCaptureResponse({ status: "DECLINED" })), {
            status: 200,
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const service = new EscrowCaptureService(authClient);
      await expect(
        service.captureEscrow({
          authorizationId: "0VF52814937998046",
          transactionId: asTransactionId("TX_98765"),
          milestone: createDeliveredMilestone(),
        }),
      ).rejects.toThrow(EscrowCaptureError);
    });

    it("throws EscrowCaptureError when PayPal returns unexpected status PARTIALLY_REFUNDED", async () => {
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v2/payments/authorizations/")) {
          return new Response(
            JSON.stringify(createMockCaptureResponse({ status: "PARTIALLY_REFUNDED" })),
            { status: 200 },
          );
        }
        return new Response("Not found", { status: 404 });
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const service = new EscrowCaptureService(authClient);
      await expect(
        service.captureEscrow({
          authorizationId: "0VF52814937998046",
          transactionId: asTransactionId("TX_98765"),
          milestone: createDeliveredMilestone(),
        }),
      ).rejects.toThrow(EscrowCaptureError);
    });

    it("throws EscrowCaptureError on PayPal 422 Unprocessable Entity", async () => {
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            name: "UNPROCESSABLE_ENTITY",
            message: "The authorization has expired.",
            debug_id: "dbg_cap_expired",
          }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        );
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const service = new EscrowCaptureService(authClient);
      await expect(
        service.captureEscrow({
          authorizationId: "EXPIRED_AUTH_ID",
          transactionId: asTransactionId("TX_98765"),
          milestone: createDeliveredMilestone(),
        }),
      ).rejects.toThrow(EscrowCaptureError);
    });
  });

  describe("PayPalClient and Top-Level captureEscrow Integration", () => {
    it("routes capture via PayPalClient.captureEscrow", async () => {
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v2/payments/authorizations/")) {
          return new Response(JSON.stringify(createMockCaptureResponse()), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });

      const client = new PayPalClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const result = await client.captureEscrow({
        authorizationId: "AUTH_CLIENT_TEST",
        transactionId: asTransactionId("TX_98765"),
        milestone: createDeliveredMilestone(),
      });
      expect(result.status).toBe("SETTLED");
      expect(result.captureId).toBe("2GG279541U471931P");
    });

    it("routes capture via top-level captureEscrow helper", async () => {
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v2/payments/authorizations/")) {
          return new Response(JSON.stringify(createMockCaptureResponse()), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });

      const result = await captureEscrow(
        {
          clientId: "CLIENT_ID",
          clientSecret: "CLIENT_SECRET",
          customFetch: mockFetch as unknown as typeof fetch,
        },
        {
          authorizationId: "AUTH_STANDALONE",
          transactionId: asTransactionId("TX_98765"),
          milestone: createDeliveredMilestone(),
        },
      );
      expect(result.status).toBe("SETTLED");
    });
  });
});
