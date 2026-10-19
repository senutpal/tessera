import { describe, expect, it, vi } from "vitest";
import {
  CertificateManager,
  type ClearinghouseAuthorizationCreatedEvent,
  type ClearinghouseAuthorizationVoidedEvent,
  type ClearinghouseWebhookEvent,
  routeWebhook,
  type WebhookEventSink,
  WebhookRouter,
  WebhookSignatureVerifier,
} from "../index.js";
import { createSignedWebhookRequest, TEST_CERT_PEM, TEST_WEBHOOK_ID } from "./testCryptoHelpers.js";

describe("WebhookRouter", () => {
  const createMockVerifier = () => {
    const mockFetch = vi
      .fn()
      .mockImplementation(() => new Response(TEST_CERT_PEM, { status: 200 }));
    const certManager = new CertificateManager({
      customFetch: mockFetch as unknown as typeof fetch,
    });
    return new WebhookSignatureVerifier({
      certificateManager: certManager,
      defaultWebhookId: TEST_WEBHOOK_ID,
    });
  };

  describe("Routing PAYMENT.AUTHORIZATION.CREATED", () => {
    it("transforms resource and dispatches to event sink and handlers", async () => {
      const verifier = createMockVerifier();
      const emittedEvents: ClearinghouseWebhookEvent[] = [];
      const mockEventSink: WebhookEventSink = {
        emit: vi.fn().mockImplementation((event) => {
          emittedEvents.push(event);
        }),
      };

      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
        eventSink: mockEventSink,
      });

      const specificHandler = vi.fn();
      const wildcardHandler = vi.fn();
      router.on("PAYMENT.AUTHORIZATION.CREATED", specificHandler);
      router.on("*", wildcardHandler);

      const payload = {
        id: "WH-EVT-001",
        create_time: "2026-10-19T10:00:00Z",
        resource_type: "authorization",
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        summary: "A payment authorization was created",
        resource: {
          id: "2DC87612EK520411B",
          status: "CREATED",
          amount: {
            currency_code: "USD",
            value: "249.99",
          },
          parent_payment: "PAY-36246664YD343335CKHFA4AY",
          expiration_time: "2026-11-19T10:00:00Z",
        },
      };

      const req = createSignedWebhookRequest({
        rawBody: JSON.stringify(payload),
      });

      const result = await router.handleWebhook(req);

      expect(result.status).toBe("PROCESSED");
      expect(result.httpStatus).toBe(200);
      expect(result.eventType).toBe("PAYMENT.AUTHORIZATION.CREATED");
      expect(result.domainEvent).toBeDefined();

      const domainEvent = result.domainEvent as ClearinghouseAuthorizationCreatedEvent;
      expect(domainEvent.type).toBe("PAYMENT.AUTHORIZATION.CREATED");
      expect(domainEvent.authorizationId).toBe("2DC87612EK520411B");
      expect(domainEvent.orderId).toBeUndefined(); // parent_payment must NOT be assigned to orderId
      expect(domainEvent.amount.amount).toBe(24999);
      expect(domainEvent.amount.currency).toBe("USD");
      expect(domainEvent.status).toBe("CREATED");
      expect(domainEvent.parentPayment).toBe("PAY-36246664YD343335CKHFA4AY");
      expect(domainEvent.transmissionId).toBe(req.headers["paypal-transmission-id"]);

      expect(mockEventSink.emit).toHaveBeenCalledTimes(1);
      expect(specificHandler).toHaveBeenCalledWith(domainEvent);
      expect(wildcardHandler).toHaveBeenCalledWith(domainEvent);
    });

    it("extracts orderId from supplementary_data if present", async () => {
      const verifier = createMockVerifier();
      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
      });

      const payload = {
        id: "WH-EVT-002",
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource: {
          id: "AUTH-SUPP-1",
          status: "CREATED",
          amount: { currency: "USD", total: "10.00" },
          supplementary_data: {
            related_ids: {
              order_id: "ORD-999-XYZ",
            },
          },
        },
      };

      const req = createSignedWebhookRequest({ rawBody: JSON.stringify(payload) });
      const result = await router.handleWebhook(req);

      expect(result.status).toBe("PROCESSED");
      const event = result.domainEvent as ClearinghouseAuthorizationCreatedEvent;
      expect(event.orderId).toBe("ORD-999-XYZ");
      expect(event.amount.amount).toBe(1000);
    });

    it("extracts orderId directly from resource.order_id and normalizes lowercase currency", async () => {
      const verifier = createMockVerifier();
      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
      });

      const payload = {
        id: "WH-EVT-DIRECT-ORD",
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource: {
          id: "AUTH-DIR-1",
          order_id: "ORD-DIRECT-555",
          status: "CREATED",
          amount: { currency: "usd", total: "49.50" }, // lowercase currency
        },
      };

      const req = createSignedWebhookRequest({ rawBody: JSON.stringify(payload) });
      const result = await router.handleWebhook(req);

      expect(result.status).toBe("PROCESSED");
      const event = result.domainEvent as ClearinghouseAuthorizationCreatedEvent;
      expect(event.orderId).toBe("ORD-DIRECT-555");
      expect(event.amount.amount).toBe(4950);
      expect(event.amount.currency).toBe("USD");
    });

    it("does not map custom_id to orderId and preserves customId in its own field", async () => {
      const verifier = createMockVerifier();
      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
      });

      const payload = {
        id: "WH-EVT-CUSTOM-ID",
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource: {
          id: "AUTH-CUST-1",
          custom_id: "MERCHANT-CUSTOM-REF-999",
          status: "CREATED",
          amount: { currency_code: "USD", value: "100.00" },
        },
      };

      const req = createSignedWebhookRequest({ rawBody: JSON.stringify(payload) });
      const result = await router.handleWebhook(req);

      expect(result.status).toBe("PROCESSED");
      const event = result.domainEvent as ClearinghouseAuthorizationCreatedEvent;
      expect(event.orderId).toBeUndefined(); // MUST NOT map custom_id to orderId
      expect(event.customId).toBe("MERCHANT-CUSTOM-REF-999");
    });
  });

  describe("Routing PAYMENT.AUTHORIZATION.VOIDED", () => {
    it("transforms resource and dispatches voided domain event", async () => {
      const verifier = createMockVerifier();
      const emittedEvents: ClearinghouseWebhookEvent[] = [];
      const mockEventSink: WebhookEventSink = {
        emit: vi.fn().mockImplementation((event) => {
          emittedEvents.push(event);
        }),
      };

      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
        eventSink: mockEventSink,
      });

      const payload = {
        id: "WH-EVT-003",
        event_type: "PAYMENT.AUTHORIZATION.VOIDED",
        resource: {
          id: "AUTH-VOID-99",
          status: "VOIDED",
          status_details: {
            reason: "SLA_BREACH_VOIDED",
          },
          amount: {
            currency_code: "USD",
            value: "75.50",
          },
          update_time: "2026-10-19T10:05:00Z",
        },
      };

      const req = createSignedWebhookRequest({ rawBody: JSON.stringify(payload) });
      const result = await router.handleWebhook(req);

      expect(result.status).toBe("PROCESSED");
      expect(result.httpStatus).toBe(200);
      expect(result.eventType).toBe("PAYMENT.AUTHORIZATION.VOIDED");

      const domainEvent = result.domainEvent as ClearinghouseAuthorizationVoidedEvent;
      expect(domainEvent.type).toBe("PAYMENT.AUTHORIZATION.VOIDED");
      expect(domainEvent.authorizationId).toBe("AUTH-VOID-99");
      expect(domainEvent.reason).toBe("SLA_BREACH_VOIDED");
      expect(domainEvent.amount?.amount).toBe(7550);
      expect(domainEvent.status).toBe("VOIDED");

      expect(mockEventSink.emit).toHaveBeenCalledWith(domainEvent);
    });
  });

  describe("Unhandled & Ignored Event Types", () => {
    it("safely ignores event types not subscribed without dispatching", async () => {
      const verifier = createMockVerifier();
      const mockEventSink: WebhookEventSink = {
        emit: vi.fn(),
      };

      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
        eventSink: mockEventSink,
      });

      const payload = {
        id: "WH-EVT-999",
        event_type: "PAYMENT.SALE.COMPLETED",
        resource: { id: "SALE-123" },
      };

      const req = createSignedWebhookRequest({ rawBody: JSON.stringify(payload) });
      const result = await router.handleWebhook(req);

      expect(result.status).toBe("IGNORED");
      expect(result.httpStatus).toBe(200);
      expect(result.eventType).toBe("PAYMENT.SALE.COMPLETED");
      expect(mockEventSink.emit).not.toHaveBeenCalled();
    });
  });

  describe("Replay Protection & Duplicate Handling", () => {
    it("returns DUPLICATE with HTTP 200 without re-dispatching domain events", async () => {
      const verifier = createMockVerifier();
      const mockEventSink: WebhookEventSink = {
        emit: vi.fn(),
      };

      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
        eventSink: mockEventSink,
      });

      const payload = {
        id: "WH-EVT-DUP",
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource: { id: "AUTH-DUP" },
      };

      const req = createSignedWebhookRequest({ rawBody: JSON.stringify(payload) });

      // First call processes
      const res1 = await router.handleWebhook(req);
      expect(res1.status).toBe("PROCESSED");
      expect(mockEventSink.emit).toHaveBeenCalledTimes(1);

      // Duplicate transmission ID
      const res2 = await router.handleWebhook(req);
      expect(res2.status).toBe("DUPLICATE");
      expect(res2.httpStatus).toBe(200);
      expect(res2.message).toContain("Duplicate transmission acknowledged and ignored");
      expect(mockEventSink.emit).toHaveBeenCalledTimes(1); // Not called again!
    });

    it("deduplicates repeated deliveries by event ID even when transmission ID differs", async () => {
      const verifier = createMockVerifier();
      const mockEventSink: WebhookEventSink = {
        emit: vi.fn(),
      };

      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
        eventSink: mockEventSink,
      });

      const payload = {
        id: "WH-EVT-SAME-ID",
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource: { id: "AUTH-123" },
      };

      const req1 = createSignedWebhookRequest({
        rawBody: JSON.stringify(payload),
        transmissionId: "tx-first-transmission",
      });

      const res1 = await router.handleWebhook(req1);
      expect(res1.status).toBe("PROCESSED");
      expect(mockEventSink.emit).toHaveBeenCalledTimes(1);

      // Second delivery: completely different transmission ID, but same payload event.id
      const req2 = createSignedWebhookRequest({
        rawBody: JSON.stringify(payload),
        transmissionId: "tx-second-transmission-diff",
      });

      const res2 = await router.handleWebhook(req2);
      expect(res2.status).toBe("DUPLICATE");
      expect(res2.httpStatus).toBe(200);
      expect(res2.message).toContain("Duplicate webhook event ID acknowledged and ignored");
      expect(mockEventSink.emit).toHaveBeenCalledTimes(1); // Did not dispatch twice!
    });
  });

  describe("Security & Validation Rejections", () => {
    it("rejects invalid cryptographic signature with HTTP 401", async () => {
      const verifier = createMockVerifier();
      const mockEventSink: WebhookEventSink = {
        emit: vi.fn(),
      };

      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
        eventSink: mockEventSink,
      });

      const payload = {
        id: "WH-EVT-TAMPER",
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource: { id: "AUTH-TAMPER" },
      };

      const req = createSignedWebhookRequest({
        rawBody: JSON.stringify(payload),
        tamperSignature: true,
      });

      const result = await router.handleWebhook(req);
      expect(result.status).toBe("INVALID_SIGNATURE");
      expect(result.httpStatus).toBe(401);
      expect(mockEventSink.emit).not.toHaveBeenCalled();
    });

    it("rejects untrusted certificate URLs with HTTP 401", async () => {
      const verifier = createMockVerifier();
      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
      });

      const payload = {
        id: "WH-EVT-EVIL",
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource: { id: "AUTH-1" },
      };

      const req = createSignedWebhookRequest({
        rawBody: JSON.stringify(payload),
        certUrl: "https://evil.com/cert.pem",
      });

      const result = await router.handleWebhook(req);
      expect(result.status).toBe("INVALID_SIGNATURE");
      expect(result.httpStatus).toBe(401);
      expect(result.message).toContain("Untrusted certificate URL rejected");
    });

    it("returns MALFORMED_PAYLOAD with HTTP 400 on non-JSON raw body", async () => {
      const verifier = createMockVerifier();
      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
      });

      const req = createSignedWebhookRequest({
        rawBody: "this is not JSON at all",
      });

      const result = await router.handleWebhook(req);
      expect(result.status).toBe("MALFORMED_PAYLOAD");
      expect(result.httpStatus).toBe(400);
    });

    it("returns MALFORMED_PAYLOAD with HTTP 400 when missing required event fields", async () => {
      const verifier = createMockVerifier();
      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
      });

      const req = createSignedWebhookRequest({
        rawBody: JSON.stringify({ notAnEvent: true }),
      });

      const result = await router.handleWebhook(req);
      expect(result.status).toBe("MALFORMED_PAYLOAD");
      expect(result.httpStatus).toBe(400);
    });

    it("returns MALFORMED_PAYLOAD with HTTP 400 when request is null or not an object", async () => {
      const verifier = createMockVerifier();
      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
      });

      // @ts-expect-error Testing invalid runtime request
      const result = await router.handleWebhook(null);
      expect(result.status).toBe("MALFORMED_PAYLOAD");
      expect(result.httpStatus).toBe(400);
      expect(result.message).toContain("Webhook request must be an object");
    });

    it("returns MALFORMED_PAYLOAD with HTTP 400 when resource has invalid monetary amount", async () => {
      const verifier = createMockVerifier();
      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
      });

      const payload = {
        id: "WH-EVT-BAD-AMT",
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource: {
          id: "AUTH-BAD-AMT",
          status: "CREATED",
          amount: { currency_code: "INVALID_CURRENCY", value: "not-a-number" },
        },
      };

      const req = createSignedWebhookRequest({ rawBody: JSON.stringify(payload) });
      const result = await router.handleWebhook(req);

      expect(result.status).toBe("MALFORMED_PAYLOAD");
      expect(result.httpStatus).toBe(400);
      expect(result.message).toContain("Failed to transform");
    });

    it("returns MALFORMED_PAYLOAD with HTTP 400 when resource.id is missing or empty", async () => {
      const verifier = createMockVerifier();
      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
      });

      const payload = {
        id: "WH-EVT-MISSING-ID",
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource: {
          status: "CREATED",
          amount: { currency_code: "USD", value: "10.00" },
        },
      };

      const req = createSignedWebhookRequest({ rawBody: JSON.stringify(payload) });
      const result = await router.handleWebhook(req);

      expect(result.status).toBe("MALFORMED_PAYLOAD");
      expect(result.httpStatus).toBe(400);
      expect(result.message).toContain("Missing or empty required resource.id");
    });
  });

  describe("Dispatch Error Resilience", () => {
    it("returns DISPATCH_ERROR with HTTP 500 when eventSink throws without crashing process", async () => {
      const verifier = createMockVerifier();
      const failingEventSink: WebhookEventSink = {
        emit: vi.fn().mockRejectedValue(new Error("Database connection lost")),
      };

      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
        eventSink: failingEventSink,
      });

      const payload = {
        id: "WH-EVT-CRASH",
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource: { id: "AUTH-CRASH" },
      };

      const req = createSignedWebhookRequest({ rawBody: JSON.stringify(payload) });

      const result = await router.handleWebhook(req);
      expect(result.status).toBe("DISPATCH_ERROR");
      expect(result.httpStatus).toBe(500);
      expect(result.error).toContain("Database connection lost");
    });

    it("allows retry of webhook after previous delivery failed with DISPATCH_ERROR", async () => {
      const verifier = createMockVerifier();
      let callCount = 0;
      const transientSink: WebhookEventSink = {
        emit: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error("Temporary DB timeout");
          }
        }),
      };

      const router = new WebhookRouter({
        webhookId: TEST_WEBHOOK_ID,
        verifier,
        eventSink: transientSink,
      });

      const payload = {
        id: "WH-EVT-RETRYABLE",
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource: { id: "AUTH-RETRY" },
      };

      const req = createSignedWebhookRequest({ rawBody: JSON.stringify(payload) });

      // First attempt fails with 500
      const res1 = await router.handleWebhook(req);
      expect(res1.status).toBe("DISPATCH_ERROR");
      expect(res1.httpStatus).toBe(500);
      expect(transientSink.emit).toHaveBeenCalledTimes(1);

      // Retry delivery with same transmission ID must NOT be prematurely blocked as DUPLICATE
      const res2 = await router.handleWebhook(req);
      expect(res2.status).toBe("PROCESSED");
      expect(res2.httpStatus).toBe(200);
      expect(transientSink.emit).toHaveBeenCalledTimes(2);

      // Third delivery after success is correctly identified as DUPLICATE
      const res3 = await router.handleWebhook(req);
      expect(res3.status).toBe("DUPLICATE");
      expect(res3.httpStatus).toBe(200);
      expect(transientSink.emit).toHaveBeenCalledTimes(2); // Not emitted again!
    });
  });

  describe("High-level routeWebhook function", () => {
    it("processes webhook through standalone routeWebhook function", async () => {
      const verifier = createMockVerifier();
      const payload = {
        id: "WH-EVT-TOP",
        event_type: "PAYMENT.AUTHORIZATION.VOIDED",
        resource: { id: "AUTH-TOP-VOID" },
      };

      const req = createSignedWebhookRequest({ rawBody: JSON.stringify(payload) });

      const result = await routeWebhook(req, {
        webhookId: TEST_WEBHOOK_ID,
        verifier,
      });

      expect(result.status).toBe("PROCESSED");
      expect(result.httpStatus).toBe(200);
      expect(result.eventType).toBe("PAYMENT.AUTHORIZATION.VOIDED");
    });
  });
});
