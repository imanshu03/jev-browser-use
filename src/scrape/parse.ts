// Value parsers of the scrape kit: a closed set that turns the text of a cell or a slot into a row value. Pure. A model
// can name a parser; it cannot add one, and no pattern from a model runs here.
import { parseDate } from "../task.js";
import type { RowValue, ValueParser } from "./spec.js";

/** Texts that mean "no value" in a number cell: a dash alone, NA, N/A, nil. */
const NO_NUMBER = /^(?:-+|–|—|na|n\/a|nil)$/i;
/**
 * The first number of a text: comma groups ("1,299", Indian "1,23,456"), one decimal part. A sign counts only at the
 * start or after a space or "(": "ABC-12" is 12.
 */
const NUMBER = /(?:(?<=^|[\s(])([-+−]))?(\d+(?:,\d{2,3}(?!\d))*(?:\.\d+)?|\.\d+)/;
/**
 * A currency mark and the number after it. "MRP ₹209" and "Rs. 1,299.00" read; so does "₹ 187". A number can start with
 * its decimal point ("₹.99" is 0.99): a "." between the mark and the number is a separator only when no digit follows it.
 */
const PRICE = /(?:(?:₹|\brs\b\.?|\binr\b|\$|€|£|\bmrp\b)(?:[\s:]|\.(?!\d))*)+(\d+(?:,\d{2,3}(?!\d))*(?:\.\d+)?|\.\d+)/i;
/** A price text with no currency mark: only a number, an optional "/-" after it. */
const BARE_PRICE = /^(\d+(?:,\d{2,3}(?!\d))*(?:\.\d+)?)\s*(?:\/-)?$/;
const PERCENT = /([-+−]?\d+(?:\.\d+)?)\s*%/;
/** Units of a quantity. Longer names first, so "kg" is not read as "g". */
const WEIGHT = "kg|kgs|mg|gms|gm|grams|gram|g";
const VOLUME = "ml|ltr|litres|litre|liters|liter|l";
const COUNT = "pcs|pc|pieces|piece|packs|pack|dozen|units|unit";
const UNIT = `${WEIGHT}|${VOLUME}|${COUNT}`;
const QUANTITY = new RegExp(`(?:(\\d+)\\s*[x×*]\\s*)?(\\d+(?:\\.\\d+)?)\\s*(${UNIT})(?![\\p{L}\\p{N}])`, "giu");
const MEASURE = new RegExp(`^(?:${WEIGHT}|${VOLUME})$`, "i");

/** The default words of the boolean parser. False words win. */
export const TRUE_WORDS = ["yes", "true", "available", "in stock", "add"];
export const FALSE_WORDS = ["no", "false", "unavailable", "not available", "out of stock", "sold out", "notify me"];

/** Whitespace runs as one space, trimmed. */
export function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The compare form of a text: NFKC, lower case, whitespace squashed. Filters, keys, and replay compare with it. */
export function normText(s: string): string {
  return squash(s.normalize("NFKC").toLowerCase());
}

function toNumber(sign: string | undefined, digits: string): number {
  const n = Number(digits.replace(/,/g, ""));
  return sign === "-" || sign === "−" ? -n : n;
}

/** The first signed number of a text, or null. */
function firstNumber(t: string): number | null {
  if (NO_NUMBER.test(t)) return null;
  const m = NUMBER.exec(t);
  if (!m || m[2] === undefined) return null;
  const n = toNumber(m[1], m[2]);
  return Number.isFinite(n) ? n : null;
}

function price(t: string): number | null {
  const m = PRICE.exec(t) ?? BARE_PRICE.exec(t);
  if (!m || m[1] === undefined) return null;
  const n = toNumber(undefined, m[1]);
  return Number.isFinite(n) ? n : null;
}

function percent(t: string): number | null {
  const m = PERCENT.exec(t);
  if (!m || m[1] === undefined) return null;
  const n = Number(m[1].replace("−", "-"));
  return Number.isFinite(n) ? n : null;
}

/** "<number> <unit>" with one space and a lower-case unit. A weight or volume wins over a count ("1 pack (300 g)" is "300 g"). */
function quantity(t: string): string | null {
  let count: string | null = null;
  for (const m of t.matchAll(QUANTITY)) {
    const unit = (m[3] ?? "").toLowerCase();
    const text = `${m[1] !== undefined ? `${m[1]} x ` : ""}${m[2]} ${unit}`;
    if (MEASURE.test(unit)) return text;
    count ??= text;
  }
  return count;
}

function url(t: string): string | null {
  if (!/^https?:\/\//i.test(t)) return null;
  try {
    const u = new URL(t);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * A literal word or phrase as a whole-word test on a normalized text (normText). Never a pattern from the caller: every
 * character is escaped.
 */
export function hasWord(text: string, word: string): boolean {
  const w = normText(word);
  if (!w) return false;
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "u").test(text);
}

function boolean(t: string, trueWords: readonly string[], falseWords: readonly string[]): boolean | null {
  const n = normText(t);
  if (falseWords.some((w) => hasWord(n, w))) return false;
  if (trueWords.some((w) => hasWord(n, w))) return true;
  return null;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

/** A numeric date with a two-digit year ("27/09/26"), read in `order`. The year is 20yy. */
function shortYear(t: string, order: "DMY" | "MDY" | "YMD"): string | null {
  const m = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{1,2})$/.exec(t);
  if (!m) return null;
  const [a, b, c] = [Number(m[1]), Number(m[3]), Number(m[4])];
  const [y, mo, d] = order === "YMD" ? [2000 + a, b, c] : order === "MDY" ? [2000 + c, a, b] : [2000 + c, b, a];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? iso(y, mo, d) : null;
}

/** Candidate date texts inside a longer text ("Updated on 27 Sep 2026"). */
const DATE_PARTS = [
  /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g,
  /\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?[a-z]{3,9}\.?,?\s+\d{4}\b/gi,
  /\b[a-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi,
];

function dateOf(t: string, order: "DMY" | "MDY" | "YMD"): string | null {
  const whole = (s: string): string | null => {
    const f = parseDate(s);
    if (f) {
      // An ambiguous numeric date ("03/04/2026") gives the first number as the month; the order settles it.
      if (f.ambiguous !== undefined && order === "DMY") return iso(f.y, f.d, f.m);
      return iso(f.y, f.m, f.d);
    }
    return shortYear(s, order);
  };
  const direct = whole(t);
  if (direct) return direct;
  for (const re of DATE_PARTS) for (const m of t.matchAll(re)) {
    const hit = whole(m[0]);
    if (hit) return hit;
  }
  return null;
}

/** The row value of `text` under `parser`. Empty text and text that the parser cannot read give null. */
export function parseValue(text: string, parser: ValueParser = "text"): RowValue {
  const t = squash(text);
  if (!t) return null;
  if (typeof parser === "object") {
    if (parser.kind === "boolean") return boolean(t, parser.true_words ?? TRUE_WORDS, parser.false_words ?? FALSE_WORDS);
    return dateOf(t, parser.order ?? "DMY");
  }
  switch (parser) {
    case "text": return t;
    case "number": return firstNumber(t);
    case "integer": {
      const n = firstNumber(t);
      return n !== null && Number.isInteger(n) ? n : null;
    }
    case "price": return price(t);
    case "percent": return percent(t);
    case "quantity": return quantity(t);
    case "url": return url(t);
  }
}

/** The JSON type of the values that a parser gives (a null aside). */
export function parserType(parser: ValueParser | undefined): "string" | "number" | "boolean" {
  if (parser === undefined) return "string";
  if (typeof parser === "object") return parser.kind === "boolean" ? "boolean" : "string";
  return parser === "number" || parser === "integer" || parser === "price" || parser === "percent" ? "number" : "string";
}
