import {
  asAuthorizationId,
  asCaptureId,
  asOrderId,
  asTransactionId,
  ClearinghouseState,
  Money,
  ShipmentMilestoneStatus,
} from "@tessera/core";
import { generateEd25519KeyPair } from "@tessera/mandates";
import type { PayPalCaptureResponse, PayPalOrderResponse } from "@tessera/paypal";
import { PolicyEngine } from "@tessera/policy";
import { describe, expect, it } from "vitest";
import { runAgentProcurementLoop } from "../index.js";

function createMockOrderResponse(id = "ORDER-MOCK-001"): PayPalOrderResponse {
  return {
    id,
    status: "CREATED",
    intent: "AUTHORIZE",
    purchase_units: [
      {
        reference_id: "default",
        amount: {
          currency_code: "USD",
          value: "129.99",
        },
      },
    ],
    links: [],
  };
}

function createMockCaptureResponse(id = "CAPTURE-MOCK-001"): PayPalCaptureResponse {
  return {
    id,
    status: "COMPLETED",
    amount: {
      currency_code: "USD",
      value: "129.99",
    },
    final_capture: true,
  };
}

function createMockCatalogResponse(
  products: Array<{
    id: string;
    title: string;
    domain: string;
    price: number;
    inStock?: boolean;
  }>,
) {
  return {
    products: products.map((p) => ({
      id: p.id,
      title: p.title,
      offers: [
        {
          availability: (p.inStock ?? true) ? ("InStock" as const) : ("OutOfStock" as const),
          domain: p.domain,
          price: {
            currency: "USD",
            price: p.price,
          },
          url: `https://${p.domain}/products/${p.id}`,
        },
      ],
    })),
  };
}

describe("Autonomous Agent Procurement Loop (End-to-End Orchestrator)", () => {
  it("executes complete 5-step autonomous procurement lifecycle: Query -> Sign -> Escrow -> Track -> Settle", async () => {
    const buyerKeyPair = generateEd25519KeyPair();
    const mockProducts = [
      {
        id: "chair-001",
        title: "Ergonomic Mesh Chair",
        domain: "staples.com",
        price: 129.99,
      },
      {
        id: "chair-002",
        title: "Executive Leather Chair",
        domain: "officedepot.com",
        price: 249.99,
      },
    ];

    const result = await runAgentProcurementLoop({
      query: "ergonomic chair",
      maxPrice: 150.0,
      currency: "USD",
      allowedDomains: ["staples.com", "officedepot.com"],
      buyerKeyPair,
      searchCatalogFn: async () => createMockCatalogResponse(mockProducts),
      createEscrowOrderFn: async (opts) => ({
        orderId: asOrderId("ORDER-CHAIR-101"),
        status: "CREATED",
        amount:
          opts.amount instanceof Money
            ? opts.amount
            : Money.fromDecimalString(opts.amount.value, opts.amount.currency_code),
        links: [],
        rawResponse: createMockOrderResponse("ORDER-CHAIR-101"),
      }),
      authorizeOrderFn: async (opts) => ({
        authorizationId: asAuthorizationId("AUTH-CHAIR-202"),
        orderId: asOrderId(String(opts.orderId)),
        status: "CREATED",
        amount: Money.fromDecimalString("129.99", "USD"),
        rawResponse: createMockOrderResponse(String(opts.orderId)),
      }),
      getShipmentTrackingFn: async (txOrTrackerId, trackingNumber) => ({
        transactionId: asTransactionId(txOrTrackerId),
        trackingNumber: trackingNumber ?? "TRACK-CHAIR-999",
        carrier: "UPS",
        status: ShipmentMilestoneStatus.DELIVERED,
        rawStatus: "DELIVERED",
        trackingNumberValidated: true,
      }),
      captureEscrowFn: async (opts) => ({
        authorizationId: asAuthorizationId("AUTH-CHAIR-202"),
        captureId: asCaptureId("CAPTURE-CHAIR-303"),
        status: "COMPLETED",
        amount: opts.amount ?? Money.fromDecimalString("129.99", "USD"),
        finalCapture: true,
        capturedAt: new Date().toISOString(),
        requestId: "req-capture-303",
        releaseTrigger: "CARRIER_DELIVERY_PROOF",
        clearinghouseState: ClearinghouseState.SETTLED,
        rawResponse: createMockCaptureResponse("CAPTURE-CHAIR-303"),
      }),
    });

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("ORDER-CHAIR-101");
    expect(result.authorizationId).toBe("AUTH-CHAIR-202");
    expect(result.captureId).toBe("CAPTURE-CHAIR-303");
    expect(result.settledAmount?.toDecimalString()).toBe("129.99");
    expect(result.settledAmount?.currency).toBe("USD");

    expect(result.steps).toHaveLength(5);
    expect(result.steps.map((s) => s.step)).toEqual([
      "DISCOVER",
      "MANDATE_SIGN",
      "ESCROW_RESERVE",
      "SHIPMENT_TRACK",
      "SETTLE",
    ]);

    expect(result.steps[0]?.status).toBe("COMPLETED");
    expect(result.steps[0]?.data?.productId).toBe("chair-001");
    expect(result.steps[0]?.data?.domain).toBe("staples.com");

    expect(result.steps[1]?.status).toBe("COMPLETED");
    expect(result.steps[1]?.data?.vct).toBe("mandate.payment.1");

    expect(result.steps[2]?.status).toBe("COMPLETED");
    expect(result.steps[2]?.data?.intent).toBe("AUTHORIZE");

    expect(result.steps[3]?.status).toBe("COMPLETED");
    expect(result.steps[3]?.data?.milestoneStatus).toBe(ShipmentMilestoneStatus.DELIVERED);

    expect(result.steps[4]?.status).toBe("COMPLETED");
    expect(result.steps[4]?.data?.captureId).toBe("CAPTURE-CHAIR-303");
  });

  it("skips cheaper out-of-stock offer and picks in-stock offer", async () => {
    const buyerKeyPair = generateEd25519KeyPair();
    const mockProducts = [
      {
        id: "mouse-001",
        title: "Wireless Mouse (OOS)",
        domain: "store-a.com",
        price: 29.99,
        inStock: false,
      },
      {
        id: "mouse-002",
        title: "Wireless Mouse (In Stock)",
        domain: "store-b.com",
        price: 49.99,
        inStock: true,
      },
    ];

    const result = await runAgentProcurementLoop({
      query: "mouse",
      maxPrice: 60.0,
      buyerKeyPair,
      simulateCarrierDelivery: true,
      searchCatalogFn: async () => createMockCatalogResponse(mockProducts),
      createEscrowOrderFn: async (opts) => ({
        orderId: asOrderId("ORDER-MOUSE-01"),
        status: "CREATED",
        amount:
          opts.amount instanceof Money
            ? opts.amount
            : Money.fromDecimalString(opts.amount.value, opts.amount.currency_code),
        links: [],
        rawResponse: createMockOrderResponse("ORDER-MOUSE-01"),
      }),
      authorizeOrderFn: async (opts) => ({
        authorizationId: asAuthorizationId("AUTH-MOUSE-01"),
        orderId: asOrderId(String(opts.orderId)),
        status: "CREATED",
        amount: Money.fromDecimalString("49.99", "USD"),
        rawResponse: createMockOrderResponse(String(opts.orderId)),
      }),
      captureEscrowFn: async (opts) => ({
        authorizationId: asAuthorizationId("AUTH-MOUSE-01"),
        captureId: asCaptureId("CAPTURE-MOUSE-01"),
        status: "COMPLETED",
        amount: opts.amount ?? Money.fromDecimalString("49.99", "USD"),
        finalCapture: true,
        capturedAt: new Date().toISOString(),
        requestId: "req-capture-mouse",
        releaseTrigger: "CARRIER_DELIVERY_PROOF",
        clearinghouseState: ClearinghouseState.SETTLED,
        rawResponse: createMockCaptureResponse("CAPTURE-MOUSE-01"),
      }),
    });

    expect(result.success).toBe(true);
    expect(result.steps[0]?.data?.productId).toBe("mouse-002");
    expect(result.steps[0]?.data?.domain).toBe("store-b.com");
    expect(result.settledAmount?.toDecimalString()).toBe("49.99");
  });

  it("validates input parameters before initiating procurement loop", async () => {
    const buyerKeyPair = generateEd25519KeyPair();

    const emptyQueryRes = await runAgentProcurementLoop({
      query: "   ",
      maxPrice: 100,
      buyerKeyPair,
    });
    expect(emptyQueryRes.success).toBe(false);
    expect(emptyQueryRes.steps[0]?.step).toBe("DISCOVER");
    expect(emptyQueryRes.steps[0]?.status).toBe("FAILED");
    expect(emptyQueryRes.error).toContain("cannot be empty");

    const invalidPriceRes = await runAgentProcurementLoop({
      query: "keyboard",
      maxPrice: -10,
      buyerKeyPair,
    });
    expect(invalidPriceRes.success).toBe(false);
    expect(invalidPriceRes.steps[0]?.step).toBe("DISCOVER");
    expect(invalidPriceRes.steps[0]?.status).toBe("FAILED");
    expect(invalidPriceRes.error).toContain("positive finite number");
  });

  it("accurately attributes intermediate ESCROW_RESERVE failure and preserves order ID", async () => {
    const buyerKeyPair = generateEd25519KeyPair();
    const mockProducts = [
      {
        id: "prod-1",
        title: "Test Item",
        domain: "store.com",
        price: 50.0,
      },
    ];

    const result = await runAgentProcurementLoop({
      query: "item",
      maxPrice: 100.0,
      buyerKeyPair,
      searchCatalogFn: async () => createMockCatalogResponse(mockProducts),
      createEscrowOrderFn: async (opts) => ({
        orderId: asOrderId("ORDER-RESERVE-FAIL"),
        status: "CREATED",
        amount:
          opts.amount instanceof Money
            ? opts.amount
            : Money.fromDecimalString(opts.amount.value, opts.amount.currency_code),
        links: [],
        rawResponse: createMockOrderResponse("ORDER-RESERVE-FAIL"),
      }),
      authorizeOrderFn: async () => {
        throw new Error("PayPal authorization connection timed out");
      },
    });

    expect(result.success).toBe(false);
    expect(result.orderId).toBe("ORDER-RESERVE-FAIL");
    expect(result.authorizationId).toBeUndefined();
    expect(result.error).toContain("PayPal authorization connection timed out");

    const reserveStep = result.steps.find((s) => s.step === "ESCROW_RESERVE");
    expect(reserveStep?.status).toBe("FAILED");
    expect(reserveStep?.error).toContain("Failed to authorize escrow order");

    // Must NOT attribute failure to SETTLE!
    const settleStep = result.steps.find((s) => s.step === "SETTLE");
    expect(settleStep).toBeUndefined();
  });

  it("accurately attributes intermediate SHIPMENT_TRACK failure and preserves authorization ID", async () => {
    const buyerKeyPair = generateEd25519KeyPair();
    const mockProducts = [
      {
        id: "prod-1",
        title: "Test Item",
        domain: "store.com",
        price: 50.0,
      },
    ];

    const result = await runAgentProcurementLoop({
      query: "item",
      maxPrice: 100.0,
      buyerKeyPair,
      searchCatalogFn: async () => createMockCatalogResponse(mockProducts),
      createEscrowOrderFn: async (opts) => ({
        orderId: asOrderId("ORDER-TRACK-FAIL"),
        status: "CREATED",
        amount:
          opts.amount instanceof Money
            ? opts.amount
            : Money.fromDecimalString(opts.amount.value, opts.amount.currency_code),
        links: [],
        rawResponse: createMockOrderResponse("ORDER-TRACK-FAIL"),
      }),
      authorizeOrderFn: async (opts) => ({
        authorizationId: asAuthorizationId("AUTH-TRACK-FAIL"),
        orderId: asOrderId(String(opts.orderId)),
        status: "CREATED",
        amount: Money.fromDecimalString("50.00", "USD"),
        rawResponse: createMockOrderResponse(String(opts.orderId)),
      }),
      getShipmentTrackingFn: async () => {
        throw new Error("Carrier tracking API rate limit exceeded");
      },
    });

    expect(result.success).toBe(false);
    expect(result.orderId).toBe("ORDER-TRACK-FAIL");
    expect(result.authorizationId).toBe("AUTH-TRACK-FAIL");

    const trackStep = result.steps.find((s) => s.step === "SHIPMENT_TRACK");
    expect(trackStep?.status).toBe("FAILED");
    expect(trackStep?.error).toContain("Carrier tracking query failed");

    // Must NOT attribute failure to SETTLE!
    const settleStep = result.steps.find((s) => s.step === "SETTLE");
    expect(settleStep).toBeUndefined();
  });

  it("fails early at DISCOVER when all available offers exceed buyer budget cap", async () => {
    const buyerKeyPair = generateEd25519KeyPair();
    const mockProducts = [
      {
        id: "pro-laptop-01",
        title: "Workstation Laptop",
        domain: "lenovo.com",
        price: 1899.99,
      },
    ];

    let createEscrowCalled = false;
    const result = await runAgentProcurementLoop({
      query: "laptop",
      maxPrice: 800.0,
      buyerKeyPair,
      searchCatalogFn: async () => createMockCatalogResponse(mockProducts),
      createEscrowOrderFn: async () => {
        createEscrowCalled = true;
        throw new Error("Should not be called!");
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No matching in-stock products found");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.step).toBe("DISCOVER");
    expect(result.steps[0]?.status).toBe("FAILED");
    expect(createEscrowCalled).toBe(false);
  });

  it("fails early at DISCOVER when offers do not match domain whitelist", async () => {
    const buyerKeyPair = generateEd25519KeyPair();
    const mockProducts = [
      {
        id: "gadget-01",
        title: "Smart Widget",
        domain: "unauthorized-marketplace.com",
        price: 49.99,
      },
    ];

    const result = await runAgentProcurementLoop({
      query: "smart widget",
      maxPrice: 100.0,
      allowedDomains: ["target.com", "walmart.com"],
      buyerKeyPair,
      searchCatalogFn: async () => createMockCatalogResponse(mockProducts),
    });

    expect(result.success).toBe(false);
    expect(result.steps[0]?.step).toBe("DISCOVER");
    expect(result.steps[0]?.status).toBe("FAILED");
  });

  it("enforces organizational spending policies during ESCROW_RESERVE and stops before payment", async () => {
    const buyerKeyPair = generateEd25519KeyPair();
    const mockProducts = [
      {
        id: "drill-001",
        title: "Industrial Cordless Drill",
        domain: "homedepot.com",
        price: 199.99,
      },
    ];

    const policyEngine = new PolicyEngine({
      maxAmountPerTransaction: Money.fromDecimalString("150.00", "USD"),
      maxVelocity24h: Money.fromDecimalString("1000.00", "USD"),
      allowedMerchantDomains: ["homedepot.com"],
      autoApprovalLimit: Money.fromDecimalString("100.00", "USD"),
      hitlRiskThreshold: 80,
      authorizedSupervisorPublicKeys: ["0".repeat(64)],
    });

    let authorizeCalled = false;
    const result = await runAgentProcurementLoop({
      query: "drill",
      maxPrice: 250.0,
      buyerKeyPair,
      policyEngine,
      searchCatalogFn: async () => createMockCatalogResponse(mockProducts),
      authorizeOrderFn: async () => {
        authorizeCalled = true;
        throw new Error("Should not authorize!");
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Spending policy rejected transaction");
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]?.step).toBe("DISCOVER");
    expect(result.steps[0]?.status).toBe("COMPLETED");
    expect(result.steps[1]?.step).toBe("MANDATE_SIGN");
    expect(result.steps[1]?.status).toBe("COMPLETED");
    expect(result.steps[2]?.step).toBe("ESCROW_RESERVE");
    expect(result.steps[2]?.status).toBe("FAILED");
    expect(authorizeCalled).toBe(false);
  });

  it("pauses at SHIPMENT_TRACK and skips SETTLE when delivery is still in transit", async () => {
    const buyerKeyPair = generateEd25519KeyPair();
    const mockProducts = [
      {
        id: "item-001",
        title: "In-Transit Goods",
        domain: "store.com",
        price: 50.0,
      },
    ];

    let captureCalled = false;
    const result = await runAgentProcurementLoop({
      query: "goods",
      maxPrice: 100.0,
      buyerKeyPair,
      searchCatalogFn: async () => createMockCatalogResponse(mockProducts),
      createEscrowOrderFn: async (opts) => ({
        orderId: asOrderId("ORDER-TRANSIT-1"),
        status: "CREATED",
        amount:
          opts.amount instanceof Money
            ? opts.amount
            : Money.fromDecimalString(opts.amount.value, opts.amount.currency_code),
        links: [],
        rawResponse: createMockOrderResponse("ORDER-TRANSIT-1"),
      }),
      authorizeOrderFn: async (opts) => ({
        authorizationId: asAuthorizationId("AUTH-TRANSIT-1"),
        orderId: asOrderId(String(opts.orderId)),
        status: "CREATED",
        amount: Money.fromDecimalString("50.00", "USD"),
        rawResponse: createMockOrderResponse(String(opts.orderId)),
      }),
      getShipmentTrackingFn: async (txOrTrackerId, trackingNumber) => ({
        transactionId: asTransactionId(txOrTrackerId),
        trackingNumber: trackingNumber ?? "TRACK-TRANSIT",
        carrier: "USPS",
        status: ShipmentMilestoneStatus.IN_TRANSIT,
        rawStatus: "IN_TRANSIT",
        trackingNumberValidated: true,
      }),
      captureEscrowFn: async () => {
        captureCalled = true;
        throw new Error("Capture must not be executed without delivery!");
      },
    });

    expect(result.success).toBe(false);
    expect(result.orderId).toBe("ORDER-TRANSIT-1");
    expect(result.authorizationId).toBe("AUTH-TRANSIT-1");
    expect(result.error).toContain("Carrier shipment milestone is IN_TRANSIT");

    const trackStep = result.steps.find((s) => s.step === "SHIPMENT_TRACK");
    expect(trackStep?.status).toBe("PENDING_DELIVERY");

    const settleStep = result.steps.find((s) => s.step === "SETTLE");
    expect(settleStep?.status).toBe("SKIPPED");
    expect(captureCalled).toBe(false);
  });

  it("fails at ESCROW_RESERVE when merchant domain cannot be resolved to a trusted PayPal merchant ID", async () => {
    const buyerKeyPair = generateEd25519KeyPair();
    const mockProducts = [
      {
        id: "item-unmapped",
        title: "Unmapped Merchant Item",
        domain: "unknown-store.com",
        price: 49.99,
        inStock: true,
      },
    ];

    let createEscrowCalled = false;
    const result = await runAgentProcurementLoop({
      query: "item",
      maxPrice: 100.0,
      buyerKeyPair,
      merchantRegistry: {}, // empty registry so domain cannot be resolved
      searchCatalogFn: async () => createMockCatalogResponse(mockProducts),
      createEscrowOrderFn: async () => {
        createEscrowCalled = true;
        throw new Error("Must not be called");
      },
    });

    expect(result.success).toBe(false);
    expect(createEscrowCalled).toBe(false);
    expect(result.error).toContain("Unable to resolve trusted PayPal merchant ID");
    const reserveStep = result.steps.find((s) => s.step === "ESCROW_RESERVE");
    expect(reserveStep?.status).toBe("FAILED");
  });

  it("resolves merchant ID from registry and passes it as payee.merchantId to createEscrowOrder", async () => {
    const buyerKeyPair = generateEd25519KeyPair();
    const mockProducts = [
      {
        id: "item-custom",
        title: "Custom Merchant Item",
        domain: "custom-supplier.com",
        price: 39.99,
        inStock: true,
      },
    ];

    let receivedPayeeMerchantId: string | undefined;
    const result = await runAgentProcurementLoop({
      query: "item",
      maxPrice: 100.0,
      buyerKeyPair,
      merchantRegistry: {
        "custom-supplier.com": "MERC-CUSTOM-SUPPLIER-999",
      },
      searchCatalogFn: async () => createMockCatalogResponse(mockProducts),
      createEscrowOrderFn: async (opts) => {
        receivedPayeeMerchantId = opts.payee?.merchantId;
        return {
          orderId: asOrderId("ORDER-CUSTOM-01"),
          status: "CREATED",
          amount: Money.fromDecimalString("39.99", "USD"),
          links: [],
          rawResponse: createMockOrderResponse("ORDER-CUSTOM-01"),
        };
      },
      authorizeOrderFn: async (opts) => ({
        authorizationId: asAuthorizationId("AUTH-CUSTOM-01"),
        orderId: asOrderId(String(opts.orderId)),
        status: "CREATED",
        amount: Money.fromDecimalString("39.99", "USD"),
        rawResponse: createMockOrderResponse(String(opts.orderId)),
      }),
      simulateCarrierDelivery: true,
      captureEscrowFn: async () => ({
        authorizationId: asAuthorizationId("AUTH-CUSTOM-01"),
        captureId: asCaptureId("CAP-CUSTOM-01"),
        status: "COMPLETED",
        amount: Money.fromDecimalString("39.99", "USD"),
        finalCapture: true,
        capturedAt: new Date().toISOString(),
        requestId: "req-custom-01",
        releaseTrigger: "CARRIER_DELIVERY_PROOF",
        clearinghouseState: ClearinghouseState.SETTLED,
        rawResponse: createMockCaptureResponse("CAP-CUSTOM-01"),
      }),
    });

    expect(result.success).toBe(true);
    expect(receivedPayeeMerchantId).toBe("MERC-CUSTOM-SUPPLIER-999");
    expect(receivedPayeeMerchantId).not.toBe("custom-supplier.com");
  });

  it("passes paymentSource to paypalClient.authorizeOrder without waiting for approval", async () => {
    const buyerKeyPair = generateEd25519KeyPair();
    const mockProducts = [
      {
        id: "item-ps",
        title: "Payment Source Item",
        domain: "staples.com",
        price: 25.0,
      },
    ];

    let passedPaymentSource: Record<string, unknown> | undefined;
    const fakePaymentSource = { vault_id: "vault-token-123" };

    const mockPayPalClient = {
      createEscrowOrder: async (opts: any) => ({
        orderId: asOrderId("ORDER-PS-01"),
        status: "CREATED",
        amount: opts.amount,
        links: [],
        rawResponse: createMockOrderResponse("ORDER-PS-01"),
      }),
      authorizeOrder: async (opts: any) => {
        passedPaymentSource = opts.paymentSource;
        return {
          authorizationId: asAuthorizationId("AUTH-PS-01"),
          orderId: opts.orderId,
          status: "CREATED",
          amount: Money.fromDecimalString("25.00", "USD"),
          rawResponse: createMockOrderResponse("ORDER-PS-01"),
        };
      },
      captureEscrow: async () => ({
        authorizationId: asAuthorizationId("AUTH-PS-01"),
        captureId: asCaptureId("CAP-PS-01"),
        status: "COMPLETED",
        amount: Money.fromDecimalString("25.00", "USD"),
        finalCapture: true,
        capturedAt: new Date().toISOString(),
        requestId: "req-ps",
        releaseTrigger: "CARRIER_DELIVERY_PROOF",
        clearinghouseState: ClearinghouseState.SETTLED,
        rawResponse: createMockCaptureResponse("CAP-PS-01"),
      }),
    };

    const result = await runAgentProcurementLoop({
      query: "item",
      maxPrice: 50.0,
      buyerKeyPair,
      paymentSource: fakePaymentSource,
      paypalClient: mockPayPalClient as any,
      simulateCarrierDelivery: true,
      searchCatalogFn: async () => createMockCatalogResponse(mockProducts),
    });

    expect(result.success).toBe(true);
    expect(passedPaymentSource).toEqual(fakePaymentSource);
  });

  it("polls getOrder until APPROVED before calling paypalClient.authorizeOrder", async () => {
    const buyerKeyPair = generateEd25519KeyPair();
    const mockProducts = [
      {
        id: "item-poll",
        title: "Polling Item",
        domain: "staples.com",
        price: 15.0,
      },
    ];

    let pollCount = 0;
    const mockPayPalClient = {
      createEscrowOrder: async (opts: any) => ({
        orderId: asOrderId("ORDER-POLL-01"),
        status: "CREATED",
        amount: opts.amount,
        links: [],
        rawResponse: createMockOrderResponse("ORDER-POLL-01"),
      }),
      getOrder: async () => {
        pollCount++;
        return {
          orderId: asOrderId("ORDER-POLL-01"),
          status: pollCount >= 2 ? ("APPROVED" as const) : ("CREATED" as const),
          amount: Money.fromDecimalString("15.00", "USD"),
          links: [],
          rawResponse: createMockOrderResponse("ORDER-POLL-01"),
        };
      },
      authorizeOrder: async (opts: any) => ({
        authorizationId: asAuthorizationId("AUTH-POLL-01"),
        orderId: opts.orderId,
        status: "CREATED",
        amount: Money.fromDecimalString("15.00", "USD"),
        rawResponse: createMockOrderResponse("ORDER-POLL-01"),
      }),
      captureEscrow: async () => ({
        authorizationId: asAuthorizationId("AUTH-POLL-01"),
        captureId: asCaptureId("CAP-POLL-01"),
        status: "COMPLETED",
        amount: Money.fromDecimalString("15.00", "USD"),
        finalCapture: true,
        capturedAt: new Date().toISOString(),
        requestId: "req-poll",
        releaseTrigger: "CARRIER_DELIVERY_PROOF",
        clearinghouseState: ClearinghouseState.SETTLED,
        rawResponse: createMockCaptureResponse("CAP-POLL-01"),
      }),
    };

    const result = await runAgentProcurementLoop({
      query: "item",
      maxPrice: 50.0,
      buyerKeyPair,
      paypalClient: mockPayPalClient as any,
      approvalPollIntervalMs: 10,
      approvalTimeoutMs: 1000,
      simulateCarrierDelivery: true,
      searchCatalogFn: async () => createMockCatalogResponse(mockProducts),
    });

    expect(result.success).toBe(true);
    expect(pollCount).toBeGreaterThanOrEqual(2);
  });
});
