import { Money, RiskTier } from "@tessera/core";
import { generateEd25519KeyPair, type PaymentMandate } from "@tessera/mandates";
import { describe, expect, it } from "vitest";
import {
  createSupervisorApprovalPayload,
  DEFAULT_HITL_TTL_MS,
  HITLQueue,
  HITLQueueStatus,
  InvalidQueueStateError,
  InvalidSupervisorSignatureError,
  type PolicyConfig,
  QueueItemExpiredError,
  signSupervisorApproval,
  submitSupervisorApproval,
  UnauthorizedSupervisorError,
  VelocityLimitExceededError,
  VelocityTracker,
} from "../index.js";

function createSampleMandate(id = "tx-hitl-001"): PaymentMandate {
  return {
    vct: "mandate.payment.1",
    transaction_id: id,
    payee: {
      id: "bestbuy.com",
      name: "Best Buy Co.",
      website: "https://bestbuy.com",
    },
    payment_amount: {
      amount: 49999, // $499.99
      currency: "USD",
    },
    payment_instrument: {
      id: "instr-001",
      type: "PAYPAL_CREDIT",
    },
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: "nonce-hitl-001",
  };
}

describe("HITL Escalation Queue & Supervisor Counter-Signatures", () => {
  const supervisorKeys = generateEd25519KeyPair();
  const unauthorizedKeys = generateEd25519KeyPair();

  const config: PolicyConfig = {
    maxAmountPerTransaction: Money.fromCents(100000, "USD"),
    maxVelocity24h: Money.fromCents(500000, "USD"),
    autoApprovalLimit: Money.fromCents(25000, "USD"),
    hitlRiskThreshold: 70,
    allowedMerchantDomains: ["bestbuy.com"],
    authorizedSupervisorPublicKeys: [supervisorKeys.publicKey],
    queueItemTtlMs: 24 * 60 * 60 * 1000,
  };

  it("enqueues a mandate into PENDING_HUMAN_APPROVAL status", () => {
    const queue = new HITLQueue(config);
    const mandate = createSampleMandate();
    const now = 1_700_000_000_000;

    const item = queue.enqueue({
      agentId: "agent-001",
      mandate,
      transactionAmount: Money.fromCents(49999, "USD"),
      riskScore: 85,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["High risk score", "Exceeds auto-approval limit"],
      createdAt: now,
    });

    expect(item.id).toMatch(/^hitl_[a-f0-9]+$/);
    expect(item.status).toBe(HITLQueueStatus.PENDING_HUMAN_APPROVAL);
    expect(item.riskScore).toBe(85);
    expect(item.riskTier).toBe(RiskTier.CRITICAL_HITL);
    expect(item.expiresAt).toBe(now + DEFAULT_HITL_TTL_MS);

    const retrieved = queue.getItem(item.id, now);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(item.id);

    const pending = queue.getPendingItems(now);
    expect(pending.length).toBe(1);
    expect(pending[0]?.id).toBe(item.id);
  });

  it("successfully transitions state to APPROVED_BY_SUPERVISOR upon valid counter-signature", () => {
    const queue = new HITLQueue(config);
    const mandate = createSampleMandate();
    const now = 1_700_000_000_000;

    const item = queue.enqueue({
      agentId: "agent-001",
      mandate,
      transactionAmount: Money.fromCents(49999, "USD"),
      riskScore: 80,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["Manual review required"],
      createdAt: now,
    });

    // Supervisor constructs approval payload and signs it
    const approvalTimestamp = now + 10_000;
    const approvalPayload = createSupervisorApprovalPayload(
      item.id,
      mandate,
      "APPROVE",
      approvalTimestamp,
      "Approved after verifying supplier invoice",
    );

    const signature = signSupervisorApproval(approvalPayload, supervisorKeys.privateKey);

    const resolved = queue.submitSupervisorApproval(
      {
        queueId: item.id,
        supervisorPublicKey: supervisorKeys.publicKey,
        signature,
        decision: "APPROVE",
        timestamp: approvalTimestamp,
        comment: "Approved after verifying supplier invoice",
      },
      approvalTimestamp,
    );

    expect(resolved.status).toBe(HITLQueueStatus.APPROVED_BY_SUPERVISOR);
    expect(resolved.resolvedAt).toBe(approvalTimestamp);
    expect(resolved.supervisorDecision?.decision).toBe("APPROVE");

    // Queue item is no longer in pending list
    expect(queue.getPendingItems(approvalTimestamp).length).toBe(0);
  });

  it("transitions state to REJECTED_BY_SUPERVISOR upon valid supervisor rejection", () => {
    const queue = new HITLQueue(config);
    const mandate = createSampleMandate();
    const now = 1_700_000_000_000;

    const item = queue.enqueue({
      agentId: "agent-001",
      mandate,
      transactionAmount: Money.fromCents(49999, "USD"),
      riskScore: 80,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["High risk transaction"],
      createdAt: now,
    });

    const rejectTimestamp = now + 5000;
    const payload = createSupervisorApprovalPayload(item.id, mandate, "REJECT", rejectTimestamp);
    const signature = signSupervisorApproval(payload, supervisorKeys.privateKey);

    const resolved = queue.submitSupervisorApproval(
      {
        queueId: item.id,
        supervisorPublicKey: supervisorKeys.publicKey,
        signature,
        decision: "REJECT",
        timestamp: rejectTimestamp,
      },
      rejectTimestamp,
    );

    expect(resolved.status).toBe(HITLQueueStatus.REJECTED_BY_SUPERVISOR);
  });

  it("rejects unauthorized supervisor public key", () => {
    const queue = new HITLQueue(config);
    const mandate = createSampleMandate();
    const now = 1_700_000_000_000;

    const item = queue.enqueue({
      agentId: "agent-001",
      mandate,
      transactionAmount: Money.fromCents(49999, "USD"),
      riskScore: 75,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["Escalation"],
      createdAt: now,
    });

    const payload = createSupervisorApprovalPayload(item.id, mandate, "APPROVE", now + 1000);
    const signature = signSupervisorApproval(payload, unauthorizedKeys.privateKey);

    expect(() =>
      queue.submitSupervisorApproval(
        {
          queueId: item.id,
          supervisorPublicKey: unauthorizedKeys.publicKey,
          signature,
          decision: "APPROVE",
          timestamp: now + 1000,
        },
        now + 1000,
      ),
    ).toThrow(UnauthorizedSupervisorError);
  });

  it("rejects invalid or forged cryptographic signatures", () => {
    const queue = new HITLQueue(config);
    const mandate = createSampleMandate();
    const now = 1_700_000_000_000;

    const item = queue.enqueue({
      agentId: "agent-001",
      mandate,
      transactionAmount: Money.fromCents(49999, "USD"),
      riskScore: 75,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["Escalation"],
      createdAt: now,
    });

    // Signature created with unauthorized key but claimed as authorized key
    const payload = createSupervisorApprovalPayload(item.id, mandate, "APPROVE", now + 1000);
    const forgedSignature = signSupervisorApproval(payload, unauthorizedKeys.privateKey);

    expect(() =>
      queue.submitSupervisorApproval(
        {
          queueId: item.id,
          supervisorPublicKey: supervisorKeys.publicKey, // claiming authorized key
          signature: forgedSignature, // but signed with different key
          decision: "APPROVE",
          timestamp: now + 1000,
        },
        now + 1000,
      ),
    ).toThrow(InvalidSupervisorSignatureError);
  });

  it("expires items past TTL and forbids approval of expired items", () => {
    const queue = new HITLQueue({ ...config, queueItemTtlMs: 3600 * 1000 }); // 1h TTL
    const mandate = createSampleMandate();
    const now = 1_700_000_000_000;

    const item = queue.enqueue({
      agentId: "agent-001",
      mandate,
      transactionAmount: Money.fromCents(49999, "USD"),
      riskScore: 75,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["Escalation"],
      createdAt: now,
    });

    // 2 hours later: item has expired
    const expiredQueryTime = now + 2 * 3600 * 1000;
    const expiredItem = queue.getItem(item.id, expiredQueryTime);
    expect(expiredItem?.status).toBe(HITLQueueStatus.EXPIRED);

    const payload = createSupervisorApprovalPayload(item.id, mandate, "APPROVE", expiredQueryTime);
    const signature = signSupervisorApproval(payload, supervisorKeys.privateKey);

    expect(() =>
      queue.submitSupervisorApproval(
        {
          queueId: item.id,
          supervisorPublicKey: supervisorKeys.publicKey,
          signature,
          decision: "APPROVE",
          timestamp: expiredQueryTime,
        },
        expiredQueryTime,
      ),
    ).toThrow(QueueItemExpiredError);
  });

  it("prevents double-resolution on already resolved items", () => {
    const queue = new HITLQueue(config);
    const mandate = createSampleMandate();
    const now = 1_700_000_000_000;

    const item = queue.enqueue({
      agentId: "agent-001",
      mandate,
      transactionAmount: Money.fromCents(49999, "USD"),
      riskScore: 80,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["Review"],
      createdAt: now,
    });

    const payload = createSupervisorApprovalPayload(item.id, mandate, "APPROVE", now + 1000);
    const signature = signSupervisorApproval(payload, supervisorKeys.privateKey);

    queue.submitSupervisorApproval(
      {
        queueId: item.id,
        supervisorPublicKey: supervisorKeys.publicKey,
        signature,
        decision: "APPROVE",
        timestamp: now + 1000,
      },
      now + 1000,
    );

    // Attempt second resolution
    expect(() =>
      queue.submitSupervisorApproval(
        {
          queueId: item.id,
          supervisorPublicKey: supervisorKeys.publicKey,
          signature,
          decision: "APPROVE",
          timestamp: now + 2000,
        },
        now + 2000,
      ),
    ).toThrow(InvalidQueueStateError);
  });

  it("throws on non-existent queueId", () => {
    const queue = new HITLQueue(config);
    expect(() =>
      queue.submitSupervisorApproval({
        queueId: "hitl_nonexistent",
        supervisorPublicKey: supervisorKeys.publicKey,
        signature: "sig",
        decision: "APPROVE",
        timestamp: Date.now(),
      }),
    ).toThrow(InvalidQueueStateError);
  });

  it("automatically records spend into velocityTracker upon supervisor approval", () => {
    const tracker = new VelocityTracker();
    const queue = new HITLQueue(config, { velocityTracker: tracker });
    const mandate = createSampleMandate("tx-auto-vel-001");
    const now = 1_700_000_000_000;

    const item = queue.enqueue({
      agentId: "agent-spend-test",
      mandate,
      transactionAmount: Money.fromCents(45000, "USD"), // $450.00
      riskScore: 75,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["High value"],
      createdAt: now,
    });

    // Before approval: velocity is 0
    expect(tracker.getVelocity24h("agent-spend-test", "USD", now + 1000).amount).toBe(0);

    // Supervisor approves
    const payload = createSupervisorApprovalPayload(item.id, mandate, "APPROVE", now + 5000);
    const signature = signSupervisorApproval(payload, supervisorKeys.privateKey);

    queue.submitSupervisorApproval(
      {
        queueId: item.id,
        supervisorPublicKey: supervisorKeys.publicKey,
        signature,
        decision: "APPROVE",
        timestamp: now + 5000,
      },
      now + 5000,
    );

    // After approval: velocity reflects the $450.00 spend!
    expect(tracker.getVelocity24h("agent-spend-test", "USD", now + 6000).amount).toBe(45000);
  });

  it("rejects approval with VelocityLimitExceededError if velocity limit is exceeded at approval time", () => {
    const tracker = new VelocityTracker();
    const queue = new HITLQueue(config, { velocityTracker: tracker });
    const mandate = createSampleMandate("tx-vel-recheck-001");
    const now = 1_700_000_000_000;

    const item = queue.enqueue({
      agentId: "agent-vel-recheck",
      mandate,
      transactionAmount: Money.fromCents(200000, "USD"), // $2,000.00
      riskScore: 75,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["High value"],
      createdAt: now,
    });

    // While item is pending review, autonomous spend happens: $4,000.00 spend is recorded
    // Max 24h limit is $5,000.00. Current spend $4,000.00 + pending $2,000.00 = $6,000.00 > $5,000.00
    tracker.recordSpend("agent-vel-recheck", Money.fromCents(400000, "USD"), now + 1000);

    const payload = createSupervisorApprovalPayload(item.id, mandate, "APPROVE", now + 5000);
    const signature = signSupervisorApproval(payload, supervisorKeys.privateKey);

    expect(() =>
      queue.submitSupervisorApproval(
        {
          queueId: item.id,
          supervisorPublicKey: supervisorKeys.publicKey,
          signature,
          decision: "APPROVE",
          timestamp: now + 5000,
        },
        now + 5000,
      ),
    ).toThrow(VelocityLimitExceededError);
  });

  it("deduplicates pending items for the same mandate transaction_id", () => {
    const queue = new HITLQueue(config);
    const mandate = createSampleMandate("tx-dedup-001");
    const now = 1_700_000_000_000;

    const item1 = queue.enqueue({
      agentId: "agent-dedup",
      mandate,
      transactionAmount: Money.fromCents(30000, "USD"),
      riskScore: 80,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["First enqueue"],
      createdAt: now,
    });

    // Re-enqueuing the same mandate while pending returns existing item1
    const item2 = queue.enqueue({
      agentId: "agent-dedup",
      mandate,
      transactionAmount: Money.fromCents(30000, "USD"),
      riskScore: 80,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["Retry enqueue"],
      createdAt: now + 1000,
    });

    expect(item2.id).toBe(item1.id);
    expect(queue.getPendingItems(now + 2000).length).toBe(1);
  });

  it("rejects enqueue with existing transaction_id but differing mandate content or agentId", () => {
    const queue = new HITLQueue(config);
    const mandate1 = createSampleMandate();
    const now = 1_700_000_000_000;

    queue.enqueue({
      agentId: "agent-001",
      mandate: mandate1,
      transactionAmount: Money.fromCents(30000, "USD"),
      riskScore: 80,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["First enqueue"],
      createdAt: now,
    });

    // 1. Same transaction_id but different agentId -> throws InvalidQueueStateError
    expect(() =>
      queue.enqueue({
        agentId: "agent-ATTACKER",
        mandate: mandate1,
        transactionAmount: Money.fromCents(30000, "USD"),
        riskScore: 80,
        riskTier: RiskTier.CRITICAL_HITL,
        rationale: ["Different agent"],
        createdAt: now + 500,
      }),
    ).toThrow(InvalidQueueStateError);

    // 2. Same transaction_id and agentId, but different mandate amount -> throws InvalidQueueStateError
    const mandate2 = {
      ...mandate1,
      payment_amount: { amount: 99999, currency: "USD" },
    };
    expect(() =>
      queue.enqueue({
        agentId: "agent-001",
        mandate: mandate2,
        transactionAmount: Money.fromCents(99999, "USD"),
        riskScore: 80,
        riskTier: RiskTier.CRITICAL_HITL,
        rationale: ["Tampered mandate"],
        createdAt: now + 500,
      }),
    ).toThrow(InvalidQueueStateError);
  });

  it("validates supervisor decision string and rejects invalid values", () => {
    const queue = new HITLQueue(config);
    const mandate = createSampleMandate();
    const now = 1_700_000_000_000;

    const item = queue.enqueue({
      agentId: "agent-dec",
      mandate,
      transactionAmount: Money.fromCents(30000, "USD"),
      riskScore: 80,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["Review"],
      createdAt: now,
    });

    expect(() =>
      queue.submitSupervisorApproval(
        {
          queueId: item.id,
          supervisorPublicKey: supervisorKeys.publicKey,
          signature: "dummy",
          decision: "INVALID" as unknown as "APPROVE",
          timestamp: now + 1000,
        },
        now + 1000,
      ),
    ).toThrow(InvalidQueueStateError);
  });

  it("enforces timestamp causality: supervisor timestamp cannot precede creation", () => {
    const queue = new HITLQueue(config);
    const mandate = createSampleMandate();
    const now = 1_700_000_000_000;

    const item = queue.enqueue({
      agentId: "agent-causality",
      mandate,
      transactionAmount: Money.fromCents(30000, "USD"),
      riskScore: 80,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["Review"],
      createdAt: now,
    });

    // Timestamp 1000ms BEFORE item creation
    const payload = createSupervisorApprovalPayload(item.id, mandate, "APPROVE", now - 1000);
    const signature = signSupervisorApproval(payload, supervisorKeys.privateKey);

    expect(() =>
      queue.submitSupervisorApproval(
        {
          queueId: item.id,
          supervisorPublicKey: supervisorKeys.publicKey,
          signature,
          decision: "APPROVE",
          timestamp: now - 1000,
        },
        now + 1000,
      ),
    ).toThrow(InvalidSupervisorSignatureError);
  });

  it("standalone submitSupervisorApproval helper functions identically to queue method", () => {
    const queue = new HITLQueue(config);
    const mandate = createSampleMandate("tx-standalone-001");
    const now = 1_700_000_000_000;

    const item = queue.enqueue({
      agentId: "agent-standalone",
      mandate,
      transactionAmount: Money.fromCents(30000, "USD"),
      riskScore: 80,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["Review"],
      createdAt: now,
    });

    const payload = createSupervisorApprovalPayload(item.id, mandate, "APPROVE", now + 1000);
    const signature = signSupervisorApproval(payload, supervisorKeys.privateKey);

    const resolved = submitSupervisorApproval(
      queue,
      {
        queueId: item.id,
        supervisorPublicKey: supervisorKeys.publicKey,
        signature,
        decision: "APPROVE",
        timestamp: now + 1000,
      },
      now + 1000,
    );

    expect(resolved.status).toBe(HITLQueueStatus.APPROVED_BY_SUPERVISOR);
  });

  it("uses real clock time Date.now() when now parameter is omitted", () => {
    const queue = new HITLQueue(config);
    const mandate = createSampleMandate("tx-clock-test-001");
    // Enqueued 2 days in the past (already expired relative to Date.now())
    const pastTime = Date.now() - 48 * 60 * 60 * 1000;

    const item = queue.enqueue({
      agentId: "agent-clock",
      mandate,
      transactionAmount: Money.fromCents(30000, "USD"),
      riskScore: 80,
      riskTier: RiskTier.CRITICAL_HITL,
      rationale: ["Clock test"],
      createdAt: pastTime,
    });

    const payload = createSupervisorApprovalPayload(item.id, mandate, "APPROVE", pastTime + 1000);
    const signature = signSupervisorApproval(payload, supervisorKeys.privateKey);

    // Submitting with omitted `now` compares against Date.now(), detecting expiration even if submission timestamp was forged in past
    expect(() =>
      queue.submitSupervisorApproval({
        queueId: item.id,
        supervisorPublicKey: supervisorKeys.publicKey,
        signature,
        decision: "APPROVE",
        timestamp: pastTime + 1000,
      }),
    ).toThrow(QueueItemExpiredError);
  });
});
