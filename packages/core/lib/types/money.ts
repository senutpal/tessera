import { MandateValidationError } from "../errors/domainErrors.js";

const ISO_4217_SCALES: Record<string, number> = {
  BHD: 3,
  BIF: 0,
  CLF: 4,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  IQD: 3,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  PYG: 0,
  RWF: 0,
  TND: 3,
  UGX: 0,
  UYI: 0,
  UYW: 4,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

function getCurrencyScale(currency: string): number {
  return ISO_4217_SCALES[currency] ?? 2;
}

function validateCurrency(currency: string): string {
  if (!currency || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new MandateValidationError(
      `Invalid ISO 4217 currency code: "${currency}". Expected 3 uppercase letters.`,
      { currency },
    );
  }
  return currency;
}

export interface AP2Amount {
  amount: number;
  currency: string;
}

export interface PayPalAmount {
  currency_code: string;
  value: string;
}

export class Money {
  public readonly amount: number;
  public readonly currency: string;
  public readonly scale: number;

  private constructor(amount: number, currency: string) {
    if (!Number.isSafeInteger(amount)) {
      throw new MandateValidationError(
        `Monetary amount must be a safe integer in minor units, received: ${amount}`,
        { amount, currency },
      );
    }
    this.currency = validateCurrency(currency);
    this.amount = Object.is(amount, -0) ? 0 : amount;
    this.scale = getCurrencyScale(this.currency);
    Object.freeze(this);
  }

  public static fromMinorUnits(amount: number, currency = "USD"): Money {
    return new Money(amount, currency);
  }

  public static fromCents(cents: number, currency = "USD"): Money {
    return new Money(cents, currency);
  }

  public static zero(currency = "USD"): Money {
    return new Money(0, currency);
  }

  public static fromDecimalString(decimalStr: string, currency = "USD"): Money {
    const validCurrency = validateCurrency(currency);
    const scale = getCurrencyScale(validCurrency);

    if (typeof decimalStr !== "string" || !decimalStr.trim()) {
      throw new MandateValidationError(
        `Invalid monetary decimal string: "${decimalStr}". Cannot be empty.`,
        { decimalStr, currency: validCurrency },
      );
    }

    const trimmed = decimalStr.trim();
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
    if (!match) {
      throw new MandateValidationError(
        `Invalid monetary decimal string format: "${decimalStr}". Expected standard decimal representation.`,
        { decimalStr, currency: validCurrency },
      );
    }

    const isNegative = match[1] === "-";
    const intPart = match[2] ?? "0";
    const fracPart = match[3] ?? "";

    let minorUnitsBigInt: bigint;
    if (scale === 0) {
      let roundedBonus = 0n;
      if (fracPart.length > 0) {
        const nextDigit = Number(fracPart[0]);
        if (nextDigit >= 5) {
          roundedBonus = 1n;
        }
      }
      minorUnitsBigInt = BigInt(intPart) + roundedBonus;
    } else {
      const paddedFraction = fracPart.padEnd(scale, "0").slice(0, scale);
      let roundedBonus = 0n;
      if (fracPart.length > scale) {
        const nextDigit = Number(fracPart[scale]);
        if (nextDigit >= 5) {
          roundedBonus = 1n;
        }
      }
      minorUnitsBigInt =
        BigInt(intPart) * 10n ** BigInt(scale) + BigInt(paddedFraction) + roundedBonus;
    }

    const minorUnits = Number(minorUnitsBigInt);
    if (!Number.isSafeInteger(minorUnits)) {
      throw new MandateValidationError(`Monetary amount overflow in minor units: "${decimalStr}"`, {
        decimalStr,
        currency: validCurrency,
      });
    }

    const finalAmount = isNegative && minorUnits !== 0 ? -minorUnits : minorUnits;
    return new Money(finalAmount, validCurrency);
  }

  public static fromPayPal(payPalAmount: PayPalAmount): Money {
    if (!payPalAmount || typeof payPalAmount !== "object") {
      throw new MandateValidationError("Invalid PayPal amount payload");
    }
    return Money.fromDecimalString(payPalAmount.value, payPalAmount.currency_code);
  }

  public static fromAP2(ap2Amount: AP2Amount): Money {
    if (!ap2Amount || typeof ap2Amount !== "object") {
      throw new MandateValidationError("Invalid AP2 amount payload");
    }
    return Money.fromMinorUnits(ap2Amount.amount, ap2Amount.currency);
  }

  public toMinorUnits(): number {
    return this.amount;
  }

  public toDecimalString(): string {
    const isNegative = this.amount < 0;
    const abs = Math.abs(this.amount);

    if (this.scale === 0) {
      return `${isNegative ? "-" : ""}${abs}`;
    }

    const divisor = 10 ** this.scale;
    const intPart = Math.floor(abs / divisor);
    const fracPart = (abs % divisor).toString().padStart(this.scale, "0");

    return `${isNegative ? "-" : ""}${intPart}.${fracPart}`;
  }

  public toPayPalAmount(): PayPalAmount {
    return {
      currency_code: this.currency,
      value: this.toDecimalString(),
    };
  }

  public toAP2Amount(): AP2Amount {
    return {
      amount: this.amount,
      currency: this.currency,
    };
  }

  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount - other.amount, this.currency);
  }

  public multiply(factor: number): Money {
    if (typeof factor !== "number" || !Number.isFinite(factor)) {
      throw new MandateValidationError(`Invalid multiplication factor: ${factor}`);
    }
    const scaled = Math.round(this.amount * factor);
    return new Money(scaled, this.currency);
  }

  public allocate(ratios: number[]): Money[] {
    if (!Array.isArray(ratios) || ratios.length === 0) {
      throw new MandateValidationError("Ratios array cannot be empty for allocation");
    }

    const totalRatio = ratios.reduce((sum, r) => {
      if (typeof r !== "number" || r < 0 || !Number.isFinite(r)) {
        throw new MandateValidationError(`Invalid allocation ratio: ${r}`);
      }
      return sum + r;
    }, 0);

    if (totalRatio === 0) {
      throw new MandateValidationError("Sum of allocation ratios must be positive");
    }

    const isNegative = this.amount < 0;
    const totalMinorUnits = Math.abs(this.amount);

    // Hare-Niemeyer (Largest Remainder) Method
    const shares: number[] = [];
    const remainders: { index: number; fraction: number }[] = [];
    let allocatedTotal = 0;

    for (let i = 0; i < ratios.length; i++) {
      const ratio = ratios[i] as number;
      const exactShare = (totalMinorUnits * ratio) / totalRatio;
      const integerShare = Math.floor(exactShare);
      shares.push(integerShare);
      allocatedTotal += integerShare;
      remainders.push({
        index: i,
        fraction: exactShare - integerShare,
      });
    }

    const leftover = totalMinorUnits - allocatedTotal;

    // Distribute remaining units to shares with the largest fractional remainder
    remainders.sort((a, b) => {
      if (b.fraction !== a.fraction) {
        return b.fraction - a.fraction;
      }
      return a.index - b.index;
    });

    for (let i = 0; i < leftover; i++) {
      const targetIndex = (remainders[i % remainders.length] as { index: number }).index;
      shares[targetIndex] = (shares[targetIndex] ?? 0) + 1;
    }

    return shares.map((amt) => new Money(isNegative ? -amt : amt, this.currency));
  }

  public equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount === other.amount;
  }

  public greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount > other.amount;
  }

  public greaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount >= other.amount;
  }

  public lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount < other.amount;
  }

  public lessThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount <= other.amount;
  }

  public isZero(): boolean {
    return this.amount === 0;
  }

  public isPositive(): boolean {
    return this.amount > 0;
  }

  public isNegative(): boolean {
    return this.amount < 0;
  }

  public toJSON(): { amount: number; currency: string; formatted: string } {
    return {
      amount: this.amount,
      currency: this.currency,
      formatted: this.toDecimalString(),
    };
  }

  public toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (!(other instanceof Money)) {
      throw new MandateValidationError("Operand must be an instance of Money");
    }
    if (this.currency !== other.currency) {
      throw new MandateValidationError(
        `Currency mismatch: cannot perform operation between ${this.currency} and ${other.currency}`,
        { baseCurrency: this.currency, targetCurrency: other.currency },
      );
    }
  }
}
