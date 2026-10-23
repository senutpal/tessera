// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProcurementGantt,
  type ProcurementGanttHandle,
} from "../src/components/gantt/ProcurementGantt.js";
import type { ClearinghouseRecord } from "../src/types.js";

const mockRecord1: ClearinghouseRecord = {
  transactionId: "tx-gantt-101",
  mandateId: "man-101",
  agentId: "agent-infra-01",
  merchantDomain: "aws.amazon.com",
  amount: 1425000,
  currency: "USD",
  clearinghouseState: "AUTHORIZED_IN_ESCROW",
  escrowStatus: "AUTHORIZED_HOLD",
  riskScore: 18,
  riskTier: "LOW",
  hitlStatus: "NOT_REQUIRED",
  authorizationId: "auth-aws-9912",
  createdAt: "2026-10-21T08:00:00.000Z",
  updatedAt: "2026-10-21T08:30:00.000Z",
  sequenceNumber: 101,
  timestampMicros: 1774080000000000,
};

const mockRecordDelayed: ClearinghouseRecord = {
  transactionId: "tx-gantt-102",
  mandateId: "man-102",
  agentId: "agent-procure-11",
  merchantDomain: "delayed-supplier.com",
  amount: 540000,
  currency: "USD",
  clearinghouseState: "AUTHORIZED_IN_ESCROW",
  escrowStatus: "IN_TRANSIT",
  riskScore: 82,
  riskTier: "CRITICAL_HITL",
  hitlStatus: "APPROVED",
  authorizationId: "auth-del-5521",
  trackingId: "FEDEX-DELAY-991",
  carrier: "FedEx",
  createdAt: "2026-10-10T08:00:00.000Z",
  updatedAt: "2026-10-12T08:00:00.000Z",
  sequenceNumber: 102,
  timestampMicros: 1773129600000000,
};

describe("Bryntum Gantt Component & Critical Path View (ProcurementGantt)", () => {
  beforeEach(() => {
    if (typeof window !== "undefined" && !window.matchMedia) {
      window.matchMedia = vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
    }
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe("Gantt Toolbar & Component Layout", () => {
    it("renders the procurement Gantt container, title, and timeline controls", () => {
      render(<ProcurementGantt records={[mockRecord1]} />);

      const ganttContainer = screen.getByTestId("procurement-gantt");
      expect(ganttContainer).toBeInTheDocument();

      expect(screen.getByText(/Procurement Milestone SLA Scheduler/i)).toBeInTheDocument();
      expect(screen.getByTestId("critical-path-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("zoom-in-btn")).toBeInTheDocument();
      expect(screen.getByTestId("zoom-out-btn")).toBeInTheDocument();
      expect(screen.getByTestId("zoom-fit-btn")).toBeInTheDocument();
    });

    it("renders task milestones and displays stage markers", () => {
      render(<ProcurementGantt records={[mockRecord1]} />);

      expect(screen.getByText(/Mandate Verification/i)).toBeInTheDocument();
      expect(screen.getByText(/Escrow Authorization Hold/i)).toBeInTheDocument();
      expect(screen.getByText(/Merchant Fulfillment & Dispatch/i)).toBeInTheDocument();

      const milestoneMarkers = screen.getAllByTestId("milestone-marker");
      expect(milestoneMarkers.length).toBeGreaterThan(0);
    });

    it("escapes malicious task name, status, and duration in Bryntum taskTooltip template", () => {
      let capturedConfig:
        | {
            features?: {
              taskTooltip?: {
                template?: (data?: {
                  taskRecord?:
                    | {
                        name?: string | undefined;
                        status?: string | undefined;
                        duration?: number | undefined;
                      }
                    | undefined;
                }) => string;
              };
            };
          }
        | undefined;
      const factory = vi.fn().mockImplementation((config) => {
        capturedConfig = config;
        return {
          destroy: vi.fn(),
          isDestroyed: false,
        };
      });

      render(<ProcurementGantt records={[mockRecord1]} ganttInstanceFactory={factory} />);

      expect(capturedConfig?.features?.taskTooltip?.template).toBeDefined();
      const template = capturedConfig?.features?.taskTooltip?.template;
      expect(template).toBeDefined();
      if (!template) throw new Error("taskTooltip template was not defined");

      const maliciousHtml = template({
        taskRecord: {
          name: '<script>alert("xss")</script>',
          status: "<img src=x onerror=alert(1)>",
          duration: "<svg/onload=alert(2)>" as unknown as number,
        },
      });

      expect(maliciousHtml).not.toContain("<script>");
      expect(maliciousHtml).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
      expect(maliciousHtml).not.toContain("<img");
      expect(maliciousHtml).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(maliciousHtml).not.toContain("<svg");
      expect(maliciousHtml).toContain("&lt;svg/onload=alert(2)&gt;");

      const zeroHtml = template({
        taskRecord: { name: "Normal Task", status: "PENDING", duration: 0 },
      });
      expect(zeroHtml).toContain("Duration: 0h");

      const undefinedHtml = template({
        taskRecord: { name: "Undefined Duration Task", status: "PENDING" },
      });
      expect(undefinedHtml).toContain("Duration: 0h");

      // Verify nullish data or missing taskRecord does not throw uncaught error
      expect(() => template()).not.toThrow();
      expect(() => template({})).not.toThrow();
      expect(() => template({ taskRecord: undefined })).not.toThrow();
      const emptyHtml = template();
      expect(emptyHtml).toContain("Duration: 0h");
    });
  });

  describe("Critical Path Highlighting & Toggling", () => {
    it("toggles critical path on and off when button is clicked", () => {
      const handleToggle = vi.fn();
      render(
        <ProcurementGantt
          records={[mockRecord1]}
          onToggleCriticalPath={handleToggle}
          showCriticalPath={false}
        />,
      );

      const toggleBtn = screen.getByTestId("critical-path-toggle");
      expect(toggleBtn).toHaveAttribute("data-active", "false");

      fireEvent.click(toggleBtn);
      expect(handleToggle).toHaveBeenCalledWith(true);
    });

    it("highlights critical path bottleneck tasks with visual indicators when active", () => {
      render(<ProcurementGantt records={[mockRecord1]} showCriticalPath={true} />);

      const toggleBtn = screen.getByTestId("critical-path-toggle");
      expect(toggleBtn).toHaveAttribute("data-active", "true");

      const criticalTasks = screen.getAllByTestId("critical-task-indicator");
      expect(criticalTasks.length).toBeGreaterThan(0);
    });
  });

  describe("Zooming Controls & Imperative Handle", () => {
    it("exposes imperative controls for zooming and critical path via ref", () => {
      const ref = createRef<ProcurementGanttHandle>();
      render(<ProcurementGantt ref={ref} records={[mockRecord1]} />);

      expect(ref.current).toBeDefined();
      expect(typeof ref.current?.zoomIn).toBe("function");
      expect(typeof ref.current?.zoomOut).toBe("function");
      expect(typeof ref.current?.zoomToFit).toBe("function");
      expect(typeof ref.current?.toggleCriticalPath).toBe("function");

      // Verify invoking imperative methods succeeds without throwing
      expect(() => {
        act(() => {
          ref.current?.zoomIn();
          ref.current?.zoomOut();
          ref.current?.zoomToFit();
        });
      }).not.toThrow();
    });

    it("triggers zoom actions and updates scale text when toolbar zoom buttons are clicked", () => {
      const mockZoomIn = vi.fn();
      const mockZoomOut = vi.fn();
      const mockZoomToFit = vi.fn();

      const mockGanttInstance = {
        zoomIn: mockZoomIn,
        zoomOut: mockZoomOut,
        zoomToFit: mockZoomToFit,
        destroy: vi.fn(),
        isDestroyed: false,
      };

      const factory = vi.fn().mockReturnValue(mockGanttInstance);

      render(<ProcurementGantt records={[mockRecord1]} ganttInstanceFactory={factory} />);

      expect(screen.getByText(/Scale: 100%/i)).toBeInTheDocument();

      const zoomInBtn = screen.getByTestId("zoom-in-btn");
      const zoomOutBtn = screen.getByTestId("zoom-out-btn");
      const zoomFitBtn = screen.getByTestId("zoom-fit-btn");

      fireEvent.click(zoomInBtn);
      expect(mockZoomIn).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Scale: 120%/i)).toBeInTheDocument();

      fireEvent.click(zoomOutBtn);
      expect(mockZoomOut).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Scale: 100%/i)).toBeInTheDocument();

      fireEvent.click(zoomFitBtn);
      expect(mockZoomToFit).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Scale: 100%/i)).toBeInTheDocument();
    });
  });

  describe("SLA Warnings & Delays Visualization", () => {
    it("displays prominent SLA breach warning badge when a shipment exceeds cutoff", () => {
      const onSlaWarning = vi.fn();
      render(<ProcurementGantt records={[mockRecordDelayed]} onSlaWarning={onSlaWarning} />);

      const warningBadges = screen.getAllByTestId("sla-warning-indicator");
      expect(warningBadges.length).toBeGreaterThan(0);
      expect(screen.getByText(/SLA Alert/i)).toBeInTheDocument();
    });
  });

  describe("Theme and Design System", () => {
    it("applies light theme classes when theme='light'", () => {
      render(<ProcurementGantt records={[mockRecord1]} theme="light" />);
      const container = screen.getByTestId("procurement-gantt");
      expect(container.className).toContain("bg-white");
    });

    it("applies dark theme classes when theme='dark'", () => {
      render(<ProcurementGantt records={[mockRecord1]} theme="dark" />);
      const container = screen.getByTestId("procurement-gantt");
      expect(container.className).toContain("dark:bg-[#09090b]");
    });

    it("applies b-theme-stockholm-dark dark to the gantt container element when theme='dark'", () => {
      render(<ProcurementGantt records={[mockRecord1]} theme="dark" />);
      const ganttHost = screen.getByTestId("gantt-container");
      expect(ganttHost.className).toContain("b-theme-stockholm-dark");
      expect(ganttHost.className).toContain("dark");
    });

    it("applies b-theme-stockholm-light to the gantt container element when theme='light'", () => {
      render(<ProcurementGantt records={[mockRecord1]} theme="light" />);
      const ganttHost = screen.getByTestId("gantt-container");
      expect(ganttHost.className).toContain("b-theme-stockholm-light");
      expect(ganttHost.className).not.toContain("b-theme-stockholm-dark");
    });

    it("updates gantt instance element theme classes dynamically when theme prop toggles", () => {
      const mockElement = document.createElement("div");
      const mockGanttInstance = {
        destroy: vi.fn(),
        isDestroyed: false,
        element: mockElement,
      };
      const factory = vi.fn().mockReturnValue(mockGanttInstance);

      const { rerender } = render(
        <ProcurementGantt records={[mockRecord1]} theme="dark" ganttInstanceFactory={factory} />,
      );

      expect(mockElement.classList.contains("b-theme-stockholm-dark")).toBe(true);

      rerender(
        <ProcurementGantt records={[mockRecord1]} theme="light" ganttInstanceFactory={factory} />,
      );

      expect(mockElement.classList.contains("b-theme-stockholm-light")).toBe(true);
      expect(mockElement.classList.contains("b-theme-stockholm-dark")).toBe(false);
    });
  });

  describe("Live Streaming Stabilization & Jitter Prevention", () => {
    it("configures transitionDuration: 0, disables event animations, stabilizes time axis, and syncs inline data to eliminate flickering", () => {
      let capturedConfig:
        | {
            transitionDuration?: number;
            enableEventAnimations?: boolean;
            useInitialAnimation?: boolean;
            autoAdjustTimeAxis?: boolean;
            cls?: string;
            project?: {
              syncDataOnLoad?: boolean;
              silenceInitialCommit?: boolean;
            };
            features?: {
              projectLines?: { disabled: boolean };
              criticalPaths?: { disabled: boolean };
              nonWorkingTime?: { disabled: boolean };
            };
          }
        | undefined;

      const factory = vi.fn().mockImplementation((config) => {
        capturedConfig = config;
        return {
          destroy: vi.fn(),
          isDestroyed: false,
        };
      });

      render(
        <ProcurementGantt records={[mockRecord1]} theme="dark" ganttInstanceFactory={factory} />,
      );

      expect(capturedConfig).toBeDefined();
      expect(capturedConfig?.transitionDuration).toBe(0);
      expect(capturedConfig?.enableEventAnimations).toBe(false);
      expect(capturedConfig?.useInitialAnimation).toBe(false);
      expect(capturedConfig?.autoAdjustTimeAxis).toBe(false);
      expect(capturedConfig?.features?.projectLines?.disabled).toBe(true);
      expect(capturedConfig?.features?.nonWorkingTime?.disabled).toBe(true);
      expect(capturedConfig?.project?.syncDataOnLoad).toBe(true);
      expect(capturedConfig?.project?.silenceInitialCommit).toBe(true);
      expect(capturedConfig?.cls).toContain("b-theme-stockholm-dark dark");
    });

    it("keeps effective referenceDate stable across rapid re-renders to prevent elapsed duration bar drift", () => {
      let firstCapturedTasks:
        | Array<{ duration: number; startDate: string; endDate: string }>
        | undefined;
      let secondCapturedTasks:
        | Array<{ duration: number; startDate: string; endDate: string }>
        | undefined;

      const mockLoadInlineData = vi.fn();
      const factory = vi.fn().mockImplementation((config) => {
        firstCapturedTasks = config.project.tasksData[0]?.children;
        return {
          destroy: vi.fn(),
          isDestroyed: false,
          project: {
            loadInlineData: mockLoadInlineData,
          },
        };
      });

      const { rerender } = render(
        <ProcurementGantt records={[mockRecord1]} ganttInstanceFactory={factory} />,
      );

      // Re-render with updated record (simulating streaming tick)
      const updatedRecord: ClearinghouseRecord = {
        ...mockRecord1,
        riskScore: 25,
        sequenceNumber: 102,
        updatedAt: new Date(Date.now() + 3000).toISOString(),
      };

      rerender(<ProcurementGantt records={[updatedRecord]} ganttInstanceFactory={factory} />);

      expect(mockLoadInlineData).toHaveBeenCalled();
      const lastCall = mockLoadInlineData.mock.calls[mockLoadInlineData.mock.calls.length - 1][0];
      secondCapturedTasks = lastCall.tasksData[0]?.children;

      expect(firstCapturedTasks).toBeDefined();
      expect(secondCapturedTasks).toBeDefined();

      // Verify task durations and start dates have not jittered
      for (let i = 0; i < (firstCapturedTasks?.length ?? 0); i++) {
        expect(secondCapturedTasks?.[i]?.duration).toBe(firstCapturedTasks?.[i]?.duration);
        expect(secondCapturedTasks?.[i]?.startDate).toBe(firstCapturedTasks?.[i]?.startDate);
        expect(secondCapturedTasks?.[i]?.endDate).toBe(firstCapturedTasks?.[i]?.endDate);
      }
    });
  });

  describe("Lifecycle Disposal & Memory Safety", () => {
    it("safely disposes resources on unmount without memory leaks or uncaught errors", () => {
      const { unmount } = render(<ProcurementGantt records={[mockRecord1]} />);
      expect(() => unmount()).not.toThrow();
    });

    it("wires imperative handle directly to the active Bryntum Gantt instance", () => {
      const mockDestroy = vi.fn();
      const mockZoomIn = vi.fn();
      const mockZoomOut = vi.fn();
      const mockZoomToFit = vi.fn();
      const mockFeatures = {
        criticalPaths: { disabled: true },
        baselines: { disabled: false },
        dependencies: { disabled: false },
      };
      const mockProject = {
        tasksData: [],
        dependenciesData: [],
      };

      const mockGanttInstance = {
        destroy: mockDestroy,
        isDestroyed: false,
        zoomIn: mockZoomIn,
        zoomOut: mockZoomOut,
        zoomToFit: mockZoomToFit,
        features: mockFeatures,
        project: mockProject,
      };

      const factory = vi.fn().mockReturnValue(mockGanttInstance);

      const ref = createRef<ProcurementGanttHandle>();
      const { unmount, rerender } = render(
        <ProcurementGantt ref={ref} records={[mockRecord1]} ganttInstanceFactory={factory} />,
      );

      expect(factory).toHaveBeenCalled();
      expect(ref.current?.getGanttInstance()).toBe(mockGanttInstance);

      act(() => {
        ref.current?.zoomIn();
        ref.current?.zoomOut();
        ref.current?.zoomToFit();
        ref.current?.toggleCriticalPath();
        ref.current?.refreshData();
      });

      expect(mockZoomIn).toHaveBeenCalledTimes(1);
      expect(mockZoomOut).toHaveBeenCalledTimes(1);
      expect(mockZoomToFit).toHaveBeenCalledTimes(1);

      // Verify that re-rendering with new records DOES NOT call destroy
      rerender(
        <ProcurementGantt
          ref={ref}
          records={[mockRecord1, mockRecordDelayed]}
          ganttInstanceFactory={factory}
        />,
      );
      expect(mockDestroy).not.toHaveBeenCalled();

      // Verify destroy is ONLY called on unmount
      unmount();
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });

    it("invokes project.loadInlineData when available on data updates and refreshData, catching rejections", () => {
      const mockLoadInlineData = vi.fn().mockResolvedValue(undefined);
      const mockProject = {
        loadInlineData: mockLoadInlineData,
        tasksData: [],
        dependenciesData: [],
      };
      const mockGanttInstance = {
        destroy: vi.fn(),
        isDestroyed: false,
        project: mockProject,
        features: {
          criticalPaths: { disabled: false },
        },
      };
      const factory = vi.fn().mockReturnValue(mockGanttInstance);
      const ref = createRef<ProcurementGanttHandle>();

      const { rerender } = render(
        <ProcurementGantt ref={ref} records={[mockRecord1]} ganttInstanceFactory={factory} />,
      );

      // Re-render triggers Effect 2 which calls loadInlineData
      rerender(
        <ProcurementGantt
          ref={ref}
          records={[mockRecord1, mockRecordDelayed]}
          ganttInstanceFactory={factory}
        />,
      );

      expect(mockLoadInlineData).toHaveBeenCalled();
      const lastCallArgs =
        mockLoadInlineData.mock.calls[mockLoadInlineData.mock.calls.length - 1][0];
      expect(lastCallArgs.tasksData).toBeDefined();
      expect(lastCallArgs.dependenciesData).toBeDefined();

      // Imperative refreshData also calls loadInlineData
      mockLoadInlineData.mockClear();
      act(() => {
        ref.current?.refreshData();
      });
      expect(mockLoadInlineData).toHaveBeenCalledTimes(1);

      // Rejection from loadInlineData is caught and does not throw
      mockLoadInlineData.mockRejectedValueOnce(new Error("Bryntum calculation cycle"));
      expect(() => {
        act(() => {
          ref.current?.refreshData();
        });
      }).not.toThrow();
    });

    it("renders Show More Orders pagination button when records exceed maxVisibleRecords", () => {
      const recordsBatch: ClearinghouseRecord[] = Array.from({ length: 30 }, (_, i) => ({
        ...mockRecord1,
        transactionId: `tx-batch-${i + 1}`,
      }));

      render(<ProcurementGantt records={recordsBatch} maxVisibleRecords={10} />);

      const showMoreBtn = screen.getByTestId("show-more-orders-btn");
      expect(showMoreBtn).toBeInTheDocument();
      expect(showMoreBtn.textContent).toContain("Show More Orders (10 of 30)");

      fireEvent.click(showMoreBtn);
      // Visible count increases by 25
      expect(screen.queryByTestId("show-more-orders-btn")).not.toBeInTheDocument();
    });
  });
});
