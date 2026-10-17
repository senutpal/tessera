import { CanonicalJsonError } from "../errors/domainErrors.js";

function isWellFormedString(str: string): boolean {
  if (typeof (str as unknown as { isWellFormed?: () => boolean }).isWellFormed === "function") {
    return (str as unknown as { isWellFormed: () => boolean }).isWellFormed();
  }
  return !/(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(str);
}

function serializeValue(value: unknown, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(
        `Non-finite number cannot be canonicalized to RFC 8785 JSON: ${value}`,
      );
    }
    if (Object.is(value, -0)) {
      return "0";
    }
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    if (!isWellFormedString(value)) {
      throw new CanonicalJsonError("Invalid Unicode: string contains lone surrogate");
    }
    return JSON.stringify(value);
  }

  if (typeof value === "object") {
    const candidate = value as { toJSON?: () => unknown };
    if (typeof candidate.toJSON === "function") {
      return serializeValue(candidate.toJSON(), seen);
    }

    if (seen.has(value)) {
      throw new CanonicalJsonError("Circular reference detected during RFC 8785 canonicalization");
    }
    seen.add(value);

    try {
      if (Array.isArray(value)) {
        const elements = value.map((elem) => {
          if (elem === undefined || typeof elem === "function" || typeof elem === "symbol") {
            return "null";
          }
          return serializeValue(elem, seen);
        });
        return `[${elements.join(",")}]`;
      }

      // RFC 8785 Section 3.2.3: Sorting of Object Properties
      // Property name strings are sorted by UTF-16 code unit values as unsigned integers.
      const sortedKeys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      const serializedPairs: string[] = [];
      const record = value as Record<string, unknown>;

      for (const key of sortedKeys) {
        if (!isWellFormedString(key)) {
          throw new CanonicalJsonError("Invalid Unicode: object key contains lone surrogate");
        }
        const propVal = record[key];
        if (propVal === undefined || typeof propVal === "function" || typeof propVal === "symbol") {
          continue;
        }
        const keyJson = JSON.stringify(key);
        const valJson = serializeValue(propVal, seen);
        serializedPairs.push(`${keyJson}:${valJson}`);
      }

      return `{${serializedPairs.join(",")}}`;
    } finally {
      seen.delete(value);
    }
  }

  throw new CanonicalJsonError(`Unsupported value type cannot be canonicalized: ${typeof value}`);
}

export function canonicalize(data: unknown): string {
  if (data === undefined || typeof data === "function" || typeof data === "symbol") {
    throw new CanonicalJsonError("Top-level undefined, function, or symbol cannot be serialized");
  }
  return serializeValue(data, new Set<object>());
}

export function canonicalizeToBuffer(data: unknown): Buffer {
  return Buffer.from(canonicalize(data), "utf8");
}
