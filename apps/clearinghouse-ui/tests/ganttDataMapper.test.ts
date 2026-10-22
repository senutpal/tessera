import { describe, expect, it } from "vitest";
import {
  calculateCriticalPath,
  computeBaselineComparison,
  mapRecordsToGanttProject,
  mapRecordToGanttDependencies,
  mapRecordToGanttProject,
  mapRecordToGanttTasks,
} from "../src/components/gantt/ganttDataMapper.js";
import { evaluateGanttTasksSla } from "../src/components/gantt/slaMonitor.js";
import {
  BryntumDependencyType,
  PROCUREMENT_STAGES,
  STAGE_DEFINITIONS,
} from "../src/types/gantt.js";
import type { ClearinghouseRecord } from "../src/types.js";

const mockSampleRecordAuthorized: ClearinghouseRecord = {
  transactionId: "tx-test-001",
  mandateId: "man-001",
  agentId: "agent-01",
  merchantDomain: "aws.amazon.com",
  amount: 50000,
  currency: "USD",
  clearinghouseState: "AUTHORIZED_IN_ESCROW",
  escrowStatus: "AUTHORIZED_HOLD",
  riskScore: 20,
  riskTier: "LOW",
  hitlStatus: "NOT_REQUIRED",
  authorizationId: "auth-aws-1234",
  createdAt: "2026-10-21T08:00:00.000Z",
  updatedAt: "2026-10-21T09:30:00.000Z",
  sequenceNumber: 1,
  timestampMicros: 1774080000000000,
};

const mockSampleRecordInTransit: ClearinghouseRecord = {
  transactionId: "tx-test-002",
  mandateId: "man-002",
  agentId: "agent-02",
  merchantDomain: "stripe.com",
  amount: 150000,
  currency: "USD",
  clearinghouseState: "AUTHORIZED_IN_ESCROW",
  escrowStatus: "IN_TRANSIT",
  riskScore: 45,
  riskTier: "ELEVATED",
  hitlStatus: "APPROVED",
  authorizationId: "auth-str-5678",
  trackingId: "FEDEX-TRACK-9901",
  carrier: "FedEx",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-21T12:00:00.000Z",
  sequenceNumber: 2,
  timestampMicros: 1774000800000000,
};

const mockSampleRecordSettled: ClearinghouseRecord = {
  transactionId: "tx-test-003",
  mandateId: "man-003",
  agentId: "agent-03",
  merchantDomain: "github.com",
  amount: 25000,
  currency: "USD",
  clearinghouseState: "SETTLED",
  escrowStatus: "SETTLED",
  riskScore: 8,
  riskTier: "LOW",
  hitlStatus: "NOT_REQUIRED",
  authorizationId: "auth-gh-9988",
  captureId: "cap-gh-4422",
  trackingId: "UPS-TRACK-1122",
  carrier: "UPS",
  createdAt: "2026-10-19T06:00:00.000Z",
  updatedAt: "2026-10-20T18:00:00.000Z",
  sequenceNumber: 3,
  timestampMicros: 1773900000000000,
};

const mockSampleRecordBreached: ClearinghouseRecord = {
  transactionId: "tx-test-004",
  mandateId: "man-004",
  agentId: "agent-04",
  merchantDomain: "delayed-vendor.com",
  amount: 80000,
  currency: "USD",
  clearinghouseState: "VOIDED",
  escrowStatus: "SLA_BREACH_VOIDED",
  riskScore: 85,
  riskTier: "CRITICAL_HITL",
  hitlStatus: "REJECTED",
  authorizationId: "auth-del-3311",
  createdAt: "2026-10-18T04:00:00.000Z",
  updatedAt: "2026-10-21T10:00:00.000Z",
  sequenceNumber: 4,
  timestampMicros: 1773800000000000,
};

describe("Ticket 11.1: Procurement Task Data Model & State Mapper (ganttDataMapper)", () => {
  describe("7-Stage Milestone Task Tree Generation", () => {
    it("generates exactly 7 stage milestone tasks for a transaction record", () => {
      const tasks = mapRecordToGanttTasks(mockSampleRecordAuthorized);
      expect(tasks).toHaveLength(7);

      const stages = tasks.map((t) => t.stage);
      expect(stages).toEqual(PROCUREMENT_STAGES);
    });

    it("assigns unique deterministic IDs prefixed by transactionId", () => {
      const tasks = mapRecordToGanttTasks(mockSampleRecordAuthorized);
      for (const stage of PROCUREMENT_STAGES) {
        const expectedId = `${mockSampleRecordAuthorized.transactionId}-${stage}`;
        const task = tasks.find((t) => t.id === expectedId);
        expect(task).toBeDefined();
        expect(task?.transactionId).toBe(mockSampleRecordAuthorized.transactionId);
      }
    });

    it("designates specific stages as milestones (mandate verified, delivery verified, escrow captured)", () => {
      const tasks = mapRecordToGanttTasks(mockSampleRecordAuthorized);
      const stageMap = new Map(tasks.map((t) => [t.stage, t]));

      expect(stageMap.get("MANDATE_VERIFIED")?.milestone).toBe(true);
      expect(stageMap.get("CATALOG_DISCOVERY")?.milestone).toBe(false);
      expect(stageMap.get("ESCROW_HOLD")?.milestone).toBe(false);
      expect(stageMap.get("MERCHANT_DISPATCH")?.milestone).toBe(false);
      expect(stageMap.get("IN_TRANSIT")?.milestone).toBe(false);
      expect(stageMap.get("DELIVERY_VERIFIED")?.milestone).toBe(true);
      expect(stageMap.get("ESCROW_CAPTURED")?.milestone).toBe(true);
    });

    it("populates domain metadata including carrier and merchant information", () => {
      const tasks = mapRecordToGanttTasks(mockSampleRecordInTransit);
      const inTransitTask = tasks.find((t) => t.stage === "IN_TRANSIT");

      expect(inTransitTask?.carrier).toBe("FedEx");
      expect(inTransitTask?.trackingId).toBe("FEDEX-TRACK-9901");
      expect(inTransitTask?.merchantDomain).toBe("stripe.com");
      expect(inTransitTask?.riskScore).toBe(45);
    });
  });

  describe("Finish-to-Start (FS) Dependencies", () => {
    it("generates 6 Finish-to-Start dependencies linking consecutive stages", () => {
      const dependencies = mapRecordToGanttDependencies(mockSampleRecordAuthorized);
      expect(dependencies).toHaveLength(6);

      for (let i = 0; i < 6; i++) {
        const fromStage = PROCUREMENT_STAGES[i];
        const toStage = PROCUREMENT_STAGES[i + 1];
        const expectedFromId = `${mockSampleRecordAuthorized.transactionId}-${fromStage}`;
        const expectedToId = `${mockSampleRecordAuthorized.transactionId}-${toStage}`;

        const dep = dependencies[i];
        expect(dep.from).toBe(expectedFromId);
        expect(dep.to).toBe(expectedToId);
        expect(dep.fromEvent).toBe(expectedFromId);
        expect(dep.toEvent).toBe(expectedToId);
        expect(dep.type).toBe(BryntumDependencyType.FinishToStart);
        expect(dep.type).toBe(2);
      }
    });
  });

  describe("State & Progress Mapping Across Lifecycle", () => {
    it("maps AUTHORIZED_HOLD state: stages 1-3 completed, stage 4 in-progress, remainder pending", () => {
      const tasks = mapRecordToGanttTasks(mockSampleRecordAuthorized);
      const stageMap = new Map(tasks.map((t) => [t.stage, t]));

      expect(stageMap.get("MANDATE_VERIFIED")?.status).toBe("COMPLETED");
      expect(stageMap.get("MANDATE_VERIFIED")?.percentDone).toBe(100);

      expect(stageMap.get("CATALOG_DISCOVERY")?.status).toBe("COMPLETED");
      expect(stageMap.get("CATALOG_DISCOVERY")?.percentDone).toBe(100);

      expect(stageMap.get("ESCROW_HOLD")?.status).toBe("COMPLETED");
      expect(stageMap.get("ESCROW_HOLD")?.percentDone).toBe(100);

      expect(stageMap.get("MERCHANT_DISPATCH")?.status).toBe("IN_PROGRESS");
      expect(stageMap.get("MERCHANT_DISPATCH")?.percentDone).toBeGreaterThan(0);
      expect(stageMap.get("MERCHANT_DISPATCH")?.percentDone).toBeLessThan(100);

      expect(stageMap.get("IN_TRANSIT")?.status).toBe("PENDING");
      expect(stageMap.get("IN_TRANSIT")?.percentDone).toBe(0);
      expect(stageMap.get("DELIVERY_VERIFIED")?.status).toBe("PENDING");
      expect(stageMap.get("ESCROW_CAPTURED")?.status).toBe("PENDING");
    });

    it("maps IN_TRANSIT state: stages 1-4 completed, stage 5 in-progress, remainder pending", () => {
      const tasks = mapRecordToGanttTasks(mockSampleRecordInTransit);
      const stageMap = new Map(tasks.map((t) => [t.stage, t]));

      expect(stageMap.get("MANDATE_VERIFIED")?.status).toBe("COMPLETED");
      expect(stageMap.get("CATALOG_DISCOVERY")?.status).toBe("COMPLETED");
      expect(stageMap.get("ESCROW_HOLD")?.status).toBe("COMPLETED");
      expect(stageMap.get("MERCHANT_DISPATCH")?.status).toBe("COMPLETED");
      expect(stageMap.get("MERCHANT_DISPATCH")?.percentDone).toBe(100);

      expect(stageMap.get("IN_TRANSIT")?.status).toBe("IN_PROGRESS");
      expect(stageMap.get("IN_TRANSIT")?.percentDone).toBeGreaterThan(0);

      expect(stageMap.get("DELIVERY_VERIFIED")?.status).toBe("PENDING");
      expect(stageMap.get("ESCROW_CAPTURED")?.status).toBe("PENDING");
    });

    it("maps SETTLED state: all 7 stages 100% completed", () => {
      const tasks = mapRecordToGanttTasks(mockSampleRecordSettled);
      for (const task of tasks) {
        expect(task.status).toBe("COMPLETED");
        expect(task.percentDone).toBe(100);
      }
    });

    it("maps SLA_BREACH_VOIDED state: marks breached stage as BREACHED and subsequent as VOIDED", () => {
      const tasks = mapRecordToGanttTasks(mockSampleRecordBreached);
      const stageMap = new Map(tasks.map((t) => [t.stage, t]));

      expect(stageMap.get("MANDATE_VERIFIED")?.status).toBe("COMPLETED");
      expect(stageMap.get("CATALOG_DISCOVERY")?.status).toBe("COMPLETED");
      expect(stageMap.get("ESCROW_HOLD")?.status).toBe("COMPLETED");

      // Merchant dispatch was breached
      expect(stageMap.get("MERCHANT_DISPATCH")?.status).toBe("BREACHED");
      expect(stageMap.get("MERCHANT_DISPATCH")?.cls).toContain("sla-breached");

      // Subsequent stages voided
      expect(stageMap.get("IN_TRANSIT")?.status).toBe("VOIDED");
      expect(stageMap.get("DELIVERY_VERIFIED")?.status).toBe("VOIDED");
      expect(stageMap.get("ESCROW_CAPTURED")?.status).toBe("VOIDED");
    });
  });

  describe("Baseline vs. Actual Milestone Durations", () => {
    it("computes baselines according to stage definitions contract", () => {
      const tasks = mapRecordToGanttTasks(mockSampleRecordAuthorized);
      for (const task of tasks) {
        expect(task.baselines).toBeDefined();
        expect(task.baselines?.length).toBeGreaterThanOrEqual(1);

        const baseline = task.baselines?.[0];
        if (!task.stage || !baseline) continue;
        const stageDef = STAGE_DEFINITIONS[task.stage];
        expect(baseline.duration).toBe(stageDef.baselineDurationHours);

        const baseStart = new Date(baseline.startDate).getTime();
        const baseEnd = new Date(baseline.endDate).getTime();
        expect(baseEnd).toBeGreaterThanOrEqual(baseStart);
      }
    });

    it("computes baseline comparison variance accurately", () => {
      const tasks = mapRecordToGanttTasks(mockSampleRecordAuthorized);
      const dispatchTask = tasks.find((t) => t.stage === "MERCHANT_DISPATCH");
      expect(dispatchTask).toBeDefined();
      if (!dispatchTask) return;

      const comparison = computeBaselineComparison(dispatchTask);
      expect(comparison.baselineDuration).toBe(24.0);
      expect(typeof comparison.actualDuration).toBe("number");
      expect(typeof comparison.varianceHours).toBe("number");
      expect(typeof comparison.isOverdue).toBe("boolean");
    });
  });

  describe("Critical Path Calculation", () => {
    it("directly calculates critical path tasks from task array", () => {
      const tasks = mapRecordToGanttTasks(mockSampleRecordAuthorized);
      const criticalIds = calculateCriticalPath(tasks);
      expect(criticalIds.length).toBeGreaterThan(0);
      expect(criticalIds).toContain(
        `${mockSampleRecordAuthorized.transactionId}-MERCHANT_DISPATCH`,
      );
    });

    it("identifies active and pending tasks on the critical path for in-flight transactions", () => {
      const project = mapRecordToGanttProject(mockSampleRecordAuthorized, {
        calculateCriticalPath: true,
      });

      expect(project.criticalPathTaskIds.length).toBeGreaterThan(0);

      // In an authorized hold order, dispatch, in-transit, delivery, and escrow capture are on the critical path
      const dispatchTaskId = `${mockSampleRecordAuthorized.transactionId}-MERCHANT_DISPATCH`;
      const transitTaskId = `${mockSampleRecordAuthorized.transactionId}-IN_TRANSIT`;
      const deliveryTaskId = `${mockSampleRecordAuthorized.transactionId}-DELIVERY_VERIFIED`;
      const captureTaskId = `${mockSampleRecordAuthorized.transactionId}-ESCROW_CAPTURED`;

      expect(project.criticalPathTaskIds).toContain(dispatchTaskId);
      expect(project.criticalPathTaskIds).toContain(transitTaskId);
      expect(project.criticalPathTaskIds).toContain(deliveryTaskId);
      expect(project.criticalPathTaskIds).toContain(captureTaskId);
    });

    it("flags critical property and CSS classes on critical path tasks", () => {
      const project = mapRecordToGanttProject(mockSampleRecordAuthorized, {
        calculateCriticalPath: true,
      });

      const rootTask = project.tasksData[0];
      const children = rootTask.children || [];
      const dispatchTask = children.find((t) => t.stage === "MERCHANT_DISPATCH");

      expect(dispatchTask?.critical).toBe(true);
      expect(dispatchTask?.cls).toContain("b-critical-path");
    });

    it("settled orders have empty or complete critical paths since no pending bottlenecks remain", () => {
      const project = mapRecordToGanttProject(mockSampleRecordSettled, {
        calculateCriticalPath: true,
      });

      // No in-flight bottleneck tasks blocking final completion
      expect(project.criticalPathTaskIds).toHaveLength(0);
    });
  });

  describe("Summary Root Task & Batch Project Mapping", () => {
    it("wraps tasks under an expanded summary root task by default", () => {
      const project = mapRecordToGanttProject(mockSampleRecordAuthorized, {
        includeSummaryRoot: true,
      });

      expect(project.tasksData).toHaveLength(1);
      const root = project.tasksData[0];
      expect(root.id).toBe(mockSampleRecordAuthorized.transactionId);
      expect(root.expanded).toBe(true);
      expect(root.children).toHaveLength(7);
      expect(root.name).toContain("Procurement Order");
    });

    it("maps a batch of multiple records into a unified Gantt project", () => {
      const batchRecords = [
        mockSampleRecordAuthorized,
        mockSampleRecordInTransit,
        mockSampleRecordSettled,
      ];
      const project = mapRecordsToGanttProject(batchRecords);

      expect(project.tasksData).toHaveLength(3); // 3 root tasks
      expect(project.dependenciesData).toHaveLength(18); // 3 * 6 FS dependencies

      const allChildrenCount = project.tasksData.reduce(
        (sum, root) => sum + (root.children?.length || 0),
        0,
      );
      expect(allChildrenCount).toBe(21);
    });
  });

  describe("Edge Cases, Corrupted Dates, and Robust Carrier State Propagation", () => {
    it("handles invalid or corrupt ISO timestamp strings without crashing", () => {
      const corruptRecord: ClearinghouseRecord = {
        ...mockSampleRecordAuthorized,
        createdAt: "invalid-timestamp-xyz",
        updatedAt: "corrupt-date-123",
      };

      expect(() => {
        const tasks = mapRecordToGanttTasks(corruptRecord);
        expect(tasks).toHaveLength(7);
        for (const task of tasks) {
          expect(Number.isNaN(new Date(task.startDate).getTime())).toBe(false);
          expect(Number.isNaN(new Date(task.endDate).getTime())).toBe(false);
        }
      }).not.toThrow();
    });

    it("preserves explicit carrierStatus from record into IN_TRANSIT task", () => {
      const recordWithCarrierStatus = {
        ...mockSampleRecordInTransit,
        carrierStatus: "DELIVERY_DELAYED",
      };

      const tasks = mapRecordToGanttTasks(
        recordWithCarrierStatus as unknown as ClearinghouseRecord,
      );
      const transitTask = tasks.find((t) => t.stage === "IN_TRANSIT");
      expect(transitTask).toBeDefined();
      expect(transitTask?.carrierStatus).toBe("DELIVERY_DELAYED");
    });

    it("evaluates critical path as empty for terminated SLA_BREACH_VOIDED transactions", () => {
      const tasks = mapRecordToGanttTasks(mockSampleRecordBreached);
      const criticalPathIds = calculateCriticalPath(tasks);

      // In a voided/breached terminated order, no active tasks impact future delivery SLA
      expect(criticalPathIds).toHaveLength(0);
    });

    it("does not alter merchant dispatch duration or transit start when updatedAt changes from unrelated updates", () => {
      const baselineTasks = mapRecordToGanttTasks(mockSampleRecordInTransit);
      const baselineDispatch = baselineTasks.find((t) => t.stage === "MERCHANT_DISPATCH");
      const baselineTransit = baselineTasks.find((t) => t.stage === "IN_TRANSIT");

      const recordWithUnrelatedUpdate: ClearinghouseRecord = {
        ...mockSampleRecordInTransit,
        updatedAt: "2026-10-22T12:00:00.000Z", // Unrelated update days later (e.g. risk score re-eval)
        riskScore: 88,
      };

      const updatedTasks = mapRecordToGanttTasks(recordWithUnrelatedUpdate);
      const updatedDispatch = updatedTasks.find((t) => t.stage === "MERCHANT_DISPATCH");
      const updatedTransit = updatedTasks.find((t) => t.stage === "IN_TRANSIT");

      expect(updatedDispatch?.duration).toBe(baselineDispatch?.duration);
      expect(updatedTransit?.startDate).toBe(baselineTransit?.startDate);

      const refDate = new Date("2026-10-22T12:00:00.000Z");
      const baselineSla = evaluateGanttTasksSla(baselineTasks, refDate);
      const updatedSla = evaluateGanttTasksSla(updatedTasks, refDate);
      expect(updatedSla).toEqual(baselineSla);
    });
  });
});
