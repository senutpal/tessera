// Public entry point for @tessera/mcp-server
// Deep module exposing Tessera Model Context Protocol server, tools, and autonomous procurement loop

// Autonomous Agent Procurement Orchestration Loop
export {
  type AgentProcurementOptions,
  type AgentProcurementResult,
  type ProcurementStepAudit,
  type ProcurementStepName,
  type ProcurementStepStatus,
  runAgentProcurementLoop,
} from "./lib/orchestrator/agentProcurementLoop.js";
// MCP Server Instance & Transports
export {
  startMcpServer,
  TesseraMcpServer,
  type TesseraMcpServerOptions,
} from "./lib/server/tesseraMcpServer.js";
export {
  type CheckSettlementContext,
  type CheckSettlementInput,
  CheckSettlementInputSchema,
  CheckSettlementInputShape,
  registerCheckSettlementTool,
} from "./lib/tools/checkSettlementTool.js";
// Tessera Commerce MCP Tool Suite
export {
  registerSearchCatalogTool,
  type SearchCatalogContext,
  type SearchCatalogInput,
  SearchCatalogInputSchema,
  SearchCatalogInputShape,
} from "./lib/tools/searchCatalogTool.js";
export {
  registerSubmitMandateTool,
  type SubmitMandateContext,
  type SubmitMandateInput,
  SubmitMandateInputSchema,
  SubmitMandateInputShape,
} from "./lib/tools/submitMandateTool.js";
