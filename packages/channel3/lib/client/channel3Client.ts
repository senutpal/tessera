import { normalizeSearchResults } from "../normalizer/catalogNormalizer.js";
import { optimizeQuote } from "../optimizer/quoteOptimizer.js";
import {
  type Channel3ClientOptions,
  Channel3Error,
  Channel3McpError,
  Channel3TimeoutError,
  type HighLevelSearchOptions,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type MandateQuoteConstraints,
  type ProcurementQuote,
  type QuoteOptimizationResult,
  type SearchProductsOptions,
  SearchProductsResultSchema,
  type SearchProductsResultWire,
} from "../types/channel3.js";

const DEFAULT_MCP_ENDPOINT = "https://mcp.trychannel3.com/";
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_INITIAL_BACKOFF_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Channel3Client {
  public readonly endpoint: string;
  private readonly apiKey?: string | undefined;
  public readonly timeoutMs: number;
  public readonly maxRetries: number;
  public readonly initialBackoffMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private currentThreadId?: string | undefined;

  constructor(options: Channel3ClientOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_MCP_ENDPOINT;
    if (options.apiKey !== undefined) {
      this.apiKey = options.apiKey;
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    if (options.threadId !== undefined) {
      this.currentThreadId = options.threadId;
    }
  }

  /**
   * Returns the current conversation thread ID.
   */
  public get threadId(): string | undefined {
    return this.currentThreadId;
  }

  /**
   * Manually sets or resets the conversation thread ID.
   */
  public set threadId(value: string | undefined) {
    this.currentThreadId = value;
  }

  /**
   * Low-level search tool invocation against Channel3 MCP server (`search_products`).
   * Adheres strictly to MCP JSON-RPC 2.0 specifications.
   */
  public async searchProducts(params: SearchProductsOptions): Promise<SearchProductsResultWire> {
    const threadIdToUse = params.threadId ?? this.currentThreadId;

    const rpcPayload: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      method: "tools/call",
      params: {
        name: "search_products",
        arguments: {
          ...(params.query ? { query: params.query } : {}),
          ...(params.imageUrl ? { image_url: params.imageUrl } : {}),
          ...(threadIdToUse ? { thread_id: threadIdToUse } : {}),
          ...(params.limit != null ? { limit: params.limit } : {}),
          ...(params.pageToken ? { page_token: params.pageToken } : {}),
        },
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const jitter = Math.random() * 50;
        const delayMs = this.initialBackoffMs * 2 ** (attempt - 1) + jitter;
        await sleep(delayMs);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchFn(this.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(rpcPayload),
          signal: controller.signal,
        });

        clearTimeout(timer);

        // If server returns rate limit (429) or transient 5xx, retry
        if (response.status === 429 || (response.status >= 500 && response.status <= 504)) {
          const bodyText = await response.text().catch(() => "");
          lastError = new Channel3McpError(
            `Channel3 MCP server returned transient HTTP ${response.status}: ${bodyText}`,
            { status: response.status, attempt, bodyText },
          );
          continue;
        }

        if (!response.ok) {
          const errBody = await response.text().catch(() => "");
          throw new Channel3McpError(
            `Channel3 MCP server returned HTTP ${response.status}: ${errBody}`,
            { status: response.status, body: errBody },
          );
        }

        const rawJson = (await response.json()) as JsonRpcResponse | Record<string, unknown>;
        const parsedWireResult = this.unwrapMcpResult(rawJson);

        // Remember thread ID for follow-up calls in this conversation
        if (parsedWireResult.thread_id) {
          this.currentThreadId = parsedWireResult.thread_id;
        }

        return parsedWireResult;
      } catch (err: unknown) {
        clearTimeout(timer);

        if (err instanceof Channel3Error) {
          throw err;
        }

        const isAbort =
          (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) ||
          controller.signal.aborted;

        if (isAbort) {
          lastError = new Channel3TimeoutError(
            `Channel3 MCP search request timed out after ${this.timeoutMs}ms`,
            { timeoutMs: this.timeoutMs, attempt },
          );
          // Timeout can be retried if attempts remain
          continue;
        }

        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (lastError instanceof Channel3TimeoutError) {
      throw lastError;
    }
    throw new Channel3McpError(
      `Channel3 MCP tool call failed after ${this.maxRetries + 1} attempts: ${lastError?.message}`,
      { originalError: lastError },
    );
  }

  /**
   * Unwraps structured content from MCP JSON-RPC response shapes.
   */
  private unwrapMcpResult(json: unknown): SearchProductsResultWire {
    if (!json || typeof json !== "object") {
      throw new Channel3McpError("Invalid non-object response from Channel3 MCP server", { json });
    }

    const obj = json as Record<string, unknown>;

    // Handle JSON-RPC error response
    if (obj.error && typeof obj.error === "object") {
      const rpcErr = obj.error as { code?: number; message?: string };
      throw new Channel3McpError(
        `MCP JSON-RPC Error: ${rpcErr.message ?? "Unknown error"} (code: ${rpcErr.code})`,
        { error: obj.error },
      );
    }

    // Candidate payload discovery
    let candidate: unknown = null;

    if (obj.result && typeof obj.result === "object") {
      const res = obj.result as Record<string, unknown>;
      if (res.structuredContent && typeof res.structuredContent === "object") {
        candidate = res.structuredContent;
      } else if (Array.isArray(res.products)) {
        candidate = res;
      } else if (Array.isArray(res.content)) {
        for (const item of res.content as Array<{ type?: string; text?: string }>) {
          if (item?.type === "text" && item.text) {
            try {
              const parsed = JSON.parse(item.text);
              if (
                parsed &&
                typeof parsed === "object" &&
                (parsed.products || parsed.structuredContent)
              ) {
                candidate = parsed.structuredContent ?? parsed;
                break;
              }
            } catch {
              // Not JSON text, continue
            }
          }
        }
      }
    } else if (obj.structuredContent && typeof obj.structuredContent === "object") {
      candidate = obj.structuredContent;
    } else if (Array.isArray(obj.products)) {
      candidate = obj;
    }

    if (!candidate) {
      throw new Channel3McpError(
        "Could not extract SearchProductsResult wire payload from MCP response",
        { response: json },
      );
    }

    // Validate using Zod wire schema
    const parseResult = SearchProductsResultSchema.safeParse(candidate);
    if (!parseResult.success) {
      throw new Channel3McpError(
        `Channel3 MCP payload validation failed: ${parseResult.error.message}`,
        { issues: parseResult.error.issues, candidate },
      );
    }

    return parseResult.data;
  }

  /**
   * High-level search and quote optimization method.
   * Discovers products via MCP, normalizes multi-vendor listings, and evaluates quotes against mandate constraints.
   */
  public async search(
    queryOrOptions: string | HighLevelSearchOptions,
    constraints?: MandateQuoteConstraints,
  ): Promise<QuoteOptimizationResult> {
    const options: HighLevelSearchOptions =
      typeof queryOrOptions === "string" ? { query: queryOrOptions } : queryOrOptions;

    const mergedConstraints = options.constraints ?? constraints;

    const wireResult = await this.searchProducts({
      query: options.query,
      imageUrl: options.imageUrl,
      threadId: options.threadId,
    });

    const normalizedProducts = normalizeSearchResults(wireResult);
    return optimizeQuote(normalizedProducts, mergedConstraints);
  }

  /**
   * Convenience method returning only ranked procurement quotes.
   */
  public async searchAndRank(
    query: string,
    constraints?: MandateQuoteConstraints,
  ): Promise<ProcurementQuote[]> {
    const result = await this.search(query, constraints);
    return result.quotes;
  }
}

/**
 * Top-level convenience search function.
 */
export async function searchProducts(
  clientOrOptions: Channel3Client | Channel3ClientOptions,
  params: SearchProductsOptions,
): Promise<SearchProductsResultWire> {
  const client =
    clientOrOptions instanceof Channel3Client
      ? clientOrOptions
      : new Channel3Client(clientOrOptions);
  return client.searchProducts(params);
}
