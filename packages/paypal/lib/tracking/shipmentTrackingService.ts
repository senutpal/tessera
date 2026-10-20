import {
  asTransactionId,
  CarrierTrackingError,
  MandateValidationError,
  NotFoundError,
  ShipmentMilestoneStatus,
} from "@tessera/core";
import type { PayPalAuthClient } from "../client/paypalAuthClient.js";
import { throwPayPalError } from "../client/paypalErrors.js";
import {
  type BatchTrackersInput,
  type BatchTrackersResult,
  PayPalBatchTrackerCollectionSchema,
  PayPalTrackerItemSchema,
  type PayPalTrackingStatus,
  type ShipmentMilestone,
  type TrackingEventSink,
} from "../types/tracking.js";

const MAX_BATCH_TRACKERS = 20;

export class ShipmentTrackingService {
  private readonly eventSink?: TrackingEventSink | undefined;

  constructor(
    private readonly authClient: PayPalAuthClient,
    options: { eventSink?: TrackingEventSink | undefined } = {},
  ) {
    this.eventSink = options.eventSink;
  }

  /**
   * Registers physical shipment tracking numbers with PayPal Shipping Tracking v1 API
   * via POST /v1/shipping/trackers-batch.
   */
  public async registerTrackersBatch(input: BatchTrackersInput): Promise<BatchTrackersResult> {
    if (!input || !Array.isArray(input.trackers) || input.trackers.length === 0) {
      throw new MandateValidationError(
        "Invalid tracking batch registration payload: trackers array must contain at least 1 tracker",
        { input },
      );
    }

    if (input.trackers.length > MAX_BATCH_TRACKERS) {
      throw new MandateValidationError(
        `Exceeded maximum tracking batch size: received ${input.trackers.length}, maximum allowed is ${MAX_BATCH_TRACKERS}`,
        { count: input.trackers.length, max: MAX_BATCH_TRACKERS },
      );
    }

    const payloadTrackers = input.trackers.map((t, idx) => {
      const transactionId = String(t.transactionId ?? "").trim();
      if (!transactionId) {
        throw new MandateValidationError(
          `Tracker at index ${idx} is missing required transactionId`,
          {
            index: idx,
          },
        );
      }

      const trackingNumber = t.trackingNumber ? String(t.trackingNumber).trim() : undefined;
      const carrier = t.carrier ? String(t.carrier).trim() : undefined;

      if (trackingNumber && !carrier) {
        throw new MandateValidationError(
          `Carrier is required when tracking_number is provided (tracker index ${idx})`,
          { index: idx, trackingNumber },
        );
      }

      const trackerWire: Record<string, unknown> = {
        transaction_id: transactionId,
        status: t.status ?? "SHIPPED",
      };

      if (trackingNumber) {
        trackerWire.tracking_number = trackingNumber;
      }
      if (carrier) {
        trackerWire.carrier = carrier;
      }
      if (t.carrierNameOther) {
        trackerWire.carrier_name_other = String(t.carrierNameOther).trim();
      }
      if (t.trackingNumberType) {
        trackerWire.tracking_number_type = t.trackingNumberType;
      }
      if (t.shipmentDate) {
        trackerWire.shipment_date = t.shipmentDate;
      }
      if (t.notifyBuyer !== undefined) {
        trackerWire.notify_buyer = Boolean(t.notifyBuyer);
      }
      if (t.quantity !== undefined) {
        trackerWire.quantity = t.quantity;
      }
      if (t.trackingUrl) {
        trackerWire.tracking_url = t.trackingUrl;
      }

      return trackerWire;
    });

    const res = await this.authClient.fetchAuthenticated("/v1/shipping/trackers-batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trackers: payloadTrackers }),
    });

    if (!res.ok) {
      await throwPayPalError(
        res,
        "Failed to register shipment tracking batch with PayPal",
        (msg, d) => new CarrierTrackingError(msg, d),
      );
    }

    const rawData = (await res.json()) as unknown;
    const parsed = PayPalBatchTrackerCollectionSchema.safeParse(rawData);
    if (!parsed.success) {
      throw new CarrierTrackingError("PayPal returned malformed batch tracker response schema", {
        rawData,
        issues: parsed.error.issues,
      });
    }

    const identifiers = (parsed.data.tracker_identifiers ?? []).map((ti) => {
      const txId = asTransactionId(ti.transaction_id);
      const trackNum = ti.tracking_number;
      const trackerId = trackNum ? `${ti.transaction_id}-${trackNum}` : ti.transaction_id;
      return {
        transactionId: txId,
        trackingNumber: trackNum,
        trackerId,
        links: ti.links ?? [],
      };
    });

    return {
      trackerIdentifiers: identifiers,
      errors: parsed.data.errors,
      rawResponse: parsed.data,
    };
  }

  /**
   * Queries shipment tracking information from PayPal Tracking v1 via GET /v1/shipping/trackers/{id}.
   */
  public async getTracker(
    transactionIdOrTrackerId: string,
    trackingNumber?: string,
  ): Promise<ShipmentMilestone> {
    const primary = String(transactionIdOrTrackerId ?? "").trim();
    if (!primary) {
      throw new MandateValidationError("Tracker ID or transaction ID is required.");
    }

    const id = trackingNumber ? `${primary}-${String(trackingNumber).trim()}` : primary;
    const path = `/v1/shipping/trackers/${encodeURIComponent(id)}`;

    const res = await this.authClient.fetchAuthenticated(path, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      if (res.status === 404) {
        throw new NotFoundError(`Shipment tracker not found for identifier: ${id}`, {
          trackerId: id,
        });
      }
      await throwPayPalError(
        res,
        `Failed to retrieve shipment tracker ${id}`,
        (msg, d) => new CarrierTrackingError(msg, d),
      );
    }

    const rawData = (await res.json()) as unknown;
    const parsed = PayPalTrackerItemSchema.safeParse(rawData);
    if (!parsed.success) {
      throw new CarrierTrackingError(
        `PayPal returned malformed shipment tracker response schema for ${id}`,
        { id, rawData, issues: parsed.error.issues },
      );
    }

    const tracker = parsed.data;
    const status = this.normalizeStatus(tracker.status);
    const proofTimestamp =
      tracker.last_updated_time ?? tracker.shipment_date ?? new Date().toISOString();

    const milestone: ShipmentMilestone = {
      transactionId: asTransactionId(tracker.transaction_id),
      trackingNumber: tracker.tracking_number ?? "",
      carrier: tracker.carrier ?? "",
      carrierNameOther: tracker.carrier_name_other,
      status,
      rawStatus: tracker.status as PayPalTrackingStatus,
      carrierProofTimestamp: proofTimestamp,
      trackingUrl: tracker.tracking_url,
      trackingNumberValidated: tracker.tracking_number_validated,
      rawTracker: tracker as Record<string, unknown>,
    };

    if (status === ShipmentMilestoneStatus.DELIVERED && this.eventSink) {
      try {
        await this.eventSink.emit({
          type: "SHIPMENT_DELIVERED",
          transactionId: milestone.transactionId,
          trackingNumber: milestone.trackingNumber,
          carrier: milestone.carrier,
          status: ShipmentMilestoneStatus.DELIVERED,
          carrierProofTimestamp: milestone.carrierProofTimestamp,
          rawTracker: milestone.rawTracker,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Query succeeded; event emission failure does not fail the read operation
      }
    }

    return milestone;
  }

  /**
   * Normalizes PayPal tracking status enum into the core domain's ShipmentMilestoneStatus.
   */
  public normalizeStatus(rawStatus: string): ShipmentMilestoneStatus {
    const upper = String(rawStatus ?? "")
      .trim()
      .toUpperCase();
    switch (upper) {
      case "DELIVERED":
      case "COMPLETED":
        return ShipmentMilestoneStatus.DELIVERED;

      case "IN_TRANSIT":
      case "IN_PROCESS":
      case "DELIVERY_SCHEDULED":
      case "DELIVERY_DELAYED":
      case "LOCAL_PICKUP":
        return ShipmentMilestoneStatus.IN_TRANSIT;

      case "SHIPPED":
      case "SHIPMENT_CREATED":
      case "DROPPED_OFF":
      case "LABEL_PRINTED":
      case "PROCESSED":
      case "NEW":
        return ShipmentMilestoneStatus.SHIPPED;

      case "CANCELLED":
      case "VOID":
      case "NOT_SHIPPED":
        return ShipmentMilestoneStatus.CANCELLED;

      case "RETURNED":
      case "INRETURN":
        return ShipmentMilestoneStatus.RETURNED;

      case "ON_HOLD":
      case "ERROR":
      case "UNCONFIRMED":
      case "PICKUP_FAILED":
      case "DELIVERY_FAILED":
        // Fall back to IN_TRANSIT with hold status preserved in rawTracker
        return ShipmentMilestoneStatus.IN_TRANSIT;

      default:
        throw new CarrierTrackingError(
          `Unrecognized PayPal shipment tracking status: ${rawStatus}`,
          {
            rawStatus,
          },
        );
    }
  }
}
