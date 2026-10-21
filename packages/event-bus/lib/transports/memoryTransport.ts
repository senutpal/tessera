import { EventEmitter } from "node:events";
import type { EventBusTransport, MessageHandler } from "./transport.js";

export class MemoryTransport implements EventBusTransport {
  readonly type = "memory" as const;
  private emitter = new EventEmitter();
  private connected = false;

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async publish(channel: string, message: string): Promise<void> {
    if (!this.connected) {
      throw new Error("MemoryTransport is not connected");
    }
    this.emitter.emit(channel, message);
  }

  async subscribe(channel: string, handler: MessageHandler): Promise<() => Promise<void>> {
    const wrapped = async (message: string) => {
      try {
        await handler(message);
      } catch (err) {
        // Isolate handler errors so other handlers on this channel still execute
        console.error(`[MemoryTransport] Error in handler for channel '${channel}':`, err);
      }
    };

    this.emitter.on(channel, wrapped);

    return async () => {
      this.emitter.off(channel, wrapped);
    };
  }

  async close(): Promise<void> {
    this.connected = false;
    this.emitter.removeAllListeners();
  }
}
