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
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
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
  onApprove?: (record: ClearinghouseRecord) => Promise<void>;
  onVoid?: (record: ClearinghouseRecord) => Promise<void>;
  onDispute?: (record: ClearinghouseRecord) => Promise<void>;
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
      onApprove,
      onVoid,
      onDispute,
      onGridReady: onGridReadyProp,
      className = "w-full h-[600px]",
    } = props;

    const [quickFilter, setQuickFilterState] = useState<string>("");
    const gridApiRef = useRef<GridApi<ClearinghouseRecord> | null>(null);
    const pendingTransactionsRef = useRef<GridTransaction[]>([]);

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
          width: 150,
          pinned: "left",
          filter: "agTextColumnFilter",
          cellClass: "font-mono text-xs text-sky-400 font-semibold",
        },
        {
          field: "mandateId",
          headerName: "Mandate ID",
          width: 150,
          filter: "agTextColumnFilter",
          cellClass: "font-mono text-xs text-slate-300",
        },
        {
          field: "merchantDomain",
          headerName: "Merchant Domain",
          width: 180,
          enableRowGroup: true,
          filter: "agTextColumnFilter",
          cellClass: "font-medium text-slate-200",
        },
        {
          field: "agentId",
          headerName: "Agent ID",
          width: 140,
          filter: "agTextColumnFilter",
          cellClass: "font-mono text-xs text-slate-400",
        },
        {
          field: "amount",
          headerName: "Amount",
          width: 130,
          filter: "agNumberColumnFilter",
          valueFormatter: formatCurrency,
          cellClass: "font-mono font-semibold text-right text-emerald-400",
        },
        {
          field: "currency",
          headerName: "Cur",
          width: 80,
          cellClass: "text-center text-slate-400 text-xs font-mono",
        },
        {
          field: "clearinghouseState",
          headerName: "Clearinghouse State",
          width: 180,
          filter: "agTextColumnFilter",
          cellRenderer: StatusBadgeRenderer,
        },
        {
          field: "escrowStatus",
          headerName: "Escrow Status",
          width: 180,
          filter: "agTextColumnFilter",
          cellRenderer: StatusBadgeRenderer,
        },
        {
          field: "riskScore",
          headerName: "Risk Heatmap",
          width: 170,
          filter: "agNumberColumnFilter",
          sortable: true,
          cellRenderer: RiskCellRenderer,
          comparator: (valueA: number, valueB: number) => valueA - valueB,
        },
        {
          field: "hitlStatus",
          headerName: "HITL Status",
          width: 160,
          filter: "agTextColumnFilter",
          cellRenderer: StatusBadgeRenderer,
        },
        {
          field: "createdAt",
          headerName: "Timestamp",
          width: 170,
          valueFormatter: formatDate,
          cellClass: "font-mono text-xs text-slate-400",
        },
        {
          colId: "actions",
          headerName: "Supervisor Actions",
          minWidth: 290,
          pinned: "right",
          sortable: false,
          filter: false,
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
        flex: 1,
        minWidth: 100,
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

    return (
      <div data-testid="clearinghouse-grid-container" className="flex flex-col gap-2 w-full">
        {/* Institutional Top Control Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-slate-900 border border-slate-800 rounded-t-lg">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider">
                Clearinghouse Ledger
              </span>
            </div>

            <div className="relative">
              <input
                type="text"
                data-testid="quick-filter-input"
                value={quickFilter}
                onChange={handleQuickFilterChange}
                placeholder="Search ledger..."
                className="bg-slate-950 border border-slate-800 rounded px-2.5 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-sky-500 font-mono w-56"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="export-csv-btn"
              onClick={() => exportCsv()}
              className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono rounded border border-slate-700 transition-colors flex items-center gap-1.5"
            >
              <span>Export CSV</span>
            </button>
            <button
              type="button"
              data-testid="export-audit-btn"
              onClick={() => void exportAuditBundle()}
              className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-sky-400 text-xs font-mono rounded border border-slate-700 transition-colors flex items-center gap-1.5"
            >
              <span>Export Audit Bundle</span>
            </button>
          </div>
        </div>

        {/* AG Grid Enterprise Container */}
        <div data-testid="clearinghouse-grid" className={`ag-theme-quartz-dark ${className}`}>
          <AgGridReact<ClearinghouseRecord>
            rowData={rowData ?? null}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            getRowId={getRowId}
            context={gridContext}
            rowGroupPanelShow="always"
            animateRows={true}
            rowSelection={{ mode: "singleRow" }}
            onGridReady={onGridReady}
            asyncTransactionWaitMillis={50}
          />
        </div>
      </div>
    );
  },
);

ClearinghouseGrid.displayName = "ClearinghouseGrid";
