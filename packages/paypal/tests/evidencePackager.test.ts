import { asMandateId, DisputeError, MandateValidationError, Money } from "@tessera/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildDisputeEvidenceAuditNote,
  computeEvidenceHash,
  type DisputeEventSink,
  type DisputeEvidenceSubmittedEvent,
  EvidencePackager,
  PayPalAuthClient,
  PayPalClient,
  provideDisputeEvidence,
} from "../index.js";

function createMockTokenResponse() {
  return {
    access_token: "MOCK_TOKEN_EVIDENCE",
    token_type: "Bearer",
    expires_in: 3600,
  };
}

function createMockEvidenceResponse(overrides: Record<string, unknown> = {}) {
  return {
    links: [
      {
        href: "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-99887",
        rel: "self",
        method: "GET",
      },
    ],
    ...overrides,
  };
}

describe("EvidencePackager & computeEvidenceHash", () => {
  const dummyConfig = {
    clientId: "CLIENT_ID",
    clientSecret: "CLIENT_SECRET",
    environment: "sandbox" as const,
  };

  describe("buildDisputeEvidenceAuditNote & computeEvidenceHash", () => {
    it("builds a structured audit note with tracking, mandate, and quote metadata", () => {
      const note = buildDisputeEvidenceAuditNote({
        disputeId: "PP-D-99887",
        tracking: {
          carrierName: "UPS",
          trackingNumber: "1Z9999999999999999",
          deliveryProofTimestamp: "2026-10-20T14:30:00Z",
          milestoneStatus: "DELIVERED",
          trackingUrl: "https://www.ups.com/track?num=1Z9999999999999999",
        },
        mandate: {
          mandateId: asMandateId("MANDATE-UUID-123"),
          signature: "SIG_ED25519_HEX_12345",
          payloadHash: "HASH_SHA256_HEX_ABCDE",
          publicKey: "PUBKEY_ED25519_HEX_999",
          payeeDomain: "merchant.example.com",
        },
        quote: {
          quoteId: "QUOTE-C3-8877",
          merchantDomain: "merchant.example.com",
          productTitle: "Mechanical Keyboard",
          total: Money.fromDecimalString("149.99", "USD").toDecimalString(),
        },
        notes: "Autonomous resolution engine audit proof",
      });

      expect(note).toContain("[Tessera Settlement Engine Audit Bundle]");
      expect(note).toContain("Carrier=UPS");
      expect(note).toContain("Track#=1Z9999999999999999");
      expect(note).toContain("Delivery Proof Timestamp: 2026-10-20T14:30:00Z");
      expect(note).toContain("Mandate ID: MANDATE-UUID-123");
      expect(note).toContain("Mandate Sig: SIG_ED25519_HEX_12345");
      expect(note).toContain("Quote ID: QUOTE-C3-8877");
      expect(note).toContain("Notes: Autonomous resolution engine audit proof");
      expect(note.length).toBeLessThanOrEqual(2000);
    });

    it("truncates excessively long notes to within 2000 characters with ellipsis", () => {
      const veryLongNotes = "X".repeat(3000);
      const note = buildDisputeEvidenceAuditNote({
        disputeId: "PP-D-99887",
        notes: veryLongNotes,
      });

      expect(note.length).toBe(2000);
      expect(note.endsWith("...")).toBe(true);
    });

    it("computes a deterministic SHA-256 digest for identical evidence bundles", () => {
      const bundle1 = {
        disputeId: "PP-D-99887",
        evidenceType: "PROOF_OF_FULFILLMENT",
        tracking: {
          carrierName: "UPS",
          trackingNumber: "1Z9999999999999999",
        },
        mandate: {
          mandateId: asMandateId("MANDATE-UUID-123"),
          signature: "SIG123",
        },
      };

      const bundle2 = {
        disputeId: "PP-D-99887",
        evidenceType: "PROOF_OF_FULFILLMENT",
        tracking: {
          carrierName: "UPS",
          trackingNumber: "1Z9999999999999999",
        },
        mandate: {
          mandateId: asMandateId("MANDATE-UUID-123"),
          signature: "SIG123",
        },
      };

      const hash1 = computeEvidenceHash(bundle1);
      const hash2 = computeEvidenceHash(bundle2);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 hex
    });
  });

  describe("EvidencePackager.packageAndSubmitEvidence", () => {
    it("submits direct JSON evidence payload without attached files", async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockEvidenceResponse()), { status: 200 }),
      );

      const capturedEvents: DisputeEvidenceSubmittedEvent[] = [];
      const eventSink: DisputeEventSink = {
        emitEvidenceSubmitted: (e) => {
          capturedEvents.push(e);
        },
      };

      const auth = new PayPalAuthClient(dummyConfig);
      const packager = new EvidencePackager(auth, { eventSink });

      const result = await packager.packageAndSubmitEvidence({
        disputeId: "PP-D-99887",
        evidenceType: "PROOF_OF_FULFILLMENT",
        tracking: {
          carrierName: "FEDEX",
          trackingNumber: "794628392019",
          deliveryProofTimestamp: new Date("2026-10-20T11:00:00Z"),
        },
        mandate: {
          mandateId: asMandateId("MANDATE-ABC-99"),
          signature: "SIG_HEX_88",
        },
        notes: "Item delivered on time with recipient signature",
      });

      expect(result.disputeId).toBe("PP-D-99887");
      expect(result.status).toBe("EVIDENCE_SUBMITTED");
      expect(result.evidenceHash).toHaveLength(64);
      expect(result.submittedAt).toBeDefined();

      // Check fetch call
      const call = fetchSpy.mock.calls[1];
      const calledUrl = call?.[0] as string;
      const calledOptions = call?.[1] as RequestInit;
      expect(calledUrl).toBe(
        "https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-99887/provide-evidence",
      );
      expect(calledOptions.method).toBe("POST");
      const headers = new Headers(calledOptions.headers);
      expect(headers.get("Content-Type")).toBe("application/json");

      const requestBody = JSON.parse(calledOptions.body as string);
      expect(requestBody.evidence_type).toBe("PROOF_OF_FULFILLMENT");
      expect(requestBody.evidence_info.tracking_info).toEqual([
        {
          carrier_name: "FEDEX",
          tracking_number: "794628392019",
        },
      ]);
      expect(requestBody.notes).toContain("Carrier=FEDEX");
      expect(requestBody.notes).toContain("Track#=794628392019");

      // Verify domain event emitted
      expect(capturedEvents).toHaveLength(1);
      const ev = capturedEvents[0];
      expect(ev).toBeDefined();
      if (!ev) throw new Error("Expected event");
      expect(ev.type).toBe("dispute.evidence_submitted");
      expect(ev.disputeId).toBe("PP-D-99887");
      expect(ev.carrierName).toBe("FEDEX");
      expect(ev.trackingNumber).toBe("794628392019");
      expect(ev.mandateId).toBe("MANDATE-ABC-99");
    });

    it("submits multipart/form-data when document attachments are provided", async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockEvidenceResponse()), { status: 200 }),
      );

      const auth = new PayPalAuthClient(dummyConfig);
      const packager = new EvidencePackager(auth);

      const fileBuffer = Buffer.from("PDF proof of delivery content", "utf8");

      const result = await packager.packageAndSubmitEvidence({
        disputeId: "PP-D-99887",
        evidenceType: "PROOF_OF_DELIVERY_SIGNATURE",
        tracking: {
          carrierName: "UPS",
          trackingNumber: "1Z9999999999999999",
        },
        documents: [
          {
            name: "delivery_receipt.pdf",
            contentType: "application/pdf",
            content: fileBuffer,
          },
        ],
      });

      expect(result.status).toBe("EVIDENCE_SUBMITTED");

      // Verify body is FormData
      const call = fetchSpy.mock.calls[1];
      const calledOptions = call?.[1] as RequestInit;
      expect(calledOptions.body).toBeInstanceOf(FormData);
      const formData = calledOptions.body as FormData;
      expect(formData.has("input")).toBe(true);
      expect(formData.has("evidence-file")).toBe(true);
    });

    it("throws MandateValidationError when disputeId is missing", async () => {
      const auth = new PayPalAuthClient(dummyConfig);
      const packager = new EvidencePackager(auth);

      await expect(packager.packageAndSubmitEvidence({ disputeId: "" })).rejects.toThrow(
        MandateValidationError,
      );
    });

    it("throws MandateValidationError when tracking is missing carrier name or tracking number", async () => {
      const auth = new PayPalAuthClient(dummyConfig);
      const packager = new EvidencePackager(auth);

      await expect(
        packager.packageAndSubmitEvidence({
          disputeId: "PP-D-99887",
          tracking: { carrierName: "", trackingNumber: "12345" },
        }),
      ).rejects.toThrow(MandateValidationError);

      await expect(
        packager.packageAndSubmitEvidence({
          disputeId: "PP-D-99887",
          tracking: { carrierName: "UPS", trackingNumber: "" },
        }),
      ).rejects.toThrow(MandateValidationError);
    });

    it("throws DisputeError when PayPal rejects evidence submission", async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "DISPUTE_ACTION_NOT_ALLOWED",
            message: "Cannot provide evidence for dispute in current stage",
          }),
          { status: 422 },
        ),
      );

      const auth = new PayPalAuthClient(dummyConfig);
      const packager = new EvidencePackager(auth);

      await expect(
        packager.packageAndSubmitEvidence({
          disputeId: "PP-D-99887",
        }),
      ).rejects.toThrow(DisputeError);
    });
  });

  describe("High-level API helper provideDisputeEvidence and PayPalClient", () => {
    it("provideDisputeEvidence helper delegates to EvidencePackager correctly", async () => {
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockTokenResponse()), { status: 200 }),
      );
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(createMockEvidenceResponse()), { status: 200 }),
      );

      const res = await provideDisputeEvidence(dummyConfig, {
        disputeId: "PP-D-99887",
        tracking: { carrierName: "DHL", trackingNumber: "DHL123456" },
      });

      expect(res.status).toBe("EVIDENCE_SUBMITTED");
      expect(res.disputeId).toBe("PP-D-99887");
    });

    it("PayPalClient exposes evidencePackager", () => {
      const client = new PayPalClient(dummyConfig);
      expect(client.evidencePackager).toBeInstanceOf(EvidencePackager);
    });
  });
});
