import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClearinghouseRecord,
  ConnectionStatus,
  GridTransaction,
  UseClearinghouseSocketOptions,
  UseClearinghouseSocketReturn,
} from "../types.js";

const DEFAULT_WS_URL = "ws://localhost:3000/ws/clearinghouse";
const DEFAULT_RECONNECT_INTERVAL_MS = 1000;
const DEFAULT_MAX_RECONNECT_INTERVAL_MS = 10000;
const DEFAULT_MAX_BUFFER_SIZE = 1000;

export function useClearinghouseSocket(
  options: UseClearinghouseSocketOptions = {},
): UseClearinghouseSocketReturn {
  const {
    url = DEFAULT_WS_URL,
    autoConnect = true,
    reconnectIntervalMs = DEFAULT_RECONNECT_INTERVAL_MS,
    maxReconnectIntervalMs = DEFAULT_MAX_RECONNECT_INTERVAL_MS,
    maxBufferSize = DEFAULT_MAX_BUFFER_SIZE,
    channel = "ledger",
    token,
    onSnapshot,
    onTransaction,
  } = options;

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [lastSequenceNumber, setLastSequenceNumber] = useState<number>(0);
  const [snapshot, setSnapshot] = useState<ClearinghouseRecord[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explicitDisconnectRef = useRef<boolean>(false);
  const bufferedTransactionsRef = useRef<GridTransaction[]>([]);

  // Stable references for callbacks to avoid tearing in high-frequency event loops
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;

  const onTransactionRef = useRef(onTransaction);
  onTransactionRef.current = onTransaction;

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearBuffer = useCallback(() => {
    bufferedTransactionsRef.current = [];
  }, []);

  const getBufferedTransactions = useCallback(() => {
    return [...bufferedTransactionsRef.current];
  }, []);

  const flushBuffer = useCallback((handler: (transaction: GridTransaction) => void) => {
    const items = bufferedTransactionsRef.current.splice(0, bufferedTransactionsRef.current.length);
    for (const item of items) {
      handler(item);
    }
  }, []);

  const sendMessage = useCallback((msg: unknown): boolean => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        const payload = typeof msg === "string" ? msg : JSON.stringify(msg);
        wsRef.current.send(payload);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }, []);

  const connect = useCallback(
    (isReconnect = false) => {
      explicitDisconnectRef.current = false;
      clearReconnectTimer();

      if (!isReconnect) {
        reconnectAttemptsRef.current = 0;
      }

      // Close any existing active connection cleanly
      if (wsRef.current) {
        try {
          wsRef.current.close(1000, "Reconnecting");
        } catch {}
        wsRef.current = null;
      }

      setConnectionStatus("connecting");

      // Append auth token if provided
      let connectUrl = url;
      if (token) {
        try {
          const urlObj = new URL(
            url,
            typeof window !== "undefined" ? window.location.href : "http://localhost",
          );
          urlObj.searchParams.set("token", token);
          connectUrl = urlObj.toString();
        } catch {
          connectUrl = url.includes("?")
            ? `${url}&token=${encodeURIComponent(token)}`
            : `${url}?token=${encodeURIComponent(token)}`;
        }
      }

      try {
        const socket = new WebSocket(connectUrl);
        wsRef.current = socket;

        socket.onopen = () => {
          if (wsRef.current !== socket) return;
          reconnectAttemptsRef.current = 0;
          setConnectionStatus("connected");

          // Subscribe to channel if required
          if (channel && channel !== "ledger") {
            sendMessage({ type: "subscribe", channel, ack: true });
          }
        };

        socket.onmessage = (event: MessageEvent) => {
          if (wsRef.current !== socket) return;

          try {
            const rawData = typeof event.data === "string" ? event.data : String(event.data);
            const parsed = JSON.parse(rawData);

            if (!parsed || typeof parsed !== "object") return;

            if (parsed.type === "snapshot" && Array.isArray(parsed.data)) {
              const records: ClearinghouseRecord[] = parsed.data;
              if (typeof parsed.sequenceNumber === "number") {
                setLastSequenceNumber((prev) => Math.max(prev, parsed.sequenceNumber));
              }
              // Clear stale deltas buffered before snapshot hydration
              bufferedTransactionsRef.current = [];
              setSnapshot(records);
              onSnapshotRef.current?.(records);
              return;
            }

            if (parsed.type === "delta") {
              if (typeof parsed.sequenceNumber === "number") {
                setLastSequenceNumber((prev) => Math.max(prev, parsed.sequenceNumber));
              }

              let transaction: GridTransaction;
              if (
                parsed.transaction &&
                Array.isArray(parsed.transaction.add) &&
                Array.isArray(parsed.transaction.update) &&
                Array.isArray(parsed.transaction.remove)
              ) {
                transaction = parsed.transaction as GridTransaction;
              } else if (Array.isArray(parsed.deltas)) {
                // Synthesize transaction from raw deltas
                const add: ClearinghouseRecord[] = [];
                const update: ClearinghouseRecord[] = [];
                const remove: ClearinghouseRecord[] = [];

                for (const delta of parsed.deltas) {
                  if (delta?.data && typeof delta.data === "object") {
                    if (delta.type === "add") add.push(delta.data);
                    else if (delta.type === "update") update.push(delta.data);
                    else if (delta.type === "remove") remove.push(delta.data);
                  }
                }

                transaction = { add, update, remove };
              } else {
                return;
              }

              // High-performance streaming: decoupled from React state renders
              // Buffer the transaction for AG Grid consumption (bounded size to prevent memory leaks)
              if (bufferedTransactionsRef.current.length >= maxBufferSize) {
                bufferedTransactionsRef.current.shift();
              }
              bufferedTransactionsRef.current.push(transaction);

              // Immediately invoke callback (e.g. gridApi.applyTransactionAsync)
              onTransactionRef.current?.(transaction);
            }
          } catch {
            // Ignore invalid frames
          }
        };

        socket.onclose = () => {
          if (wsRef.current !== socket) return;
          wsRef.current = null;

          if (explicitDisconnectRef.current) {
            setConnectionStatus("disconnected");
            return;
          }

          // Automatic RFC 6455 reconnection with exponential backoff & jitter
          setConnectionStatus("reconnecting");
          const attempt = reconnectAttemptsRef.current;
          reconnectAttemptsRef.current = attempt + 1;

          const baseDelay = Math.min(maxReconnectIntervalMs, reconnectIntervalMs * 2 ** attempt);
          const jitter = Math.random() * 200;
          const delay = baseDelay + jitter;

          reconnectTimerRef.current = setTimeout(() => {
            connect(true);
          }, delay);
        };

        socket.onerror = () => {
          // Socket errors typically bubble into onclose
          if (wsRef.current === socket) {
            try {
              socket.close();
            } catch {}
          }
        };
      } catch {
        setConnectionStatus("disconnected");
      }
    },
    [
      url,
      token,
      channel,
      reconnectIntervalMs,
      maxReconnectIntervalMs,
      maxBufferSize,
      sendMessage,
      clearReconnectTimer,
    ],
  );

  const disconnect = useCallback(() => {
    explicitDisconnectRef.current = true;
    clearReconnectTimer();

    if (wsRef.current) {
      try {
        wsRef.current.close(1000, "Explicit disconnect");
      } catch {}
      wsRef.current = null;
    }
    setConnectionStatus("disconnected");
  }, [clearReconnectTimer]);

  useEffect(() => {
    if (autoConnect) {
      connect();
    }
    return () => {
      explicitDisconnectRef.current = true;
      clearReconnectTimer();
      if (wsRef.current) {
        try {
          wsRef.current.close(1000, "Unmount");
        } catch {}
        wsRef.current = null;
      }
    };
  }, [autoConnect, connect, clearReconnectTimer]);

  return {
    connectionStatus,
    isConnected: connectionStatus === "connected",
    lastSequenceNumber,
    snapshot,
    connect,
    disconnect,
    sendMessage,
    flushBuffer,
    getBufferedTransactions,
    clearBuffer,
  };
}
