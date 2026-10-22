import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { runPostmanTests } from "./runPostmanTests.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const collectionPath = path.resolve(__dirname, "tessera.postman_collection.json");
const environmentPath = path.resolve(__dirname, "tessera.postman_environment.json");
const openapiPath = path.resolve(__dirname, "../../apps/clearinghouse-api/docs/openapi.yaml");
const apimaticConfigPath = path.resolve(
  __dirname,
  "../../apps/clearinghouse-api/docs/apimatic-config.json",
);

describe("Phase 13: Postman Test Suite & APIMatic OpenAPI Spec", () => {
  describe("Ticket 13.1: Clearinghouse OpenAPI 3.1 Specification & APIMatic Config", () => {
    it("provides a valid OpenAPI 3.1 specification file with all required clearinghouse endpoints", () => {
      expect(fs.existsSync(openapiPath)).toBe(true);
      const content = fs.readFileSync(openapiPath, "utf-8");
      const doc = YAML.parse(content);

      expect(doc.openapi).toBe("3.1.0");
      expect(doc.info.title).toBe("Tessera Clearinghouse API");
      expect(doc.info.contact.url).toBe("https://github.com/senutpal/tessera");

      // Verify all required endpoints and HTTP methods exist under paths
      const requiredOperations: Array<{ path: string; method: string }> = [
        { path: "/v1/oauth2/token", method: "post" },
        { path: "/api/v1/mandates/verify", method: "post" },
        { path: "/v2/checkout/orders", method: "post" },
        { path: "/v1/notifications/verify-webhook-signature", method: "post" },
        { path: "/v1/shipping/trackers", method: "get" },
        { path: "/v2/payments/authorizations/{authorization_id}/capture", method: "post" },
        { path: "/v2/payments/authorizations/{authorization_id}/void", method: "post" },
      ];

      for (const op of requiredOperations) {
        expect(doc.paths[op.path]).toBeDefined();
        expect(doc.paths[op.path][op.method]).toBeDefined();
      }

      // Verify AP2 mandate and webhook components under components.schemas
      const schemas = doc.components?.schemas;
      expect(schemas).toBeDefined();
      expect(schemas.AP2PaymentMandate).toBeDefined();
      expect(schemas.AP2PaymentMandate.required).toContain("exp");
      expect(schemas.AP2PaymentMandate.required).toContain("nonce");
      expect(schemas.AP2CheckoutMandate).toBeDefined();
      expect(schemas.AP2CheckoutMandate.required).toContain("exp");
      expect(schemas.AP2CheckoutMandate.required).toContain("nonce");
      expect(schemas.VerifyWebhookSignatureRequest).toBeDefined();
      expect(schemas.VerifyWebhookSignatureRequest.properties.transmission_time.example).toBe(
        "2026-10-22T10:00:00Z",
      );
    });

    it("provides an APIMatic configuration file configured for SDK codegen and Context Plugins", () => {
      expect(fs.existsSync(apimaticConfigPath)).toBe(true);
      const raw = fs.readFileSync(apimaticConfigPath, "utf-8");
      const config = JSON.parse(raw);

      expect(config.specification).toBe("./openapi.yaml");
      expect(config.title).toBe("Tessera Clearinghouse API");
      expect(config.codegen).toBeDefined();
      expect(config.codegen.generateInterfaces).toBe(true);
      expect(config.codegen.exportModels).toBe(true);
      expect(config.codegen.useAsync).toBe(true);
      expect(config.plugins?.context?.enabled).toBe(true);
      expect(config.platforms).toEqual(expect.arrayContaining(["ts", "python", "csharp"]));
    });
  });

  describe("Ticket 13.2: Automated Postman Collection & Pre-Request Scripts", () => {
    it("provides a Postman Collection conforming to Schema v2.1.0", () => {
      expect(fs.existsSync(collectionPath)).toBe(true);
      const raw = fs.readFileSync(collectionPath, "utf-8");
      const collection = JSON.parse(raw);

      expect(collection.info.schema).toBe(
        "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      );
      expect(collection.info.name).toBe("Tessera Clearinghouse Test Suite");
      expect(Array.isArray(collection.item)).toBe(true);
      expect(collection.item.length).toBe(7);
    });

    it("covers the full 7-stage clearinghouse lifecycle in correct order", () => {
      const raw = fs.readFileSync(collectionPath, "utf-8");
      const collection = JSON.parse(raw);

      const itemNames = collection.item.map((i: { name: string }) => i.name);
      expect(itemNames[0]).toContain("1. OAuth2");
      expect(itemNames[1]).toContain("2. AP2 Mandate Verification");
      expect(itemNames[2]).toContain("3. Orders v2 Escrow");
      expect(itemNames[3]).toContain("4. Webhook Signature Verification");
      expect(itemNames[4]).toContain("5. Shipment Tracking");
      expect(itemNames[5]).toContain("6. Milestone Escrow Capture");
      expect(itemNames[6]).toContain("7. Authorization Void");
    });

    it("enforces the zero-hardcoded-secrets invariant via dynamic environment variable references", () => {
      const raw = fs.readFileSync(collectionPath, "utf-8");

      // Verify that no credentials are hardcoded as raw strings
      expect(raw).not.toMatch(/"[A-Za-z0-9+/=]{40,}"/); // no raw long tokens
      expect(raw).toContain("{{paypal_client_id}}");
      expect(raw).toContain("{{paypal_client_secret}}");
      expect(raw).toContain("{{current_access_token}}");
    });

    it("contains collection-level pre-request scripting for dynamic OAuth2 token acquisition", () => {
      const raw = fs.readFileSync(collectionPath, "utf-8");
      const collection = JSON.parse(raw);

      expect(Array.isArray(collection.event)).toBe(true);
      const prerequestEvent = collection.event.find(
        (e: { listen: string }) => e.listen === "prerequest",
      );
      expect(prerequestEvent).toBeDefined();

      const script = prerequestEvent.script.exec.join("\n");
      expect(script).toContain("current_access_token");
      expect(script).toContain("/v1/oauth2/token");
      expect(script).toContain("client_credentials");
    });

    it("provides an environment file with required variables and scopes", () => {
      expect(fs.existsSync(environmentPath)).toBe(true);
      const raw = fs.readFileSync(environmentPath, "utf-8");
      const env = JSON.parse(raw);

      expect(env.name).toBe("Tessera Clearinghouse Environment");
      const keys = env.values.map((v: { key: string }) => v.key);
      expect(keys).toContain("baseUrl");
      expect(keys).toContain("paypal_client_id");
      expect(keys).toContain("paypal_client_secret");
      expect(keys).toContain("current_access_token");
      expect(keys).toContain("order_id");
      expect(keys).toContain("authorization_id");
      expect(keys).toContain("void_authorization_id");
    });
  });

  describe("Ticket 13.3: Headless Newman CI Test Runner", () => {
    it("executes the entire Postman collection headlessly with 100% assertions passing", async () => {
      const result = await runPostmanTests({
        reporters: [], // Silent during vitest run
      });

      expect(result.failedTests).toBe(0);
      expect(result.failedAssertions).toBe(0);
      expect(result.failures).toHaveLength(0);
      expect(result.passedAssertions).toBeGreaterThanOrEqual(14);
      expect(result.totalAssertions).toBe(result.passedAssertions);
      expect(result.passedTests).toBe(7);
      expect(result.totalTests).toBe(7);
    }, 15000);
  });
});
