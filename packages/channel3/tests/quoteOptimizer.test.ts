import { Money } from "@tessera/core";
import { describe, expect, it } from "vitest";
import {
  Channel3ValidationError,
  isDomainWhitelisted,
  normalizeConstraints,
  optimizeQuote,
  type ProcurementProduct,
} from "../index.js";

function buildTestProduct(
  id: string,
  title: string,
  offers: Array<{
    domain: string;
    cents: number;
    inStock?: boolean;
    days?: number;
    compareAtCents?: number;
  }>,
): ProcurementProduct {
  return {
    id,
    title,
    offers: offers.map((o) => ({
      offerId: `${id}:${o.domain}`,
      merchantDomain: o.domain,
      productUrl: `https://${o.domain}/item/${id}`,
      price: Money.fromMinorUnits(o.cents, "USD"),
      compareAtPrice: o.compareAtCents ? Money.fromMinorUnits(o.compareAtCents, "USD") : undefined,
      inStock: o.inStock ?? true,
      shippingDurationIso: `P${o.days ?? 3}D`,
      estimatedDeliveryDays: o.days ?? 3,
    })),
  };
}

describe("Autonomous Quote Optimizer", () => {
  describe("isDomainWhitelisted", () => {
    it("matches exact domain", () => {
      expect(isDomainWhitelisted("bestbuy.com", ["bestbuy.com", "amazon.com"])).toBe(true);
      expect(isDomainWhitelisted("walmart.com", ["bestbuy.com", "amazon.com"])).toBe(false);
    });

    it("matches subdomains of allowed domain", () => {
      expect(isDomainWhitelisted("store.nike.com", ["nike.com"])).toBe(true);
      expect(isDomainWhitelisted("us.shop.adidas.com", ["adidas.com"])).toBe(true);
      expect(isDomainWhitelisted("fake-nike.com", ["nike.com"])).toBe(false);
    });

    it("matches explicit wildcard patterns and universal wildcards", () => {
      expect(isDomainWhitelisted("deals.target.com", ["*.target.com"])).toBe(true);
      expect(isDomainWhitelisted("target.com", ["*.target.com"])).toBe(true);
      expect(isDomainWhitelisted("nike.com", ["*"])).toBe(true);
      expect(isDomainWhitelisted("nike.com", ["all"])).toBe(true);
    });

    it("normalizes protocol, www, and URL paths when comparing whitelist patterns", () => {
      expect(isDomainWhitelisted("nike.com", ["https://www.nike.com"])).toBe(true);
      expect(isDomainWhitelisted("nike.com", ["www.nike.com"])).toBe(true);
      expect(isDomainWhitelisted("https://www.nike.com/shoes", ["nike.com"])).toBe(true);
    });
  });

  describe("optimizeQuote vendor selection", () => {
    it("selects lowest-cost in-stock offer satisfying SLA and whitelist", () => {
      const product = buildTestProduct("prod_keyboard", "Keychron Q1 Pro", [
        { domain: "bestbuy.com", cents: 21900, inStock: true, days: 2 },
        { domain: "amazon.com", cents: 19900, inStock: true, days: 3 },
        { domain: "keychron.com", cents: 18900, inStock: true, days: 7 }, // violates SLA if maxDeliveryDays=5
      ]);

      const result = optimizeQuote([product], {
        maxBudget: 25000, // $250.00
        allowedDomains: ["amazon.com", "bestbuy.com", "keychron.com"],
        maxDeliveryDays: 5,
      });

      expect(result.totalCandidates).toBe(3);
      expect(result.eligibleCount).toBe(2);
      expect(result.optimalQuote).not.toBeNull();
      // keychron was $189 but delivery is 7 days > 5d SLA
      // amazon is $199 with 3 days <= 5d SLA
      expect(result.optimalQuote?.merchantDomain).toBe("amazon.com");
      expect(result.optimalQuote?.price.toMinorUnits()).toBe(19900);
      expect(result.optimalQuote?.status).toBe("ELIGIBLE");
      expect(result.optimalQuote?.selected).toBe(true);
      expect(result.optimalQuote?.rank).toBe(1);

      // Verify keychron offer was flagged for SLA breach
      const keychronQuote = result.quotes.find((q) => q.merchantDomain === "keychron.com");
      expect(keychronQuote?.status).toBe("SLA_BREACH");
      expect(keychronQuote?.rejectionReasons[0]).toContain("breaches SLA limit");
    });

    it("filters out out-of-stock items", () => {
      const product = buildTestProduct("prod_gpu", "NVIDIA RTX 4080 Super", [
        { domain: "microcenter.com", cents: 99900, inStock: false, days: 2 },
        { domain: "newegg.com", cents: 104900, inStock: true, days: 3 },
      ]);

      const result = optimizeQuote([product], {
        maxBudget: 120000,
        allowedDomains: ["microcenter.com", "newegg.com"],
      });

      expect(result.optimalQuote?.merchantDomain).toBe("newegg.com");
      const mcQuote = result.quotes.find((q) => q.merchantDomain === "microcenter.com");
      expect(mcQuote?.status).toBe("OUT_OF_STOCK");
      expect(mcQuote?.selected).toBe(false);
    });

    it("flags candidate offers exceeding mandate budget cap", () => {
      const product = buildTestProduct("prod_monitor", "Dell UltraSharp 32 4K", [
        { domain: "dell.com", cents: 79900, inStock: true, days: 3 },
        { domain: "bhphotovideo.com", cents: 74900, inStock: true, days: 2 },
      ]);

      const result = optimizeQuote([product], {
        maxBudget: 75000, // $750.00
      });

      expect(result.optimalQuote?.merchantDomain).toBe("bhphotovideo.com");

      const dellQuote = result.quotes.find((q) => q.merchantDomain === "dell.com");
      expect(dellQuote?.status).toBe("EXCEEDS_BUDGET");
      expect(dellQuote?.rejectionReasons[0]).toContain("exceeds mandate budget cap");
    });

    it("flags candidate offers from merchants not in mandate whitelist", () => {
      const product = buildTestProduct("prod_phone", "Pixel 9 Pro", [
        { domain: "unverified-retailer.com", cents: 89900, inStock: true, days: 2 },
        { domain: "store.google.com", cents: 99900, inStock: true, days: 3 },
      ]);

      const result = optimizeQuote([product], {
        allowedDomains: ["google.com"],
      });

      expect(result.optimalQuote?.merchantDomain).toBe("store.google.com");

      const unverified = result.quotes.find((q) => q.merchantDomain === "unverified-retailer.com");
      expect(unverified?.status).toBe("DISALLOWED_MERCHANT");
      expect(unverified?.rejectionReasons[0]).toContain("not in mandate allowed whitelist");
    });

    it("prioritizes preferred merchants when specified (supporting case and url normalization)", () => {
      const product = buildTestProduct("prod_mouse", "Logitech MX Master 3S", [
        { domain: "amazon.com", cents: 9999, inStock: true, days: 2 },
        { domain: "bestbuy.com", cents: 9999, inStock: true, days: 2 },
      ]);

      const result = optimizeQuote([product], {
        preferredMerchants: ["BestBuy.com"],
      });

      expect(result.optimalQuote?.merchantDomain).toBe("bestbuy.com");

      const resultUrl = optimizeQuote([product], {
        preferredMerchants: ["https://www.bestbuy.com"],
      });
      expect(resultUrl.optimalQuote?.merchantDomain).toBe("bestbuy.com");
    });

    it("rejects offers with mismatched currencies without throwing unhandled errors", () => {
      const product: ProcurementProduct = {
        id: "prod_intl",
        title: "International Item",
        offers: [
          {
            offerId: "prod_intl:amazon.co.uk",
            merchantDomain: "amazon.co.uk",
            productUrl: "https://amazon.co.uk/item",
            price: Money.fromMinorUnits(5000, "GBP"),
            inStock: true,
            shippingDurationIso: "P2D",
            estimatedDeliveryDays: 2,
          },
          {
            offerId: "prod_intl:amazon.com",
            merchantDomain: "amazon.com",
            productUrl: "https://amazon.com/item",
            price: Money.fromMinorUnits(7000, "USD"),
            inStock: true,
            shippingDurationIso: "P2D",
            estimatedDeliveryDays: 2,
          },
        ],
      };

      const result = optimizeQuote([product], {
        maxBudget: Money.fromMinorUnits(10000, "USD"),
      });

      expect(result.optimalQuote?.merchantDomain).toBe("amazon.com");
      const gbpQuote = result.quotes.find((q) => q.merchantDomain === "amazon.co.uk");
      expect(gbpQuote?.status).toBe("CURRENCY_MISMATCH");
      expect(gbpQuote?.rejectionReasons[0]).toContain("does not match");
    });

    it("throws Channel3ValidationError on negative budget constraints", () => {
      const product = buildTestProduct("prod_budget", "Item", [
        { domain: "bestbuy.com", cents: 5000, inStock: true, days: 2 },
      ]);

      expect(() =>
        optimizeQuote([product], {
          maxBudget: -100,
        }),
      ).toThrow(Channel3ValidationError);

      expect(() =>
        optimizeQuote([product], {
          maxBudget: { amount: -5000, currency: "USD" },
        }),
      ).toThrow(Channel3ValidationError);
    });

    it("flags candidate offers with invalid negative prices as ineligible", () => {
      const product: ProcurementProduct = {
        id: "prod_exploit",
        title: "Exploit Product",
        offers: [
          {
            offerId: "prod_exploit:sketchy.com",
            merchantDomain: "sketchy.com",
            productUrl: "https://sketchy.com/deal",
            price: Money.fromMinorUnits(-5000, "USD"),
            inStock: true,
            shippingDurationIso: "P1D",
            estimatedDeliveryDays: 1,
          },
          {
            offerId: "prod_exploit:legit.com",
            merchantDomain: "legit.com",
            productUrl: "https://legit.com/deal",
            price: Money.fromMinorUnits(5000, "USD"),
            inStock: true,
            shippingDurationIso: "P2D",
            estimatedDeliveryDays: 2,
          },
        ],
      };

      const result = optimizeQuote([product], {});
      expect(result.optimalQuote?.merchantDomain).toBe("legit.com");
      const sketchyQuote = result.quotes.find((q) => q.merchantDomain === "sketchy.com");
      expect(sketchyQuote?.status).toBe("EXCEEDS_BUDGET");
      expect(sketchyQuote?.rejectionReasons[0]).toContain("negative price");
    });

    it("extracts constraints from an AP2 Mandate object structure", () => {
      const mockCheckoutMandate = {
        vct: "mandate.checkout.1",
        payment_parameters: {
          maximum_amount: { amount: 30000, currency: "USD" },
        },
        merchant_whitelist: ["amazon.com", "target.com"],
        delivery_sla_days: 4,
      };

      const constraints = normalizeConstraints({ mandate: mockCheckoutMandate });
      expect(constraints.maxBudget).toBeInstanceOf(Money);
      expect((constraints.maxBudget as Money).toMinorUnits()).toBe(30000);
      expect(constraints.allowedDomains).toEqual(["amazon.com", "target.com"]);
      expect(constraints.maxDeliveryDays).toBe(4);

      const product = buildTestProduct("prod_audio", "Bose QC Ultra", [
        { domain: "amazon.com", cents: 29900, inStock: true, days: 2 },
        { domain: "walmart.com", cents: 28900, inStock: true, days: 2 }, // not in whitelist
      ]);

      const result = optimizeQuote([product], { mandate: mockCheckoutMandate });
      expect(result.optimalQuote?.merchantDomain).toBe("amazon.com");
    });

    it("returns null optimalQuote when no candidate satisfies constraints", () => {
      const product = buildTestProduct("prod_tv", "OLED 65 Inch", [
        { domain: "bestbuy.com", cents: 180000, inStock: true, days: 2 },
      ]);

      const result = optimizeQuote([product], {
        maxBudget: 150000, // $1500 < $1800
      });

      expect(result.optimalQuote).toBeNull();
      expect(result.eligibleCount).toBe(0);
      expect(result.rejectedCount).toBe(1);
      expect(result.summary).toContain("No eligible quote found");
    });

    it("throws Channel3ValidationError on fractional or non-safe integer budget amounts", () => {
      const product = buildTestProduct("prod_budget_float", "Item", [
        { domain: "bestbuy.com", cents: 5000, inStock: true, days: 2 },
      ]);

      expect(() =>
        optimizeQuote([product], {
          maxBudget: 25.5,
        }),
      ).toThrow(Channel3ValidationError);

      expect(() =>
        optimizeQuote([product], {
          maxBudget: Number.MAX_SAFE_INTEGER + 10,
        }),
      ).toThrow(Channel3ValidationError);
    });

    it("evaluates numeric budget in mandate currency when currency is specified", () => {
      const product: ProcurementProduct = {
        id: "prod_eur",
        title: "European Product",
        offers: [
          {
            offerId: "prod_eur:fnac.fr",
            merchantDomain: "fnac.fr",
            productUrl: "https://fnac.fr/item",
            price: Money.fromMinorUnits(45000, "EUR"), // €450.00
            inStock: true,
            shippingDurationIso: "P2D",
            estimatedDeliveryDays: 2,
          },
          {
            offerId: "prod_eur:amazon.de",
            merchantDomain: "amazon.de",
            productUrl: "https://amazon.de/item",
            price: Money.fromMinorUnits(55000, "EUR"), // €550.00 (exceeds €500 budget)
            inStock: true,
            shippingDurationIso: "P2D",
            estimatedDeliveryDays: 2,
          },
        ],
      };

      const result = optimizeQuote([product], {
        mandate: {
          maxBudget: 50000, // 50000 cents in EUR = €500.00
          currency: "EUR",
        },
      });

      expect(result.optimalQuote?.merchantDomain).toBe("fnac.fr");
      expect(result.optimalQuote?.price.currency).toBe("EUR");
      expect(result.optimalQuote?.price.toMinorUnits()).toBe(45000);
      const amazonQuote = result.quotes.find((q) => q.merchantDomain === "amazon.de");
      expect(amazonQuote?.status).toBe("EXCEEDS_BUDGET");
    });

    it("rejects all merchants when an empty whitelist is explicitly declared", () => {
      const product = buildTestProduct("prod_whitelist", "Item", [
        { domain: "bestbuy.com", cents: 5000, inStock: true, days: 2 },
      ]);

      const resultEmptyAllowed = optimizeQuote([product], {
        allowedDomains: [],
      });
      expect(resultEmptyAllowed.optimalQuote).toBeNull();
      expect(resultEmptyAllowed.rejectedCount).toBe(1);
      expect(resultEmptyAllowed.quotes[0]?.status).toBe("DISALLOWED_MERCHANT");

      const resultEmptyMandate = optimizeQuote([product], {
        mandate: {
          merchant_whitelist: [],
        },
      });
      expect(resultEmptyMandate.optimalQuote).toBeNull();
      expect(resultEmptyMandate.rejectedCount).toBe(1);
      expect(resultEmptyMandate.quotes[0]?.status).toBe("DISALLOWED_MERCHANT");
    });

    it("generates distinct quoteIds for hyphenated vs dotted domains and multiple offers from same merchant", () => {
      const product: ProcurementProduct = {
        id: "prod_distinct",
        title: "Distinct Quotes Test",
        offers: [
          {
            offerId: "prod_distinct:a-b.com:0",
            merchantDomain: "a-b.com",
            productUrl: "https://a-b.com/item",
            price: Money.fromMinorUnits(5000, "USD"),
            inStock: true,
            shippingDurationIso: "P2D",
            estimatedDeliveryDays: 2,
          },
          {
            offerId: "prod_distinct:a.b.com:1",
            merchantDomain: "a.b.com",
            productUrl: "https://a.b.com/item",
            price: Money.fromMinorUnits(6000, "USD"),
            inStock: true,
            shippingDurationIso: "P2D",
            estimatedDeliveryDays: 2,
          },
          {
            offerId: "prod_distinct:a.b.com:refurbished:2",
            merchantDomain: "a.b.com",
            productUrl: "https://a.b.com/item-refurb",
            price: Money.fromMinorUnits(4000, "USD"),
            condition: "refurbished",
            inStock: true,
            shippingDurationIso: "P2D",
            estimatedDeliveryDays: 2,
          },
        ],
      };

      const result = optimizeQuote([product], {});
      const quoteIds = result.quotes.map((q) => q.quoteId);
      const uniqueQuoteIds = new Set(quoteIds);
      expect(uniqueQuoteIds.size).toBe(quoteIds.length);
      expect(quoteIds).toContain("quote_prod_distinct_a-b_com_0");
      expect(quoteIds).toContain("quote_prod_distinct_a_b_com_1");
      expect(quoteIds).toContain("quote_prod_distinct_a_b_com_refurbished_2");
    });
  });
});
