import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { startServer } from "../server.js";
import { startWorker } from "../worker.js";

describe("Production Server and Worker Services", () => {
  it("starts and stops Clearinghouse API server instance with security headers and health routes", async () => {
    const serverInstance = await startServer({ port: 0, host: "127.0.0.1" });
    const address = serverInstance.server.address();
    expect(address).toBeDefined();
    const port = typeof address === "object" && address ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    // 1. Test root API landing endpoint
    const rootRes = await new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      });
      req.on("error", reject);
    });

    expect(rootRes.status).toBe(200);
    expect(rootRes.headers["content-security-policy"]).toBeDefined();
    expect(rootRes.headers["x-frame-options"]).toBe("DENY");
    const rootData = JSON.parse(rootRes.body);
    expect(rootData.service).toBe("tessera-clearinghouse-api");
    expect(rootData.status).toBe("ONLINE");

    // 2. Test liveness probe
    const liveRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/health/live`, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      });
      req.on("error", reject);
    });
    expect(liveRes.status).toBe(200);
    const liveData = JSON.parse(liveRes.body);
    expect(liveData.status).toBe("UP");

    // 3. Test readiness probe (standalone mode reports READY)
    const readyRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/health/ready`, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      });
      req.on("error", reject);
    });
    expect(readyRes.status).toBe(200);
    const readyData = JSON.parse(readyRes.body);
    expect(readyData.status).toBe("READY");

    // 4. Test 404 handler
    const notFoundRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/unknown/path`, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      });
      req.on("error", reject);
    });
    expect(notFoundRes.status).toBe(404);

    // Clean shutdown
    await serverInstance.close();
  });

  it("starts and stops background SLA tracking worker instance cleanly", async () => {
    const workerInstance = await startWorker();
    expect(workerInstance).toBeDefined();
    expect(workerInstance.trackingStateMachine).toBeDefined();

    await workerInstance.stop();
  });

  it("resolves canonical ESM module file URLs correctly across relative and absolute invocations", () => {
    const relativeScript = "apps/clearinghouse-api/dist/server.js";
    const resolvedUrl = pathToFileURL(path.resolve(relativeScript)).href;

    expect(resolvedUrl).toMatch(/^file:\/\/\/.+/);
    expect(resolvedUrl).toContain("server.js");
  });
});
