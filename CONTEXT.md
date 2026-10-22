# Tessera Domain Glossary & Architecture Context

This document defines the ubiquitous domain vocabulary and codebase architecture concepts for **Tessera**. All tickets, specifications, and code comments must use these precise terms.

---

## 1. Domain Vocabulary

### Mandate
An authenticated, cryptographically signed spending authorization issued by a human principal or autonomous agent under the **Agent Payments Protocol (AP2)**.
- **Checkout Mandate (`mandate.checkout.1`):** Defines the high-level intent, spending budget, and agent identity.
- **Payment Mandate (`mandate.payment.1`):** Binds the checkout mandate to an exact merchant payee, specific monetary amount (in integer cents), and cryptographic nonce.
- **SD-JWT Hash Proof:** The cryptographic hash (`transaction_id`) binding the payment mandate to the canonical checkout mandate.

### Clearinghouse
The core orchestration engine of Tessera that validates mandates, enforces spending policies, coordinates multi-retailer quotation, interfaces with PayPal payment rails, and streams real-time financial settlement deltas to institutional ledgers.

### Escrow Authorization Hold
A financial hold executed via PayPal **Orders v2** with `"intent": "AUTHORIZE"`. Funds are locked in buyer escrow without immediate settlement, protecting capital until physical or digital fulfillment is cryptographically proven.

### Milestone Escrow Capture
The final release of escrowed funds to the merchant via `/v2/payments/authorizations/{id}/capture`. Strictly gated by automated carrier delivery confirmation or authorized supervisor counter-signature.

### Shipment Milestone
A verified tracking checkpoint ingested from **PayPal Shipment Tracking v1** (`SHIPPED`, `IN_TRANSIT`, `DELIVERED`, `CANCELLED`, `RETURNED`). Transition to `DELIVERED` status cryptographically triggers escrow capture release.

### Dispute Evidence Pack
A cryptographically verifiable bundle of carrier tracking logs, signed AP2 mandates, and Channel3 quote snapshots submitted to PayPal **Disputes API v1** (`/v1/customer/disputes/{id}/provide-evidence`) upon shipment failure or merchant dispute.

### Autonomous Dispute Resolution & Claim Acceptance
An automated clearinghouse remediation pipeline evaluating customer dispute states. Autonomously accepts claims (`/v1/customer/disputes/{id}/accept-claim`) to immediately refund buyers when carrier proof confirms items are non-deliverable or verified damaged, or escalates unresolved disputes to PayPal review (`/v1/customer/disputes/{id}/escalate`) when carrier proof verifies successful delivery and buyer dispute SLA has elapsed.

### Rolling Velocity Window
A sliding-window time accumulator (1-hour, 24-hour, 30-day) tracking cumulative expenditure per agent ID or merchant domain to prevent runaway spending loops.

### Human-in-the-Loop (HITL) Threshold
A configurable risk scoring ceiling (typically $\ge 70/100$ or transaction values exceeding $250.00) that pauses autonomous execution and routes the transaction to the supervisor approval queue for a counter-signature.

### Cryptographic Webhook Ingestion & Verification
The asynchronous event ingestion pipeline validating PayPal webhook notifications. Authenticates incoming notifications using byte-for-byte CRC32 hashing over raw request buffers and RSA signature verification against PayPal's whitelisted X.509 signing certificates (`^https://api(\-m)?\.(sandbox\.)?paypal\.com/`). Defends against replay attacks with 24-hour transmission ID idempotency caching and translates verified notifications (`PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`) into typed Clearinghouse domain events.

### WebSocket Streaming Ledger Engine

The real-time financial clearinghouse streaming server (`apps/clearinghouse-api`) broadcasting transactional deltas over RFC 6455 WebSockets with 30-second heartbeat ping/pong keep-alives and backpressure-aware client session management. Directly formats deltas for high-throughput UI consumption via AG Grid Enterprise (`applyTransactionAsync`).

### AG Grid Delta Batch & Monotonic Hydration

A coalesced transaction packet emitted by `GridDeltaTransformer` (`packages/event-bus`) converting raw domain events into batched `{ type: "add" | "update" | "remove", data: ClearinghouseRecord }` updates. Enriched with microsecond-precision timestamps (`timestampMicros`) and strictly monotonic sequence numbers (`sequenceNumber`) for initial client snapshot hydration and UI thread thrashing prevention.

### Distributed Event Bus & Resilient Fallback

The pub/sub event backbone coordinating domain events (`MandateVerified`, `EscrowLocked`, `TrackingUpdated`, `DisputeOpened`, `DisputeResolved`). Implements distributed multi-instance broadcasting via Redis Pub/Sub with automatic, seamless fallback to in-memory `EventEmitter` dispatching for local testing and broker resilience.

### AG Grid Enterprise Clearinghouse Dashboard UI

The institutional supervisory frontend (`apps/clearinghouse-ui`) consuming real-time streaming deltas from the WebSocket streaming ledger engine via `applyTransactionAsync`. Visualizes dynamic risk heatmaps (0-30 green, 31-70 amber, 71-100 red), live status badges, multi-column filtering, and provides 1-click Human-in-the-Loop (HITL) supervisor action buttons (`/counter-sign` approve, `/void` escrow void, and `/dispute` escalation) with decoupled delta buffering.

### Bryntum Gantt Pro Procurement Scheduler

The interactive timeline component (`apps/clearinghouse-ui`) modeling autonomous procurement lifecycles as dependent milestone task trees with baseline duration comparisons, zoom controls, and critical path highlighting.

### Procurement Milestone Lifecycle & SLA Monitor

A 7-stage deterministic task sequence (`MANDATE_VERIFIED`, `CATALOG_DISCOVERY`, `ESCROW_HOLD`, `MERCHANT_DISPATCH`, `IN_TRANSIT`, `DELIVERY_VERIFIED`, `ESCROW_CAPTURED`) with Finish-to-Start dependencies. Evaluates real-time shipment milestones against carrier SLAs (e.g. 48h merchant dispatch, 72h carrier transit) and flags carrier exception statuses (`DELIVERY_DELAYED`, `ON_HOLD`, `PICKUP_FAILED`, `ERROR`, `RETURNED`) with visual warning badges and reactive event notifications.

---

## 2. Codebase Architecture Vocabulary (`codebase-design`)

All architectural suggestions and code reviews must use these concepts strictly:

- **Module:** A coherent unit of code exposing a public interface while encapsulating private implementation details behind entry points.
- **Interface:** The public surface area (root entry points: `index.ts`, `client.ts`) through which callers interact with a module.
- **Depth:** The ratio of internal behavior and complexity encapsulated to the size and simplicity of the public interface. A *deep module* provides powerful functionality through a minimal, elegant interface. A *shallow module* has an interface nearly as complex as its implementation.
- **Seam:** The boundary where tests exercise external behavior. Higher seams (testing through public entry points rather than internal functions) produce resilient, refactor-safe test suites.
- **Adapter:** A translation layer connecting external APIs (PayPal REST APIs, Channel3 MCP) to internal domain representations. One adapter represents a hypothetical seam; two adapters prove a real seam.
- **Leverage:** The degree to which a small interface change or foundational abstraction simplifies wide swathes of consumer code.
- **Locality:** The property where understanding and debugging a behavior does not require jumping across scattered files or ad-hoc conditionals.
- **The Deletion Test:** Would deleting an abstraction concentrate complexity in a clear way, or just scatter it across the codebase?
