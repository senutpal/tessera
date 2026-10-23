import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";

export interface RedisPingable {
  ping(): Promise<string>;
}

export interface HealthCheckOptions {
  checkDatabase?: (() => Promise<boolean>) | undefined;
  checkRedis?: (() => Promise<boolean>) | undefined;
  redis?: RedisPingable | undefined;
}

/**
 * Checks TCP socket connectivity to a PostgreSQL database if DATABASE_URL is configured.
 * When databaseUrl is omitted (e.g. standalone local testing), reports healthy.
 */
export async function checkDatabaseConnectivity(databaseUrl?: string): Promise<boolean> {
  if (!databaseUrl) {
    return true;
  }
  try {
    const parsed = new URL(databaseUrl);
    const host = parsed.hostname;
    const port = Number(parsed.port) || 5432;
    return await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(2000);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
  } catch {
    return false;
  }
}

export interface HealthLivenessResponse {
  status: "UP";
  timestamp: string;
}

export interface HealthReadinessResponse {
  status: "READY" | "DEGRADED";
  checks: {
    database: "UP" | "DOWN";
    redis: "UP" | "DOWN";
  };
  timestamp: string;
  error?: string | undefined;
}

/**
 * Handles /health/live and /health/ready requests.
 * Returns true if request was handled as a health check route, false otherwise.
 */
export async function handleHealthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  options: HealthCheckOptions = {},
): Promise<boolean> {
  const url = req.url || "/";
  const pathname = new URL(url, "http://127.0.0.1").pathname;

  if (pathname === "/health/live") {
    const payload: HealthLivenessResponse = {
      status: "UP",
      timestamp: new Date().toISOString(),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
    return true;
  }

  if (pathname === "/health/ready") {
    let databaseHealthy = true;
    let redisHealthy = true;
    let failureDetail: string | undefined;

    // Check Database Connectivity
    if (options.checkDatabase) {
      try {
        databaseHealthy = await options.checkDatabase();
        if (!databaseHealthy) {
          failureDetail = "Database subsystem check failed";
        }
      } catch (err) {
        databaseHealthy = false;
        failureDetail = err instanceof Error ? err.message : String(err);
      }
    } else if (process.env.DATABASE_URL) {
      try {
        databaseHealthy = await checkDatabaseConnectivity(process.env.DATABASE_URL);
        if (!databaseHealthy) {
          failureDetail = "Database connection check failed";
        }
      } catch (err) {
        databaseHealthy = false;
        failureDetail = err instanceof Error ? err.message : String(err);
      }
    }

    // Check Redis Connectivity
    if (options.checkRedis) {
      try {
        redisHealthy = await options.checkRedis();
        if (!redisHealthy) {
          failureDetail = failureDetail
            ? `${failureDetail}; Redis subsystem check failed`
            : "Redis subsystem check failed";
        }
      } catch (err) {
        redisHealthy = false;
        failureDetail = failureDetail
          ? `${failureDetail}; ${err instanceof Error ? err.message : String(err)}`
          : err instanceof Error
            ? err.message
            : String(err);
      }
    } else if (options.redis) {
      try {
        const pingResult = await options.redis.ping();
        redisHealthy = pingResult === "PONG";
        if (!redisHealthy) {
          failureDetail = failureDetail
            ? `${failureDetail}; Redis ping returned ${pingResult}`
            : `Redis ping returned ${pingResult}`;
        }
      } catch (err) {
        redisHealthy = false;
        failureDetail = failureDetail
          ? `${failureDetail}; ${err instanceof Error ? err.message : String(err)}`
          : err instanceof Error
            ? err.message
            : String(err);
      }
    }

    const isReady = databaseHealthy && redisHealthy;
    const responsePayload: HealthReadinessResponse = {
      status: isReady ? "READY" : "DEGRADED",
      checks: {
        database: databaseHealthy ? "UP" : "DOWN",
        redis: redisHealthy ? "UP" : "DOWN",
      },
      timestamp: new Date().toISOString(),
      ...(failureDetail ? { error: failureDetail } : {}),
    };

    const statusCode = isReady ? 200 : 503;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responsePayload));
    return true;
  }

  return false;
}
