import { asTransactionId, DisputeError, MandateValidationError, Money } from "@tessera/core";
import type { PayPalAuthClient } from "../client/paypalAuthClient.js";
import { throwPayPalError } from "../client/paypalErrors.js";
import {
  type ClearinghouseDispute,
  type ClearinghouseDisputeOutcome,
  ClearinghouseDisputeStatus,
  DisputeAction,
  type DisputeSearchResult,
  type ListDisputesOptions,
  type PayPalDisputeInfoWire,
  type PayPalDisputeOutcomeWire,
  PayPalDisputeSearchResponseSchema,
  type PayPalDisputeWire,
  PayPalDisputeWireSchema,
} from "../types/disputes.js";

/**
 * Normalizes raw PayPal dispute wire data into the domain `ClearinghouseDispute` model.
 */
export function normalizePayPalDispute(
  wire: PayPalDisputeWire | PayPalDisputeInfoWire,
): ClearinghouseDispute {
  const disputeId = String(wire.dispute_id ?? "").trim();
  if (!disputeId) {
    throw new MandateValidationError("Dispute wire payload is missing dispute_id", { wire });
  }

  // Extract transaction ID
  let transactionIdStr = "";
  if ("disputed_transactions" in wire && Array.isArray(wire.disputed_transactions)) {
    const primaryTx = wire.disputed_transactions[0];
    if (primaryTx) {
      transactionIdStr =
        primaryTx.seller_transaction_id ??
        primaryTx.buyer_transaction_id ??
        primaryTx.reference_id ??
        "";
    }
  }
  if (!transactionIdStr) {
    transactionIdStr = disputeId;
  }
  const transactionId = asTransactionId(transactionIdStr);

  // Map status
  const rawStatus = (wire.status ?? "").toUpperCase();
  let status: ClearinghouseDisputeStatus;
  switch (rawStatus) {
    case "OPEN":
      status = ClearinghouseDisputeStatus.OPEN;
      break;
    case "WAITING_FOR_BUYER_RESPONSE":
      status = ClearinghouseDisputeStatus.WAITING_FOR_BUYER;
      break;
    case "WAITING_FOR_SELLER_RESPONSE":
      status = ClearinghouseDisputeStatus.WAITING_FOR_SELLER;
      break;
    case "UNDER_REVIEW":
    case "UNDER_PAYPAL_REVIEW":
      status = ClearinghouseDisputeStatus.UNDER_REVIEW;
      break;
    case "RESOLVED":
      status = ClearinghouseDisputeStatus.RESOLVED;
      break;
    default:
      status = ClearinghouseDisputeStatus.OTHER;
      break;
  }

  // Parse dispute amount
  let disputeAmount = Money.zero("USD");
  if (wire.dispute_amount?.value && wire.dispute_amount.currency_code) {
    try {
      disputeAmount = Money.fromDecimalString(
        wire.dispute_amount.value,
        wire.dispute_amount.currency_code,
      );
    } catch {
      disputeAmount = Money.zero("USD");
    }
  }

  // Parse outcome if present
  let outcome: ClearinghouseDisputeOutcome | undefined;
  if ("dispute_outcome" in wire && wire.dispute_outcome) {
    const rawOutcome = wire.dispute_outcome as PayPalDisputeOutcomeWire;
    let refunded: Money | undefined;
    if (rawOutcome.amount_refunded?.value && rawOutcome.amount_refunded.currency_code) {
      try {
        refunded = Money.fromDecimalString(
          rawOutcome.amount_refunded.value,
          rawOutcome.amount_refunded.currency_code,
        );
      } catch {
        refunded = undefined;
      }
    }
    outcome = {
      outcomeCode: rawOutcome.outcome_code ?? "NONE",
      outcomeReason: rawOutcome.outcome_reason,
      amountRefunded: refunded,
    };
  }

  // Derive allowed actions from HATEOAS links or status
  const allowedActionsSet = new Set<DisputeAction>();
  const hasLinks = Array.isArray(wire.links);
  if (hasLinks) {
    for (const link of wire.links ?? []) {
      const rel = (link.rel ?? "").toLowerCase();
      if (rel === "provide-evidence" || rel === "evidence") {
        allowedActionsSet.add(DisputeAction.PROVIDE_EVIDENCE);
      } else if (rel === "accept-claim") {
        allowedActionsSet.add(DisputeAction.ACCEPT_CLAIM);
      } else if (rel === "escalate") {
        allowedActionsSet.add(DisputeAction.ESCALATE);
      } else if (rel === "appeal") {
        allowedActionsSet.add(DisputeAction.APPEAL);
      } else if (rel === "send-message") {
        allowedActionsSet.add(DisputeAction.SEND_MESSAGE);
      }
    }
  } else {
    // If links were omitted entirely (e.g. some summary listings), infer standard actions from status
    if (status === ClearinghouseDisputeStatus.WAITING_FOR_SELLER) {
      allowedActionsSet.add(DisputeAction.PROVIDE_EVIDENCE);
      allowedActionsSet.add(DisputeAction.ACCEPT_CLAIM);
      allowedActionsSet.add(DisputeAction.ESCALATE);
    } else if (status === ClearinghouseDisputeStatus.OPEN) {
      allowedActionsSet.add(DisputeAction.ACCEPT_CLAIM);
      allowedActionsSet.add(DisputeAction.ESCALATE);
      allowedActionsSet.add(DisputeAction.SEND_MESSAGE);
    }
  }

  return {
    disputeId,
    transactionId,
    status,
    state: wire.dispute_state ?? "UNKNOWN",
    stage: wire.dispute_life_cycle_stage ?? "INQUIRY",
    reason: wire.reason ?? "OTHER",
    disputeAmount,
    createTime: wire.create_time ?? new Date().toISOString(),
    updateTime: wire.update_time ?? new Date().toISOString(),
    sellerResponseDueDate: wire.seller_response_due_date,
    buyerResponseDueDate: wire.buyer_response_due_date,
    outcome,
    allowedActions: Array.from(allowedActionsSet),
    raw: wire,
  };
}

export class DisputesService {
  constructor(private readonly authClient: PayPalAuthClient) {}

  /**
   * Lists customer disputes from PayPal Customer Disputes API v1
   * via GET /v1/customer/disputes.
   */
  public async listDisputes(options: ListDisputesOptions = {}): Promise<DisputeSearchResult> {
    const queryParams = new URLSearchParams();

    if (options.disputedTransactionId) {
      queryParams.set("disputed_transaction_id", String(options.disputedTransactionId).trim());
    }
    if (options.disputeState) {
      queryParams.set("dispute_state", String(options.disputeState).trim());
    }
    if (options.disputeLifeCycleStage) {
      queryParams.set("dispute_life_cycle_stage", String(options.disputeLifeCycleStage).trim());
    }
    if (options.pageSize !== undefined) {
      if (options.pageSize < 1 || options.pageSize > 100) {
        throw new MandateValidationError("pageSize must be between 1 and 100", {
          pageSize: options.pageSize,
        });
      }
      queryParams.set("page_size", String(options.pageSize));
    }
    if (options.nextPageToken) {
      queryParams.set("next_page_token", String(options.nextPageToken).trim());
    }
    if (options.startTime) {
      queryParams.set("start_time", String(options.startTime).trim());
    }
    if (options.updateTimeBefore) {
      queryParams.set("update_time_before", String(options.updateTimeBefore).trim());
    }
    if (options.updateTimeAfter) {
      queryParams.set("update_time_after", String(options.updateTimeAfter).trim());
    }

    const qs = queryParams.toString();
    const endpoint = `/v1/customer/disputes${qs ? `?${qs}` : ""}`;

    const res = await this.authClient.fetchAuthenticated(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      await throwPayPalError(
        res,
        "Failed to list customer disputes from PayPal API",
        (msg, d) => new DisputeError(msg, d),
      );
    }

    const rawData = (await res.json()) as unknown;
    const parsed = PayPalDisputeSearchResponseSchema.safeParse(rawData);
    if (!parsed.success) {
      throw new DisputeError("Failed to parse PayPal dispute search response", {
        errors: parsed.error.format(),
        raw: rawData,
      });
    }

    const wireData = parsed.data;
    const disputes = (wireData.items ?? []).map((item) => normalizePayPalDispute(item));

    // Extract next page token if available in HATEOAS links
    let nextPageToken: string | undefined;
    const nextLink = wireData.links?.find((l) => l.rel === "next");
    if (nextLink?.href) {
      try {
        const nextUrl = new URL(nextLink.href);
        nextPageToken = nextUrl.searchParams.get("next_page_token") ?? undefined;
      } catch {
        nextPageToken = undefined;
      }
    }

    return {
      disputes,
      totalItems: wireData.total_items,
      totalPages: wireData.total_pages,
      links: wireData.links ?? [],
      nextPageToken,
    };
  }

  /**
   * Retrieves full details for a customer dispute
   * via GET /v1/customer/disputes/{dispute_id}.
   */
  public async getDispute(disputeId: string): Promise<ClearinghouseDispute> {
    const trimmedId = String(disputeId ?? "").trim();
    if (!trimmedId) {
      throw new MandateValidationError("Dispute ID is required to fetch dispute details");
    }

    const endpoint = `/v1/customer/disputes/${encodeURIComponent(trimmedId)}`;
    const res = await this.authClient.fetchAuthenticated(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      await throwPayPalError(
        res,
        `Failed to retrieve dispute details for ${trimmedId}`,
        (msg, d) => new DisputeError(msg, d),
      );
    }

    const rawData = (await res.json()) as unknown;
    const parsed = PayPalDisputeWireSchema.safeParse(rawData);
    if (!parsed.success) {
      throw new DisputeError(`Failed to parse PayPal dispute response for dispute ${trimmedId}`, {
        errors: parsed.error.format(),
        raw: rawData,
      });
    }

    return normalizePayPalDispute(parsed.data);
  }
}
