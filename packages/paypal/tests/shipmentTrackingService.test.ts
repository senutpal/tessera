import {
  CarrierTrackingError,
  MandateValidationError,
  NotFoundError,
  ShipmentMilestoneStatus,
} from "@tessera/core";
import { describe, expect, it, vi } from "vitest";
import {
  getShipmentTracking,
  PayPalAuthClient,
  PayPalClient,
  registerShipmentTracking,
  ShipmentTrackingService,
  type TrackingEventSink,
} from "../index.js";

function createMockTokenResponse() {
  return {
    access_token: "MOCK_TOKEN_TRACKING",
    token_type: "Bearer",
    expires_in: 3600,
  };
}

function createMockBatchResponse(overrides: Record<string, unknown> = {}) {
  return {
    tracker_identifiers: [
      {
        transaction_id: "8374928374",
        tracking_number: "1Z9999999999999999",
        links: [
          {
            href: "https://api-m.sandbox.paypal.com/v1/shipping/trackers/8374928374-1Z9999999999999999",
            rel: "replace",
            method: "PUT",
          },
        ],
      },
    ],
    errors: [],
    links: [
      {
        href: "https://api-m.sandbox.paypal.com/v1/shipping/trackers-batch",
        rel: "self",
        method: "POST",
      },
    ],
    ...overrides,
  };
}

function createMockTrackerResponse(overrides: Record<string, unknown> = {}) {
  return {
    transaction_id: "8374928374",
    tracking_number: "1Z9999999999999999",
    status: "SHIPPED",
    carrier: "UPS",
    shipment_date: "2026-10-20",
    last_updated_time: "2026-10-20T10:30:00Z",
    tracking_number_validated: true,
    tracking_url: "https://www.ups.com/track?tracknum=1Z9999999999999999",
    links: [
      {
        href: "https://api-m.sandbox.paypal.com/v1/shipping/trackers/8374928374-1Z9999999999999999",
        rel: "self",
        method: "GET",
      },
    ],
    ...overrides,
  };
}

describe("ShipmentTrackingService (Ticket 07.1)", () => {
  describe("registerTrackersBatch", () => {
    it("submits valid tracking batch payload via POST /v1/shipping/trackers-batch", async () => {
      let capturedUrl = "";
      let capturedMethod = "";
      let capturedHeaders: Headers | undefined;
      let capturedBody: Record<string, unknown> | undefined;

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v1/shipping/trackers-batch")) {
          capturedUrl = urlStr;
          capturedMethod = init?.method ?? "";
          capturedHeaders = new Headers(init?.headers);
          capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify(createMockBatchResponse()), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const service = new ShipmentTrackingService(authClient);
      const result = await service.registerTrackersBatch({
        trackers: [
          {
            transactionId: "8374928374",
            trackingNumber: "1Z9999999999999999",
            carrier: "UPS",
            status: "SHIPPED",
            notifyBuyer: false,
          },
        ],
      });

      expect(capturedUrl).toContain("/v1/shipping/trackers-batch");
      expect(capturedMethod).toBe("POST");
      expect(capturedHeaders?.get("Content-Type")).toBe("application/json");
      expect(capturedHeaders?.get("Authorization")).toBe("Bearer MOCK_TOKEN_TRACKING");
      expect(capturedBody).toEqual({
        trackers: [
          {
            transaction_id: "8374928374",
            tracking_number: "1Z9999999999999999",
            carrier: "UPS",
            status: "SHIPPED",
            notify_buyer: false,
          },
        ],
      });

      expect(result.trackerIdentifiers).toHaveLength(1);
      expect(result.trackerIdentifiers[0].transactionId).toBe("8374928374");
      expect(result.trackerIdentifiers[0].trackingNumber).toBe("1Z9999999999999999");
      expect(result.trackerIdentifiers[0].trackerId).toBe("8374928374-1Z9999999999999999");
      expect(result.trackerIdentifiers[0].links).toHaveLength(1);
    });

    it("supports carrier OTHER with carrier_name_other", async () => {
      let capturedBody: Record<string, unknown> | undefined;

      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v1/shipping/trackers-batch")) {
          capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(JSON.stringify(createMockBatchResponse()), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const service = new ShipmentTrackingService(authClient);
      await service.registerTrackersBatch({
        trackers: [
          {
            transactionId: "8374928374",
            trackingNumber: "CUSTOM999",
            carrier: "OTHER",
            carrierNameOther: "Acme Logistics Express",
          },
        ],
      });

      const trackers = capturedBody?.trackers as Array<Record<string, unknown>>;
      expect(trackers[0].carrier).toBe("OTHER");
      expect(trackers[0].carrier_name_other).toBe("Acme Logistics Express");
      expect(trackers[0].status).toBe("SHIPPED"); // default status
    });

    it("rejects empty trackers array with MandateValidationError", async () => {
      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });
      const service = new ShipmentTrackingService(authClient);

      await expect(service.registerTrackersBatch({ trackers: [] })).rejects.toThrow(
        MandateValidationError,
      );
    });

    it("rejects batch exceeding 20 trackers with MandateValidationError", async () => {
      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });
      const service = new ShipmentTrackingService(authClient);

      const items = Array.from({ length: 21 }, (_, i) => ({
        transactionId: `TX_${i}`,
        trackingNumber: `TRACK_${i}`,
        carrier: "UPS",
      }));

      await expect(service.registerTrackersBatch({ trackers: items })).rejects.toThrow(
        MandateValidationError,
      );
    });

    it("rejects tracker with tracking number but no carrier specified", async () => {
      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });
      const service = new ShipmentTrackingService(authClient);

      await expect(
        service.registerTrackersBatch({
          trackers: [
            {
              transactionId: "TX_100",
              trackingNumber: "TRACK_100",
            },
          ],
        }),
      ).rejects.toThrow(MandateValidationError);
    });

    it("handles PayPal 400 error on batch submission and raises CarrierTrackingError", async () => {
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            name: "INVALID_REQUEST",
            message: "Tracking number is invalid for the specified carrier",
            debug_id: "dbg_trk_400",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const service = new ShipmentTrackingService(authClient);
      await expect(
        service.registerTrackersBatch({
          trackers: [
            {
              transactionId: "TX_1",
              trackingNumber: "INVALID_NUM",
              carrier: "UPS",
            },
          ],
        }),
      ).rejects.toThrow(CarrierTrackingError);
    });
  });

  describe("getTracker", () => {
    it("queries tracker by ID and normalizes into ShipmentMilestone", async () => {
      let capturedUrl = "";

      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v1/shipping/trackers/")) {
          capturedUrl = urlStr;
          return new Response(JSON.stringify(createMockTrackerResponse()), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const service = new ShipmentTrackingService(authClient);
      const milestone = await service.getTracker("8374928374-1Z9999999999999999");

      expect(capturedUrl).toContain("/v1/shipping/trackers/8374928374-1Z9999999999999999");
      expect(milestone.transactionId).toBe("8374928374");
      expect(milestone.trackingNumber).toBe("1Z9999999999999999");
      expect(milestone.carrier).toBe("UPS");
      expect(milestone.status).toBe(ShipmentMilestoneStatus.SHIPPED);
      expect(milestone.carrierProofTimestamp).toBe("2026-10-20T10:30:00Z");
      expect(milestone.trackingNumberValidated).toBe(true);
      expect(milestone.trackingUrl).toContain("ups.com");
    });

    it("supports composite querying with transactionId and trackingNumber arguments", async () => {
      let capturedUrl = "";

      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v1/shipping/trackers/")) {
          capturedUrl = urlStr;
          return new Response(
            JSON.stringify(
              createMockTrackerResponse({
                status: "DELIVERED",
                last_updated_time: "2026-10-22T15:00:00Z",
              }),
            ),
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

      const service = new ShipmentTrackingService(authClient);
      const milestone = await service.getTracker("TX_ABC", "TRACK_XYZ");

      expect(capturedUrl).toContain("/v1/shipping/trackers/TX_ABC-TRACK_XYZ");
      expect(milestone.status).toBe(ShipmentMilestoneStatus.DELIVERED);
      expect(milestone.carrierProofTimestamp).toBe("2026-10-22T15:00:00Z");
    });

    it("throws NotFoundError when tracker does not exist (404 response)", async () => {
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        return new Response(JSON.stringify({ name: "RESOURCE_NOT_FOUND" }), { status: 404 });
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const service = new ShipmentTrackingService(authClient);
      await expect(service.getTracker("NON_EXISTENT_TRACKER")).rejects.toThrow(NotFoundError);
    });

    it("emits ShipmentDeliveredEvent when queried status is DELIVERED", async () => {
      const mockSink: TrackingEventSink = {
        emit: vi.fn(),
      };

      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        return new Response(
          JSON.stringify(
            createMockTrackerResponse({
              status: "DELIVERED",
              last_updated_time: "2026-10-22T18:00:00Z",
            }),
          ),
          { status: 200 },
        );
      });

      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const service = new ShipmentTrackingService(authClient, { eventSink: mockSink });
      await service.getTracker("8374928374-1Z9999999999999999");

      expect(mockSink.emit).toHaveBeenCalledTimes(1);
      expect(mockSink.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "SHIPMENT_DELIVERED",
          status: ShipmentMilestoneStatus.DELIVERED,
          carrierProofTimestamp: "2026-10-22T18:00:00Z",
        }),
      );
    });
  });

  describe("normalizeStatus", () => {
    it("maps all supported status values correctly", () => {
      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });
      const service = new ShipmentTrackingService(authClient);

      expect(service.normalizeStatus("DELIVERED")).toBe(ShipmentMilestoneStatus.DELIVERED);
      expect(service.normalizeStatus("COMPLETED")).toBe(ShipmentMilestoneStatus.DELIVERED);

      expect(service.normalizeStatus("IN_TRANSIT")).toBe(ShipmentMilestoneStatus.IN_TRANSIT);
      expect(service.normalizeStatus("IN_PROCESS")).toBe(ShipmentMilestoneStatus.IN_TRANSIT);
      expect(service.normalizeStatus("DELIVERY_SCHEDULED")).toBe(
        ShipmentMilestoneStatus.IN_TRANSIT,
      );
      expect(service.normalizeStatus("DELIVERY_DELAYED")).toBe(ShipmentMilestoneStatus.IN_TRANSIT);
      expect(service.normalizeStatus("LOCAL_PICKUP")).toBe(ShipmentMilestoneStatus.IN_TRANSIT);

      expect(service.normalizeStatus("SHIPPED")).toBe(ShipmentMilestoneStatus.SHIPPED);
      expect(service.normalizeStatus("SHIPMENT_CREATED")).toBe(ShipmentMilestoneStatus.SHIPPED);
      expect(service.normalizeStatus("DROPPED_OFF")).toBe(ShipmentMilestoneStatus.SHIPPED);
      expect(service.normalizeStatus("LABEL_PRINTED")).toBe(ShipmentMilestoneStatus.SHIPPED);

      expect(service.normalizeStatus("CANCELLED")).toBe(ShipmentMilestoneStatus.CANCELLED);
      expect(service.normalizeStatus("VOID")).toBe(ShipmentMilestoneStatus.CANCELLED);
      expect(service.normalizeStatus("NOT_SHIPPED")).toBe(ShipmentMilestoneStatus.CANCELLED);

      expect(service.normalizeStatus("RETURNED")).toBe(ShipmentMilestoneStatus.RETURNED);
      expect(service.normalizeStatus("INRETURN")).toBe(ShipmentMilestoneStatus.RETURNED);

      // On-hold / unconfirmed fall back to IN_TRANSIT
      expect(service.normalizeStatus("ON_HOLD")).toBe(ShipmentMilestoneStatus.IN_TRANSIT);
      expect(service.normalizeStatus("ERROR")).toBe(ShipmentMilestoneStatus.IN_TRANSIT);
      expect(service.normalizeStatus("UNCONFIRMED")).toBe(ShipmentMilestoneStatus.IN_TRANSIT);
    });

    it("throws CarrierTrackingError on completely unknown status string", () => {
      const authClient = new PayPalAuthClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });
      const service = new ShipmentTrackingService(authClient);

      expect(() => service.normalizeStatus("COMPLETELY_BOGUS_STATUS")).toThrow(
        CarrierTrackingError,
      );
    });
  });

  describe("PayPalClient and Top-Level Helpers integration", () => {
    it("routes through PayPalClient tracking service methods", async () => {
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v1/shipping/trackers-batch")) {
          return new Response(JSON.stringify(createMockBatchResponse()), { status: 200 });
        }
        if (urlStr.includes("/v1/shipping/trackers/")) {
          return new Response(JSON.stringify(createMockTrackerResponse()), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });

      const client = new PayPalClient({
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      });

      const batchRes = await client.registerShipmentTracking({
        trackers: [{ transactionId: "TX1", trackingNumber: "TR1", carrier: "FEDEX" }],
      });
      expect(batchRes.trackerIdentifiers).toHaveLength(1);

      const milestone = await client.getShipmentTracking("TX1-TR1");
      expect(milestone.carrier).toBe("UPS");
    });

    it("routes through top-level standalone functions", async () => {
      const mockFetch = vi.fn(async (url: string | URL | Request) => {
        const urlStr = String(url);
        if (urlStr.includes("/v1/oauth2/token")) {
          return new Response(JSON.stringify(createMockTokenResponse()), { status: 200 });
        }
        if (urlStr.includes("/v1/shipping/trackers-batch")) {
          return new Response(JSON.stringify(createMockBatchResponse()), { status: 200 });
        }
        if (urlStr.includes("/v1/shipping/trackers/")) {
          return new Response(JSON.stringify(createMockTrackerResponse()), { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      });

      const config = {
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
        customFetch: mockFetch as unknown as typeof fetch,
      };

      const res = await registerShipmentTracking(config, {
        trackers: [{ transactionId: "TX2", trackingNumber: "TR2", carrier: "USPS" }],
      });
      expect(res.trackerIdentifiers).toHaveLength(1);

      const tracking = await getShipmentTracking(config, "TX2-TR2");
      expect(tracking.status).toBe(ShipmentMilestoneStatus.SHIPPED);
    });
  });
});
