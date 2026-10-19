import {
  asAuthorizationId,
  asOrderId,
  ConflictError,
  EscrowVoidError,
  MandateValidationError,
  Money,
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
    const debugId = typeof parsed.debug_id === "string" ? parsed.debug_id : undefined;

    const detailsList = Array.isArray(parsed.details) ? parsed.details : [];
    const detailsSummary = detailsList
      .map((d: unknown) => {
        if (typeof d === "object" && d !== null) {
          const item = d as Record<string, unknown>;
          const issue = typeof item.issue === "string" ? item.issue : "";
          const desc = typeof item.description === "string" ? item.description : "";
          if (issue && desc) return `${issue}: ${desc}`;
          return issue || desc;
        }
        return "";
      })
      .filter(Boolean)
      .join("; ");

    const baseMessage = typeof parsed.message === "string" ? parsed.message : defaultMessage;
    const message = detailsSummary ? `${baseMessage} (${detailsSummary})` : baseMessage;

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
