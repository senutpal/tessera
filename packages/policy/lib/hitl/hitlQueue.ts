import { randomUUID } from "node:crypto";
import type { Money, RiskTier } from "@tessera/core";
import {
  computeCanonicalMandateHash,
  type PaymentMandate,
  signPayloadEd25519,
  verifyPayloadEd25519,
} from "@tessera/mandates";
import {
  type HITLQueueItem,
  HITLQueueStatus,
  InvalidQueueStateError,
  InvalidSupervisorSignatureError,
  type PolicyConfig,
  QueueItemExpiredError,
  type SupervisorApprovalPayload,
  type SupervisorApprovalSubmission,
  UnauthorizedSupervisorError,
} from "../types/policy.js";
import type { VelocityTracker } from "../velocity/velocityTracker.js";

export const DEFAULT_HITL_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface HITLQueueOptions {
  readonly velocityTracker?: VelocityTracker | undefined;
}

export interface EnqueueOptions {
  readonly agentId: string;
  readonly mandate: PaymentMandate;
  readonly transactionAmount: Money;
  readonly riskScore: number;
  readonly riskTier: RiskTier;
  readonly rationale: readonly string[];
  readonly ttlMs?: number;
  readonly createdAt?: number;
}

/**
 * Constructs the canonical payload signed by a supervisor during HITL review.
 */
export function createSupervisorApprovalPayload(
  queueId: string,
  mandate: PaymentMandate,
  decision: "APPROVE" | "REJECT",
  timestamp = Date.now(),
  comment?: string,
): SupervisorApprovalPayload {
  const mandateHash = computeCanonicalMandateHash(mandate);
  const payload: SupervisorApprovalPayload = {
    queueId,
    transactionId: mandate.transaction_id,
    mandateHash,
    decision,
    timestamp,
    ...(comment !== undefined ? { comment } : {}),
  };
  return payload;
}

/**
 * Helper to cryptographically sign a supervisor approval payload using Ed25519.
 */
export function signSupervisorApproval(
  payload: SupervisorApprovalPayload,
  privateKey: string,
): string {
  return signPayloadEd25519(payload, privateKey);
}

/**
 * Human-in-the-Loop (HITL) risk escalation queue and state machine.
 * Manages mandates requiring manual review and enforces Ed25519
 * cryptographic supervisor counter-signatures before release.
 */
export class HITLQueue {
  private readonly items = new Map<string, HITLQueueItem>();
  private readonly config: PolicyConfig;
  private readonly velocityTracker?: VelocityTracker | undefined;

  constructor(config: PolicyConfig, options: HITLQueueOptions = {}) {
    this.config = config;
    this.velocityTracker = options.velocityTracker;
  }

  /**
   * Enqueues a high-risk or over-limit mandate for supervisor review.
   */
  public enqueue(options: EnqueueOptions): HITLQueueItem {
    const {
      agentId,
      mandate,
      transactionAmount,
      riskScore,
      riskTier,
      rationale,
      ttlMs = this.config.queueItemTtlMs ?? DEFAULT_HITL_TTL_MS,
      createdAt = Date.now(),
    } = options;

    // Prevent duplicate pending items for the same mandate transaction_id
    const incomingHash = computeCanonicalMandateHash(mandate);
    for (const existing of this.items.values()) {
      if (
        existing.mandate.transaction_id === mandate.transaction_id &&
        existing.status === HITLQueueStatus.PENDING_HUMAN_APPROVAL &&
        createdAt <= existing.expiresAt
      ) {
        if (
          existing.agentId === agentId &&
          computeCanonicalMandateHash(existing.mandate) === incomingHash
        ) {
          return existing;
        }
        throw new InvalidQueueStateError(
          `A different mandate with transaction_id "${mandate.transaction_id}" is already pending review`,
          { transactionId: mandate.transaction_id, existingQueueId: existing.id },
        );
      }
    }

    const id = `hitl_${randomUUID().replace(/-/g, "")}`;
    const expiresAt = createdAt + ttlMs;

    const item: HITLQueueItem = {
      id,
      agentId,
      mandate,
      transactionAmount,
      riskScore,
      riskTier,
      rationale,
      status: HITLQueueStatus.PENDING_HUMAN_APPROVAL,
      createdAt,
      expiresAt,
    };

    this.items.set(id, item);
    return item;
  }

  /**
   * Retrieves a queue item by ID, automatically evaluating expiration.
   */
  public getItem(queueId: string, now = Date.now()): HITLQueueItem | undefined {
    const item = this.items.get(queueId);
    if (!item) {
      return undefined;
    }

    // Auto-expire pending items past their expiration deadline
    if (item.status === HITLQueueStatus.PENDING_HUMAN_APPROVAL && now > item.expiresAt) {
      const expiredItem: HITLQueueItem = {
        ...item,
        status: HITLQueueStatus.EXPIRED,
        resolvedAt: now,
      };
      this.items.set(queueId, expiredItem);
      return expiredItem;
    }

    return item;
  }

  /**
   * Returns all items currently in PENDING_HUMAN_APPROVAL status.
   */
  public getPendingItems(now = Date.now()): HITLQueueItem[] {
    const result: HITLQueueItem[] = [];
    for (const [id] of this.items) {
      const item = this.getItem(id, now);
      if (item && item.status === HITLQueueStatus.PENDING_HUMAN_APPROVAL) {
        result.push(item);
      }
    }
    return result;
  }

  /**
   * Submits an authenticated supervisor decision with Ed25519 signature.
   *
   * @throws {InvalidQueueStateError} If item does not exist or is not pending approval.
   * @throws {QueueItemExpiredError} If item has expired.
   * @throws {UnauthorizedSupervisorError} If supervisor public key is not in authorized list.
   * @throws {InvalidSupervisorSignatureError} If cryptographic signature verification fails.
   */
  public submitSupervisorApproval(
    submission: SupervisorApprovalSubmission,
    now = Date.now(),
  ): HITLQueueItem {
    if (!submission || typeof submission !== "object") {
      throw new InvalidQueueStateError("Supervisor approval submission is required");
    }

    if (submission.decision !== "APPROVE" && submission.decision !== "REJECT") {
      throw new InvalidQueueStateError(
        `Invalid supervisor decision: "${submission.decision}". Expected "APPROVE" or "REJECT"`,
        { queueId: submission?.queueId, decision: submission?.decision },
      );
    }

    if (typeof submission.timestamp !== "number" || !Number.isFinite(submission.timestamp)) {
      throw new InvalidSupervisorSignatureError("Submission timestamp must be a valid number", {
        queueId: submission.queueId,
      });
    }

    const effectiveNow = now;
    const item = this.getItem(submission.queueId, effectiveNow);
    if (!item) {
      throw new InvalidQueueStateError(`HITL queue item not found: ${submission.queueId}`, {
        queueId: submission.queueId,
      });
    }

    if (
      item.status === HITLQueueStatus.EXPIRED ||
      effectiveNow > item.expiresAt ||
      submission.timestamp > item.expiresAt
    ) {
      throw new QueueItemExpiredError(`HITL queue item ${submission.queueId} has expired`, {
        queueId: submission.queueId,
        expiresAt: item.expiresAt,
        now: effectiveNow,
      });
    }

    if (item.status !== HITLQueueStatus.PENDING_HUMAN_APPROVAL) {
      throw new InvalidQueueStateError(
        `Cannot review item in status "${item.status}". Expected "PENDING_HUMAN_APPROVAL"`,
        { queueId: submission.queueId, currentStatus: item.status },
      );
    }

    // Verify timestamp causality
    if (submission.timestamp < item.createdAt) {
      throw new InvalidSupervisorSignatureError(
        `Supervisor decision timestamp (${submission.timestamp}) cannot precede item creation (${item.createdAt})`,
        {
          queueId: submission.queueId,
          createdAt: item.createdAt,
          timestamp: submission.timestamp,
        },
      );
    }

    // Verify future timestamp skew tolerance (up to 60s)
    if (submission.timestamp > effectiveNow + 60_000) {
      throw new InvalidSupervisorSignatureError(
        `Supervisor decision timestamp (${submission.timestamp}) is too far in the future compared to current time (${effectiveNow})`,
        { queueId: submission.queueId, now: effectiveNow, timestamp: submission.timestamp },
      );
    }

    // 1. Check supervisor public key authorization
    const isAuthorized = this.config.authorizedSupervisorPublicKeys.includes(
      submission.supervisorPublicKey,
    );
    if (!isAuthorized) {
      throw new UnauthorizedSupervisorError(
        `Supervisor public key "${submission.supervisorPublicKey}" is not in the authorized keys list`,
        { supervisorPublicKey: submission.supervisorPublicKey },
      );
    }

    // 2. Reconstruct canonical approval payload and verify Ed25519 signature
    const mandateHash = computeCanonicalMandateHash(item.mandate);
    const expectedPayload: SupervisorApprovalPayload = {
      queueId: submission.queueId,
      transactionId: item.mandate.transaction_id,
      mandateHash,
      decision: submission.decision,
      timestamp: submission.timestamp,
      ...(submission.comment !== undefined ? { comment: submission.comment } : {}),
    };

    let isValidSignature = false;
    try {
      isValidSignature = verifyPayloadEd25519(
        expectedPayload,
        submission.signature,
        submission.supervisorPublicKey,
      );
    } catch (err) {
      throw new InvalidSupervisorSignatureError(
        `Cryptographic signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
        { queueId: submission.queueId, error: String(err) },
      );
    }

    if (!isValidSignature) {
      throw new InvalidSupervisorSignatureError(
        "Invalid supervisor signature for HITL escalation release",
        { queueId: submission.queueId },
      );
    }

    // 3. Transition queue state
    const resolvedStatus =
      submission.decision === "APPROVE"
        ? HITLQueueStatus.APPROVED_BY_SUPERVISOR
        : HITLQueueStatus.REJECTED_BY_SUPERVISOR;

    const resolvedItem: HITLQueueItem = {
      ...item,
      status: resolvedStatus,
      resolvedAt: effectiveNow,
      supervisorDecision: submission,
    };

    this.items.set(submission.queueId, resolvedItem);

    // 4. Automatically record approved spend into velocity tracker
    if (submission.decision === "APPROVE" && this.velocityTracker) {
      this.velocityTracker.recordSpend(item.agentId, item.transactionAmount, effectiveNow);
    }

    return resolvedItem;
  }

  /**
   * Clears all items in the queue.
   */
  public reset(): void {
    this.items.clear();
  }
}

/**
 * Standalone helper to submit a cryptographic supervisor approval to a HITL queue.
 */
export function submitSupervisorApproval(
  queue: HITLQueue,
  submission: SupervisorApprovalSubmission,
  now = Date.now(),
): HITLQueueItem {
  return queue.submitSupervisorApproval(submission, now);
}
