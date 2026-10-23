import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_TRACKING_SLA_WINDOW_MS, TrackingStateMachine } from "@tessera/paypal";
import { Redis } from "ioredis";

export interface WorkerInstance {
  trackingStateMachine: TrackingStateMachine;
  stop: () => Promise<void>;
}

export async function startWorker(): Promise<WorkerInstance> {
  const redisUrl = process.env.REDIS_URL;
  let redis: Redis | undefined;

  if (redisUrl) {
    try {
      redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await redis.connect().catch((err) => {
        console.warn(
          "[tessera-worker] Redis connection failed, falling back to local ticker:",
          err instanceof Error ? err.message : String(err),
        );
        redis?.disconnect();
        redis = undefined;
      });
    } catch {
      redis?.disconnect();
      redis = undefined;
    }
  }

  const trackingStateMachine = new TrackingStateMachine({
    slaWindowMs: DEFAULT_TRACKING_SLA_WINDOW_MS,
  });

  let isRunning = true;
  console.log(
    `[tessera-worker] Background tracking sync & SLA monitor started (SLA window: ${DEFAULT_TRACKING_SLA_WINDOW_MS}ms)`,
  );

  const timer = setInterval(async () => {
    if (!isRunning) return;
    try {
      // Periodic tracking sync and SLA monitor sweep
      if (redis) {
        const activeTrackingKeys = await redis.keys("tracking:*").catch(() => []);
        for (const key of activeTrackingKeys) {
          const raw = await redis.get(key).catch(() => null);
          if (!raw) continue;
          try {
            const data = JSON.parse(raw);
            if (data?.dispatchedAt && data?.status) {
              const sla = trackingStateMachine.checkSlaStatus({
                shipmentCreatedAt: data.dispatchedAt,
                lastMilestone: data.status,
              });
              if (sla.isBreached) {
                console.warn(
                  `[tessera-worker] SLA breached for ${key}: recommendation=${sla.recommendation}`,
                );
              }
            }
          } catch {
            // Skip malformed entries
          }
        }
      }
    } catch (err) {
      console.error("[tessera-worker] Error during SLA sweep cycle:", err);
    }
  }, 10000);

  return {
    trackingStateMachine,
    stop: async () => {
      isRunning = false;
      clearInterval(timer);
      if (redis) {
        redis.disconnect();
      }
      console.log("[tessera-worker] Worker stopped gracefully");
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
  startWorker().catch((err) => {
    console.error("[tessera-worker] Fatal error:", err);
    process.exit(1);
  });
}
