import {
  asAuthorizationId,
  asCaptureId,
  asMandateId,
  asTransactionId,
  ClearinghouseState,
  EscrowCaptureError,
  MandateValidationError,
  Money,
  ShipmentMilestoneStatus,
} from "@tessera/core";
import type { PayPalAuthClient } from "../client/paypalAuthClient.js";
import { throwPayPalError } from "../client/paypalErrors.js";
import {
  type CaptureEventSink,
  type EscrowCaptureOptions,
  type EscrowCaptureResult,
  type EscrowReleasedEvent,
  PayPalCaptureResponseSchema,
} from "../types/tracking.js";

export class EscrowCaptureService {
  private readonly eventSink?: CaptureEventSink | undefined;

  constructor(
    private readonly authClient: PayPalAuthClient,
    options: { eventSink?: CaptureEventSink | undefined } = {},
  ) {
    this.eventSink = options.eventSink;
  }

  /**
   * Captures an authorized payment hold from escrow.
   * Gated strictly upon verified carrier DELIVERED milestone or supervisor override.
   */
  public async captureEscrow(options: EscrowCaptureOptions): Promise<EscrowCaptureResult> {
    const authIdRaw = String(options.authorizationId ?? "").trim();
    if (!authIdRaw) {
      throw new MandateValidationError("Authorization ID is required to execute escrow capture.");
    }

    // 1. Delivery Milestone Gate Verification
    const isDeliveryVerified =
      options.deliveryProof?.status === ShipmentMilestoneStatus.DELIVERED ||
      options.milestone?.status === ShipmentMilestoneStatus.DELIVERED;

    const isSupervisorOverride = Boolean(options.supervisorOverride);

    if (!isDeliveryVerified && !isSupervisorOverride) {
      const currentStatus = options.deliveryProof?.status ?? options.milestone?.status ?? "UNKNOWN";
      throw new EscrowCaptureError(
        `Escrow capture refused: Shipment delivery is unverified (current milestone status: ${currentStatus}). ` +
          "Automated escrow fund release requires verified carrier DELIVERED milestone or supervisor override.",
        {
          authorizationId: authIdRaw,
          currentStatus,
          mandateId: options.mandateId,
        },
      );
    }

    if (options.supervisorOverride) {
      const override = options.supervisorOverride;
      if (!override.authorizedBy?.trim() || !override.reason?.trim()) {
        throw new EscrowCaptureError(
          "Supervisor override rejected: both authorizedBy and reason must be specified.",
          { supervisorOverride: override },
        );
      }
    }

    // 2. Deterministic Idempotency Key
    const requestId =
      options.requestId ??
      (options.mandateId
        ? `capture-mandate-${String(options.mandateId).replace(/[^a-zA-Z0-9-_]/g, "")}`
        : crypto.randomUUID());

    // 3. Prepare Capture Request Body
    const body: Record<string, unknown> = {
      final_capture: options.finalCapture !== undefined ? Boolean(options.finalCapture) : true,
    };

    if (options.amount) {
      body.amount = {
        currency_code: options.amount.currency,
        value: options.amount.toDecimalString(),
      };
    }
    if (options.invoiceId) {
      body.invoice_id = String(options.invoiceId).trim();
    }
    if (options.noteToPayer) {
      body.note_to_payer = String(options.noteToPayer).trim();
    }
    if (options.softDescriptor) {
      body.soft_descriptor = String(options.softDescriptor).trim();
    }

    const path = `/v2/payments/authorizations/${encodeURIComponent(authIdRaw)}/capture`;
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("Prefer", "return=representation");
    headers.set("PayPal-Request-Id", requestId);

    const res = await this.authClient.fetchAuthenticated(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      await throwPayPalError(
        res,
        `Failed to capture escrow authorization ${authIdRaw}`,
        (msg, d) => new EscrowCaptureError(msg, d),
      );
    }

    const rawData = (await res.json()) as unknown;
    const parsed = PayPalCaptureResponseSchema.safeParse(rawData);
    if (!parsed.success) {
      throw new EscrowCaptureError(
        `PayPal returned malformed capture response for authorization ${authIdRaw}`,
        { authorizationId: authIdRaw, rawData, issues: parsed.error.issues },
      );
    }

    const captureData = parsed.data;
    if (captureData.status === "DECLINED" || captureData.status === "FAILED") {
      throw new EscrowCaptureError(
        `PayPal capture rejected with terminal failure status: ${captureData.status}`,
        { authorizationId: authIdRaw, captureId: captureData.id, status: captureData.status },
      );
    }

    const capturedAmount = Money.fromDecimalString(
      captureData.amount.value,
      captureData.amount.currency_code,
    );
    const capturedAt = captureData.create_time ?? new Date().toISOString();
    const releaseTrigger = isSupervisorOverride ? "SUPERVISOR_OVERRIDE" : "CARRIER_DELIVERY_PROOF";

    const result: EscrowCaptureResult = {
      authorizationId: asAuthorizationId(authIdRaw),
      captureId: asCaptureId(captureData.id),
      status: captureData.status === "COMPLETED" ? "SETTLED" : (captureData.status as "PENDING"),
      amount: capturedAmount,
      capturedAt,
      requestId,
      releaseTrigger,
      clearinghouseState: ClearinghouseState.SETTLED,
      rawResponse: captureData,
    };

    // 4. Emit Clearinghouse EscrowReleasedEvent
    if (this.eventSink) {
      const releaseEvent: EscrowReleasedEvent = {
        type: "ESCROW_RELEASED",
        authorizationId: asAuthorizationId(authIdRaw),
        captureId: asCaptureId(captureData.id),
        amount: capturedAmount,
        status: captureData.status === "COMPLETED" ? "SETTLED" : "COMPLETED",
        capturedAt,
        requestId,
        releaseTrigger,
        timestamp: new Date().toISOString(),
      };

      if (options.mandateId) {
        releaseEvent.mandateId = asMandateId(String(options.mandateId));
      }
      if (options.transactionId) {
        releaseEvent.transactionId = asTransactionId(String(options.transactionId));
      }
      if (options.supervisorOverride?.signature) {
        releaseEvent.supervisorSignature = options.supervisorOverride.signature;
      }
      releaseEvent.rawCapture = captureData as Record<string, unknown>;

      try {
        await this.eventSink.emit(releaseEvent);
      } catch (sinkErr: unknown) {
        // Escrow capture at PayPal already succeeded; record emit error without failing capture
        result.eventEmitError = sinkErr instanceof Error ? sinkErr.message : String(sinkErr);
      }
    }

    return result;
  }
}
