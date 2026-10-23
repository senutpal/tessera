import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { checkDatabaseConnectivity, handleHealthRoutes } from "../index.js";

describe("Health Check Routes", () => {
  function createMockResponse() {
    let statusCode = 200;
    const headers = new Map<string, string>();
    let body = "";

    const res = {
      writeHead: (code: number, hdrs?: Record<string, string>) => {
        statusCode = code;
        if (hdrs) {
          for (const [k, v] of Object.entries(hdrs)) {
            headers.set(k, v);
          }
        }
      },
      setHeader: (k: string, v: string) => headers.set(k, v),
      end: (data?: string) => {
        if (data) body = data;
      },
    } as unknown as ServerResponse;

    return {
      res,
      getStatusCode: () => statusCode,
      getHeaders: () => headers,
      getBody: () => body,
      getJson: () => JSON.parse(body),
    };
  }

  it("handles /health/live liveness probe with HTTP 200 UP", async () => {
    const mock = createMockResponse();
    const req = { url: "/health/live" } as IncomingMessage;

    const handled = await handleHealthRoutes(req, mock.res);
    expect(handled).toBe(true);
    expect(mock.getStatusCode()).toBe(200);

    const json = mock.getJson();
    expect(json.status).toBe("UP");
    expect(json.timestamp).toBeDefined();
  });

  it("handles /health/ready readiness probe with HTTP 200 READY when all dependencies healthy", async () => {
    const mock = createMockResponse();
    const req = { url: "/health/ready" } as IncomingMessage;

    const handled = await handleHealthRoutes(req, mock.res, {
      checkDatabase: async () => true,
      checkRedis: async () => true,
    });

    expect(handled).toBe(true);
    expect(mock.getStatusCode()).toBe(200);

    const json = mock.getJson();
    expect(json.status).toBe("READY");
    expect(json.checks.database).toBe("UP");
    expect(json.checks.redis).toBe("UP");
    expect(json.timestamp).toBeDefined();
  });

  it("handles /health/ready with HTTP 503 DEGRADED when database is DOWN", async () => {
    const mock = createMockResponse();
    const req = { url: "/health/ready" } as IncomingMessage;

    const handled = await handleHealthRoutes(req, mock.res, {
      checkDatabase: async () => false,
      checkRedis: async () => true,
    });

    expect(handled).toBe(true);
    expect(mock.getStatusCode()).toBe(503);

    const json = mock.getJson();
    expect(json.status).toBe("DEGRADED");
    expect(json.checks.database).toBe("DOWN");
    expect(json.checks.redis).toBe("UP");
    expect(json.error).toBeDefined();
  });

  it("handles /health/ready with HTTP 503 DEGRADED when database throws error", async () => {
    const mock = createMockResponse();
    const req = { url: "/health/ready" } as IncomingMessage;

    const handled = await handleHealthRoutes(req, mock.res, {
      checkDatabase: async () => {
        throw new Error("PostgreSQL connection timeout");
      },
      checkRedis: async () => true,
    });

    expect(handled).toBe(true);
    expect(mock.getStatusCode()).toBe(503);

    const json = mock.getJson();
    expect(json.status).toBe("DEGRADED");
    expect(json.checks.database).toBe("DOWN");
    expect(json.checks.redis).toBe("UP");
    expect(json.error).toContain("Database subsystem check failed");
  });

  it("handles /health/ready with HTTP 503 DEGRADED when Redis ping fails", async () => {
    const mock = createMockResponse();
    const req = { url: "/health/ready" } as IncomingMessage;

    const failingRedis = {
      ping: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:6379");
      },
    };

    const handled = await handleHealthRoutes(req, mock.res, {
      checkDatabase: async () => true,
      redis: failingRedis,
    });

    expect(handled).toBe(true);
    expect(mock.getStatusCode()).toBe(503);

    const json = mock.getJson();
    expect(json.status).toBe("DEGRADED");
    expect(json.checks.database).toBe("UP");
    expect(json.checks.redis).toBe("DOWN");
    expect(json.error).toContain("Redis ping check failed");
  });

  it("returns false for non-health routes without touching response", async () => {
    const mock = createMockResponse();
    const req = { url: "/api/v1/mandates" } as IncomingMessage;

    const handled = await handleHealthRoutes(req, mock.res);
    expect(handled).toBe(false);
    expect(mock.getBody()).toBe("");
  });

  it("verifies checkDatabaseConnectivity handles empty and invalid URLs safely", async () => {
    // When no URL is provided, returns true for standalone development fallback
    const emptyResult = await checkDatabaseConnectivity();
    expect(emptyResult).toBe(true);

    // When an invalid URL is provided, returns false safely
    const invalidResult = await checkDatabaseConnectivity("invalid-scheme://hostname");
    expect(invalidResult).toBe(false);

    // When an unreachable port is provided, returns false cleanly
    const unreachableResult = await checkDatabaseConnectivity(
      "postgresql://127.0.0.1:65530/testdb",
    );
    expect(unreachableResult).toBe(false);
  });
});
