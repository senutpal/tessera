import { type Money, RiskTier } from "@tessera/core";
import { amountToMoney, PaymentMandateSchema } from "@tessera/mandates";
import { HITLQueue } from "../hitl/hitlQueue.js";
import { RiskScorer } from "../risk/riskScorer.js";
import {
  DisallowedCategoryError,
  HITLDecisionStatus,
  MerchantDisallowedError,
  MerchantSpoofingError,
  type PolicyConfig,
  type PolicyEvaluationResult,
  type PolicyViolationDetail,
  type SpendContext,
  SpendingLimitExceededError,
  VelocityLimitExceededError,
} from "../types/policy.js";
import { VelocityTracker } from "../velocity/velocityTracker.js";

// Detection of IPv4 addresses (including shorthand like 127.1 or 10.1)
const IPV4_REGEX = /^(?:\d{1,3}\.){1,3}\d{1,3}$/;

// Detection of domain strings with suspicious characters (auth, port, path, null bytes, url encoding, shell chars)
const SUSPICIOUS_DOMAIN_CHARS_REGEX = /[@:/?#\\;|<>&`$!*+='"`~,%^()[\]{} ]/;

// RFC 1035 / RFC 1123 domain label validation: 1-63 chars, alphanumeric and hyphens, no leading/trailing hyphen
const DOMAIN_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Top-level domain must be purely alphabetic and at least 2 characters long
const TLD_REGEX = /^[a-z]{2,63}$/;

/**
 * Validates domain string format and checks for homograph, punycode, or spoofing attacks.
 * Conforms to RFC 1035 / RFC 1123 standards.
 */
export function validateMerchantDomain(domain: string): void {
  if (!domain || typeof domain !== "string" || !domain.trim()) {
    throw new MerchantSpoofingError("Merchant domain is missing or empty", { domain });
  }

  const trimmed = domain.trim().toLowerCase();

  if (trimmed.length > 253) {
    throw new MerchantSpoofingError(
      `Merchant domain exceeds maximum RFC length of 253 characters: "${domain}"`,
      { domain },
    );
  }

  // Reject non-ASCII characters (homographs, unicode, zero-width characters)
  if (/[^\x21-\x7E]/.test(trimmed) || /\s/.test(trimmed)) {
    throw new MerchantSpoofingError(
      `Non-ASCII or whitespace characters detected in merchant domain: "${domain}"`,
      { domain },
    );
  }

  // Check for suspicious characters (ports, paths, userinfo, semicolons, shell metachars)
  if (SUSPICIOUS_DOMAIN_CHARS_REGEX.test(trimmed)) {
    throw new MerchantSpoofingError(
      `Merchant domain contains invalid or deceptive characters: "${domain}"`,
      { domain },
    );
  }

  // Check for Punycode anywhere in the domain (full domain, subdomain, or TLD)
  if (trimmed.includes("xn--")) {
    throw new MerchantSpoofingError(
      `Punycode or non-ASCII internationalized domain spoofing detected: "${domain}"`,
      { domain },
    );
  }

  // Reject raw IP addresses (IPv4, shorthand IP, or IPv6)
  if (
    IPV4_REGEX.test(trimmed) ||
    trimmed.includes(":") ||
    trimmed.includes("[") ||
    trimmed.includes("]")
  ) {
    throw new MerchantSpoofingError(
      `Raw IP addresses are disallowed as merchant domains: "${domain}"`,
      { domain },
    );
  }

  const parts = trimmed.split(".");
  if (parts.length < 2) {
    throw new MerchantSpoofingError(
      `Malformed merchant domain structure: "${domain}". Must contain at least a domain name and TLD.`,
      { domain },
    );
  }

  // Validate each label (excluding TLD)
  for (let i = 0; i < parts.length - 1; i++) {
    const label = parts[i] as string;
    if (!DOMAIN_LABEL_REGEX.test(label)) {
      throw new MerchantSpoofingError(
        `Malformed merchant domain label: "${label}" in domain "${domain}"`,
        { domain, label },
      );
    }
  }

  // Validate TLD (must be alphabetic and at least 2 chars)
  const tld = parts[parts.length - 1] as string;
  if (!TLD_REGEX.test(tld)) {
    throw new MerchantSpoofingError(`Invalid top-level domain: "${tld}" in domain "${domain}"`, {
      domain,
      tld,
    });
  }
}

/**
 * Checks if a candidate domain matches an allowed pattern (supports exact and *.example.com wildcards).
 */
export function isDomainAllowed(domain: string, allowedDomains: readonly string[]): boolean {
  if (!domain || typeof domain !== "string") {
    return false;
  }
  const normDomain = domain.toLowerCase().trim();

  return allowedDomains.some((pattern) => {
    if (!pattern || typeof pattern !== "string") {
      return false;
    }
    const cleanPattern = pattern
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");

    if (cleanPattern.startsWith("*.")) {
      const rootDomain = cleanPattern.slice(2);
      return normDomain === rootDomain || normDomain.endsWith(`.${rootDomain}`);
    }
    return normDomain === cleanPattern;
  });
}

/**
 * Extracts the effective merchant domain from a payment mandate payee.
 * Validates consistency between declared domain/id and website URL to prevent spoofing.
 */
export function extractMerchantDomain(payee: Record<string, unknown>): string {
  if (!payee || typeof payee !== "object") {
    throw new MerchantSpoofingError("Payee object is missing or invalid");
  }

  let websiteHost: string | undefined;
  if (typeof payee.website === "string" && payee.website.trim()) {
    try {
      const parsedUrl = new URL(payee.website);
      if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
        throw new MerchantSpoofingError(
          `Merchant website URL has invalid protocol: "${parsedUrl.protocol}"`,
          { website: payee.website },
        );
      }
      websiteHost = parsedUrl.hostname;
    } catch (err) {
      if (err instanceof MerchantSpoofingError) throw err;
      throw new MerchantSpoofingError(`Merchant website is not a valid URL: "${payee.website}"`, {
        website: payee.website,
      });
    }
  }

  let declaredDomain: string | undefined;
  if (typeof payee.domain === "string" && payee.domain.trim()) {
    declaredDomain = payee.domain.trim();
  } else if (typeof payee.id === "string" && payee.id.trim()) {
    declaredDomain = payee.id.trim();
  } else if (typeof payee.name === "string" && payee.name.trim()) {
    declaredDomain = payee.name.trim();
  }

  // If both website and declaredDomain contain domain structures, verify they match
  if (websiteHost && declaredDomain?.includes(".")) {
    const normWebsite = websiteHost.toLowerCase();
    const normDeclared = declaredDomain.toLowerCase();
    const matches =
      normWebsite === normDeclared ||
      normWebsite.endsWith(`.${normDeclared}`) ||
      normDeclared.endsWith(`.${normWebsite}`);

    if (!matches) {
      throw new MerchantSpoofingError(
        `Merchant website domain ("${websiteHost}") does not match payee identifier domain ("${declaredDomain}")`,
        { websiteHost, declaredDomain },
      );
    }
    return websiteHost;
  }

  return websiteHost || declaredDomain || "";
}

export interface PolicyEngineOptions {
  readonly velocityTracker?: VelocityTracker;
  readonly hitlQueue?: HITLQueue;
  readonly riskScorer?: RiskScorer;
}

/**
 * Main organizational spending policy evaluation engine.
 * Evaluates payment mandates against budget caps, sliding velocity limits,
 * merchant whitelists, spoofing checks, and risk thresholds (< 2ms evaluation).
 */
export class PolicyEngine {
  public readonly config: PolicyConfig;
  public readonly velocityTracker: VelocityTracker;
  public readonly hitlQueue: HITLQueue;
  public readonly riskScorer: RiskScorer;

  constructor(config: PolicyConfig, options: PolicyEngineOptions = {}) {
    const baseCurrency = config.maxAmountPerTransaction.currency;
    const limits: Record<string, Money | undefined> = {
      maxVelocity24h: config.maxVelocity24h,
      maxVelocity1h: config.maxVelocity1h,
      maxMonthlySpend: config.maxMonthlySpend,
      autoApprovalLimit: config.autoApprovalLimit,
    };
    for (const [name, limit] of Object.entries(limits)) {
      if (limit && limit.currency !== baseCurrency) {
        throw new Error(
          `PolicyConfig.${name} currency "${limit.currency}" must match base limit currency "${baseCurrency}"`,
        );
      }
    }

    this.config = config;
    this.velocityTracker = options.velocityTracker ?? new VelocityTracker();
    this.hitlQueue =
      options.hitlQueue ?? new HITLQueue(config, { velocityTracker: this.velocityTracker });
    this.riskScorer = options.riskScorer ?? new RiskScorer();
  }

  /**
   * Evaluates a payment mandate against policies.
   * Throws PolicyRuleViolationError if hard constraints are violated.
   * If valid, routes to HITL queue or approves immediately.
   */
  public evaluate(context: SpendContext): PolicyEvaluationResult {
    const timestamp = context.timestamp ?? Date.now();

    // 1. Mandate schema validation
    PaymentMandateSchema.parse(context.mandate);

    // 2. Extract and validate merchant domain against spoofing
    const rawDomain = extractMerchantDomain(
      context.mandate.payee as unknown as Record<string, unknown>,
    );
    validateMerchantDomain(rawDomain);

    // 3. Whitelist validation
    const domainAllowed = isDomainAllowed(rawDomain, this.config.allowedMerchantDomains);
    if (!domainAllowed) {
      throw new MerchantDisallowedError(
        `Merchant domain "${rawDomain}" is not in the authorized whitelist`,
        { domain: rawDomain, allowed: this.config.allowedMerchantDomains },
      );
    }

    // 4. Disallowed category validation
    if (context.category && this.config.disallowedCategories) {
      const normCat = context.category.trim().toLowerCase();
      const isDisallowed = this.config.disallowedCategories.some(
        (disallowed) => disallowed.trim().toLowerCase() === normCat,
      );
      if (isDisallowed) {
        throw new DisallowedCategoryError(
          `Procurement category "${context.category}" is strictly disallowed by organizational policy`,
          { category: context.category },
        );
      }
    }

    // 5. Currency matching check & Per-transaction budget limit check
    const amount = amountToMoney(context.mandate.payment_amount);
    const policyCurrency = this.config.maxAmountPerTransaction.currency;
    if (amount.currency !== policyCurrency) {
      throw new SpendingLimitExceededError(
        `Transaction currency "${amount.currency}" does not match configured policy currency "${policyCurrency}"`,
        {
          transactionCurrency: amount.currency,
          policyCurrency,
        },
      );
    }
    if (amount.greaterThan(this.config.maxAmountPerTransaction)) {
      throw new SpendingLimitExceededError(
        `Transaction amount (${amount.toDecimalString()} ${amount.currency}) exceeds maximum per-transaction cap (${this.config.maxAmountPerTransaction.toDecimalString()} ${this.config.maxAmountPerTransaction.currency})`,
        {
          requestedAmount: amount.toJSON(),
          maxAllowed: this.config.maxAmountPerTransaction.toJSON(),
        },
      );
    }

    // 6. Rolling 24-hour spend velocity limit check
    const currentVelocity24h = this.velocityTracker.getVelocity24h(
      context.agentId,
      amount.currency,
      timestamp,
    );
    const projected24h = currentVelocity24h.add(amount);
    if (projected24h.greaterThan(this.config.maxVelocity24h)) {
      throw new VelocityLimitExceededError(
        `Transaction exceeds rolling 24-hour spending velocity limit (${projected24h.toDecimalString()} > ${this.config.maxVelocity24h.toDecimalString()} ${this.config.maxVelocity24h.currency})`,
        {
          currentVelocity24h: currentVelocity24h.toJSON(),
          requestedAmount: amount.toJSON(),
          projected24h: projected24h.toJSON(),
          maxVelocity24h: this.config.maxVelocity24h.toJSON(),
        },
      );
    }

    // 7. Optional rolling 1-hour spend velocity limit check
    const currentVelocity1h = this.velocityTracker.getVelocity1h(
      context.agentId,
      amount.currency,
      timestamp,
    );
    if (this.config.maxVelocity1h) {
      const projected1h = currentVelocity1h.add(amount);
      if (projected1h.greaterThan(this.config.maxVelocity1h)) {
        throw new VelocityLimitExceededError(
          `Transaction exceeds rolling 1-hour spending velocity limit (${projected1h.toDecimalString()} > ${this.config.maxVelocity1h.toDecimalString()} ${this.config.maxVelocity1h.currency})`,
          {
            currentVelocity1h: currentVelocity1h.toJSON(),
            requestedAmount: amount.toJSON(),
            projected1h: projected1h.toJSON(),
            maxVelocity1h: this.config.maxVelocity1h.toJSON(),
          },
        );
      }
    }

    // 8. Optional monthly / cumulative spend check
    if (this.config.maxMonthlySpend) {
      const currentVelocity30d = this.velocityTracker.getVelocity30d(
        context.agentId,
        amount.currency,
        timestamp,
      );
      const projected30d = currentVelocity30d.add(amount);
      if (projected30d.greaterThan(this.config.maxMonthlySpend)) {
        throw new SpendingLimitExceededError(
          `Transaction exceeds cumulative monthly spend cap (${projected30d.toDecimalString()} > ${this.config.maxMonthlySpend.toDecimalString()} ${this.config.maxMonthlySpend.currency})`,
          {
            currentVelocity30d: currentVelocity30d.toJSON(),
            requestedAmount: amount.toJSON(),
            projected30d: projected30d.toJSON(),
            maxMonthlySpend: this.config.maxMonthlySpend.toJSON(),
          },
        );
      }
    }

    // 9. Risk scoring
    const txCount1h = this.velocityTracker.getTransactionCount(
      context.agentId,
      amount.currency,
      60 * 60 * 1000,
      timestamp,
    );

    const riskEvaluation = this.riskScorer.score({
      context,
      config: this.config,
      currentVelocity24h,
      txCount1h,
    });

    // 10. HITL Threshold Trigger Evaluation
    const exceedsAutoApprovalCeiling = amount.greaterThanOrEqual(this.config.autoApprovalLimit);
    const exceedsRiskThreshold = riskEvaluation.riskScore >= this.config.hitlRiskThreshold;
    const requiresHITL = exceedsAutoApprovalCeiling || exceedsRiskThreshold;

    if (requiresHITL) {
      const queueItem = this.hitlQueue.enqueue({
        agentId: context.agentId,
        mandate: context.mandate,
        transactionAmount: amount,
        riskScore: riskEvaluation.riskScore,
        riskTier: riskEvaluation.riskTier,
        rationale: riskEvaluation.rationale,
        createdAt: timestamp,
      });

      return {
        approved: false,
        requiresHITL: true,
        status: HITLDecisionStatus.PENDING_HUMAN_APPROVAL,
        riskScore: riskEvaluation.riskScore,
        riskTier: riskEvaluation.riskTier,
        rationale: riskEvaluation.rationale,
        violations: [],
        queueId: queueItem.id,
      };
    }

    // 11. Autonomous Approval: record velocity spend immediately
    this.velocityTracker.recordSpend(context.agentId, amount, timestamp);

    return {
      approved: true,
      requiresHITL: false,
      status: HITLDecisionStatus.APPROVED,
      riskScore: riskEvaluation.riskScore,
      riskTier: riskEvaluation.riskTier,
      rationale: riskEvaluation.rationale,
      violations: [],
    };
  }

  /**
   * Safe evaluation variant that does not throw on policy violations,
   * returning violations in the result object instead.
   */
  public evaluateSafe(context: SpendContext): PolicyEvaluationResult {
    try {
      return this.evaluate(context);
    } catch (err) {
      const violationCode =
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        typeof (err as { code: unknown }).code === "string"
          ? ((err as { code: string }).code as PolicyViolationDetail["code"])
          : ("LIMIT_EXCEEDED" as const);

      const violationDetail: PolicyViolationDetail = {
        code: violationCode,
        message: err instanceof Error ? err.message : String(err),
      };

      return {
        approved: false,
        requiresHITL: false,
        status: HITLDecisionStatus.REJECTED,
        riskScore: 100,
        riskTier: RiskTier.CRITICAL_HITL,
        rationale: [violationDetail.message],
        violations: [violationDetail],
      };
    }
  }
}

/**
 * Standalone helper to evaluate a mandate against policy configuration.
 */
export function evaluatePolicy(
  context: SpendContext,
  config: PolicyConfig,
  options?: PolicyEngineOptions,
): PolicyEvaluationResult {
  return new PolicyEngine(config, options).evaluate(context);
}
