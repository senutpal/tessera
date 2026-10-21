import type { ICellRendererParams } from "ag-grid-community";
import type React from "react";
import { useState } from "react";
import type { ClearinghouseRecord, HitlActionType } from "../../types.js";

export interface ActionCellRendererProps extends Partial<ICellRendererParams<ClearinghouseRecord>> {
  record?: ClearinghouseRecord;
  apiBaseUrl?: string;
  onApprove?: (record: ClearinghouseRecord) => Promise<void>;
  onVoid?: (record: ClearinghouseRecord) => Promise<void>;
  onDispute?: (record: ClearinghouseRecord) => Promise<void>;
}

export const ActionCellRenderer: React.FC<ActionCellRendererProps> = (props) => {
  const record = props.record ?? props.data;
  const [activeAction, setActiveAction] = useState<HitlActionType | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!record) {
    return <span className="text-slate-600 text-xs">-</span>;
  }

  const rawApiBaseUrl = props.apiBaseUrl ?? props.context?.apiBaseUrl ?? "http://localhost:3000";
  const apiBaseUrl = rawApiBaseUrl.replace(/\/+$/, "");

  const isTerminal =
    record.clearinghouseState === "SETTLED" ||
    record.clearinghouseState === "VOIDED" ||
    record.clearinghouseState === "REFUNDED" ||
    record.clearinghouseState === "FAILED" ||
    record.escrowStatus === "SLA_BREACH_VOIDED" ||
    record.escrowStatus === "DELIVERED_CAPTURED";

  const isApproved = record.hitlStatus === "APPROVED";
  const isVoided =
    record.clearinghouseState === "VOIDED" || record.escrowStatus === "SLA_BREACH_VOIDED";
  const isDisputed = record.clearinghouseState === "DISPUTED";

  const executeAction = async (action: HitlActionType) => {
    if (activeAction) return;
    if (action === "counter-sign" && (isTerminal || isApproved)) return;
    if (action === "void" && (isTerminal || isVoided)) return;
    if (action === "dispute" && (isTerminal || isDisputed)) return;

    setActiveAction(action);
    setErrorMsg(null);

    try {
      const encodedMandateId = encodeURIComponent(record.mandateId);
      if (action === "counter-sign") {
        if (props.onApprove) {
          await props.onApprove(record);
        } else if (props.context?.onApprove) {
          await props.context.onApprove(record);
        } else {
          const res = await fetch(
            `${apiBaseUrl}/api/v1/mandates/${encodedMandateId}/counter-sign`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                transactionId: record.transactionId,
                supervisorDecision: "APPROVED",
                timestamp: new Date().toISOString(),
              }),
            },
          );
          if (!res.ok) {
            throw new Error(`Counter-sign failed: HTTP ${res.status}`);
          }
        }
      } else if (action === "void") {
        if (props.onVoid) {
          await props.onVoid(record);
        } else if (props.context?.onVoid) {
          await props.context.onVoid(record);
        } else {
          const res = await fetch(`${apiBaseUrl}/api/v1/mandates/${encodedMandateId}/void`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transactionId: record.transactionId,
              reason: "SUPERVISOR_SLA_VOID",
              timestamp: new Date().toISOString(),
            }),
          });
          if (!res.ok) {
            throw new Error(`Void failed: HTTP ${res.status}`);
          }
        }
      } else if (action === "dispute") {
        if (props.onDispute) {
          await props.onDispute(record);
        } else if (props.context?.onDispute) {
          await props.context.onDispute(record);
        } else {
          const res = await fetch(`${apiBaseUrl}/api/v1/mandates/${encodedMandateId}/dispute`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transactionId: record.transactionId,
              reason: "SUPERVISOR_DISPUTE_ESCALATION",
              timestamp: new Date().toISOString(),
            }),
          });
          if (!res.ok) {
            throw new Error(`Dispute escalation failed: HTTP ${res.status}`);
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Action failed";
      setErrorMsg(msg);
      console.error(`[ActionCellRenderer] ${action} error:`, err);
    } finally {
      setActiveAction(null);
    }
  };

  return (
    <div
      data-testid="action-cell"
      className="inline-flex items-center gap-1.5 py-1 font-sans text-xs"
    >
      {/* 1-Click HITL Approve / Counter-Sign */}
      <button
        type="button"
        data-testid="action-approve"
        aria-label="Approve Counter-sign"
        disabled={activeAction !== null || isTerminal || isApproved}
        onClick={(e) => {
          e.stopPropagation();
          executeAction("counter-sign");
        }}
        className={`px-2.5 py-1 rounded-md font-medium text-xs border transition-all duration-150 flex items-center gap-1.5 whitespace-nowrap ${
          activeAction === "counter-sign"
            ? "bg-emerald-100 dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-400 border-emerald-300 dark:border-emerald-500/50 cursor-wait"
            : isTerminal || isApproved
              ? "bg-zinc-100 dark:bg-zinc-900/40 text-zinc-400 dark:text-zinc-600 border-zinc-200 dark:border-zinc-800/40 cursor-not-allowed opacity-40"
              : "bg-emerald-50 dark:bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/20 hover:bg-emerald-100 dark:hover:bg-emerald-500/[0.15] hover:border-emerald-300 dark:hover:border-emerald-500/40 active:scale-[0.98]"
        }`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            activeAction === "counter-sign"
              ? "bg-emerald-500 dark:bg-emerald-400 animate-pulse"
              : isApproved
                ? "bg-zinc-400 dark:bg-zinc-600"
                : "bg-emerald-500 dark:bg-emerald-400"
          }`}
        />
        <span>
          {activeAction === "counter-sign" ? "Approving..." : isApproved ? "Approved" : "Approve"}
        </span>
      </button>

      {/* 1-Click HITL Void Escrow */}
      <button
        type="button"
        data-testid="action-void"
        aria-label="Void Escrow"
        disabled={activeAction !== null || isTerminal || isVoided}
        onClick={(e) => {
          e.stopPropagation();
          executeAction("void");
        }}
        className={`px-2.5 py-1 rounded-md font-medium text-xs border transition-all duration-150 flex items-center gap-1.5 whitespace-nowrap ${
          activeAction === "void"
            ? "bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-400 border-amber-300 dark:border-amber-500/50 cursor-wait"
            : isTerminal || isVoided
              ? "bg-zinc-100 dark:bg-zinc-900/40 text-zinc-400 dark:text-zinc-600 border-zinc-200 dark:border-zinc-800/40 cursor-not-allowed opacity-40"
              : "bg-amber-50 dark:bg-amber-500/[0.08] text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-500/20 hover:bg-amber-100 dark:hover:bg-amber-500/[0.15] hover:border-amber-300 dark:hover:border-amber-500/40 active:scale-[0.98]"
        }`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            activeAction === "void"
              ? "bg-amber-500 dark:bg-amber-400 animate-pulse"
              : isVoided
                ? "bg-zinc-400 dark:bg-zinc-600"
                : "bg-amber-500 dark:bg-amber-400"
          }`}
        />
        <span>{activeAction === "void" ? "Voiding..." : isVoided ? "Voided" : "Void Escrow"}</span>
      </button>

      {/* 1-Click HITL Dispute Escalation */}
      <button
        type="button"
        data-testid="action-dispute"
        aria-label="Dispute Escalation"
        disabled={activeAction !== null || isTerminal || isDisputed}
        onClick={(e) => {
          e.stopPropagation();
          executeAction("dispute");
        }}
        className={`px-2.5 py-1 rounded-md font-medium text-xs border transition-all duration-150 flex items-center gap-1.5 whitespace-nowrap ${
          activeAction === "dispute"
            ? "bg-rose-100 dark:bg-rose-950/60 text-rose-800 dark:text-rose-400 border-rose-300 dark:border-rose-500/50 cursor-wait"
            : isTerminal || isDisputed
              ? "bg-zinc-100 dark:bg-zinc-900/40 text-zinc-400 dark:text-zinc-600 border-zinc-200 dark:border-zinc-800/40 cursor-not-allowed opacity-40"
              : "bg-rose-50 dark:bg-rose-500/[0.08] text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-500/20 hover:bg-rose-100 dark:hover:bg-rose-500/[0.15] hover:border-rose-300 dark:hover:border-rose-500/40 active:scale-[0.98]"
        }`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            activeAction === "dispute"
              ? "bg-rose-500 dark:bg-rose-400 animate-pulse"
              : isDisputed
                ? "bg-zinc-400 dark:bg-zinc-600"
                : "bg-rose-500 dark:bg-rose-400"
          }`}
        />
        <span>
          {activeAction === "dispute" ? "Escalating..." : isDisputed ? "Disputed" : "Dispute"}
        </span>
      </button>

      {errorMsg && (
        <span
          data-testid="action-error"
          title={errorMsg}
          className="text-rose-600 dark:text-rose-400 text-[10px] ml-1 font-mono"
        >
          !
        </span>
      )}
    </div>
  );
};
