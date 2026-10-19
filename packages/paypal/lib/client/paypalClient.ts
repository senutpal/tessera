import { AuthorizationVoidService } from "../orders/authorizationVoidService.js";
import { OrdersEscrowService } from "../orders/ordersEscrowService.js";
import type {
  AuthorizeOrderOptions,
  CreateEscrowOrderOptions,
  EscrowAuthorization,
  EscrowEventSink,
  EscrowOrder,
  EscrowVoidResult,
  PayPalConfig,
  VoidAuthorizationOptions,
} from "../types/orders.js";
import {
  type PayPalVerifyWebhookSignatureRequest,
  PayPalVerifyWebhookSignatureResponseSchema,
  WebhookVerificationError,
} from "../types/webhooks.js";
import { PayPalAuthClient } from "./paypalAuthClient.js";
import { throwPayPalError } from "./paypalErrors.js";

export class PayPalClient {
  public readonly auth: PayPalAuthClient;
  public readonly orders: OrdersEscrowService;
  public readonly voids: AuthorizationVoidService;

  constructor(config: PayPalConfig, options: { eventSink?: EscrowEventSink | undefined } = {}) {
    this.auth = new PayPalAuthClient(config);
    this.orders = new OrdersEscrowService(this.auth);
    this.voids = new AuthorizationVoidService(this.auth, options);
  }

  /**
   * Creates an order with `intent: "AUTHORIZE"` to lock funds in buyer escrow.
   */
  public async createEscrowOrder(options: CreateEscrowOrderOptions): Promise<EscrowOrder> {
    return this.orders.createEscrowOrder(options);
  }

  /**
   * Authorizes an approved order, placing the escrow hold and returning the authorization_id.
   */
  public async authorizeOrder(options: AuthorizeOrderOptions): Promise<EscrowAuthorization> {
    return this.orders.authorizeOrder(options);
  }

  /**
   * Voids an active authorization hold on buyer funds.
   */
  public async voidAuthorization(options: VoidAuthorizationOptions): Promise<EscrowVoidResult> {
    return this.voids.voidAuthorization(options);
  }

  /**
   * Fetches the current state of an order by ID.
   */
  public async getOrder(orderId: string): Promise<EscrowOrder> {
    return this.orders.getOrder(orderId);
  }

  /**
   * Verifies a webhook signature using PayPal's REST API endpoint:
   * `POST /v1/notifications/verify-webhook-signature`
   */
  public async verifyWebhookSignature(
    request: PayPalVerifyWebhookSignatureRequest,
  ): Promise<boolean> {
    const res = await this.auth.fetchAuthenticated("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!res.ok) {
      if (res.status >= 500) {
        await throwPayPalError(
          res,
          "Failed to verify webhook signature via PayPal API",
          (msg, d) => new WebhookVerificationError(msg, d),
        );
      }
      return false;
    }

    const data = (await res.json()) as unknown;
    const parsed = PayPalVerifyWebhookSignatureResponseSchema.safeParse(data);
    if (!parsed.success) {
      return false;
    }

    return parsed.data.verification_status === "SUCCESS";
  }
}
