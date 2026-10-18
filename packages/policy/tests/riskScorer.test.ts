import { Money, RiskTier } from "@tessera/core";
import type { PaymentMandate } from "@tessera/mandates";
import { describe, expect, it } from "vitest";
import { type PolicyConfig, RiskScorer, type SpendContext, scoreRisk } from "../index.js";

function createSampleMandate(overrides: Partial<PaymentMandate> = {}): PaymentMandate {
  return {
    vct: "mandate.payment.1",
    transaction_id: "tx-test-risk-001",
    payee: {
      id: "bestbuy.com",
      name: "Best Buy Co.",
      website: "https://bestbuy.com",
    },
    payment_amount: {
      amount: 4500, // $45.00
      currency: "USD",
    },
    payment_instrument: {
      id: "instr-001",
      type: "PAYPAL_CREDIT",
    },
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: "nonce-risk-001",
    ...overrides,
  };
}

const sampleConfig: PolicyConfig = {
  maxAmountPerTransaction: Money.fromCents(100000, "USD"), // $1,000.00
  maxVelocity24h: Money.fromCents(500000, "USD"), // $5,000.00
  maxVelocity1h: Money.fromCents(200000, "USD"), // $2,000.00
  autoApprovalLimit: Money.fromCents(25000, "USD"), // $250.00
  hitlRiskThreshold: 70,
  allowedMerchantDomains: ["bestbuy.com", "amazon.com"],
  authorizedSupervisorPublicKeys: ["dummy-supervisor-key"],
};

describe("Composite Risk Scorer", () => {
  it("classifies standard low-value transaction with known merchant as LOW risk", () => {
    const scorer = new RiskScorer();
    const mandate = createSampleMandate({
      payment_amount: { amount: 2500, currency: "USD" }, // $25.00
    });

    const context: SpendContext = {
      agentId: "agent-001",
      mandate,
      isFirstTimeMerchant: false,
    };

    const evaluation = scorer.score({
      context,
      config: sampleConfig,
      currentVelocity24h: Money.fromCents(5000, "USD"),
      txCount1h: 1,
    });

    expect(evaluation.riskScore).toBeLessThan(31);
    expect(evaluation.riskTier).toBe(RiskTier.LOW);
    expect(evaluation.rationale.length).toBe(0);
  });

  it("escalates risk score when transaction amount exceeds auto-approval threshold", () => {
    const scorer = new RiskScorer();
    // $300.00 exceeds $250.00 ceiling
    const mandate = createSampleMandate({
      payment_amount: { amount: 30000, currency: "USD" },
    });

    const context: SpendContext = {
      agentId: "agent-001",
      mandate,
      isFirstTimeMerchant: false,
    };

    const evaluation = scorer.score({
      context,
      config: sampleConfig,
      currentVelocity24h: Money.zero("USD"),
      txCount1h: 0,
    });

    expect(evaluation.riskScore).toBeGreaterThanOrEqual(35);
    expect(evaluation.rationale.some((r) => r.includes("auto-approval ceiling"))).toBe(true);
  });

  it("flags elevated velocity and rapid transaction bursts", () => {
    const scorer = new RiskScorer();
    const mandate = createSampleMandate({
      payment_amount: { amount: 5000, currency: "USD" },
    });

    const context: SpendContext = {
      agentId: "agent-001",
      mandate,
      isFirstTimeMerchant: false,
    };

    // 24h spend already at $4,500.00 (which is 90% of $5,000 max) and 6 transactions in past hour
    const evaluation = scorer.score({
      context,
      config: sampleConfig,
      currentVelocity24h: Money.fromCents(450000, "USD"),
      txCount1h: 6,
    });

    expect(evaluation.riskScore).toBeGreaterThanOrEqual(35);
    expect(evaluation.rationale.some((r) => r.includes("24-hour spending velocity"))).toBe(true);
    expect(evaluation.rationale.some((r) => r.includes("Rapid transaction burst"))).toBe(true);
  });

  it("penalizes first-time merchant interaction", () => {
    const scorer = new RiskScorer();
    const mandate = createSampleMandate();

    const context: SpendContext = {
      agentId: "agent-001",
      mandate,
      isFirstTimeMerchant: true,
    };

    const evaluation = scorer.score({
      context,
      config: sampleConfig,
      currentVelocity24h: Money.zero("USD"),
      txCount1h: 0,
    });

    expect(evaluation.riskScore).toBe(20);
    expect(evaluation.rationale.some((r) => r.includes("First-time merchant"))).toBe(true);
  });

  it("detects shipping destination deviations and international destinations", () => {
    const scorer = new RiskScorer();
    const mandate = createSampleMandate();

    const context: SpendContext = {
      agentId: "agent-001",
      mandate,
      shippingAddress: {
        streetAddress: "999 Rogue Street",
        locality: "London",
        postalCode: "EC1A 1BB",
        country: "GB",
      },
      priorShippingAddresses: [
        {
          streetAddress: "123 Main St",
          locality: "Seattle",
          postalCode: "98101",
          country: "US",
        },
      ],
    };

    const evaluation = scorer.score({
      context,
      config: sampleConfig,
      currentVelocity24h: Money.zero("USD"),
      txCount1h: 0,
    });

    // 20 pts for mismatch + 10 pts for non-US = 30 pts
    expect(evaluation.riskScore).toBe(30);
    expect(evaluation.rationale.some((r) => r.includes("Shipping destination deviation"))).toBe(
      true,
    );
    expect(evaluation.rationale.some((r) => r.includes("Cross-border"))).toBe(true);
  });

  it("detects proxy/vpn and bot indicators from mandate risk_data", () => {
    const scorer = new RiskScorer();
    const mandate = createSampleMandate({
      risk_data: {
        proxy: true,
        bot_detected: true,
        score: 85,
      },
    });

    const context: SpendContext = {
      agentId: "agent-001",
      mandate,
    };

    const evaluation = scorer.score({
      context,
      config: sampleConfig,
      currentVelocity24h: Money.zero("USD"),
      txCount1h: 0,
    });

    // 25 (proxy) + 35 (bot) + 14 (upstream score) = 74 pts -> CRITICAL_HITL
    expect(evaluation.riskScore).toBeGreaterThanOrEqual(70);
    expect(evaluation.riskTier).toBe(RiskTier.CRITICAL_HITL);
    expect(evaluation.rationale.some((r) => r.includes("proxy/VPN/Tor"))).toBe(true);
    expect(evaluation.rationale.some((r) => r.includes("behavioral risk signal"))).toBe(true);
  });

  it("combines multiple compounding risk signals into CRITICAL_HITL tier (>= 70) with 100 point clamp", () => {
    const mandate = createSampleMandate({
      payment_amount: { amount: 35000, currency: "USD" }, // $350.00 (> $250.00 -> 35 pts)
      risk_data: {
        tor_detected: true, // 25 pts
        device_anomaly: true, // 35 pts
      },
    });

    const context: SpendContext = {
      agentId: "agent-001",
      mandate,
      isFirstTimeMerchant: true, // 20 pts
    };

    const evaluation = scoreRisk({
      context,
      config: sampleConfig,
      currentVelocity24h: Money.fromCents(450000, "USD"), // 20 pts
      txCount1h: 5, // 15 pts
    });

    // Total raw points = 35 + 25 + 35 + 20 + 20 + 15 = 150 -> clamped to 100
    expect(evaluation.riskScore).toBe(100);
    expect(evaluation.riskTier).toBe(RiskTier.CRITICAL_HITL);
    expect(evaluation.rationale.length).toBeGreaterThanOrEqual(5);
  });

  it("handles currency mismatch between mandate and policy limits safely without throwing", () => {
    const scorer = new RiskScorer();
    // Mandate in EUR, config in USD
    const mandate = createSampleMandate({
      payment_amount: { amount: 50000, currency: "EUR" },
    });

    const context: SpendContext = {
      agentId: "agent-curr-test",
      mandate,
    };

    const evaluation = scorer.score({
      context,
      config: sampleConfig,
      currentVelocity24h: Money.zero("EUR"),
      txCount1h: 0,
    });

    expect(evaluation.riskScore).toBeDefined();
    expect(Number.isFinite(evaluation.riskScore)).toBe(true);
  });

  it("handles shipping address with missing or empty country without crashing", () => {
    const scorer = new RiskScorer();
    const mandate = createSampleMandate();

    const context: SpendContext = {
      agentId: "agent-country-test",
      mandate,
      shippingAddress: {
        streetAddress: "123 Unknown Rd",
        country: "",
      },
    };

    const evaluation = scorer.score({
      context,
      config: sampleConfig,
      currentVelocity24h: Money.zero("USD"),
      txCount1h: 0,
    });

    expect(evaluation.riskScore).toBeDefined();
  });
});
