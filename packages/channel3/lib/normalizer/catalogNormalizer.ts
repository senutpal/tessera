import { Money } from "@tessera/core";
import {
  Channel3ValidationError,
  type PriceWire,
  type ProcurementOffer,
  type ProcurementProduct,
  type ProductOfferWire,
  type ProductSummaryWire,
  type SearchProductsResultWire,
} from "../types/channel3.js";

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
  C$: "CAD",
  A$: "AUD",
};

/**
 * Normalizes a raw domain or URL string into a clean hostname without protocol, port, path, or www prefix.
 */
export function normalizeDomain(rawDomain: string): string {
  if (!rawDomain || typeof rawDomain !== "string") {
    throw new Channel3ValidationError("Merchant domain must be a non-empty string", {
      domain: rawDomain,
    });
  }

  let cleaned = rawDomain.trim().toLowerCase();

  // Strip protocol if present
  if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) {
    try {
      const parsed = new URL(cleaned);
      cleaned = parsed.hostname;
    } catch {
      cleaned = cleaned.replace(/^https?:\/\//, "");
    }
  }

  // Strip path, query params, hash
  const slashIdx = cleaned.indexOf("/");
  if (slashIdx !== -1) {
    cleaned = cleaned.slice(0, slashIdx);
  }
  const qIdx = cleaned.indexOf("?");
  if (qIdx !== -1) {
    cleaned = cleaned.slice(0, qIdx);
  }

  // Strip port
  const portIdx = cleaned.indexOf(":");
  if (portIdx !== -1) {
    cleaned = cleaned.slice(0, portIdx);
  }

  // Strip www. prefix
  if (cleaned.startsWith("www.")) {
    cleaned = cleaned.slice(4);
  }

  // Basic RFC validation
  if (!cleaned?.includes(".") || /[^a-z0-9.-]/.test(cleaned)) {
    throw new Channel3ValidationError(`Invalid merchant domain format: "${rawDomain}"`, {
      domain: rawDomain,
    });
  }

  return cleaned;
}

/**
 * Parses raw price representations (strings, numbers, objects) into a canonical Money instance.
 */
export function parsePriceToMoney(raw: unknown, defaultCurrency = "USD"): Money {
  if (raw instanceof Money) {
    return raw;
  }

  if (raw === null || raw === undefined) {
    throw new Channel3ValidationError("Price value is null or undefined");
  }

  // If already an AP2 object: { amount: 19999, currency: "USD" }
  if (
    typeof raw === "object" &&
    "amount" in raw &&
    typeof (raw as { amount: unknown }).amount === "number" &&
    "currency" in raw &&
    typeof (raw as { currency: unknown }).currency === "string"
  ) {
    return Money.fromMinorUnits(
      (raw as { amount: number }).amount,
      (raw as { currency: string }).currency,
    );
  }

  // If PayPal object: { value: "199.99", currency_code: "USD" }
  if (
    typeof raw === "object" &&
    "value" in raw &&
    typeof (raw as { value: unknown }).value === "string" &&
    "currency_code" in raw &&
    typeof (raw as { currency_code: unknown }).currency_code === "string"
  ) {
    return Money.fromDecimalString(
      (raw as { value: string }).value,
      (raw as { currency_code: string }).currency_code,
    );
  }

  // If Channel3 PriceWire object: { price: number | string, currency?: string }
  if (
    typeof raw === "object" &&
    "price" in raw &&
    (typeof (raw as { price: unknown }).price === "number" ||
      typeof (raw as { price: unknown }).price === "string")
  ) {
    const wirePrice = raw as PriceWire;
    const curr = wirePrice.currency || defaultCurrency;
    return parsePriceToMoney(wirePrice.price, curr);
  }

  // Numeric amount (e.g. 199.99)
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || Number.isNaN(raw)) {
      throw new Channel3ValidationError(`Invalid numeric price value: ${raw}`);
    }
    return Money.fromDecimalString(raw.toFixed(2), defaultCurrency);
  }

  // String amount (e.g. "$199.99", "199.99", "USD 199.99", "$ 1,299.50")
  if (typeof raw === "string") {
    let str = raw.trim();
    if (!str) {
      throw new Channel3ValidationError("Price string cannot be empty");
    }

    let detectedCurrency = defaultCurrency;

    // Check for symbol prefix
    for (const [sym, currCode] of Object.entries(CURRENCY_SYMBOLS)) {
      if (str.includes(sym)) {
        detectedCurrency = currCode;
        str = str.replace(sym, "");
        break;
      }
    }

    // Check for 3-letter currency code (e.g. "USD 199.99" or "199.99 EUR")
    const codeMatch = /\b([A-Z]{3})\b/.exec(str);
    if (codeMatch?.[1]) {
      detectedCurrency = codeMatch[1];
      str = str.replace(codeMatch[1], "");
    }

    // Strip commas and whitespace
    const cleanedNumber = str.replace(/,/g, "").trim();

    if (!/^-?\d+(?:\.\d+)?$/.test(cleanedNumber)) {
      throw new Channel3ValidationError(
        `Unable to parse price string "${raw}" into a valid decimal amount`,
        { raw },
      );
    }

    return Money.fromDecimalString(cleanedNumber, detectedCurrency);
  }

  throw new Channel3ValidationError(`Unsupported price representation: ${typeof raw}`, { raw });
}

/**
 * Standardizes shipping duration estimates into an integer day count and ISO 8601 duration (e.g. "P3D").
 */
export function parseShippingEstimate(estimate: unknown): { days: number; isoDuration: string } {
  if (typeof estimate !== "string" || !estimate.trim()) {
    // Default fallback: 5 business days
    return { days: 5, isoDuration: "P5D" };
  }

  const s = estimate.trim().toLowerCase();

  // Check direct ISO duration (e.g. "P3D", "P5D")
  const isoMatch = /^p(\d+)d$/i.exec(s);
  if (isoMatch?.[1]) {
    const days = parseInt(isoMatch[1], 10);
    return { days, isoDuration: `P${days}D` };
  }

  // Same day / today
  if (s.includes("same day") || s.includes("today")) {
    return { days: 1, isoDuration: "P1D" };
  }

  // Next day / overnight
  if (
    s.includes("next day") ||
    s.includes("overnight") ||
    s.includes("1 business day") ||
    s === "1 day"
  ) {
    return { days: 1, isoDuration: "P1D" };
  }

  // 2-day / 2 business days
  if (s.includes("2-day") || s.includes("2 business day") || s.includes("2 days")) {
    return { days: 2, isoDuration: "P2D" };
  }

  // Ranges e.g. "3-5 business days", "3 to 5 days", "1-3 days" -> take upper bound
  const rangeMatch = /(\d+)\s*(?:-|to)\s*(\d+)\s*(?:business\s*)?day/i.exec(s);
  if (rangeMatch?.[2]) {
    const upperDays = parseInt(rangeMatch[2], 10);
    return { days: upperDays, isoDuration: `P${upperDays}D` };
  }

  // Single number with day(s) e.g. "3 days", "4 business days"
  const singleMatch = /(\d+)\s*(?:business\s*)?day/i.exec(s);
  if (singleMatch?.[1]) {
    const days = parseInt(singleMatch[1], 10);
    return { days, isoDuration: `P${days}D` };
  }

  // Named speed categories
  if (s.includes("express") || s.includes("rush") || s.includes("priority")) {
    return { days: 2, isoDuration: "P2D" };
  }
  if (s.includes("standard")) {
    return { days: 5, isoDuration: "P5D" };
  }
  if (s.includes("economy") || s.includes("ground") || s.includes("saver")) {
    return { days: 7, isoDuration: "P7D" };
  }

  // Fallback
  return { days: 5, isoDuration: "P5D" };
}

/**
 * Normalizes a raw ProductOfferWire into a canonical ProcurementOffer.
 */
export function normalizeOffer(rawOffer: ProductOfferWire, productId: string): ProcurementOffer {
  const merchantDomain = normalizeDomain(rawOffer.domain);
  const price = parsePriceToMoney(rawOffer.price.price, rawOffer.price.currency);
  const compareAtPrice =
    rawOffer.price.compare_at_price != null
      ? parsePriceToMoney(rawOffer.price.compare_at_price, rawOffer.price.currency)
      : undefined;

  const shipping = parseShippingEstimate(rawOffer.shipping);

  return {
    offerId: `${productId}:${merchantDomain}`,
    merchantDomain,
    productUrl: rawOffer.url,
    price,
    compareAtPrice,
    inStock: rawOffer.availability === "InStock",
    shippingEstimateRaw: rawOffer.shipping,
    shippingDurationIso: shipping.isoDuration,
    estimatedDeliveryDays: shipping.days,
  };
}

/**
 * Normalizes a raw ProductSummaryWire into a canonical ProcurementProduct.
 */
export function normalizeProduct(rawProduct: ProductSummaryWire): ProcurementProduct {
  const rawOffers: ProductOfferWire[] = rawProduct.offers ?? [];
  const offers: ProcurementOffer[] = rawOffers.map((o: ProductOfferWire) =>
    normalizeOffer(o, rawProduct.id),
  );

  // Determine lowest price and lead offer (lowest price among in-stock offers, or overall lowest)
  const inStockOffers = offers.filter((o) => o.inStock);
  const candidateOffers = inStockOffers.length > 0 ? inStockOffers : offers;

  let leadOffer: ProcurementOffer | undefined;
  let lowestPrice: Money | undefined;

  if (candidateOffers.length > 0) {
    const sorted = [...candidateOffers].sort(
      (a, b) => a.price.toMinorUnits() - b.price.toMinorUnits(),
    );
    leadOffer = sorted[0];
    lowestPrice = leadOffer?.price;
  }

  const brand = rawProduct.brands?.[0]?.name;
  const imageUrl = rawProduct.images?.[0]?.cleaned_url ?? rawProduct.images?.[0]?.url;

  return {
    id: rawProduct.id,
    title: rawProduct.title,
    brand,
    imageUrl,
    offers,
    leadOffer,
    lowestPrice,
  };
}

/**
 * Normalizes wire search results into an array of canonical ProcurementProducts.
 */
export function normalizeSearchResults(
  result: SearchProductsResultWire | ProductSummaryWire[],
): ProcurementProduct[] {
  const products = Array.isArray(result) ? result : result.products;
  return products.map(normalizeProduct);
}
