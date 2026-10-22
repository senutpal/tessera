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

        const escrowStatus = orderData?.status ?? "HELD";
        const shipmentStatus = trackingMilestone?.status ?? "SHIPPED";
        const isDelivered = shipmentStatus === "DELIVERED";
        const canCapture = isDelivered && escrowStatus !== "COMPLETED" && escrowStatus !== "VOIDED";

        const lines = [
          "## Tessera Settlement Status Check",
          args.order_id ? `- **Order ID:** ${args.order_id}` : undefined,
          args.authorization_id ? `- **Authorization ID:** ${args.authorization_id}` : undefined,
          `- **Escrow Status:** ${escrowStatus}`,
          args.tracking_number ? `- **Tracking Number:** ${args.tracking_number}` : undefined,
          `- **Shipment Milestone:** ${shipmentStatus}`,
          `- **Delivery Verified:** ${isDelivered ? "YES" : "NO"}`,
          `- **Settlement Ready (Capture Permitted):** ${canCapture ? "READY FOR CAPTURE" : "PENDING DELIVERY"}`,
        ].filter((l): l is string => Boolean(l));

        const structuredPayload = {
          success: true,
          orderId: args.order_id,
          authorizationId:
            args.authorization_id ??
            (orderData?.authorizationId ? String(orderData.authorizationId) : undefined),
          escrowStatus,
          trackingNumber: args.tracking_number,
          shipmentStatus,
          deliveryVerified: isDelivered,
          settlementReady: canCapture,
          canCapture,
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
