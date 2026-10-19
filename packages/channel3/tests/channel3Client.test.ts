import { describe, expect, it, vi } from "vitest";
import {
  Channel3Client,
  Channel3McpError,
  Channel3TimeoutError,
  Channel3ValidationError,
  type SearchProductsResultWire,
  searchProducts,
} from "../index.js";

function createMockWireResponse(
  overrides: Partial<SearchProductsResultWire> = {},
): SearchProductsResultWire {
  return {
    query: "sony wh-1000xm5",
    products: [
      {
        id: "prod_sony_xm5",
        title: "Sony WH-1000XM5 Wireless Noise Canceling Headphones",
        brands: [{ id: "brand_sony", name: "Sony" }],
        images: [{ url: "https://cdn.trychannel3.com/sony_xm5.jpg" }],
        offers: [
          {
            availability: "InStock",
            domain: "bestbuy.com",
            price: { currency: "USD", price: 349.99, compare_at_price: 399.99 },
            url: "https://bestbuy.com/deal",
            shipping: "2-day delivery",
          },
          {
            availability: "InStock",
            domain: "amazon.com",
            price: { currency: "USD", price: 338.0, compare_at_price: 399.99 },
            url: "https://amazon.com/dp/B09XS7JWHH",
            shipping: "Next day delivery",
          },
        ],
      },
    ],
    next_page_token: "page_tok_abc123",
    as_of: "2026-10-18T12:00:00.000Z",
    thread_id: "thread_sess_xyz789",
    ...overrides,
  };
}

describe("Channel3Client MCP Engine", () => {
  it("formats JSON-RPC 2.0 tool call and sends authentication headers", async () => {
    let capturedUrl = "";
    const capturedInits: RequestInit[] = [];

    const mockWire = createMockWireResponse();

    const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      if (init) {
        capturedInits.push(init);
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req_1",
          result: {
            content: [{ type: "text", text: "Found 1 products" }],
            structuredContent: mockWire,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const client = new Channel3Client({
      endpoint: "https://mcp.test.channel3.local/",
      apiKey: "ch3_sec_token_999",
      fetch: mockFetch,
    });

    const result = await client.searchProducts({
      query: "sony wh-1000xm5",
      imageUrl: "https://example.com/ref.jpg",
    });

    expect(capturedUrl).toBe("https://mcp.test.channel3.local/");
    expect(capturedInits).toHaveLength(1);

    const init = capturedInits[0];
    expect(init).toBeDefined();
    expect(init?.method).toBe("POST");

    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer ch3_sec_token_999");

    const sentBody = JSON.parse(String(init?.body));
    expect(sentBody.jsonrpc).toBe("2.0");
    expect(sentBody.method).toBe("tools/call");
    expect(sentBody.params.name).toBe("search_products");
    expect(sentBody.params.arguments.query).toBe("sony wh-1000xm5");
    expect(sentBody.params.arguments.image_url).toBe("https://example.com/ref.jpg");

    expect(result.products).toHaveLength(1);
    expect(result.thread_id).toBe("thread_sess_xyz789");
    expect(client.threadId).toBe("thread_sess_xyz789");
  });

  it("automatically retains and propagates thread_id on follow-up searches", async () => {
    const thread1 = "thread_step_1";
    const thread2 = "thread_step_2";

    let callCount = 0;
    const receivedArguments: Record<string, unknown>[] = [];

    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse(String(init?.body));
      receivedArguments.push(body.params.arguments);

      const returnedThread = callCount === 1 ? thread1 : thread2;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            structuredContent: createMockWireResponse({ thread_id: returnedThread }),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const client = new Channel3Client({ fetch: mockFetch });

    // Initial search: no thread_id sent
    await client.searchProducts({ query: "running shoes" });
    expect(receivedArguments[0]?.thread_id).toBeUndefined();
    expect(client.threadId).toBe(thread1);

    // Follow-up search: thread_id propagated automatically
    await client.searchProducts({ query: "nike trail shoes" });
    expect(receivedArguments[1]?.thread_id).toBe(thread1);
    expect(client.threadId).toBe(thread2);

    // Override thread_id explicitly
    await client.searchProducts({ query: "socks", threadId: "manual_override_thread" });
    expect(receivedArguments[2]?.thread_id).toBe("manual_override_thread");
  });

  it("unwraps JSON string inside MCP content text block", async () => {
    const mockWire = createMockWireResponse();
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req_2",
          result: {
            content: [{ type: "text", text: JSON.stringify(mockWire) }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const client = new Channel3Client({ fetch: mockFetch });
    const result = await client.searchProducts({ query: "headphones" });

    expect(result.products[0]?.id).toBe("prod_sony_xm5");
    expect(result.thread_id).toBe("thread_sess_xyz789");
  });

  it("retries on transient HTTP 429 and 503 errors and succeeds on recovery", async () => {
    let attempts = 0;
    const mockWire = createMockWireResponse();

    const mockFetch = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        return new Response("Too Many Requests", { status: 429 });
      }
      if (attempts === 2) {
        return new Response("Service Unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req_3",
          result: { structuredContent: mockWire },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const client = new Channel3Client({
      fetch: mockFetch,
      maxRetries: 3,
      initialBackoffMs: 10,
    });

    const result = await client.searchProducts({ query: "macbook pro" });
    expect(attempts).toBe(3);
    expect(result.products).toHaveLength(1);
  });

  it("throws Channel3McpError when retries are exhausted", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response("Internal Server Error", { status: 500 });
    }) as unknown as typeof globalThis.fetch;

    const client = new Channel3Client({
      fetch: mockFetch,
      maxRetries: 1,
      initialBackoffMs: 5,
    });

    await expect(client.searchProducts({ query: "ipad" })).rejects.toThrow(Channel3McpError);
  });

  it("throws Channel3McpError on non-retryable 4xx client errors", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof globalThis.fetch;

    const client = new Channel3Client({ fetch: mockFetch, maxRetries: 2 });
    await expect(client.searchProducts({ query: "camera" })).rejects.toThrow(Channel3McpError);
  });

  it("throws Channel3McpError when MCP returns a JSON-RPC error payload", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req_err",
          error: { code: -32602, message: "Invalid params: query too long" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const client = new Channel3Client({ fetch: mockFetch });
    await expect(client.searchProducts({ query: "long".repeat(50) })).rejects.toThrow(
      "MCP JSON-RPC Error: Invalid params: query too long",
    );
  });

  it("times out and throws Channel3TimeoutError", async () => {
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const abortError = new Error("This operation was aborted");
          abortError.name = "AbortError";
          reject(abortError);
        });
      });
    }) as unknown as typeof globalThis.fetch;

    const client = new Channel3Client({
      fetch: mockFetch,
      timeoutMs: 50,
      maxRetries: 0,
    });

    await expect(client.searchProducts({ query: "slow query" })).rejects.toThrow(
      Channel3TimeoutError,
    );
  });

  it("executes high-level search and quote optimization end-to-end", async () => {
    const mockWire = createMockWireResponse();
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req_hl",
          result: { structuredContent: mockWire },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const client = new Channel3Client({ fetch: mockFetch });

    const result = await client.search("sony wh-1000xm5", {
      maxBudget: 35000, // $350.00
      allowedDomains: ["amazon.com", "bestbuy.com"],
      maxDeliveryDays: 3,
    });

    expect(result.totalCandidates).toBe(2);
    expect(result.eligibleCount).toBe(2);
    expect(result.optimalQuote).not.toBeNull();
    // amazon.com was $338.00 vs bestbuy $349.99
    expect(result.optimalQuote?.merchantDomain).toBe("amazon.com");
    expect(result.optimalQuote?.price.toMinorUnits()).toBe(33800);
    expect(result.optimalQuote?.selected).toBe(true);

    // searchAndRank returns quotes array directly
    const quotes = await client.searchAndRank("sony wh-1000xm5");
    expect(quotes).toHaveLength(2);
  });

  it("executes standalone searchProducts convenience function", async () => {
    const mockWire = createMockWireResponse();
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req_fn",
          result: { structuredContent: mockWire },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await searchProducts({ fetch: mockFetch }, { query: "drone" });
    expect(result.products).toHaveLength(1);
    expect(result.products[0]?.title).toContain("Sony WH-1000XM5");
  });

  it("throws Channel3ValidationError without making fetch calls when search criteria are missing", async () => {
    const mockFetch = vi.fn();
    const client = new Channel3Client({ fetch: mockFetch as unknown as typeof globalThis.fetch });

    await expect(client.searchProducts({})).rejects.toThrow(Channel3ValidationError);
    await expect(client.searchProducts({ query: "   " })).rejects.toThrow(Channel3ValidationError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("propagates MCP tool execution errors (result.isError) without retrying", async () => {
    let callCount = 0;
    const mockFetch = vi.fn(async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req_err_tool",
          result: {
            isError: true,
            content: [{ type: "text", text: "Error: Retailer API rate limit exceeded" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const client = new Channel3Client({ fetch: mockFetch, maxRetries: 3 });

    await expect(client.searchProducts({ query: "monitor" })).rejects.toThrow(
      "MCP Tool Execution Error: Error: Retailer API rate limit exceeded",
    );
    // Tool execution errors are deterministic application errors and should not trigger HTTP retries
    expect(callCount).toBe(1);
  });

  it("unwraps JSON payload wrapped in markdown code blocks within text content", async () => {
    const mockWire = createMockWireResponse();
    const markdownText = `Here are the search results:\n\`\`\`json\n${JSON.stringify(mockWire)}\n\`\`\`\nHope this helps!`;

    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req_md",
          result: {
            content: [{ type: "text", text: markdownText }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const client = new Channel3Client({ fetch: mockFetch });
    const result = await client.searchProducts({ query: "sony" });

    expect(result.products).toHaveLength(1);
    expect(result.thread_id).toBe("thread_sess_xyz789");
  });

  it("handles pagination via nextPage helper method", async () => {
    const page1Wire = createMockWireResponse({
      next_page_token: "tok_page_2",
      thread_id: "thread_p1",
    });
    const page2Wire = createMockWireResponse({
      products: [],
      next_page_token: null,
      thread_id: "thread_p2",
    });

    let callCount = 0;
    const capturedArgs: Record<string, unknown>[] = [];

    const mockFetch = vi.fn(async (_url, init) => {
      callCount++;
      const body = JSON.parse(String(init?.body));
      capturedArgs.push(body.params.arguments);

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { structuredContent: callCount === 1 ? page1Wire : page2Wire },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof globalThis.fetch;

    const client = new Channel3Client({ fetch: mockFetch });
    const page1 = await client.searchProducts({ query: "sneakers" });
    expect(page1.next_page_token).toBe("tok_page_2");

    const page2 = await client.nextPage(page1);
    expect(page2).not.toBeNull();
    expect(capturedArgs[1]?.page_token).toBe("tok_page_2");
    expect(capturedArgs[1]?.thread_id).toBe("thread_p1");

    // When next_page_token is null, nextPage returns null
    const page3 = await client.nextPage(page2 as SearchProductsResultWire);
    expect(page3).toBeNull();
    expect(callCount).toBe(2);
  });

  it("provides thread isolation via withThread without mutating parent client", async () => {
    const client = new Channel3Client({ threadId: "parent_thread" });
    const scopedClient = client.withThread("child_thread");

    expect(client.threadId).toBe("parent_thread");
    expect(scopedClient.threadId).toBe("child_thread");

    scopedClient.threadId = "mutated_child_thread";
    expect(client.threadId).toBe("parent_thread");
  });

  it("times out if reading response body exceeds timeoutMs", async () => {
    const mockFetch = vi.fn(async (_url, init) => {
      const signal = init?.signal as AbortSignal;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        json: async () => {
          return new Promise((_resolve, reject) => {
            const onAbort = () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            };
            if (signal?.aborted) return onAbort();
            signal?.addEventListener("abort", onAbort);
          });
        },
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const client = new Channel3Client({
      timeoutMs: 50,
      maxRetries: 0,
      fetch: mockFetch,
    });

    await expect(client.searchProducts({ query: "test" })).rejects.toThrow(Channel3TimeoutError);
  });

  it("times out if reading error response body (500/400) exceeds timeoutMs", async () => {
    const mockFetch = vi.fn(async (_url, init) => {
      const signal = init?.signal as AbortSignal;
      return {
        ok: false,
        status: 500,
        headers: new Headers({ "Content-Type": "text/plain" }),
        text: async () => {
          return new Promise((_resolve, reject) => {
            const onAbort = () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            };
            if (signal?.aborted) return onAbort();
            signal?.addEventListener("abort", onAbort);
          });
        },
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;

    const client = new Channel3Client({
      timeoutMs: 50,
      maxRetries: 0,
      fetch: mockFetch,
    });

    await expect(client.searchProducts({ query: "test" })).rejects.toThrow(Channel3TimeoutError);
  });
});
