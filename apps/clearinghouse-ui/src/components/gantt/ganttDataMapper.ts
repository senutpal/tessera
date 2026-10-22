import {
  BryntumDependencyType,
  type CarrierTrackingStatus,
  type GanttBaseline,
  type GanttMapperOptions,
  type GanttTaskStatus,
  PROCUREMENT_STAGES,
  type ProcurementGanttDependency,
  type ProcurementGanttProjectData,
  type ProcurementGanttTask,
  type ProcurementStage,
  STAGE_DEFINITIONS,
} from "../../types/gantt.js";
import type { ClearinghouseRecord } from "../../types.js";

/**
 * Safely parses any date-like input to a valid Date object, falling back if invalid or NaN.
 */
export function parseDateSafe(dateVal: unknown, fallback: Date = new Date()): Date {
  if (!dateVal) return fallback;
  if (dateVal instanceof Date && !Number.isNaN(dateVal.getTime())) return dateVal;
  if (typeof dateVal === "string" || typeof dateVal === "number") {
    const d = new Date(dateVal);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
}

/**
 * Computes date arithmetic adding fractional hours to a Date
 */
function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + Math.round(hours * 3600 * 1000));
}

/**
 * Determines stage lifecycle status and percentage progress given a clearinghouse record
 */
function determineStageStatusAndProgress(
  stage: ProcurementStage,
  record: ClearinghouseRecord,
): { status: GanttTaskStatus; percentDone: number; cls: string } {
  const { clearinghouseState, escrowStatus, hitlStatus, captureId, trackingId } = record;

  // Terminal Settled
  if (clearinghouseState === "SETTLED" || escrowStatus === "SETTLED") {
    return { status: "COMPLETED", percentDone: 100, cls: "stage-completed" };
  }

  // SLA Breach Voided
  if (escrowStatus === "SLA_BREACH_VOIDED" || clearinghouseState === "VOIDED") {
    const breachStage: ProcurementStage = trackingId ? "IN_TRANSIT" : "MERCHANT_DISPATCH";
    const stageIndex = PROCUREMENT_STAGES.indexOf(stage);
    const breachIndex = PROCUREMENT_STAGES.indexOf(breachStage);

    if (stageIndex < breachIndex) {
      return { status: "COMPLETED", percentDone: 100, cls: "stage-completed" };
    }
    if (stageIndex === breachIndex) {
      return { status: "BREACHED", percentDone: 100, cls: "sla-breached b-task-error" };
    }
    return { status: "VOIDED", percentDone: 0, cls: "stage-voided b-task-inactive" };
  }

  // Disputed state
  if (clearinghouseState === "DISPUTED" || escrowStatus === "DISPUTED") {
    const stageIndex = PROCUREMENT_STAGES.indexOf(stage);
    const disputeIndex = PROCUREMENT_STAGES.indexOf("IN_TRANSIT");

    if (stageIndex < disputeIndex) {
      return { status: "COMPLETED", percentDone: 100, cls: "stage-completed" };
    }
    if (stage === "IN_TRANSIT" || stage === "DELIVERY_VERIFIED") {
      return { status: "DISPUTED", percentDone: 100, cls: "stage-disputed b-task-warning" };
    }
    return { status: "PENDING", percentDone: 0, cls: "stage-pending" };
  }

  // Active Standard Lifecycle Mapping
  switch (stage) {
    case "MANDATE_VERIFIED":
      return { status: "COMPLETED", percentDone: 100, cls: "stage-completed" };

    case "CATALOG_DISCOVERY":
      return { status: "COMPLETED", percentDone: 100, cls: "stage-completed" };

    case "ESCROW_HOLD":
      if (clearinghouseState === "PENDING_AUTHORIZATION") {
        const progress = hitlStatus === "PENDING_APPROVAL" ? 50 : 25;
        return { status: "IN_PROGRESS", percentDone: progress, cls: "stage-in-progress" };
      }
      return { status: "COMPLETED", percentDone: 100, cls: "stage-completed" };

    case "MERCHANT_DISPATCH":
      if (clearinghouseState === "PENDING_AUTHORIZATION") {
        return { status: "PENDING", percentDone: 0, cls: "stage-pending" };
      }
      if (trackingId || escrowStatus === "IN_TRANSIT" || escrowStatus === "DELIVERED_CAPTURED") {
        return { status: "COMPLETED", percentDone: 100, cls: "stage-completed" };
      }
      // Currently awaiting merchant dispatch
      return { status: "IN_PROGRESS", percentDone: 60, cls: "stage-in-progress" };

    case "IN_TRANSIT":
      if (escrowStatus === "DELIVERED_CAPTURED" || clearinghouseState === "FULFILLED_DELIVERED") {
        return { status: "COMPLETED", percentDone: 100, cls: "stage-completed" };
      }
      if (escrowStatus === "IN_TRANSIT" || trackingId) {
        return { status: "IN_PROGRESS", percentDone: 45, cls: "stage-in-progress" };
      }
      return { status: "PENDING", percentDone: 0, cls: "stage-pending" };

    case "DELIVERY_VERIFIED":
      if (escrowStatus === "DELIVERED_CAPTURED" || clearinghouseState === "FULFILLED_DELIVERED") {
        return { status: "COMPLETED", percentDone: 100, cls: "stage-completed" };
      }
      return { status: "PENDING", percentDone: 0, cls: "stage-pending" };

    case "ESCROW_CAPTURED":
      if (captureId) {
        return { status: "COMPLETED", percentDone: 100, cls: "stage-completed" };
      }
      if (escrowStatus === "DELIVERED_CAPTURED" || clearinghouseState === "FULFILLED_DELIVERED") {
        return { status: "IN_PROGRESS", percentDone: 75, cls: "stage-in-progress" };
      }
      return { status: "PENDING", percentDone: 0, cls: "stage-pending" };

    default:
      return { status: "PENDING", percentDone: 0, cls: "stage-pending" };
  }
}

/**
 * Transforms a clearinghouse transaction record into the 7 standard procurement milestone tasks
 */
export function mapRecordToGanttTasks(
  record: ClearinghouseRecord,
  options?: GanttMapperOptions,
): ProcurementGanttTask[] {
  const fallbackNow = new Date();
  const createdDate = parseDateSafe(record.createdAt, fallbackNow);
  const updatedDate = parseDateSafe(record.updatedAt, createdDate);
  const refDate = options?.referenceDate
    ? parseDateSafe(options.referenceDate, updatedDate)
    : updatedDate;

  let currentBaselineStart = createdDate;
  let currentActualStart = createdDate;

  const tasks: ProcurementGanttTask[] = [];

  for (let i = 0; i < PROCUREMENT_STAGES.length; i++) {
    const stage = PROCUREMENT_STAGES[i];
    const def = STAGE_DEFINITIONS[stage];

    // Compute baseline interval
    const baselineStart = currentBaselineStart;
    const baselineEnd = addHours(baselineStart, def.baselineDurationHours);
    currentBaselineStart = baselineEnd;

    const baselines: GanttBaseline[] = [
      {
        startDate: baselineStart.toISOString(),
        endDate: baselineEnd.toISOString(),
        duration: def.baselineDurationHours,
        durationUnit: "h",
      },
    ];

    // Compute actual stage lifecycle status and progress
    const { status, percentDone, cls } = determineStageStatusAndProgress(stage, record);

    const actualStart = currentActualStart;
    let actualEnd: Date;
    let actualDurationHours: number;

    if (status === "COMPLETED") {
      actualDurationHours = def.baselineDurationHours;
      actualEnd = addHours(actualStart, actualDurationHours);
      currentActualStart = actualEnd;
    } else if (status === "IN_PROGRESS") {
      const elapsedHours = Math.max(
        0.1,
        (refDate.getTime() - actualStart.getTime()) / (3600 * 1000),
      );
      actualDurationHours = Math.max(elapsedHours, def.baselineDurationHours);
      actualEnd = addHours(actualStart, actualDurationHours);
      currentActualStart = actualEnd;
    } else {
      // PENDING / VOIDED / BREACHED
      actualEnd = addHours(actualStart, def.baselineDurationHours);
      actualDurationHours = def.baselineDurationHours;
      currentActualStart = actualEnd;
    }

    const taskId = `${record.transactionId}-${stage}`;

    // Detect carrier tracking status if present on record or fallback to escrow status
    const rawCarrierStatus =
      (record as Record<string, unknown>).carrierStatus ||
      (record as Record<string, unknown>).carrier_status ||
      (record as Record<string, unknown>).trackingStatus;

    const carrierStatus: CarrierTrackingStatus | string | undefined =
      stage === "IN_TRANSIT"
        ? (rawCarrierStatus as CarrierTrackingStatus) ||
          (record.escrowStatus === "IN_TRANSIT"
            ? "IN_TRANSIT"
            : record.escrowStatus === "DELIVERED_CAPTURED"
              ? "DELIVERED"
              : undefined)
        : undefined;

    tasks.push({
      id: taskId,
      name: def.name,
      stage,
      transactionId: record.transactionId,
      startDate: actualStart.toISOString(),
      endDate: actualEnd.toISOString(),
      duration: actualDurationHours,
      durationUnit: "h",
      percentDone,
      status,
      milestone: def.isMilestone,
      cls,
      baselines,
      merchantDomain: record.merchantDomain,
      carrier: record.carrier,
      trackingId: record.trackingId,
      carrierStatus,
      riskScore: record.riskScore,
      disputeReason: record.disputeReason,
    });
  }

  return tasks;
}

/**
 * Creates 6 Finish-to-Start dependencies linking consecutive stages:
 * 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7
 */
export function mapRecordToGanttDependencies(
  record: ClearinghouseRecord,
): ProcurementGanttDependency[] {
  const dependencies: ProcurementGanttDependency[] = [];

  for (let i = 0; i < PROCUREMENT_STAGES.length - 1; i++) {
    const fromStage = PROCUREMENT_STAGES[i];
    const toStage = PROCUREMENT_STAGES[i + 1];

    const fromId = `${record.transactionId}-${fromStage}`;
    const toId = `${record.transactionId}-${toStage}`;

    dependencies.push({
      id: `${record.transactionId}-dep-${i + 1}-${i + 2}`,
      from: fromId,
      to: toId,
      fromEvent: fromId,
      toEvent: toId,
      type: BryntumDependencyType.FinishToStart,
    });
  }

  return dependencies;
}

/**
 * Calculates critical path task IDs for a procurement project tree.
 * In a Finish-to-Start sequential chain, all remaining in-flight tasks
 * leading directly to final settlement form the critical path.
 */
export function calculateCriticalPath(
  tasks: ProcurementGanttTask[],
  _dependencies?: ProcurementGanttDependency[],
): string[] {
  // If all tasks are completed, voided, or breached (aborted order), critical path is empty
  const allCompletedOrClosed = tasks.every(
    (t) => t.status === "COMPLETED" || t.status === "VOIDED" || t.status === "BREACHED",
  );
  if (allCompletedOrClosed) {
    return [];
  }

  // Find the first non-completed active task
  let firstActiveIndex = -1;
  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].status !== "COMPLETED") {
      firstActiveIndex = i;
      break;
    }
  }

  if (firstActiveIndex === -1) {
    return [];
  }

  const criticalIds: string[] = [];
  for (let i = firstActiveIndex; i < tasks.length; i++) {
    const task = tasks[i];
    if (task.status !== "VOIDED" && task.status !== "BREACHED") {
      criticalIds.push(task.id);
    }
  }

  return criticalIds;
}

/**
 * Computes baseline variance comparison for a task
 */
export function computeBaselineComparison(task: ProcurementGanttTask): {
  baselineDuration: number;
  actualDuration: number;
  varianceHours: number;
  isOverdue: boolean;
} {
  const baseline = task.baselines?.[0];
  const baselineDuration = baseline?.duration ?? task.duration;
  const actualDuration = task.duration;
  const varianceHours = actualDuration - baselineDuration;
  const isOverdue = varianceHours > 0 && task.status !== "COMPLETED";

  return {
    baselineDuration,
    actualDuration,
    varianceHours,
    isOverdue,
  };
}

/**
 * Maps a single Clearinghouse Record into a complete Gantt project data tree
 */
export function mapRecordToGanttProject(
  record: ClearinghouseRecord,
  options?: GanttMapperOptions,
): ProcurementGanttProjectData {
  const childTasks = mapRecordToGanttTasks(record, options);
  const dependencies = mapRecordToGanttDependencies(record);

  const calculateCritical = options?.calculateCriticalPath ?? true;
  const criticalPathTaskIds = calculateCritical
    ? calculateCriticalPath(childTasks, dependencies)
    : [];

  const criticalSet = new Set(criticalPathTaskIds);

  // Apply critical path styling to tasks
  for (const task of childTasks) {
    if (criticalSet.has(task.id)) {
      task.critical = true;
      task.cls = `${task.cls || ""} b-critical-path b-critical-path-task`.trim();
    }
  }

  const includeRoot = options?.includeSummaryRoot ?? true;

  if (includeRoot) {
    const firstTask = childTasks[0];
    const lastTask = childTasks[childTasks.length - 1];

    const totalDuration = childTasks.reduce((sum, t) => sum + t.duration, 0);
    const avgProgress = Math.round(
      childTasks.reduce((sum, t) => sum + t.percentDone, 0) / childTasks.length,
    );

    const rootTask: ProcurementGanttTask = {
      id: record.transactionId,
      name: `Procurement Order: ${record.transactionId} (${record.merchantDomain})`,
      transactionId: record.transactionId,
      startDate: firstTask.startDate,
      endDate: lastTask.endDate,
      duration: totalDuration,
      durationUnit: "h",
      percentDone: avgProgress,
      status:
        record.clearinghouseState === "SETTLED"
          ? "COMPLETED"
          : record.escrowStatus === "SLA_BREACH_VOIDED"
            ? "BREACHED"
            : "IN_PROGRESS",
      milestone: false,
      expanded: true,
      children: childTasks,
      merchantDomain: record.merchantDomain,
      riskScore: record.riskScore,
      carrier: record.carrier,
      trackingId: record.trackingId,
    };

    return {
      tasksData: [rootTask],
      dependenciesData: dependencies,
      criticalPathTaskIds,
    };
  }

  return {
    tasksData: childTasks,
    dependenciesData: dependencies,
    criticalPathTaskIds,
  };
}

/**
 * Maps an array of clearinghouse records into a unified Gantt project dataset
 */
export function mapRecordsToGanttProject(
  records: ClearinghouseRecord[],
  options?: GanttMapperOptions,
): ProcurementGanttProjectData {
  const allTasks: ProcurementGanttTask[] = [];
  const allDependencies: ProcurementGanttDependency[] = [];
  const allCriticalIds: string[] = [];

  for (const record of records) {
    const project = mapRecordToGanttProject(record, {
      ...options,
      includeSummaryRoot: true,
    });
    allTasks.push(...project.tasksData);
    allDependencies.push(...project.dependenciesData);
    allCriticalIds.push(...project.criticalPathTaskIds);
  }

  return {
    tasksData: allTasks,
    dependenciesData: allDependencies,
    criticalPathTaskIds: allCriticalIds,
  };
}
