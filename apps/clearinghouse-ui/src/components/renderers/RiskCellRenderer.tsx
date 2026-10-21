import type { ICellRendererParams } from "ag-grid-community";
import type React from "react";
import type { ClearinghouseRecord, RiskLevel } from "../../types.js";
import { getRiskLevel } from "../../types.js";

export interface RiskCellRendererProps
  extends Partial<ICellRendererParams<ClearinghouseRecord, number>> {
  score?: number;
}

export const RiskCellRenderer: React.FC<RiskCellRendererProps> = (props) => {
  const rawScore = props.score ?? props.value ?? props.data?.riskScore ?? 0;
  const score = typeof rawScore === "number" && !Number.isNaN(rawScore) ? rawScore : 0;
  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
  const tier: RiskLevel = getRiskLevel(clampedScore);

  let tierLabel: string;
  let badgeStyle: string;
  let barColor: string;
  let dotColor: string;

  if (tier === "low") {
    tierLabel = "LOW";
    badgeStyle =
      "text-emerald-700 dark:text-emerald-400 bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08] border-emerald-500/20 dark:border-emerald-500/20";
    barColor = "bg-emerald-500 dark:bg-emerald-400";
    dotColor = "bg-emerald-500 dark:bg-emerald-400";
  } else if (tier === "elevated") {
    tierLabel = "ELEVATED";
    badgeStyle =
      "text-amber-700 dark:text-amber-400 bg-amber-500/[0.06] dark:bg-amber-500/[0.08] border-amber-500/20 dark:border-amber-500/20";
    barColor = "bg-amber-500 dark:bg-amber-400";
    dotColor = "bg-amber-500 dark:bg-amber-400";
  } else {
    tierLabel = "CRITICAL";
    badgeStyle =
      "text-rose-700 dark:text-rose-400 bg-rose-500/[0.06] dark:bg-rose-500/[0.08] border-rose-500/20 dark:border-rose-500/20 animate-pulse";
    barColor = "bg-rose-500 dark:bg-rose-400";
    dotColor = "bg-rose-500 dark:bg-rose-400";
  }

  return (
    <div
      data-testid="risk-cell"
      data-risk-tier={tier}
      data-risk-score={clampedScore}
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 border text-[11px] font-mono tracking-tight font-medium transition-colors whitespace-nowrap ${badgeStyle}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor} opacity-75`} />
      <span className="font-semibold tabular-nums">{clampedScore}</span>
      <span className="text-[10px] opacity-70 uppercase tracking-wider font-mono">{tierLabel}</span>
      <div className="w-8 h-1 bg-zinc-200/80 dark:bg-zinc-800/80 rounded-full overflow-hidden shrink-0 ml-0.5">
        <div
          className={`h-full ${barColor} transition-all duration-300 ease-out`}
          style={{ width: `${clampedScore}%` }}
        />
      </div>
    </div>
  );
};
