import { AlertTriangle, Check, Copy, Layers, Lock, ShieldCheck, X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";

import type { ClearinghouseRecord, HitlActionType } from "../types.js";
import { getRiskLevel } from "../types.js";
import { StatusBadgeRenderer } from "./renderers/StatusBadgeRenderer.js";

export interface TransactionDetailDrawerProps {
  record: ClearinghouseRecord | null;
  onClose: () => void;
  onApprove?: (record: ClearinghouseRecord) => Promise<void>;
  onVoid?: (record: ClearinghouseRecord) => Promise<void>;
  onDispute?: (record: ClearinghouseRecord) => Promise<void>;
}

export const TransactionDetailDrawer: React.FC<TransactionDetailDrawerProps> = ({
  record,
  onClose,
  onApprove,
  onVoid,
  onDispute,
}) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<HitlActionType | null>(null);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const copyToClipboard = useCallback((text: string, key: string) => {
    try {
      navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      // fallback
    }
  }, []);

  if (!record) return null;

  const riskTier = getRiskLevel(record.riskScore);
  const formattedAmount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: record.currency || "USD",
  }).format(record.amount / 100);

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

  const handleAction = async (action: HitlActionType) => {
    if (activeAction) return;
    setActiveAction(action);
    try {
      if (action === "counter-sign" && onApprove) {
        await onApprove(record);
      } else if (action === "void" && onVoid) {
        await onVoid(record);
      } else if (action === "dispute" && onDispute) {
        await onDispute(record);
      }
    } finally {
      setActiveAction(null);
    }
  };

  return (
    <>
      {/* Semi-transparent Backdrop with Click-to-Dismiss */}
      <div
        data-testid="drawer-backdrop"
        onClick={onClose}
        aria-hidden="true"
        className="fixed inset-0 z-40 bg-zinc-950/20 dark:bg-black/50 backdrop-blur-[2px] transition-opacity animate-in fade-in duration-200"
      />

      <aside
        aria-label="Transaction Audit Inspector"
        data-testid="transaction-detail-drawer"
        className="fixed inset-y-0 right-0 z-50 w-full max-w-lg bg-white dark:bg-zinc-950 border-l border-zinc-200 dark:border-zinc-800 shadow-2xl flex flex-col font-sans text-zinc-900 dark:text-zinc-100 animate-in slide-in-from-right duration-250 ease-out"
      >
        {/* Drawer Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/60">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 flex items-center justify-center text-zinc-600 dark:text-zinc-300 shadow-sm">
              <Layers className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-semibold tracking-wider text-zinc-500 dark:text-zinc-400 uppercase">
                  Mandate Inspector
                </span>
              </div>
              <h2 className="text-sm font-mono font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                {record.transactionId}
                <button
                  type="button"
                  onClick={() => copyToClipboard(record.transactionId, "txId")}
                  className="text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300 transition-colors"
                  title="Copy Transaction ID"
                >
                  {copiedKey === "txId" ? (
                    <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                </button>
              </h2>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close Inspector"
            className="w-8 h-8 rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 flex items-center justify-center transition-all active:scale-[0.96]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Drawer Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Highlight Card: Monetary Value & Settlement State */}
          <div className="p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/40">
            <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400 font-mono">
              <span>ESCROW VALUE</span>
              <span className="text-zinc-400 dark:text-zinc-500 text-[11px]">
                SEQ #{record.sequenceNumber}
              </span>
            </div>
            <div className="mt-1 flex items-baseline justify-between">
              <span className="text-3xl font-semibold font-mono tracking-tight text-zinc-900 dark:text-zinc-100">
                {formattedAmount}
              </span>
              <span className="inline-flex items-center gap-1.5 text-[11px] font-mono tracking-tight px-2 py-0.5 rounded-md bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 dark:border-emerald-500/20 font-medium">
                <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-emerald-500 dark:bg-emerald-400 opacity-75" />
                <span>{record.currency} HOLD</span>
              </span>
            </div>

            {/* Escrow State Pipeline Bar */}
            <div className="mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-between text-[11px] font-sans">
              <span className="text-zinc-500 dark:text-zinc-400">Clearinghouse State</span>
              <StatusBadgeRenderer status={record.clearinghouseState} />
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] font-sans">
              <span className="text-zinc-500 dark:text-zinc-400">Escrow Status</span>
              <StatusBadgeRenderer status={record.escrowStatus} />
            </div>
          </div>

          {/* Risk Analysis Matrix */}
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/30 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                <h3 className="text-xs font-mono font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
                  Risk Engine Evaluation
                </h3>
              </div>
              <span
                className={`inline-flex items-center gap-1.5 text-[11px] font-mono tracking-tight font-medium px-2 py-0.5 rounded-md border uppercase whitespace-nowrap ${
                  riskTier === "low"
                    ? "bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-400 border-emerald-500/20 dark:border-emerald-500/20"
                    : riskTier === "elevated"
                      ? "bg-amber-500/[0.06] dark:bg-amber-500/[0.08] text-amber-700 dark:text-amber-400 border-amber-500/20 dark:border-amber-500/20"
                      : "bg-rose-500/[0.06] dark:bg-rose-500/[0.08] text-rose-700 dark:text-rose-400 border-rose-500/20 dark:border-rose-500/20 animate-pulse"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 opacity-75 ${
                    riskTier === "low"
                      ? "bg-emerald-500 dark:bg-emerald-400"
                      : riskTier === "elevated"
                        ? "bg-amber-500 dark:bg-amber-400"
                        : "bg-rose-500 dark:bg-rose-400"
                  }`}
                />
                <span>
                  Score {record.riskScore}/100 · {riskTier.toUpperCase()}
                </span>
              </span>
            </div>

            {/* Risk Score Progress Bar */}
            <div className="w-full h-1.5 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${
                  riskTier === "low"
                    ? "bg-emerald-500 dark:bg-emerald-400"
                    : riskTier === "elevated"
                      ? "bg-amber-500 dark:bg-amber-400"
                      : "bg-rose-500 dark:bg-rose-400"
                }`}
                style={{ width: `${Math.min(100, Math.max(0, record.riskScore))}%` }}
              />
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2 text-[11px] font-mono">
              <div className="p-2.5 rounded-lg bg-white dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800/80">
                <span className="text-zinc-500 dark:text-zinc-400 block text-[10px] mb-1">
                  HITL Policy Ceiling
                </span>
                <span className="text-zinc-800 dark:text-zinc-200 font-medium">
                  {record.amount > 25000 || record.riskScore > 70
                    ? "HITL Triggered"
                    : "Autonomous Pass"}
                </span>
              </div>
              <div className="p-2.5 rounded-lg bg-white dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800/80">
                <span className="text-zinc-500 dark:text-zinc-400 block text-[10px] mb-1">
                  Supervisor Key
                </span>
                <span className="font-medium text-zinc-800 dark:text-zinc-200">
                  {record.hitlStatus}
                </span>
              </div>
            </div>
          </div>

          {/* AP2 Cryptographic Identity & Rails */}
          <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/30 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Lock className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
              <h3 className="text-xs font-mono font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
                AP2 Cryptographic Identity & Rails
              </h3>
            </div>

            <div className="space-y-2.5 text-xs font-mono">
              <div className="flex items-center justify-between py-1.5 border-b border-zinc-200/80 dark:border-zinc-800/60">
                <span className="text-zinc-500 dark:text-zinc-400">Mandate ID</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-800 dark:text-zinc-200 text-[11px] font-mono break-all">
                    {record.mandateId}
                  </span>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(record.mandateId, "mandateId")}
                    className="text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300 transition-colors shrink-0"
                  >
                    {copiedKey === "mandateId" ? (
                      <Check className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3" />
                    )}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between py-1.5 border-b border-zinc-200/80 dark:border-zinc-800/60">
                <span className="text-zinc-500 dark:text-zinc-400">Agent Identity</span>
                <span className="text-zinc-800 dark:text-zinc-200 text-[11px]">
                  {record.agentId}
                </span>
              </div>

              <div className="flex items-center justify-between py-1.5 border-b border-zinc-200/80 dark:border-zinc-800/60">
                <span className="text-zinc-500 dark:text-zinc-400">Merchant Payee Domain</span>
                <span className="text-zinc-800 dark:text-zinc-200 text-[11px] font-semibold">
                  {record.merchantDomain}
                </span>
              </div>

              {record.authorizationId && (
                <div className="flex items-center justify-between py-1.5 border-b border-zinc-200/80 dark:border-zinc-800/60">
                  <span className="text-zinc-500 dark:text-zinc-400">PayPal Auth Hold ID</span>
                  <span className="text-zinc-800 dark:text-zinc-200 text-[11px]">
                    {record.authorizationId}
                  </span>
                </div>
              )}

              {record.captureId && (
                <div className="flex items-center justify-between py-1.5 border-b border-zinc-200/80 dark:border-zinc-800/60">
                  <span className="text-zinc-500 dark:text-zinc-400">PayPal Capture ID</span>
                  <span className="text-zinc-800 dark:text-zinc-200 text-[11px]">
                    {record.captureId}
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between py-1.5">
                <span className="text-zinc-500 dark:text-zinc-400">Timestamp (UTC)</span>
                <span className="text-zinc-600 dark:text-zinc-400 text-[11px]">
                  {new Date(record.createdAt).toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          {/* Dispute Details if applicable */}
          {record.disputeReason && (
            <div className="rounded-xl border border-rose-500/20 dark:border-rose-500/20 bg-rose-500/[0.06] dark:bg-rose-500/[0.08] p-4 space-y-2 text-xs font-mono">
              <div className="flex items-center gap-2 text-rose-700 dark:text-rose-400">
                <AlertTriangle className="w-4 h-4" />
                <span className="font-semibold uppercase tracking-wider">
                  Dispute Evidence Attached
                </span>
              </div>
              <p className="text-zinc-700 dark:text-zinc-300 text-[11px]">{record.disputeReason}</p>
            </div>
          )}
        </div>

        {/* Drawer Action Footer: Institutional HITL Controls */}
        <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-900/80 space-y-2">
          <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400 block">
            Supervisor Authorization Controls
          </span>
          <div className="grid grid-cols-3 gap-2">
            {/* Approve / Counter-Sign */}
            <button
              type="button"
              data-testid="drawer-action-approve"
              disabled={activeAction !== null || isTerminal || isApproved}
              onClick={() => handleAction("counter-sign")}
              className={`px-3 py-2 rounded-lg text-xs font-mono tracking-tight font-medium border flex items-center justify-center gap-1.5 transition-all ${
                activeAction === "counter-sign"
                  ? "bg-emerald-500/[0.15] dark:bg-emerald-950/60 text-emerald-800 dark:text-emerald-400 border-emerald-500/30 dark:border-emerald-500/50 cursor-wait"
                  : isTerminal || isApproved
                    ? "bg-zinc-500/[0.04] dark:bg-zinc-900/40 text-zinc-400 dark:text-zinc-600 border-zinc-500/[0.15] dark:border-zinc-800/40 cursor-not-allowed opacity-50"
                    : "bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08] hover:bg-emerald-500/[0.12] dark:hover:bg-emerald-500/[0.15] text-emerald-700 dark:text-emerald-300 border-emerald-500/20 dark:border-emerald-500/20 active:scale-[0.97]"
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-emerald-500 dark:bg-emerald-400 opacity-75" />
              <span>{isApproved ? "Approved" : "Approve"}</span>
            </button>

            {/* Void Escrow */}
            <button
              type="button"
              data-testid="drawer-action-void"
              disabled={activeAction !== null || isTerminal || isVoided}
              onClick={() => handleAction("void")}
              className={`px-3 py-2 rounded-lg text-xs font-mono tracking-tight font-medium border flex items-center justify-center gap-1.5 transition-all ${
                activeAction === "void"
                  ? "bg-amber-500/[0.15] dark:bg-amber-950/60 text-amber-800 dark:text-amber-400 border-amber-500/30 dark:border-amber-500/50 cursor-wait"
                  : isTerminal || isVoided
                    ? "bg-zinc-500/[0.04] dark:bg-zinc-900/40 text-zinc-400 dark:text-zinc-600 border-zinc-500/[0.15] dark:border-zinc-800/40 cursor-not-allowed opacity-50"
                    : "bg-amber-500/[0.06] dark:bg-amber-500/[0.08] hover:bg-amber-500/[0.12] dark:hover:bg-amber-500/[0.15] text-amber-700 dark:text-amber-300 border-amber-500/20 dark:border-amber-500/20 active:scale-[0.97]"
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-amber-500 dark:bg-amber-400 opacity-75" />
              <span>{isVoided ? "Voided" : "Void Escrow"}</span>
            </button>

            {/* Dispute Escalation */}
            <button
              type="button"
              data-testid="drawer-action-dispute"
              disabled={activeAction !== null || isTerminal || isDisputed}
              onClick={() => handleAction("dispute")}
              className={`px-3 py-2 rounded-lg text-xs font-mono tracking-tight font-medium border flex items-center justify-center gap-1.5 transition-all ${
                activeAction === "dispute"
                  ? "bg-rose-500/[0.15] dark:bg-rose-950/60 text-rose-800 dark:text-rose-400 border-rose-500/30 dark:border-rose-500/50 cursor-wait"
                  : isTerminal || isDisputed
                    ? "bg-zinc-500/[0.04] dark:bg-zinc-900/40 text-zinc-400 dark:text-zinc-600 border-zinc-500/[0.15] dark:border-zinc-800/40 cursor-not-allowed opacity-50"
                    : "bg-rose-500/[0.06] dark:bg-rose-500/[0.08] hover:bg-rose-500/[0.12] dark:hover:bg-rose-500/[0.15] text-rose-700 dark:text-rose-300 border-rose-500/20 dark:border-rose-500/20 active:scale-[0.97]"
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-rose-500 dark:bg-rose-400 opacity-75" />
              <span>{isDisputed ? "Disputed" : "Dispute"}</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
};
