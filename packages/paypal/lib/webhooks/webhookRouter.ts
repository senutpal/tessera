import { asAuthorizationId, asOrderId, Money } from "@tessera/core";
import {
  type ClearinghouseAuthorizationCreatedEvent,
  type ClearinghouseAuthorizationVoidedEvent,
  type ClearinghouseWebhookEvent,
  PayPalAuthorizationCreatedResourceSchema,
  PayPalAuthorizationVoidedResourceSchema,
  type PayPalWebhookAmount,
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
  private static readonly inFlightDispatches = new Map<string, Promise<WebhookProcessingResult>>();

  public readonly webhookId: string;
  public readonly verifier: WebhookSignatureVerifier;
  public readonly eventSink?: WebhookEventSink | undefined;
  private readonly handlers = new Map<string, WebhookEventHandler[]>();

  /**
   * Resets active in-flight dispatch promises (used primarily in test teardown).
   */
  public static clearInFlightDispatches(): void {
    WebhookRouter.inFlightDispatches.clear();
  }

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
    if (!request || typeof request !== "object") {
      return {
        status: "MALFORMED_PAYLOAD",
        httpStatus: 400,
        message: "Webhook request must be an object",
        error: "Missing or invalid webhook request payload",
      };
    }

    // 1. Cryptographic Signature Verification (without committing replay state yet)
    let verification: WebhookVerificationResult;
    try {
      verification = await this.verifier.verify({
        headers: request.headers,
        rawBody: request.rawBody,
        webhookId: request.webhookId ?? this.webhookId,
        options: { checkReplay: false },
      });
    } catch (err) {
      return {
        status: "INVALID_SIGNATURE",
        httpStatus: 401,
        message: (err as Error).message,
        error: (err as Error).message,
      };
    }

    if (!verification.isValid) {
      return {
        status: "INVALID_SIGNATURE",
        httpStatus: 401,
        message: verification.failureReason ?? "Webhook signature verification failed",
        transmissionId: verification.transmissionId,
        error: verification.failureReason ?? "Signature mismatch",
      };
    }

    // Check transmission ID idempotency (already successfully processed or currently in-flight)
    const isDuplicateTx = await this.verifier.idempotencyStore.has(verification.transmissionId);
    if (isDuplicateTx) {
      return {
        status: "DUPLICATE",
        httpStatus: 200,
        message: `Duplicate transmission acknowledged and ignored: ${verification.transmissionId}`,
        transmissionId: verification.transmissionId,
      };
    }

    const inFlightTx = WebhookRouter.inFlightDispatches.get(`tx:${verification.transmissionId}`);
    if (inFlightTx) {
      await inFlightTx;
      if (await this.verifier.idempotencyStore.has(verification.transmissionId)) {
        return {
          status: "DUPLICATE",
          httpStatus: 200,
          message: `Duplicate transmission acknowledged and ignored: ${verification.transmissionId}`,
          transmissionId: verification.transmissionId,
        };
      }
    }

    // 2. Parse Raw Request Body into JSON
    let rawString: string;
    try {
      if (Buffer.isBuffer(request.rawBody)) {
        rawString = request.rawBody.toString("utf8");
      } else if (typeof request.rawBody === "string") {
        rawString = request.rawBody;
      } else if (request.rawBody instanceof Uint8Array) {
        rawString = Buffer.from(request.rawBody).toString("utf8");
      } else {
        throw new Error("rawBody must be a Buffer, Uint8Array, or string");
      }
    } catch (err) {
      return {
        status: "MALFORMED_PAYLOAD",
        httpStatus: 400,
        message: `Invalid webhook raw body type: ${(err as Error).message}`,
        transmissionId: verification.transmissionId,
        error: (err as Error).message,
      };
    }

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

    // Deduplicate by business event ID across differing transmission deliveries
    const isDuplicateEvent = await this.verifier.idempotencyStore.has(`event:${event.id}`);
    if (isDuplicateEvent) {
      return {
        status: "DUPLICATE",
        httpStatus: 200,
        message: `Duplicate webhook event ID acknowledged and ignored: ${event.id}`,
        transmissionId: verification.transmissionId,
        eventType: event.event_type,
      };
    }

    const inFlightEvent = WebhookRouter.inFlightDispatches.get(`event:${event.id}`);
    if (inFlightEvent) {
      await inFlightEvent;
      if (await this.verifier.idempotencyStore.has(`event:${event.id}`)) {
        return {
          status: "DUPLICATE",
          httpStatus: 200,
          message: `Duplicate webhook event ID acknowledged and ignored: ${event.id}`,
          transmissionId: verification.transmissionId,
          eventType: event.event_type,
        };
      }
    }

    // 4. Transform & Dispatch by Event Type
    switch (event.event_type) {
      case "PAYMENT.AUTHORIZATION.CREATED": {
        let domainEvent: ClearinghouseAuthorizationCreatedEvent;
        try {
          domainEvent = this.transformAuthorizationCreated(event, verification.transmissionId);
        } catch (err) {
          return {
            status: "MALFORMED_PAYLOAD",
            httpStatus: 400,
            message: `Failed to transform PAYMENT.AUTHORIZATION.CREATED resource: ${(err as Error).message}`,
            eventType: event.event_type,
            transmissionId: verification.transmissionId,
            error: (err as Error).message,
          };
        }
        return this.dispatchEvent(
          domainEvent,
          event.event_type,
          verification.transmissionId,
          event.id,
        );
      }

      case "PAYMENT.AUTHORIZATION.VOIDED": {
        let domainEvent: ClearinghouseAuthorizationVoidedEvent;
        try {
          domainEvent = this.transformAuthorizationVoided(event, verification.transmissionId);
        } catch (err) {
          return {
            status: "MALFORMED_PAYLOAD",
            httpStatus: 400,
            message: `Failed to transform PAYMENT.AUTHORIZATION.VOIDED resource: ${(err as Error).message}`,
            eventType: event.event_type,
            transmissionId: verification.transmissionId,
            error: (err as Error).message,
          };
        }
        return this.dispatchEvent(
          domainEvent,
          event.event_type,
          verification.transmissionId,
          event.id,
        );
      }

      default: {
        await this.verifier.idempotencyStore.record(verification.transmissionId);
        await this.verifier.idempotencyStore.record(`event:${event.id}`);
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
    const parseResult = PayPalAuthorizationCreatedResourceSchema.safeParse(event.resource);
    if (!parseResult.success) {
      throw new Error(`Invalid authorization resource: ${parseResult.error.message}`);
    }
    const resource = parseResult.data;
    const authorizationId = asAuthorizationId(resource.id.trim());

    const relatedIds = (resource.supplementary_data as Record<string, unknown> | undefined)
      ?.related_ids as Record<string, unknown> | undefined;
    const orderIdRaw = relatedIds?.order_id ?? resource.order_id;
    const orderIdStr =
      typeof orderIdRaw === "string" && orderIdRaw.trim().length > 0
        ? orderIdRaw.trim()
        : undefined;

    const customId = resource.custom_id ? resource.custom_id.trim() : undefined;
    const parentPayment = resource.parent_payment ? resource.parent_payment.trim() : undefined;
    const amount = this.parseMoney(resource.amount);
    const status = resource.status
      ? resource.status.trim()
      : resource.state
        ? resource.state.trim()
        : "CREATED";
    const createTime = resource.create_time ?? event.create_time ?? new Date().toISOString();
    const expirationTime = resource.expiration_time;

    return {
      type: "PAYMENT.AUTHORIZATION.CREATED",
      authorizationId,
      orderId: orderIdStr ? asOrderId(orderIdStr) : undefined,
      amount,
      status,
      createTime,
      expirationTime,
      parentPayment,
      customId,
      rawResource: event.resource,
      transmissionId,
      timestamp: event.create_time ?? new Date().toISOString(),
    };
  }

  private transformAuthorizationVoided(
    event: { resource: Record<string, unknown>; create_time?: string | undefined },
    transmissionId: string,
  ): ClearinghouseAuthorizationVoidedEvent {
    const parseResult = PayPalAuthorizationVoidedResourceSchema.safeParse(event.resource);
    if (!parseResult.success) {
      throw new Error(`Invalid authorization void resource: ${parseResult.error.message}`);
    }
    const resource = parseResult.data;
    const authorizationId = asAuthorizationId(resource.id.trim());

    const relatedIds = (resource.supplementary_data as Record<string, unknown> | undefined)
      ?.related_ids as Record<string, unknown> | undefined;
    const orderIdRaw = relatedIds?.order_id ?? resource.order_id;
    const orderIdStr =
      typeof orderIdRaw === "string" && orderIdRaw.trim().length > 0
        ? orderIdRaw.trim()
        : undefined;

    const customId = resource.custom_id ? resource.custom_id.trim() : undefined;
    const parentPayment = resource.parent_payment ? resource.parent_payment.trim() : undefined;
    const amount = resource.amount ? this.parseMoney(resource.amount) : undefined;
    const reason = resource.status_details?.reason;
    const updateTime = resource.update_time;

    return {
      type: "PAYMENT.AUTHORIZATION.VOIDED",
      authorizationId,
      orderId: orderIdStr ? asOrderId(orderIdStr) : undefined,
      amount,
      reason,
      status: "VOIDED",
      updateTime,
      parentPayment,
      customId,
      rawResource: event.resource,
      transmissionId,
      timestamp: event.create_time ?? new Date().toISOString(),
    };
  }

  private parseMoney(rawAmount: PayPalWebhookAmount): Money {
    const rawCurrency = rawAmount.currency_code ?? rawAmount.currency;
    const rawValue = rawAmount.value ?? rawAmount.total;
    if (!rawCurrency || !rawValue) {
      throw new Error("Missing required currency or value in amount");
    }
    const currency = rawCurrency.trim().toUpperCase();
    const value = rawValue.trim();
    return Money.fromPayPal({ currency_code: currency, value });
  }

  private async dispatchEvent(
    domainEvent: ClearinghouseWebhookEvent,
    eventType: string,
    transmissionId: string,
    eventId: string,
  ): Promise<WebhookProcessingResult> {
    const inFlightEventKey = `event:${eventId}`;
    const inFlightTxKey = `tx:${transmissionId}`;

    const executeDispatch = async (): Promise<WebhookProcessingResult> => {
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

        // Successful dispatch: commit transmission ID and event ID atomically
        await this.verifier.idempotencyStore.record(transmissionId);
        await this.verifier.idempotencyStore.record(`event:${eventId}`);

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
      } finally {
        WebhookRouter.inFlightDispatches.delete(inFlightEventKey);
        WebhookRouter.inFlightDispatches.delete(inFlightTxKey);
      }
    };

    const dispatchPromise = executeDispatch();
    WebhookRouter.inFlightDispatches.set(inFlightEventKey, dispatchPromise);
    WebhookRouter.inFlightDispatches.set(inFlightTxKey, dispatchPromise);

    return dispatchPromise;
  }
}
