import { describe, expect, it } from "vitest";
import { DomainError, Money } from "../index.js";

describe("Money Value Object", () => {
  describe("Creation and Conversion", () => {
    it("creates money from integer minor units (cents)", () => {
      const money = Money.fromMinorUnits(24999, "USD");
      expect(money.amount).toBe(24999);
      expect(money.currency).toBe("USD");
      expect(money.toDecimalString()).toBe("249.99");
      expect(money.toMinorUnits()).toBe(24999);
    });

    it("creates money from decimal string safely without floating point drift", () => {
      const money = Money.fromDecimalString("249.99", "USD");
      expect(money.amount).toBe(24999);
      expect(money.toDecimalString()).toBe("249.99");

      // Known IEEE 754 precision trap: 10.99 * 100 in float is 1099.0000000000002
      const trap1 = Money.fromDecimalString("10.99", "USD");
      expect(trap1.amount).toBe(1099);
      expect(trap1.toDecimalString()).toBe("10.99");

      // Another IEEE 754 precision trap: 1.14 * 100 in float is 113.99999999999999
      const trap2 = Money.fromDecimalString("1.14", "USD");
      expect(trap2.amount).toBe(114);
      expect(trap2.toDecimalString()).toBe("1.14");

      // Zero decimal places padding
      const singleDecimal = Money.fromDecimalString("5.5", "USD");
      expect(singleDecimal.amount).toBe(550);
      expect(singleDecimal.toDecimalString()).toBe("5.50");

      const noDecimal = Money.fromDecimalString("100", "USD");
      expect(noDecimal.amount).toBe(10000);
      expect(noDecimal.toDecimalString()).toBe("100.00");
    });

    it("handles zero and negative amounts accurately", () => {
      const zero = Money.zero("USD");
      expect(zero.amount).toBe(0);
      expect(zero.isZero()).toBe(true);
      expect(zero.toDecimalString()).toBe("0.00");

      const negative = Money.fromDecimalString("-15.75", "USD");
      expect(negative.amount).toBe(-1575);
      expect(negative.isNegative()).toBe(true);
      expect(negative.toDecimalString()).toBe("-15.75");

      const negativeSmall = Money.fromMinorUnits(-5, "USD");
      expect(negativeSmall.toDecimalString()).toBe("-0.05");

      // Normalization of IEEE 754 negative zero
      const negZeroString = Money.fromDecimalString("-0.00", "USD");
      expect(Object.is(negZeroString.amount, 0)).toBe(true);
      expect(negZeroString.isZero()).toBe(true);

      const negZeroMinor = Money.fromMinorUnits(-0, "USD");
      expect(Object.is(negZeroMinor.amount, 0)).toBe(true);
      expect(negZeroMinor.isZero()).toBe(true);
    });

    it("supports zero-decimal currencies (JPY) with proper rounding", () => {
      const jpy = Money.fromDecimalString("1500", "JPY");
      expect(jpy.amount).toBe(1500);
      expect(jpy.currency).toBe("JPY");
      expect(jpy.toDecimalString()).toBe("1500");

      const jpyRoundUp = Money.fromDecimalString("100.6", "JPY");
      expect(jpyRoundUp.amount).toBe(101);

      const jpyRoundDown = Money.fromDecimalString("100.4", "JPY");
      expect(jpyRoundDown.amount).toBe(100);
    });

    it("supports three-decimal currencies (BHD)", () => {
      const bhd = Money.fromDecimalString("10.500", "BHD");
      expect(bhd.amount).toBe(10500);
      expect(bhd.currency).toBe("BHD");
      expect(bhd.toDecimalString()).toBe("10.500");
    });

    it("converts to and from PayPal amount schema", () => {
      const money = Money.fromPayPal({
        currency_code: "USD",
        value: "249.99",
      });
      expect(money.amount).toBe(24999);
      expect(money.currency).toBe("USD");

      const payPalObj = money.toPayPalAmount();
      expect(payPalObj).toEqual({
        currency_code: "USD",
        value: "249.99",
      });
    });

    it("converts to and from AP2 amount schema", () => {
      const money = Money.fromAP2({
        currency: "USD",
        amount: 24999,
      });
      expect(money.amount).toBe(24999);
      expect(money.currency).toBe("USD");

      const ap2Obj = money.toAP2Amount();
      expect(ap2Obj).toEqual({
        currency: "USD",
        amount: 24999,
      });

      expect(money.toJSON()).toEqual({
        amount: 24999,
        currency: "USD",
        formatted: "249.99",
      });
      expect(JSON.stringify(money)).toBe('{"amount":24999,"currency":"USD","formatted":"249.99"}');
    });
  });

  describe("Arithmetic Operations", () => {
    it("adds amounts of the same currency", () => {
      const m1 = Money.fromDecimalString("10.50", "USD");
      const m2 = Money.fromDecimalString("20.25", "USD");
      const result = m1.add(m2);
      expect(result.toDecimalString()).toBe("30.75");
      expect(result.amount).toBe(3075);
    });

    it("rejects addition across different currencies", () => {
      const m1 = Money.fromDecimalString("10.50", "USD");
      const m2 = Money.fromDecimalString("20.25", "EUR");
      expect(() => m1.add(m2)).toThrow(DomainError);
    });

    it("subtracts amounts of the same currency", () => {
      const m1 = Money.fromDecimalString("50.00", "USD");
      const m2 = Money.fromDecimalString("19.99", "USD");
      const result = m1.subtract(m2);
      expect(result.toDecimalString()).toBe("30.01");
      expect(result.amount).toBe(3001);
    });

    it("multiplies amount by a factor with half-up rounding", () => {
      const m = Money.fromDecimalString("10.00", "USD");
      const taxed = m.multiply(1.0825);
      expect(taxed.toDecimalString()).toBe("10.83");
      expect(taxed.amount).toBe(1083);

      const neg = Money.fromDecimalString("-10.00", "USD");
      const negTaxed = neg.multiply(1.0825);
      expect(negTaxed.toDecimalString()).toBe("-10.83");
      expect(negTaxed.amount).toBe(-1083);
      expect(taxed.add(negTaxed).isZero()).toBe(true);
    });

    it("allocates amounts across ratios without penny-loss", () => {
      // $10.00 split 1:1:1 gives 3.34, 3.33, 3.33 -> total 10.00
      const total = Money.fromDecimalString("10.00", "USD");
      const parts = total.allocate([1, 1, 1]);
      expect(parts.length).toBe(3);
      expect(parts[0]?.amount).toBe(334);
      expect(parts[1]?.amount).toBe(333);
      expect(parts[2]?.amount).toBe(333);

      const sum = parts.reduce((acc, p) => acc.add(p), Money.zero("USD"));
      expect(sum.equals(total)).toBe(true);
    });

    it("allocates remaining penny to the largest fractional remainder (Hare-Niemeyer method)", () => {
      // $1.01 (101 cents) split 1:3:
      // Ratio 1: 101 * 1/4 = 25.25 cents (floor 25, fraction 0.25)
      // Ratio 3: 101 * 3/4 = 75.75 cents (floor 75, fraction 0.75)
      // Largest fractional remainder is 0.75, so ratio 3 receives the leftover cent -> [25, 76]
      const total = Money.fromDecimalString("1.01", "USD");
      const parts = total.allocate([1, 3]);
      expect(parts.length).toBe(2);
      expect(parts[0]?.amount).toBe(25);
      expect(parts[1]?.amount).toBe(76);
      expect(parts[0]?.toDecimalString()).toBe("0.25");
      expect(parts[1]?.toDecimalString()).toBe("0.76");

      const sum = parts.reduce((acc, p) => acc.add(p), Money.zero("USD"));
      expect(sum.equals(total)).toBe(true);
    });

    it("allocates negative and zero amounts deterministically", () => {
      // Negative amount: -$1.01 split 1:3 -> [-25, -76]
      const neg = Money.fromDecimalString("-1.01", "USD");
      const negParts = neg.allocate([1, 3]);
      expect(negParts[0]?.amount).toBe(-25);
      expect(negParts[1]?.amount).toBe(-76);

      const zero = Money.zero("USD");
      const zeroParts = zero.allocate([1, 2]);
      expect(zeroParts[0]?.amount).toBe(0);
      expect(zeroParts[1]?.amount).toBe(0);
    });
  });

  describe("Comparisons and State", () => {
    it("compares amounts correctly", () => {
      const low = Money.fromDecimalString("5.00", "USD");
      const high = Money.fromDecimalString("10.00", "USD");
      const equalToLow = Money.fromDecimalString("5.00", "USD");

      expect(low.lessThan(high)).toBe(true);
      expect(high.greaterThan(low)).toBe(true);
      expect(low.equals(equalToLow)).toBe(true);
      expect(low.lessThanOrEqual(equalToLow)).toBe(true);
      expect(high.greaterThanOrEqual(low)).toBe(true);
    });

    it("rejects comparisons with different currencies", () => {
      const usd = Money.fromDecimalString("5.00", "USD");
      const eur = Money.fromDecimalString("5.00", "EUR");
      expect(() => usd.equals(eur)).toThrow(DomainError);
    });
  });

  describe("Validation", () => {
    it("rejects invalid currency codes", () => {
      expect(() => Money.fromMinorUnits(100, "us")).toThrow(DomainError);
      expect(() => Money.fromMinorUnits(100, "US1")).toThrow(DomainError);
      expect(() => Money.fromMinorUnits(100, "")).toThrow(DomainError);
    });

    it("rejects invalid decimal strings", () => {
      expect(() => Money.fromDecimalString("abc", "USD")).toThrow(DomainError);
      expect(() => Money.fromDecimalString("12.34.56", "USD")).toThrow(DomainError);
      expect(() => Money.fromDecimalString("", "USD")).toThrow(DomainError);
    });

    it("rejects non-integer minor units", () => {
      expect(() => Money.fromMinorUnits(100.5, "USD")).toThrow(DomainError);
      expect(() => Money.fromMinorUnits(NaN, "USD")).toThrow(DomainError);
    });

    it("verifies fromCents, toString, and toJSON serialization", () => {
      const money = Money.fromCents(1250, "USD");
      expect(money.amount).toBe(1250);
      expect(money.toString()).toBe("12.50 USD");
      expect(money.toJSON()).toEqual({
        amount: 1250,
        currency: "USD",
        formatted: "12.50",
      });
    });

    it("evaluates positivity and negativity flags", () => {
      const pos = Money.fromMinorUnits(100, "USD");
      expect(pos.isPositive()).toBe(true);
      expect(pos.isNegative()).toBe(false);

      const neg = Money.fromMinorUnits(-100, "USD");
      expect(neg.isPositive()).toBe(false);
      expect(neg.isNegative()).toBe(true);

      const zero = Money.zero("USD");
      expect(zero.isPositive()).toBe(false);
      expect(zero.isNegative()).toBe(false);
      expect(zero.isZero()).toBe(true);
    });

    it("rejects invalid allocation parameters", () => {
      const money = Money.fromCents(100, "USD");
      expect(() => money.allocate([])).toThrow(DomainError);
      expect(() => money.allocate([0, 0])).toThrow(DomainError);
      expect(() => money.allocate([-1, 2])).toThrow(DomainError);
    });

    it("rejects non-finite multiplication factors", () => {
      const money = Money.fromCents(100, "USD");
      expect(() => money.multiply(NaN)).toThrow(DomainError);
      expect(() => money.multiply(Infinity)).toThrow(DomainError);
    });
  });
});
