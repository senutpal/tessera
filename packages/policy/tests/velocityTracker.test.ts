import { Money } from "@tessera/core";
import { describe, expect, it } from "vitest";
import {
  defaultVelocityTracker,
  ONE_HOUR_MS,
  recordSpend,
  TWENTY_FOUR_HOURS_MS,
  VelocityTracker,
} from "../index.js";

describe("Spend Velocity Tracker", () => {
  it("records and aggregates spends accurately in minor units", () => {
    const tracker = new VelocityTracker();
    const agentId = "agent-alpha-001";
    const now = 1_700_000_000_000;

    tracker.recordSpend(agentId, Money.fromCents(1050, "USD"), now);
    tracker.recordSpend(agentId, Money.fromCents(2500, "USD"), now + 1000);
    tracker.recordSpend(agentId, Money.fromCents(499, "USD"), now + 5000);

    const v1h = tracker.getVelocity1h(agentId, "USD", now + 6000);
    expect(v1h.amount).toBe(4049);
    expect(v1h.currency).toBe("USD");
    expect(v1h.toDecimalString()).toBe("40.49");
  });

  it("handles rolling time window transitions cleanly across 1h boundary", () => {
    const tracker = new VelocityTracker();
    const agentId = "agent-beta-002";
    const t0 = 1_700_000_000_000;

    // Spend at T=0
    tracker.recordSpend(agentId, Money.fromCents(5000, "USD"), t0);

    // Spend at T = 30 minutes
    tracker.recordSpend(agentId, Money.fromCents(3000, "USD"), t0 + 30 * 60 * 1000);

    // At T = 45 minutes: both spends are within 1h
    const vAt45m = tracker.getVelocity1h(agentId, "USD", t0 + 45 * 60 * 1000);
    expect(vAt45m.amount).toBe(8000);

    // At T = 1 hour + 1 second: first spend has aged out of 1h window
    const vAt61m = tracker.getVelocity1h(agentId, "USD", t0 + 60 * 60 * 1000 + 1000);
    expect(vAt61m.amount).toBe(3000);

    // Both spends are still within 24h window
    const v24h = tracker.getVelocity24h(agentId, "USD", t0 + 60 * 60 * 1000 + 1000);
    expect(v24h.amount).toBe(8000);
  });

  it("ages out transactions cleanly past 24-hour window", () => {
    const tracker = new VelocityTracker();
    const agentId = "agent-gamma-003";
    const t0 = 1_700_000_000_000;

    tracker.recordSpend(agentId, Money.fromCents(10000, "USD"), t0);

    // 23 hours later: still in window
    expect(tracker.getVelocity24h(agentId, "USD", t0 + 23 * ONE_HOUR_MS).amount).toBe(10000);

    // 24 hours + 1 ms later: aged out
    expect(tracker.getVelocity24h(agentId, "USD", t0 + TWENTY_FOUR_HOURS_MS + 1).amount).toBe(0);
  });

  it("tracks transaction counts correctly within sliding windows", () => {
    const tracker = new VelocityTracker();
    const agentId = "agent-delta-004";
    const t0 = 1_700_000_000_000;

    tracker.recordSpend(agentId, Money.fromCents(100, "USD"), t0);
    tracker.recordSpend(agentId, Money.fromCents(200, "USD"), t0 + 10 * 1000);
    tracker.recordSpend(agentId, Money.fromCents(300, "USD"), t0 + 20 * 1000);

    expect(tracker.getTransactionCount(agentId, "USD", ONE_HOUR_MS, t0 + 30 * 1000)).toBe(3);
    expect(
      tracker.getTransactionCount(agentId, "USD", ONE_HOUR_MS, t0 + ONE_HOUR_MS + 15 * 1000),
    ).toBe(1);
    expect(
      tracker.getTransactionCount(agentId, "USD", ONE_HOUR_MS, t0 + ONE_HOUR_MS + 25 * 1000),
    ).toBe(0);
  });

  it("verifies checkSpendLimit boundary conditions (exact limit vs limit + 1 cent)", () => {
    const tracker = new VelocityTracker();
    const agentId = "agent-epsilon-005";
    const limit24h = Money.fromCents(10000, "USD"); // $100.00
    const t0 = 1_700_000_000_000;

    // Existing spend: $60.00
    tracker.recordSpend(agentId, Money.fromCents(6000, "USD"), t0);

    // Candidate $40.00 exactly reaches limit -> allowed
    expect(
      tracker.checkSpendLimit(
        agentId,
        Money.fromCents(4000, "USD"),
        limit24h,
        TWENTY_FOUR_HOURS_MS,
        t0 + 1000,
      ),
    ).toBe(true);

    // Candidate $40.01 exceeds limit by 1 cent -> disallowed
    expect(
      tracker.checkSpendLimit(
        agentId,
        Money.fromCents(4001, "USD"),
        limit24h,
        TWENTY_FOUR_HOURS_MS,
        t0 + 1000,
      ),
    ).toBe(false);
  });

  it("isolates spends by agent ID and by currency independently", () => {
    const tracker = new VelocityTracker();
    const t0 = 1_700_000_000_000;

    tracker.recordSpend("agent-1", Money.fromCents(5000, "USD"), t0);
    tracker.recordSpend("agent-1", Money.fromCents(3000, "EUR"), t0);
    tracker.recordSpend("agent-2", Money.fromCents(7500, "USD"), t0);

    expect(tracker.getVelocity24h("agent-1", "USD", t0).amount).toBe(5000);
    expect(tracker.getVelocity24h("agent-1", "EUR", t0).amount).toBe(3000);
    expect(tracker.getVelocity24h("agent-2", "USD", t0).amount).toBe(7500);

    // Resetting agent-1 does not affect agent-2
    tracker.reset("agent-1");
    expect(tracker.getVelocity24h("agent-1", "USD", t0).amount).toBe(0);
    expect(tracker.getVelocity24h("agent-2", "USD", t0).amount).toBe(7500);
  });

  it("compresses historical entries into bounded time buckets without losing accuracy", () => {
    // Configure small threshold to trigger bucket compression
    const tracker = new VelocityTracker({
      compressionThreshold: 10,
      bucketSizeMs: 60_000,
    });
    const agentId = "agent-compress-006";
    const t0 = 1_700_000_000_000;

    // Add 25 transactions older than 1 hour
    for (let i = 0; i < 25; i++) {
      tracker.recordSpend(agentId, Money.fromCents(100, "USD"), t0 + i * 1000);
    }

    // Now query velocity 2 hours later (all 25 transactions fall in 24h window)
    const queryTime = t0 + 2 * ONE_HOUR_MS;
    const v24h = tracker.getVelocity24h(agentId, "USD", queryTime);
    expect(v24h.amount).toBe(2500);
  });

  it("prunes expired data past retention window", () => {
    const tracker = new VelocityTracker({
      maxRetentionMs: 10 * 1000, // 10s retention
    });
    const agentId = "agent-prune-007";
    const t0 = 1_700_000_000_000;

    tracker.recordSpend(agentId, Money.fromCents(500, "USD"), t0);
    expect(tracker.getVelocity(agentId, "USD", 60_000, t0).amount).toBe(500);

    // Prune at T + 15s
    tracker.prune(t0 + 15_000);
    expect(tracker.getVelocity(agentId, "USD", 60_000, t0 + 15_000).amount).toBe(0);
  });

  it("rejects invalid inputs on recordSpend", () => {
    const tracker = new VelocityTracker();
    expect(() => tracker.recordSpend("", Money.fromCents(100, "USD"))).toThrow();
    expect(() => tracker.recordSpend("agent", null as unknown as Money)).toThrow();
    expect(() => tracker.recordSpend("agent", Money.fromCents(-100, "USD"))).toThrow();
  });

  it("handles out-of-order transaction arrival maintaining sorted order and accurate aggregation", () => {
    const tracker = new VelocityTracker();
    const agentId = "agent-ooo-001";
    const t0 = 1_700_000_000_000;

    // Arrive out of order: T+30s, then T+10s, then T+50s, then T+20s
    tracker.recordSpend(agentId, Money.fromCents(300, "USD"), t0 + 30_000);
    tracker.recordSpend(agentId, Money.fromCents(100, "USD"), t0 + 10_000);
    tracker.recordSpend(agentId, Money.fromCents(500, "USD"), t0 + 50_000);
    tracker.recordSpend(agentId, Money.fromCents(200, "USD"), t0 + 20_000);

    // At T+25s: only T+10s and T+20s are recorded
    const vAt25s = tracker.getVelocity(agentId, "USD", 60_000, t0 + 25_000);
    expect(vAt25s.amount).toBe(300); // 100 + 200

    // At T+60s: all 4 transactions are included
    const vAt60s = tracker.getVelocity(agentId, "USD", 60_000, t0 + 60_000);
    expect(vAt60s.amount).toBe(1100); // 100 + 200 + 300 + 500
  });

  it("bounds memory by evicting oldest idle ledger when maxAgents capacity is reached", () => {
    const tracker = new VelocityTracker({ maxAgents: 3 });
    const t0 = 1_700_000_000_000;

    tracker.recordSpend("agent-A", Money.fromCents(100, "USD"), t0);
    tracker.recordSpend("agent-B", Money.fromCents(200, "USD"), t0 + 1000);
    tracker.recordSpend("agent-C", Money.fromCents(300, "USD"), t0 + 2000);

    // Adding 4th agent forces eviction of agent-A (oldest lastActive)
    tracker.recordSpend("agent-D", Money.fromCents(400, "USD"), t0 + 3000);

    expect(tracker.getVelocity24h("agent-A", "USD", t0 + 4000).amount).toBe(0);
    expect(tracker.getVelocity24h("agent-B", "USD", t0 + 4000).amount).toBe(200);
    expect(tracker.getVelocity24h("agent-C", "USD", t0 + 4000).amount).toBe(300);
    expect(tracker.getVelocity24h("agent-D", "USD", t0 + 4000).amount).toBe(400);
  });

  it("prune() deletes dormant ledgers with no active entries past maxRetentionMs", () => {
    const tracker = new VelocityTracker({ maxRetentionMs: 5000 });
    const t0 = 1_700_000_000_000;

    tracker.recordSpend("agent-ephemeral", Money.fromCents(500, "USD"), t0);
    expect(tracker.getVelocity24h("agent-ephemeral", "USD", t0).amount).toBe(500);

    // Prune 10 seconds later
    tracker.prune(t0 + 10_000);
    expect(tracker.getVelocity24h("agent-ephemeral", "USD", t0 + 10_000).amount).toBe(0);
  });

  it("checkSpendLimit returns false safely on currency mismatch without throwing", () => {
    const tracker = new VelocityTracker();
    const allowed = tracker.checkSpendLimit(
      "agent-curr",
      Money.fromCents(100, "EUR"),
      Money.fromCents(1000, "USD"),
      TWENTY_FOUR_HOURS_MS,
    );
    expect(allowed).toBe(false);
  });

  it("standalone recordSpend helper records spend on explicit and default trackers", () => {
    const customTracker = new VelocityTracker();
    const t0 = 1_700_000_000_000;

    // With explicit tracker
    recordSpend(customTracker, "agent-helper-1", Money.fromCents(1234, "USD"), t0);
    expect(customTracker.getVelocity24h("agent-helper-1", "USD", t0).amount).toBe(1234);

    // With default singleton tracker
    recordSpend("agent-helper-2", Money.fromCents(5678, "USD"), t0);
    expect(defaultVelocityTracker.getVelocity24h("agent-helper-2", "USD", t0).amount).toBe(5678);
  });
});
