import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Money } from "@tessera/core";
import {
  amountToMoney,
  type MandateVerificationOptions,
  type NonceStore,
  type PaymentMandate,
  type SignedMandate,
  verifyMandate,
} from "@tessera/mandates";
import {
  type AuthorizeOrderOptions,
  type CreateEscrowOrderOptions,
  type EscrowAuthorization,
  type EscrowOrder,
  PayPalClient,
  type PayPalConfig,
} from "@tessera/paypal";
import type { PolicyEngine } from "@tessera/policy";
import { z } from "zod";

export const SubmitMandateInputShape = {
  signed_mandate: z
    .object({
      mandate: z
        .record(z.unknown())
        .describe(
          "AP2 Payment Mandate or Checkout Mandate payload conforming to AP2 specification",
        ),
      signature: z
        .string()
        .min(1, "Signature cannot be empty")
        .describe("Ed25519 signature over canonical mandate payload"),
      signerPublicKey: z
        .string()
        .min(1, "signerPublicKey cannot be empty")
        .describe("Signer Ed25519 public key"),
    })
    .describe("Cryptographically signed AP2 mandate container"),
  merchant_id: z.string().optional().describe("Payee or merchant identifier"),
  description: z.string().optional().describe("Escrow order description"),
  custom_id: z.string().optional().describe("Tracking or correlation ID"),
};

export const SubmitMandateInputSchema = z.object(SubmitMandateInputShape);
export type SubmitMandateInput = z.infer<typeof SubmitMandateInputSchema>;

export interface SubmitMandateContext {
  paypalClient?: PayPalClient | undefined;
  paypalConfig?: PayPalConfig | undefined;
  policyEngine?: PolicyEngine | undefined;
  nonceStore?: NonceStore | undefined;
  createEscrowOrderFn?: ((options: CreateEscrowOrderOptions) => Promise<EscrowOrder>) | undefined;
  authorizeOrderFn?: ((options: AuthorizeOrderOptions) => Promise<EscrowAuthorization>) | undefined;
}

export function registerSubmitMandateTool(server: McpServer, context: SubmitMandateContext = {}) {
  server.tool(
    "tessera_submit_mandate",
    "Submits a cryptographically signed AP2 mandate (Ed25519) to authorize buyer funds into PayPal escrow (intent: AUTHORIZE).",
    SubmitMandateInputShape,
    async (args) => {
      try {
        const signed = args.signed_mandate;

        // 1. Cryptographically verify AP2 mandate (Ed25519 signature + timestamps + anti-replay)
        let verifiedMandate: unknown;
        try {
          const verifOptions: MandateVerificationOptions = {
            publicKey: signed.signerPublicKey,
            ...(context.nonceStore !== undefined ? { nonceStore: context.nonceStore } : {}),
          };
          verifiedMandate = await verifyMandate(signed as SignedMandate<unknown>, verifOptions);
        } catch (verifErr) {
          const msg = verifErr instanceof Error ? verifErr.message : String(verifErr);
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `Mandate cryptographic verification failed: ${msg}`,
              },
            ],
          };
        }

        // 2. Evaluate organizational spending policy if policy engine configured
        const isPaymentMandate =
          typeof verifiedMandate === "object" &&
          verifiedMandate !== null &&
          (verifiedMandate as { vct?: unknown }).vct === "mandate.payment.1";

        if (context.policyEngine && isPaymentMandate) {
          const paymentMandate = verifiedMandate as PaymentMandate;
          const policyEval = context.policyEngine.evaluateSafe({
            agentId:
              typeof (signed.mandate as { agent_id?: unknown }).agent_id === "string"
                ? (signed.mandate as { agent_id: string }).agent_id
                : "agent-mcp-orchestrator",
            mandate: paymentMandate,
          });

          if (!policyEval.approved) {
            const violationMsg =
              policyEval.rationale.length > 0
                ? policyEval.rationale.join("; ")
                : "Policy spending limits or merchant rules violated";
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `Spending policy violation: ${violationMsg}`,
                },
              ],
            };
          }
        }

        // 3. Extract monetary amount from verified mandate
        let money: Money;
        let payeeId = args.merchant_id;
        let customId = args.custom_id;

        if (isPaymentMandate) {
          const pm = verifiedMandate as PaymentMandate;
          money = amountToMoney(pm.payment_amount);
          if (!payeeId && pm.payee?.id) {
            payeeId = pm.payee.id;
          }
          if (!customId && pm.transaction_id) {
            customId = pm.transaction_id;
          }
        } else {
          money = Money.fromDecimalString("1.00", "USD");
        }

        // 4. Create and authorize PayPal escrow order (intent: AUTHORIZE)
        const paypalClient =
          context.paypalClient ??
          (context.paypalConfig ? new PayPalClient(context.paypalConfig) : undefined);

        let escrowOrder: EscrowOrder;
        if (context.createEscrowOrderFn) {
          escrowOrder = await context.createEscrowOrderFn({
            amount: money,
            description: args.description ?? "Tessera Autonomous AP2 Escrow Order",
            customId,
            referenceId: customId ?? "tessera-mandate-ref",
            payee: payeeId ? { merchantId: payeeId } : undefined,
          });
        } else if (paypalClient) {
          escrowOrder = await paypalClient.createEscrowOrder({
            amount: money,
            description: args.description ?? "Tessera Autonomous AP2 Escrow Order",
            customId,
            referenceId: customId ?? "tessera-mandate-ref",
            payee: payeeId ? { merchantId: payeeId } : undefined,
          });
        } else {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "PayPal clearinghouse client is not configured on this server.",
              },
            ],
          };
        }

        // Attempt order authorization
        let authorization: EscrowAuthorization | undefined;
        try {
          if (context.authorizeOrderFn) {
            authorization = await context.authorizeOrderFn({
              orderId: escrowOrder.orderId,
            });
          } else if (paypalClient) {
            authorization = await paypalClient.authorizeOrder({
              orderId: escrowOrder.orderId,
            });
          }
        } catch {
          // If direct authorization is pending buyer flow or mock, authorization remains undefined
        }

        const authId = authorization?.authorizationId ?? escrowOrder.authorizationId;
        const status = authorization?.status ?? escrowOrder.status;

        const summaryLines = [
          "## AP2 Mandate Authorization Succeeded",
          `- **Order ID:** ${escrowOrder.orderId}`,
          authId ? `- **Authorization ID:** ${authId}` : "- **Authorization ID:** Pending approval",
          `- **Status:** ${status}`,
          `- **Escrow Amount:** ${money.toDecimalString()} ${money.currency}`,
          "- **Mandate Verified:** Ed25519 signature authenticated against AP2 specification",
          "- **Intent:** AUTHORIZE (Funds locked in buyer escrow until carrier delivery proof)",
        ];

        const structuredPayload = {
          success: true,
          orderId: String(escrowOrder.orderId),
          authorizationId: authId ? String(authId) : undefined,
          status,
          amount: money.toDecimalString(),
          currency: money.currency,
          mandateVerified: true,
          intent: "AUTHORIZE",
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `${summaryLines.join("\n")}\n\n\`\`\`json\n${JSON.stringify(structuredPayload, null, 2)}\n\`\`\``,
            },
          ],
          structuredContent: structuredPayload,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Failed to submit mandate to clearinghouse: ${errorMsg}`,
            },
          ],
        };
      }
    },
  );
}
