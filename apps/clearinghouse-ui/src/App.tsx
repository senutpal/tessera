import type React from "react";
import { useCallback, useMemo, useRef } from "react";
import { ClearinghouseGrid, type ClearinghouseGridHandle } from "./components/ClearinghouseGrid.js";
import { useClearinghouseSocket } from "./hooks/useClearinghouseSocket.js";
import type { GridTransaction } from "./types.js";

export const App: React.FC = () => {
  const gridRef = useRef<ClearinghouseGridHandle | null>(null);

  const handleTransaction = useCallback((tx: GridTransaction) => {
    if (gridRef.current) {
      gridRef.current.applyTransaction(tx);
    }
  }, []);

  const { connectionStatus, isConnected, lastSequenceNumber, snapshot, connect, disconnect } =
    useClearinghouseSocket({
      url: "ws://localhost:3000/ws/clearinghouse",
      autoConnect: true,
      onTransaction: handleTransaction,
    });

  const stats = useMemo(() => {
    let pendingHitl = 0;
    let criticalRisk = 0;
    let totalVolume = 0;

    for (const item of snapshot) {
      if (item.hitlStatus === "PENDING_APPROVAL") pendingHitl++;
      if (item.riskScore > 70) criticalRisk++;
      if (typeof item.amount === "number") totalVolume += item.amount;
    }

    return {
      pendingHitl,
      criticalRisk,
      totalVolume,
      totalCount: snapshot.length,
    };
  }, [snapshot]);

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col font-sans">
      {/* Top Navigation / Status Header */}
      <header className="border-b border-slate-800 bg-[#0F172A]/80 backdrop-blur px-6 py-3.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-gradient-to-tr from-sky-600 to-indigo-600 flex items-center justify-center font-bold text-white shadow-lg shadow-sky-900/30">
            T
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-wide text-slate-100">
              TESSERA INSTITUTIONAL CLEARINGHOUSE
            </h1>
            <p className="text-[11px] font-mono text-slate-400">
              High-Frequency AG Grid Enterprise Supervisor Terminal
            </p>
          </div>
        </div>

        {/* Real-Time Telemetry Bar */}
        <div className="flex items-center gap-5 text-xs font-mono">
          <div className="flex items-center gap-2">
            <span className="text-slate-500">SEQ:</span>
            <span className="text-sky-400 font-semibold">
              #{lastSequenceNumber.toString().padStart(6, "0")}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-slate-500">RECORDS:</span>
            <span className="text-slate-300 font-semibold">{stats.totalCount}</span>
          </div>

          {/* Connection Status Pill */}
          <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-slate-900 border border-slate-800">
            <span
              className={`w-2 h-2 rounded-full ${
                isConnected
                  ? "bg-emerald-400 animate-pulse"
                  : connectionStatus === "reconnecting"
                    ? "bg-amber-400 animate-ping"
                    : "bg-rose-500"
              }`}
            />
            <span
              className={`text-[11px] font-medium uppercase tracking-wider ${
                isConnected
                  ? "text-emerald-400"
                  : connectionStatus === "reconnecting"
                    ? "text-amber-400"
                    : "text-rose-400"
              }`}
            >
              {connectionStatus}
            </span>
          </div>

          <button
            type="button"
            onClick={isConnected ? disconnect : connect}
            className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded border border-slate-700 text-[11px] transition-colors"
          >
            {isConnected ? "Disconnect" : "Connect"}
          </button>
        </div>
      </header>

      {/* KPI Stats Strip */}
      <section className="px-6 py-4 grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3.5 flex flex-col gap-1">
          <span className="text-slate-400 text-xs font-mono uppercase">Total Monitored Volume</span>
          <span className="text-xl font-bold font-mono text-emerald-400">
            {new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: "USD",
            }).format(stats.totalVolume / 100)}
          </span>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3.5 flex flex-col gap-1">
          <span className="text-slate-400 text-xs font-mono uppercase">Pending HITL Approvals</span>
          <span
            className={`text-xl font-bold font-mono ${
              stats.pendingHitl > 0 ? "text-amber-400 animate-pulse" : "text-slate-300"
            }`}
          >
            {stats.pendingHitl}
          </span>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3.5 flex flex-col gap-1">
          <span className="text-slate-400 text-xs font-mono uppercase">
            Critical Risk Anomalies
          </span>
          <span
            className={`text-xl font-bold font-mono ${
              stats.criticalRisk > 0 ? "text-rose-400 animate-pulse" : "text-slate-300"
            }`}
          >
            {stats.criticalRisk}
          </span>
        </div>

        <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-3.5 flex flex-col gap-1">
          <span className="text-slate-400 text-xs font-mono uppercase">Engine Latency SLA</span>
          <span className="text-xl font-bold font-mono text-sky-400">&lt; 50 µs</span>
        </div>
      </section>

      {/* Primary AG Grid Enterprise Ledger View */}
      <main className="flex-1 px-6 pb-6 flex flex-col">
        <ClearinghouseGrid
          ref={gridRef}
          rowData={snapshot}
          className="w-full flex-1 min-h-[580px]"
        />
      </main>
    </div>
  );
};
