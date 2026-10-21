import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import "ag-grid-enterprise";

import type { ColDef, GridApi, GridReadyEvent, ValueFormatterParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import type React from "react";
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ClearinghouseRecord, GridTransaction } from "../types.js";
import { ActionCellRenderer } from "./renderers/ActionCellRenderer.js";
import { RiskCellRenderer } from "./renderers/RiskCellRenderer.js";
import { StatusBadgeRenderer } from "./renderers/StatusBadgeRenderer.js";

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

    const onGridReady = useCallback(
      (params: GridReadyEvent<ClearinghouseRecord>) => {
        gridApiRef.current = params.api;
        if (onGridReadyProp) {
          onGridReadyProp(params);
        }
      },
      [onGridReadyProp],
    );

    const applyTransaction = useCallback((tx: GridTransaction) => {
      if (gridApiRef.current) {
        gridApiRef.current.applyTransactionAsync(tx);
      }
    }, []);

    const exportCsv = useCallback((filename = "clearinghouse-ledger.csv") => {
      if (gridApiRef.current) {
        gridApiRef.current.exportDataAsCsv({ fileName: filename });
      }
    }, []);

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
        },
        applyTransaction,
        setQuickFilter: (val: string) => {
          setQuickFilterState(val);
          if (gridApiRef.current) {
            gridApiRef.current.setGridOption("quickFilterText", val);
          }
        },
        exportCsv,
      }),
      [applyTransaction, exportCsv],
    );

    const formatCurrency = useCallback(
      (params: ValueFormatterParams<ClearinghouseRecord, number>) => {
        if (typeof params.value !== "number") return "-";
        const currency = params.data?.currency || "USD";
        // Amount in minor units (cents)
        return new Intl.NumberFormat("en-US", {
          style: "currency",
          currency,
        }).format(params.value / 100);
      },
      [],
    );

    const formatDate = useCallback((params: ValueFormatterParams<ClearinghouseRecord, string>) => {
      if (!params.value) return "-";
      try {
        const d = new Date(params.value);
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
      (params: { data: ClearinghouseRecord }) => params.data.transactionId,
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
