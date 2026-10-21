// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ActionCellRenderer,
  ClearinghouseGrid,
  type ClearinghouseGridHandle,
  type ClearinghouseRecord,
  type GridTransaction,
  getRiskLevel,
  RiskCellRenderer,
  StatusBadgeRenderer,
  useClearinghouseSocket,
} from "../src/index.js";

// Mock Sample Records
const mockRecordLow: ClearinghouseRecord = {
  transactionId: "tx-low-001",
  mandateId: "man-001",
  agentId: "agent-alpha",
  merchantDomain: "merchant-a.com",
  amount: 25000, // $250.00
  currency: "USD",
  clearinghouseState: "PENDING_AUTHORIZATION",
  escrowStatus: "PENDING_AUTHORIZATION",
  riskScore: 15,
  riskTier: "LOW",
  hitlStatus: "NOT_REQUIRED",
  createdAt: "2026-10-21T10:00:00.000Z",
  updatedAt: "2026-10-21T10:00:00.000Z",
  sequenceNumber: 1,
  timestampMicros: 1774087200000000,
};

const mockRecordElevated: ClearinghouseRecord = {
  transactionId: "tx-elevated-002",
  mandateId: "man-002",
  agentId: "agent-beta",
  merchantDomain: "merchant-b.com",
  amount: 75000, // $750.00
  currency: "USD",
  clearinghouseState: "AUTHORIZED_IN_ESCROW",
  escrowStatus: "AUTHORIZED_HOLD",
  riskScore: 55,
  riskTier: "ELEVATED",
  hitlStatus: "PENDING_APPROVAL",
  createdAt: "2026-10-21T10:01:00.000Z",
  updatedAt: "2026-10-21T10:01:00.000Z",
  sequenceNumber: 2,
  timestampMicros: 1774087260000000,
};

const mockRecordCritical: ClearinghouseRecord = {
  transactionId: "tx-critical-003",
  mandateId: "man-003",
  agentId: "agent-gamma",
  merchantDomain: "merchant-c.com",
  amount: 150000, // $1500.00
  currency: "USD",
  clearinghouseState: "DISPUTED",
  escrowStatus: "SLA_BREACH_VOIDED",
  riskScore: 88,
  riskTier: "CRITICAL_HITL",
  hitlStatus: "PENDING_APPROVAL",
  createdAt: "2026-10-21T10:02:00.000Z",
  updatedAt: "2026-10-21T10:02:00.000Z",
  sequenceNumber: 3,
  timestampMicros: 1774087320000000,
};

// Mock WebSocket implementation for unit testing
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 10);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close(_code?: number, _reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose();
  }

  triggerMessage(data: unknown) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }

  triggerError(err: unknown) {
    if (this.onerror) this.onerror(err);
  }
}

describe("AG Grid Enterprise Clearinghouse Dashboard UI", () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    MockWebSocket.instances = [];
    // @ts-expect-error mock assignment
    globalThis.WebSocket = MockWebSocket;
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("Risk Heatmaps (RiskCellRenderer & getRiskLevel)", () => {
    it("renders dynamic risk heatmaps (0-30 green, 31-70 amber, 71-100 red)", () => {
      // 0-30 Green / Low
      render(<RiskCellRenderer score={15} data={mockRecordLow} />);
      const cellLow = screen.getByTestId("risk-cell");
      expect(cellLow).toHaveAttribute("data-risk-tier", "low");
      expect(cellLow).toHaveAttribute("data-risk-score", "15");
      expect(cellLow.textContent).toContain("LOW");
      expect(cellLow.className).toContain("text-emerald-400");
      expect(getRiskLevel(15)).toBe("low");
      expect(getRiskLevel(0)).toBe("low");
      expect(getRiskLevel(30)).toBe("low");

      // 31-70 Amber / Elevated
      const { unmount } = render(<RiskCellRenderer score={55} data={mockRecordElevated} />);
      const cellsElevated = screen.getAllByTestId("risk-cell");
      const cellElevated = cellsElevated[cellsElevated.length - 1];
      expect(cellElevated).toHaveAttribute("data-risk-tier", "elevated");
      expect(cellElevated).toHaveAttribute("data-risk-score", "55");
      expect(cellElevated.textContent).toContain("ELEVATED");
      expect(cellElevated.className).toContain("text-amber-400");
      expect(getRiskLevel(31)).toBe("elevated");
      expect(getRiskLevel(70)).toBe("elevated");
      unmount();

      // 71-100 Red / Critical
      render(<RiskCellRenderer score={88} data={mockRecordCritical} />);
      const cellsCritical = screen.getAllByTestId("risk-cell");
      const cellCritical = cellsCritical[cellsCritical.length - 1];
      expect(cellCritical).toHaveAttribute("data-risk-tier", "critical");
      expect(cellCritical).toHaveAttribute("data-risk-score", "88");
      expect(cellCritical.textContent).toContain("CRITICAL");
      expect(cellCritical.className).toContain("text-rose-400");
      expect(cellCritical.className).toContain("animate-pulse");
      expect(getRiskLevel(71)).toBe("critical");
      expect(getRiskLevel(100)).toBe("critical");
    });

    it("clamps boundary values below 0 and above 100 gracefully", () => {
      render(<RiskCellRenderer score={-10} />);
      const cellMin = screen.getAllByTestId("risk-cell")[0];
      expect(cellMin).toHaveAttribute("data-risk-score", "0");
      expect(cellMin).toHaveAttribute("data-risk-tier", "low");

      render(<RiskCellRenderer score={125} />);
      const cells = screen.getAllByTestId("risk-cell");
      const cellMax = cells[cells.length - 1];
      expect(cellMax).toHaveAttribute("data-risk-score", "100");
      expect(cellMax).toHaveAttribute("data-risk-tier", "critical");
    });
  });

  describe("Status Badge Styling (StatusBadgeRenderer)", () => {
    it("renders institutional status badges with appropriate theme tints", () => {
      const { unmount: u1 } = render(<StatusBadgeRenderer status="SETTLED" />);
      expect(screen.getByTestId("status-badge").className).toContain("text-emerald-300");
      u1();

      const { unmount: u2 } = render(<StatusBadgeRenderer status="AUTHORIZED_IN_ESCROW" />);
      expect(screen.getByTestId("status-badge").className).toContain("text-cyan-300");
      u2();

      const { unmount: u3 } = render(<StatusBadgeRenderer status="PENDING_APPROVAL" />);
      expect(screen.getByTestId("status-badge").className).toContain("text-amber-300");
      u3();

      const { unmount: u4 } = render(<StatusBadgeRenderer status="SLA_BREACH_VOIDED" />);
      expect(screen.getByTestId("status-badge").className).toContain("text-rose-300");
      u4();

      render(<StatusBadgeRenderer status="NOT_REQUIRED" />);
      expect(screen.getByTestId("status-badge").className).toContain("text-slate-400");
    });
  });

  describe("1-Click HITL Supervisor Actions (ActionCellRenderer)", () => {
    it("executes 1-click supervisor counter-signature approval", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "APPROVED" }),
      });
      globalThis.fetch = mockFetch;

      const onApprove = vi.fn().mockResolvedValue(undefined);

      render(<ActionCellRenderer record={mockRecordElevated} onApprove={onApprove} />);

      const approveBtn = screen.getByTestId("action-approve");
      expect(approveBtn).not.toBeDisabled();

      fireEvent.click(approveBtn);

      await waitFor(() => {
        expect(onApprove).toHaveBeenCalledTimes(1);
        expect(onApprove).toHaveBeenCalledWith(mockRecordElevated);
      });
    });

    it("dispatches REST POST to /counter-sign when no custom callback is supplied", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "APPROVED" }),
      });
      globalThis.fetch = mockFetch;

      render(<ActionCellRenderer record={mockRecordElevated} apiBaseUrl="http://localhost:3000" />);

      const approveBtn = screen.getByTestId("action-approve");
      fireEvent.click(approveBtn);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:3000/api/v1/mandates/man-002/counter-sign",
          expect.objectContaining({
            method: "POST",
            headers: { "Content-Type": "application/json" },
          }),
        );
      });
    });

    it("dispatches authorization void on SLA breach", async () => {
      const onVoid = vi.fn().mockResolvedValue(undefined);

      render(<ActionCellRenderer record={mockRecordElevated} onVoid={onVoid} />);

      const voidBtn = screen.getByTestId("action-void");
      expect(voidBtn).not.toBeDisabled();

      fireEvent.click(voidBtn);

      await waitFor(() => {
        expect(onVoid).toHaveBeenCalledTimes(1);
        expect(onVoid).toHaveBeenCalledWith(mockRecordElevated);
      });
    });

    it("dispatches REST POST to /void when no custom callback is supplied", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "VOIDED" }),
      });
      globalThis.fetch = mockFetch;

      render(<ActionCellRenderer record={mockRecordElevated} apiBaseUrl="http://localhost:3000" />);

      const voidBtn = screen.getByTestId("action-void");
      fireEvent.click(voidBtn);

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          "http://localhost:3000/api/v1/mandates/man-002/void",
          expect.objectContaining({
            method: "POST",
            headers: { "Content-Type": "application/json" },
          }),
        );
      });
    });

    it("executes 1-click dispute escalation", async () => {
      const onDispute = vi.fn().mockResolvedValue(undefined);

      render(<ActionCellRenderer record={mockRecordElevated} onDispute={onDispute} />);

      const disputeBtn = screen.getByTestId("action-dispute");
      expect(disputeBtn).not.toBeDisabled();

      fireEvent.click(disputeBtn);

      await waitFor(() => {
        expect(onDispute).toHaveBeenCalledTimes(1);
        expect(onDispute).toHaveBeenCalledWith(mockRecordElevated);
      });
    });

    it("disables action buttons while an action request is in flight", async () => {
      let resolvePromise: () => void = () => {};
      const pendingPromise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
      });

      const onApprove = vi.fn().mockReturnValue(pendingPromise);

      render(<ActionCellRenderer record={mockRecordElevated} onApprove={onApprove} />);

      const approveBtn = screen.getByTestId("action-approve");
      const voidBtn = screen.getByTestId("action-void");
      const disputeBtn = screen.getByTestId("action-dispute");

      fireEvent.click(approveBtn);

      // Verify button shows in-flight state and buttons are disabled
      expect(approveBtn.textContent).toContain("Approving...");
      expect(approveBtn).toBeDisabled();
      expect(voidBtn).toBeDisabled();
      expect(disputeBtn).toBeDisabled();

      // Resolve in-flight promise
      act(() => {
        resolvePromise();
      });

      await waitFor(() => {
        expect(approveBtn.textContent).toBe("Approve");
        expect(approveBtn).not.toBeDisabled();
      });
    });
  });

  describe("WebSocket Hook (useClearinghouseSocket)", () => {
    it("hydrates state snapshot and notifies onSnapshot callback", async () => {
      const onSnapshot = vi.fn();
      const onTransaction = vi.fn();

      const { result } = renderHook(() =>
        useClearinghouseSocket({
          url: "ws://localhost:3000/ws/clearinghouse",
          autoConnect: true,
          onSnapshot,
          onTransaction,
        }),
      );

      // Wait for mock socket connection
      await waitFor(() => {
        expect(MockWebSocket.instances.length).toBe(1);
        expect(result.current.isConnected).toBe(true);
      });

      const ws = MockWebSocket.instances[0];

      // Simulate snapshot frame from server
      act(() => {
        ws.triggerMessage({
          type: "snapshot",
          channel: "ledger",
          sequenceNumber: 10,
          timestampMicros: 1774087200000000,
          data: [mockRecordLow, mockRecordElevated],
        });
      });

      await waitFor(() => {
        expect(result.current.snapshot).toHaveLength(2);
        expect(result.current.lastSequenceNumber).toBe(10);
        expect(onSnapshot).toHaveBeenCalledWith([mockRecordLow, mockRecordElevated]);
      });
    });

    it("applies streaming delta transactions decoupled from React state", async () => {
      const onTransaction = vi.fn();

      const { result } = renderHook(() =>
        useClearinghouseSocket({
          url: "ws://localhost:3000/ws/clearinghouse",
          autoConnect: true,
          onTransaction,
        }),
      );

      await waitFor(() => {
        expect(MockWebSocket.instances.length).toBe(1);
      });

      const ws = MockWebSocket.instances[0];

      const streamingDeltaBatch = {
        type: "delta",
        channel: "ledger",
        sequenceNumber: 11,
        timestampMicros: 1774087260000000,
        timestamp: "2026-10-21T10:01:00.000Z",
        deltas: [
          {
            type: "update",
            data: { ...mockRecordElevated, hitlStatus: "APPROVED" },
          },
        ],
        transaction: {
          add: [],
          update: [{ ...mockRecordElevated, hitlStatus: "APPROVED" }],
          remove: [],
        },
      };

      act(() => {
        ws.triggerMessage(streamingDeltaBatch);
      });

      await waitFor(() => {
        expect(onTransaction).toHaveBeenCalledTimes(1);
        expect(onTransaction).toHaveBeenCalledWith(streamingDeltaBatch.transaction);
        expect(result.current.lastSequenceNumber).toBe(11);
      });

      // Verify transaction was buffered and can be flushed
      const buffered = result.current.getBufferedTransactions();
      expect(buffered).toHaveLength(1);

      const flushedHandler = vi.fn();
      act(() => {
        result.current.flushBuffer(flushedHandler);
      });

      expect(flushedHandler).toHaveBeenCalledTimes(1);
      expect(result.current.getBufferedTransactions()).toHaveLength(0);
    });

    it("automatically reconnects upon socket disconnection", async () => {
      vi.useFakeTimers();

      const { result } = renderHook(() =>
        useClearinghouseSocket({
          url: "ws://localhost:3000/ws/clearinghouse",
          autoConnect: true,
          reconnectIntervalMs: 100,
          maxReconnectIntervalMs: 500,
        }),
      );

      // Run timers for initial connect
      act(() => {
        vi.advanceTimersByTime(20);
      });

      expect(MockWebSocket.instances.length).toBe(1);
      const ws1 = MockWebSocket.instances[0];

      // Simulate unexpected server disconnect
      act(() => {
        ws1.close(1006, "Abnormal closure");
      });

      expect(result.current.connectionStatus).toBe("reconnecting");
      expect(result.current.isConnected).toBe(false);

      // Advance timers to trigger reconnect
      act(() => {
        vi.advanceTimersByTime(350);
      });

      expect(MockWebSocket.instances.length).toBe(2);

      vi.useRealTimers();
    });
  });

  describe("ClearinghouseGrid Component", () => {
    it("renders grid container, toolbar, and quick filter input", () => {
      render(<ClearinghouseGrid rowData={[mockRecordLow, mockRecordElevated]} />);

      expect(screen.getByTestId("clearinghouse-grid-container")).toBeInTheDocument();
      expect(screen.getByTestId("clearinghouse-grid")).toBeInTheDocument();
      expect(screen.getByTestId("quick-filter-input")).toBeInTheDocument();
      expect(screen.getByTestId("export-csv-btn")).toBeInTheDocument();
    });

    it("applies streaming delta transactions via applyTransactionAsync", async () => {
      const gridRef = createRef<ClearinghouseGridHandle>();

      render(<ClearinghouseGrid ref={gridRef} rowData={[mockRecordLow]} />);

      // Mock gridApi applyTransactionAsync
      const mockApplyTransactionAsync = vi.fn().mockResolvedValue({
        status: "SUCCESS",
      });

      if (gridRef.current) {
        // @ts-expect-error test mock injection
        gridRef.current.api = {
          applyTransactionAsync: mockApplyTransactionAsync,
          setGridOption: vi.fn(),
          exportDataAsCsv: vi.fn(),
        };
      }

      const tx: GridTransaction = {
        add: [mockRecordCritical],
        update: [{ ...mockRecordLow, riskScore: 28 }],
        remove: [],
      };

      act(() => {
        gridRef.current?.applyTransaction(tx);
      });

      // Verify applyTransaction delegated to AG Grid applyTransactionAsync
      expect(mockApplyTransactionAsync).toHaveBeenCalledWith(tx);
    });

    it("updates quick filter and executes CSV export on button click", async () => {
      const gridRef = createRef<ClearinghouseGridHandle>();

      render(<ClearinghouseGrid ref={gridRef} rowData={[mockRecordLow]} />);

      const mockExportDataAsCsv = vi.fn();
      const mockSetGridOption = vi.fn();

      if (gridRef.current) {
        // @ts-expect-error test mock injection
        gridRef.current.api = {
          applyTransactionAsync: vi.fn(),
          setGridOption: mockSetGridOption,
          exportDataAsCsv: mockExportDataAsCsv,
        };
      }

      // Quick filter
      const filterInput = screen.getByTestId("quick-filter-input");
      fireEvent.change(filterInput, { target: { value: "merchant-a" } });

      expect(mockSetGridOption).toHaveBeenCalledWith("quickFilterText", "merchant-a");

      // Export CSV
      const exportBtn = screen.getByTestId("export-csv-btn");
      fireEvent.click(exportBtn);

      expect(mockExportDataAsCsv).toHaveBeenCalledWith({
        fileName: "clearinghouse-ledger.csv",
      });
    });
  });
});
