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
  C$: "CAD",
  A$: "AUD",
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
};

const SORTED_CURRENCY_SYMBOLS = Object.entries(CURRENCY_SYMBOLS).sort(
  (a, b) => b[0].length - a[0].length,
);

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

  // Reject credentials or mail addresses passed as domains
  if (cleaned.includes("@")) {
    throw new Channel3ValidationError(`Invalid merchant domain format: "${rawDomain}"`, {
      domain: rawDomain,
    });
  }

  // Use WHATWG URL parsing to handle protocol stripping, path/port/query stripping, and IDN to punycode conversion
  const urlCandidate =
    cleaned.startsWith("http://") || cleaned.startsWith("https://")
      ? cleaned
      : `https://${cleaned}`;

  try {
    const parsed = new URL(urlCandidate);
    if (parsed.hostname) {
      cleaned = parsed.hostname;
    }
  } catch {
    cleaned = cleaned.replace(/^https?:\/\//, "");
  }

  // Strip path, query params, hash if fallback was used
  const slashIdx = cleaned.indexOf("/");
  if (slashIdx !== -1) {
    cleaned = cleaned.slice(0, slashIdx);
  }
  const qIdx = cleaned.indexOf("?");
  if (qIdx !== -1) {
    cleaned = cleaned.slice(0, qIdx);
  }
  const hashIdx = cleaned.indexOf("#");
  if (hashIdx !== -1) {
    cleaned = cleaned.slice(0, hashIdx);
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

  // Strip trailing dot
  cleaned = cleaned.replace(/\.+$/, "");

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
 * Strictly rejects negative prices as invalid in catalog commerce.
 */
export function parsePriceToMoney(raw: unknown, defaultCurrency = "USD"): Money {
  if (raw instanceof Money) {
    if (raw.amount < 0) {
      throw new Channel3ValidationError("Product price cannot be negative", { raw });
    }
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
    const amt = (raw as { amount: number }).amount;
    if (amt < 0) {
      throw new Channel3ValidationError(`Product price cannot be negative: ${amt}`, { raw });
    }
    return Money.fromMinorUnits(amt, (raw as { currency: string }).currency);
  }

  // If PayPal object: { value: "199.99", currency_code: "USD" }
  if (
    typeof raw === "object" &&
    "value" in raw &&
    typeof (raw as { value: unknown }).value === "string" &&
    "currency_code" in raw &&
    typeof (raw as { currency_code: unknown }).currency_code === "string"
  ) {
    const val = (raw as { value: string }).value.trim();
    if (val.startsWith("-")) {
      throw new Channel3ValidationError(`Product price cannot be negative: ${val}`, { raw });
    }
    return Money.fromDecimalString(val, (raw as { currency_code: string }).currency_code);
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
    if (raw < 0) {
      throw new Channel3ValidationError(`Product price cannot be negative: ${raw}`);
    }
    return Money.fromDecimalString(raw.toString(), defaultCurrency);
  }

  // String amount (e.g. "$199.99", "199.99", "USD 199.99", "$ 1,299.50", "C$199.99")
  if (typeof raw === "string") {
    let str = raw.trim();
    if (!str) {
      throw new Channel3ValidationError("Price string cannot be empty");
    }

    if (str.startsWith("-") || str.includes(" -")) {
      throw new Channel3ValidationError(`Product price cannot be negative: ${raw}`, { raw });
    }

    let detectedCurrency = defaultCurrency;

    // Check for symbol prefix (longest symbol first to prevent C$ matching $)
    for (const [sym, currCode] of SORTED_CURRENCY_SYMBOLS) {
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

    if (cleanedNumber.startsWith("-")) {
      throw new Channel3ValidationError(`Product price cannot be negative: ${raw}`, { raw });
    }

    if (!/^\d+(?:\.\d+)?$/.test(cleanedNumber)) {
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

  // Check direct ISO duration (e.g. "P3D", "P5D", "P1W", "P2W")
  const isoMatch = /^p(\d+)d$/i.exec(s);
  if (isoMatch?.[1]) {
    const days = parseInt(isoMatch[1], 10);
    return { days, isoDuration: `P${days}D` };
  }
  const isoWeekMatch = /^p(\d+)w$/i.exec(s);
  if (isoWeekMatch?.[1]) {
    const weeks = parseInt(isoWeekMatch[1], 10);
    const days = weeks * 7;
    return { days, isoDuration: `P${days}D` };
  }

  // Same day / today
  if (s.includes("same day") || s.includes("today")) {
    return { days: 1, isoDuration: "P1D" };
  }

  // Next day / overnight / tomorrow
  if (
    s.includes("next day") ||
    s.includes("overnight") ||
    s.includes("tomorrow") ||
    s.includes("1 business day") ||
    s === "1 day"
  ) {
    return { days: 1, isoDuration: "P1D" };
  }

  // 2-day / 2 business days
  if (s.includes("2-day") || s.includes("2 business day") || s.includes("2 days")) {
    return { days: 2, isoDuration: "P2D" };
  }

  // Week ranges e.g. "1-2 weeks", "2 to 3 weeks", "1 - 2 weeks" -> take upper bound * 7
  const weekRangeMatch = /(\d+)\s*(?:-|to)\s*(\d+)\s*(?:business\s*)?week/i.exec(s);
  if (weekRangeMatch?.[2]) {
    const upperWeeks = parseInt(weekRangeMatch[2], 10);
    const days = upperWeeks * 7;
    return { days, isoDuration: `P${days}D` };
  }

  // Single week count e.g. "1 week", "2 weeks", "3 business weeks"
  const singleWeekMatch = /(\d+)\s*(?:business\s*)?week/i.exec(s);
  if (singleWeekMatch?.[1]) {
    const weeks = parseInt(singleWeekMatch[1], 10);
    const days = weeks * 7;
    return { days, isoDuration: `P${days}D` };
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
export function normalizeOffer(
  rawOffer: ProductOfferWire,
  productId: string,
  index?: number,
): ProcurementOffer {
  const merchantDomain = normalizeDomain(rawOffer.domain);
  const price = parsePriceToMoney(rawOffer.price.price, rawOffer.price.currency);
  const compareAtPrice =
    rawOffer.price.compare_at_price != null
      ? parsePriceToMoney(rawOffer.price.compare_at_price, rawOffer.price.currency)
      : undefined;

  const shipping = parseShippingEstimate(rawOffer.shipping);

  const idSuffix =
    index != null
      ? rawOffer.condition
        ? `:${rawOffer.condition}:${index}`
        : `:${index}`
      : rawOffer.condition
        ? `:${rawOffer.condition}`
        : "";
  const offerId = `${productId}:${merchantDomain}${idSuffix}`;

  return {
    offerId,
    merchantDomain,
    productUrl: rawOffer.url,
    price,
    compareAtPrice,
    inStock: rawOffer.availability === "InStock",
    shippingEstimateRaw: rawOffer.shipping,
    shippingDurationIso: shipping.isoDuration,
    estimatedDeliveryDays: shipping.days,
    condition: rawOffer.condition,
  };
}

/**
 * Normalizes a raw ProductSummaryWire into a canonical ProcurementProduct.
 */
export function normalizeProduct(rawProduct: ProductSummaryWire): ProcurementProduct {
  const rawOffers: ProductOfferWire[] = rawProduct.offers ?? [];
  const offers: ProcurementOffer[] = [];
  for (let i = 0; i < rawOffers.length; i++) {
    const o = rawOffers[i];
    if (!o) continue;
    try {
      offers.push(normalizeOffer(o, rawProduct.id, i));
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      // Skip malformed offers so one bad offer does not fail the entire product or search
    }
  }

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
