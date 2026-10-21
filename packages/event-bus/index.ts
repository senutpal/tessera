// Public entry point for @tessera/event-bus
// Deep module exposing distributed event bus, transports, and transformers.

export {
  createEventBus,
  EventBus,
  type EventBusOptions,
  type EventBusStatus,
} from "./lib/bus/eventBus.js";

export {
  createGridDeltaTransformer,
  GridDeltaTransformer,
  type GridDeltaTransformerOptions,
  transformEventToDelta,
} from "./lib/transformers/gridDeltaTransformer.js";

export { MemoryTransport } from "./lib/transports/memoryTransport.js";
export {
  RedisTransport,
  type RedisTransportOptions,
} from "./lib/transports/redisTransport.js";
export type {
  EventBusTransport,
  MessageHandler,
} from "./lib/transports/transport.js";

export {
  type DisputeOpenedData,
  type DisputeOpenedEvent,
  DisputeOpenedEventSchema,
  type DisputeResolvedData,
  type DisputeResolvedEvent,
  DisputeResolvedEventSchema,
  type DomainEvent,
  DomainEventSchema,
  type DomainEventType,
  type EscrowLockedData,
  type EscrowLockedEvent,
  EscrowLockedEventSchema,
  type MandateVerifiedData,
  type MandateVerifiedEvent,
  MandateVerifiedEventSchema,
  type TrackingUpdatedData,
  type TrackingUpdatedEvent,
  TrackingUpdatedEventSchema,
} from "./lib/types/events.js";

export {
  type ClearinghouseRecord,
  ClearinghouseRecordSchema,
  type GridDeltaBatch,
  type GridDeltaItem,
  type GridDeltaType,
  type GridTransaction,
  getMicrosecondTimestamp,
} from "./lib/types/records.js";
