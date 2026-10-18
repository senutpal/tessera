import { Money } from "@tessera/core";
import { parsePriceToMoney } from "../normalizer/catalogNormalizer.js";
import {
  Channel3ValidationError,
  type MandateQuoteConstraints,
  type ProcurementProduct,
  type ProcurementQuote,
  type QuoteEvaluationStatus,
  type QuoteOptimizationResult,
} from "../types/channel3.js";

/**
 * Parses budget constraints into a Money instance.
 * For integer numbers, treats them as minor units (cents) per AP2 protocol specification.
 * For decimal numbers or strings, treats them as standard currency amounts.
 */
export function parseBudgetConstraint(val: unknown, currency = "USD"): Money {
  if (val instanceof Money) {
    return val;
  }

  if (val === null || val === undefined) {
    throw new Channel3ValidationError("Budget value is null or undefined");
  }

  if (typeof val === "object") {
    if ("amount" in val && typeof (val as { amount: unknown }).amount === "number") {
      const amtObj = val as { amount: number; currency?: string };
      return Money.fromMinorUnits(amtObj.amount, amtObj.currency ?? currency);
    }
    return parsePriceToMoney(val, currency);
  }

  if (typeof val === "number") {
    if (!Number.isFinite(val) || Number.isNaN(val)) {
      throw new Channel3ValidationError(`Invalid numeric budget: ${val}`);
    }
    if (Number.isInteger(val)) {
      return Money.fromMinorUnits(val, currency);
    }
    return Money.fromDecimalString(val.toFixed(2), currency);
  }

  if (typeof val === "string") {
    return parsePriceToMoney(val, currency);
  }

  throw new Channel3ValidationError(`Unsupported budget representation: ${typeof val}`, { val });
}

/**
 * Checks if a candidate domain matches an allowed domain whitelist pattern.
 * Supports exact domain matches, subdomains (e.g. "store.nike.com" matches "nike.com"),
 * and explicit wildcards (e.g. "*.nike.com").
 */
export function isDomainWhitelisted(domain: string, allowedDomains: readonly string[]): boolean {
  if (!domain || typeof domain !== "string" || !allowedDomains || allowedDomains.length === 0) {
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

    // Default: exact match or subdomain of allowed pattern
    return normDomain === cleanPattern || normDomain.endsWith(`.${cleanPattern}`);
  });
}

/**
 * Extracts normalized MandateQuoteConstraints from various mandate structures or plain constraints.
 */
export function normalizeConstraints(
  constraints?: MandateQuoteConstraints | Record<string, unknown>,
): MandateQuoteConstraints {
  if (!constraints) {
    return {};
  }

  // If a mandate object is passed in { mandate: ... }
  const rawMandate =
    "mandate" in constraints && constraints.mandate && typeof constraints.mandate === "object"
      ? (constraints.mandate as Record<string, unknown>)
      : constraints;

  let maxBudget: Money | undefined;
  if ("maxBudget" in rawMandate && rawMandate.maxBudget != null) {
    maxBudget = parseBudgetConstraint(rawMandate.maxBudget);
  } else if ("max_amount" in rawMandate && rawMandate.max_amount != null) {
    maxBudget = parseBudgetConstraint(rawMandate.max_amount);
  } else if ("payment_amount" in rawMandate && rawMandate.payment_amount != null) {
    maxBudget = parseBudgetConstraint(rawMandate.payment_amount);
  } else if (
    "payment_parameters" in rawMandate &&
    rawMandate.payment_parameters &&
    typeof rawMandate.payment_parameters === "object"
  ) {
    const params = rawMandate.payment_parameters as Record<string, unknown>;
    if (params.maximum_amount != null) {
      maxBudget = parseBudgetConstraint(params.maximum_amount);
    } else if (params.max_amount != null) {
      maxBudget = parseBudgetConstraint(params.max_amount);
    }
  }

  const allowedDomains: string[] = [];
  if ("allowedDomains" in rawMandate && Array.isArray(rawMandate.allowedDomains)) {
    allowedDomains.push(...rawMandate.allowedDomains.map(String));
  } else if ("merchant_whitelist" in rawMandate && Array.isArray(rawMandate.merchant_whitelist)) {
    allowedDomains.push(...rawMandate.merchant_whitelist.map(String));
  } else if ("allowed_merchants" in rawMandate && Array.isArray(rawMandate.allowed_merchants)) {
    allowedDomains.push(...rawMandate.allowed_merchants.map(String));
  } else if ("payee" in rawMandate && rawMandate.payee && typeof rawMandate.payee === "object") {
    const payeeObj = rawMandate.payee as Record<string, unknown>;
    if (typeof payeeObj.merchant_id === "string") {
      allowedDomains.push(payeeObj.merchant_id);
    }
    if (typeof payeeObj.domain === "string") {
      allowedDomains.push(payeeObj.domain);
    }
    if (typeof payeeObj.website === "string") {
      try {
        const u = new URL(payeeObj.website);
        allowedDomains.push(u.hostname.replace(/^www\./, ""));
      } catch {
        allowedDomains.push(payeeObj.website);
      }
    }
  }

  let maxDeliveryDays: number | undefined;
  if ("maxDeliveryDays" in rawMandate && typeof rawMandate.maxDeliveryDays === "number") {
    maxDeliveryDays = rawMandate.maxDeliveryDays;
  } else if (
    "delivery_sla_days" in rawMandate &&
    typeof rawMandate.delivery_sla_days === "number"
  ) {
    maxDeliveryDays = rawMandate.delivery_sla_days;
  } else if (
    "max_delivery_days" in rawMandate &&
    typeof rawMandate.max_delivery_days === "number"
  ) {
    maxDeliveryDays = rawMandate.max_delivery_days;
  }

  const preferredMerchants: string[] = [];
  if ("preferredMerchants" in rawMandate && Array.isArray(rawMandate.preferredMerchants)) {
    preferredMerchants.push(...rawMandate.preferredMerchants.map(String));
  }

  const requireInStock =
    "requireInStock" in rawMandate && typeof rawMandate.requireInStock === "boolean"
      ? rawMandate.requireInStock
      : true;

  const currency =
    "currency" in rawMandate && typeof rawMandate.currency === "string"
      ? rawMandate.currency
      : maxBudget?.currency;

  return {
    maxBudget,
    currency,
    allowedDomains: allowedDomains.length > 0 ? allowedDomains : undefined,
    maxDeliveryDays,
    preferredMerchants: preferredMerchants.length > 0 ? preferredMerchants : undefined,
    requireInStock,
  };
}

/**
 * Optimizes vendor quotation by evaluating candidate products against mandate constraints,
 * ranking candidates by price and delivery speed, and selecting the optimal procurement quote.
 */
export function optimizeQuote(
  products: ProcurementProduct[],
  rawConstraints?: MandateQuoteConstraints | Record<string, unknown>,
): QuoteOptimizationResult {
  const constraints = normalizeConstraints(rawConstraints);
  const now = new Date().toISOString();

  const candidateQuotes: ProcurementQuote[] = [];

  for (const product of products) {
    for (const offer of product.offers) {
      const rejectionReasons: string[] = [];
      let status: QuoteEvaluationStatus = "ELIGIBLE";

      // 1. Availability constraint
      if (constraints.requireInStock !== false && !offer.inStock) {
        status = "OUT_OF_STOCK";
        rejectionReasons.push("Product offer is currently out of stock");
      }

      // 2. Merchant reputation / whitelist constraint
      if (
        status === "ELIGIBLE" &&
        constraints.allowedDomains &&
        constraints.allowedDomains.length > 0
      ) {
        const isWhitelisted = isDomainWhitelisted(offer.merchantDomain, constraints.allowedDomains);
        if (!isWhitelisted) {
          status = "DISALLOWED_MERCHANT";
          rejectionReasons.push(
            `Merchant domain "${offer.merchantDomain}" is not in mandate allowed whitelist`,
          );
        }
      }

      // 3. Delivery SLA constraint
      if (
        status === "ELIGIBLE" &&
        constraints.maxDeliveryDays != null &&
        offer.estimatedDeliveryDays > constraints.maxDeliveryDays
      ) {
        status = "SLA_BREACH";
        rejectionReasons.push(
          `Estimated delivery of ${offer.estimatedDeliveryDays} days breaches SLA limit of ${constraints.maxDeliveryDays} days`,
        );
      }

      // 4. Budget cap constraint
      if (status === "ELIGIBLE" && constraints.maxBudget != null) {
        const budgetMoney = parseBudgetConstraint(constraints.maxBudget, offer.price.currency);
        if (offer.price.greaterThan(budgetMoney)) {
          status = "EXCEEDS_BUDGET";
          rejectionReasons.push(
            `Price ${offer.price.toString()} exceeds mandate budget cap of ${budgetMoney.toString()}`,
          );
        }
      }

      const quoteId = `quote_${product.id}_${offer.merchantDomain.replace(/[^a-z0-9]/g, "_")}`;

      candidateQuotes.push({
        quoteId,
        productId: product.id,
        productTitle: product.title,
        brand: product.brand,
        merchantDomain: offer.merchantDomain,
        productUrl: offer.productUrl,
        price: offer.price,
        compareAtPrice: offer.compareAtPrice,
        estimatedDeliveryDays: offer.estimatedDeliveryDays,
        shippingDurationIso: offer.shippingDurationIso,
        inStock: offer.inStock,
        status,
        rejectionReasons,
        rank: 0,
        score: 0,
        selected: false,
        timestamp: now,
      });
    }
  }

  // Split eligible vs rejected
  const eligible = candidateQuotes.filter((q) => q.status === "ELIGIBLE");
  const rejected = candidateQuotes.filter((q) => q.status !== "ELIGIBLE");

  // Determine min and max prices among eligible for score calculation
  const eligiblePrices = eligible.map((q) => q.price.toMinorUnits());
  const minPrice = eligiblePrices.length > 0 ? Math.min(...eligiblePrices) : 0;
  const maxPrice = eligiblePrices.length > 0 ? Math.max(...eligiblePrices) : 1;

  // Sorting comparator for eligible quotes:
  // 1. Preferred merchant bonus
  // 2. Lowest price
  // 3. Fastest delivery speed
  eligible.sort((a, b) => {
    const aPreferred = constraints.preferredMerchants?.includes(a.merchantDomain) ? 1 : 0;
    const bPreferred = constraints.preferredMerchants?.includes(b.merchantDomain) ? 1 : 0;
    if (aPreferred !== bPreferred) {
      return bPreferred - aPreferred;
    }

    const priceDiff = a.price.toMinorUnits() - b.price.toMinorUnits();
    if (priceDiff !== 0) {
      return priceDiff;
    }

    return a.estimatedDeliveryDays - b.estimatedDeliveryDays;
  });

  // Calculate scores (0 - 100)
  for (const quote of eligible) {
    let score = 70; // baseline eligible score
    if (maxPrice > minPrice) {
      const priceFactor = (maxPrice - quote.price.toMinorUnits()) / (maxPrice - minPrice);
      score += Math.round(priceFactor * 20); // up to +20 points for price
    } else {
      score += 20;
    }

    // Faster delivery bonus (up to +10 points)
    if (quote.estimatedDeliveryDays <= 2) {
      score += 10;
    } else if (quote.estimatedDeliveryDays <= 5) {
      score += 5;
    }

    // Preferred merchant bonus
    if (constraints.preferredMerchants?.includes(quote.merchantDomain)) {
      score = Math.min(100, score + 10);
    }

    quote.score = Math.min(100, score);
  }

  // Sort rejected quotes by lowest price
  rejected.sort((a, b) => a.price.toMinorUnits() - b.price.toMinorUnits());
  for (const quote of rejected) {
    quote.score = 0;
  }

  // Combine and assign 1-based ranks
  const ranked = [...eligible, ...rejected];
  for (let i = 0; i < ranked.length; i++) {
    const item = ranked[i];
    if (item) {
      item.rank = i + 1;
    }
  }

  let optimalQuote: ProcurementQuote | null = null;
  if (eligible.length > 0 && eligible[0]) {
    eligible[0].selected = true;
    optimalQuote = eligible[0];
  }

  const summary = optimalQuote
    ? `Selected optimal quote from ${optimalQuote.merchantDomain} for ${optimalQuote.price.toString()} (${optimalQuote.estimatedDeliveryDays}d SLA, score: ${optimalQuote.score}) among ${candidateQuotes.length} candidates.`
    : `No eligible quote found among ${candidateQuotes.length} candidate offers. ${rejected.length} offers rejected by mandate constraints.`;

  return {
    quotes: ranked,
    optimalQuote,
    totalCandidates: candidateQuotes.length,
    eligibleCount: eligible.length,
    rejectedCount: rejected.length,
    summary,
  };
}
