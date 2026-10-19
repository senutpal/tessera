import { DomainError, type Money } from "@tessera/core";
import { z } from "zod";

// ==========================================
// 1. Channel3 MCP Wire Schemas (Primary Source Parity)
// ==========================================

export const PriceWireSchema = z
  .object({
    currency: z.string().default("USD"),
    price: z.number(),
    compare_at_price: z.number().nullish(),
  })
  .passthrough();
export type PriceWire = z.infer<typeof PriceWireSchema>;

export const ProductOfferWireSchema = z
  .object({
    availability: z.enum(["InStock", "OutOfStock"]),
    domain: z.string(),
    price: PriceWireSchema,
    url: z.string(),
    shipping: z.string().optional(),
    condition: z.string().optional(),
  })
  .passthrough();
export type ProductOfferWire = z.infer<typeof ProductOfferWireSchema>;

export const ProductBrandWireSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
  })
  .passthrough();
export type ProductBrandWire = z.infer<typeof ProductBrandWireSchema>;

export const ProductImageWireSchema = z
  .object({
    url: z.string(),
    cleaned_url: z.string().nullish(),
    is_main_image: z.boolean().optional(),
  })
  .passthrough();
export type ProductImageWire = z.infer<typeof ProductImageWireSchema>;

export const ProductSummaryWireSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    brands: z.array(ProductBrandWireSchema).optional(),
    images: z.array(ProductImageWireSchema).optional(),
    offers: z.array(ProductOfferWireSchema).optional(),
    description: z.string().optional(),
  })
  .passthrough();
export type ProductSummaryWire = z.infer<typeof ProductSummaryWireSchema>;

export const SearchCriteriaSchema = z.object({
  query: z.string().optional(),
  image_url: z.string().optional(),
});
export type SearchCriteria = z.infer<typeof SearchCriteriaSchema>;

export const SearchProductsResultSchema = z.object({
  query: z.string().optional(),
  image_url: z.string().optional(),
  products: z.array(ProductSummaryWireSchema),
  next_page_token: z.string().nullable().optional(),
  as_of: z.string(),
  session_id: z.string().optional(),
  server_origin: z.string().optional(),
  thread_id: z.string(),
  seq: z.number().int().optional(),
});
export type SearchProductsResultWire = z.infer<typeof SearchProductsResultSchema>;

export const SearchRequestSchema = z
  .object({
    query: z.string().trim().min(1).optional(),
    image_url: z.string().optional(),
    thread_id: z.string().optional(),
  })
  .refine((data) => Boolean(data.query || data.image_url), {
    message: "At least one of `query` or `image_url` is required.",
  });
export type SearchRequestInput = z.infer<typeof SearchRequestSchema>;

// JSON-RPC 2.0 Wire Types for MCP
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result?: T | undefined;
  error?:
    | {
        code: number;
        message: string;
        data?: unknown;
      }
    | undefined;
}

// ==========================================
// 2. Normalized Domain Models
// ==========================================

export interface ProcurementOffer {
  offerId: string;
  merchantDomain: string;
  productUrl: string;
  price: Money;
  compareAtPrice?: Money | undefined;
  inStock: boolean;
  shippingEstimateRaw?: string | undefined;
  shippingDurationIso: string;
  estimatedDeliveryDays: number;
  condition?: string | undefined;
}

export interface ProcurementProduct {
  id: string;
  title: string;
  brand?: string | undefined;
  imageUrl?: string | undefined;
  offers: ProcurementOffer[];
  leadOffer?: ProcurementOffer | undefined;
  lowestPrice?: Money | undefined;
}

// ==========================================
// 3. Quote Optimizer Models
// ==========================================

export type QuoteEvaluationStatus =
  | "ELIGIBLE"
  | "EXCEEDS_BUDGET"
  | "DISALLOWED_MERCHANT"
  | "SLA_BREACH"
  | "OUT_OF_STOCK"
  | "CURRENCY_MISMATCH"
  | "DISALLOWED_CONDITION";

export interface ProcurementQuote {
  quoteId: string;
  offerId?: string | undefined;
  productId: string;
  productTitle: string;
  brand?: string | undefined;
  merchantDomain: string;
  productUrl: string;
  price: Money;
  compareAtPrice?: Money | undefined;
  estimatedDeliveryDays: number;
  shippingDurationIso: string;
  inStock: boolean;
  condition?: string | undefined;
  status: QuoteEvaluationStatus;
  rejectionReasons: string[];
  rank: number;
  score: number;
  selected: boolean;
  timestamp: string;
}

export interface MandateQuoteConstraints {
  maxBudget?: Money | number | { amount: number; currency: string } | undefined;
  currency?: string | undefined;
  allowedDomains?: readonly string[] | undefined;
  maxDeliveryDays?: number | undefined;
  preferredMerchants?: readonly string[] | undefined;
  requireInStock?: boolean | undefined;
  allowedConditions?: readonly string[] | undefined;
}

export interface QuoteOptimizationResult {
  quotes: ProcurementQuote[];
  optimalQuote: ProcurementQuote | null;
  totalCandidates: number;
  eligibleCount: number;
  rejectedCount: number;
  summary: string;
}

// ==========================================
// 4. Client Configuration & Methods
// ==========================================

export interface Channel3ClientOptions {
  endpoint?: string | undefined;
  apiKey?: string | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  initialBackoffMs?: number | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  threadId?: string | undefined;
}

export interface SearchProductsOptions {
  query?: string | undefined;
  imageUrl?: string | undefined;
  threadId?: string | undefined;
  limit?: number | undefined;
  pageToken?: string | undefined;
}

export interface HighLevelSearchOptions {
  query: string;
  imageUrl?: string | undefined;
  constraints?: MandateQuoteConstraints | undefined;
  threadId?: string | undefined;
}

// ==========================================
// 5. Channel3 Domain Errors
// ==========================================

export class Channel3Error extends DomainError {
  constructor(
    message: string,
    code = "CHANNEL3_ERROR",
    httpStatus = 502,
    details: Record<string, unknown> = {},
  ) {
    super(message, code, httpStatus, details);
  }
}

export class Channel3McpError extends Channel3Error {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, "CHANNEL3_MCP_ERROR", 502, details);
  }
}

export class Channel3TimeoutError extends Channel3Error {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, "CHANNEL3_TIMEOUT_ERROR", 504, details);
  }
}

export class Channel3ValidationError extends Channel3Error {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, "CHANNEL3_VALIDATION_ERROR", 400, details);
  }
}
