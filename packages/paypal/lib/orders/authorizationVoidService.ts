import {
  asAuthorizationId,
  asOrderId,
  EscrowVoidError,
  MandateValidationError,
  Money,
} from "@tessera/core";
import type { PayPalAuthClient } from "../client/paypalAuthClient.js";
import { throwPayPalError } from "../client/paypalErrors.js";
import type {
  EscrowEventSink,
  EscrowHoldVoidedEvent,
  EscrowVoidResult,
  VoidAuthorizationOptions,
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
    if (!options.authorizationId || !String(options.authorizationId).trim()) {
      throw new MandateValidationError("Authorization ID is required to execute void.");
    }
    const authIdStr = String(options.authorizationId).trim();

    const path = `/v2/payments/authorizations/${encodeURIComponent(authIdStr)}/void`;
    const requestId = options.requestId ?? crypto.randomUUID();
    const headers = new Headers();
    headers.set("Prefer", "return=representation");
    headers.set("PayPal-Request-Id", requestId);

    const res = await this.authClient.fetchAuthenticated(path, {
      method: "POST",
      headers,
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

    if (rawResponse && typeof rawResponse.status === "string" && rawResponse.status !== "VOIDED") {
      throw new EscrowVoidError(
        `PayPal authorization void failed: status returned was ${rawResponse.status}, expected VOIDED`,
        { authorizationId: authIdStr, status: rawResponse.status, rawResponse },
      );
    }

    let voidedAmount: Money | undefined = options.amount;
    if (
      !voidedAmount &&
      rawResponse &&
      typeof rawResponse.amount === "object" &&
      rawResponse.amount !== null
    ) {
      const amtObj = rawResponse.amount as Record<string, unknown>;
      if (typeof amtObj.currency_code === "string" && typeof amtObj.value === "string") {
        try {
          voidedAmount = Money.fromDecimalString(amtObj.value, amtObj.currency_code);
        } catch {
          // ignore parsing error if non-standard
        }
      }
    }

    const voidedAt = new Date().toISOString();
    const result: EscrowVoidResult = {
      authorizationId: asAuthorizationId(authIdStr),
      status: "VOIDED",
      voidedAt,
      requestId,
    };

    if (voidedAmount) {
      result.amount = voidedAmount;
    }
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
        requestId,
      };
      if (options.orderId) {
        event.orderId = asOrderId(options.orderId);
      }
      if (voidedAmount) {
        event.amount = voidedAmount;
      }
      if (options.reason) {
        event.reason = options.reason;
      }

      try {
        await this.eventSink.emit(event);
      } catch (emitErr: unknown) {
        // Void already succeeded at PayPal; do not report it as a failed void.
        result.eventEmitError = emitErr instanceof Error ? emitErr.message : String(emitErr);
      }
    }

    return result;
  }

  /**
   * Fetches the current state of an authorization by ID.
   */
  public async getAuthorization(authorizationId: string): Promise<{
    id: string;
    status: string;
    amount?: { currency_code: string; value: string } | undefined;
    rawResponse?: Record<string, unknown> | undefined;
  }> {
    if (!authorizationId || !String(authorizationId).trim()) {
      throw new MandateValidationError("Authorization ID is required to fetch authorization.");
    }
    const authIdStr = String(authorizationId).trim();
    const path = `/v2/payments/authorizations/${encodeURIComponent(authIdStr)}`;
    const res = await this.authClient.fetchAuthenticated(path, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      await this.handleErrorResponse(res, `Failed to get authorization ${authIdStr}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    return {
      id: String(json.id ?? authIdStr),
      status: String(json.status ?? "UNKNOWN"),
      amount: json.amount as { currency_code: string; value: string } | undefined,
      rawResponse: json,
    };
  }

  private handleErrorResponse(res: Response, defaultMessage: string): Promise<never> {
    return throwPayPalError(
      res,
      defaultMessage,
      (msg, details) => new EscrowVoidError(msg, details),
    );
  }
}
