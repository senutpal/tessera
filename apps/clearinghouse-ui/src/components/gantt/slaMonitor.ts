import type {
  ProcurementGanttTask,
  SlaDelayWarning,
  SlaEvaluationResult,
  SlaSeverity,
} from "../../types/gantt.js";
import type { ClearinghouseRecord } from "../../types.js";
import { mapRecordToGanttTasks } from "./ganttDataMapper.js";

/**
 * Standard SLA duration thresholds in hours
 */
export const SLA_THRESHOLDS = {
  MERCHANT_DISPATCH_CUTOFF_HOURS: 48.0,
  IN_TRANSIT_CUTOFF_HOURS: 72.0,
  MANDATE_MAX_HOURS: 1.0,
  CATALOG_MAX_HOURS: 4.0,
  ESCROW_MAX_HOURS: 3.0,
  DELIVERY_VERIFIED_MAX_HOURS: 2.0,
  ESCROW_CAPTURED_MAX_HOURS: 1.0,
} as const;

/**
 * Evaluates SLA compliance for an individual clearinghouse record
 */
export function evaluateRecordSla(
  record: ClearinghouseRecord,
  referenceDate?: Date,
): SlaEvaluationResult {
  const now = referenceDate || new Date();
  const tasks = mapRecordToGanttTasks(record, { referenceDate: now });

  const warnings = evaluateGanttTasksSla(tasks, now);

  let maxSeverity: SlaSeverity | null = null;
  if (warnings.some((w) => w.severity === "CRITICAL")) {
    maxSeverity = "CRITICAL";
  } else if (warnings.some((w) => w.severity === "WARNING")) {
    maxSeverity = "WARNING";
  } else if (warnings.some((w) => w.severity === "INFO")) {
    maxSeverity = "INFO";
  }

  const totalDelayHours = warnings.reduce((sum, w) => sum + Math.max(0, w.delayHours), 0);

  return {
    transactionId: record.transactionId,
    isBreached: warnings.length > 0,
    warnings,
    maxSeverity,
    totalDelayHours,
  };
}

/**
 * Evaluates an array of Gantt tasks for carrier tracking delays and SLA cutoff violations
 */
export function evaluateGanttTasksSla(
  tasks: ProcurementGanttTask[],
  referenceDate?: Date,
): SlaDelayWarning[] {
  const now = referenceDate || new Date();
  const warnings: SlaDelayWarning[] = [];

  for (const task of tasks) {
    if (!task.stage) continue;

    const startDate = new Date(task.startDate);
    const endDate = new Date(task.endDate);

    // Calculate actual elapsed hours for in-progress tasks
    const effectiveEndDate = task.status === "IN_PROGRESS" ? now : endDate;
    const elapsedHours = Math.max(
      0,
      (effectiveEndDate.getTime() - startDate.getTime()) / (3600 * 1000),
    );

    // 1. Merchant Dispatch SLA Cutoff (48 hours)
    if (task.stage === "MERCHANT_DISPATCH") {
      if (
        (task.status === "IN_PROGRESS" || task.status === "BREACHED") &&
        elapsedHours >= SLA_THRESHOLDS.MERCHANT_DISPATCH_CUTOFF_HOURS
      ) {
        const delay = elapsedHours - SLA_THRESHOLDS.MERCHANT_DISPATCH_CUTOFF_HOURS;
        warnings.push({
          id: `warn-disp-${task.transactionId}`,
          transactionId: task.transactionId,
          stage: "MERCHANT_DISPATCH",
          severity: "WARNING",
          message: `Dispatch SLA exceeded: Merchant fulfillment took ${elapsedHours.toFixed(1)}h (cutoff: ${SLA_THRESHOLDS.MERCHANT_DISPATCH_CUTOFF_HOURS}h)`,
          allocatedDurationHours: SLA_THRESHOLDS.MERCHANT_DISPATCH_CUTOFF_HOURS,
          actualDurationHours: elapsedHours,
          delayHours: delay,
          merchantDomain: task.merchantDomain,
          timestamp: now.toISOString(),
          actionRecommended: "SUPERVISOR_REVIEW",
        });
      }
    }

    // 2. Carrier In-Transit SLA Cutoff (72 hours)
    if (task.stage === "IN_TRANSIT") {
      if (task.status === "IN_PROGRESS" && elapsedHours > SLA_THRESHOLDS.IN_TRANSIT_CUTOFF_HOURS) {
        const delay = elapsedHours - SLA_THRESHOLDS.IN_TRANSIT_CUTOFF_HOURS;
        warnings.push({
          id: `warn-transit-${task.transactionId}`,
          transactionId: task.transactionId,
          stage: "IN_TRANSIT",
          severity: "CRITICAL",
          message: `In-transit carrier transit SLA exceeded: In transit for ${elapsedHours.toFixed(1)}h (SLA limit: ${SLA_THRESHOLDS.IN_TRANSIT_CUTOFF_HOURS}h)`,
          allocatedDurationHours: SLA_THRESHOLDS.IN_TRANSIT_CUTOFF_HOURS,
          actualDurationHours: elapsedHours,
          delayHours: delay,
          carrier: task.carrier,
          trackingId: task.trackingId,
          timestamp: now.toISOString(),
          actionRecommended: "STAGE_PAYPAL_DISPUTE",
        });
      }

      // 3. Grounded PayPal Tracking v1 carrier exceptions
      if (task.carrierStatus) {
        const status = task.carrierStatus;

        if (status === "DELIVERY_DELAYED") {
          const delay = Math.max(1, elapsedHours > 48 ? elapsedHours - 48 : 24);
          warnings.push({
            id: `warn-carrier-delay-${task.transactionId}`,
            transactionId: task.transactionId,
            stage: "IN_TRANSIT",
            severity: "WARNING",
            message: `Carrier reported delivery delay: shipment in transit experiencing courier delays (${task.carrier || "Carrier"})`,
            allocatedDurationHours: SLA_THRESHOLDS.IN_TRANSIT_CUTOFF_HOURS,
            actualDurationHours: elapsedHours,
            delayHours: delay,
            carrierStatus: status,
            carrier: task.carrier,
            trackingId: task.trackingId,
            timestamp: now.toISOString(),
            actionRecommended: "NOTIFY_BUYER",
          });
        } else if (status === "ON_HOLD") {
          const delay = Math.max(1, elapsedHours > 48 ? elapsedHours - 48 : 24);
          warnings.push({
            id: `warn-carrier-hold-${task.transactionId}`,
            transactionId: task.transactionId,
            stage: "IN_TRANSIT",
            severity: "WARNING",
            message: `Shipment placed on hold by carrier ${task.carrier || "carrier"} (customs/weather/exception)`,
            allocatedDurationHours: SLA_THRESHOLDS.IN_TRANSIT_CUTOFF_HOURS,
            actualDurationHours: elapsedHours,
            delayHours: delay,
            carrierStatus: status,
            carrier: task.carrier,
            trackingId: task.trackingId,
            timestamp: now.toISOString(),
            actionRecommended: "SUPERVISOR_REVIEW",
          });
        } else if (status === "PICKUP_FAILED") {
          warnings.push({
            id: `warn-pickup-failed-${task.transactionId}`,
            transactionId: task.transactionId,
            stage: "IN_TRANSIT",
            severity: "WARNING",
            message: `Carrier pickup failed for tracking ID ${task.trackingId || "unknown"}`,
            allocatedDurationHours: SLA_THRESHOLDS.IN_TRANSIT_CUTOFF_HOURS,
            actualDurationHours: elapsedHours,
            delayHours: Math.max(1, elapsedHours > 24 ? elapsedHours - 24 : 12),
            carrierStatus: status,
            carrier: task.carrier,
            trackingId: task.trackingId,
            timestamp: now.toISOString(),
            actionRecommended: "SUPERVISOR_REVIEW",
          });
        } else if (status === "ERROR" || status === "DELIVERY_FAILED") {
          warnings.push({
            id: `warn-carrier-error-${task.transactionId}`,
            transactionId: task.transactionId,
            stage: "IN_TRANSIT",
            severity: "CRITICAL",
            message: `Carrier delivery error reported for shipment ${task.trackingId || "unknown"}`,
            allocatedDurationHours: SLA_THRESHOLDS.IN_TRANSIT_CUTOFF_HOURS,
            actualDurationHours: elapsedHours,
            delayHours: Math.max(1, elapsedHours),
            carrierStatus: status,
            carrier: task.carrier,
            trackingId: task.trackingId,
            timestamp: now.toISOString(),
            actionRecommended: "STAGE_PAYPAL_DISPUTE",
          });
        } else if (status === "RETURNED" || status === "INRETURN") {
          warnings.push({
            id: `warn-carrier-return-${task.transactionId}`,
            transactionId: task.transactionId,
            stage: "IN_TRANSIT",
            severity: "CRITICAL",
            message: `Shipment returned or in return to merchant for tracking ID ${task.trackingId || "unknown"}`,
            allocatedDurationHours: SLA_THRESHOLDS.IN_TRANSIT_CUTOFF_HOURS,
            actualDurationHours: elapsedHours,
            delayHours: Math.max(1, elapsedHours),
            carrierStatus: status,
            carrier: task.carrier,
            trackingId: task.trackingId,
            timestamp: now.toISOString(),
            actionRecommended: "STAGE_PAYPAL_DISPUTE",
          });
        } else if (status === "CANCELLED" || status === "VOID") {
          warnings.push({
            id: `warn-carrier-cancelled-${task.transactionId}`,
            transactionId: task.transactionId,
            stage: "IN_TRANSIT",
            severity: "CRITICAL",
            message: `Shipment tracking was cancelled by carrier for tracking ID ${task.trackingId || "unknown"}`,
            allocatedDurationHours: SLA_THRESHOLDS.IN_TRANSIT_CUTOFF_HOURS,
            actualDurationHours: elapsedHours,
            delayHours: Math.max(1, elapsedHours),
            carrierStatus: status,
            carrier: task.carrier,
            trackingId: task.trackingId,
            timestamp: now.toISOString(),
            actionRecommended: "STAGE_PAYPAL_DISPUTE",
          });
        }
      }
    }
  }

  return warnings;
}

/**
 * Returns CSS font-awesome / Bryntum icon classes corresponding to SLA severity
 */
export function getWarningIconCls(severity: SlaSeverity): string {
  switch (severity) {
    case "CRITICAL":
      return "b-fa b-fa-radiation text-rose-500 animate-pulse";
    case "WARNING":
      return "b-fa b-fa-exclamation-triangle text-amber-500";
    default:
      return "b-fa b-fa-info-circle text-sky-500";
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Returns HTML badge string for visual milestone tooltip / cell rendering
 */
export function getWarningBadgeHtml(warning: SlaDelayWarning): string {
  const badgeColors: Record<SlaSeverity, string> = {
    CRITICAL: "background-color:#f43f5e; color:#ffffff;",
    WARNING: "background-color:#f59e0b; color:#ffffff;",
    INFO: "background-color:#0284c7; color:#ffffff;",
  };

  return `<span class="sla-warning-badge" data-sla-severity="${warning.severity}" style="padding:2px 6px; border-radius:4px; font-size:11px; font-weight:600; font-family:monospace; ${badgeColors[warning.severity]}">
    ${warning.severity}: ${escapeHtml(warning.message)}
  </span>`;
}

export type SlaWarningListener = (warning: SlaDelayWarning) => void;

/**
 * Client-Side SLA Monitor with event subscription and clearinghouse notification rail
 */
export class SlaMonitor {
  private listeners: Set<SlaWarningListener> = new Set();
  private activeWarnings: SlaDelayWarning[] = [];

  /**
   * Subscribes a listener to SLA warning events
   * @returns Unsubscribe function
   */
  public onWarning(listener: SlaWarningListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Evaluates a set of records and emits warning events to all active listeners
   */
  public evaluateAndEmit(records: ClearinghouseRecord[], referenceDate?: Date): SlaDelayWarning[] {
    const now = referenceDate || new Date();
    const batchWarnings: SlaDelayWarning[] = [];

    for (const record of records) {
      const result = evaluateRecordSla(record, now);
      for (const warning of result.warnings) {
        batchWarnings.push(warning);
        this.emit(warning);
      }
    }

    this.activeWarnings = batchWarnings;
    return batchWarnings;
  }

  /**
   * Retrieves active warnings
   */
  public getWarnings(): SlaDelayWarning[] {
    return [...this.activeWarnings];
  }

  /**
   * Clears historical warnings
   */
  public clear(): void {
    this.activeWarnings = [];
  }

  private emit(warning: SlaDelayWarning): void {
    for (const listener of this.listeners) {
      try {
        listener(warning);
      } catch (err) {
        console.error("Error in SLA warning listener:", err);
      }
    }
  }
}

/**
 * Factory creating a new SLA Monitor instance
 */
export function createSlaMonitor(): SlaMonitor {
  return new SlaMonitor();
}
