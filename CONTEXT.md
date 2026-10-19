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

### Rolling Velocity Window
A sliding-window time accumulator (1-hour, 24-hour, 30-day) tracking cumulative expenditure per agent ID or merchant domain to prevent runaway spending loops.

### Human-in-the-Loop (HITL) Threshold
A configurable risk scoring ceiling (typically $\ge 70/100$ or transaction values exceeding $250.00) that pauses autonomous execution and routes the transaction to the supervisor approval queue for a counter-signature.

### Cryptographic Webhook Ingestion & Verification
The asynchronous event ingestion pipeline validating PayPal webhook notifications. Authenticates incoming notifications using byte-for-byte CRC32 hashing over raw request buffers and RSA signature verification against PayPal's whitelisted X.509 signing certificates (`^https://api(\-m)?\.(sandbox\.)?paypal\.com/`). Defends against replay attacks with 24-hour transmission ID idempotency caching and translates verified notifications (`PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`) into typed Clearinghouse domain events.


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
