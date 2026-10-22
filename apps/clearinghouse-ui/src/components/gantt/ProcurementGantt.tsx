import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  Maximize2,
  ShieldAlert,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ProcurementGanttProjectData,
  ProcurementGanttTask,
  SlaDelayWarning,
} from "../../types/gantt.js";
import type { ClearinghouseRecord } from "../../types.js";
import { mapRecordsToGanttProject } from "./ganttDataMapper.js";
import { evaluateRecordSla } from "./slaMonitor.js";

export interface BryntumGanttInstance {
  destroy: () => void;
  isDestroyed?: boolean;
  features?: {
    criticalPaths?: { disabled: boolean };
    baselines?: { disabled: boolean };
    dependencies?: { disabled: boolean };
  };
  project?: {
    tasksData: unknown;
    dependenciesData: unknown;
  };
  zoomIn?: () => void;
  zoomOut?: () => void;
  zoomToFit?: () => void;
}

type GanttConstructor = new (config?: Record<string, unknown>) => BryntumGanttInstance;

// Optional Bryntum Gantt runtime module hydration in browser environments
let BryntumGanttClass: GanttConstructor | null = null;
if (typeof window !== "undefined" && typeof document !== "undefined") {
  // Ensure polyfill for matchMedia exists before importing Bryntum
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  try {
    import("@bryntum/gantt")
      .then((mod) => {
        BryntumGanttClass = mod.Gantt as unknown as GanttConstructor;
      })
      .catch(() => {
        // Graceful fallback for non-browser/eval environments
      });
  } catch {
    // ignore
  }
}

export interface ProcurementGanttProps {
  records?: ClearinghouseRecord[];
  selectedTransactionId?: string;
  showCriticalPath?: boolean;
  onToggleCriticalPath?: (active: boolean) => void;
  theme?: "dark" | "light";
  onTaskClick?: (task: ProcurementGanttTask) => void;
  className?: string;
  onSlaWarning?: (warning: SlaDelayWarning) => void;
  referenceDate?: Date | string | undefined;
  maxVisibleRecords?: number | undefined;
  ganttInstanceFactory?: ((config?: Record<string, unknown>) => BryntumGanttInstance) | undefined;
}

export interface ProcurementGanttHandle {
  getGanttInstance: () => BryntumGanttInstance | null;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomToFit: () => void;
  toggleCriticalPath: () => boolean;
  refreshData: () => void;
}

export const ProcurementGantt = forwardRef<ProcurementGanttHandle, ProcurementGanttProps>(
  (
    {
      records = [],
      selectedTransactionId,
      showCriticalPath: controlledShowCriticalPath,
      onToggleCriticalPath,
      theme = "dark",
      onTaskClick,
      className = "",
      onSlaWarning,
      referenceDate,
      maxVisibleRecords = 25,
      ganttInstanceFactory,
    },
    ref,
  ) => {
    const ganttContainerRef = useRef<HTMLDivElement | null>(null);
    const ganttInstanceRef = useRef<BryntumGanttInstance | null>(null);
    const [internalCriticalPath, setInternalCriticalPath] = useState<boolean>(false);
    const [zoomLevel, setZoomLevel] = useState<number>(100);
    const [visibleCount, setVisibleCount] = useState<number>(maxVisibleRecords);

    const isCriticalPathActive =
      controlledShowCriticalPath !== undefined ? controlledShowCriticalPath : internalCriticalPath;

    const effectiveRefDate = useMemo(() => {
      return referenceDate ? new Date(referenceDate) : new Date();
    }, [referenceDate, records]);

    // Filter records if a specific transaction is isolated
    const filteredRecords = useMemo(() => {
      if (!selectedTransactionId) return records;
      return records.filter((r) => r.transactionId === selectedTransactionId);
    }, [records, selectedTransactionId]);

    // Map records to Gantt Project data model
    const projectData: ProcurementGanttProjectData = useMemo(() => {
      return mapRecordsToGanttProject(filteredRecords, {
        calculateCriticalPath: isCriticalPathActive,
        includeSummaryRoot: true,
        referenceDate: effectiveRefDate,
      });
    }, [filteredRecords, isCriticalPathActive, effectiveRefDate]);

    // Evaluate SLA warnings across loaded records
    const slaWarnings: SlaDelayWarning[] = useMemo(() => {
      const warnings: SlaDelayWarning[] = [];
      for (const rec of filteredRecords) {
        const result = evaluateRecordSla(rec, effectiveRefDate);
        warnings.push(...result.warnings);
      }
      return warnings;
    }, [filteredRecords, effectiveRefDate]);

    // Notify parent on SLA warning changes without infinite loops
    const reportedWarningsRef = useRef<Set<string>>(new Set());
    useEffect(() => {
      if (onSlaWarning && slaWarnings.length > 0) {
        for (const warn of slaWarnings) {
          if (!reportedWarningsRef.current.has(warn.id)) {
            reportedWarningsRef.current.add(warn.id);
            onSlaWarning(warn);
          }
        }
      }
    }, [slaWarnings, onSlaWarning]);

    // Critical Path Toggle Handler
    const handleToggleCriticalPath = useCallback(() => {
      const next = !isCriticalPathActive;
      if (onToggleCriticalPath) {
        onToggleCriticalPath(next);
      } else {
        setInternalCriticalPath(next);
      }

      if (ganttInstanceRef.current?.features?.criticalPaths) {
        ganttInstanceRef.current.features.criticalPaths.disabled = !next;
      }
    }, [isCriticalPathActive, onToggleCriticalPath]);

    // Zoom Handlers
    const handleZoomIn = useCallback(() => {
      setZoomLevel((prev) => Math.min(prev + 20, 200));
      if (ganttInstanceRef.current && typeof ganttInstanceRef.current.zoomIn === "function") {
        try {
          ganttInstanceRef.current.zoomIn();
        } catch {
          // ignore
        }
      }
    }, []);

    const handleZoomOut = useCallback(() => {
      setZoomLevel((prev) => Math.max(prev - 20, 40));
      if (ganttInstanceRef.current && typeof ganttInstanceRef.current.zoomOut === "function") {
        try {
          ganttInstanceRef.current.zoomOut();
        } catch {
          // ignore
        }
      }
    }, []);

    const handleZoomFit = useCallback(() => {
      setZoomLevel(100);
      if (ganttInstanceRef.current && typeof ganttInstanceRef.current.zoomToFit === "function") {
        try {
          ganttInstanceRef.current.zoomToFit();
        } catch {
          // ignore
        }
      }
    }, []);

    // Expose Imperative Handle
    useImperativeHandle(
      ref,
      () => ({
        getGanttInstance: () => ganttInstanceRef.current,
        zoomIn: handleZoomIn,
        zoomOut: handleZoomOut,
        zoomToFit: handleZoomFit,
        toggleCriticalPath: () => {
          handleToggleCriticalPath();
          return !isCriticalPathActive;
        },
        refreshData: () => {
          const project = ganttInstanceRef.current?.project as
            | {
                loadInlineData?: (data: Record<string, unknown>) => Promise<unknown>;
                tasksData?: unknown;
                dependenciesData?: unknown;
              }
            | undefined;
          if (project) {
            try {
              if (typeof project.loadInlineData === "function") {
                void project.loadInlineData({
                  tasksData: projectData.tasksData,
                  dependenciesData: projectData.dependenciesData,
                });
              } else {
                project.tasksData = projectData.tasksData;
                project.dependenciesData = projectData.dependenciesData;
              }
            } catch {
              // ignore
            }
          }
        },
      }),
      [
        handleZoomIn,
        handleZoomOut,
        handleZoomFit,
        handleToggleCriticalPath,
        isCriticalPathActive,
        projectData,
      ],
    );

    // Effect 1: Bryntum Gantt Lifecycle Management (Mount and clean unmount disposal)
    // biome-ignore lint/correctness/useExhaustiveDependencies: Gantt instance is instantiated once on mount; subsequent data updates handled in dedicated effect
    useEffect(() => {
      let isMounted = true;

      async function initGantt() {
        if (!ganttContainerRef.current) return;
        if (typeof window === "undefined" || typeof document === "undefined") return;

        try {
          if (!ganttInstanceFactory && !BryntumGanttClass) {
            const mod = await import("@bryntum/gantt");
            BryntumGanttClass = mod.Gantt as unknown as GanttConstructor;
          }

          if (
            !isMounted ||
            (!ganttInstanceFactory && !BryntumGanttClass) ||
            !ganttContainerRef.current ||
            ganttInstanceRef.current
          ) {
            return;
          }

          const ganttConfig = {
            appendTo: ganttContainerRef.current,
            autoHeight: true,
            features: {
              criticalPaths: { disabled: !isCriticalPathActive },
              baselines: { disabled: false },
              dependencies: { disabled: false },
              taskTooltip: {
                template: ({
                  taskRecord,
                }: {
                  taskRecord: {
                    name?: string;
                    status?: string;
                    duration?: number;
                  };
                }) => {
                  const esc = (v: unknown) =>
                    String(v ?? "").replace(/[&<>"']/g, (c) =>
                      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
                    );
                  return `<div class="p-2 font-mono text-xs">
                    <div class="font-bold">${esc(taskRecord.name)}</div>
                    <div>Status: ${esc(taskRecord.status)}</div>
                    <div>Duration: ${taskRecord.duration || 0}h</div>
                  </div>`;
                },
              },
            },
            project: {
              tasksData: projectData.tasksData,
              dependenciesData: projectData.dependenciesData,
            },
          };

          const gantt = ganttInstanceFactory
            ? ganttInstanceFactory(ganttConfig)
            : new (BryntumGanttClass as GanttConstructor)(ganttConfig);

          ganttInstanceRef.current = gantt;
        } catch {
          // In test/jsdom environments where layout/canvas isn't supported,
          // the declarative React timeline view handles visual presentation
        }
      }

      initGantt();

      return () => {
        isMounted = false;
        if (ganttInstanceRef.current) {
          try {
            if (!ganttInstanceRef.current.isDestroyed) {
              ganttInstanceRef.current.destroy();
            }
          } catch {
            // ignore disposal error
          }
          ganttInstanceRef.current = null;
        }
      };
    }, [ganttInstanceFactory]);

    // Effect 2: Update existing Gantt instance data & features smoothly without re-instantiation
    useEffect(() => {
      if (!ganttInstanceRef.current) return;
      try {
        const project = ganttInstanceRef.current.project as
          | {
              loadInlineData?: (data: Record<string, unknown>) => Promise<unknown>;
              tasksData?: unknown;
              dependenciesData?: unknown;
            }
          | undefined;
        if (project) {
          if (typeof project.loadInlineData === "function") {
            void project.loadInlineData({
              tasksData: projectData.tasksData,
              dependenciesData: projectData.dependenciesData,
            });
          } else {
            project.tasksData = projectData.tasksData;
            project.dependenciesData = projectData.dependenciesData;
          }
        }
        if (ganttInstanceRef.current.features?.criticalPaths) {
          ganttInstanceRef.current.features.criticalPaths.disabled = !isCriticalPathActive;
        }
      } catch {
        // ignore update errors
      }
    }, [projectData, isCriticalPathActive]);

    const isLight = theme === "light";
    const criticalTaskCount = projectData.criticalPathTaskIds.length;

    return (
      <div
        data-testid="procurement-gantt"
        className={`flex flex-col rounded-xl border transition-colors duration-150 overflow-hidden ${
          isLight
            ? "bg-white border-zinc-200 text-zinc-900 shadow-sm"
            : "bg-white dark:bg-[#09090b] border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-sm"
        } ${className}`}
      >
        {/* Minimalist Editorial Toolbar Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-zinc-400 dark:text-zinc-500" />
            <h3 className="text-xs font-semibold uppercase tracking-wider font-mono text-zinc-900 dark:text-zinc-100">
              Procurement Milestone SLA Scheduler
            </h3>
          </div>

          {/* Action Toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Active SLA Warning Pill */}
            {slaWarnings.length > 0 && (
              <div
                data-testid="sla-warning-indicator"
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono font-medium bg-rose-50 text-rose-700 border border-rose-200 dark:bg-rose-500/10 dark:text-rose-400 dark:border-rose-500/25"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-rose-500 animate-pulse" />
                <span>SLA Alert: {slaWarnings.length} Overdue</span>
              </div>
            )}

            {/* Critical Path Toggle Button */}
            <button
              type="button"
              data-testid="critical-path-toggle"
              data-active={isCriticalPathActive ? "true" : "false"}
              onClick={handleToggleCriticalPath}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition-all duration-150 border flex items-center gap-1.5 active:scale-[0.98] ${
                isCriticalPathActive
                  ? "bg-rose-50 text-rose-700 border-rose-300 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/35 shadow-sm"
                  : "bg-white hover:bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-800 shadow-sm"
              }`}
            >
              <ShieldAlert
                className={`w-3.5 h-3.5 ${
                  isCriticalPathActive
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-zinc-400 dark:text-zinc-500"
                }`}
              />
              <span>Critical Path</span>
              {criticalTaskCount > 0 && isCriticalPathActive && (
                <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] bg-rose-600 text-white font-bold">
                  {criticalTaskCount}
                </span>
              )}
            </button>

            {/* Zoom Controls */}
            <div className="flex items-center rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-sm overflow-hidden">
              <button
                type="button"
                data-testid="zoom-in-btn"
                title="Zoom In"
                onClick={handleZoomIn}
                className="p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border-r border-zinc-200 dark:border-zinc-800 transition-colors"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                data-testid="zoom-out-btn"
                title="Zoom Out"
                onClick={handleZoomOut}
                className="p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border-r border-zinc-200 dark:border-zinc-800 transition-colors"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                data-testid="zoom-fit-btn"
                title="Zoom to Fit"
                onClick={handleZoomFit}
                className="p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 transition-colors"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Bryntum Gantt DOM Container */}
        <div
          ref={ganttContainerRef}
          className="b-gantt-host min-h-[380px] flex-1 w-full overflow-hidden"
        />

        {/* Accessible Timeline Presentation Layer (Provides structured task bar visual inspection) */}
        <div className="p-4 border-t border-zinc-200 dark:border-zinc-800/80 bg-zinc-50/30 dark:bg-zinc-950/20 flex flex-col gap-3">
          <div className="flex items-center justify-between text-[11px] font-mono text-zinc-500 uppercase tracking-wider">
            <span>Milestone Stage Tree & Finish-to-Start Dependencies</span>
            <span>Scale: {zoomLevel}%</span>
          </div>

          <div className="flex flex-col gap-2">
            {projectData.tasksData.slice(0, visibleCount).map((rootTask) => {
              const children = rootTask.children || [];
              const orderSlaBreached = slaWarnings.some((w) => w.transactionId === rootTask.id);

              return (
                <div
                  key={rootTask.id}
                  className="rounded-lg border border-zinc-200/80 dark:border-zinc-800/80 p-3 bg-white dark:bg-zinc-900/40 flex flex-col gap-2.5 shadow-sm"
                >
                  {/* Order Summary Header */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-zinc-800 dark:text-zinc-200">
                        {rootTask.id}
                      </span>
                      <span className="text-xs text-zinc-500">({rootTask.merchantDomain})</span>
                      {rootTask.carrier && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                          {rootTask.carrier} • {rootTask.trackingId}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 text-xs font-mono">
                      {orderSlaBreached && (
                        <span
                          data-testid="sla-warning-indicator"
                          className="px-2 py-0.5 rounded bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/25 text-[10px] font-bold"
                        >
                          SLA Breach Detected
                        </span>
                      )}
                      <span className="tabular-nums text-zinc-500">
                        {rootTask.percentDone}% complete
                      </span>
                    </div>
                  </div>

                  {/* 7-Stage Milestone Track */}
                  <div className="grid grid-cols-1 md:grid-cols-7 gap-2 pt-1">
                    {children.map((stageTask, idx) => {
                      const isCritical = Boolean(stageTask.critical);
                      const isMilestone = Boolean(stageTask.milestone);
                      const isCompleted = stageTask.status === "COMPLETED";
                      const isInProgress = stageTask.status === "IN_PROGRESS";
                      const isBreached = stageTask.status === "BREACHED";

                      return (
                        <button
                          type="button"
                          key={stageTask.id}
                          onClick={() => onTaskClick?.(stageTask)}
                          className={`text-left relative p-2 rounded-md border text-xs font-mono transition-all duration-150 cursor-pointer ${
                            isCritical && isCriticalPathActive
                              ? "border-rose-400 dark:border-rose-500/60 bg-rose-50/40 dark:bg-rose-500/10"
                              : isCompleted
                                ? "border-emerald-200 dark:border-emerald-500/20 bg-emerald-50/30 dark:bg-emerald-500/5"
                                : isInProgress
                                  ? "border-amber-300 dark:border-amber-500/30 bg-amber-50/30 dark:bg-amber-500/5"
                                  : isBreached
                                    ? "border-rose-300 dark:border-rose-500/30 bg-rose-50/30 dark:bg-rose-500/5"
                                    : "border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/20 opacity-70"
                          }`}
                        >
                          {/* Milestone Diamond Marker */}
                          {isMilestone && (
                            <span
                              data-testid="milestone-marker"
                              title="Milestone Marker"
                              className="absolute -top-1.5 -right-1.5 w-3 h-3 rotate-45 rounded-[1px] bg-zinc-700 dark:bg-zinc-300 border border-white dark:border-zinc-900 shadow-sm"
                            />
                          )}

                          {/* Critical Path Indicator */}
                          {isCritical && isCriticalPathActive && (
                            <div
                              data-testid="critical-task-indicator"
                              className="flex items-center gap-1 text-[10px] text-rose-600 dark:text-rose-400 font-bold uppercase tracking-wider mb-1"
                            >
                              <ShieldAlert className="w-3 h-3" />
                              <span>Critical</span>
                            </div>
                          )}

                          <div className="flex items-center gap-1.5 font-semibold text-zinc-900 dark:text-zinc-100 text-[11px] truncate">
                            {isCompleted ? (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                            ) : isInProgress ? (
                              <Clock className="w-3.5 h-3.5 text-amber-500 shrink-0 animate-spin" />
                            ) : (
                              <span className="w-3.5 h-3.5 rounded-full border border-zinc-300 dark:border-zinc-600 shrink-0" />
                            )}
                            <span className="truncate">{stageTask.name}</span>
                          </div>

                          <div className="flex items-center justify-between text-[10px] text-zinc-500 pt-1 mt-1 border-t border-zinc-100 dark:border-zinc-800/60 tabular-nums">
                            <span>Stage {idx + 1}</span>
                            <span>{stageTask.duration}h</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {projectData.tasksData.length > visibleCount && (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  data-testid="show-more-orders-btn"
                  onClick={() => setVisibleCount((prev) => prev + 25)}
                  className="px-4 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs font-mono font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 transition-colors shadow-sm"
                >
                  Show More Orders ({visibleCount} of {projectData.tasksData.length})
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  },
);

ProcurementGantt.displayName = "ProcurementGantt";
