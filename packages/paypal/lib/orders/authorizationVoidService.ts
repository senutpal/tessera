import {
  asAuthorizationId,
  asOrderId,
  ConflictError,
  EscrowVoidError,
  MandateValidationError,
  NotFoundError,
  UnauthorizedError,
} from "@tessera/core";
import type { PayPalAuthClient } from "../client/paypalAuthClient.js";
import {
  type EscrowEventSink,
  type EscrowHoldVoidedEvent,
  type EscrowVoidResult,
  PayPalApiError,
  type VoidAuthorizationOptions,
} from "../types/orders.js";

export class AuthorizationVoidService {
  private readonly eventSink?: EscrowEventSink | undefined;

  constructor(
    private readonly authClient: PayPalAuthClient,
    options: { eventSink?: EscrowEventSink | undefined } = {},
  ) {
    this.eventSink = options.eventSink;
  }

  /**
   * Voids an active authorization hold on buyer funds (e.g. upon mandate violation or SLA breach).
   */
  public async voidAuthorization(options: VoidAuthorizationOptions): Promise<EscrowVoidResult> {
    const authIdStr = String(options.authorizationId);
    if (!authIdStr.trim()) {
      throw new MandateValidationError("Authorization ID is required to execute void.");
    }

    const path = `/v2/payments/authorizations/${encodeURIComponent(authIdStr)}/void`;
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("Prefer", "return=representation");
    if (options.requestId) {
      headers.set("PayPal-Request-Id", options.requestId);
    }

    const res = await this.authClient.fetchAuthenticated(path, {
      method: "POST",
      headers,
      body: "{}",
    });

    if (!res.ok) {
      await this.handleErrorResponse(res, `Failed to void authorization ${authIdStr}`);
    }

    let rawResponse: Record<string, unknown> | undefined;
    if (res.status === 200) {
      try {
        rawResponse = (await res.json()) as Record<string, unknown>;
      } catch {
        // empty response fallback
      }
    }

    const voidedAt = new Date().toISOString();
    const result: EscrowVoidResult = {
      authorizationId: asAuthorizationId(authIdStr),
      status: "VOIDED",
      voidedAt,
    };

    if (options.reason) {
      result.reason = options.reason;
    }
    if (rawResponse) {
      result.rawResponse = rawResponse;
    }

    if (this.eventSink) {
      const event: EscrowHoldVoidedEvent = {
        type: "ESCROW_HOLD_VOIDED",
        authorizationId: asAuthorizationId(authIdStr),
        timestamp: voidedAt,
      };
      if (options.orderId) {
        event.orderId = asOrderId(options.orderId);
      }
      if (options.amount) {
        event.amount = options.amount;
      }
      if (options.reason) {
        event.reason = options.reason;
      }

      await this.eventSink.emit(event);
    }

    return result;
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
      throw new EscrowVoidError(message, {
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
