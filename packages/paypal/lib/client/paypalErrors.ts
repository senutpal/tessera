import { ConflictError, NotFoundError, UnauthorizedError } from "@tessera/core";
import { PayPalApiError } from "../types/orders.js";

/**
 * Extracts error details from a failed PayPal API response and throws
 * the corresponding typed domain error.
 */
export async function throwPayPalError(
  res: Response,
  defaultMessage: string,
  unprocessableFactory: (message: string, details: Record<string, unknown>) => Error,
): Promise<never> {
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
    throw unprocessableFactory(message, {
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
