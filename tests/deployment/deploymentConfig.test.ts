import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

describe("Production Infrastructure Configuration", () => {
  const rootDir = path.resolve(__dirname, "../../");

  it("validates render.yaml blueprint against schema requirements", () => {
    const renderPath = path.join(rootDir, "render.yaml");
    expect(fs.existsSync(renderPath)).toBe(true);

    const raw = fs.readFileSync(renderPath, "utf8");
    const doc = YAML.parse(raw);

    expect(doc.version).toBe("1");
    expect(Array.isArray(doc.services)).toBe(true);
    expect(Array.isArray(doc.databases)).toBe(true);

    const serviceNames = doc.services.map((s: { name: string }) => s.name);
    expect(serviceNames).toContain("tessera-api");
    expect(serviceNames).toContain("tessera-worker");
    expect(serviceNames).toContain("tessera-dashboard");
    expect(serviceNames).toContain("tessera-redis");

    const dbNames = doc.databases.map((d: { name: string }) => d.name);
    expect(dbNames).toContain("tessera-postgres");

    // Check tessera-api configuration
    const api = doc.services.find((s: { name: string }) => s.name === "tessera-api");
    expect(api.type).toBe("web");
    expect(api.runtime).toBe("node");
    expect(api.healthCheckPath).toBe("/health/live");

    // Check tessera-worker configuration
    const worker = doc.services.find((s: { name: string }) => s.name === "tessera-worker");
    expect(worker.type).toBe("worker");
    expect(worker.runtime).toBe("node");

    // Check tessera-dashboard configuration
    const dashboard = doc.services.find((s: { name: string }) => s.name === "tessera-dashboard");
    expect(dashboard.type).toBe("web");
    expect(dashboard.runtime).toBe("static");
    expect(dashboard.staticPublishPath).toBe("./apps/clearinghouse-ui/dist");
    expect(dashboard.routes).toBeDefined();
    const dashboardEnvKeys = (dashboard.envVars || []).map((e: { key: string }) => e.key);
    expect(dashboardEnvKeys).toContain("VITE_CLEARINGHOUSE_WS_URL");

    // Check tessera-redis configuration
    const redis = doc.services.find((s: { name: string }) => s.name === "tessera-redis");
    expect(redis.type).toBe("keyvalue");
  });

  it("validates docker-compose.yml configuration and service dependencies", () => {
    const composePath = path.join(rootDir, "docker-compose.yml");
    expect(fs.existsSync(composePath)).toBe(true);

    const raw = fs.readFileSync(composePath, "utf8");
    const compose = YAML.parse(raw);

    expect(compose.services).toBeDefined();
    const serviceNames = Object.keys(compose.services);

    expect(serviceNames).toContain("tessera-postgres");
    expect(serviceNames).toContain("tessera-redis");
    expect(serviceNames).toContain("tessera-api");
    expect(serviceNames).toContain("tessera-worker");
    expect(serviceNames).toContain("tessera-dashboard");

    expect(compose.services["tessera-postgres"].healthcheck).toBeDefined();
    expect(compose.services["tessera-redis"].healthcheck).toBeDefined();
    expect(compose.services["tessera-api"].healthcheck).toBeDefined();
  });

  it("validates multi-stage Dockerfile stages and non-root security", () => {
    const dockerfilePath = path.join(rootDir, "Dockerfile");
    expect(fs.existsSync(dockerfilePath)).toBe(true);

    const content = fs.readFileSync(dockerfilePath, "utf8");

    expect(content).toContain("FROM node:20-alpine AS base");
    expect(content).toContain("FROM base AS dependencies");
    expect(content).toContain("FROM dependencies AS builder");
    expect(content).toContain("FROM builder AS prod-dependencies");
    expect(content).toContain("pnpm prune --prod");
    expect(content).toContain("FROM node:20-alpine AS runner");
    expect(content).toContain("FROM nginx:alpine AS dashboard");
    expect(content).toContain("adduser --system --uid 1001 tessera");
    expect(content).toContain("USER tessera");
    expect(content).toContain("EXPOSE 3000");
  });
});
