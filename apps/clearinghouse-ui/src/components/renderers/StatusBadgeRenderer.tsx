import type { ICellRendererParams } from "ag-grid-community";
import type React from "react";
import type { ClearinghouseRecord } from "../../types.js";

export interface StatusBadgeRendererProps
  extends Partial<ICellRendererParams<ClearinghouseRecord, string>> {
  status?: string;
  type?: "clearinghouseState" | "escrowStatus" | "hitlStatus" | "riskTier";
}

export const StatusBadgeRenderer: React.FC<StatusBadgeRendererProps> = (props) => {
  const rawStatus = props.status ?? props.value ?? String(props.data?.clearinghouseState ?? "");
  const status = String(rawStatus || "UNKNOWN").toUpperCase();

  let colorClasses = "bg-slate-800 text-slate-300 border-slate-700";

  switch (status) {
    case "SETTLED":
    case "DELIVERED_CAPTURED":
    case "APPROVED":
    case "LOW":
      colorClasses = "bg-emerald-950/70 text-emerald-300 border-emerald-700/80";
      break;

    case "AUTHORIZED_IN_ESCROW":
    case "AUTHORIZED_HOLD":
    case "IN_TRANSIT":
    case "FULFILLED_DELIVERED":
      colorClasses = "bg-cyan-950/70 text-cyan-300 border-cyan-700/80";
      break;

    case "PENDING_AUTHORIZATION":
    case "AWAITING_FULFILLMENT":
    case "PENDING_APPROVAL":
    case "ELEVATED":
      colorClasses = "bg-amber-950/70 text-amber-300 border-amber-700/80";
      break;

    case "DISPUTED":
    case "VOIDED":
    case "FAILED":
    case "SLA_BREACH_VOIDED":
    case "REFUNDED":
    case "REJECTED":
    case "CRITICAL_HITL":
      colorClasses = "bg-rose-950/70 text-rose-300 border-rose-700/80";
      break;

    default:
      colorClasses = "bg-slate-900 text-slate-400 border-slate-800";
      break;
  }

  // Format label: remove underscores, title case
  const formattedLabel = status.replace(/_/g, " ");

  return (
    <span
      data-testid="status-badge"
      data-status={status}
      className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono font-medium border uppercase tracking-wider ${colorClasses}`}
    >
      {formattedLabel}
    </span>
  );
};
