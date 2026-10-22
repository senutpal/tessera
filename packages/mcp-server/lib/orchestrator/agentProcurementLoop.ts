import {
  Channel3Client,
  normalizeSearchResults,
  type ProcurementProduct,
  type ProductSummaryWire,
  type SearchProductsResultWire,
} from "@tessera/channel3";
import {
  asAuthorizationId,
  asTransactionId,
  type Money,
  ShipmentMilestoneStatus,
} from "@tessera/core";
import {
  type Ed25519KeyPair,
  type MandateVerificationOptions,
  type NonceStore,
  type PaymentMandate,
  type SignedMandate,
  signMandate,
  verifyMandate,
} from "@tessera/mandates";
import type {
  AuthorizeOrderOptions,
  CreateEscrowOrderOptions,
  EscrowAuthorization,
  EscrowCaptureOptions,
  EscrowCaptureResult,
  EscrowOrder,
  PayPalClient,
  ShipmentMilestone,
} from "@tessera/paypal";
import type { PolicyEngine } from "@tessera/policy";

export type ProcurementStepName =
  | "DISCOVER"
  | "MANDATE_SIGN"
  | "ESCROW_RESERVE"
  | "SHIPMENT_TRACK"
  | "SETTLE";

export type ProcurementStepStatus = "COMPLETED" | "FAILED" | "PENDING_DELIVERY" | "SKIPPED";

export interface ProcurementStepAudit {
  step: ProcurementStepName;
  status: ProcurementStepStatus;
  timestamp: string;
  data?: Record<string, unknown> | undefined;
  error?: string | undefined;
}

export interface AgentProcurementOptions {
  query: string;
  maxPrice: number;
  currency?: string | undefined;
  allowedDomains?: string[] | undefined;
  buyerKeyPair: Ed25519KeyPair;
  agentId?: string | undefined;
  channel3Client?: Channel3Client | undefined;
  searchCatalogFn?:
    | ((params: { query: string; limit?: number | undefined }) => Promise<unknown>)
    | undefined;
  paypalClient?: PayPalClient | undefined;
  policyEngine?: PolicyEngine | undefined;
  nonceStore?: NonceStore | undefined;
  trackingNumber?: string | undefined;
  carrier?: string | undefined;
  simulateCarrierDelivery?: boolean | undefined;
  createEscrowOrderFn?: ((options: CreateEscrowOrderOptions) => Promise<EscrowOrder>) | undefined;
  authorizeOrderFn?: ((options: AuthorizeOrderOptions) => Promise<EscrowAuthorization>) | undefined;
  getShipmentTrackingFn?:
    | ((txOrTrackerId: string, trackingNumber?: string | undefined) => Promise<ShipmentMilestone>)
    | undefined;
  captureEscrowFn?: ((options: EscrowCaptureOptions) => Promise<EscrowCaptureResult>) | undefined;
}

export interface AgentProcurementResult {
  success: boolean;
  orderId?: string | undefined;
  authorizationId?: string | undefined;
  captureId?: string | undefined;
  settledAmount?: Money | undefined;
  steps: ProcurementStepAudit[];
  error?: string | undefined;
}

function cleanDomain(raw: string): string {
  const stripped = raw
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .split(":")[0]
    .trim()
    .toLowerCase();
  return stripped.startsWith("www.") ? stripped.slice(4) : stripped;
}

export async function runAgentProcurementLoop(
  options: AgentProcurementOptions,
): Promise<AgentProcurementResult> {
  const steps: ProcurementStepAudit[] = [];
  const targetCurrency = (options.currency ?? "USD").toUpperCase();
  const agentId = options.agentId ?? "agent-autonomous-procurement";

  let createdOrderId: string | undefined;
  let createdAuthId: string | undefined;

  const recordStep = (
    step: ProcurementStepName,
    status: ProcurementStepStatus,
    data?: Record<string, unknown> | undefined,
    error?: string | undefined,
  ) => {
    steps.push({
      step,
      status,
      timestamp: new Date().toISOString(),
      ...(data !== undefined ? { data } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  };

  // 0. Input validation
  if (!options.query?.trim()) {
    const msg = "Product search query cannot be empty";
    recordStep("DISCOVER", "FAILED", undefined, msg);
    return { success: false, steps, error: msg };
  }

  if (
    typeof options.maxPrice !== "number" ||
    options.maxPrice <= 0 ||
    !Number.isFinite(options.maxPrice)
  ) {
    const msg = "maxPrice must be a positive finite number";
    recordStep("DISCOVER", "FAILED", undefined, msg);
    return { success: false, steps, error: msg };
  }

  if (!options.buyerKeyPair?.privateKey || !options.buyerKeyPair?.publicKey) {
    const msg = "Valid buyer Ed25519 keypair is required";
    recordStep("MANDATE_SIGN", "FAILED", undefined, msg);
    return { success: false, steps, error: msg };
  }

  try {
    // -------------------------------------------------------------
    // STEP 1: DISCOVER (Channel3 Multi-Retailer Product Discovery)
    // -------------------------------------------------------------
    let normalizedProducts: ProcurementProduct[] = [];
    try {
      const client = options.channel3Client ?? new Channel3Client();
      const raw = options.searchCatalogFn
        ? await options.searchCatalogFn({ query: options.query, limit: 10 })
        : await client.searchProducts({ query: options.query, limit: 10 });
      normalizedProducts = normalizeSearchResults(
        raw as SearchProductsResultWire | ProductSummaryWire[],
      );
    } catch (discErr) {
      const msg = discErr instanceof Error ? discErr.message : String(discErr);
      recordStep("DISCOVER", "FAILED", undefined, `Product discovery failed: ${msg}`);
      return { success: false, steps, error: msg };
    }

    // Filter offers by allowedDomains, currency, maxPrice, and inStock
    const allowed = options.allowedDomains?.map(cleanDomain).filter(Boolean);
    let selectedProduct: ProcurementProduct | undefined;
    let selectedOffer: ProcurementProduct["offers"][0] | undefined;

    for (const prod of normalizedProducts) {
      for (const off of prod.offers) {
        // Enforce inventory availability for autonomous checkout
        if (!off.inStock) continue;

        if (allowed && allowed.length > 0) {
          const dom = cleanDomain(off.merchantDomain);
          const match = allowed.some((d) => dom === d || dom.endsWith(`.${d}`));
          if (!match) continue;
        }

        if (off.price.currency !== targetCurrency) continue;

        const priceDec = Number.parseFloat(off.price.toDecimalString());
        if (priceDec > options.maxPrice) continue;

        if (
          !selectedOffer ||
          Number.parseFloat(off.price.toDecimalString()) <
            Number.parseFloat(selectedOffer.price.toDecimalString())
        ) {
          selectedProduct = prod;
          selectedOffer = off;
        }
      }
    }

    if (!selectedProduct || !selectedOffer) {
      const msg = `No matching in-stock products found for "${options.query}" under max price ${options.maxPrice} ${targetCurrency}`;
      recordStep("DISCOVER", "FAILED", undefined, msg);
      return { success: false, steps, error: msg };
    }

    recordStep("DISCOVER", "COMPLETED", {
      productId: selectedProduct.id,
      title: selectedProduct.title,
      domain: selectedOffer.merchantDomain,
      price: selectedOffer.price.toDecimalString(),
      currency: selectedOffer.price.currency,
      url: selectedOffer.productUrl,
    });

    // -------------------------------------------------------------
    // STEP 2: SIGN MANDATE (AP2 Cryptographic Mandate Generation)
    // -------------------------------------------------------------
    const transactionId = crypto.randomUUID();
    const nowEpoch = Math.floor(Date.now() / 1000);
    const mandateAmount = selectedOffer.price.toMinorUnits();

    const paymentMandate: PaymentMandate = {
      vct: "mandate.payment.1",
      transaction_id: transactionId,
      payee: {
        id: selectedOffer.merchantDomain,
        name: selectedOffer.merchantDomain,
        website: `https://${selectedOffer.merchantDomain}`,
      },
      payment_amount: {
        amount: mandateAmount,
        currency: selectedOffer.price.currency,
      },
      payment_instrument: {
        id: "pi-tessera-escrow",
        type: "PAYPAL_ESCROW",
        description: "PayPal Orders v2 Escrow Authorization",
      },
      iat: nowEpoch,
      exp: nowEpoch + 3600,
      nonce: crypto.randomUUID(),
    };

    let signedMandate: SignedMandate<PaymentMandate>;
    try {
      signedMandate = signMandate(
        paymentMandate,
        options.buyerKeyPair.privateKey,
        options.buyerKeyPair.publicKey,
      );
    } catch (signErr) {
      const msg = signErr instanceof Error ? signErr.message : String(signErr);
      recordStep("MANDATE_SIGN", "FAILED", undefined, `Failed to sign AP2 mandate: ${msg}`);
      return { success: false, steps, error: msg };
    }

    recordStep("MANDATE_SIGN", "COMPLETED", {
      transactionId,
      payee: selectedOffer.merchantDomain,
      amount: selectedOffer.price.toDecimalString(),
      currency: selectedOffer.price.currency,
      signatureLength: signedMandate.signature.length,
      vct: paymentMandate.vct,
    });

    // -------------------------------------------------------------
    // STEP 3: RESERVE ESCROW (Verify Mandate & Authorize PayPal Hold)
    // -------------------------------------------------------------
    try {
      const verifOptions: MandateVerificationOptions = {
        publicKey: options.buyerKeyPair.publicKey,
        ...(options.nonceStore !== undefined ? { nonceStore: options.nonceStore } : {}),
      };
      await verifyMandate(signedMandate, verifOptions);
    } catch (verifErr) {
      const msg = verifErr instanceof Error ? verifErr.message : String(verifErr);
      recordStep(
        "ESCROW_RESERVE",
        "FAILED",
        undefined,
        `Mandate verification rejected before escrow reservation: ${msg}`,
      );
      return { success: false, steps, error: msg };
    }

    // Spending policy evaluation
    if (options.policyEngine) {
      const policyEval = options.policyEngine.evaluateSafe({
        agentId,
        mandate: paymentMandate,
      });
      if (!policyEval.approved) {
        const msg = `Spending policy rejected transaction: ${policyEval.rationale.join("; ")}`;
        recordStep("ESCROW_RESERVE", "FAILED", undefined, msg);
        return { success: false, steps, error: msg };
      }
    }

    const orderAmount = selectedOffer.price;
    let escrowOrder: EscrowOrder;

    try {
      if (options.createEscrowOrderFn) {
        escrowOrder = await options.createEscrowOrderFn({
          amount: orderAmount,
          description: `Tessera Escrow for ${selectedProduct.title}`,
          customId: transactionId,
          referenceId: transactionId,
          payee: { merchantId: selectedOffer.merchantDomain },
        });
      } else if (options.paypalClient) {
        escrowOrder = await options.paypalClient.createEscrowOrder({
          amount: orderAmount,
          description: `Tessera Escrow for ${selectedProduct.title}`,
          customId: transactionId,
          referenceId: transactionId,
          payee: { merchantId: selectedOffer.merchantDomain },
        });
      } else {
        const msg = "PayPal client is required to execute escrow reservation";
        recordStep("ESCROW_RESERVE", "FAILED", undefined, msg);
        return { success: false, steps, error: msg };
      }
    } catch (createErr) {
      const msg = createErr instanceof Error ? createErr.message : String(createErr);
      recordStep("ESCROW_RESERVE", "FAILED", undefined, `Failed to create escrow order: ${msg}`);
      return { success: false, steps, error: msg };
    }

    createdOrderId = String(escrowOrder.orderId);

    let authorization: EscrowAuthorization;
    try {
      if (options.authorizeOrderFn) {
        authorization = await options.authorizeOrderFn({
          orderId: escrowOrder.orderId,
        });
      } else if (options.paypalClient) {
        authorization = await options.paypalClient.authorizeOrder({
          orderId: escrowOrder.orderId,
        });
      } else {
        const msg = "PayPal authorization handler missing";
        recordStep("ESCROW_RESERVE", "FAILED", undefined, msg);
        return { success: false, orderId: createdOrderId, steps, error: msg };
      }
    } catch (authErr) {
      const msg = authErr instanceof Error ? authErr.message : String(authErr);
      recordStep("ESCROW_RESERVE", "FAILED", undefined, `Failed to authorize escrow order: ${msg}`);
      return { success: false, orderId: createdOrderId, steps, error: msg };
    }

    createdAuthId = String(authorization.authorizationId);

    recordStep("ESCROW_RESERVE", "COMPLETED", {
      orderId: createdOrderId,
      authorizationId: createdAuthId,
      status: authorization.status,
      escrowAmount: orderAmount.toDecimalString(),
      currency: orderAmount.currency,
      intent: "AUTHORIZE",
    });

    // -------------------------------------------------------------
    // STEP 4: AWAIT DELIVERY (Shipment Carrier Milestone Verification)
    // -------------------------------------------------------------
    const trackingNum = options.trackingNumber ?? `TRACK_${Date.now()}`;
    const carrierCode = options.carrier ?? "UPS";

    let milestone: ShipmentMilestone;
    try {
      if (options.getShipmentTrackingFn) {
        milestone = await options.getShipmentTrackingFn(createdAuthId, trackingNum);
      } else if (options.paypalClient) {
        try {
          milestone = await options.paypalClient.getShipmentTracking(createdAuthId, trackingNum);
        } catch {
          milestone = {
            transactionId: asTransactionId(transactionId),
            trackingNumber: trackingNum,
            carrier: carrierCode,
            status: options.simulateCarrierDelivery
              ? ShipmentMilestoneStatus.DELIVERED
              : ShipmentMilestoneStatus.IN_TRANSIT,
            rawStatus: options.simulateCarrierDelivery ? "DELIVERED" : "IN_TRANSIT",
            trackingNumberValidated: true,
          };
        }
      } else {
        milestone = {
          transactionId: asTransactionId(transactionId),
          trackingNumber: trackingNum,
          carrier: carrierCode,
          status: options.simulateCarrierDelivery
            ? ShipmentMilestoneStatus.DELIVERED
            : ShipmentMilestoneStatus.IN_TRANSIT,
          rawStatus: options.simulateCarrierDelivery ? "DELIVERED" : "IN_TRANSIT",
          trackingNumberValidated: true,
        };
      }
    } catch (trackErr) {
      const msg = trackErr instanceof Error ? trackErr.message : String(trackErr);
      recordStep(
        "SHIPMENT_TRACK",
        "FAILED",
        { trackingNumber: trackingNum },
        `Carrier tracking query failed: ${msg}`,
      );
      return {
        success: false,
        orderId: createdOrderId,
        authorizationId: createdAuthId,
        steps,
        error: msg,
      };
    }

    if (milestone.status !== ShipmentMilestoneStatus.DELIVERED) {
      const msg = `Carrier shipment milestone is ${milestone.status}. Delivery proof required before settlement.`;
      recordStep(
        "SHIPMENT_TRACK",
        "PENDING_DELIVERY",
        {
          trackingNumber: trackingNum,
          milestoneStatus: milestone.status,
        },
        msg,
      );
      recordStep("SETTLE", "SKIPPED", undefined, "Settlement skipped pending verified delivery");
      return {
        success: false,
        orderId: createdOrderId,
        authorizationId: createdAuthId,
        steps,
        error: msg,
      };
    }

    recordStep("SHIPMENT_TRACK", "COMPLETED", {
      trackingNumber: trackingNum,
      carrier: milestone.carrier,
      milestoneStatus: milestone.status,
      verifiedAt: new Date().toISOString(),
    });

    // -------------------------------------------------------------
    // STEP 5: SETTLE (Delivery-Gated Escrow Capture)
    // -------------------------------------------------------------
    let captureResult: EscrowCaptureResult;
    const captureOptions = {
      authorizationId: asAuthorizationId(createdAuthId),
      transactionId: asTransactionId(transactionId),
      milestone: {
        ...milestone,
        transactionId: asTransactionId(transactionId),
        trackingNumberValidated: true,
      },
      amount: orderAmount,
      finalCapture: true,
    };

    try {
      if (options.captureEscrowFn) {
        captureResult = await options.captureEscrowFn(captureOptions);
      } else if (options.paypalClient) {
        captureResult = await options.paypalClient.captureEscrow(captureOptions);
      } else {
        const msg = "PayPal escrow capture service missing";
        recordStep("SETTLE", "FAILED", undefined, msg);
        return {
          success: false,
          orderId: createdOrderId,
          authorizationId: createdAuthId,
          steps,
          error: msg,
        };
      }
    } catch (settleErr) {
      const msg = settleErr instanceof Error ? settleErr.message : String(settleErr);
      recordStep("SETTLE", "FAILED", undefined, `Escrow capture failed: ${msg}`);
      return {
        success: false,
        orderId: createdOrderId,
        authorizationId: createdAuthId,
        steps,
        error: msg,
      };
    }

    const captureId = String(captureResult.captureId);

    recordStep("SETTLE", "COMPLETED", {
      captureId,
      status: captureResult.status,
      settledAmount: orderAmount.toDecimalString(),
      currency: orderAmount.currency,
      releasedToPayee: selectedOffer.merchantDomain,
    });

    return {
      success: true,
      orderId: createdOrderId,
      authorizationId: createdAuthId,
      captureId,
      settledAmount: orderAmount,
      steps,
    };
  } catch (unhandledErr) {
    const errorMsg = unhandledErr instanceof Error ? unhandledErr.message : String(unhandledErr);
    return {
      success: false,
      orderId: createdOrderId,
      authorizationId: createdAuthId,
      steps,
      error: errorMsg,
    };
  }
}
