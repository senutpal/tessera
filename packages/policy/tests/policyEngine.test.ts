import { Money, RiskTier } from "@tessera/core";
import type { PaymentMandate } from "@tessera/mandates";
import { describe, expect, it } from "vitest";
import {
  DisallowedCategoryError,
  evaluatePolicy,
  HITLDecisionStatus,
  MerchantDisallowedError,
  MerchantSpoofingError,
  type PolicyConfig,
  PolicyEngine,
  PolicyRuleViolationError,
  type SpendContext,
  SpendingLimitExceededError,
  VelocityLimitExceededError,
  VelocityTracker,
} from "../index.js";

function createValidMandate(overrides: Partial<PaymentMandate> = {}): PaymentMandate {
  const now = Math.floor(Date.now() / 1000);
  return {
    vct: "mandate.payment.1",
    transaction_id: "tx-policy-test-001",
    payee: {
      id: "bestbuy.com",
      name: "Best Buy Co.",
      website: "https://bestbuy.com",
    },
    payment_amount: {
      amount: 15000, // $150.00
      currency: "USD",
    },
    payment_instrument: {
      id: "instr-001",
      type: "PAYPAL_CREDIT",
    },
    iat: now - 10,
    exp: now + 3600,
    nonce: "nonce-engine-001",
    ...overrides,
  };
}

const baseConfig: PolicyConfig = {
  maxAmountPerTransaction: Money.fromCents(100000, "USD"), // $1,000.00
  maxVelocity24h: Money.fromCents(500000, "USD"), // $5,000.00
  maxVelocity1h: Money.fromCents(200000, "USD"), // $2,000.00
  maxMonthlySpend: Money.fromCents(2000000, "USD"), // $20,000.00
  autoApprovalLimit: Money.fromCents(25000, "USD"), // $250.00
  hitlRiskThreshold: 70,
  allowedMerchantDomains: ["bestbuy.com", "*.bestbuy.com", "homedepot.com"],
  disallowedCategories: ["gambling", "crypto", "weapons", "adult"],
  authorizedSupervisorPublicKeys: ["supervisor-pubkey-001"],
};

describe("Policy Engine Evaluation", () => {
  it("approves low-risk mandate under auto-approval limit (< $250.00)", () => {
    const engine = new PolicyEngine(baseConfig);
    const mandate = createValidMandate({
      payment_amount: { amount: 15000, currency: "USD" }, // $150.00
    });

    const context: SpendContext = {
      agentId: "agent-alpha",
      mandate,
      category: "electronics",
      isFirstTimeMerchant: false,
    };

    const result = engine.evaluate(context);
    expect(result.approved).toBe(true);
    expect(result.requiresHITL).toBe(false);
    expect(result.status).toBe(HITLDecisionStatus.APPROVED);
    expect(result.riskTier).toBe(RiskTier.LOW);

    // Spend was recorded in velocity tracker
    expect(engine.velocityTracker.getVelocity24h("agent-alpha", "USD").amount).toBe(15000);
  });

  it("routes mandate to PENDING_HUMAN_APPROVAL when amount reaches auto-approval limit ($250.00)", () => {
    const engine = new PolicyEngine(baseConfig);
    const mandate = createValidMandate({
      payment_amount: { amount: 25000, currency: "USD" }, // $250.00
    });

    const context: SpendContext = {
      agentId: "agent-alpha",
      mandate,
      category: "office_supplies",
      isFirstTimeMerchant: false,
    };

    const result = engine.evaluate(context);
    expect(result.approved).toBe(false);
    expect(result.requiresHITL).toBe(true);
    expect(result.status).toBe(HITLDecisionStatus.PENDING_HUMAN_APPROVAL);
    expect(result.queueId).toBeDefined();

    // Spend is NOT yet recorded in velocity tracker while in HITL queue
    expect(engine.velocityTracker.getVelocity24h("agent-alpha", "USD").amount).toBe(0);
  });

  it("routes high-risk mandate to PENDING_HUMAN_APPROVAL even for small transactions", () => {
    const engine = new PolicyEngine(baseConfig);
    // $50.00 is well under $250.00, but has bot, proxy, and tor flags in risk_data (score >= 70)
    const mandate = createValidMandate({
      payment_amount: { amount: 5000, currency: "USD" },
      risk_data: {
        bot_detected: true,
        proxy: true,
        tor_detected: true,
      },
    });

    const context: SpendContext = {
      agentId: "agent-alpha",
      mandate,
    };

    const result = engine.evaluate(context);
    expect(result.approved).toBe(false);
    expect(result.requiresHITL).toBe(true);
    expect(result.status).toBe(HITLDecisionStatus.PENDING_HUMAN_APPROVAL);
    expect(result.riskScore).toBeGreaterThanOrEqual(70);
    expect(result.riskTier).toBe(RiskTier.CRITICAL_HITL);
  });

  it("enforces per-transaction budget limit (allows cap, rejects cap + 1 cent)", () => {
    const engine = new PolicyEngine(baseConfig);

    // 1. Transaction exactly at cap ($1,000.00) -> accepted (routes to HITL because $1000 >= $250)
    const mandateAtCap = createValidMandate({
      payment_amount: { amount: 100000, currency: "USD" },
    });
    const resultAtCap = engine.evaluate({
      agentId: "agent-cap",
      mandate: mandateAtCap,
    });
    expect(resultAtCap.status).toBe(HITLDecisionStatus.PENDING_HUMAN_APPROVAL);

    // 2. Transaction at cap + 1 cent ($1,000.01) -> throws SpendingLimitExceededError with code LIMIT_EXCEEDED
    const mandateOverCap = createValidMandate({
      payment_amount: { amount: 100001, currency: "USD" },
    });
    expect(() =>
      engine.evaluate({
        agentId: "agent-cap",
        mandate: mandateOverCap,
      }),
    ).toThrow(SpendingLimitExceededError);

    try {
      engine.evaluate({
        agentId: "agent-cap",
        mandate: mandateOverCap,
      });
    } catch (err) {
      expect(err instanceof PolicyRuleViolationError).toBe(true);
      expect((err as PolicyRuleViolationError).code).toBe("LIMIT_EXCEEDED");
    }
  });

  it("enforces rolling 24-hour spending velocity limit", () => {
    const tracker = new VelocityTracker();
    const engine = new PolicyEngine(baseConfig, { velocityTracker: tracker });
    const now = 1_700_000_000_000;

    // Pre-record $4,850.00 spend 2 hours ago (within 24h window, outside 1h window)
    const tMinus2h = now - 2 * 60 * 60 * 1000;
    tracker.recordSpend("agent-vel", Money.fromCents(485000, "USD"), tMinus2h);

    // Next transaction: $150.00 reaches exactly $5,000.00 cap -> allowed
    const mandateAtLimit = createValidMandate({
      payment_amount: { amount: 15000, currency: "USD" },
    });
    const resultAtLimit = engine.evaluate({
      agentId: "agent-vel",
      mandate: mandateAtLimit,
      timestamp: now + 1000,
    });
    expect(resultAtLimit.approved).toBe(true);

    // Following transaction: $1.00 pushes over $5,000.00 limit -> throws VelocityLimitExceededError
    const mandateOverLimit = createValidMandate({
      payment_amount: { amount: 100, currency: "USD" },
    });
    expect(() =>
      engine.evaluate({
        agentId: "agent-vel",
        mandate: mandateOverLimit,
        timestamp: now + 2000,
      }),
    ).toThrow(VelocityLimitExceededError);
  });

  it("enforces rolling 1-hour spending velocity limit", () => {
    const tracker = new VelocityTracker();
    const engine = new PolicyEngine(baseConfig, { velocityTracker: tracker });
    const now = 1_700_000_000_000;

    // Max 1h velocity is $2,000.00. Pre-record $1,900.00 in current hour
    tracker.recordSpend("agent-1h", Money.fromCents(190000, "USD"), now);

    // Attempt $150.00 transaction in same hour (would total $2,050.00 > $2,000.00)
    const mandate = createValidMandate({
      payment_amount: { amount: 15000, currency: "USD" },
    });

    expect(() =>
      engine.evaluate({
        agentId: "agent-1h",
        mandate,
        timestamp: now + 5000,
      }),
    ).toThrow(VelocityLimitExceededError);
  });

  it("enforces monthly cumulative budget limit", () => {
    const tracker = new VelocityTracker();
    const engine = new PolicyEngine(baseConfig, { velocityTracker: tracker });
    const now = 1_700_000_000_000;

    // Max monthly spend is $20,000.00. Pre-record $19,950.00 2 days ago (outside 24h, inside 30d)
    const tMinus2d = now - 2 * 24 * 60 * 60 * 1000;
    tracker.recordSpend("agent-month", Money.fromCents(1995000, "USD"), tMinus2d);

    const mandateOver = createValidMandate({
      payment_amount: { amount: 6000, currency: "USD" }, // $60.00 -> $20,010.00
    });

    expect(() =>
      engine.evaluate({
        agentId: "agent-month",
        mandate: mandateOver,
        timestamp: now + 1000,
      }),
    ).toThrow(SpendingLimitExceededError);
  });

  it("validates merchant whitelist (exact domain and wildcard subdomain)", () => {
    const engine = new PolicyEngine(baseConfig);

    // 1. Exact whitelist match: "bestbuy.com"
    const resultExact = engine.evaluate({
      agentId: "agent-m",
      mandate: createValidMandate({
        payee: { id: "bestbuy.com", name: "Best Buy", website: "https://bestbuy.com" },
      }),
    });
    expect(resultExact.approved).toBe(true);

    // 2. Wildcard subdomain match: "shop.bestbuy.com" matches "*.bestbuy.com"
    const resultWildcard = engine.evaluate({
      agentId: "agent-m",
      mandate: createValidMandate({
        payee: { id: "bestbuy", name: "Best Buy", website: "https://shop.bestbuy.com" },
      }),
    });
    expect(resultWildcard.approved).toBe(true);

    // 3. Disallowed domain: "unauthorized-retailer.com" throws MerchantDisallowedError
    expect(() =>
      engine.evaluate({
        agentId: "agent-m",
        mandate: createValidMandate({
          payee: { id: "retailer", name: "Retailer", website: "https://unauthorized-retailer.com" },
        }),
      }),
    ).toThrow(MerchantDisallowedError);

    // 4. Subdomain spoofing attempt: "bestbuy.com.attacker.com"
    expect(() =>
      engine.evaluate({
        agentId: "agent-m",
        mandate: createValidMandate({
          payee: { id: "attacker", name: "Attacker", website: "https://bestbuy.com.attacker.com" },
        }),
      }),
    ).toThrow(MerchantDisallowedError);
  });

  it("detects and blocks merchant domain spoofing and homograph attacks", () => {
    const engine = new PolicyEngine(baseConfig);

    // 1. Deceptive auth / userinfo in domain string
    expect(() =>
      engine.evaluate({
        agentId: "agent-s",
        mandate: createValidMandate({
          payee: { id: "bestbuy.com@evil.com", name: "Spoof" },
        }),
      }),
    ).toThrow(MerchantSpoofingError);

    // 2. Punycode spoofing (starts with xn--)
    expect(() =>
      engine.evaluate({
        agentId: "agent-s",
        mandate: createValidMandate({
          payee: { id: "xn--bestbuy-v1a.com", name: "Punycode Spoof" },
        }),
      }),
    ).toThrow(MerchantSpoofingError);

    // 3. Raw IP address disallowed as domain
    expect(() =>
      engine.evaluate({
        agentId: "agent-s",
        mandate: createValidMandate({
          payee: { id: "192.168.1.1", name: "IP Merchant" },
        }),
      }),
    ).toThrow(MerchantSpoofingError);

    // 4. Malformed domain structure (consecutive dots)
    expect(() =>
      engine.evaluate({
        agentId: "agent-s",
        mandate: createValidMandate({
          payee: { id: "..bestbuy.com", name: "Malformed" },
        }),
      }),
    ).toThrow(MerchantSpoofingError);
  });

  it("blocks disallowed procurement categories", () => {
    const engine = new PolicyEngine(baseConfig);
    const mandate = createValidMandate();

    expect(() =>
      engine.evaluate({
        agentId: "agent-c",
        mandate,
        category: "gambling",
      }),
    ).toThrow(DisallowedCategoryError);

    expect(() =>
      engine.evaluate({
        agentId: "agent-c",
        mandate,
        category: "CRYPTO",
      }),
    ).toThrow(DisallowedCategoryError);

    // Allowed category succeeds
    const allowed = engine.evaluate({
      agentId: "agent-c",
      mandate,
      category: "hardware",
    });
    expect(allowed.approved).toBe(true);
  });

  it("evaluates safely without throwing when evaluateSafe is used", () => {
    const engine = new PolicyEngine(baseConfig);
    const mandateOverCap = createValidMandate({
      payment_amount: { amount: 500000, currency: "USD" }, // $5,000 > $1,000 cap
    });

    const result = engine.evaluateSafe({
      agentId: "agent-safe",
      mandate: mandateOverCap,
    });

    expect(result.approved).toBe(false);
    expect(result.status).toBe(HITLDecisionStatus.REJECTED);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0]?.code).toBe("LIMIT_EXCEEDED");
  });

  it("standalone evaluatePolicy function evaluates mandate correctly", () => {
    const mandate = createValidMandate({
      payment_amount: { amount: 5000, currency: "USD" },
    });

    const result = evaluatePolicy(
      {
        agentId: "agent-standalone",
        mandate,
      },
      baseConfig,
    );

    expect(result.approved).toBe(true);
    expect(result.status).toBe(HITLDecisionStatus.APPROVED);
  });

  it("satisfies performance acceptance criterion: evaluates mandates in < 2ms", () => {
    const engine = new PolicyEngine(baseConfig);
    const mandate = createValidMandate();
    const context: SpendContext = {
      agentId: "agent-perf",
      mandate,
      category: "tools",
      isFirstTimeMerchant: false,
    };

    // Warm-up run
    engine.evaluate(context);

    // Benchmark 100 evaluations
    const iterations = 100;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      engine.evaluate({
        ...context,
        agentId: `agent-perf-${i}`,
      });
    }
    const end = performance.now();
    const avgDurationMs = (end - start) / iterations;

    // Must be well below 2ms per evaluation
    expect(avgDurationMs).toBeLessThan(2.0);
  });

  it("blocks subdomain and TLD punycode homograph attacks", () => {
    const engine = new PolicyEngine(baseConfig);

    // Subdomain punycode homograph
    expect(() =>
      engine.evaluate({
        agentId: "agent-puny-sub",
        mandate: createValidMandate({
          payee: { id: "shop.xn--bestbuy-v1a.com", name: "Subdomain Punycode" },
        }),
      }),
    ).toThrow(MerchantSpoofingError);

    // TLD punycode
    expect(() =>
      engine.evaluate({
        agentId: "agent-puny-tld",
        mandate: createValidMandate({
          payee: { id: "bestbuy.xn--p1ai", name: "TLD Punycode" },
        }),
      }),
    ).toThrow(MerchantSpoofingError);
  });

  it("blocks dangerous characters, spaces, shell metacharacters, and shorthand IP formats", () => {
    const engine = new PolicyEngine(baseConfig);

    // Domain containing space
    expect(() =>
      engine.evaluate({
        agentId: "agent-bad-chars",
        mandate: createValidMandate({
          payee: { id: "bestbuy com", name: "Space Spoof" },
        }),
      }),
    ).toThrow(MerchantSpoofingError);

    // Domain containing shell/control characters
    expect(() =>
      engine.evaluate({
        agentId: "agent-bad-chars",
        mandate: createValidMandate({
          payee: { id: "bestbuy.com;rm -rf", name: "Command Injection" },
        }),
      }),
    ).toThrow(MerchantSpoofingError);

    expect(() =>
      engine.evaluate({
        agentId: "agent-bad-chars",
        mandate: createValidMandate({
          payee: { id: "bestbuy.com&evil.com", name: "Ampersand" },
        }),
      }),
    ).toThrow(MerchantSpoofingError);

    expect(() =>
      engine.evaluate({
        agentId: "agent-bad-chars",
        mandate: createValidMandate({
          payee: { id: "bestbuy.com|evil.com", name: "Pipe" },
        }),
      }),
    ).toThrow(MerchantSpoofingError);

    // Shorthand IPv4 (127.1)
    expect(() =>
      engine.evaluate({
        agentId: "agent-bad-chars",
        mandate: createValidMandate({
          payee: { id: "127.1", name: "Shorthand IP" },
        }),
      }),
    ).toThrow(MerchantSpoofingError);

    // Raw IPv6 (::1)
    expect(() =>
      engine.evaluate({
        agentId: "agent-bad-chars",
        mandate: createValidMandate({
          payee: { id: "::1", name: "IPv6" },
        }),
      }),
    ).toThrow(MerchantSpoofingError);
  });

  it("detects and blocks payee website domain and payee id mismatch", () => {
    const engine = new PolicyEngine(baseConfig);

    // Declares id: bestbuy.com (whitelisted) but website: https://evil.com (attacker)
    expect(() =>
      engine.evaluate({
        agentId: "agent-mismatch",
        mandate: createValidMandate({
          payee: {
            id: "bestbuy.com",
            name: "Best Buy Co.",
            website: "https://evil.com",
          },
        }),
      }),
    ).toThrow(MerchantSpoofingError);
  });

  it("enforces strict currency matching with configured policy base currency", () => {
    const engine = new PolicyEngine(baseConfig);

    // Base config is USD. Mandate specifies EUR.
    const mandateEur = createValidMandate({
      payment_amount: { amount: 15000, currency: "EUR" },
    });

    expect(() =>
      engine.evaluate({
        agentId: "agent-curr",
        mandate: mandateEur,
      }),
    ).toThrow(SpendingLimitExceededError);
  });

  it("normalizes whitelisted domain patterns configured with URL protocols and trailing slashes", () => {
    const configWithUrls: PolicyConfig = {
      ...baseConfig,
      allowedMerchantDomains: ["https://homedepot.com/", "http://*.bestbuy.com"],
    };
    const engine = new PolicyEngine(configWithUrls);

    const result1 = engine.evaluate({
      agentId: "agent-norm",
      mandate: createValidMandate({
        payee: { id: "homedepot.com", name: "Home Depot" },
      }),
    });
    expect(result1.approved).toBe(true);

    const result2 = engine.evaluate({
      agentId: "agent-norm",
      mandate: createValidMandate({
        payee: { id: "shop.bestbuy.com", name: "Best Buy Shop" },
      }),
    });
    expect(result2.approved).toBe(true);
  });
});
