import { AlertTriangle, Moon, ShieldAlert, Sun, TrendingUp, Zap } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ClearinghouseGrid, type ClearinghouseGridHandle } from "./components/ClearinghouseGrid.js";
import { ProcurementGantt } from "./components/gantt/ProcurementGantt.js";
import { TransactionDetailDrawer } from "./components/TransactionDetailDrawer.js";
import { INITIAL_DEMO_RECORDS } from "./demoData.js";
import { useClearinghouseSocket } from "./hooks/useClearinghouseSocket.js";
import type { ClearinghouseRecord, GridTransaction } from "./types.js";

export const App: React.FC = () => {
  const gridRef = useRef<ClearinghouseGridHandle | null>(null);
  const recordsRef = useRef<Map<string, ClearinghouseRecord>>(new Map());
  const statsRafRef = useRef<number | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [simulationActive, setSimulationActive] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<"ledger" | "gantt">("ledger");
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<ClearinghouseRecord | null>(null);
  const simTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [seqNumber, setSeqNumber] = useState<number>(112);
  const seqRef = useRef<number>(112);
  const [recordsVersion, setRecordsVersion] = useState<number>(0);
  const [ganttCriticalPath, setGanttCriticalPath] = useState<boolean>(true);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("tessera-theme");
      if (saved === "light" || saved === "dark") return saved;
      if (window.matchMedia?.("(prefers-color-scheme: light)").matches) return "light";
    }
    return "dark";
  });

  useEffect(() => {
    if (typeof document !== "undefined") {
      const root = document.documentElement;
      if (theme === "dark") {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }
      try {
        localStorage.setItem("tessera-theme", theme);
      } catch {
        // ignore storage error in sandboxed environment
      }
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((curr) => (curr === "dark" ? "light" : "dark"));
  }, []);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => {
      setToastMsg(null);
    }, 3200);
  }, []);

  const [stats, setStats] = useState({
    pendingHitl: 0,
    criticalRisk: 0,
    totalVolume: 0,
    totalCount: 0,
  });

  const recalculateStats = useCallback(() => {
    let pendingHitl = 0;
    let criticalRisk = 0;
    let totalVolume = 0;

    for (const item of recordsRef.current.values()) {
      if (item.hitlStatus === "PENDING_APPROVAL") pendingHitl++;
      if (item.riskScore > 70) criticalRisk++;
      if (typeof item.amount === "number") totalVolume += item.amount;
    }

    setStats({
      pendingHitl,
      criticalRisk,
      totalVolume,
      totalCount: recordsRef.current.size,
    });
  }, []);

  const scheduleStatsUpdate = useCallback(() => {
    if (typeof window === "undefined" || !window.requestAnimationFrame) {
      recalculateStats();
      return;
    }
    if (statsRafRef.current !== null) return;
    statsRafRef.current = window.requestAnimationFrame(() => {
      statsRafRef.current = null;
      recalculateStats();
    });
  }, [recalculateStats]);

  const handleTransaction = useCallback(
    (tx: GridTransaction) => {
      if (gridRef.current) {
        gridRef.current.applyTransaction(tx);
      }
      for (const item of tx.add) {
        recordsRef.current.set(item.transactionId, item);
      }
      for (const item of tx.update) {
        recordsRef.current.set(item.transactionId, item);
        setSelectedRecord((curr) =>
          curr && curr.transactionId === item.transactionId ? item : curr,
        );
      }
      for (const item of tx.remove) {
        recordsRef.current.delete(item.transactionId);
        setSelectedRecord((curr) =>
          curr && curr.transactionId === item.transactionId ? null : curr,
        );
      }
      scheduleStatsUpdate();
      setRecordsVersion((v) => v + 1);
    },
    [scheduleStatsUpdate],
  );

  const handleSnapshot = useCallback(
    (records: ClearinghouseRecord[]) => {
      recordsRef.current.clear();
      for (const item of records) {
        recordsRef.current.set(item.transactionId, item);
      }
      recalculateStats();
      setRecordsVersion((v) => v + 1);
    },
    [recalculateStats],
  );

  // Initialize with rich demo dataset on mount if no active snapshot
  useEffect(() => {
    if (recordsRef.current.size === 0) {
      for (const item of INITIAL_DEMO_RECORDS) {
        recordsRef.current.set(item.transactionId, item);
      }
      recalculateStats();
      setRecordsVersion((v) => v + 1);
    }
  }, [recalculateStats]);

  const recordsList = useMemo(
    () => Array.from(recordsRef.current.values()),
    [recordsVersion],
  );

  const defaultWsUrl =
    typeof window !== "undefined" && window.location.host
      ? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/clearinghouse`
      : "ws://localhost:3000/ws/clearinghouse";
  const wsUrl =
    (typeof import.meta !== "undefined" &&
      (import.meta as { env?: Record<string, string> }).env?.VITE_CLEARINGHOUSE_WS_URL) ||
    defaultWsUrl;

  const defaultApiUrl =
    typeof window !== "undefined" &&
    window.location.origin &&
    !window.location.origin.startsWith("null")
      ? window.location.origin
      : "http://localhost:3000";
  const apiBaseUrl =
    (typeof import.meta !== "undefined" &&
      (import.meta as { env?: Record<string, string> }).env?.VITE_CLEARINGHOUSE_API_URL) ||
    defaultApiUrl;

  const { connectionStatus, isConnected, lastSequenceNumber, snapshot, connect, disconnect } =
    useClearinghouseSocket({
      url: wsUrl,
      autoConnect: false,
      onSnapshot: handleSnapshot,
      onTransaction: handleTransaction,
    });

  // Supervisor Action Handlers with optimistic UI updates
  const handleApprove = useCallback(
    async (record: ClearinghouseRecord) => {
      if (isConnected) {
        const res = await fetch(
          `${apiBaseUrl.replace(/\/+$/, "")}/api/v1/mandates/${encodeURIComponent(record.mandateId)}/counter-sign`,
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
        if (!res.ok) throw new Error(`Counter-sign failed: HTTP ${res.status}`);
      }
      const updated: ClearinghouseRecord = {
        ...record,
        hitlStatus: "APPROVED",
        clearinghouseState:
          record.clearinghouseState === "DISPUTED" ? "DISPUTED" : "AUTHORIZED_IN_ESCROW",
        updatedAt: new Date().toISOString(),
      };
      handleTransaction({ add: [], update: [updated], remove: [] });
      setSelectedRecord((curr) =>
        curr && curr.transactionId === record.transactionId ? updated : curr,
      );
      showToast(`Counter-signature approved for ${record.transactionId}`);
    },
    [handleTransaction, isConnected, apiBaseUrl, showToast],
  );

  const handleVoid = useCallback(
    async (record: ClearinghouseRecord) => {
      if (isConnected) {
        const res = await fetch(
          `${apiBaseUrl.replace(/\/+$/, "")}/api/v1/mandates/${encodeURIComponent(record.mandateId)}/void`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transactionId: record.transactionId,
              reason: "SUPERVISOR_SLA_VOID",
              timestamp: new Date().toISOString(),
            }),
          },
        );
        if (!res.ok) throw new Error(`Void failed: HTTP ${res.status}`);
      }
      const updated: ClearinghouseRecord = {
        ...record,
        clearinghouseState: "VOIDED",
        escrowStatus: "SLA_BREACH_VOIDED",
        hitlStatus: "REJECTED",
        updatedAt: new Date().toISOString(),
      };
      handleTransaction({ add: [], update: [updated], remove: [] });
      setSelectedRecord((curr) =>
        curr && curr.transactionId === record.transactionId ? updated : curr,
      );
      showToast(`Escrow voided for ${record.transactionId}`);
    },
    [handleTransaction, isConnected, apiBaseUrl, showToast],
  );

  const handleDispute = useCallback(
    async (record: ClearinghouseRecord) => {
      if (isConnected) {
        const res = await fetch(
          `${apiBaseUrl.replace(/\/+$/, "")}/api/v1/mandates/${encodeURIComponent(record.mandateId)}/dispute`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transactionId: record.transactionId,
              reason: "SUPERVISOR_MANUAL_DISPUTE",
              timestamp: new Date().toISOString(),
            }),
          },
        );
        if (!res.ok) throw new Error(`Dispute failed: HTTP ${res.status}`);
      }
      const updated: ClearinghouseRecord = {
        ...record,
        clearinghouseState: "DISPUTED",
        escrowStatus: "DISPUTED",
        updatedAt: new Date().toISOString(),
      };
      handleTransaction({ add: [], update: [updated], remove: [] });
      setSelectedRecord((curr) =>
        curr && curr.transactionId === record.transactionId ? updated : curr,
      );
      showToast(`Dispute escalation filed for ${record.transactionId}`);
    },
    [handleTransaction, isConnected, apiBaseUrl, showToast],
  );

  // Live streaming delta simulator
  useEffect(() => {
    if (!simulationActive) {
      if (simTimerRef.current) clearInterval(simTimerRef.current);
      return;
    }

    simTimerRef.current = setInterval(() => {
      seqRef.current += 1;
      const nextSeq = seqRef.current;
      setSeqNumber(nextSeq);
      const currentRecords = Array.from(recordsRef.current.values());
      if (currentRecords.length === 0) return;

      // Pick a random record to modify or append
      const target = currentRecords[Math.floor(Math.random() * currentRecords.length)];
      const deltaType = Math.random();

      if (deltaType < 0.6) {
        // Update existing risk score / amount slightly
        const scoreDelta = Math.floor(Math.random() * 15) - 7;
        const newScore = Math.max(1, Math.min(99, target.riskScore + scoreDelta));
        const updated: ClearinghouseRecord = {
          ...target,
          riskScore: newScore,
          riskTier: newScore <= 30 ? "LOW" : newScore <= 70 ? "ELEVATED" : "CRITICAL_HITL",
          sequenceNumber: nextSeq,
          updatedAt: new Date().toISOString(),
        };
        handleTransaction({ add: [], update: [updated], remove: [] });
      } else {
        // Add a new high-frequency transaction
        const merchants = [
          "stripe.com",
          "openai.com",
          "aws.amazon.com",
          "anthropic.com",
          "google.com",
        ];
        const merchant = merchants[Math.floor(Math.random() * merchants.length)];
        const randomAmount = Math.floor(Math.random() * 50000) * 100 + 10000;
        const randomScore = Math.floor(Math.random() * 95) + 5;
        const newTx: ClearinghouseRecord = {
          transactionId: `tx-stream-${nextSeq}`,
          mandateId: `man-sim-${nextSeq}`,
          agentId: `agent-live-${(nextSeq % 5) + 1}`,
          merchantDomain: merchant,
          amount: randomAmount,
          currency: "USD",
          clearinghouseState: "AUTHORIZED_IN_ESCROW",
          escrowStatus: "AUTHORIZED_HOLD",
          riskScore: randomScore,
          riskTier: randomScore <= 30 ? "LOW" : randomScore <= 70 ? "ELEVATED" : "CRITICAL_HITL",
          hitlStatus: randomScore > 70 ? "PENDING_APPROVAL" : "NOT_REQUIRED",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sequenceNumber: nextSeq,
          timestampMicros: Date.now() * 1000,
        };
        handleTransaction({ add: [newTx], update: [], remove: [] });
      }
    }, 1500);

    return () => {
      if (simTimerRef.current) clearInterval(simTimerRef.current);
    };
  }, [simulationActive, handleTransaction]);

  useEffect(() => {
    return () => {
      if (statsRafRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(statsRafRef.current);
      }
      if (simTimerRef.current) clearInterval(simTimerRef.current);
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  const displaySequence = isConnected ? lastSequenceNumber : seqNumber;
  const initialRowData = snapshot.length > 0 ? snapshot : INITIAL_DEMO_RECORDS;

  const handleFilterClick = (filterTerm: string) => {
    if (gridRef.current) {
      gridRef.current.setQuickFilter(filterTerm);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-[#09090b] text-zinc-900 dark:text-zinc-100 flex flex-col font-sans selection:bg-zinc-200 dark:selection:bg-zinc-800 selection:text-zinc-900 dark:selection:text-zinc-100 antialiased transition-colors duration-150">
      {/* Top Header / Status Bar */}
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white/90 dark:bg-zinc-950/80 backdrop-blur-md px-6 py-3 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-20 transition-colors duration-150">
        <div className="flex items-center gap-3">
          <img src="/logo.png" alt="TESSERA" className="w-7 h-7 object-contain dark:invert" />
          <span className="text-xs font-bold tracking-[0.2em] font-mono text-zinc-900 dark:text-zinc-100 uppercase">
            TESSERA
          </span>
        </div>

        {/* Real-Time Telemetry & Controls */}
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          {/* Simulation Toggle */}
          <button
            type="button"
            onClick={() => setSimulationActive((prev) => !prev)}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-all duration-150 border flex items-center gap-2 active:scale-[0.98] ${
              simulationActive
                ? "bg-emerald-50 text-emerald-800 border-emerald-300 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/35"
                : "bg-white hover:bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-800 shadow-sm"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full ${
                simulationActive
                  ? "bg-emerald-500 dark:bg-emerald-400 animate-ping"
                  : "bg-zinc-400 dark:bg-zinc-500"
              }`}
            />
            <span className="font-medium">
              {simulationActive ? "Feed Streaming (Pause)" : "Simulate Live Ingestion"}
            </span>
          </button>

          {/* Sequence Monotonic Pill */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 shadow-sm">
            <span className="text-zinc-400 dark:text-zinc-500 text-[10px] font-mono font-semibold tracking-wider">
              SEQ
            </span>
            <span className="text-zinc-800 dark:text-zinc-200 font-mono text-xs font-medium tabular-nums">
              #{displaySequence.toString().padStart(6, "0")}
            </span>
          </div>

          {/* Record Volume Pill */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 shadow-sm">
            <span className="text-zinc-400 dark:text-zinc-500 text-[10px] font-mono font-semibold tracking-wider">
              RECORDS
            </span>
            <span className="text-zinc-800 dark:text-zinc-200 font-mono text-xs font-medium tabular-nums">
              {stats.totalCount}
            </span>
          </div>

          {/* Connection Status Pill */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 shadow-sm">
            <span
              className={`w-2 h-2 rounded-full ${
                isConnected
                  ? "bg-emerald-500 dark:bg-emerald-400"
                  : connectionStatus === "reconnecting"
                    ? "bg-amber-500 dark:bg-amber-400 animate-pulse"
                    : "bg-zinc-400 dark:bg-zinc-500"
              }`}
            />
            <span
              className={`text-[11px] font-mono font-medium uppercase tracking-wider ${
                isConnected
                  ? "text-emerald-700 dark:text-emerald-400"
                  : connectionStatus === "reconnecting"
                    ? "text-amber-700 dark:text-amber-400"
                    : "text-zinc-600 dark:text-zinc-400"
              }`}
            >
              {isConnected ? "WS Live Rail" : "Stand-Alone Demo"}
            </span>
          </div>

          {/* Connect / Disconnect WS Button */}
          <button
            type="button"
            onClick={
              isConnected ||
              connectionStatus === "connecting" ||
              connectionStatus === "reconnecting"
                ? disconnect
                : () => connect()
            }
            className="px-3 py-1.5 bg-white hover:bg-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 rounded-lg border border-zinc-200 dark:border-zinc-800 text-xs font-mono transition-all active:scale-[0.98] font-medium shadow-sm"
          >
            {isConnected || connectionStatus === "connecting" || connectionStatus === "reconnecting"
              ? "Disconnect"
              : "Connect WS"}
          </button>

          {/* View Mode Toggle: AG Grid Ledger / Bryntum Gantt Timeline */}
          <div className="flex items-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60 p-0.5 shadow-sm text-xs font-mono">
            <button
              type="button"
              data-testid="view-mode-ledger"
              onClick={() => setViewMode("ledger")}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                viewMode === "ledger"
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-semibold shadow-xs"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              Ledger
            </button>
            <button
              type="button"
              data-testid="view-mode-gantt"
              onClick={() => setViewMode("gantt")}
              className={`px-2.5 py-1 rounded-md transition-colors ${
                viewMode === "gantt"
                  ? "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-semibold shadow-xs"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              Gantt SLA
            </button>
          </div>

          {/* Theme Switcher Toggle */}
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label="Toggle color theme"
            className="p-1.5 bg-white hover:bg-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 rounded-lg border border-zinc-200 dark:border-zinc-800 transition-all active:scale-[0.96] shadow-sm flex items-center justify-center"
          >
            {theme === "dark" ? (
              <Sun className="w-4 h-4 text-zinc-400 group-hover:text-zinc-100" />
            ) : (
              <Moon className="w-4 h-4 text-zinc-600 group-hover:text-zinc-900" />
            )}
          </button>
        </div>
      </header>

      {/* KPI Bento Strip: Crisp 1px Neutral Borders & Clean Whitespace */}
      <section className="px-6 py-5">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Card 1: Total Monitored Escrow Volume */}
          <div className="p-5 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 shadow-sm flex flex-col justify-between gap-3 h-full hover:border-zinc-300 dark:hover:border-zinc-700 transition-all duration-150">
            <div className="flex items-center justify-between text-zinc-500 dark:text-zinc-400 text-[11px] font-mono uppercase tracking-wider">
              <span className="flex items-center gap-1.5 font-semibold">
                <TrendingUp className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500" />
                Total Monitored Escrow
              </span>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/80 dark:bg-emerald-400/80" />
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-2xl lg:text-3xl font-semibold font-mono tracking-tight tabular-nums text-zinc-900 dark:text-zinc-100">
                {new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: "USD",
                }).format(stats.totalVolume / 100)}
              </span>
              <span className="text-[11px] font-mono tracking-tight text-emerald-700 dark:text-emerald-400 bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08] px-2 py-0.5 rounded-md border border-emerald-500/20 dark:border-emerald-500/20 font-medium">
                +18.4% 24h
              </span>
            </div>

            {/* Mini Sparkline SVG */}
            <div className="flex items-center justify-between pt-2 border-t border-zinc-100 dark:border-zinc-800/80">
              <span className="text-[11px] text-zinc-500 font-sans">
                PayPal Orders v2 Auth Holds
              </span>
              <svg
                aria-hidden="true"
                className="w-16 h-4 text-emerald-600/70 dark:text-emerald-400/70"
                viewBox="0 0 64 16"
                fill="none"
              >
                <path
                  d="M1 13L12 11L24 14L36 7L48 9L63 2"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          </div>

          {/* Card 2: Pending HITL Approvals */}
          <button
            type="button"
            onClick={() => handleFilterClick("PENDING_APPROVAL")}
            className="text-left w-full p-5 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 shadow-sm flex flex-col justify-between gap-3 h-full hover:border-amber-400/60 dark:hover:border-amber-500/40 cursor-pointer transition-all duration-150 group"
          >
            <div className="flex items-center justify-between text-zinc-500 dark:text-zinc-400 text-[11px] font-mono uppercase tracking-wider">
              <span className="flex items-center gap-1.5 font-semibold">
                <AlertTriangle className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500" />
                Pending HITL Approvals
              </span>
              {stats.pendingHitl > 0 ? (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500/80 dark:bg-amber-400/80 animate-pulse" />
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
              )}
            </div>

            <div className="flex items-center gap-2.5">
              <span
                className={`text-2xl lg:text-3xl font-semibold font-mono tracking-tight tabular-nums ${
                  stats.pendingHitl > 0
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-zinc-800 dark:text-zinc-200"
                }`}
              >
                {stats.pendingHitl}
              </span>
              {stats.pendingHitl > 0 && (
                <span className="text-[10px] font-mono tracking-tight px-2 py-0.5 rounded-md bg-amber-500/[0.06] dark:bg-amber-500/[0.08] text-amber-700 dark:text-amber-400 border border-amber-500/20 dark:border-amber-500/25 uppercase tracking-wider font-semibold">
                  Action Required
                </span>
              )}
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-zinc-100 dark:border-zinc-800/80 text-[11px]">
              <span className="text-zinc-500 font-sans">Threshold ≥ $250.00 / Risk ≥ 70</span>
              <span className="text-amber-600 dark:text-amber-400/80 font-mono text-[10px] group-hover:translate-x-0.5 transition-transform">
                Filter queue →
              </span>
            </div>
          </button>

          {/* Card 3: Critical Risk Anomalies */}
          <button
            type="button"
            onClick={() => handleFilterClick("CRITICAL")}
            className="text-left w-full p-5 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 shadow-sm flex flex-col justify-between gap-3 h-full hover:border-rose-400/60 dark:hover:border-rose-500/40 cursor-pointer transition-all duration-150 group"
          >
            <div className="flex items-center justify-between text-zinc-500 dark:text-zinc-400 text-[11px] font-mono uppercase tracking-wider">
              <span className="flex items-center gap-1.5 font-semibold">
                <ShieldAlert className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500" />
                Critical Risk Anomalies
              </span>
              {stats.criticalRisk > 0 ? (
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500/80 dark:bg-rose-400/80 animate-pulse" />
              ) : (
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600" />
              )}
            </div>

            <div className="flex items-center gap-2.5">
              <span
                className={`text-2xl lg:text-3xl font-semibold font-mono tracking-tight tabular-nums ${
                  stats.criticalRisk > 0
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-zinc-800 dark:text-zinc-200"
                }`}
              >
                {stats.criticalRisk}
              </span>
              {stats.criticalRisk > 0 && (
                <span className="text-[10px] font-mono tracking-tight px-2 py-0.5 rounded-md bg-rose-500/[0.06] dark:bg-rose-500/[0.08] text-rose-700 dark:text-rose-400 border border-rose-500/20 dark:border-rose-500/25 uppercase tracking-wider font-semibold">
                  High Severity
                </span>
              )}
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-zinc-100 dark:border-zinc-800/80 text-[11px]">
              <span className="text-zinc-500 font-sans">Autonomous circuit breaker active</span>
              <span className="text-rose-600 dark:text-rose-400/80 font-mono text-[10px] group-hover:translate-x-0.5 transition-transform">
                Review risks →
              </span>
            </div>
          </button>

          {/* Card 4: Engine Settlement Latency */}
          <div className="p-5 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 shadow-sm flex flex-col justify-between gap-3 h-full hover:border-zinc-300 dark:hover:border-zinc-700 transition-all duration-150">
            <div className="flex items-center justify-between text-zinc-500 dark:text-zinc-400 text-[11px] font-mono uppercase tracking-wider">
              <span className="flex items-center gap-1.5 font-semibold">
                <Zap className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500" />
                Engine Latency SLA
              </span>
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-500/80 dark:bg-cyan-400/80" />
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-2xl lg:text-3xl font-semibold font-mono tracking-tight tabular-nums text-zinc-900 dark:text-zinc-100">
                &lt; 50 µs
              </span>
              <span className="text-[11px] font-mono tracking-tight text-sky-700 dark:text-cyan-400 bg-cyan-500/[0.06] dark:bg-cyan-500/[0.08] px-2 py-0.5 rounded-md border border-cyan-500/20 dark:border-cyan-500/20 font-medium">
                p99: 38 µs
              </span>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-zinc-100 dark:border-zinc-800/80">
              <span className="text-[11px] text-zinc-500 font-sans">
                Zero-loss ring buffer ingestion
              </span>
              <span className="text-zinc-500 dark:text-zinc-400 font-mono text-[10px]">
                100% Uptime
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Primary AG Grid Enterprise Ledger View or Bryntum Gantt Pro Timeline */}
      <main className="flex-1 px-6 pb-6 flex flex-col">
        {viewMode === "ledger" ? (
          <ClearinghouseGrid
            ref={gridRef}
            rowData={initialRowData}
            apiBaseUrl={apiBaseUrl}
            theme={theme}
            onApprove={handleApprove}
            onVoid={handleVoid}
            onDispute={handleDispute}
            onRowClicked={(record) => setSelectedRecord(record)}
            className="w-full h-[660px]"
          />
        ) : (
          <ProcurementGantt
            records={recordsList}
            theme={theme}
            showCriticalPath={ganttCriticalPath}
            onToggleCriticalPath={setGanttCriticalPath}
            onTaskClick={(task) => {
              const rec = recordsRef.current.get(task.transactionId);
              if (rec) setSelectedRecord(rec);
            }}
            onSlaWarning={(warning) => {
              if (warning.severity === "CRITICAL") {
                showToast(`SLA CRITICAL: ${warning.message}`);
              }
            }}
            className="w-full flex-1 min-h-[660px]"
          />
        )}
      </main>

      {/* Slide-Out Inspector Drawer for Selected Transaction */}
      {selectedRecord && (
        <TransactionDetailDrawer
          record={selectedRecord}
          onClose={() => setSelectedRecord(null)}
          onApprove={handleApprove}
          onVoid={handleVoid}
          onDispute={handleDispute}
        />
      )}

      {/* Subtle Toast Notification Pill */}
      {toastMsg && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5 px-4 py-2 rounded-full bg-white/95 dark:bg-zinc-900/95 border border-zinc-200 dark:border-zinc-800 text-xs font-mono text-zinc-800 dark:text-zinc-100 shadow-xl backdrop-blur-xl transition-all duration-200 animate-in fade-in slide-in-from-bottom-2"
        >
          <span className="w-2 h-2 rounded-full bg-emerald-500 dark:bg-emerald-400 shrink-0" />
          <span className="font-medium">{toastMsg}</span>
        </div>
      )}
    </div>
  );
};
