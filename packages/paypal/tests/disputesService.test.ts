import { DisputeError, MandateValidationError, NotFoundError } from "@tessera/core";
import { describe, expect, it, vi } from "vitest";
import {
  ClearinghouseDisputeStatus,
  DisputeAction,
  DisputesService,
  getDispute,
  listDisputes,
  normalizePayPalDispute,
  PayPalAuthClient,
  PayPalClient,
  type PayPalDisputeWire,
} from "../index.js";

function createMockTokenResponse() {
  return {
    access_token: "MOCK_TOKEN_DISPUTES",
    token_type: "Bearer",
    expires_in: 3600,
  };
}

function createMockDisputeItem(overrides: Record<string, unknown> = {}) {
  return {
    dispute_id: "PP-D-12345",
    create_time: "2026-10-20T10:00:00Z",
    update_time: "2026-10-20T12:00:00Z",
    status: "WAITING_FOR_SELLER_RESPONSE",
    dispute_state: "REQUIRED_ACTION",
    dispute_life_cycle_stage: "INQUIRY",
    dispute_channel: "INTERNAL",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    dispute_amount: {
      currency_code: "USD",
      value: "150.00",
    },
    disputed_transactions: [
      {
        seller_transaction_id: "TX-SELLER-999",
        buyer_transaction_id: "TX-BUYER-888",
        gross_amount: {
          currency_code: "USD",
          value: "150.00",
        },
      },
    ],
    seller_response_due_date: "2026-10-27T10:00:00Z",
    buyer_response_due_date: "2026-10-28T10:00:00Z",
    links: [
      {
        href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-12345",
        rel: "self",
        method: "GET",
      },
      {
        href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-12345/provide-evidence",
        rel: "provide-evidence",
        method: "POST",
      },
      {
        href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-12345/accept-claim",
        rel: "accept-claim",
        method: "POST",
      },
      {
        href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-12345/escalate",
        rel: "escalate",
        method: "POST",
      },
    ],
    ...overrides,
  };
}

function createMockDisputeSearchResponse(items = [createMockDisputeItem()], links: unknown[] = []) {
  return {
    items,
    total_items: items.length,
    total_pages: 1,
    links:
      links.length > 0
        ? links
        : [
            {
              href: "https://api-m.sandbox.paypal.com/v1/customer/disputes?page_size=10",
              rel: "self",
              method: "GET",
            },
          ],
  };
}

describe("DisputesService & normalizePayPalDispute", () => {
  const dummyConfig = {
    clientId: "CLIENT_ID",
    clientSecret: "CLIENT_SECRET",
    environment: "sandbox" as const,
  };

  describe("normalizePayPalDispute", () => {
    it("normalizes a complete dispute wire payload into ClearinghouseDispute domain model", () => {
      const wire = createMockDisputeItem();
      const domain = normalizePayPalDispute(wire);

      expect(domain.disputeId).toBe("PP-D-12345");
      expect(domain.transactionId).toBe("TX-SELLER-999");
      expect(domain.status).toBe(ClearinghouseDisputeStatus.WAITING_FOR_SELLER);
      expect(domain.state).toBe("REQUIRED_ACTION");
      expect(domain.stage).toBe("INQUIRY");
      expect(domain.reason).toBe("MERCHANDISE_OR_SERVICE_NOT_RECEIVED");
      expect(domain.disputeAmount.toDecimalString()).toBe("150.00");
      expect(domain.disputeAmount.currency).toBe("USD");
      expect(domain.sellerResponseDueDate).toBe("2026-10-27T10:00:00Z");
      expect(domain.allowedActions).toContain(DisputeAction.PROVIDE_EVIDENCE);
      expect(domain.allowedActions).toContain(DisputeAction.ACCEPT_CLAIM);
      expect(domain.allowedActions).toContain(DisputeAction.ESCALATE);
      expect(domain.raw).toBe(wire);
    });

    it("throws MandateValidationError when dispute_id is missing or empty", () => {
      expect(() =>
        normalizePayPalDispute({ dispute_id: "" } as unknown as PayPalDisputeWire),
      ).toThrow(MandateValidationError);
      expect(() => normalizePayPalDispute({} as unknown as PayPalDisputeWire)).toThrow(
        MandateValidationError,
      );
    });

    it("maps all recognized dispute status values correctly", () => {
      const mapStatus = (status: string) =>
        normalizePayPalDispute(createMockDisputeItem({ status })).status;

      expect(mapStatus("OPEN")).toBe(ClearinghouseDisputeStatus.OPEN);
      expect(mapStatus("WAITING_FOR_BUYER_RESPONSE")).toBe(
        ClearinghouseDisputeStatus.WAITING_FOR_BUYER,
      );
      expect(mapStatus("WAITING_FOR_SELLER_RESPONSE")).toBe(
        ClearinghouseDisputeStatus.WAITING_FOR_SELLER,
      );
      expect(mapStatus("UNDER_REVIEW")).toBe(ClearinghouseDisputeStatus.UNDER_REVIEW);
      expect(mapStatus("UNDER_PAYPAL_REVIEW")).toBe(ClearinghouseDisputeStatus.UNDER_REVIEW);
      expect(mapStatus("RESOLVED")).toBe(ClearinghouseDisputeStatus.RESOLVED);
      expect(mapStatus("SOMETHING_ELSE")).toBe(ClearinghouseDisputeStatus.OTHER);
    });

    it("normalizes dispute outcome with refunded amount if present", () => {
      const wire = createMockDisputeItem({
        status: "RESOLVED",
        dispute_outcome: {
          outcome_code: "RESOLVED_BUYER_FAVOUR",
          outcome_reason: "SELLER_FAULT",
          amount_refunded: {
            currency_code: "USD",
            value: "150.00",
          },
        },
      });

      const domain = normalizePayPalDispute(wire);
      expect(domain.outcome).toBeDefined();
      expect(domain.outcome?.outcomeCode).toBe("RESOLVED_BUYER_FAVOUR");
      expect(domain.outcome?.outcomeReason).toBe("SELLER_FAULT");
      expect(domain.outcome?.amountRefunded?.toDecimalString()).toBe("150.00");
    });

    it("falls back to dispute_id as transactionId if transaction details are omitted", () => {
      const wire = createMockDisputeItem({
        disputed_transactions: undefined,
      });
      const domain = normalizePayPalDispute(wire);
      expect(domain.transactionId).toBe("PP-D-12345");
    });

    it("infers allowed actions when HATEOAS links are not present in summary", () => {
      const wire = createMockDisputeItem({
        status: "WAITING_FOR_SELLER_RESPONSE",
        links: [],
      });
      const domain = normalizePayPalDispute(wire);
      expect(domain.allowedActions).toContain(DisputeAction.PROVIDE_EVIDENCE);
      expect(domain.allowedActions).toContain(DisputeAction.ACCEPT_CLAIM);
      expect(domain.allowedActions).toContain(DisputeAction.ESCALATE);
    });
  });

  describe("DisputesService.listDisputes", () => {
    it("successfully queries customer disputes with filter parameters", async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      // 1. Auth token
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );

      // 2. Dispute search
      const mockSearchData = createMockDisputeSearchResponse();
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(mockSearchData), { status: 200 }));

      const auth = new PayPalAuthClient(dummyConfig);
      const service = new DisputesService(auth);

      const result = await service.listDisputes({
        disputedTransactionId: "TX-SELLER-999",
        disputeState: "REQUIRED_ACTION",
        disputeLifeCycleStage: "INQUIRY",
        pageSize: 10,
        startTime: "2026-10-01T00:00:00Z",
      });

      expect(result.disputes).toHaveLength(1);
      const firstDispute = result.disputes[0];
      expect(firstDispute).toBeDefined();
      expect(firstDispute?.disputeId).toBe("PP-D-12345");
      expect(result.totalItems).toBe(1);

      // Verify URL called
      const call = fetchSpy.mock.calls[1];
      const calledUrl = (call?.[0] as string) ?? "";
      expect(calledUrl).toContain("/v1/customer/disputes?");
      expect(calledUrl).toContain("disputed_transaction_id=TX-SELLER-999");
      expect(calledUrl).toContain("dispute_state=REQUIRED_ACTION");
      expect(calledUrl).toContain("dispute_life_cycle_stage=INQUIRY");
      expect(calledUrl).toContain("page_size=10");
      expect(calledUrl).toContain("start_time=2026-10-01T00%3A00%3A00Z");
    });

    it("parses next page token from HATEOAS links if present", async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            createMockDisputeSearchResponse(
              [createMockDisputeItem()],
              [
                {
                  href: "https://api-m.sandbox.paypal.com/v1/customer/disputes?next_page_token=TOKEN_PAGE_2",
                  rel: "next",
                  method: "GET",
                },
              ],
            ),
          ),
          { status: 200 },
        ),
      );

      const auth = new PayPalAuthClient(dummyConfig);
      const service = new DisputesService(auth);

      const result = await service.listDisputes();
      expect(result.nextPageToken).toBe("TOKEN_PAGE_2");
    });

    it("throws MandateValidationError when pageSize is invalid (< 1 or > 100)", async () => {
      const auth = new PayPalAuthClient(dummyConfig);
      const service = new DisputesService(auth);

      await expect(service.listDisputes({ pageSize: 0 })).rejects.toThrow(MandateValidationError);
      await expect(service.listDisputes({ pageSize: 101 })).rejects.toThrow(MandateValidationError);
    });

    it("throws DisputeError when PayPal API returns 400 Bad Request", async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "INVALID_REQUEST",
            message: "Invalid query parameter",
          }),
          { status: 400 },
        ),
      );

      const auth = new PayPalAuthClient(dummyConfig);
      const service = new DisputesService(auth);

      await expect(service.listDisputes()).rejects.toThrow(DisputeError);
    });
  });

  describe("DisputesService.getDispute", () => {
    it("successfully retrieves dispute details by ID", async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockDisputeItem()), { status: 200 }),
      );

      const auth = new PayPalAuthClient(dummyConfig);
      const service = new DisputesService(auth);

      const dispute = await service.getDispute("PP-D-12345");
      expect(dispute.disputeId).toBe("PP-D-12345");
      expect(dispute.status).toBe(ClearinghouseDisputeStatus.WAITING_FOR_SELLER);

      const call = fetchSpy.mock.calls[1];
      const calledUrl = (call?.[0] as string) ?? "";
      expect(calledUrl).toBe("https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-12345");
    });

    it("throws MandateValidationError when disputeId is empty", async () => {
      const auth = new PayPalAuthClient(dummyConfig);
      const service = new DisputesService(auth);

      await expect(service.getDispute("   ")).rejects.toThrow(MandateValidationError);
    });

    it("throws NotFoundError when dispute is not found (404)", async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "RESOURCE_NOT_FOUND",
            message: "Dispute PP-D-NOT-EXIST not found",
          }),
          { status: 404 },
        ),
      );

      const auth = new PayPalAuthClient(dummyConfig);
      const service = new DisputesService(auth);

      await expect(service.getDispute("PP-D-NOT-EXIST")).rejects.toThrow(NotFoundError);
    });

    it("throws DisputeError when PayPal API returns 422 Unprocessable Entity", async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "UNPROCESSABLE_ENTITY",
            message: "Dispute details cannot be retrieved in current state",
          }),
          { status: 422 },
        ),
      );

      const auth = new PayPalAuthClient(dummyConfig);
      const service = new DisputesService(auth);

      await expect(service.getDispute("PP-D-12345")).rejects.toThrow(DisputeError);
    });
  });

  describe("High-level API helpers and PayPalClient integration", () => {
    it("listDisputes and getDispute high-level helpers delegate correctly", async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockDisputeSearchResponse()), { status: 200 }),
      );

      const search = await listDisputes(dummyConfig, { pageSize: 5 });
      expect(search.disputes).toHaveLength(1);

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockDisputeItem()), { status: 200 }),
      );

      const single = await getDispute(dummyConfig, "PP-D-12345");
      expect(single.disputeId).toBe("PP-D-12345");
    });

    it("PayPalClient exposes disputes service methods", async () => {
      const client = new PayPalClient(dummyConfig);
      expect(client.disputes).toBeInstanceOf(DisputesService);
    });
  });
});
