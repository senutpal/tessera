import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  asAuthorizationId,
  asOrderId,
  asTransactionId,
  Money,
  ShipmentMilestoneStatus,
} from "@tessera/core";
import { computeCheckoutHash, generateEd25519KeyPair, signMandate } from "@tessera/mandates";
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

function toMoney(amount: Money | { currency_code: string; value: string }): Money {
  if (amount instanceof Money) return amount;
  return Money.fromDecimalString(amount.value, amount.currency_code);
}

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
    expect(searchTool?.inputSchema.properties).toHaveProperty("in_stock_only");

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

    it("filters out out-of-stock items when in_stock_only is true", async () => {
      const mockProducts = [
        createMockProduct("prod-1", "Cheaper Out Of Stock Item", "bestbuy.com", 49.99, false),
        createMockProduct("prod-2", "In Stock Item", "bestbuy.com", 79.99, true),
      ];

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
          query: "gadget",
          in_stock_only: true,
        },
      });

      expect(result.isError).toBeFalsy();
      const text = getTextContent(result);
      expect(text).toContain("In Stock Item");
      expect(text).not.toContain("Cheaper Out Of Stock Item");

      await client.close();
      await server.close();
    });

    it("normalizes protocol URLs in allowed_domains parameter", async () => {
      const mockProducts = [
        createMockProduct("prod-1", "Product A", "bestbuy.com", 50.0),
        createMockProduct("prod-2", "Product B", "walmart.com", 50.0),
      ];

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
          query: "item",
          allowed_domains: ["https://www.bestbuy.com/products"],
        },
      });

      expect(result.isError).toBeFalsy();
      const text = getTextContent(result);
      expect(text).toContain("Product A");
      expect(text).not.toContain("Product B");

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
      expect(text).toContain("No products found matching query");

      await client.close();
      await server.close();
    });

    it("overfetches upstream catalog results and limits after local filtering", async () => {
      let capturedLimit: number | undefined;
      const mockProducts = [
        createMockProduct("prod-1", "Product A (disallowed domain)", "disallowed.com", 50.0),
        createMockProduct("prod-2", "Product B (allowed)", "allowed.com", 60.0),
        createMockProduct("prod-3", "Product C (allowed)", "allowed.com", 70.0),
        createMockProduct("prod-4", "Product D (allowed)", "allowed.com", 80.0),
      ];

      const server = new TesseraMcpServer({
        searchProductsFn: async (opts) => {
          capturedLimit = opts.limit;
          return { products: mockProducts };
        },
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "tessera_search_catalog",
        arguments: {
          query: "keyboard",
          limit: 2,
          allowed_domains: ["allowed.com"],
        },
      });

      expect(result.isError).toBeFalsy();
      expect(capturedLimit).toBe(20); // Math.max(2 * 4, 20) = 20

      const text = getTextContent(result);
      expect(text).not.toContain("Product A");
      expect(text).toContain("Product B");
      expect(text).toContain("Product C");
      expect(text).not.toContain("Product D");

      await client.close();
      await server.close();
    });

    it("handles underlying search exceptions gracefully", async () => {
      const server = new TesseraMcpServer({
        searchProductsFn: async () => {
          throw new Error("Channel3 Rate Limit Exceeded: HTTP 429");
        },
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "tessera_search_catalog",
        arguments: {
          query: "keyboard",
        },
      });

      expect(result.isError).toBe(true);
      const text = getTextContent(result);
      expect(text).toContain("Catalog search failed: Channel3 Rate Limit Exceeded");

      await client.close();
      await server.close();
    });
  });

  describe("tessera_submit_mandate", () => {
    it("verifies Ed25519 signature and dispatches PayPal escrow authorization", async () => {
      const keyPair = generateEd25519KeyPair();
      const nowEpoch = Math.floor(Date.now() / 1000);
      const paymentMandate = {
        vct: "mandate.payment.1",
        transaction_id: "tx-test-12345",
        payee: {
          id: "bestbuy.com",
          name: "Best Buy",
          website: "https://bestbuy.com",
        },
        payment_amount: {
          amount: 14999,
          currency: "USD",
        },
        payment_instrument: {
          id: "pi-tessera",
          type: "PAYPAL_ESCROW",
          description: "Tessera PayPal Escrow Authorization",
        },
        iat: nowEpoch,
        exp: nowEpoch + 3600,
        nonce: "nonce-rand-12345",
      };

      const signedMandate = signMandate(paymentMandate, keyPair.privateKey, keyPair.publicKey);

      let createEscrowCalled = false;
      let authorizeCalled = false;

      const server = new TesseraMcpServer({
        createEscrowOrderFn: async (opts) => {
          createEscrowCalled = true;
          const money = toMoney(opts.amount);
          expect(money.toDecimalString()).toBe("149.99");
          expect(money.currency).toBe("USD");
          return {
            orderId: asOrderId("ORDER-TEST-001"),
            status: "CREATED",
            amount: money,
            links: [],
            rawResponse: createMockOrderResponse("ORDER-TEST-001"),
          };
        },
        authorizeOrderFn: async (opts) => {
          authorizeCalled = true;
          expect(opts.orderId).toBe("ORDER-TEST-001");
          return {
            authorizationId: asAuthorizationId("AUTH-TEST-999"),
            orderId: asOrderId(opts.orderId),
            status: "CREATED",
            amount: Money.fromDecimalString("149.99", "USD"),
            rawResponse: createMockOrderResponse(opts.orderId),
          };
        },
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const args: SubmitMandateInput = {
        signed_mandate: {
          mandate: paymentMandate,
          signature: signedMandate.signature,
          signerPublicKey: keyPair.publicKey,
        },
      };

      const result = await client.callTool({
        name: "tessera_submit_mandate",
        arguments: args,
      });

      expect(result.isError).toBeFalsy();
      const text = getTextContent(result);

      expect(text).toContain("AP2 Mandate Authorization Succeeded");
      expect(text).toContain("ORDER-TEST-001");
      expect(text).toContain("AUTH-TEST-999");
      expect(text).toContain("149.99 USD");
      expect(createEscrowCalled).toBe(true);
      expect(authorizeCalled).toBe(true);

      await client.close();
      await server.close();
    });

    it("accepts snake_case public_key in signed_mandate container", async () => {
      const keyPair = generateEd25519KeyPair();
      const nowEpoch = Math.floor(Date.now() / 1000);
      const paymentMandate = {
        vct: "mandate.payment.1",
        transaction_id: "tx-snake-key",
        payee: { id: "store.com", name: "Store", website: "https://store.com" },
        payment_amount: { amount: 5000, currency: "USD" },
        payment_instrument: { id: "pi-1", type: "PAYPAL_ESCROW" },
        iat: nowEpoch,
        exp: nowEpoch + 3600,
        nonce: "nonce-snake-key",
      };

      const signedMandate = signMandate(paymentMandate, keyPair.privateKey, keyPair.publicKey);

      const server = new TesseraMcpServer({
        createEscrowOrderFn: async (opts) => ({
          orderId: asOrderId("ORDER-SNAKE-01"),
          status: "CREATED",
          amount: toMoney(opts.amount),
          links: [],
          rawResponse: createMockOrderResponse("ORDER-SNAKE-01"),
        }),
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "tessera_submit_mandate",
        arguments: {
          signed_mandate: {
            mandate: paymentMandate,
            signature: signedMandate.signature,
            public_key: keyPair.publicKey,
          },
        },
      });

      expect(result.isError).toBeFalsy();
      const text = getTextContent(result);
      expect(text).toContain("ORDER-SNAKE-01");

      await client.close();
      await server.close();
    });

    it("verifies and processes CheckoutMandate when explicit amount is supplied", async () => {
      const keyPair = generateEd25519KeyPair();
      const nowEpoch = Math.floor(Date.now() / 1000);
      const fakeJwt = "header.payload.signature";
      const checkoutHash = computeCheckoutHash(fakeJwt);

      const checkoutMandate = {
        vct: "mandate.checkout.1",
        checkout_jwt: fakeJwt,
        checkout_hash: checkoutHash,
        iat: nowEpoch,
        exp: nowEpoch + 3600,
        nonce: "nonce-checkout-001",
      };

      const signed = signMandate(checkoutMandate, keyPair.privateKey, keyPair.publicKey);

      let capturedAmount: Money | undefined;
      const server = new TesseraMcpServer({
        createEscrowOrderFn: async (opts) => {
          const money = toMoney(opts.amount);
          capturedAmount = money;
          return {
            orderId: asOrderId("ORDER-CHECKOUT-101"),
            status: "CREATED",
            amount: money,
            links: [],
            rawResponse: createMockOrderResponse("ORDER-CHECKOUT-101"),
          };
        },
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "tessera_submit_mandate",
        arguments: {
          signed_mandate: {
            mandate: checkoutMandate,
            signature: signed.signature,
            signerPublicKey: keyPair.publicKey,
          },
          amount: 89.5,
          currency: "USD",
        },
      });

      expect(result.isError).toBeFalsy();
      expect(capturedAmount?.toDecimalString()).toBe("89.50");

      await client.close();
      await server.close();
    });

    it("rejects CheckoutMandate when no explicit amount is provided", async () => {
      const keyPair = generateEd25519KeyPair();
      const nowEpoch = Math.floor(Date.now() / 1000);
      const fakeJwt = "header.payload.signature";
      const checkoutHash = computeCheckoutHash(fakeJwt);

      const checkoutMandate = {
        vct: "mandate.checkout.1",
        checkout_jwt: fakeJwt,
        checkout_hash: checkoutHash,
        iat: nowEpoch,
        exp: nowEpoch + 3600,
        nonce: "nonce-checkout-no-amt",
      };

      const signed = signMandate(checkoutMandate, keyPair.privateKey, keyPair.publicKey);

      const server = new TesseraMcpServer();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "tessera_submit_mandate",
        arguments: {
          signed_mandate: {
            mandate: checkoutMandate,
            signature: signed.signature,
            signerPublicKey: keyPair.publicKey,
          },
        },
      });

      expect(result.isError).toBe(true);
      const text = getTextContent(result);
      expect(text).toContain("Mandate does not include payment_amount");

      await client.close();
      await server.close();
    });

    it("rejects tampered mandate payloads when Ed25519 signature fails verification", async () => {
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
    it("reports settlement ready when shipment is verified DELIVERED and escrow authorized", async () => {
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
          authorizationId: asAuthorizationId("AUTH-TRANSIT-01"),
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

    it("reports pending authorization when order exists but has not been authorized in escrow", async () => {
      const server = new TesseraMcpServer({
        getOrderFn: async (orderId) => ({
          orderId: asOrderId(orderId),
          status: "CREATED",
          amount: Money.fromDecimalString("50.00", "USD"),
          links: [],
          rawResponse: createMockOrderResponse(orderId),
        }),
      });

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "tessera_check_settlement",
        arguments: {
          order_id: "ORDER-UNAPPROVED",
        },
      });

      expect(result.isError).toBeFalsy();
      const text = getTextContent(result);
      expect(text).toContain("PENDING AUTHORIZATION");

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

    it("reports READY FOR CAPTURE when order status is COMPLETED but nested authorization status is CREATED", async () => {
      const server = new TesseraMcpServer({
        getOrderFn: async (orderId) => ({
          orderId: asOrderId(orderId),
          status: "COMPLETED", // PayPal order status is COMPLETED after AUTHORIZE intent succeeds
          amount: Money.fromDecimalString("100.00", "USD"),
          authorizationId: asAuthorizationId("AUTH-ACTIVE-01"),
          links: [],
          rawResponse: {
            id: orderId,
            status: "COMPLETED",
            intent: "AUTHORIZE",
            purchase_units: [
              {
                payments: {
                  authorizations: [
                    {
                      id: "AUTH-ACTIVE-01",
                      status: "CREATED",
                      amount: { currency_code: "USD", value: "100.00" },
                    },
                  ],
                },
              },
            ],
          } as any,
        }),
        getShipmentTrackingFn: async () => ({
          transactionId: asTransactionId("TX-DELIVERED"),
          trackingNumber: "TRACK-DELIVERED",
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

      const result = await client.callTool({
        name: "tessera_check_settlement",
        arguments: { order_id: "ORDER-COMPLETED-WITH-ACTIVE-AUTH" },
      });

      expect(result.isError).toBeFalsy();
      const text = getTextContent(result);
      expect(text).toContain("READY FOR CAPTURE");
      expect(text).not.toContain("ALREADY CAPTURED / SETTLED");

      await client.close();
      await server.close();
    });

    it("reports ALREADY CAPTURED / SETTLED when authorization status is CAPTURED", async () => {
      const server = new TesseraMcpServer({
        getAuthorizationFn: async (authId) => ({
          id: authId,
          status: "CAPTURED",
        }),
        getShipmentTrackingFn: async () => ({
          transactionId: asTransactionId("TX-DELIVERED"),
          trackingNumber: "TRACK-DELIVERED",
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

      const result = await client.callTool({
        name: "tessera_check_settlement",
        arguments: { authorization_id: "AUTH-CAPTURED-99" },
      });

      expect(result.isError).toBeFalsy();
      const text = getTextContent(result);
      expect(text).toContain("ALREADY CAPTURED / SETTLED");
      expect(text).not.toContain("READY FOR CAPTURE");

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

    it("handles real SSE transport with concurrent clients over HTTP", async () => {
      const mockProducts = [
        createMockProduct("sse-prod-1", "SSE Mechanical Keyboard", "bestbuy.com", 89.99),
      ];

      const mcpServer = new TesseraMcpServer({
        name: "tessera-sse-test",
        searchProductsFn: async () => ({ products: mockProducts }),
      });

      const httpServer = createHttpServer(async (req, res) => {
        const url = new URL(req.url ?? "", "http://localhost");
        if (req.method === "GET" && url.pathname === "/sse") {
          await mcpServer.createSseTransport("/messages", res);
        } else if (req.method === "POST" && url.pathname === "/messages") {
          const sessionId = url.searchParams.get("sessionId");
          if (!sessionId) {
            res.writeHead(400).end("Missing sessionId");
            return;
          }
          await mcpServer.handleSsePostMessage(sessionId, req, res);
        } else {
          res.writeHead(404).end("Not found");
        }
      });

      await new Promise<void>((resolve) => httpServer.listen(0, resolve));
      const port = (httpServer.address() as AddressInfo).port;
      const sseUrl = new URL(`http://localhost:${port}/sse`);

      // Client 1 connects over SSE
      const client1 = new Client({ name: "sse-client-1", version: "1.0.0" }, { capabilities: {} });
      const transport1 = new SSEClientTransport(sseUrl);
      await client1.connect(transport1);

      // Client 2 connects concurrently over SSE (verifying multi-session support)
      const client2 = new Client({ name: "sse-client-2", version: "1.0.0" }, { capabilities: {} });
      const transport2 = new SSEClientTransport(sseUrl);
      await client2.connect(transport2);

      expect(mcpServer.activeSseSessionCount).toBe(2);

      // Client 1 queries tools
      const toolsResult1 = await client1.listTools();
      expect(toolsResult1.tools.map((t) => t.name)).toContain("tessera_search_catalog");

      // Client 2 calls search catalog tool over SSE
      const searchResult = await client2.callTool({
        name: "tessera_search_catalog",
        arguments: { query: "keyboard" },
      });
      const text = getTextContent(searchResult);
      expect(text).toContain("SSE Mechanical Keyboard");

      // Cleanup
      await client1.close();
      await client2.close();
      await mcpServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
  });
});
