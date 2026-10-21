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

  const apiBaseUrl = props.apiBaseUrl ?? props.context?.apiBaseUrl ?? "http://localhost:3000";

  const executeAction = async (action: HitlActionType) => {
    if (activeAction) return;
    setActiveAction(action);
    setErrorMsg(null);

    try {
      if (action === "counter-sign") {
        if (props.onApprove) {
          await props.onApprove(record);
        } else if (props.context?.onApprove) {
          await props.context.onApprove(record);
        } else {
          const res = await fetch(
            `${apiBaseUrl}/api/v1/mandates/${record.mandateId}/counter-sign`,
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
          const res = await fetch(`${apiBaseUrl}/api/v1/mandates/${record.mandateId}/void`, {
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
          const res = await fetch(`${apiBaseUrl}/api/v1/mandates/${record.mandateId}/dispute`, {
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

  const isTerminal =
    record.clearinghouseState === "SETTLED" ||
    record.clearinghouseState === "VOIDED" ||
    record.clearinghouseState === "REFUNDED";

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
        disabled={activeAction !== null || isTerminal}
        onClick={() => executeAction("counter-sign")}
        className={`px-2 py-1 rounded font-medium text-xs border transition-colors flex items-center gap-1 ${
          activeAction === "counter-sign"
            ? "bg-emerald-950 text-emerald-400 border-emerald-600 animate-pulse cursor-wait"
            : isTerminal
              ? "bg-slate-900 text-slate-600 border-slate-800 cursor-not-allowed opacity-50"
              : "bg-emerald-950/80 text-emerald-300 border-emerald-700/80 hover:bg-emerald-900 hover:text-emerald-200 active:scale-95"
        }`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        {activeAction === "counter-sign" ? "Approving..." : "Approve"}
      </button>

      {/* 1-Click HITL Void Escrow */}
      <button
        type="button"
        data-testid="action-void"
        aria-label="Void Escrow"
        disabled={activeAction !== null || isTerminal}
        onClick={() => executeAction("void")}
        className={`px-2 py-1 rounded font-medium text-xs border transition-colors flex items-center gap-1 ${
          activeAction === "void"
            ? "bg-amber-950 text-amber-400 border-amber-600 animate-pulse cursor-wait"
            : isTerminal
              ? "bg-slate-900 text-slate-600 border-slate-800 cursor-not-allowed opacity-50"
              : "bg-amber-950/80 text-amber-300 border-amber-700/80 hover:bg-amber-900 hover:text-amber-200 active:scale-95"
        }`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
        {activeAction === "void" ? "Voiding..." : "Void Escrow"}
      </button>

      {/* 1-Click HITL Dispute Escalation */}
      <button
        type="button"
        data-testid="action-dispute"
        aria-label="Dispute Escalation"
        disabled={activeAction !== null || record.clearinghouseState === "DISPUTED"}
        onClick={() => executeAction("dispute")}
        className={`px-2 py-1 rounded font-medium text-xs border transition-colors flex items-center gap-1 ${
          activeAction === "dispute"
            ? "bg-rose-950 text-rose-400 border-rose-600 animate-pulse cursor-wait"
            : record.clearinghouseState === "DISPUTED"
              ? "bg-slate-900 text-slate-600 border-slate-800 cursor-not-allowed opacity-50"
              : "bg-rose-950/80 text-rose-300 border-rose-700/80 hover:bg-rose-900 hover:text-rose-200 active:scale-95"
        }`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
        {activeAction === "dispute" ? "Escalating..." : "Dispute"}
      </button>

      {errorMsg && (
        <span
          data-testid="action-error"
          title={errorMsg}
          className="text-rose-400 text-[10px] ml-1"
        >
          !
        </span>
      )}
    </div>
  );
};
