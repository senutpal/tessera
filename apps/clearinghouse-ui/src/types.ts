import type {
  ClearinghouseRecord,
  GridDeltaBatch,
  GridDeltaItem,
  GridDeltaType,
  GridTransaction,
} from "@tessera/event-bus";

export type { ClearinghouseRecord, GridDeltaBatch, GridDeltaItem, GridDeltaType, GridTransaction };

export type RiskLevel = "low" | "elevated" | "critical";

export function getRiskLevel(score: number): RiskLevel {
  if (score <= 30) return "low";
  if (score <= 70) return "elevated";
  return "critical";
}

export type HitlActionType = "counter-sign" | "void" | "dispute";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface HitlActionHandlerParams {
  record: ClearinghouseRecord;
  action: HitlActionType;
}

export type SupervisorActionHandler = (params: HitlActionHandlerParams) => Promise<void>;

export interface UseClearinghouseSocketOptions {
  url?: string;
  autoConnect?: boolean;
  reconnectIntervalMs?: number;
  maxReconnectIntervalMs?: number;
  channel?: string;
  token?: string;
  onSnapshot?: (records: ClearinghouseRecord[]) => void;
  onTransaction?: (transaction: GridTransaction) => void;
}

export interface UseClearinghouseSocketReturn {
  connectionStatus: ConnectionStatus;
  isConnected: boolean;
  lastSequenceNumber: number;
  snapshot: ClearinghouseRecord[];
  connect: () => void;
  disconnect: () => void;
  sendMessage: (msg: unknown) => boolean;
  flushBuffer: (handler: (transaction: GridTransaction) => void) => void;
  getBufferedTransactions: () => GridTransaction[];
  clearBuffer: () => void;
}
