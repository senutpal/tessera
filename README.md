<p align="center">
  <img src="./assets/logo.png" alt="Tessera Logo" width="180" />
</p>

<h1 align="center">Tessera</h1>

<p align="center">
  <strong>Autonomous Clearinghouse & Delivery-Contingent Escrow Settlement Engine</strong>
</p>

<p align="center">
  An institutional clearinghouse bridging autonomous AI purchasing agents with regulated payment rails.<br />
  Enforcing zero-trust financial settlement through cryptographic spending mandates and carrier-verified milestone holds.
</p>

<p align="center">
  <a href="#system-architecture">Architecture</a> &bull;
  <a href="#core-capabilities">Capabilities</a> &bull;
  <a href="#supervisory-console">Console</a> &bull;
  <a href="#monorepo-layout">Monorepo</a> &bull;
  <a href="#quickstart">Quickstart</a>
</p>

---

## System Architecture

```mermaid
flowchart TD
    subgraph AgentLayer ["Autonomous Procurement Agents"]
        Agent["Autonomous Buyer Agent"]
        Mandates["Google AP2 Mandate Generator (RFC 8785 Canonical JSON)"]
        Agent -->|"Generates Mandates"| Mandates
    end

    subgraph GatewayLayer ["Tessera Clearinghouse Gateway (apps/clearinghouse-api)"]
        MCP["Model Context Protocol (MCP) Server"]
        Security["Security Middleware (Sliding Rate Limiter & OWASP Headers)"]
        Verifier["Ed25519 Cryptographic Verifier & SD-JWT Hash Binder"]
        PolicyEngine["Policy & Multi-Tier Velocity Risk Engine"]
        Channel3["Channel3 B2B Discovery & Inventory Engine"]

        MCP --> Security
        Security --> Verifier
        Verifier --> PolicyEngine
        MCP --> Channel3
    end

    subgraph SettlementLayer ["Settlement Rails & Event Backbone"]
        subgraph PayPalRails ["PayPal Institutional Rails"]
            Orders["PayPal Orders v2 (Authorized Hold Pattern)"]
            Tracking["PayPal Tracking v1 (Carrier Milestone Ingestion)"]
            Payments["PayPal Payments v2 (Delivery Capture & SLA Void)"]
            Disputes["PayPal Disputes v1 (Automated Dispute Evidence Packs)"]
        end

        subgraph EventData ["Data & Background Services"]
            Redis["Redis Key-Value & Pub-Sub (Sliding Nonce Store & Event Bus)"]
            Postgres["Managed PostgreSQL 16 (Auditable Transaction Records)"]
            Worker["SLA Monitor & Tracking Sync Worker (apps/clearinghouse-api/worker.ts)"]
        end
    end

    subgraph ConsoleLayer ["Institutional Supervisory Console (apps/clearinghouse-ui)"]
        WSClient["WebSocket Streaming Client (/ws/clearinghouse)"]
        AGGrid["Microsecond Timestamps & Risk Heatmaps"]
        Bryntum["Carrier SLA Milestones & Cutoff Alerts"]
        HITL["Dual-Key Adjudication Drawer (Supervisor Review & Dispute Desk)"]

        WSClient --> AGGrid
        WSClient --> Bryntum
        AGGrid --> HITL
    end

    Mandates -->|"MCP Tool Calls (JSON-RPC 2.0)"| MCP
    PolicyEngine -->|"Authorized Mandate"| Orders
    Orders -->|"Escrow State Delta"| Redis
    Redis -->|"Transactional Persistence"| Postgres
    Tracking -->|"Carrier Webhooks (SHIPPED / IN_TRANSIT / DELIVERED)"| Worker
    Worker -->|"Verified Delivery (Capture)"| Payments
    Worker -->|"SLA Breached (Void Hold)"| Payments
    Payments -->|"Settlement Event"| Redis
    Redis -->|"Real-time Deltas"| WSClient
```

---

## Core Capabilities

### Cryptographic Mandate Verification (AP2)

- **Verifiable Intent:** Implements Google AP2 specification (`mandate.checkout.1` bound to `mandate.payment.1`).
- **Ed25519 & RFC 8785:** Canonical JSON serialization (JCS) before signing and verifying over Ed25519 key pairs.
- **SD-JWT Hash Binding:** Cryptographically ties transaction authorization to the canonical checkout hash (`transaction_id`).
- **Anti-Replay Protection:** Redis sliding nonce store with TTL indexes prevents duplicate submissions.

### Delivery-Contingent Escrow (PayPal Orders v2)

- **Authorized Hold Pattern:** Executes orders with `"intent": "AUTHORIZE"`, placing a hold on the buyer's funds without premature disbursement.
- **Carrier Milestone Capture:** Ingests tracking events via Tracking v1 (`SHIPPED`, `IN_TRANSIT`, `DELIVERED`); triggers `/v2/payments/authorizations/{id}/capture` upon verified delivery.
- **Automated SLA Voiding:** Automatically voids authorizations (`/v2/payments/authorizations/{id}/void`) and releases the hold if carrier dispatch or transit windows expire.
- **Autonomous Dispute Desk:** Compiles cryptographic evidence packs for Disputes v1 or issues automated refunds upon merchant default.

### Supervisory Oversight & Dual-Key Adjudication

- **Streaming Ledger:** Monotonic state deltas over WebSockets with microsecond timestamps and dynamic risk heatmaps (Low, Elevated, Critical HITL).
- **SLA Milestone Scheduler:** Deterministic 7-stage procurement pipeline with critical-path calculation and carrier transit deadline monitors.
- **Dual-Key HITL Adjudication:** Supervisor controls for reviewing high-value transactions ($> \$250.00$) or elevated risk scores ($\ge 70/100$) before authorization.

---

## Supervisory Console

<p align="center">
  <img src="./assets/console.png" alt="Tessera Supervisory Console" width="100%" />
</p>

The institutional console pairs high-throughput virtualized data tables with deterministic milestone scheduling to give risk officers real-time operational visibility over all active agent procurements.

---

## Monorepo Layout

```text
tessera/
├── apps/
│   ├── clearinghouse-api/       # HTTP & WebSocket runtime, security middleware, health routes
│   └── clearinghouse-ui/        # AG Grid Enterprise & Bryntum Gantt supervisory console
├── packages/
│   ├── core/                    # Domain models, Money value object, RFC 8785 canonical JSON
│   ├── mandates/                # AP2 schema validation, Ed25519 signer, verifier pipeline
│   ├── policy/                  # Multi-tier risk engine, rolling velocity windows, HITL gates
│   ├── channel3/                # Retailer catalog discovery & quote normalization
│   ├── paypal/                  # PayPal Orders v2, Tracking v1, and Disputes v1 integration
│   ├── event-bus/               # Redis Pub/Sub event bus & streaming delta transformer
│   └── mcp-server/              # Model Context Protocol tools for autonomous procurement agents
├── scripts/seedDemo.ts          # Institutional scenario seeder with AP2 signatures
├── Dockerfile                   # Multi-stage production container (< 180MB footprint)
├── docker-compose.yml           # Full multi-container development & testing stack
└── render.yaml                  # Declarative Render Infrastructure as Code Blueprint
```

---

## Quickstart

### Prerequisites

- Node.js >= 20.0.0
- pnpm >= 10.0.0
- Docker & Docker Compose (optional)

### Setup & Verification

```bash
# 1. Install monorepo dependencies
pnpm install

# 2. Run quality gates & verification suite
pnpm run lint:boundaries # Boundary cruiser (148 modules, 0 violations)
pnpm run typecheck       # Strict TypeScript check (0 errors)
pnpm run lint            # Biome linter & formatter (0 errors)
pnpm test                # Monorepo unit & integration tests (653 tests)

# 3. Seed institutional commerce scenarios
pnpm run seed:demo

# 4. Run automated Postman test suite
pnpm run test:postman
```

### Containerized Stack

```bash
docker compose up --build
```

Provisions PostgreSQL 16, Redis 7, Clearinghouse API (`:3000`), Background Worker, and Supervisory Console (`:8080`).

---

## License

MIT License. See [LICENSE](LICENSE) for details.
