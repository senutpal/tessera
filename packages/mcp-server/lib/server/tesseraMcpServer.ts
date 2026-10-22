import type { ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Channel3Client } from "@tessera/channel3";
import type { NonceStore } from "@tessera/mandates";
import type {
  AuthorizeOrderOptions,
  CreateEscrowOrderOptions,
  EscrowAuthorization,
  EscrowOrder,
  PayPalClient,
  PayPalConfig,
  ShipmentMilestone,
} from "@tessera/paypal";
import type { PolicyEngine } from "@tessera/policy";
import { registerCheckSettlementTool } from "../tools/checkSettlementTool.js";
import { registerSearchCatalogTool } from "../tools/searchCatalogTool.js";
import { registerSubmitMandateTool } from "../tools/submitMandateTool.js";

export interface TesseraMcpServerOptions {
  name?: string | undefined;
  version?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  channel3Client?: Channel3Client | undefined;
  searchProductsFn?:
    | ((params: { query: string; limit?: number | undefined }) => Promise<unknown>)
    | undefined;
  paypalClient?: PayPalClient | undefined;
  paypalConfig?: PayPalConfig | undefined;
  policyEngine?: PolicyEngine | undefined;
  nonceStore?: NonceStore | undefined;
  createEscrowOrderFn?: ((options: CreateEscrowOrderOptions) => Promise<EscrowOrder>) | undefined;
  authorizeOrderFn?: ((options: AuthorizeOrderOptions) => Promise<EscrowAuthorization>) | undefined;
  getOrderFn?: ((orderId: string) => Promise<EscrowOrder>) | undefined;
  getShipmentTrackingFn?:
    | ((txOrTrackerId: string, trackingNumber?: string | undefined) => Promise<ShipmentMilestone>)
    | undefined;
}

export class TesseraMcpServer {
  private readonly mcpServer: McpServer;
  private readonly options: TesseraMcpServerOptions;

  constructor(options: TesseraMcpServerOptions = {}) {
    this.options = options;
    this.mcpServer = new McpServer(
      {
        name: options.name ?? "tessera-clearinghouse",
        version: options.version ?? "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
        instructions:
          "Tessera Autonomous Commerce Clearinghouse Protocol Server.\n" +
          "Use `tessera_search_catalog` to discover retail products and evaluate live quotes.\n" +
          "Use `tessera_submit_mandate` to authorize funds in escrow using signed AP2 mandates.\n" +
          "Use `tessera_check_settlement` to inspect carrier delivery and escrow settlement readiness.",
      },
    );

    this.registerTools();
  }

  private registerTools(): void {
    registerSearchCatalogTool(this.mcpServer, {
      channel3Client: this.options.channel3Client,
      searchProductsFn: this.options.searchProductsFn,
    });

    registerSubmitMandateTool(this.mcpServer, {
      paypalClient: this.options.paypalClient,
      paypalConfig: this.options.paypalConfig,
      policyEngine: this.options.policyEngine,
      nonceStore: this.options.nonceStore,
      createEscrowOrderFn: this.options.createEscrowOrderFn,
      authorizeOrderFn: this.options.authorizeOrderFn,
    });

    registerCheckSettlementTool(this.mcpServer, {
      paypalClient: this.options.paypalClient,
      paypalConfig: this.options.paypalConfig,
      getOrderFn: this.options.getOrderFn,
      getShipmentTrackingFn: this.options.getShipmentTrackingFn,
    });
  }

  /**
   * Connects the MCP server to a given transport.
   */
  public async connect(transport: Transport): Promise<void> {
    await this.mcpServer.connect(transport);
  }

  /**
   * Starts the server using stdio transport (for Cursor, Claude Code, and CLI agents).
   */
  public async startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.connect(transport);
  }

  /**
   * Creates an SSE server transport and connects it (for browser/web agents).
   */
  public async createSseTransport(
    endpoint: string,
    res: ServerResponse,
  ): Promise<SSEServerTransport> {
    const transport = new SSEServerTransport(endpoint, res);
    await this.connect(transport);
    return transport;
  }

  /**
   * Closes the MCP server and disconnects any active transports.
   */
  public async close(): Promise<void> {
    await this.mcpServer.close();
  }

  /**
   * Returns the underlying McpServer instance.
   */
  public getMcpServer(): McpServer {
    return this.mcpServer;
  }
}

/**
 * Convenience helper to start the Tessera MCP Server with optional transport.
 */
export async function startMcpServer(
  options?: TesseraMcpServerOptions & {
    transport?: "stdio" | Transport | undefined;
  },
): Promise<TesseraMcpServer> {
  const server = new TesseraMcpServer(options);

  if (options?.transport === "stdio") {
    await server.startStdio();
  } else if (options?.transport) {
    await server.connect(options.transport);
  }

  return server;
}
