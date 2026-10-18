import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalize, canonicalizeToBuffer } from "../index.js";

describe("RFC 8785 Deterministic Canonical JSON Engine", () => {
  describe("Object Key Ordering", () => {
    it("sorts object keys lexicographically", () => {
      const obj1 = { b: 2, a: 1 };
      const obj2 = { a: 1, b: 2 };

      expect(canonicalize(obj1)).toBe('{"a":1,"b":2}');
      expect(canonicalize(obj2)).toBe('{"a":1,"b":2}');
      expect(canonicalize(obj1)).toBe(canonicalize(obj2));
    });

    it("sorts nested object keys deterministically", () => {
      const nested1 = {
        z: 100,
        payload: {
          beta: "second",
          alpha: "first",
          details: {
            y: true,
            x: false,
          },
        },
      };
      const nested2 = {
        payload: {
          details: {
            x: false,
            y: true,
          },
          alpha: "first",
          beta: "second",
        },
        z: 100,
      };

      const expected =
        '{"payload":{"alpha":"first","beta":"second","details":{"x":false,"y":true}},"z":100}';
      expect(canonicalize(nested1)).toBe(expected);
      expect(canonicalize(nested2)).toBe(expected);
    });

    it("sorts keys strictly by UTF-16 code units per RFC 8785 Section 3.2.3", () => {
      // Supplementary character U+10000 has UTF-16 surrogate \uD800\uDC00 (code unit 0xD800 = 55296).
      // BMP character \uE000 has code unit 0xE000 (57344).
      // In UTF-16 code unit order: 0xD800 < 0xE000, so \u{10000} MUST come before \uE000.
      const obj = {
        "\uE000": "bmp-e000",
        "\u{10000}": "supplementary-10000",
      };
      expect(canonicalize(obj)).toBe('{"\u{10000}":"supplementary-10000","\uE000":"bmp-e000"}');
    });

    it("matches RFC 8785 Cyberphone structures.json reference test vector", () => {
      const input = {
        "1": { f: { f: "hi", F: 5 }, "\n": 56.0 },
        "10": {},
        "": "empty",
        a: {},
        "111": [{ e: "yes", E: "no" }],
        A: {},
      };
      expect(canonicalize(input)).toBe(
        '{"":"empty","1":{"\\n":56,"f":{"F":5,"f":"hi"}},"10":{},"111":[{"E":"no","e":"yes"}],"A":{},"a":{}}',
      );
    });

    it("matches RFC 8785 Cyberphone french.json reference test vector", () => {
      const input = {
        peach: "This sorting order",
        péché: "is wrong according to French",
        pêche: "but canonicalization MUST",
        sin: "ignore locale",
      };
      expect(canonicalize(input)).toBe(
        '{"peach":"This sorting order","péché":"is wrong according to French","pêche":"but canonicalization MUST","sin":"ignore locale"}',
      );
    });
  });

  describe("Whitespace Elimination", () => {
    it("produces compact output with zero whitespace outside strings", () => {
      const input = {
        list: [1, 2, 3],
        nested: { hello: "world with spaces" },
      };
      const result = canonicalize(input);
      expect(result).toBe('{"list":[1,2,3],"nested":{"hello":"world with spaces"}}');
    });
  });

  describe("Number Canonicalization", () => {
    it("normalizes -0 to 0 per RFC 8785", () => {
      expect(canonicalize({ val: -0 })).toBe('{"val":0}');
      expect(canonicalize(-0)).toBe("0");
    });

    it("formats standard numbers matching ECMAScript specifications", () => {
      expect(canonicalize({ n: 42 })).toBe('{"n":42}');
      expect(canonicalize({ n: 12.345 })).toBe('{"n":12.345}');
      expect(canonicalize({ n: 0 })).toBe('{"n":0}');
    });

    it("matches RFC 8785 Section 3.2.2 number serialization sample", () => {
      const input = JSON.parse("[333333333.33333329, 1e30, 4.5, 2e-3, 1e-27]");
      expect(canonicalize(input)).toBe("[333333333.3333333,1e+30,4.5,0.002,1e-27]");
    });

    it("rejects non-finite numbers (NaN, Infinity, -Infinity)", () => {
      expect(() => canonicalize({ bad: NaN })).toThrow(CanonicalJsonError);
      expect(() => canonicalize({ bad: Infinity })).toThrow(CanonicalJsonError);
      expect(() => canonicalize({ bad: -Infinity })).toThrow(CanonicalJsonError);
    });
  });

  describe("Arrays and Primitives", () => {
    it("preserves array element ordering", () => {
      const arr = [3, 1, 2];
      expect(canonicalize(arr)).toBe("[3,1,2]");
    });

    it("handles null, boolean, and string primitives", () => {
      expect(canonicalize(null)).toBe("null");
      expect(canonicalize(true)).toBe("true");
      expect(canonicalize(false)).toBe("false");
      expect(canonicalize("hello")).toBe('"hello"');
    });

    it("omits undefined properties in objects and maps undefined in arrays to null", () => {
      const obj = { a: 1, b: undefined, c: "keep" };
      expect(canonicalize(obj)).toBe('{"a":1,"c":"keep"}');

      const arr = [1, undefined, 2];
      expect(canonicalize(arr)).toBe("[1,null,2]");
    });

    it("honors toJSON methods on objects", () => {
      const custom = {
        id: "raw",
        toJSON() {
          return { customId: 42, title: "normalized" };
        },
      };
      expect(canonicalize(custom)).toBe('{"customId":42,"title":"normalized"}');
    });
  });

  describe("Error and Edge Handling", () => {
    it("throws CanonicalJsonError on circular references", () => {
      const circular: Record<string, unknown> = { name: "loop" };
      circular.self = circular;

      expect(() => canonicalize(circular)).toThrow(CanonicalJsonError);
    });

    it("serializes directly to UTF-8 Buffer", () => {
      const data = { b: 2, a: 1 };
      const buffer = canonicalizeToBuffer(data);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.toString("utf8")).toBe('{"a":1,"b":2}');
    });

    it("handles empty objects and empty arrays", () => {
      expect(canonicalize({})).toBe("{}");
      expect(canonicalize([])).toBe("[]");
    });

    it("handles nested structures of mixed objects and arrays", () => {
      const complex = [{ z: 9, a: [{ d: 4, c: 3 }] }];
      expect(canonicalize(complex)).toBe('[{"a":[{"c":3,"d":4}],"z":9}]');
    });

    it("escapes quotes, backslashes, control characters properly", () => {
      const special = { text: 'Quote: " Backslash: \\ Newline: \n Tab: \t' };
      expect(canonicalize(special)).toBe(
        '{"text":"Quote: \\" Backslash: \\\\ Newline: \\n Tab: \\t"}',
      );
    });

    it("rejects lone surrogate strings per RFC 8785 Section 3.2.2.2", () => {
      expect(() => canonicalize("\uD800")).toThrow(CanonicalJsonError);
      expect(() => canonicalize("\uDC00")).toThrow(CanonicalJsonError);
      expect(() => canonicalize({ bad: "\uD800" })).toThrow(CanonicalJsonError);
      expect(() => canonicalize({ "\uD800": 1 })).toThrow(CanonicalJsonError);
    });

    it("accepts valid surrogate pairs", () => {
      const emoji = { symbol: "🎉" };
      expect(canonicalize(emoji)).toBe('{"symbol":"🎉"}');
    });

    it("rejects top-level undefined, function, or symbol", () => {
      expect(() => canonicalize(undefined)).toThrow(CanonicalJsonError);
      expect(() => canonicalize(() => {})).toThrow(CanonicalJsonError);
      expect(() => canonicalize(Symbol("test"))).toThrow(CanonicalJsonError);
    });

    it("rejects non-plain objects without toJSON (e.g. Map, Set)", () => {
      expect(() => canonicalize(new Map())).toThrow(CanonicalJsonError);
      expect(() => canonicalize(new Set([1, 2]))).toThrow(CanonicalJsonError);
      class CustomClass {
        constructor(public val = 1) {}
      }
      expect(() => canonicalize(new CustomClass())).toThrow(CanonicalJsonError);
    });

    it("serializes null-prototype objects correctly", () => {
      const nullProto = Object.create(null);
      nullProto.b = 2;
      nullProto.a = 1;
      expect(canonicalize(nullProto)).toBe('{"a":1,"b":2}');
    });

    it("detects circular reference via self-returning toJSON", () => {
      const selfRefToJSON = {
        toJSON() {
          return this;
        },
      };
      expect(() => canonicalize(selfRefToJSON)).toThrow(CanonicalJsonError);
    });
  });
});
