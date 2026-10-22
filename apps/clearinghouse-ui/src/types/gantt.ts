/**
 * 7 Standard Autonomous Procurement Lifecycle Stages
 * Grounded in AP2 cryptographic mandates, Channel3 discovery,
 * PayPal Orders v2 escrow holds, and PayPal Shipment Tracking v1.
 */
export type ProcurementStage =
  | "MANDATE_VERIFIED"
  | "CATALOG_DISCOVERY"
  | "ESCROW_HOLD"
  | "MERCHANT_DISPATCH"
  | "IN_TRANSIT"
  | "DELIVERY_VERIFIED"
  | "ESCROW_CAPTURED";

export const PROCUREMENT_STAGES: readonly ProcurementStage[] = [
  "MANDATE_VERIFIED",
  "CATALOG_DISCOVERY",
  "ESCROW_HOLD",
  "MERCHANT_DISPATCH",
  "IN_TRANSIT",
  "DELIVERY_VERIFIED",
  "ESCROW_CAPTURED",
] as const;

/**
 * Human-readable metadata and contract defaults for each procurement stage.
 */
export interface StageDefinition {
  stage: ProcurementStage;
  name: string;
  shortCode: string;
  baselineDurationHours: number;
  maxSlaDurationHours: number;
  isMilestone: boolean;
  description: string;
}

export const STAGE_DEFINITIONS: Record<ProcurementStage, StageDefinition> = {
  MANDATE_VERIFIED: {
    stage: "MANDATE_VERIFIED",
    name: "Mandate Verification",
    shortCode: "MAN_VER",
    baselineDurationHours: 0.5,
    maxSlaDurationHours: 1.0,
    isMilestone: true,
    description: "AP2 cryptographic mandate validation and Ed25519 signature verification",
  },
  CATALOG_DISCOVERY: {
    stage: "CATALOG_DISCOVERY",
    name: "Catalog Discovery",
    shortCode: "CAT_DISC",
    baselineDurationHours: 2.0,
    maxSlaDurationHours: 4.0,
    isMilestone: false,
    description: "Channel3 multi-retailer quotation search and price optimization",
  },
  ESCROW_HOLD: {
    stage: "ESCROW_HOLD",
    name: "Escrow Authorization Hold",
    shortCode: "ESC_HOLD",
    baselineDurationHours: 1.5,
    maxSlaDurationHours: 3.0,
    isMilestone: false,
    description: "PayPal Orders v2 authorization hold placed on buyer funds",
  },
  MERCHANT_DISPATCH: {
    stage: "MERCHANT_DISPATCH",
    name: "Merchant Fulfillment & Dispatch",
    shortCode: "MCH_DISP",
    baselineDurationHours: 24.0,
    maxSlaDurationHours: 48.0,
    isMilestone: false,
    description: "Merchant order processing, packaging, and carrier registration",
  },
  IN_TRANSIT: {
    stage: "IN_TRANSIT",
    name: "Carrier Transit Tracking",
    shortCode: "IN_TRAN",
    baselineDurationHours: 48.0,
    maxSlaDurationHours: 72.0,
    isMilestone: false,
    description: "Multi-hop carrier transit telemetry monitored via PayPal Shipment Tracking v1",
  },
  DELIVERY_VERIFIED: {
    stage: "DELIVERY_VERIFIED",
    name: "Delivery Verification",
    shortCode: "DEL_VER",
    baselineDurationHours: 1.0,
    maxSlaDurationHours: 2.0,
    isMilestone: true,
    description: "Carrier signed proof of delivery and autonomous clearinghouse verification",
  },
  ESCROW_CAPTURED: {
    stage: "ESCROW_CAPTURED",
    name: "Escrow Capture & Settlement",
    shortCode: "ESC_CAPT",
    baselineDurationHours: 0.5,
    maxSlaDurationHours: 1.0,
    isMilestone: true,
    description: "PayPal authorization capture release and financial ledger finalization",
  },
};

/**
 * Carrier shipment statuses grounded directly in PayPal Tracking v1 OpenAPI specification:
 * `references/paypal-rest-api-specifications/openapi/shipping_shipment_tracking_v1.json`
 */
export type CarrierTrackingStatus =
  | "CANCELLED"
  | "DELIVERED"
  | "LOCAL_PICKUP"
  | "ON_HOLD"
  | "SHIPPED"
  | "SHIPMENT_CREATED"
  | "DROPPED_OFF"
  | "IN_TRANSIT"
  | "RETURNED"
  | "LABEL_PRINTED"
  | "ERROR"
  | "UNCONFIRMED"
  | "PICKUP_FAILED"
  | "DELIVERY_DELAYED"
  | "DELIVERY_SCHEDULED"
  | "DELIVERY_FAILED"
  | "INRETURN"
  | "IN_PROCESS"
  | "NEW"
  | "VOID"
  | "PROCESSED"
  | "NOT_SHIPPED"
  | "COMPLETED";

/**
 * Status of individual Gantt tasks in the procurement schedule
 */
export type GanttTaskStatus =
  | "COMPLETED"
  | "IN_PROGRESS"
  | "PENDING"
  | "BREACHED"
  | "VOIDED"
  | "DISPUTED";

/**
 * Bryntum Gantt Baseline model representing contracted SLA baseline
 */
export interface GanttBaseline {
  startDate: string;
  endDate: string;
  duration: number;
  durationUnit?: "h" | "d" | undefined;
}

/**
 * Bryntum Gantt Task Model for procurement milestones and summary tasks
 */
export interface ProcurementGanttTask {
  id: string;
  name: string;
  stage?: ProcurementStage | undefined;
  transactionId: string;
  startDate: string;
  endDate: string;
  duration: number;
  durationUnit: "h" | "d";
  percentDone: number;
  status: GanttTaskStatus;
  milestone: boolean;
  critical?: boolean | undefined;
  cls?: string | undefined;
  iconCls?: string | undefined;
  baselines?: GanttBaseline[] | undefined;
  children?: ProcurementGanttTask[] | undefined;
  expanded?: boolean | undefined;
  // Domain metadata
  merchantDomain?: string | undefined;
  carrier?: string | undefined;
  trackingId?: string | undefined;
  carrierStatus?: CarrierTrackingStatus | string | undefined;
  riskScore?: number | undefined;
  disputeReason?: string | undefined;
  slaWarning?: boolean | undefined;
  slaWarningMessage?: string | undefined;
  slaSeverity?: SlaSeverity | undefined;
  [key: string]: unknown;
}

/**
 * Bryntum Gantt Dependency Types:
 * 0 = Start-to-Start (SS)
 * 1 = Start-to-Finish (SF)
 * 2 = Finish-to-Start (FS)
 * 3 = Finish-to-Finish (FF)
 */
export enum BryntumDependencyType {
  StartToStart = 0,
  StartToFinish = 1,
  FinishToStart = 2,
  FinishToFinish = 3,
}

/**
 * Bryntum Gantt Dependency Model linking dependent procurement milestones
 */
export interface ProcurementGanttDependency {
  id: string;
  from: string;
  to: string;
  fromEvent?: string | undefined;
  toEvent?: string | undefined;
  type: 2 | BryntumDependencyType | number;
  cls?: string | undefined;
  lag?: number | undefined;
  lagUnit?: "h" | "d" | undefined;
  critical?: boolean | undefined;
}

/**
 * Complete project tree and dependency graph consumable by Bryntum Gantt Pro
 */
export interface ProcurementGanttProjectData {
  tasksData: ProcurementGanttTask[];
  dependenciesData: ProcurementGanttDependency[];
  criticalPathTaskIds: string[];
}

/**
 * SLA Delay & Breach Severities
 */
export type SlaSeverity = "INFO" | "WARNING" | "CRITICAL";

/**
 * Actionable event emitted when a milestone violates contracted SLA
 */
export interface SlaDelayWarning {
  id: string;
  transactionId: string;
  stage: ProcurementStage;
  severity: SlaSeverity;
  message: string;
  allocatedDurationHours: number;
  actualDurationHours: number;
  delayHours: number;
  carrierStatus?: string | undefined;
  carrier?: string | undefined;
  trackingId?: string | undefined;
  merchantDomain?: string | undefined;
  timestamp: string;
  actionRecommended?:
    | "NONE"
    | "NOTIFY_BUYER"
    | "SUPERVISOR_REVIEW"
    | "VOID_AUTHORIZATION"
    | "STAGE_PAYPAL_DISPUTE"
    | undefined;
}

/**
 * Result of SLA compliance evaluation for a single record or task tree
 */
export interface SlaEvaluationResult {
  transactionId: string;
  isBreached: boolean;
  warnings: SlaDelayWarning[];
  maxSeverity: SlaSeverity | null;
  totalDelayHours: number;
}

/**
 * Options for mapping Clearinghouse records to Gantt tasks
 */
export interface GanttMapperOptions {
  referenceDate?: Date | string | undefined;
  includeSummaryRoot?: boolean | undefined;
  calculateCriticalPath?: boolean | undefined;
}
