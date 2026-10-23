import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { applySecurityHeaders, createSecurityHeadersMiddleware } from "../index.js";

describe("Security Headers Middleware", () => {
  it("applies default OWASP and Helmet compliant security headers", () => {
    const headersMap = new Map<string, string>();
    const mockRes = {
      setHeader: (name: string, value: string) => {
        headersMap.set(name, value);
      },
    } as unknown as ServerResponse;

    applySecurityHeaders(mockRes);

    expect(headersMap.get("X-Frame-Options")).toBe("DENY");
    expect(headersMap.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headersMap.get("Strict-Transport-Security")).toContain("max-age=31536000");
    expect(headersMap.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(headersMap.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headersMap.get("X-XSS-Protection")).toBe("0");
    expect(headersMap.get("Permissions-Policy")).toContain("geolocation=()");
    expect(headersMap.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(headersMap.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  it("allows selective overriding of security headers", () => {
    const headersMap = new Map<string, string>();
    const mockRes = {
      setHeader: (name: string, value: string) => {
        headersMap.set(name, value);
      },
    } as unknown as ServerResponse;

    applySecurityHeaders(mockRes, {
      xFrameOptions: "SAMEORIGIN",
      contentSecurityPolicy: false,
    });

    expect(headersMap.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(headersMap.has("Content-Security-Policy")).toBe(false);
    expect(headersMap.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("executes middleware and invokes next() callback", () => {
    const middleware = createSecurityHeadersMiddleware();
    const headersMap = new Map<string, string>();
    const mockReq = {} as IncomingMessage;
    const mockRes = {
      setHeader: (name: string, value: string) => {
        headersMap.set(name, value);
      },
    } as unknown as ServerResponse;

    let nextCalled = false;
    middleware(mockReq, mockRes, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(headersMap.get("X-Frame-Options")).toBe("DENY");
  });
});
