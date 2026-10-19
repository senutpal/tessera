import { Money } from "@tessera/core";
import { describe, expect, it } from "vitest";
import {
  Channel3ValidationError,
  normalizeDomain,
  normalizeOffer,
  normalizeProduct,
  normalizeSearchResults,
  type ProductOfferWire,
  type ProductSummaryWire,
  parsePriceToMoney,
  parseShippingEstimate,
} from "../index.js";

describe("Catalog Normalizer & Canonical Representation", () => {
  describe("parsePriceToMoney", () => {
    it("converts float numbers into integer minor units (Money)", () => {
      const money = parsePriceToMoney(199.99);
      expect(money).toBeInstanceOf(Money);
      expect(money.toMinorUnits()).toBe(19999);
      expect(money.currency).toBe("USD");
      expect(money.toDecimalString()).toBe("199.99");
    });

    it("converts whole numbers into minor units", () => {
      const money = parsePriceToMoney(200);
      expect(money.toMinorUnits()).toBe(20000);
      expect(money.toDecimalString()).toBe("200.00");
    });

    it("converts dollar strings into integer minor units", () => {
      const m1 = parsePriceToMoney("$199.99");
      expect(m1.toMinorUnits()).toBe(19999);
      expect(m1.currency).toBe("USD");

      const m2 = parsePriceToMoney("$ 1,299.50");
      expect(m2.toMinorUnits()).toBe(129950);
      expect(m2.currency).toBe("USD");
    });

    it("detects currency symbols and codes in string representations", () => {
      const eur = parsePriceToMoney("€149.50");
      expect(eur.currency).toBe("EUR");
      expect(eur.toMinorUnits()).toBe(14950);

      const gbp = parsePriceToMoney("£89.99");
      expect(gbp.currency).toBe("GBP");
      expect(gbp.toMinorUnits()).toBe(8999);

      const cad = parsePriceToMoney("CAD 75.00");
      expect(cad.currency).toBe("CAD");
      expect(cad.toMinorUnits()).toBe(7500);

      const cadSymbol = parsePriceToMoney("C$199.99");
      expect(cadSymbol.currency).toBe("CAD");
      expect(cadSymbol.toMinorUnits()).toBe(19999);

      const audSymbol = parsePriceToMoney("A$50.00");
      expect(audSymbol.currency).toBe("AUD");
      expect(audSymbol.toMinorUnits()).toBe(5000);
    });

    it("parses Channel3 PriceWire object structures", () => {
      const money = parsePriceToMoney({
        currency: "USD",
        price: 349.99,
        compare_at_price: 399.99,
      });
      expect(money.toMinorUnits()).toBe(34999);
      expect(money.currency).toBe("USD");
    });

    it("parses AP2 minor-unit amount objects", () => {
      const money = parsePriceToMoney({ amount: 24999, currency: "USD" });
      expect(money.toMinorUnits()).toBe(24999);
      expect(money.currency).toBe("USD");
    });

    it("parses PayPal amount objects", () => {
      const money = parsePriceToMoney({ value: "49.95", currency_code: "USD" });
      expect(money.toMinorUnits()).toBe(4995);
      expect(money.currency).toBe("USD");
    });

    it("passes Money instances through unchanged", () => {
      const orig = Money.fromMinorUnits(5000, "USD");
      const result = parsePriceToMoney(orig);
      expect(result).toBe(orig);
    });

    it("throws Channel3ValidationError on invalid price inputs and negative amounts", () => {
      expect(() => parsePriceToMoney(null)).toThrow(Channel3ValidationError);
      expect(() => parsePriceToMoney(undefined)).toThrow(Channel3ValidationError);
      expect(() => parsePriceToMoney("")).toThrow(Channel3ValidationError);
      expect(() => parsePriceToMoney("free")).toThrow(Channel3ValidationError);
      expect(() => parsePriceToMoney(NaN)).toThrow(Channel3ValidationError);
      expect(() => parsePriceToMoney(Infinity)).toThrow(Channel3ValidationError);
      expect(() => parsePriceToMoney(-50)).toThrow(Channel3ValidationError);
      expect(() => parsePriceToMoney("-19.99")).toThrow(Channel3ValidationError);
      expect(() => parsePriceToMoney("-$50.00")).toThrow(Channel3ValidationError);
      expect(() => parsePriceToMoney({ amount: -100, currency: "USD" })).toThrow(
        Channel3ValidationError,
      );
      expect(() => parsePriceToMoney({ value: "-10.00", currency_code: "USD" })).toThrow(
        Channel3ValidationError,
      );
    });
  });

  describe("parseShippingEstimate", () => {
    it("handles ISO 8601 duration strings directly", () => {
      expect(parseShippingEstimate("P2D")).toEqual({ days: 2, isoDuration: "P2D" });
      expect(parseShippingEstimate("p5d")).toEqual({ days: 5, isoDuration: "P5D" });
      expect(parseShippingEstimate("P1W")).toEqual({ days: 7, isoDuration: "P7D" });
      expect(parseShippingEstimate("p2w")).toEqual({ days: 14, isoDuration: "P14D" });
    });

    it("normalizes range estimates by taking the upper SLA bound", () => {
      expect(parseShippingEstimate("3-5 business days")).toEqual({ days: 5, isoDuration: "P5D" });
      expect(parseShippingEstimate("1 to 3 days")).toEqual({ days: 3, isoDuration: "P3D" });
      expect(parseShippingEstimate("5-7 days")).toEqual({ days: 7, isoDuration: "P7D" });
      expect(parseShippingEstimate("1-2 weeks")).toEqual({ days: 14, isoDuration: "P14D" });
      expect(parseShippingEstimate("2 weeks")).toEqual({ days: 14, isoDuration: "P14D" });
    });

    it("normalizes common expedited speed phrases", () => {
      expect(parseShippingEstimate("Same Day Delivery")).toEqual({ days: 1, isoDuration: "P1D" });
      expect(parseShippingEstimate("Next day delivery")).toEqual({ days: 1, isoDuration: "P1D" });
      expect(parseShippingEstimate("Overnight")).toEqual({ days: 1, isoDuration: "P1D" });
      expect(parseShippingEstimate("get it tomorrow")).toEqual({ days: 1, isoDuration: "P1D" });
      expect(parseShippingEstimate("2-day shipping")).toEqual({ days: 2, isoDuration: "P2D" });
      expect(parseShippingEstimate("Express")).toEqual({ days: 2, isoDuration: "P2D" });
    });

    it("normalizes standard and economy categories", () => {
      expect(parseShippingEstimate("Standard shipping")).toEqual({ days: 5, isoDuration: "P5D" });
      expect(parseShippingEstimate("Economy ground")).toEqual({ days: 7, isoDuration: "P7D" });
    });

    it("defaults gracefully when shipping is missing or unrecognizable", () => {
      expect(parseShippingEstimate(undefined)).toEqual({ days: 5, isoDuration: "P5D" });
      expect(parseShippingEstimate("")).toEqual({ days: 5, isoDuration: "P5D" });
      expect(parseShippingEstimate("call for quote")).toEqual({ days: 5, isoDuration: "P5D" });
    });
  });

  describe("normalizeDomain", () => {
    it("cleans URLs, stripping protocol, path, query, and www prefix", () => {
      expect(normalizeDomain("https://www.bestbuy.com/site/deal")).toBe("bestbuy.com");
      expect(normalizeDomain("http://store.nike.com/checkout?id=1")).toBe("store.nike.com");
      expect(normalizeDomain("WWW.AMAZON.COM")).toBe("amazon.com");
      expect(normalizeDomain("target.com:443/item")).toBe("target.com");
    });

    it("throws Channel3ValidationError on invalid domain formats", () => {
      expect(() => normalizeDomain("")).toThrow(Channel3ValidationError);
      expect(() => normalizeDomain("localhost")).toThrow(Channel3ValidationError);
      expect(() => normalizeDomain("not-a-domain")).toThrow(Channel3ValidationError);
    });
  });

  describe("normalizeOffer and normalizeProduct", () => {
    it("normalizes a raw offer with price, shipping, and availability", () => {
      const rawOffer: ProductOfferWire = {
        availability: "InStock",
        domain: "https://www.bhphotovideo.com/c/product/123",
        price: { currency: "USD", price: 129.99, compare_at_price: 149.99 },
        url: "https://bhphotovideo.com/c/product/123",
        shipping: "2-3 business days",
      };

      const offer = normalizeOffer(rawOffer, "prod_cam_1");
      expect(offer.offerId).toBe("prod_cam_1:bhphotovideo.com");
      expect(offer.merchantDomain).toBe("bhphotovideo.com");
      expect(offer.price.toMinorUnits()).toBe(12999);
      expect(offer.compareAtPrice?.toMinorUnits()).toBe(14999);
      expect(offer.inStock).toBe(true);
      expect(offer.shippingDurationIso).toBe("P3D");
      expect(offer.estimatedDeliveryDays).toBe(3);
    });

    it("identifies leadOffer as the lowest in-stock offer among multiple retailers", () => {
      const rawProduct: ProductSummaryWire = {
        id: "prod_macbook_m3",
        title: "Apple MacBook Pro 14 M3",
        brands: [{ id: "brand_apple", name: "Apple" }],
        images: [{ url: "https://cdn.trychannel3.com/macbook.jpg" }],
        offers: [
          {
            availability: "OutOfStock",
            domain: "walmart.com",
            price: { currency: "USD", price: 1499.0 },
            url: "https://walmart.com/deal",
            shipping: "3-5 days",
          },
          {
            availability: "InStock",
            domain: "bestbuy.com",
            price: { currency: "USD", price: 1599.0 },
            url: "https://bestbuy.com/deal",
            shipping: "2 days",
          },
          {
            availability: "InStock",
            domain: "bhphotovideo.com",
            price: { currency: "USD", price: 1549.0 },
            url: "https://bhphotovideo.com/deal",
            shipping: "Next day",
          },
        ],
      };

      const product = normalizeProduct(rawProduct);
      expect(product.id).toBe("prod_macbook_m3");
      expect(product.brand).toBe("Apple");
      expect(product.imageUrl).toBe("https://cdn.trychannel3.com/macbook.jpg");
      expect(product.offers).toHaveLength(3);

      // Lead offer should be bhphotovideo at $1549.00 because walmart ($1499) is OutOfStock
      expect(product.leadOffer?.merchantDomain).toBe("bhphotovideo.com");
      expect(product.lowestPrice?.toMinorUnits()).toBe(154900);
    });

    it("normalizes an array of products from SearchProductsResultWire", () => {
      const products = normalizeSearchResults([
        {
          id: "prod_mouse",
          title: "Logitech MX Master 3S",
          offers: [
            {
              availability: "InStock",
              domain: "amazon.com",
              price: { currency: "USD", price: 99.99 },
              url: "https://amazon.com/mx-master",
            },
          ],
        },
      ]);

      expect(products).toHaveLength(1);
      expect(products[0]?.offers[0]?.price.toMinorUnits()).toBe(9999);
    });

    it("distinguishes multiple offers from the same merchant and preserves condition", () => {
      const rawProduct: ProductSummaryWire = {
        id: "prod_headphone",
        title: "Bose QC45",
        offers: [
          {
            availability: "InStock",
            domain: "amazon.com",
            price: { currency: "USD", price: 279.0 },
            url: "https://amazon.com/dp/new",
            condition: "new",
          },
          {
            availability: "InStock",
            domain: "amazon.com",
            price: { currency: "USD", price: 219.0 },
            url: "https://amazon.com/dp/refurb",
            condition: "refurbished",
          },
        ],
      };

      const product = normalizeProduct(rawProduct);
      expect(product.offers).toHaveLength(2);
      expect(product.offers[0]?.offerId).not.toBe(product.offers[1]?.offerId);
      expect(product.offers[0]?.condition).toBe("new");
      expect(product.offers[1]?.condition).toBe("refurbished");
      expect(product.offers[0]?.offerId).toBe("prod_headphone:amazon.com:new:0");
      expect(product.offers[1]?.offerId).toBe("prod_headphone:amazon.com:refurbished:1");
    });

    it("isolates failures from malformed offers so valid offers survive", () => {
      const rawProduct: ProductSummaryWire = {
        id: "prod_mixed",
        title: "Mixed Offers Product",
        offers: [
          {
            availability: "InStock",
            domain: "not-a-valid-domain",
            price: { currency: "USD", price: 50.0 },
            url: "https://bad.com/item",
          },
          {
            availability: "InStock",
            domain: "bestbuy.com",
            price: { currency: "USD", price: -10.0 },
            url: "https://bestbuy.com/deal",
          },
          {
            availability: "InStock",
            domain: "bestbuy.com",
            price: { currency: "USD", price: 79.99 },
            url: "https://bestbuy.com/valid",
          },
        ],
      };

      const product = normalizeProduct(rawProduct);
      expect(product.offers).toHaveLength(1);
      expect(product.offers[0]?.merchantDomain).toBe("bestbuy.com");
      expect(product.offers[0]?.price.toMinorUnits()).toBe(7999);
      expect(product.leadOffer?.price.toMinorUnits()).toBe(7999);
    });
  });
});
