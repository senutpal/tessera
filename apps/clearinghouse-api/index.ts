// Public entry point for @tessera/clearinghouse-api
// Deep module exposing clearinghouse WebSocket streaming server and session management.

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
