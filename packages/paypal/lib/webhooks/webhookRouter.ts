import { asAuthorizationId, asOrderId, Money } from "@tessera/core";
import {
  type ClearinghouseAuthorizationCreatedEvent,
  type ClearinghouseAuthorizationVoidedEvent,
  type ClearinghouseWebhookEvent,
  PayPalWebhookEventSchema,
  type WebhookEventSink,
  type WebhookProcessingResult,
  type WebhookRequest,
  type WebhookVerificationResult,
} from "../types/webhooks.js";
import { WebhookSignatureVerifier } from "./webhookSignatureVerifier.js";

export type WebhookEventHandler = (event: ClearinghouseWebhookEvent) => Promise<void> | void;

export interface WebhookRouterConfig {
  webhookId: string;
  verifier?: WebhookSignatureVerifier | undefined;
  eventSink?: WebhookEventSink | undefined;
}

/**
 * Webhook Router & Event Dispatcher for PayPal Notifications.
 *
 * Verifies inbound webhook cryptographic authenticity, guards against replays,
 * parses PayPal event resources, transforms them into typed clearinghouse domain events,
 * and dispatches them safely to internal event sinks and listeners.
 */
export class WebhookRouter {
  public readonly webhookId: string;
  public readonly verifier: WebhookSignatureVerifier;
  public readonly eventSink?: WebhookEventSink | undefined;
  private readonly handlers = new Map<string, WebhookEventHandler[]>();

  constructor(config: WebhookRouterConfig) {
    this.webhookId = config.webhookId;
    this.verifier =
      config.verifier ?? new WebhookSignatureVerifier({ defaultWebhookId: config.webhookId });
    this.eventSink = config.eventSink;
  }

  /**
   * Registers an event handler for a specific PayPal event type (e.g. `PAYMENT.AUTHORIZATION.CREATED`),
   * or `*` for all routed events.
   */
  public on(eventType: string, handler: WebhookEventHandler): this {
    const list = this.handlers.get(eventType) ?? [];
    list.push(handler);
    this.handlers.set(eventType, list);
    return this;
  }

  /**
   * Primary entry point for ingesting and processing an incoming PayPal webhook HTTP request.
   *
   * Guarantees zero unhandled exceptions: all validation, replay, parsing, and dispatch
   * results are encapsulated into a typed `WebhookProcessingResult` with HTTP status guidance.
   */
  public async handleWebhook(request: WebhookRequest): Promise<WebhookProcessingResult> {
    // 1. Cryptographic Signature & Idempotency Verification
    let verification: WebhookVerificationResult;
    try {
      verification = await this.verifier.verify({
        headers: request.headers,
        rawBody: request.rawBody,
        webhookId: request.webhookId ?? this.webhookId,
      });
    } catch (err) {
      return {
        status: "INVALID_SIGNATURE",
        httpStatus: 401,
        message: `Webhook signature verification rejected: ${(err as Error).message}`,
        error: (err as Error).message,
      };
    }

    if (!verification.isValid) {
      return {
        status: "INVALID_SIGNATURE",
        httpStatus: 401,
        message: "Webhook signature verification failed",
        transmissionId: verification.transmissionId,
        error: verification.failureReason ?? "Signature mismatch",
      };
    }

    if (verification.isDuplicate) {
      return {
        status: "DUPLICATE",
        httpStatus: 200,
        message: "Duplicate transmission acknowledged and ignored",
        transmissionId: verification.transmissionId,
      };
    }

    // 2. Parse Raw Request Body into JSON
    const rawString = Buffer.isBuffer(request.rawBody)
      ? request.rawBody.toString("utf8")
      : typeof request.rawBody === "string"
        ? request.rawBody
        : Buffer.from(request.rawBody).toString("utf8");

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawString);
    } catch (err) {
      return {
        status: "MALFORMED_PAYLOAD",
        httpStatus: 400,
        message: "Webhook body is not valid JSON",
        transmissionId: verification.transmissionId,
        error: (err as Error).message,
      };
    }

    // 3. Validate Webhook Event Envelope
    const parseResult = PayPalWebhookEventSchema.safeParse(parsedJson);
    if (!parseResult.success) {
      return {
        status: "MALFORMED_PAYLOAD",
        httpStatus: 400,
        message: "Webhook payload does not match PayPal event envelope schema",
        transmissionId: verification.transmissionId,
        error: parseResult.error.message,
      };
    }

    const event = parseResult.data;

    // 4. Transform & Dispatch by Event Type
    switch (event.event_type) {
      case "PAYMENT.AUTHORIZATION.CREATED": {
        const domainEvent = this.transformAuthorizationCreated(event, verification.transmissionId);
        return this.dispatchEvent(domainEvent, event.event_type, verification.transmissionId);
      }

      case "PAYMENT.AUTHORIZATION.VOIDED": {
        const domainEvent = this.transformAuthorizationVoided(event, verification.transmissionId);
        return this.dispatchEvent(domainEvent, event.event_type, verification.transmissionId);
      }

      default: {
        return {
          status: "IGNORED",
          httpStatus: 200,
          message: `Ignored unhandled event type: ${event.event_type}`,
          eventType: event.event_type,
          transmissionId: verification.transmissionId,
        };
      }
    }
  }

  private transformAuthorizationCreated(
    event: { resource: Record<string, unknown>; create_time?: string | undefined },
    transmissionId: string,
  ): ClearinghouseAuthorizationCreatedEvent {
    const resource = event.resource;
    const authIdStr = String(resource.id ?? "");
    const authorizationId = asAuthorizationId(authIdStr);

    const relatedIds = (resource.supplementary_data as Record<string, unknown> | undefined)
      ?.related_ids as Record<string, unknown> | undefined;
    const orderIdStr = relatedIds?.order_id
      ? String(relatedIds.order_id)
      : resource.parent_payment
        ? String(resource.parent_payment)
        : resource.custom_id
          ? String(resource.custom_id)
          : undefined;

    const amount = this.extractMoney(resource.amount);
    const status = String(resource.status ?? resource.state ?? "CREATED");
    const createTime = String(
      resource.create_time ?? event.create_time ?? new Date().toISOString(),
    );
    const expirationTime = resource.expiration_time ? String(resource.expiration_time) : undefined;
    const parentPayment = resource.parent_payment ? String(resource.parent_payment) : undefined;

    return {
      type: "PAYMENT.AUTHORIZATION.CREATED",
      authorizationId,
      orderId: orderIdStr ? asOrderId(orderIdStr) : undefined,
      amount,
      status,
      createTime,
      expirationTime,
      parentPayment,
      rawResource: resource,
      transmissionId,
      timestamp: event.create_time ?? new Date().toISOString(),
    };
  }

  private transformAuthorizationVoided(
    event: { resource: Record<string, unknown>; create_time?: string | undefined },
    transmissionId: string,
  ): ClearinghouseAuthorizationVoidedEvent {
    const resource = event.resource;
    const authIdStr = String(resource.id ?? "");
    const authorizationId = asAuthorizationId(authIdStr);

    const relatedIds = (resource.supplementary_data as Record<string, unknown> | undefined)
      ?.related_ids as Record<string, unknown> | undefined;
    const orderIdStr = relatedIds?.order_id
      ? String(relatedIds.order_id)
      : resource.parent_payment
        ? String(resource.parent_payment)
        : resource.custom_id
          ? String(resource.custom_id)
          : undefined;

    const amount = resource.amount ? this.extractMoney(resource.amount) : undefined;
    const statusDetails = resource.status_details as Record<string, unknown> | undefined;
    const reason = statusDetails?.reason ? String(statusDetails.reason) : undefined;
    const updateTime = resource.update_time ? String(resource.update_time) : undefined;

    return {
      type: "PAYMENT.AUTHORIZATION.VOIDED",
      authorizationId,
      orderId: orderIdStr ? asOrderId(orderIdStr) : undefined,
      amount,
      reason,
      status: "VOIDED",
      updateTime,
      rawResource: resource,
      transmissionId,
      timestamp: event.create_time ?? new Date().toISOString(),
    };
  }

  private extractMoney(rawAmount: unknown): Money {
    if (!rawAmount || typeof rawAmount !== "object") {
      return Money.zero("USD");
    }
    const record = rawAmount as Record<string, unknown>;
    const currency = String(record.currency_code ?? record.currency ?? "USD");
    const value = String(record.value ?? record.total ?? "0.00");
    return Money.fromPayPal({ currency_code: currency, value });
  }

  private async dispatchEvent(
    domainEvent: ClearinghouseWebhookEvent,
    eventType: string,
    transmissionId: string,
  ): Promise<WebhookProcessingResult> {
    try {
      if (this.eventSink) {
        await this.eventSink.emit(domainEvent);
      }

      const specificHandlers = this.handlers.get(eventType) ?? [];
      const wildcardHandlers = this.handlers.get("*") ?? [];
      const allHandlers = [...specificHandlers, ...wildcardHandlers];

      for (const handler of allHandlers) {
        await handler(domainEvent);
      }

      return {
        status: "PROCESSED",
        httpStatus: 200,
        message: `Successfully processed and dispatched event: ${eventType}`,
        eventType,
        domainEvent,
        transmissionId,
      };
    } catch (err) {
      return {
        status: "DISPATCH_ERROR",
        httpStatus: 500,
        message: `Error during domain event dispatch for ${eventType}: ${(err as Error).message}`,
        eventType,
        domainEvent,
        transmissionId,
        error: (err as Error).message,
      };
    }
  }
}
