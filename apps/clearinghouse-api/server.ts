import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Redis } from "ioredis";
import {
  applySecurityHeaders,
  checkDatabaseConnectivity,
  createClearinghouseSocketServer,
  createRateLimitMiddleware,
  handleHealthRoutes,
} from "./index.js";

export interface ServerInstance {
  server: ReturnType<typeof createServer>;
  socketServer: ReturnType<typeof createClearinghouseSocketServer>;
  port: number;
  host: string;
  close: () => Promise<void>;
}

export async function startServer(
  options: { port?: number; host?: string } = {},
): Promise<ServerInstance> {
  const port = options.port ?? Number(process.env.PORT || 3000);
  const host = options.host ?? (process.env.HOST || "0.0.0.0");
  const redisUrl = process.env.REDIS_URL;

  const redisConfigured = Boolean(redisUrl);
  let redisConnected = false;
  let redis: Redis | undefined;
  if (redisUrl) {
    try {
      redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await redis
        .connect()
        .then(() => {
          redisConnected = true;
        })
        .catch((err) => {
          console.warn(
            "[tessera-api] Redis connection failed, falling back to in-memory:",
            err instanceof Error ? err.message : String(err),
          );
          redis?.disconnect();
          redis = undefined;
          redisConnected = false;
        });
    } catch {
      redis?.disconnect();
      redis = undefined;
      redisConnected = false;
    }
  }

  const rateLimitMiddleware = createRateLimitMiddleware({
    redis,
    windowMs: 60000,
    max: 1000,
    trustProxyHops: Number(process.env.TRUSTED_PROXY_HOPS || 0),
  });

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 1. Security Headers (CSP, HSTS, X-Frame-Options, etc.)
    applySecurityHeaders(res);

    // 2. Health check routes (/health/live, /health/ready)
    const handled = await handleHealthRoutes(req, res, {
      redis,
      checkDatabase: async () => {
        return checkDatabaseConnectivity(process.env.DATABASE_URL);
      },
      checkRedis: async () => {
        if (!redisConfigured) return true;
        if (!redis || !redisConnected) return false;
        try {
          return (await redis.ping()) === "PONG";
        } catch {
          return false;
        }
      },
    });
    if (handled) return;

    // 3. Sliding window rate limiting
    const allowed = await rateLimitMiddleware(req, res);
    if (!allowed) return;

    // 4. API Landing & Health endpoints
    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/" || pathname === "/api" || pathname === "/api/v1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          service: "tessera-clearinghouse-api",
          status: "ONLINE",
          version: "1.0.0",
          wsEndpoint: "/ws/clearinghouse",
          healthCheck: {
            live: "/health/live",
            ready: "/health/ready",
          },
        }),
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "NOT_FOUND", path: pathname }));
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res).catch((err) => {
      console.error("[tessera-api] Unhandled request error:", err);
      if (!res.headersSent) {
        const isBadUrl = err instanceof TypeError && /Invalid URL/.test(err.message);
        res.writeHead(isBadUrl ? 400 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: isBadUrl ? "BAD_REQUEST" : "INTERNAL_ERROR" }));
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  const socketServer = createClearinghouseSocketServer({
    server,
    path: "/ws/clearinghouse",
  });

  await socketServer.start();

  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => {
      resolve();
    });
    server.once("error", reject);
  });

  return {
    server,
    socketServer,
    port,
    host,
    close: async () => {
      await socketServer.close();
      if (redis) {
        redis.disconnect();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const isMainScript = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    const invokedUrl = pathToFileURL(path.resolve(process.argv[1])).href;
    return import.meta.url === invokedUrl;
  } catch {
    return false;
  }
};

if (process.env.NODE_ENV !== "test" && isMainScript()) {
  startServer().then(({ host, port }) => {
    console.log(`[tessera-api] Production service running on ${host}:${port}`);
  });
}
