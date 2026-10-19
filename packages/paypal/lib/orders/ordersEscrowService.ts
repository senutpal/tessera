import {
  asAuthorizationId,
  asOrderId,
  ConflictError,
  EscrowAuthorizationError,
  MandateValidationError,
  Money,
  NotFoundError,
  UnauthorizedError,
} from "@tessera/core";
import type { PayPalAuthClient } from "../client/paypalAuthClient.js";
import {
  type AuthorizeOrderOptions,
  type CreateEscrowOrderOptions,
  type EscrowAuthorization,
  type EscrowItemInput,
  type EscrowOrder,
  PayPalApiError,
  type PayPalItemWire,
  PayPalOrderResponseSchema,
  type PayPalPurchaseUnitWire,
} from "../types/orders.js";

function parseMoneyInput(input: Money | { currency_code: string; value: string }): Money {
  if (input instanceof Money) {
    return input;
  }
  return Money.fromDecimalString(input.value, input.currency_code);
}

export class OrdersEscrowService {
  constructor(private readonly authClient: PayPalAuthClient) {}

  /**
   * Creates an order with `intent: "AUTHORIZE"` to lock funds in buyer escrow.
   */
  public async createEscrowOrder(options: CreateEscrowOrderOptions): Promise<EscrowOrder> {
    const money = parseMoneyInput(options.amount);
    if (!money.isPositive()) {
      throw new MandateValidationError(
        `Escrow order amount must be positive, received: ${money.toDecimalString()} ${money.currency}`,
        { amount: money.toDecimalString(), currency: money.currency },
      );
    }

    const referenceId = options.referenceId ?? "default-unit";
    const purchaseUnit: PayPalPurchaseUnitWire = {
      reference_id: referenceId,
      amount: {
        currency_code: money.currency,
        value: money.toDecimalString(),
      },
    };

    if (options.description) {
      purchaseUnit.description = options.description;
    }
    if (options.customId) {
      purchaseUnit.custom_id = options.customId;
    }
    if (options.invoiceId) {
      purchaseUnit.invoice_id = options.invoiceId;
    }
    if (options.payee) {
      const payeeObj: { email_address?: string; merchant_id?: string } = {};
      if (options.payee.email) {
        payeeObj.email_address = options.payee.email;
      }
      if (options.payee.merchantId) {
        payeeObj.merchant_id = options.payee.merchantId;
      }
      purchaseUnit.payee = payeeObj;
    }

    if (options.items && options.items.length > 0) {
      const { itemsWire, itemTotal } = this.formatItems(options.items, money.currency);
      purchaseUnit.items = itemsWire;
      purchaseUnit.amount.breakdown = {
        item_total: {
          currency_code: money.currency,
          value: itemTotal.toDecimalString(),
        },
      };
    }

    const payload: Record<string, unknown> = {
      intent: "AUTHORIZE",
      purchase_units: [purchaseUnit],
    };

    if (options.returnUrl || options.cancelUrl) {
      payload.payment_source = {
        paypal: {
          experience_context: {
            return_url: options.returnUrl,
            cancel_url: options.cancelUrl,
          },
        },
      };
    }

    const requestId = options.requestId ?? crypto.randomUUID();
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("PayPal-Request-Id", requestId);
    headers.set("Prefer", "return=representation");

    const res = await this.authClient.fetchAuthenticated("/v2/checkout/orders", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      await this.handleErrorResponse(res, "Failed to create escrow order");
    }

    const json = await res.json();
    const parseResult = PayPalOrderResponseSchema.safeParse(json);
    if (!parseResult.success) {
      throw new EscrowAuthorizationError("PayPal create order response violates expected schema", {
        validationErrors: parseResult.error.format(),
      });
    }

    const orderResponse = parseResult.data;
    if (orderResponse.intent !== "AUTHORIZE") {
      throw new EscrowAuthorizationError(
        `Critical security invariant violation: order intent must be AUTHORIZE, received: ${orderResponse.intent}`,
        { intent: orderResponse.intent, orderId: orderResponse.id },
      );
    }

    return {
      orderId: asOrderId(orderResponse.id),
      status: orderResponse.status,
      amount: money,
      referenceId: orderResponse.purchase_units?.[0]?.reference_id,
      customId: options.customId,
      links: orderResponse.links ?? [],
      rawResponse: orderResponse,
    };
  }

  /**
   * Authorizes an approved order, placing the escrow hold and returning the authorization_id.
   */
  public async authorizeOrder(options: AuthorizeOrderOptions): Promise<EscrowAuthorization> {
    const orderIdStr = String(options.orderId);
    if (!orderIdStr.trim()) {
      throw new MandateValidationError("Order ID is required for authorization");
    }

    const path = `/v2/checkout/orders/${encodeURIComponent(orderIdStr)}/authorize`;
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    if (options.requestId) {
      headers.set("PayPal-Request-Id", options.requestId);
    }
    headers.set("Prefer", "return=representation");

    const bodyPayload = options.paymentSource ? { payment_source: options.paymentSource } : {};

    const res = await this.authClient.fetchAuthenticated(path, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyPayload),
    });

    if (!res.ok) {
      await this.handleErrorResponse(res, `Failed to authorize order ${orderIdStr}`);
    }

    const json = await res.json();
    const parseResult = PayPalOrderResponseSchema.safeParse(json);
    if (!parseResult.success) {
      throw new EscrowAuthorizationError(
        "PayPal authorize order response violates expected schema",
        {
          validationErrors: parseResult.error.format(),
        },
      );
    }

    const orderResponse = parseResult.data;
    const authRecord = orderResponse.purchase_units?.[0]?.payments?.authorizations?.[0];

    if (!authRecord) {
      throw new EscrowAuthorizationError(
        `No authorization record found in PayPal authorization response for order: ${orderIdStr}`,
        { orderId: orderIdStr, response: orderResponse },
      );
    }

    const amount = Money.fromDecimalString(
      authRecord.amount.value,
      authRecord.amount.currency_code,
    );

    const authorizationObj: EscrowAuthorization = {
      authorizationId: asAuthorizationId(authRecord.id),
      orderId: asOrderId(orderResponse.id),
      status: authRecord.status,
      amount,
      rawResponse: orderResponse,
    };

    if (authRecord.expiration_time) {
      authorizationObj.expirationTime = authRecord.expiration_time;
    }
    if (authRecord.create_time) {
      authorizationObj.createTime = authRecord.create_time;
    }

    return authorizationObj;
  }

  /**
   * Retrieves order state by OrderId.
   */
  public async getOrder(orderId: string | ReturnType<typeof asOrderId>): Promise<EscrowOrder> {
    const orderIdStr = String(orderId);
    const path = `/v2/checkout/orders/${encodeURIComponent(orderIdStr)}`;

    const res = await this.authClient.fetchAuthenticated(path, {
      method: "GET",
    });

    if (!res.ok) {
      await this.handleErrorResponse(res, `Failed to fetch order ${orderIdStr}`);
    }

    const json = await res.json();
    const parseResult = PayPalOrderResponseSchema.safeParse(json);
    if (!parseResult.success) {
      throw new EscrowAuthorizationError("PayPal get order response violates expected schema", {
        validationErrors: parseResult.error.format(),
      });
    }

    const orderResponse = parseResult.data;
    const amountVal = orderResponse.purchase_units?.[0]?.amount;
    const amount = amountVal
      ? Money.fromDecimalString(amountVal.value, amountVal.currency_code)
      : Money.zero("USD");

    return {
      orderId: asOrderId(orderResponse.id),
      status: orderResponse.status,
      amount,
      referenceId: orderResponse.purchase_units?.[0]?.reference_id,
      links: orderResponse.links ?? [],
      rawResponse: orderResponse,
    };
  }

  private formatItems(
    items: EscrowItemInput[],
    expectedCurrency: string,
  ): { itemsWire: PayPalItemWire[]; itemTotal: Money } {
    let itemTotal = Money.zero(expectedCurrency);
    const itemsWire: PayPalItemWire[] = [];

    for (const item of items) {
      const unitMoney = parseMoneyInput(item.unitAmount);
      if (unitMoney.currency !== expectedCurrency) {
        throw new MandateValidationError(
          `Item currency mismatch: item "${item.name}" has ${unitMoney.currency}, order expects ${expectedCurrency}`,
          { itemName: item.name, itemCurrency: unitMoney.currency, expectedCurrency },
        );
      }

      const qty =
        typeof item.quantity === "number" ? item.quantity : Number.parseInt(item.quantity, 10);
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new MandateValidationError(
          `Item quantity must be a positive integer, received: ${item.quantity}`,
          { itemName: item.name, quantity: item.quantity },
        );
      }

      const itemLineTotal = unitMoney.multiply(qty);
      itemTotal = itemTotal.add(itemLineTotal);

      const wireItem: PayPalItemWire = {
        name: item.name,
        quantity: String(qty),
        unit_amount: {
          currency_code: unitMoney.currency,
          value: unitMoney.toDecimalString(),
        },
      };

      if (item.description) {
        wireItem.description = item.description;
      }
      if (item.sku) {
        wireItem.sku = item.sku;
      }
      if (item.category) {
        wireItem.category = item.category;
      }

      itemsWire.push(wireItem);
    }

    return { itemsWire, itemTotal };
  }

  private async handleErrorResponse(res: Response, defaultMessage: string): Promise<never> {
    const errorText = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(errorText) as Record<string, unknown>;
    } catch {
      parsed = { rawBody: errorText };
    }

    const errorName = typeof parsed.name === "string" ? parsed.name : undefined;
    const message = typeof parsed.message === "string" ? parsed.message : defaultMessage;
    const debugId = typeof parsed.debug_id === "string" ? parsed.debug_id : undefined;

    if (res.status === 401 || res.status === 403) {
      throw new UnauthorizedError(message, {
        httpStatus: res.status,
        debugId,
        errorName,
        details: parsed,
      });
    }

    if (res.status === 404) {
      throw new NotFoundError(message, {
        httpStatus: 404,
        debugId,
        errorName,
        details: parsed,
      });
    }

    if (res.status === 409) {
      throw new ConflictError(message, {
        httpStatus: 409,
        debugId,
        errorName,
        details: parsed,
      });
    }

    if (res.status === 422 || res.status === 400) {
      throw new EscrowAuthorizationError(message, {
        httpStatus: res.status,
        debugId,
        errorName,
        details: parsed,
      });
    }

    throw new PayPalApiError(message, {
      httpStatus: res.status,
      debugId,
      paypalErrorName: errorName,
      details: parsed,
    });
  }
}
