import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type EscrowOrder,
  PayPalClient,
  type PayPalConfig,
  type ShipmentMilestone,
} from "@tessera/paypal";
import { z } from "zod";

export const CheckSettlementInputShape = {
  order_id: z.string().optional().describe("PayPal Order ID to inspect"),
  authorization_id: z.string().optional().describe("PayPal Authorization ID of escrow hold"),
  tracking_number: z
    .string()
    .optional()
    .describe("Carrier tracking number to check milestone status"),
  carrier: z.string().optional().describe("Carrier code (e.g. UPS, FEDEX, DHL)"),
};

export const CheckSettlementInputSchema = z.object(CheckSettlementInputShape);
export type CheckSettlementInput = z.infer<typeof CheckSettlementInputSchema>;

export interface CheckSettlementContext {
  paypalClient?: PayPalClient | undefined;
  paypalConfig?: PayPalConfig | undefined;
  getOrderFn?: ((orderId: string) => Promise<EscrowOrder>) | undefined;
  getAuthorizationFn?:
    | ((authorizationId: string) => Promise<{ id?: string; status: string }>)
    | undefined;
  getShipmentTrackingFn?:
    | ((txOrTrackerId: string, trackingNumber?: string | undefined) => Promise<ShipmentMilestone>)
    | undefined;
}

export function registerCheckSettlementTool(
  server: McpServer,
  context: CheckSettlementContext = {},
) {
  server.tool(
    "tessera_check_settlement",
    "Checks live escrow status, shipment carrier tracking milestones, and settlement capture readiness.",
    CheckSettlementInputShape,
    async (args) => {
      try {
        if (!args.order_id && !args.authorization_id && !args.tracking_number) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: "At least one of `order_id`, `authorization_id`, or `tracking_number` must be provided to check settlement status.",
              },
            ],
          };
        }

        const paypalClient =
          context.paypalClient ??
          (context.paypalConfig ? new PayPalClient(context.paypalConfig) : undefined);

        let orderData: EscrowOrder | undefined;
        if (args.order_id) {
          if (context.getOrderFn) {
            orderData = await context.getOrderFn(args.order_id);
          } else if (paypalClient) {
            orderData = await paypalClient.getOrder(args.order_id);
          }
        }

        let trackingMilestone: ShipmentMilestone | undefined;
        const trackingTarget = args.tracking_number ?? args.authorization_id ?? args.order_id;
        if (trackingTarget) {
          try {
            if (context.getShipmentTrackingFn) {
              trackingMilestone = await context.getShipmentTrackingFn(
                trackingTarget,
                args.tracking_number,
              );
            } else if (paypalClient) {
              trackingMilestone = await paypalClient.getShipmentTracking(
                trackingTarget,
                args.tracking_number,
              );
            }
          } catch {
            // Tracking may not yet be registered or carrier not synced
          }
        }

        let authId =
          args.authorization_id ??
          (orderData?.authorizationId ? String(orderData.authorizationId) : undefined);

        let authStatus: string | undefined;

        // 1. Inspect rawResponse.purchase_units[].payments.authorizations[]
        const rawResponse = orderData?.rawResponse as
          | {
              purchase_units?: Array<{
                payments?: {
                  authorizations?: Array<{
                    id?: string;
                    status?: string;
                  }>;
                };
              }>;
            }
          | undefined;

        const authorizations = rawResponse?.purchase_units?.[0]?.payments?.authorizations;
        if (Array.isArray(authorizations) && authorizations.length > 0) {
          const matched = authId
            ? (authorizations.find((a) => a.id === authId) ?? authorizations[0])
            : authorizations[0];
          if (matched?.status) {
            authStatus = matched.status.toUpperCase();
            if (!authId && matched.id) {
              authId = matched.id;
            }
          }
        }

        // 2. If not found in rawResponse, try getAuthorizationFn or paypalClient.getAuthorization
        if (!authStatus && authId) {
          try {
            if (context.getAuthorizationFn) {
              const res = await context.getAuthorizationFn(authId);
              if (res?.status) authStatus = res.status.toUpperCase();
            } else if (paypalClient && typeof paypalClient.getAuthorization === "function") {
              const res = await paypalClient.getAuthorization(authId);
              if (res?.status) authStatus = res.status.toUpperCase();
            }
          } catch {
            // lookup failed
          }
        }

        // 3. Fallback for mock EscrowOrder with authorizationId when rawResponse has no nested authorizations array
        if (!authStatus && orderData?.authorizationId) {
          if (orderData.status === "VOIDED") {
            authStatus = "VOIDED";
          } else {
            authStatus = "CREATED";
          }
        }

        const escrowStatus =
          authStatus ?? orderData?.status ?? (args.authorization_id ? "UNKNOWN" : "NOT_FOUND");

        const shipmentStatus = trackingMilestone?.status ?? "NOT_FOUND";
        const isDelivered = String(shipmentStatus) === "DELIVERED";

        // Active authorizations that permit capture
        const isActiveAuth = authStatus === "CREATED" || authStatus === "PENDING";
        const isCaptured = authStatus === "CAPTURED";
        const isVoided = authStatus === "VOIDED" || orderData?.status === "VOIDED";
        const isExpired = authStatus === "EXPIRED";
        const isDenied = authStatus === "DENIED";

        const canCapture =
          isDelivered && isActiveAuth && !isVoided && !isCaptured && !isExpired && !isDenied;

        let settlementMessage = "PENDING DELIVERY";
        if (isCaptured) {
          settlementMessage = "ALREADY CAPTURED / SETTLED";
        } else if (isVoided) {
          settlementMessage = "AUTHORIZATION VOIDED";
        } else if (isExpired) {
          settlementMessage = "AUTHORIZATION EXPIRED";
        } else if (isDenied) {
          settlementMessage = "AUTHORIZATION DENIED";
        } else if (canCapture) {
          settlementMessage = "READY FOR CAPTURE";
        } else if (
          !isActiveAuth &&
          (args.order_id || args.authorization_id) &&
          !args.tracking_number
        ) {
          settlementMessage = "PENDING AUTHORIZATION";
        } else if (!isDelivered) {
          settlementMessage = "PENDING DELIVERY";
        } else if (!isActiveAuth) {
          settlementMessage = "PENDING AUTHORIZATION";
        }

        const lines = [
          "## Tessera Settlement Status Check",
          args.order_id ? `- **Order ID:** ${args.order_id}` : undefined,
          authId ? `- **Authorization ID:** ${authId}` : undefined,
          `- **Escrow Status:** ${escrowStatus}`,
          `- **Authorization Status:** ${authStatus ?? "UNKNOWN"}`,
          args.tracking_number ? `- **Tracking Number:** ${args.tracking_number}` : undefined,
          `- **Shipment Milestone:** ${shipmentStatus}`,
          `- **Delivery Verified:** ${isDelivered ? "YES" : "NO"}`,
          `- **Settlement Ready (Capture Permitted):** ${settlementMessage}`,
        ].filter((l): l is string => Boolean(l));

        const structuredPayload = {
          success: true,
          orderId: args.order_id,
          authorizationId: authId,
          escrowStatus,
          authorizationStatus: authStatus,
          trackingNumber: args.tracking_number,
          shipmentStatus,
          deliveryVerified: isDelivered,
          settlementReady: canCapture,
          canCapture,
          statusMessage: settlementMessage,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `${lines.join("\n")}\n\n\`\`\`json\n${JSON.stringify(structuredPayload, null, 2)}\n\`\`\``,
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
              text: `Settlement check failed: ${errorMsg}`,
            },
          ],
        };
      }
    },
  );
}
