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

  if (tier === "low") {
    tierLabel = "LOW";
    badgeStyle = "text-emerald-400 bg-emerald-950/60 border-emerald-800/80 hover:bg-emerald-900/40";
    barColor = "bg-emerald-500";
  } else if (tier === "elevated") {
    tierLabel = "ELEVATED";
    badgeStyle = "text-amber-400 bg-amber-950/60 border-amber-800/80 hover:bg-amber-900/40";
    barColor = "bg-amber-500";
  } else {
    tierLabel = "CRITICAL";
    badgeStyle =
      "text-rose-400 bg-rose-950/60 border-rose-800/80 hover:bg-rose-900/40 animate-pulse";
    barColor = "bg-rose-500";
  }

  return (
    <div
      data-testid="risk-cell"
      data-risk-tier={tier}
      data-risk-score={clampedScore}
      className={`inline-flex items-center gap-2 px-2.5 py-1 rounded border text-xs font-mono font-medium transition-colors ${badgeStyle}`}
    >
      <div className="w-1.5 h-1.5 rounded-full shrink-0 animate-ping opacity-75" />
      <span className="font-semibold">{clampedScore}</span>
      <span className="text-[10px] opacity-75 uppercase tracking-wider">{tierLabel}</span>
      <div className="w-12 h-1.5 bg-slate-800 rounded-full overflow-hidden shrink-0 ml-1">
        <div className={`h-full ${barColor}`} style={{ width: `${clampedScore}%` }} />
      </div>
    </div>
  );
};
