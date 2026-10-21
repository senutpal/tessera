import { createHash } from "node:crypto";
import { asMandateId, asTransactionId, DisputeError, MandateValidationError } from "@tessera/core";
import type { PayPalAuthClient } from "../client/paypalAuthClient.js";
import { throwPayPalError } from "../client/paypalErrors.js";
import {
  type DisputeEventSink,
  type DisputeEvidenceSubmittedEvent,
  type EvidenceBundleInput,
  type EvidenceSubmissionResult,
  type PayPalProvideEvidenceWire,
  PayPalSubsequentActionResponseSchema,
  type PayPalTrackingInfoWire,
} from "../types/disputes.js";

const MAX_PAYPAL_NOTE_LENGTH = 2000;

/**
 * Builds a structured, tamper-evident audit trail note string containing
 * tracking proof, cryptographic mandate verification, and Channel3 quote metadata.
 */
export function buildDisputeEvidenceAuditNote(input: EvidenceBundleInput): string {
  const lines: string[] = ["[Tessera Settlement Engine Audit Bundle]"];

  if (input.tracking) {
    const t = input.tracking;
    lines.push(
      `Fulfillment: Carrier=${t.carrierName}${t.carrierNameOther ? ` (${t.carrierNameOther})` : ""}, Track#=${t.trackingNumber}`,
    );
    if (t.deliveryProofTimestamp) {
      const ts =
        t.deliveryProofTimestamp instanceof Date
          ? t.deliveryProofTimestamp.toISOString()
          : String(t.deliveryProofTimestamp);
      lines.push(`Delivery Proof Timestamp: ${ts}`);
    }
    if (t.milestoneStatus) {
      lines.push(`Tracking Milestone: ${t.milestoneStatus}`);
    }
    if (t.trackingUrl) {
      lines.push(`Tracking URL: ${t.trackingUrl}`);
    }
  }

  if (input.mandate) {
    const m = input.mandate;
    lines.push(`Mandate ID: ${String(m.mandateId)}`);
    if (m.signature) {
      lines.push(`Mandate Sig: ${m.signature}`);
    }
    if (m.payloadHash) {
      lines.push(`Mandate Hash: ${m.payloadHash}`);
    }
    if (m.publicKey) {
      lines.push(`Signer PubKey: ${m.publicKey}`);
    }
    if (m.payeeDomain) {
      lines.push(`Payee Domain: ${m.payeeDomain}`);
    }
  }

  if (input.quote) {
    const q = input.quote;
    lines.push(`Quote ID: ${q.quoteId}`);
    if (q.merchantDomain) {
      lines.push(`Merchant: ${q.merchantDomain}`);
    }
    if (q.productTitle) {
      lines.push(`Product: ${q.productTitle}`);
    }
    if (q.total) {
      lines.push(`Quote Total: ${String(q.total)}`);
    }
  }

  if (input.notes) {
    lines.push(`Notes: ${input.notes.trim()}`);
  }

  let fullNote = lines.join(" | ");
  if (fullNote.length > MAX_PAYPAL_NOTE_LENGTH) {
    fullNote = `${fullNote.slice(0, MAX_PAYPAL_NOTE_LENGTH - 3)}...`;
  }
  return fullNote;
}

/**
 * Computes a SHA-256 cryptographic digest of the complete evidence bundle input.
 */
export function computeEvidenceHash(input: EvidenceBundleInput): string {
  const canonicalData = {
    disputeId: input.disputeId,
    evidenceType: input.evidenceType ?? "PROOF_OF_FULFILLMENT",
    tracking: input.tracking
      ? {
          carrier: input.tracking.carrierName,
          trackingNumber: input.tracking.trackingNumber,
          deliveryProofTimestamp: input.tracking.deliveryProofTimestamp
            ? String(input.tracking.deliveryProofTimestamp)
            : undefined,
        }
      : undefined,
    mandate: input.mandate
      ? {
          mandateId: String(input.mandate.mandateId),
          signature: input.mandate.signature,
          payloadHash: input.mandate.payloadHash,
        }
      : undefined,
    quote: input.quote
      ? {
          quoteId: input.quote.quoteId,
          merchantDomain: input.quote.merchantDomain,
        }
      : undefined,
    notes: input.notes,
  };

  return createHash("sha256").update(JSON.stringify(canonicalData)).digest("hex");
}

export class EvidencePackager {
  constructor(
    private readonly authClient: PayPalAuthClient,
    private readonly options: { eventSink?: DisputeEventSink | undefined } = {},
  ) {}

  /**
   * Bundles carrier tracking, AP2 mandate records, and Channel3 quotes into a PayPal-compliant
   * evidence payload, submits it to POST /v1/customer/disputes/{dispute_id}/provide-evidence,
   * and emits a DisputeEvidenceSubmittedEvent.
   */
  public async packageAndSubmitEvidence(
    input: EvidenceBundleInput,
  ): Promise<EvidenceSubmissionResult> {
    const disputeId = String(input.disputeId ?? "").trim();
    if (!disputeId) {
      throw new MandateValidationError("Dispute ID is required to submit evidence");
    }

    if (input.tracking) {
      if (!input.tracking.carrierName?.trim()) {
        throw new MandateValidationError("Carrier name is required when tracking is provided", {
          tracking: input.tracking,
        });
      }
      if (!input.tracking.trackingNumber?.trim()) {
        throw new MandateValidationError("Tracking number is required when tracking is provided", {
          tracking: input.tracking,
        });
      }
    }

    const evidenceType = input.evidenceType ?? "PROOF_OF_FULFILLMENT";
    const auditNote = buildDisputeEvidenceAuditNote(input);
    const evidenceHash = computeEvidenceHash(input);

    const trackingInfos: PayPalTrackingInfoWire[] = [];
    if (input.tracking) {
      const entry: PayPalTrackingInfoWire = {
        carrier_name: input.tracking.carrierName.trim(),
        tracking_number: input.tracking.trackingNumber.trim(),
      };
      if (input.tracking.carrierNameOther?.trim()) {
        entry.carrier_name_other = input.tracking.carrierNameOther.trim();
      }
      if (input.tracking.trackingUrl?.trim()) {
        entry.tracking_url = input.tracking.trackingUrl.trim();
      }
      trackingInfos.push(entry);
    }

    const evidenceWire: PayPalProvideEvidenceWire = {
      evidence_type: evidenceType,
      notes: auditNote,
    };
    if (trackingInfos.length > 0) {
      evidenceWire.evidence_info = {
        tracking_info: trackingInfos,
      };
    }
    if (input.itemId) {
      evidenceWire.item_id = input.itemId;
    }

    const endpoint = `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`;
    let response: Response;

    if (input.documents && input.documents.length > 0) {
      // Multipart/form-data upload when files are attached
      const formData = new FormData();
      formData.append("input", JSON.stringify(evidenceWire));

      for (const doc of input.documents) {
        const buffer =
          typeof doc.content === "string"
            ? Buffer.from(doc.content, "utf8")
            : Buffer.from(doc.content);
        const arrayBuffer = buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ) as ArrayBuffer;
        const blob = new Blob([arrayBuffer], { type: doc.contentType });
        formData.append("evidence-file", blob, doc.name);
      }

      response = await this.authClient.fetchAuthenticated(endpoint, {
        method: "POST",
        body: formData,
      });
    } else {
      // Direct JSON submission when no documents are attached
      response = await this.authClient.fetchAuthenticated(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(evidenceWire),
      });
    }

    if (!response.ok) {
      await throwPayPalError(
        response,
        `Failed to submit evidence for dispute ${disputeId}`,
        (msg, d) => new DisputeError(msg, d),
      );
    }

    const rawData = (await response.json()) as unknown;
    const parsed = PayPalSubsequentActionResponseSchema.safeParse(rawData);
    const links = parsed.success ? parsed.data.links : [];

    const submittedAt = new Date().toISOString();

    // Emit clearinghouse domain event
    const event: DisputeEvidenceSubmittedEvent = {
      type: "dispute.evidence_submitted",
      disputeId,
      transactionId: asTransactionId(input.tracking?.trackingNumber ? disputeId : disputeId),
      evidenceType,
      evidenceHash,
      submittedAt,
      trackingNumber: input.tracking?.trackingNumber,
      carrierName: input.tracking?.carrierName,
      mandateId: input.mandate?.mandateId
        ? asMandateId(String(input.mandate.mandateId))
        : undefined,
      quoteId: input.quote?.quoteId,
    };

    if (this.options.eventSink?.emitEvidenceSubmitted) {
      await this.options.eventSink.emitEvidenceSubmitted(event);
    }

    return {
      disputeId,
      status: "EVIDENCE_SUBMITTED",
      evidenceHash,
      submittedAt,
      links,
    };
  }
}
