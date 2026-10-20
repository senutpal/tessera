import {
  type AuthorizationId,
  CarrierTrackingError,
  ConflictError,
  type MandateId,
  ShipmentMilestoneStatus,
} from "@tessera/core";
import type {
  ShipmentDeliveredEvent,
  ShipmentMilestone,
  SlaStatusResult,
  TrackingEventSink,
} from "../types/tracking.js";

export const DEFAULT_TRACKING_SLA_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 Hours

export interface TrackingStateMachineOptions {
  eventSink?: TrackingEventSink | undefined;
  slaWindowMs?: number | undefined;
}

export class TrackingStateMachine {
  private readonly eventSink?: TrackingEventSink | undefined;
  private readonly slaWindowMs: number;

  constructor(options: TrackingStateMachineOptions = {}) {
    this.eventSink = options.eventSink;
    this.slaWindowMs = options.slaWindowMs ?? DEFAULT_TRACKING_SLA_WINDOW_MS;
  }

  /**
   * Evaluates whether a transition from current status to target status is valid.
   */
  public isValidTransition(
    current: ShipmentMilestoneStatus | undefined,
    target: ShipmentMilestoneStatus,
  ): boolean {
    if (!current) {
      return true;
    }

    // Idempotent transitions are always valid
    if (current === target) {
      return true;
    }

    switch (current) {
      case ShipmentMilestoneStatus.SHIPPED:
        return (
          target === ShipmentMilestoneStatus.IN_TRANSIT ||
          target === ShipmentMilestoneStatus.DELIVERED ||
          target === ShipmentMilestoneStatus.CANCELLED ||
          target === ShipmentMilestoneStatus.RETURNED
        );

      case ShipmentMilestoneStatus.IN_TRANSIT:
        return (
          target === ShipmentMilestoneStatus.DELIVERED ||
          target === ShipmentMilestoneStatus.CANCELLED ||
          target === ShipmentMilestoneStatus.RETURNED
        );

      case ShipmentMilestoneStatus.DELIVERED:
        // Terminal milestone: delivery cannot be reversed to earlier transit stages
        return false;

      case ShipmentMilestoneStatus.CANCELLED:
      case ShipmentMilestoneStatus.RETURNED:
        // Terminal abort states: cannot transition back to active shipment
        return false;

      default:
        return false;
    }
  }

  /**
   * Applies milestone status transition, enforcing forward-only delivery invariants
   * and emitting `ShipmentDeliveredEvent` upon reaching DELIVERED.
   */
  public async transition(
    current: ShipmentMilestone | undefined,
    incoming: ShipmentMilestone,
    context?: {
      mandateId?: MandateId | undefined;
      authorizationId?: AuthorizationId | undefined;
    },
  ): Promise<ShipmentMilestone> {
    const currentStatus = current?.status;
    const targetStatus = incoming.status;

    if (!this.isValidTransition(currentStatus, targetStatus)) {
      throw new ConflictError(
        `Invalid shipment milestone transition: cannot transition from ${currentStatus} to ${targetStatus}`,
        {
          transactionId: incoming.transactionId,
          trackingNumber: incoming.trackingNumber,
          currentStatus,
          targetStatus,
        },
      );
    }

    // Check if newly entering DELIVERED status
    const isNewDelivery =
      targetStatus === ShipmentMilestoneStatus.DELIVERED &&
      currentStatus !== ShipmentMilestoneStatus.DELIVERED;

    if (isNewDelivery && this.eventSink) {
      const deliveredEvent: ShipmentDeliveredEvent = {
        type: "SHIPMENT_DELIVERED",
        transactionId: incoming.transactionId,
        trackingNumber: incoming.trackingNumber,
        carrier: incoming.carrier,
        status: ShipmentMilestoneStatus.DELIVERED,
        carrierProofTimestamp: incoming.carrierProofTimestamp,
        mandateId: context?.mandateId,
        authorizationId: context?.authorizationId,
        rawTracker: incoming.rawTracker,
        timestamp: new Date().toISOString(),
      };

      await this.eventSink.emit(deliveredEvent);
    }

    return incoming;
  }

  /**
   * Evaluates the merchant SLA window for physical shipment tracking.
   * If tracking is not delivered within the SLA window, a warning is issued
   * and an authorization void is recommended.
   */
  public checkSlaStatus(params: {
    shipmentCreatedAt: number | string | Date;
    currentTimestamp?: number | string | Date | undefined;
    lastMilestone?: ShipmentMilestoneStatus | undefined;
  }): SlaStatusResult {
    const createdMs =
      typeof params.shipmentCreatedAt === "number"
        ? params.shipmentCreatedAt
        : new Date(params.shipmentCreatedAt).getTime();

    if (Number.isNaN(createdMs)) {
      throw new CarrierTrackingError("Invalid shipmentCreatedAt timestamp provided to SLA check", {
        shipmentCreatedAt: params.shipmentCreatedAt,
      });
    }

    const nowMs = params.currentTimestamp
      ? typeof params.currentTimestamp === "number"
        ? params.currentTimestamp
        : new Date(params.currentTimestamp).getTime()
      : Date.now();

    const elapsedMs = Math.max(0, nowMs - createdMs);
    const remainingMs = Math.max(0, this.slaWindowMs - elapsedMs);
    const isBreached = elapsedMs > this.slaWindowMs;
    const isDelivered = params.lastMilestone === ShipmentMilestoneStatus.DELIVERED;

    if (isBreached && !isDelivered) {
      return {
        isBreached: true,
        elapsedMs,
        remainingMs: 0,
        slaWindowMs: this.slaWindowMs,
        warningIssued: true,
        recommendation: "SLA_BREACH_VOID_REQUIRED",
      };
    }

    return {
      isBreached: false,
      elapsedMs,
      remainingMs,
      slaWindowMs: this.slaWindowMs,
      warningIssued: false,
      recommendation: "PROCEED",
    };
  }
}
