import { Money } from "@tessera/core";
import { describe, expect, it } from "vitest";
import {
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

    it("matches explicit wildcard patterns", () => {
      expect(isDomainWhitelisted("deals.target.com", ["*.target.com"])).toBe(true);
      expect(isDomainWhitelisted("target.com", ["*.target.com"])).toBe(true);
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

    it("prioritizes preferred merchants when specified", () => {
      const product = buildTestProduct("prod_mouse", "Logitech MX Master 3S", [
        { domain: "amazon.com", cents: 9999, inStock: true, days: 2 },
        { domain: "bestbuy.com", cents: 9999, inStock: true, days: 2 },
      ]);

      const result = optimizeQuote([product], {
        preferredMerchants: ["bestbuy.com"],
      });

      expect(result.optimalQuote?.merchantDomain).toBe("bestbuy.com");
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
  });
});
