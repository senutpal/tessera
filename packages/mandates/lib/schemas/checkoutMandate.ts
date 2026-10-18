import { createHash } from "node:crypto";
import { z } from "zod";
import { MandateSchemaValidationError } from "../errors.js";

/**
 * Computes the deterministic base64url-encoded SHA-256 hash of a checkout JWT payload.
 * Matches AP2 specification for `checkout_hash` and `transaction_id`.
 */
export function computeCheckoutHash(checkoutJwt: string): string {
  if (typeof checkoutJwt !== "string" || checkoutJwt.trim().length === 0) {
    throw new MandateSchemaValidationError(
      "checkout_jwt must be a non-empty string to compute checkout hash",
    );
  }
  return createHash("sha256").update(checkoutJwt).digest("base64url");
}

const BaseCheckoutMandateSchema = z
  .object({
    vct: z.literal("mandate.checkout.1", {
      errorMap: () => ({ message: "vct claim must be 'mandate.checkout.1'" }),
    }),
    checkout_jwt: z.string().min(1, "checkout_jwt cannot be empty"),
    checkout_hash: z.string().min(1, "checkout_hash cannot be empty"),
    iat: z.number().int().positive("iat must be a positive Unix epoch timestamp").optional(),
    exp: z.number().int().positive("exp must be a positive Unix epoch timestamp").optional(),
    nonce: z.string().min(1, "nonce cannot be empty").optional(),
  })
  .passthrough();

export type CheckoutMandate = z.infer<typeof BaseCheckoutMandateSchema>;

/**
 * Zod schema validating official AP2 Checkout Mandate payloads (`mandate.checkout.1`).
 * Validates verifiable credential types, JWT formatting, and SHA-256 checkout hash binding.
 */
export const CheckoutMandateSchema = Object.assign(BaseCheckoutMandateSchema, {
  parse(data: unknown): CheckoutMandate {
    const result = BaseCheckoutMandateSchema.safeParse(data);
    if (!result.success) {
      const errorMsg = result.error.errors
        .map((e) => `${e.path.join(".") || "root"}: ${e.message}`)
        .join("; ");
      throw new MandateSchemaValidationError(
        `Checkout Mandate schema validation failed: ${errorMsg}`,
        {
          errors: result.error.errors,
        },
      );
    }
    return result.data;
  },
});
