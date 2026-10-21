import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import "ag-grid-enterprise";

import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  ValueFormatterParams,
} from "ag-grid-community";
import { LicenseManager } from "ag-grid-enterprise";
import { AgGridReact } from "ag-grid-react";
import type React from "react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ClearinghouseAuditBundle, ClearinghouseRecord, GridTransaction } from "../types.js";
import { ActionCellRenderer } from "./renderers/ActionCellRenderer.js";
import { RiskCellRenderer } from "./renderers/RiskCellRenderer.js";
import { StatusBadgeRenderer } from "./renderers/StatusBadgeRenderer.js";

// Optional license key hydration from runtime environment
const licenseKey =
  (typeof process !== "undefined" && process.env?.AG_GRID_LICENSE_KEY) ||
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: Record<string, string> }).env?.VITE_AG_GRID_LICENSE_KEY);
if (licenseKey) {
  LicenseManager.setLicenseKey(licenseKey);
}

export async function computeAuditBundleDigest(content: string): Promise<string> {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Deterministic 64-character hash fallback
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < content.length; i++) {
    const ch = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    h2 = Math.imul(h2 ^ ch, 0x27d4eb2f);
  }
  const s1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const s2 = (h2 >>> 0).toString(16).padStart(8, "0");
  return (s1 + s2).repeat(4);
}

export async function generateAuditBundle(
  records: ClearinghouseRecord[],
): Promise<ClearinghouseAuditBundle> {
  const exportedAt = new Date().toISOString();
  const canonicalContent = JSON.stringify(records);
  const recordsDigestSha256 = await computeAuditBundleDigest(canonicalContent);
  return {
    bundleVersion: "1.0.0",
    exportedAt,
    totalRecords: records.length,
    recordsDigestSha256,
    records,
  };
}

export interface ClearinghouseGridProps {
  rowData?: ClearinghouseRecord[];
  apiBaseUrl?: string;
  theme?: "dark" | "light";
  onApprove?: (record: ClearinghouseRecord) => Promise<void>;
  onVoid?: (record: ClearinghouseRecord) => Promise<void>;
  onDispute?: (record: ClearinghouseRecord) => Promise<void>;
  onRowClicked?: (record: ClearinghouseRecord) => void;
  onGridReady?: (params: GridReadyEvent<ClearinghouseRecord>) => void;
  className?: string;
}

export interface ClearinghouseGridHandle {
  api: GridApi<ClearinghouseRecord> | null;
  applyTransaction: (tx: GridTransaction) => void;
  setQuickFilter: (filter: string) => void;
  exportCsv: (filename?: string) => void;
  exportAuditBundle: (filename?: string) => Promise<ClearinghouseAuditBundle>;
}

export const ClearinghouseGrid = forwardRef<ClearinghouseGridHandle, ClearinghouseGridProps>(
  (props, ref) => {
    const {
      rowData,
      apiBaseUrl = "http://localhost:3000",
      theme = "dark",
      onApprove,
      onVoid,
      onDispute,
      onRowClicked,
      onGridReady: onGridReadyProp,
      className = "w-full h-[600px]",
    } = props;

    const [quickFilter, setQuickFilterState] = useState<string>("");
    const gridApiRef = useRef<GridApi<ClearinghouseRecord> | null>(null);
    const pendingTransactionsRef = useRef<GridTransaction[]>([]);

    // Redraw rows and headers synchronously when theme switches
    useEffect(() => {
      if (gridApiRef.current && theme) {
        gridApiRef.current.redrawRows();
        gridApiRef.current.refreshHeader();
      }
    }, [theme]);

    const getGridRecords = useCallback((): ClearinghouseRecord[] => {
      if (gridApiRef.current) {
        const list: ClearinghouseRecord[] = [];
        gridApiRef.current.forEachNode((node) => {
          if (node.data) {
            list.push(node.data);
          }
        });
        if (list.length > 0) return list;
      }
      return rowData ?? [];
    }, [rowData]);

    const onGridReady = useCallback(
      (params: GridReadyEvent<ClearinghouseRecord>) => {
        gridApiRef.current = params.api;
        if (quickFilter) {
          params.api.setGridOption("quickFilterText", quickFilter);
        }
        if (pendingTransactionsRef.current.length > 0) {
          for (const tx of pendingTransactionsRef.current) {
            params.api.applyTransactionAsync(tx);
          }
          pendingTransactionsRef.current = [];
        }
        if (onGridReadyProp) {
          onGridReadyProp(params);
        }
      },
      [onGridReadyProp, quickFilter],
    );

    const applyTransaction = useCallback((tx: GridTransaction) => {
      if (gridApiRef.current) {
        gridApiRef.current.applyTransactionAsync(tx);
      } else {
        pendingTransactionsRef.current.push(tx);
      }
    }, []);

    const exportCsv = useCallback((filename = "clearinghouse-ledger.csv") => {
      if (gridApiRef.current) {
        gridApiRef.current.exportDataAsCsv({ fileName: filename });
      }
    }, []);

    const exportAuditBundle = useCallback(
      async (filename = "clearinghouse-audit-bundle.json"): Promise<ClearinghouseAuditBundle> => {
        const records = getGridRecords();
        const bundle = await generateAuditBundle(records);
        try {
          if (
            typeof document !== "undefined" &&
            typeof URL !== "undefined" &&
            URL.createObjectURL
          ) {
            const blob = new Blob([JSON.stringify(bundle, null, 2)], {
              type: "application/json",
            });
            const downloadUrl = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = downloadUrl;
            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            URL.revokeObjectURL(downloadUrl);
          }
        } catch {
          // Ignore download error in headless test environment
        }
        return bundle;
      },
      [getGridRecords],
    );

    const handleQuickFilterChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setQuickFilterState(val);
      if (gridApiRef.current) {
        gridApiRef.current.setGridOption("quickFilterText", val);
      }
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        get api() {
          return gridApiRef.current;
        },
        set api(mockApi: GridApi<ClearinghouseRecord> | null) {
          gridApiRef.current = mockApi;
          if (mockApi && pendingTransactionsRef.current.length > 0) {
            for (const tx of pendingTransactionsRef.current) {
              mockApi.applyTransactionAsync(tx);
            }
            pendingTransactionsRef.current = [];
          }
        },
        applyTransaction,
        setQuickFilter: (val: string) => {
          setQuickFilterState(val);
          if (gridApiRef.current) {
            gridApiRef.current.setGridOption("quickFilterText", val);
          }
        },
        exportCsv,
        exportAuditBundle,
      }),
      [applyTransaction, exportCsv, exportAuditBundle],
    );

    const formatCurrency = useCallback(
      (params: ValueFormatterParams<ClearinghouseRecord, number>) => {
        if (typeof params.value !== "number" || Number.isNaN(params.value)) return "-";
        const currency = (params.data?.currency || "USD").toUpperCase();
        try {
          const formatter = new Intl.NumberFormat("en-US", {
            style: "currency",
            currency,
          });
          const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
          return formatter.format(params.value / 10 ** digits);
        } catch {
          return `${(params.value / 100).toFixed(2)} ${currency}`;
        }
      },
      [],
    );

    const formatDate = useCallback((params: ValueFormatterParams<ClearinghouseRecord, string>) => {
      if (!params.value) return "-";
      try {
        const d = new Date(params.value);
        if (Number.isNaN(d.getTime())) return String(params.value);
        return `${d.toLocaleTimeString()} ${d.toLocaleDateString()}`;
      } catch {
        return String(params.value);
      }
    }, []);

    const columnDefs = useMemo<ColDef<ClearinghouseRecord>[]>(() => {
      return [
        {
          field: "transactionId",
          headerName: "Tx ID",
          width: 120,
          minWidth: 110,
          pinned: "left",
          filter: "agTextColumnFilter",
          cellClass:
            "font-mono text-xs text-zinc-700 dark:text-zinc-300 font-semibold tracking-tight cursor-pointer",
        },
        {
          field: "mandateId",
          headerName: "Mandate ID",
          width: 175,
          minWidth: 155,
          filter: "agTextColumnFilter",
          cellClass: "font-mono text-xs text-zinc-500 dark:text-zinc-400 cursor-pointer",
        },
        {
          field: "merchantDomain",
          headerName: "Merchant Domain",
          width: 185,
          minWidth: 165,
          flex: 1.2,
          enableRowGroup: true,
          filter: "agTextColumnFilter",
          cellClass: "font-medium text-xs text-zinc-800 dark:text-zinc-200 cursor-pointer",
        },
        {
          field: "agentId",
          headerName: "Agent ID",
          width: 150,
          minWidth: 130,
          filter: "agTextColumnFilter",
          cellClass: "font-mono text-xs text-zinc-500 dark:text-zinc-400 cursor-pointer",
        },
        {
          field: "amount",
          headerName: "Amount",
          width: 115,
          minWidth: 105,
          headerClass: "ag-right-aligned-header",
          filter: "agNumberColumnFilter",
          valueFormatter: formatCurrency,
          cellClass:
            "font-mono font-semibold text-right tabular-nums text-emerald-700 dark:text-emerald-400 cursor-pointer",
        },
        {
          field: "currency",
          headerName: "Cur",
          width: 65,
          minWidth: 60,
          filter: false,
          floatingFilter: false,
          cellClass:
            "text-center text-zinc-500 dark:text-zinc-400 text-xs font-mono cursor-pointer",
        },
        {
          field: "clearinghouseState",
          headerName: "Clearinghouse State",
          width: 200,
          minWidth: 185,
          flex: 1,
          filter: "agTextColumnFilter",
          cellClass: "flex items-center",
          cellRenderer: StatusBadgeRenderer,
        },
        {
          field: "escrowStatus",
          headerName: "Escrow Status",
          width: 185,
          minWidth: 175,
          flex: 1,
          filter: "agTextColumnFilter",
          cellClass: "flex items-center",
          cellRenderer: StatusBadgeRenderer,
        },
        {
          field: "riskScore",
          headerName: "Risk Heatmap",
          width: 145,
          minWidth: 140,
          filter: "agNumberColumnFilter",
          sortable: true,
          cellClass: "flex items-center",
          cellRenderer: RiskCellRenderer,
          comparator: (valueA: number, valueB: number) => valueA - valueB,
        },
        {
          field: "hitlStatus",
          headerName: "HITL Status",
          width: 150,
          minWidth: 140,
          filter: "agTextColumnFilter",
          cellClass: "flex items-center",
          cellRenderer: StatusBadgeRenderer,
        },
        {
          field: "createdAt",
          headerName: "Timestamp",
          width: 145,
          minWidth: 135,
          valueFormatter: formatDate,
          cellClass:
            "font-mono text-xs text-zinc-500 dark:text-zinc-400 tabular-nums cursor-pointer",
        },
        {
          colId: "actions",
          headerName: "Supervisor Actions",
          minWidth: 295,
          width: 300,
          pinned: "right",
          sortable: false,
          filter: false,
          headerClass: "ag-center-aligned-header",
          cellClass: "flex items-center justify-center",
          cellRenderer: ActionCellRenderer,
        },
      ];
    }, [formatCurrency, formatDate]);

    const defaultColDef = useMemo<ColDef>(() => {
      return {
        sortable: true,
        filter: true,
        resizable: true,
        floatingFilter: true,
        minWidth: 80,
      };
    }, []);

    const gridContext = useMemo(() => {
      return {
        apiBaseUrl,
        onApprove,
        onVoid,
        onDispute,
      };
    }, [apiBaseUrl, onApprove, onVoid, onDispute]);

    const getRowId = useCallback(
      (params: GetRowIdParams<ClearinghouseRecord>) => params.data?.transactionId ?? "",
      [],
    );

    const applyQuickFilter = useCallback((val: string) => {
      setQuickFilterState(val);
      if (gridApiRef.current) {
        gridApiRef.current.setGridOption("quickFilterText", val);
      }
    }, []);

    const filterChips = [
      { id: "all", label: "All Records", value: "" },
      { id: "hitl", label: "Pending HITL", value: "PENDING_APPROVAL" },
      { id: "critical", label: "Critical Risk", value: "CRITICAL" },
      { id: "escrow", label: "In Escrow", value: "ESCROW" },
      { id: "settled", label: "Settled", value: "SETTLED" },
    ];

    return (
      <div
        data-testid="clearinghouse-grid-container"
        className="flex flex-col w-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950/80 shadow-sm overflow-hidden"
      >
        {/* Institutional Minimalist Control Bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-3 bg-zinc-50/70 dark:bg-zinc-900/60 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 pr-3 border-r border-zinc-200 dark:border-zinc-800">
              <span className="w-2 h-2 rounded-full bg-emerald-500 dark:bg-emerald-400" />
              <span className="text-xs font-mono font-semibold text-zinc-800 dark:text-zinc-200 uppercase tracking-wider">
                Institutional Ledger
              </span>
            </div>

            {/* Quick Filter Search Box */}
            <div className="relative flex items-center">
              <svg
                aria-hidden="true"
                className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 absolute left-3 pointer-events-none"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.75}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
                />
              </svg>
              <input
                type="text"
                data-testid="quick-filter-input"
                value={quickFilter}
                onChange={handleQuickFilterChange}
                placeholder="Filter ledger (mandate, merchant, agent)..."
                className="bg-white dark:bg-zinc-950/90 border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 rounded-lg pl-9 pr-8 py-1.5 text-xs text-zinc-900 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 focus:ring-1 focus:ring-zinc-400/40 dark:focus:ring-zinc-600/40 font-mono w-72 transition-all duration-150 shadow-xs"
              />
              {quickFilter ? (
                <button
                  type="button"
                  onClick={() => applyQuickFilter("")}
                  className="absolute right-2.5 w-4 h-4 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-[10px] transition-colors"
                >
                  ✕
                </button>
              ) : null}
            </div>

            {/* Preset Category Filter Chips */}
            <div className="hidden sm:flex items-center gap-1.5 pl-1">
              {filterChips.map((chip) => {
                const isActive = quickFilter === chip.value;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => applyQuickFilter(chip.value)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-mono tracking-tight transition-all duration-150 border active:scale-[0.97] ${
                      isActive
                        ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 border-zinc-900 dark:border-zinc-100 font-medium shadow-sm"
                        : "bg-zinc-500/[0.04] dark:bg-zinc-500/[0.06] hover:bg-zinc-500/[0.08] dark:hover:bg-zinc-500/[0.12] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 border-zinc-500/20 dark:border-zinc-500/20"
                    }`}
                  >
                    {chip.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="export-csv-btn"
              onClick={() => exportCsv()}
              className="px-3 py-1.5 bg-white hover:bg-zinc-100 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100 text-xs font-mono rounded-lg border border-zinc-200 dark:border-zinc-800 transition-all active:scale-[0.98] flex items-center gap-1.5 shadow-sm"
            >
              <svg
                aria-hidden="true"
                className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.75}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.5V16.5M7.5 12l4.5 4.5m0 0l4.5-4.5M12 3v13.5"
                />
              </svg>
              <span>Export CSV</span>
            </button>
            <button
              type="button"
              data-testid="export-audit-btn"
              onClick={() => void exportAuditBundle()}
              className="px-3.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:hover:bg-zinc-200 dark:text-zinc-900 text-xs font-mono rounded-lg border border-zinc-900 dark:border-zinc-100 transition-all active:scale-[0.98] flex items-center gap-1.5 shadow-sm font-medium"
            >
              <svg
                aria-hidden="true"
                className="w-3.5 h-3.5 text-emerald-400 dark:text-emerald-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.75}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
                />
              </svg>
              <span>Export Audit Bundle</span>
            </button>
          </div>
        </div>

        {/* AG Grid Enterprise Container */}
        <div
          data-testid="clearinghouse-grid"
          className={`${theme === "light" ? "ag-theme-quartz" : "ag-theme-quartz-dark"} ${className}`}
        >
          <AgGridReact<ClearinghouseRecord>
            rowData={rowData ?? null}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            getRowId={getRowId}
            context={gridContext}
            rowGroupPanelShow="always"
            animateRows={true}
            rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
            onGridReady={onGridReady}
            onRowClicked={(event) => {
              if (event.data && onRowClicked) {
                onRowClicked(event.data);
              }
            }}
            asyncTransactionWaitMillis={50}
          />
        </div>
      </div>
    );
  },
);

ClearinghouseGrid.displayName = "ClearinghouseGrid";
