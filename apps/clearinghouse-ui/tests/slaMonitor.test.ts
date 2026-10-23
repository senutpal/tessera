import { describe, expect, it, vi } from "vitest";
import { mapRecordToGanttTasks } from "../src/components/gantt/ganttDataMapper.js";
import {
  createSlaMonitor,
  evaluateGanttTasksSla,
  evaluateRecordSla,
  getWarningBadgeHtml,
  getWarningIconCls,
  SlaMonitor,
} from "../src/components/gantt/slaMonitor.js";
import type { ClearinghouseRecord } from "../src/types.js";

describe("SLA Breach & Delay Warning Engine (slaMonitor)", () => {
  const baseRecord: ClearinghouseRecord = {
    transactionId: "tx-sla-001",
    mandateId: "man-sla-001",
    agentId: "agent-01",
    merchantDomain: "hardware-store.com",
    amount: 120000,
    currency: "USD",
    clearinghouseState: "AUTHORIZED_IN_ESCROW",
    escrowStatus: "AUTHORIZED_HOLD",
    riskScore: 25,
    riskTier: "LOW",
    hitlStatus: "NOT_REQUIRED",
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:30:00.000Z",
    sequenceNumber: 1,
    timestampMicros: 1773792000000000,
  };

  describe("Merchant Dispatch SLA Cutoff (48 hours)", () => {
    it("flags merchant dispatch as delayed when in-progress duration exceeds 48 hours", () => {
      // 52 hours of dispatch (56h after creation), still in AUTHORIZED_HOLD without carrier tracking
      const simulatedNow = new Date("2026-10-20T08:00:00.000Z");
      const evaluation = evaluateRecordSla(baseRecord, simulatedNow);

      expect(evaluation.isBreached).toBe(true);
      expect(evaluation.warnings.length).toBeGreaterThanOrEqual(1);

      const dispatchWarning = evaluation.warnings.find((w) => w.stage === "MERCHANT_DISPATCH");
      expect(dispatchWarning).toBeDefined();
      expect(dispatchWarning?.severity).toBe("WARNING");
      expect(dispatchWarning?.message).toContain("Dispatch SLA exceeded");
      expect(dispatchWarning?.delayHours).toBeGreaterThan(0);
      expect(dispatchWarning?.actionRecommended).toBe("SUPERVISOR_REVIEW");
    });

    it("does not flag dispatch delay when order is within the 48-hour window", () => {
      // 12 hours after creation
      const simulatedNow = new Date("2026-10-18T12:00:00.000Z"); // +12h
      const evaluation = evaluateRecordSla(baseRecord, simulatedNow);

      const dispatchWarning = evaluation.warnings.find((w) => w.stage === "MERCHANT_DISPATCH");
      expect(dispatchWarning).toBeUndefined();
      expect(evaluation.isBreached).toBe(false);
    });
  });

  describe("Carrier In-Transit Tracking & PayPal OpenApi Statuses", () => {
    it("flags CRITICAL warning and stages PayPal dispute when transit exceeds 72h carrier SLA cutoff", () => {
      const transitRecord: ClearinghouseRecord = {
        ...baseRecord,
        transactionId: "tx-transit-delay",
        clearinghouseState: "AUTHORIZED_IN_ESCROW",
        escrowStatus: "IN_TRANSIT",
        trackingId: "FEDEX-88221",
        carrier: "FedEx",
        createdAt: "2026-10-10T00:00:00.000Z",
        updatedAt: "2026-10-11T00:00:00.000Z", // Shipped 24h later
      };

      // 8 days later (more than 72h after shipment dispatch)
      const simulatedNow = new Date("2026-10-18T00:00:00.000Z");
      const evaluation = evaluateRecordSla(transitRecord, simulatedNow);

      expect(evaluation.isBreached).toBe(true);
      const transitWarning = evaluation.warnings.find((w) => w.stage === "IN_TRANSIT");
      expect(transitWarning).toBeDefined();
      expect(transitWarning?.severity).toBe("CRITICAL");
      expect(transitWarning?.message).toContain("In-transit carrier transit SLA exceeded");
      expect(transitWarning?.actionRecommended).toBe("STAGE_PAYPAL_DISPUTE");
    });

    it("detects DELIVERY_DELAYED carrier tracking status directly from clearinghouse record via evaluateRecordSla", () => {
      const recordWithCarrierDelay = {
        ...baseRecord,
        escrowStatus: "IN_TRANSIT" as const,
        trackingId: "UPS-9941",
        carrier: "UPS",
        carrierStatus: "DELIVERY_DELAYED",
      };

      const result = evaluateRecordSla(
        recordWithCarrierDelay as unknown as ClearinghouseRecord,
        new Date("2026-10-18T12:00:00.000Z"),
      );

      expect(result.isBreached).toBe(true);
      const delayWarning = result.warnings.find((w) => w.stage === "IN_TRANSIT");
      expect(delayWarning).toBeDefined();
      expect(delayWarning?.severity).toBe("WARNING");
      expect(delayWarning?.message).toContain("Carrier reported delivery delay");
      expect(delayWarning?.carrierStatus).toBe("DELIVERY_DELAYED");
      expect(delayWarning?.actionRecommended).toBe("NOTIFY_BUYER");
    });

    it("detects ON_HOLD and PICKUP_FAILED carrier tracking statuses directly on records", () => {
      const recordOnHold = {
        ...baseRecord,
        escrowStatus: "IN_TRANSIT" as const,
        trackingId: "DHL-5521",
        carrier: "DHL",
        carrierStatus: "ON_HOLD",
      };

      const result = evaluateRecordSla(
        recordOnHold as unknown as ClearinghouseRecord,
        new Date("2026-10-18T12:00:00.000Z"),
      );
      const holdWarning = result.warnings.find((w) => w.stage === "IN_TRANSIT");

      expect(holdWarning).toBeDefined();
      expect(holdWarning?.message).toContain("on hold");
      expect(holdWarning?.actionRecommended).toBe("SUPERVISOR_REVIEW");
    });

    it("flags CRITICAL warning and stages PayPal dispute when carrier tracking status is CANCELLED", () => {
      const recordCancelled = {
        ...baseRecord,
        escrowStatus: "IN_TRANSIT" as const,
        trackingId: "FEDEX-CANCEL-99",
        carrier: "FedEx",
        carrierStatus: "CANCELLED",
      };

      const result = evaluateRecordSla(
        recordCancelled as unknown as ClearinghouseRecord,
        new Date("2026-10-18T12:00:00.000Z"),
      );

      expect(result.isBreached).toBe(true);
      const cancelWarning = result.warnings.find((w) => w.stage === "IN_TRANSIT");
      expect(cancelWarning).toBeDefined();
      expect(cancelWarning?.severity).toBe("CRITICAL");
      expect(cancelWarning?.message).toContain("cancelled by carrier");
      expect(cancelWarning?.actionRecommended).toBe("STAGE_PAYPAL_DISPUTE");
    });

    it("produces no warnings when carrier status is DELIVERED or COMPLETED", () => {
      const tasks = mapRecordToGanttTasks({
        ...baseRecord,
        clearinghouseState: "FULFILLED_DELIVERED",
        escrowStatus: "DELIVERED_CAPTURED",
        trackingId: "USPS-1123",
        carrier: "USPS",
      });

      const transitTask = tasks.find((t) => t.stage === "IN_TRANSIT");
      if (!transitTask) {
        throw new Error("Expected IN_TRANSIT task to exist");
      }
      transitTask.carrierStatus = "DELIVERED";

      const warnings = evaluateGanttTasksSla(tasks, new Date("2026-10-18T12:00:00.000Z"));
      const transitWarning = warnings.find((w) => w.stage === "IN_TRANSIT");
      expect(transitWarning).toBeUndefined();
    });
  });

  describe("SLA Monitor Event Emitter and Lifecycle", () => {
    it("subscribes to SLA warning events and notifies listeners", () => {
      const monitor = createSlaMonitor();
      const listener = vi.fn();

      const unsubscribe = monitor.onWarning(listener);

      const overdueRecord: ClearinghouseRecord = {
        ...baseRecord,
        createdAt: "2026-10-15T00:00:00.000Z",
      };

      const emitted = monitor.evaluateAndEmit(
        [overdueRecord],
        new Date("2026-10-19T00:00:00.000Z"),
      );
      expect(emitted.length).toBeGreaterThan(0);
      expect(listener).toHaveBeenCalled();
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "MERCHANT_DISPATCH",
        }),
      );

      // Unsubscribe test
      unsubscribe();
      listener.mockClear();

      monitor.evaluateAndEmit([overdueRecord], new Date("2026-10-19T00:00:00.000Z"));
      expect(listener).not.toHaveBeenCalled();
    });

    it("clears historical warnings and returns active warning snapshot", () => {
      const monitor = new SlaMonitor();
      const overdueRecord: ClearinghouseRecord = {
        ...baseRecord,
        createdAt: "2026-10-15T00:00:00.000Z",
      };

      monitor.evaluateAndEmit([overdueRecord], new Date("2026-10-19T00:00:00.000Z"));
      expect(monitor.getWarnings().length).toBeGreaterThan(0);

      monitor.clear();
      expect(monitor.getWarnings()).toHaveLength(0);
    });
  });

  describe("Visual Helper Formatting", () => {
    it("returns correct CSS icon classes for severity levels", () => {
      expect(getWarningIconCls("INFO")).toContain("b-fa-info-circle");
      expect(getWarningIconCls("WARNING")).toContain("b-fa-exclamation-triangle");
      expect(getWarningIconCls("CRITICAL")).toContain("b-fa-radiation");
      expect(getWarningIconCls("CRITICAL")).toContain("motion-safe:animate-pulse");
    });

    it("generates accessible HTML badge markup with warning metadata", () => {
      const warning = {
        id: "warn-01",
        transactionId: "tx-sla-001",
        stage: "MERCHANT_DISPATCH" as const,
        severity: "CRITICAL" as const,
        message: "Merchant dispatch overdue by 24h",
        allocatedDurationHours: 48,
        actualDurationHours: 72,
        delayHours: 24,
        timestamp: "2026-10-21T10:00:00.000Z",
      };

      const badgeHtml = getWarningBadgeHtml(warning);
      expect(badgeHtml).toContain("CRITICAL");
      expect(badgeHtml).toContain('data-sla-severity="CRITICAL"');
      expect(badgeHtml).toContain("Merchant dispatch overdue by 24h");
    });

    it("escapes malicious HTML characters in warning messages to prevent XSS injection", () => {
      const xssWarning = {
        id: "warn-xss-01",
        transactionId: "tx-sla-xss",
        stage: "MERCHANT_DISPATCH" as const,
        severity: "CRITICAL" as const,
        message: 'Malicious payload <img src=x onerror=alert(1)> & "quotes"',
        allocatedDurationHours: 48,
        actualDurationHours: 72,
        delayHours: 24,
        timestamp: "2026-10-21T10:00:00.000Z",
      };

      const badgeHtml = getWarningBadgeHtml(xssWarning);
      expect(badgeHtml).not.toContain("<img");
      expect(badgeHtml).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(badgeHtml).toContain("&amp;");
      expect(badgeHtml).toContain("&quot;quotes&quot;");
    });

    it("safely handles nullish warning message in getWarningBadgeHtml", () => {
      const emptyWarning = {
        id: "warn-empty-01",
        transactionId: "tx-sla-empty",
        stage: "MERCHANT_DISPATCH" as const,
        severity: "INFO" as const,
        message: undefined as unknown as string,
        allocatedDurationHours: 48,
        actualDurationHours: 48,
        delayHours: 0,
        timestamp: "2026-10-21T10:00:00.000Z",
      };

      expect(() => getWarningBadgeHtml(emptyWarning)).not.toThrow();
      const badgeHtml = getWarningBadgeHtml(emptyWarning);
      expect(badgeHtml).toContain("INFO:");
    });
  });
});
