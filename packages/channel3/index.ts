// Public entry point for @tessera/channel3
// Deep module exposing Channel3 MCP catalog discovery and autonomous quote optimization

// Channel3 MCP Client
export {
  Channel3Client,
  searchProducts,
} from "./lib/client/channel3Client.js";

// Catalog Normalizer
export {
  normalizeDomain,
  normalizeOffer,
  normalizeProduct,
  normalizeSearchResults,
  parsePriceToMoney,
  parseShippingEstimate,
} from "./lib/normalizer/catalogNormalizer.js";

// Autonomous Quote Optimizer
export {
  isDomainWhitelisted,
  normalizeConstraints,
  optimizeQuote,
} from "./lib/optimizer/quoteOptimizer.js";
// Domain Errors
// Schemas & Types
export {
  type Channel3ClientOptions,
  Channel3Error,
  Channel3McpError,
  Channel3TimeoutError,
  Channel3ValidationError,
  type HighLevelSearchOptions,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type MandateQuoteConstraints,
  type PriceWire,
  PriceWireSchema,
  type ProcurementOffer,
  type ProcurementProduct,
  type ProcurementQuote,
  type ProductBrandWire,
  ProductBrandWireSchema,
  type ProductImageWire,
  ProductImageWireSchema,
  type ProductOfferWire,
  ProductOfferWireSchema,
  type ProductSummaryWire,
  ProductSummaryWireSchema,
  type QuoteEvaluationStatus,
  type QuoteOptimizationResult,
  type SearchCriteria,
  SearchCriteriaSchema,
  type SearchProductsOptions,
  SearchProductsResultSchema,
  type SearchProductsResultWire,
  type SearchRequestInput,
  SearchRequestSchema,
} from "./lib/types/channel3.js";
