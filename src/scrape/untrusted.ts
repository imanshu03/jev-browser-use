// Page strings on their way to a model: the scraper LLM (L3, authoring) and Claude (MCP read_page). Both read them only
// as data. This file marks the strings that read like instructions and the delimiters that wrap page data.
//
// Contract of the scrape kit (see /tmp/jevscrape/build/SPEC.md, sections C and D). The scrape-core unit owns this file;
// the MCP tools import it. Keep the exported names and their meaning.
import { flatText } from "../fast/generate.js";

/** The delimiters around page data in an LLM prompt. A page string never holds them (cleanUntrusted removes them). */
export const UNTRUSTED_OPEN = "<<<UNTRUSTED_PAGE_DATA";
export const UNTRUSTED_CLOSE = "UNTRUSTED_PAGE_DATA>>>";

/**
 * Text that reads like an instruction to a model or a tool: "ignore the previous instructions", "you are now ...",
 * "system prompt", a chat role tag, "call the ... tool", "run this command". A page can hold such text to steer a model
 * that reads it. The MCP view flags it (`suspect`); the LLM context replaces it with SUSPECT_MARK.
 */
const SUSPECT = [
  /\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:instructions?|prompts?|rules|previous|above|earlier)\b/i,
  /\byou are (?:now )?(?:an?|the|my) (?:ai|assistant|agent|model|chatbot|language model)\b/i,
  /\b(?:system|developer) (?:prompt|message|instructions?)\b/i,
  /<\/?\s*(?:system|assistant|user|tool|instructions?)\s*>/i,
  /\b(?:call|use|invoke|run) (?:the )?[\w-]+ (?:tool|function|command)\b/i,
  /\b(?:new|updated|real) instructions?\s*:/i,
  /\bdo not (?:tell|inform|show) the user\b/i,
];

/** Replaces a suspect string in an LLM context. */
export const SUSPECT_MARK = "[text removed: it reads like an instruction]";

export function suspectText(s: string): boolean {
  return SUSPECT.some((re) => re.test(s));
}

/**
 * `s` with the delimiters removed, each replaced with `sep`. A removal can join the parts of a delimiter that was split
 * by another one ("UNTRUSTED_PAGE_" + a delimiter + "DATA>>>"): remove until none is left.
 */
export function stripDelimiters(s: string, sep = ""): string {
  let t = s;
  for (let prev = ""; prev !== t;) {
    prev = t;
    t = t.split(UNTRUSTED_OPEN).join(sep).split(UNTRUSTED_CLOSE).join(sep);
  }
  return t;
}

/**
 * A page string for a model: sanitized and flat (flatText), the delimiters removed, cut to `max` characters. The caller
 * redacts secrets and removes the API key first.
 */
export function cleanUntrusted(s: string, max: number): string {
  const t = stripDelimiters(flatText(s), " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, Math.max(0, max - 1)) + "…" : t;
}
