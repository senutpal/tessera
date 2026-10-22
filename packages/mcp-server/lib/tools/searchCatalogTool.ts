import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  Channel3Client,
  normalizeSearchResults,
  type ProductSummaryWire,
  type SearchProductsResultWire,
} from "@tessera/channel3";
import { z } from "zod";

function cleanDomain(raw: string): string {
  const stripped = raw
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .split(":")[0]
    .trim()
    .toLowerCase();
  return stripped.startsWith("www.") ? stripped.slice(4) : stripped;
}

export const SearchCatalogInputShape = {
  query: z
    .string()
    .trim()
    .min(1, "Search query is required")
    .describe("Product search keywords or product description, e.g. 'mechanical keyboard'"),
  max_price: z
    .number()
    .positive("max_price must be positive")
    .optional()
    .describe("Maximum allowed price in USD for quote filtering"),
  currency: z
    .string()
    .length(3, "Currency must be 3-letter ISO code")
    .default("USD")
    .optional()
    .describe("ISO 4217 currency code (default: USD)"),
  allowed_domains: z
    .array(z.string())
    .optional()
    .describe("Optional whitelist of merchant domains (e.g. ['bestbuy.com', 'amazon.com'])"),
  in_stock_only: z.boolean().optional().describe("Filter only currently in-stock merchant offers"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .optional()
    .describe("Maximum number of products to return (default: 5)"),
};

export const SearchCatalogInputSchema = z.object(SearchCatalogInputShape);
export type SearchCatalogInput = z.infer<typeof SearchCatalogInputSchema>;

export interface SearchCatalogContext {
  channel3Client?: Channel3Client | undefined;
  searchProductsFn?:
    | ((params: { query: string; limit?: number | undefined }) => Promise<unknown>)
    | undefined;
}

export function registerSearchCatalogTool(server: McpServer, context: SearchCatalogContext = {}) {
  server.tool(
    "tessera_search_catalog",
    "Search products and live retail offers across 100M+ items via Channel3 with domain and price filtering.",
    SearchCatalogInputShape,
    async (args) => {
      try {
        const client = context.channel3Client ?? new Channel3Client();
        const searchOpts: { query: string; limit?: number | undefined } = {
          query: args.query,
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        };

        const rawResults = context.searchProductsFn
          ? await context.searchProductsFn(searchOpts)
          : await client.searchProducts(searchOpts);

        const wirePayload = rawResults as SearchProductsResultWire | ProductSummaryWire[];
        const normalizedProducts = normalizeSearchResults(wirePayload);
        const maxPrice = args.max_price;
        const allowedDomains = args.allowed_domains?.map(cleanDomain).filter(Boolean);
        const targetCurrency = (args.currency ?? "USD").toUpperCase();
        const inStockOnly = args.in_stock_only ?? false;

        const filtered = normalizedProducts
          .map((prod) => {
            const validOffers = prod.offers.filter((offer) => {
              if (inStockOnly && !offer.inStock) {
                return false;
              }

              if (allowedDomains && allowedDomains.length > 0) {
                const domain = cleanDomain(offer.merchantDomain);
                const matched = allowedDomains.some(
                  (d) => domain === d || domain.endsWith(`.${d}`),
                );
                if (!matched) return false;
              }

              if (targetCurrency && offer.price.currency !== targetCurrency) {
                return false;
              }

              if (maxPrice !== undefined) {
                const decimalPrice = Number.parseFloat(offer.price.toDecimalString());
                if (decimalPrice > maxPrice) return false;
              }

              return true;
            });

            validOffers.sort((a, b) => a.price.amount - b.price.amount);

            return {
              ...prod,
              offers: validOffers,
            };
          })
          .filter((prod) => prod.offers.length > 0);

        filtered.sort((a, b) => {
          const firstOfferA = a.offers[0];
          const firstOfferB = b.offers[0];
          if (!firstOfferA || !firstOfferB) return 0;
          return firstOfferA.price.amount - firstOfferB.price.amount;
        });

        const limitedProducts = filtered.slice(0, args.limit ?? 5);

        if (limitedProducts.length === 0) {
          const noResultsMsg = `No products found matching query "${args.query}" under specified budget/domain constraints.`;
          return {
            content: [
              {
                type: "text" as const,
                text: noResultsMsg,
              },
            ],
            structuredContent: {
              success: true,
              count: 0,
              query: args.query,
              products: [],
            },
          };
        }

        const formattedLines = limitedProducts.flatMap((prod, idx) => {
          const bestOffer = prod.offers[0];
          const lines = [`### ${idx + 1}. ${prod.title}`, `- **Product ID:** ${prod.id}`];
          if (bestOffer) {
            lines.push(
              `- **Best Offer:** ${bestOffer.price.toDecimalString()} ${bestOffer.price.currency} at ${bestOffer.merchantDomain}`,
              `- **Availability:** ${bestOffer.inStock ? "InStock" : "OutOfStock"}`,
              `- **Merchant URL:** ${bestOffer.productUrl}`,
            );
          }
          return lines;
        });

        const summaryText = [
          `Found ${limitedProducts.length} policy-compliant product(s) for "${args.query}":`,
          "",
          ...formattedLines,
        ].join("\n");

        const structuredPayload = {
          success: true,
          count: limitedProducts.length,
          query: args.query,
          products: limitedProducts.map((p) => ({
            id: p.id,
            title: p.title,
            offers: p.offers.map((o) => ({
              domain: o.merchantDomain,
              price: o.price.toDecimalString(),
              currency: o.price.currency,
              availability: o.inStock ? "InStock" : "OutOfStock",
              url: o.productUrl,
            })),
          })),
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `${summaryText}\n\n\`\`\`json\n${JSON.stringify(structuredPayload, null, 2)}\n\`\`\``,
            },
          ],
          structuredContent: structuredPayload,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Catalog search failed: ${errorMsg}`,
            },
          ],
        };
      }
    },
  );
}
