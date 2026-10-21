import { MemoryTransport } from "../transports/memoryTransport.js";
import { RedisTransport, type RedisTransportOptions } from "../transports/redisTransport.js";
import type { EventBusTransport } from "../transports/transport.js";
import type { DomainEvent, DomainEventType } from "../types/events.js";

export interface EventBusOptions extends RedisTransportOptions {
  channelPrefix?: string;
  defaultChannel?: string;
  transport?: EventBusTransport;
}

export interface EventBusStatus {
  transportType: "redis" | "memory";
  isConnected: boolean;
  fallbackActive: boolean;
  currentSequenceNumber: number;
  activeSubscriptions: number;
}

export class EventBus {
  private transport: EventBusTransport;
  private channelPrefix: string;
  private defaultChannel: string;
  private sequenceCounter = 0;
  private typeSubscriptions = new Map<string, Set<(event: DomainEvent) => void | Promise<void>>>();
  private defaultChannelSubscribed = false;
  private defaultChannelUnsubscribe: (() => Promise<void>) | undefined = undefined;

  constructor(options: EventBusOptions = {}) {
    this.channelPrefix = options.channelPrefix ?? "tessera";
    this.defaultChannel = options.defaultChannel ?? "clearinghouse.events";

    if (options.transport) {
      this.transport = options.transport;
    } else if (options.redisUrl || process.env.REDIS_URL) {
      this.transport = new RedisTransport(options);
    } else if (options.fallbackToMemory ?? true) {
      this.transport = new MemoryTransport();
    } else {
      this.transport = new RedisTransport(options);
    }
  }

  get isConnected(): boolean {
    return this.transport.isConnected;
  }

  async connect(): Promise<void> {
    if (!this.transport.isConnected) {
      await this.transport.connect();
    }
    await this.ensureDefaultChannelSubscription();
  }

  private getFullChannelName(channel?: string): string {
    const chan = channel || this.defaultChannel;
    return `${this.channelPrefix}.${chan}`;
  }

  private async ensureDefaultChannelSubscription(): Promise<void> {
    if (this.defaultChannelSubscribed) return;
    this.defaultChannelSubscribed = true;

    const fullChannel = this.getFullChannelName(this.defaultChannel);
    this.defaultChannelUnsubscribe = await this.transport.subscribe(fullChannel, (rawMessage) => {
      try {
        const parsed = JSON.parse(rawMessage) as DomainEvent;
        this.dispatchDomainEvent(parsed);
      } catch (err) {
        console.error("[EventBus] Failed to parse incoming domain event JSON:", err);
      }
    });
  }

  private dispatchDomainEvent(event: DomainEvent): void {
    // Specific type subscribers
    const specificHandlers = this.typeSubscriptions.get(event.type);
    if (specificHandlers) {
      for (const handler of specificHandlers) {
        try {
          void handler(event);
        } catch (err) {
          console.error(`[EventBus] Error in subscriber for event ${event.type}:`, err);
        }
      }
    }

    // Wildcard subscribers
    const wildcardHandlers = this.typeSubscriptions.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          void handler(event);
        } catch (err) {
          console.error(`[EventBus] Error in wildcard subscriber for event ${event.type}:`, err);
        }
      }
    }
  }

  async publish<T extends DomainEvent>(event: T, channel?: string): Promise<void> {
    this.sequenceCounter += 1;
    const enrichedEvent: T = {
      ...event,
      sequenceNumber: event.sequenceNumber ?? this.sequenceCounter,
    };

    const fullChannel = this.getFullChannelName(channel);
    const serialized = JSON.stringify(enrichedEvent);
    await this.transport.publish(fullChannel, serialized);
  }

  subscribe<K extends DomainEventType>(
    eventType: K,
    handler: (event: Extract<DomainEvent, { type: K }>) => void | Promise<void>,
  ): () => void;
  subscribe(eventType: "*", handler: (event: DomainEvent) => void | Promise<void>): () => void;
  subscribe(eventType: string, handler: (event: DomainEvent) => void | Promise<void>): () => void {
    // Ensure default channel is subscribed if connected
    if (this.transport.isConnected && !this.defaultChannelSubscribed) {
      void this.ensureDefaultChannelSubscription();
    }

    let handlers = this.typeSubscriptions.get(eventType);
    if (!handlers) {
      handlers = new Set();
      this.typeSubscriptions.set(eventType, handlers);
    }
    handlers.add(handler as (event: DomainEvent) => void | Promise<void>);

    return () => {
      const set = this.typeSubscriptions.get(eventType);
      if (set) {
        set.delete(handler);
        if (set.size === 0) {
          this.typeSubscriptions.delete(eventType);
        }
      }
    };
  }

  async subscribeChannel(
    channel: string,
    handler: (event: DomainEvent) => void | Promise<void>,
  ): Promise<() => void> {
    const fullChannel = this.getFullChannelName(channel);
    const unsub = await this.transport.subscribe(fullChannel, (raw) => {
      try {
        const parsed = JSON.parse(raw) as DomainEvent;
        void handler(parsed);
      } catch (err) {
        console.error(`[EventBus] Failed to parse message on channel ${channel}:`, err);
      }
    });

    return () => {
      void unsub();
    };
  }

  getStatus(): EventBusStatus {
    const isRedis = this.transport instanceof RedisTransport;
    const fallbackActive = isRedis ? (this.transport as RedisTransport).isFallbackActive : false;
    let subCount = 0;
    for (const set of this.typeSubscriptions.values()) {
      subCount += set.size;
    }

    return {
      transportType: this.transport.type,
      isConnected: this.transport.isConnected,
      fallbackActive,
      currentSequenceNumber: this.sequenceCounter,
      activeSubscriptions: subCount,
    };
  }

  async close(): Promise<void> {
    if (this.defaultChannelUnsubscribe) {
      await this.defaultChannelUnsubscribe();
      this.defaultChannelUnsubscribe = undefined;
    }
    this.defaultChannelSubscribed = false;
    this.typeSubscriptions.clear();
    await this.transport.close();
  }
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  return new EventBus(options);
}
