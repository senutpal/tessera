export type MessageHandler = (message: string) => void | Promise<void>;

export interface EventBusTransport {
  readonly type: "redis" | "memory";
  readonly isConnected: boolean;
  connect(): Promise<void>;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: MessageHandler): Promise<() => Promise<void>>;
  close(): Promise<void>;
}
