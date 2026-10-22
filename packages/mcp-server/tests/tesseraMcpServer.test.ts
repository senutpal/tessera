import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  asAuthorizationId,
  asOrderId,
  asTransactionId,
  Money,
  ShipmentMilestoneStatus,
} from "@tessera/core";
import { generateEd25519KeyPair, signMandate } from "@tessera/mandates";
import type { PayPalOrderResponse } from "@tessera/paypal";
import { PolicyEngine } from "@tessera/policy";
import { describe, expect, it } from "vitest";
import {
  type CheckSettlementInput,
  type SearchCatalogInput,
  type SubmitMandateInput,
  startMcpServer,
  TesseraMcpServer,
} from "../index.js";

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
          value: "149.99",
        },
      },
    ],
    links: [],
  };
}

function createMockProduct(
  id: string,
  title: string,
  domain: string,
  price: number,
  inStock = true,
) {
  return {
    id,
    title,
    offers: [
      {
        availability: inStock ? ("InStock" as const) : ("OutOfStock" as const),
        domain,
        price: {
          currency: "USD",
          price,
        },
        url: `https://${domain}/products/${id}`,
      },
    ],
  };
}

function getTextContent(result: unknown): string {
  const res = result as Record<string, unknown>;
  const contentArr = res.content as Array<{ type?: string; text?: string }> | undefined;
  return contentArr?.[0]?.text ?? "";
}

describe("TesseraMcpServer & MCP Commerce Tools", () => {
  it("registers all commerce tools and answers tools/list requests with complete Zod schemas", async () => {
    const server = new TesseraMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    const listResult = await client.listTools();
    const toolNames = listResult.tools.map((t) => t.name);

    expect(toolNames).toContain("tessera_search_catalog");
    expect(toolNames).toContain("tessera_submit_mandate");
    expect(toolNames).toContain("tessera_check_settlement");

    const searchTool = listResult.tools.find((t) => t.name === "tessera_search_catalog");
    expect(searchTool?.description).toContain("Search products");
    expect(searchTool?.inputSchema.properties).toHaveProperty("query");
    expect(searchTool?.inputSchema.properties).toHaveProperty("max_price");
    expect(searchTool?.inputSchema.properties).toHaveProperty("allowed_domains");

    const mandateTool = listResult.tools.find((t) => t.name === "tessera_submit_mandate");
    expect(mandateTool?.inputSchema.properties).toHaveProperty("signed_mandate");

    const settlementTool = listResult.tools.find((t) => t.name === "tessera_check_settlement");
    expect(settlementTool?.inputSchema.properties).toHaveProperty("order_id");
    expect(settlementTool?.inputSchema.properties).toHaveProperty("authorization_id");

    await client.close();
    await server.close();
  });

  describe("tessera_search_catalog", () => {
    it("returns filtered products and formatted markdown summary", async () => {
      const mockProducts = [
        createMockProduct("prod-1", "Mechanical Keyboard RGB", "bestbuy.com", 99.99),
        createMockProduct("prod-2", "Wireless Ergonomic Keyboard", "amazon.com", 149.99),
        createMockProduct("prod-3", "Expensive Custom Board", "boutique.com", 350.0),
      ];

      const server = new TesseraMcpServer({
        searchProductsFn: async () => ({ products: mockProducts }),
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const args: SearchCatalogInput = {
        query: "keyboard",
        max_price: 150.0,
        allowed_domains: ["bestbuy.com", "amazon.com"],
      };

      const result = await client.callTool({
        name: "tessera_search_catalog",
        arguments: args,
      });

      expect(result.isError).toBeFalsy();
      const text = getTextContent(result);

      expect(text).toContain("Mechanical Keyboard RGB");
      expect(text).toContain("Wireless Ergonomic Keyboard");
      expect(text).not.toContain("Expensive Custom Board");
      expect(text).toContain("bestbuy.com");

      await client.close();
      await server.close();
    });

    it("returns informative message when no products match budget or domain filter", async () => {
      const mockProducts = [createMockProduct("prod-1", "High-End Server", "dell.com", 5000.0)];

      const server = new TesseraMcpServer({
        searchProductsFn: async () => ({ products: mockProducts }),
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "tessera_search_catalog",
        arguments: {
          query: "budget server",
          max_price: 200.0,
        },
      });

      expect(result.isError).toBeFalsy();
      const text = getTextContent(result);
      expect(text).toContain("No products found");

      await client.close();
      await server.close();
    });

    it("gracefully catches search exceptions and returns error without crashing", async () => {
      const server = new TesseraMcpServer({
        searchProductsFn: async () => {
          throw new Error("Channel3 upstream gateway timeout");
        },
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "tessera_search_catalog",
        arguments: { query: "failing query" },
      });

      expect(result.isError).toBe(true);
      const text = getTextContent(result);
      expect(text).toContain("Catalog search failed: Channel3 upstream gateway timeout");

      await client.close();
      await server.close();
    });
  });

  describe("tessera_submit_mandate", () => {
    it("validates AP2 Ed25519 signature and places PayPal escrow order", async () => {
      let createdEscrowPayload: unknown = null;
      let authorizedOrderId: unknown = null;

      const server = new TesseraMcpServer({
        createEscrowOrderFn: async (opts) => {
          createdEscrowPayload = opts;
          return {
            orderId: asOrderId("ORDER-777"),
            status: "CREATED",
            amount:
              opts.amount instanceof Money
                ? opts.amount
                : Money.fromDecimalString(opts.amount.value, opts.amount.currency_code),
            links: [],
            rawResponse: createMockOrderResponse("ORDER-777"),
          };
        },
        authorizeOrderFn: async (opts) => {
          authorizedOrderId = opts.orderId;
          return {
            authorizationId: asAuthorizationId("AUTH-888"),
            orderId: asOrderId(String(opts.orderId)),
            status: "CREATED",
            amount: Money.fromDecimalString("89.99", "USD"),
            rawResponse: createMockOrderResponse(String(opts.orderId)),
          };
        },
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const keyPair = generateEd25519KeyPair();
      const nowEpoch = Math.floor(Date.now() / 1000);
      const paymentMandate = {
        vct: "mandate.payment.1",
        transaction_id: "tx-procure-101",
        payee: {
          id: "bestbuy.com",
          name: "Best Buy Official",
          website: "https://bestbuy.com",
        },
        payment_amount: {
          amount: 8999,
          currency: "USD",
        },
        payment_instrument: {
          id: "pi-tessera",
          type: "PAYPAL_ESCROW",
        },
        iat: nowEpoch,
        exp: nowEpoch + 3600,
        nonce: "nonce-valid-101",
      };

      const signedMandate = signMandate(paymentMandate, keyPair.privateKey, keyPair.publicKey);

      const args: SubmitMandateInput = {
        signed_mandate: {
          mandate: paymentMandate,
          signature: signedMandate.signature,
          signerPublicKey: keyPair.publicKey,
        },
        description: "Autonomous test purchase",
      };

      const result = await client.callTool({
        name: "tessera_submit_mandate",
        arguments: args,
      });

      expect(result.isError).toBeFalsy();
      const text = getTextContent(result);
      expect(text).toContain("AP2 Mandate Authorization Succeeded");
      expect(text).toContain("ORDER-777");
      expect(text).toContain("AUTH-888");
      expect(text).toContain("89.99 USD");
      expect(text).toContain("Ed25519 signature authenticated");

      expect(createdEscrowPayload).toBeTruthy();
      expect(authorizedOrderId).toBe("ORDER-777");

      await client.close();
      await server.close();
    });

    it("rejects tampered mandate payload before dispatching any PayPal calls", async () => {
      let createOrderCalled = false;
      const server = new TesseraMcpServer({
        createEscrowOrderFn: async () => {
          createOrderCalled = true;
          throw new Error("Should not be called!");
        },
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const keyPair = generateEd25519KeyPair();
      const nowEpoch = Math.floor(Date.now() / 1000);
      const paymentMandate = {
        vct: "mandate.payment.1",
        transaction_id: "tx-tamper-001",
        payee: {
          id: "legit-store.com",
          name: "Legit Store",
          website: "https://legit-store.com",
        },
        payment_amount: {
          amount: 5000,
          currency: "USD",
        },
        payment_instrument: {
          id: "pi-1",
          type: "PAYPAL_ESCROW",
        },
        iat: nowEpoch,
        exp: nowEpoch + 3600,
        nonce: "nonce-tamper-001",
      };

      const signedMandate = signMandate(paymentMandate, keyPair.privateKey, keyPair.publicKey);

      // Tamper with the amount after signing
      const tamperedMandate = {
        ...paymentMandate,
        payment_amount: {
          amount: 99999,
          currency: "USD",
        },
      };

      const result = await client.callTool({
        name: "tessera_submit_mandate",
        arguments: {
          signed_mandate: {
            mandate: tamperedMandate,
            signature: signedMandate.signature,
            signerPublicKey: keyPair.publicKey,
          },
        },
      });

      expect(result.isError).toBe(true);
      const text = getTextContent(result);
      expect(text).toContain("Mandate cryptographic verification failed");
      expect(createOrderCalled).toBe(false);

      await client.close();
      await server.close();
    });

    it("enforces organizational spending policy caps and blocks non-compliant mandates", async () => {
      const policyEngine = new PolicyEngine({
        maxAmountPerTransaction: Money.fromDecimalString("100.00", "USD"),
        maxVelocity24h: Money.fromDecimalString("500.00", "USD"),
        allowedMerchantDomains: ["approved-merchant.com"],
        autoApprovalLimit: Money.fromDecimalString("50.00", "USD"),
        hitlRiskThreshold: 70,
        authorizedSupervisorPublicKeys: ["0".repeat(64)],
      });

      let paypalCalled = false;
      const server = new TesseraMcpServer({
        policyEngine,
        createEscrowOrderFn: async () => {
          paypalCalled = true;
          throw new Error("Should not call PayPal!");
        },
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const keyPair = generateEd25519KeyPair();
      const nowEpoch = Math.floor(Date.now() / 1000);
      const violatingMandate = {
        vct: "mandate.payment.1",
        transaction_id: "tx-policy-fail",
        payee: {
          id: "unauthorized-domain.com",
          name: "Rogue Store",
          website: "https://unauthorized-domain.com",
        },
        payment_amount: {
          amount: 25000,
          currency: "USD",
        },
        payment_instrument: {
          id: "pi-policy",
          type: "PAYPAL_ESCROW",
        },
        iat: nowEpoch,
        exp: nowEpoch + 3600,
        nonce: "nonce-policy-fail",
      };

      const signed = signMandate(violatingMandate, keyPair.privateKey, keyPair.publicKey);

      const result = await client.callTool({
        name: "tessera_submit_mandate",
        arguments: {
          signed_mandate: {
            mandate: violatingMandate,
            signature: signed.signature,
            signerPublicKey: keyPair.publicKey,
          },
        },
      });

      expect(result.isError).toBe(true);
      const text = getTextContent(result);
      expect(text).toContain("Spending policy violation");
      expect(paypalCalled).toBe(false);

      await client.close();
      await server.close();
    });
  });

  describe("tessera_check_settlement", () => {
    it("reports settlement ready when shipment is verified DELIVERED", async () => {
      const server = new TesseraMcpServer({
        getOrderFn: async (orderId) => ({
          orderId: asOrderId(orderId),
          status: "CREATED",
          amount: Money.fromDecimalString("149.99", "USD"),
          authorizationId: asAuthorizationId("AUTH-DELIVERED-01"),
          links: [],
          rawResponse: createMockOrderResponse(orderId),
        }),
        getShipmentTrackingFn: async (txOrTrackerId, trackingNumber) => ({
          transactionId: asTransactionId(txOrTrackerId),
          trackingNumber: trackingNumber ?? "TRACK-999",
          carrier: "UPS",
          status: ShipmentMilestoneStatus.DELIVERED,
          rawStatus: "DELIVERED",
          trackingNumberValidated: true,
        }),
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const args: CheckSettlementInput = {
        order_id: "ORDER-12345",
        tracking_number: "TRACK-999",
      };

      const result = await client.callTool({
        name: "tessera_check_settlement",
        arguments: args,
      });

      expect(result.isError).toBeFalsy();
      const text = getTextContent(result);
      expect(text).toContain("ORDER-12345");
      expect(text).toContain("DELIVERED");
      expect(text).toContain("READY FOR CAPTURE");

      await client.close();
      await server.close();
    });

    it("reports settlement pending when shipment is still IN_TRANSIT", async () => {
      const server = new TesseraMcpServer({
        getOrderFn: async (orderId) => ({
          orderId: asOrderId(orderId),
          status: "CREATED",
          amount: Money.fromDecimalString("149.99", "USD"),
          links: [],
          rawResponse: createMockOrderResponse(orderId),
        }),
        getShipmentTrackingFn: async (txOrTrackerId, trackingNumber) => ({
          transactionId: asTransactionId(txOrTrackerId),
          trackingNumber: trackingNumber ?? "TRACK-INTRANSIT",
          carrier: "FEDEX",
          status: ShipmentMilestoneStatus.IN_TRANSIT,
          rawStatus: "IN_TRANSIT",
          trackingNumberValidated: true,
        }),
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "tessera_check_settlement",
        arguments: {
          order_id: "ORDER-TRANSIT",
          tracking_number: "TRACK-INTRANSIT",
        },
      });

      expect(result.isError).toBeFalsy();
      const text = getTextContent(result);
      expect(text).toContain("IN_TRANSIT");
      expect(text).toContain("PENDING DELIVERY");

      await client.close();
      await server.close();
    });

    it("errors when called without any identifiers", async () => {
      const server = new TesseraMcpServer();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "tessera_check_settlement",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      const text = getTextContent(result);
      expect(text).toContain(
        "At least one of `order_id`, `authorization_id`, or `tracking_number`",
      );

      await client.close();
      await server.close();
    });
  });

  describe("Server Factory & Transports", () => {
    it("creates server using startMcpServer helper", async () => {
      const server = await startMcpServer({ name: "custom-server" });
      expect(server).toBeInstanceOf(TesseraMcpServer);
      expect(server.getMcpServer()).toBeTruthy();
      await server.close();
    });
  });
});
