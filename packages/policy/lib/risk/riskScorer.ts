import { type Money, RiskTier } from "@tessera/core";
import { amountToMoney } from "@tessera/mandates";
import type { PolicyConfig, ShippingDestination, SpendContext } from "../types/policy.js";

export interface RiskEvaluation {
  readonly riskScore: number;
  readonly riskTier: RiskTier;
  readonly rationale: readonly string[];
}

export interface RiskScorerInputs {
  readonly context: SpendContext;
  readonly config: PolicyConfig;
  readonly currentVelocity24h: Money;
  readonly txCount1h: number;
}

/**
 * Normalizes and compares two shipping destinations for equality.
 */
function areAddressesEqual(a: ShippingDestination, b: ShippingDestination): boolean {
  return (
    (a.streetAddress?.trim().toLowerCase() ?? "") ===
      (b.streetAddress?.trim().toLowerCase() ?? "") &&
    (a.postalCode?.trim().toLowerCase() ?? "") === (b.postalCode?.trim().toLowerCase() ?? "") &&
    (a.country?.trim().toUpperCase() ?? "") === (b.country?.trim().toUpperCase() ?? "")
  );
}

/**
 * Composite risk scoring engine for AP2 payment mandates.
 * Evaluates transaction magnitude, agent velocity, merchant tenure,
 * shipping address deviations, and mandate risk_data signals to produce
 * a normalized 0-100 risk score and human-readable rationale.
 */
export class RiskScorer {
  /**
   * Scores an incoming payment mandate against organizational risk policies.
   */
  public score(inputs: RiskScorerInputs): RiskEvaluation {
    const { context, config, currentVelocity24h, txCount1h } = inputs;
    const mandate = context.mandate;
    const amount = amountToMoney(mandate.payment_amount);
    const rationale: string[] = [];
    let score = 0;

    // 1. Amount Magnitude Evaluation (up to 40 pts)
    if (amount.currency === config.autoApprovalLimit.currency) {
      if (amount.greaterThanOrEqual(config.autoApprovalLimit)) {
        score += 35;
        rationale.push(
          `Transaction amount (${amount.toDecimalString()} ${amount.currency}) meets or exceeds auto-approval ceiling (${config.autoApprovalLimit.toDecimalString()} ${config.autoApprovalLimit.currency})`,
        );
      } else if (amount.greaterThanOrEqual(config.autoApprovalLimit.multiply(0.75))) {
        score += 20;
        rationale.push(`Transaction amount is near auto-approval limit (>= 75% of limit)`);
      } else if (amount.greaterThanOrEqual(config.autoApprovalLimit.multiply(0.5))) {
        score += 10;
        rationale.push(`Transaction amount is moderate (>= 50% of auto-approval limit)`);
      }
    }

    if (amount.currency === config.maxAmountPerTransaction.currency) {
      if (amount.greaterThan(config.maxAmountPerTransaction.multiply(0.8))) {
        score += 15;
        rationale.push(
          `Transaction amount approaches organizational ceiling (> 80% of per-transaction limit)`,
        );
      }
    }

    // 2. Velocity and Frequency Burst Evaluation (up to 35 pts)
    if (
      currentVelocity24h.currency === amount.currency &&
      config.maxVelocity24h.currency === amount.currency
    ) {
      const projected24h = currentVelocity24h.add(amount);
      if (projected24h.greaterThan(config.maxVelocity24h.multiply(0.8))) {
        score += 20;
        rationale.push(
          `Projected 24-hour spending velocity exceeds 80% of limit (${projected24h.toDecimalString()} / ${config.maxVelocity24h.toDecimalString()} ${config.maxVelocity24h.currency})`,
        );
      } else if (projected24h.greaterThan(config.maxVelocity24h.multiply(0.5))) {
        score += 10;
        rationale.push(`Projected 24-hour spending velocity exceeds 50% of limit`);
      }
    }

    if (txCount1h >= 5) {
      score += 15;
      rationale.push(
        `Rapid transaction burst: ${txCount1h} transactions initiated in the past hour`,
      );
    } else if (txCount1h >= 3) {
      score += 10;
      rationale.push(`Elevated 1-hour transaction frequency (${txCount1h} transactions)`);
    }

    // 3. Merchant Tenure / New Merchant (up to 20 pts)
    if (context.isFirstTimeMerchant === true) {
      score += 20;
      rationale.push(
        `First-time merchant domain interaction for agent: ${mandate.payee.name || mandate.payee.id}`,
      );
    }

    // 4. Shipping Destination Deviation (up to 25 pts)
    const shipping = context.shippingAddress;
    if (shipping) {
      if (context.priorShippingAddresses && context.priorShippingAddresses.length > 0) {
        const matchesPrior = context.priorShippingAddresses.some((prior) =>
          areAddressesEqual(prior, shipping),
        );
        if (!matchesPrior) {
          score += 20;
          rationale.push(
            `Shipping destination deviation: destination does not match any previously verified addresses`,
          );
        }
      }

      const country = (shipping.country ?? "").trim().toUpperCase();
      if (country && country !== "US" && country !== "USA") {
        score += 10;
        rationale.push(`Cross-border shipping destination specified (${country})`);
      }
    }

    // 5. Mandate Risk Data Signals (up to 40 pts)
    if (mandate.risk_data && typeof mandate.risk_data === "object") {
      const riskData = mandate.risk_data as Record<string, unknown>;

      if (riskData.tor_detected === true) {
        score += 30;
        rationale.push("Tor exit node or anonymizing network detected in mandate risk_data");
      }

      if (riskData.proxy === true || riskData.flagged_ip === true) {
        score += 25;
        rationale.push(
          "Proxy, VPN, or flagged IP address detected in mandate risk_data (proxy/VPN/Tor)",
        );
      }

      if (
        riskData.bot_detected === true ||
        riskData.device_anomaly === true ||
        riskData.suspicious === true
      ) {
        score += 45;
        rationale.push(
          "Anomalous device fingerprint, bot pattern, or behavioral risk signal detected in mandate risk_data",
        );
      }

      if (
        typeof riskData.score === "number" &&
        Number.isFinite(riskData.score) &&
        riskData.score > 50
      ) {
        const upstreamPoints = Math.round((riskData.score - 50) * 0.4);
        score += upstreamPoints;
        rationale.push(
          `Upstream surface risk score (${riskData.score}/100) contributed ${upstreamPoints} points`,
        );
      }
    }

    // Clamp normalized score between 0 and 100
    const normalizedScore = Math.min(100, Math.max(0, Math.round(score)));

    // Categorize risk tier
    let riskTier: RiskTier;
    if (normalizedScore >= config.hitlRiskThreshold) {
      riskTier = RiskTier.CRITICAL_HITL;
    } else if (normalizedScore >= 31) {
      riskTier = RiskTier.ELEVATED;
    } else {
      riskTier = RiskTier.LOW;
    }

    return {
      riskScore: normalizedScore,
      riskTier,
      rationale,
    };
  }
}

/**
 * Convenient standalone function to score risk.
 */
export function scoreRisk(inputs: RiskScorerInputs): RiskEvaluation {
  return new RiskScorer().score(inputs);
}
