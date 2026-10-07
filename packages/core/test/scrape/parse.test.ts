import { describe, expect, it } from "vitest";
import { normText, parseValue, parserType } from "../../src/scrape/parse.js";
import type { ValueParser } from "../../src/scrape/spec.js";

const BOOL: ValueParser = { kind: "boolean" };
const SHOP: ValueParser = { kind: "boolean", true_words: ["add"], false_words: ["out of stock", "notify me"] };

const CASES: [string, ValueParser, unknown][] = [
  // text
  [" Koramangala \n", "text", "Koramangala"],
  ["a   b\tc", "text", "a b c"],
  ["", "text", null],
  ["   \n ", "text", null],
  // number
  ["1,23,456.50", "number", 123456.5],
  ["535.00", "number", 535],
  ["-", "number", null],
  ["–", "number", null],
  ["—", "number", null],
  ["NA", "number", null],
  ["N/A", "number", null],
  ["nil", "number", null],
  ["-12.5", "number", -12.5],
  ["Rate: 1,299", "number", 1299],
  ["ABC-12", "number", 12],
  ["(−3)", "number", -3],
  ["no digits", "number", null],
  ["10-20", "number", 10],
  [".5", "number", 0.5],
  // integer
  ["12", "integer", 12],
  ["12.5", "integer", null],
  ["12.00", "integer", 12],
  ["1,200 units", "integer", 1200],
  // price
  ["₹187", "price", 187],
  ["₹ 187", "price", 187],
  ["Rs. 1,299.00", "price", 1299],
  ["Rs.1,299", "price", 1299],
  ["MRP ₹209", "price", 209],
  ["INR 500", "price", 500],
  ["$5.99", "price", 5.99],
  ["€3", "price", 3],
  ["£4.50", "price", 4.5],
  // A price below 1 with no leading zero; a dot after "Rs" is a part of the mark.
  ["₹.99", "price", 0.99],
  ["$.5", "price", 0.5],
  ["Rs.99", "price", 99],
  ["Rs. .75", "price", 0.75],
  ["MRP: ₹ .50", "price", 0.5],
  ["525", "price", 525],
  ["250/-", "price", 250],
  ["8 MINS", "price", null],
  ["450 g", "price", null],
  ["10% OFF", "price", null],
  ["₹187 ₹209", "price", 187],
  ["Offers 20", "price", null],
  // percent
  ["10% OFF", "percent", 10],
  ["Save 12.5 %", "percent", 12.5],
  ["no percent 10", "percent", null],
  // quantity
  ["450 g", "quantity", "450 g"],
  ["1 pack (300 g)", "quantity", "300 g"],
  ["1Kg", "quantity", "1 kg"],
  ["2 x 450 g", "quantity", "2 x 450 g"],
  ["500ML", "quantity", "500 ml"],
  ["1.5 L", "quantity", "1.5 l"],
  ["6 pcs", "quantity", "6 pcs"],
  ["Pack of 6 pieces", "quantity", "6 pieces"],
  ["1 dozen", "quantity", "1 dozen"],
  ["12 units", "quantity", "12 units"],
  ["2 large eggs", "quantity", null],
  ["Licious Chicken Curry Cut", "quantity", null],
  // url
  ["https://blinkit.com/prn/x/123", "url", "https://blinkit.com/prn/x/123"],
  ["http://example.com", "url", "http://example.com/"],
  ["ftp://example.com/a", "url", null],
  ["/relative/path", "url", null],
  ["https://", "url", null],
  // boolean
  ["ADD", BOOL, true],
  ["Add to cart", BOOL, true],
  ["Out of stock", BOOL, false],
  ["Notify me", BOOL, false],
  ["Sold out", BOOL, false],
  ["In stock", BOOL, true],
  ["Not available", BOOL, false],
  ["Unavailable", BOOL, false],
  ["Address", BOOL, null],
  ["maybe", BOOL, null],
  ["ADD", SHOP, true],
  ["Notify me", SHOP, false],
  ["yes", SHOP, null],
  // date
  ["27-09-2026", { kind: "date" }, "2026-09-27"],
  ["Sep 27, 2026", { kind: "date" }, "2026-09-27"],
  ["27 September 2026", { kind: "date" }, "2026-09-27"],
  ["2026-09-27", { kind: "date" }, "2026-09-27"],
  ["03/04/2026", { kind: "date", order: "MDY" }, "2026-03-04"],
  ["03/04/2026", { kind: "date" }, "2026-04-03"],
  ["03/04/2026", { kind: "date", order: "DMY" }, "2026-04-03"],
  ["27/09/26", { kind: "date" }, "2026-09-27"],
  ["Updated on 27 Sep 2026", { kind: "date" }, "2026-09-27"],
  ["31/02/2026", { kind: "date" }, null],
  ["tomorrow", { kind: "date" }, null],
];

describe("parseValue (SPEC C2)", () => {
  it.each(CASES)("%j as %j -> %j", (text, parser, want) => {
    expect(parseValue(text, parser)).toEqual(want);
  });
  it("has at least 40 cases", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });
  it("the default parser is text", () => {
    expect(parseValue("  a  b ")).toBe("a b");
  });
  it("boolean words are literal: a word with regex characters never runs as a pattern", () => {
    expect(parseValue("a.b", { kind: "boolean", true_words: ["a.b"] })).toBe(true);
    expect(parseValue("axb", { kind: "boolean", true_words: ["a.b"] })).toBe(null);
    expect(parseValue("(x)", { kind: "boolean", true_words: ["(x)"] })).toBe(true);
    expect(parseValue("x", { kind: "boolean", true_words: ["(x)"] })).toBe(null);
  });
});

describe("parserType", () => {
  it.each<[ValueParser | undefined, string]>([
    [undefined, "string"], ["text", "string"], ["number", "number"], ["integer", "number"], ["price", "number"], ["percent", "number"],
    ["quantity", "string"], ["url", "string"], [{ kind: "boolean" }, "boolean"], [{ kind: "date" }, "string"],
  ])("%j -> %s", (p, t) => { expect(parserType(p)).toBe(t); });
});

describe("normText", () => {
  it("NFKC, lower case, squashed", () => {
    expect(normText("  ＡＢＣ \n  d ")).toBe("abc d");
  });
});
