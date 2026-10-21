import type { ICellRendererParams } from "ag-grid-community";
import type React from "react";
import type { ClearinghouseRecord } from "../../types.js";

export interface StatusBadgeRendererProps
  extends Partial<ICellRendererParams<ClearinghouseRecord, string>> {
  status?: string;
  type?: "clearinghouseState" | "escrowStatus" | "hitlStatus" | "riskTier";
}

export const StatusBadgeRenderer: React.FC<StatusBadgeRendererProps> = (props) => {
  const colField = (props.colDef?.field as keyof ClearinghouseRecord | undefined) ?? props.type;
  const dataValue = colField && props.data ? String(props.data[colField] ?? "") : undefined;
  const rawStatus = props.status ?? props.value ?? dataValue ?? "";
  const status = String(rawStatus || "UNKNOWN").toUpperCase();

  let colorClasses =
    "bg-zinc-500/[0.06] dark:bg-zinc-500/[0.08] text-zinc-600 dark:text-slate-400 border-zinc-500/20 dark:border-zinc-500/20";
  let dotColor = "bg-zinc-400 dark:bg-zinc-500";

  switch (status) {
    case "SETTLED":
    case "DELIVERED_CAPTURED":
    case "APPROVED":
    case "LOW":
      colorClasses =
        "bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300 border-emerald-500/20 dark:border-emerald-500/20";
      dotColor = "bg-emerald-500 dark:bg-emerald-400";
      break;

    case "AUTHORIZED_IN_ESCROW":
    case "AUTHORIZED_HOLD":
    case "IN_TRANSIT":
    case "FULFILLED_DELIVERED":
      colorClasses =
        "bg-cyan-500/[0.06] dark:bg-cyan-500/[0.08] text-cyan-700 dark:text-cyan-300 border-cyan-500/20 dark:border-cyan-500/20";
      dotColor = "bg-cyan-500 dark:bg-cyan-400";
      break;

    case "PENDING_AUTHORIZATION":
    case "AWAITING_FULFILLMENT":
    case "PENDING_APPROVAL":
    case "ELEVATED":
      colorClasses =
        "bg-amber-500/[0.06] dark:bg-amber-500/[0.08] text-amber-700 dark:text-amber-300 border-amber-500/20 dark:border-amber-500/20";
      dotColor = "bg-amber-500 dark:bg-amber-400";
      break;

    case "DISPUTED":
    case "VOIDED":
    case "FAILED":
    case "SLA_BREACH_VOIDED":
    case "REFUNDED":
    case "REJECTED":
    case "CRITICAL_HITL":
      colorClasses =
        "bg-rose-500/[0.06] dark:bg-rose-500/[0.08] text-rose-700 dark:text-rose-300 border-rose-500/20 dark:border-rose-500/20";
      dotColor = "bg-rose-500 dark:bg-rose-400";
      break;

    default:
      colorClasses =
        "bg-zinc-500/[0.06] dark:bg-zinc-500/[0.08] text-zinc-600 dark:text-slate-400 border-zinc-500/20 dark:border-zinc-500/20";
      dotColor = "bg-zinc-400 dark:bg-zinc-500";
      break;
  }

  // Format label: remove underscores, title case
  const formattedLabel = status.replace(/_/g, " ");

  return (
    <span
      data-testid="status-badge"
      data-status={status}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-mono tracking-tight font-medium border uppercase whitespace-nowrap transition-colors ${colorClasses}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor} opacity-75`} />
      <span>{formattedLabel}</span>
    </span>
  );
};
