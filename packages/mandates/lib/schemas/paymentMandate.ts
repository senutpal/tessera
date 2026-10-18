import { Money } from "@tessera/core";
import { z } from "zod";
import { MandateSchemaValidationError } from "../errors.js";

export const MerchantIdentifierSchema = z
  .object({
    id: z.string().min(1, "Merchant id is required"),
    name: z.string().min(1, "Merchant name is required"),
    website: z.string().url("Merchant website must be a valid URL").optional(),
  })
  .passthrough();
export type MerchantIdentifier = z.infer<typeof MerchantIdentifierSchema>;

export const AmountSchema = z.object({
  amount: z
    .number()
    .int("Amount must be an integer in minor units")
    .nonnegative("Amount must be non-negative")
    .refine((val) => Number.isSafeInteger(val), {
      message: "Amount must be a safe integer",
    }),
  currency: z
    .string()
    .length(3, "Currency must be a 3-letter ISO 4217 code")
    .regex(/^[A-Z]{3}$/, "Currency must be 3 uppercase alphabetic characters"),
});
export type Amount = z.infer<typeof AmountSchema>;

/**
 * Converts an AP2 Amount object to a validated @tessera/core Money instance.
 */
export function amountToMoney(amount: Amount): Money {
  AmountSchema.parse(amount);
  return Money.fromMinorUnits(amount.amount, amount.currency);
}

/**
 * Converts a @tessera/core Money instance to an AP2 Amount object.
 */
export function moneyToAmount(money: Money): Amount {
  return {
    amount: money.amount,
    currency: money.currency,
  };
}

export const PaymentInstrumentSchema = z
  .object({
    id: z.string().min(1, "Payment instrument id is required"),
    type: z.string().min(1, "Payment instrument type is required"),
    description: z.string().optional(),
  })
  .passthrough();
export type PaymentInstrument = z.infer<typeof PaymentInstrumentSchema>;

export const PispIdentifierSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough()
  .optional();
export type PispIdentifier = z.infer<typeof PispIdentifierSchema>;

const BasePaymentMandateSchema = z
  .object({
    vct: z.literal("mandate.payment.1", {
      errorMap: () => ({ message: "vct claim must be 'mandate.payment.1'" }),
    }),
    transaction_id: z.string().min(1, "transaction_id cannot be empty"),
    payee: MerchantIdentifierSchema,
    pisp: PispIdentifierSchema,
    payment_amount: AmountSchema,
    payment_instrument: PaymentInstrumentSchema,
    execution_date: z.string().optional(),
    risk_data: z.record(z.unknown()).optional(),
    iat: z.number().int().positive("iat must be a positive Unix epoch timestamp").optional(),
    exp: z.number().int().positive("exp must be a positive Unix epoch timestamp").optional(),
    nonce: z.string().min(1, "nonce cannot be empty").optional(),
  })
  .passthrough();

export type PaymentMandate = z.infer<typeof BasePaymentMandateSchema>;

/**
 * Zod schema validating official AP2 Payment Mandate payloads (`mandate.payment.1`).
 * Validates verifiable credential types, minor-unit integer amounts, merchant identification,
 * payment instrument structures, and transaction hash bindings.
 */
export const PaymentMandateSchema = Object.assign(BasePaymentMandateSchema, {
  parse(data: unknown): PaymentMandate {
    const result = BasePaymentMandateSchema.safeParse(data);
    if (!result.success) {
      const errorMsg = result.error.errors
        .map((e) => `${e.path.join(".") || "root"}: ${e.message}`)
        .join("; ");
      throw new MandateSchemaValidationError(
        `Payment Mandate schema validation failed: ${errorMsg}`,
        {
          errors: result.error.errors,
        },
      );
    }
    return result.data;
  },
});
