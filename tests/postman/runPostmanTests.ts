import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import newmanPkg from "newman";

// Interop with CommonJS/ESM newman export
type NewmanType = typeof newmanPkg;
const newman: NewmanType =
  // biome-ignore lint/suspicious/noExplicitAny: CommonJS interop
  (newmanPkg as any).default || newmanPkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_COLLECTION_PATH = path.resolve(__dirname, "tessera.postman_collection.json");
export const DEFAULT_ENVIRONMENT_PATH = path.resolve(__dirname, "tessera.postman_environment.json");

export interface MockServerInstance {
  server: http.Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

/**
 * Creates and starts a lightweight local HTTP mock server adhering to the
 * Tessera Clearinghouse API and PayPal REST contracts for headless Postman testing.
 */
export function createMockServer(port = 0): Promise<MockServerInstance> {
  return new Promise((resolve, reject) => {
    let issuedAccessToken: string | undefined;

    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const method = req.method?.toUpperCase() || "GET";

      // Enable CORS & JSON headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, PayPal-Request-Id, Prefer",
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // 1. OAuth2 Token Acquisition
      if (method === "POST" && pathname === "/v1/oauth2/token") {
        const accessToken = `mock_jwt_access_token_${Date.now()}`;
        issuedAccessToken = accessToken;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: 32400,
            scope: "https://uri.paypal.com/services/payments/orders",
          }),
        );
        return;
      }

      const isProtectedRoute =
        (method === "POST" &&
          [
            "/api/v1/mandates/verify",
            "/v2/checkout/orders",
            "/v1/notifications/verify-webhook-signature",
          ].includes(pathname)) ||
        (method === "GET" && pathname === "/v1/shipping/trackers") ||
        (method === "POST" &&
          (/^\/v2\/payments\/authorizations\/[^/]+\/capture$/.test(pathname) ||
            /^\/v2\/payments\/authorizations\/[^/]+\/void$/.test(pathname)));

      if (
        isProtectedRoute &&
        (!issuedAccessToken || req.headers.authorization !== `Bearer ${issuedAccessToken}`)
      ) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            name: "AUTHENTICATION_ERROR",
            message: "Missing or invalid Bearer access token",
          }),
        );
        return;
      }

      // 2. AP2 Mandate Verification
      if (method === "POST" && pathname === "/api/v1/mandates/verify") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            valid: true,
            status: "VERIFIED",
            mandate_id: "mnd_checkout_bestbuy_01",
            vct: "mandate.payment.1",
            amount: {
              amount: 24999,
              currency: "USD",
            },
          }),
        );
        return;
      }

      // 3. Orders v2 Escrow Authorization Hold
      if (method === "POST" && pathname === "/v2/checkout/orders") {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "ORD-9876543210",
            status: "CREATED",
            intent: "AUTHORIZE",
            authorization_id: "AUTH-1234567890",
            purchase_units: [
              {
                reference_id: "tessera-escrow-unit-1",
                amount: {
                  currency_code: "USD",
                  value: "249.99",
                },
                description: "Channel3 Escrow Hold for AP2 Mandate",
              },
            ],
          }),
        );
        return;
      }

      // 4. Webhook Signature Verification
      if (method === "POST" && pathname === "/v1/notifications/verify-webhook-signature") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            verification_status: "SUCCESS",
          }),
        );
        return;
      }

      // 5. Shipment Tracking Milestone Check
      if (method === "GET" && pathname === "/v1/shipping/trackers") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "TRK-9876543210",
            transaction_id: "ORD-9876543210",
            tracking_number: "FEDEX-99887766",
            status: "DELIVERED",
            carrier: "FEDEX",
          }),
        );
        return;
      }

      // 6. Milestone Escrow Capture Release
      if (method === "POST" && /^\/v2\/payments\/authorizations\/[^/]+\/capture$/.test(pathname)) {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "CAP-1234567890",
            status: "COMPLETED",
            final_capture: true,
            amount: {
              currency_code: "USD",
              value: "249.99",
            },
          }),
        );
        return;
      }

      // 7. Authorization Void on SLA Breach
      if (method === "POST" && /^\/v2\/payments\/authorizations\/[^/]+\/void$/.test(pathname)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "AUTH-1234567890",
            status: "VOIDED",
          }),
        );
        return;
      }

      // 404 Fallback
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          name: "RESOURCE_NOT_FOUND",
          message: `Endpoint ${method} ${pathname} not found on mock server`,
        }),
      );
    });

    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to obtain server address"));
        return;
      }
      const actualPort = address.port;
      const url = `http://127.0.0.1:${actualPort}`;
      resolve({
        server,
        port: actualPort,
        url,
        close: () =>
          new Promise<void>((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    });

    server.on("error", (err) => {
      reject(err);
    });
  });
}

export interface RunPostmanTestsOptions {
  collectionPath?: string;
  environmentPath?: string;
  port?: number;
  baseUrl?: string;
  reporters?: string | string[];
  bail?: boolean;
}

export interface RunPostmanTestsResult {
  summary: newmanPkg.NewmanRunSummary;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  totalAssertions: number;
  passedAssertions: number;
  failedAssertions: number;
  failures: newmanPkg.NewmanRunFailure[];
}

/**
 * Runs the Postman test collection headlessly against the clearinghouse mock server.
 */
export async function runPostmanTests(
  options: RunPostmanTestsOptions = {},
): Promise<RunPostmanTestsResult> {
  const collectionPath = options.collectionPath ?? DEFAULT_COLLECTION_PATH;
  const environmentPath = options.environmentPath ?? DEFAULT_ENVIRONMENT_PATH;

  let mockInstance: MockServerInstance | undefined;
  let targetUrl = options.baseUrl;

  if (!targetUrl) {
    mockInstance = await createMockServer(options.port ?? 0);
    targetUrl = mockInstance.url;
  }

  try {
    return await new Promise<RunPostmanTestsResult>((resolve, reject) => {
      newman.run(
        {
          collection: collectionPath,
          environment: environmentPath,
          envVar: [{ key: "baseUrl", value: targetUrl }],
          reporters: options.reporters ?? ["cli"],
          bail: options.bail ?? false,
        },
        (err, summary) => {
          if (err) {
            reject(err);
            return;
          }

          const stats = summary.run.stats.tests;
          const totalTests = stats.total ?? 0;
          const failedTests = stats.failed ?? 0;
          const passedTests = totalTests - failedTests;

          const assertionStats = summary.run.stats.assertions;
          const totalAssertions = assertionStats.total ?? 0;
          const failedAssertions = assertionStats.failed ?? 0;
          const passedAssertions = totalAssertions - failedAssertions;

          const failures = summary.run.failures ?? [];

          resolve({
            summary,
            totalTests,
            passedTests,
            failedTests,
            totalAssertions,
            passedAssertions,
            failedAssertions,
            failures,
          });
        },
      );
    });
  } finally {
    if (mockInstance) {
      await mockInstance.close();
    }
  }
}

// Direct CLI invocation handler
const isDirectCli =
  process.argv[1] &&
  (process.argv[1].endsWith("runPostmanTests.ts") ||
    process.argv[1].endsWith("runPostmanTests.js"));

if (isDirectCli) {
  runPostmanTests()
    .then((result) => {
      if (result.failedAssertions > 0 || result.failedTests > 0) {
        console.error(
          `Postman test suite failed with ${result.failedAssertions} assertion failure(s) out of ${result.totalAssertions}.`,
        );
        process.exit(1);
      }
      console.log(
        `Postman test suite passed: ${result.passedAssertions}/${result.totalAssertions} assertions passed cleanly across ${result.totalTests} requests.`,
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error("Fatal error running Postman test runner:", err);
      process.exit(1);
    });
}
