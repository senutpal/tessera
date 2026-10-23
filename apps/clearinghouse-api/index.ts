// Public entry point for @tessera/clearinghouse-api
// Deep module exposing clearinghouse WebSocket streaming server, security, and health routing.

export {
  checkDatabaseConnectivity,
  type HealthCheckOptions,
  type HealthLivenessResponse,
  type HealthReadinessResponse,
  handleHealthRoutes,
  type RedisPingable,
} from "./lib/routes/healthRoutes.js";
export {
  createRateLimitMiddleware,
  extractClientIdentifier,
  RateLimiter,
  type RateLimiterOptions,
  type RateLimitResult,
  type RedisClientLike,
} from "./lib/security/rateLimiter.js";

export {
  applySecurityHeaders,
  createSecurityHeadersMiddleware,
  DEFAULT_SECURITY_HEADERS,
  type SecurityHeadersOptions,
} from "./lib/security/securityHeaders.js";
export {
  type AuthenticateFunction,
  type AuthenticateResult,
  ClearinghouseSocketServer,
  type ClearinghouseSocketServerOptions,
  createClearinghouseSocketServer,
} from "./lib/websocket/clearinghouseSocketServer.js";
export {
  type ClientSession,
  SessionManager,
} from "./lib/websocket/sessionManager.js";
