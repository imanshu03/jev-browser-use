// Scraper steps from the step records of a fast run (a Jev navigation): L2 heal, authoring, and MCP scraper save.
//
// The exported names and signatures are a contract of the scrape kit (see /tmp/jevscrape/build/SPEC.md, section C5).
import type { Action } from "../fast/model.js";
import type { StepRecord } from "../types.js";
import { DISMISS_WORDS } from "../types.js";
import { normText } from "./parse.js";
import type { Step, Target } from "./spec.js";
import { PRESS_KEYS, placeholders } from "./spec.js";

export interface RecordedSteps {
  steps: Step[];
  /** Records that gave no step, with the reason (a secret fill, a failed action, an unknown operation). */
  skipped: string[];
}

/** The text that the fast loop and its redactor put in place of a secret value. */
const SECRET_VALUES = ["***", "<secret>"];
const ELLIPSIS = /\s*(?:…|\.\.\.)$/;
const MAX_TIMES = 20;

/** A literal `{` or `}` of a recorded text, escaped so that it is not a placeholder. */
function escape(s: string): string {
  return s.replace(/\{/g, "{{").replace(/\}/g, "}}");
}

/** The non-empty params, longest value first: a longer value wins over a value that it holds. */
function paramList(params: Record<string, string>): [string, string][] {
  return Object.entries(params).filter(([, v]) => normText(v) !== "").sort((a, b) => normText(b[1]).length - normText(a[1]).length);
}

/** A typed value or an option: `{param}` when it equals a param value, else the literal text. */
function valueOf(text: string, params: [string, string][]): string {
  const n = normText(text);
  const hit = params.find(([, v]) => normText(v) === n);
  return hit ? `{${hit[0]}}` : escape(text);
}

/** A target name: `{param}` when it equals, starts with, or holds a param value. A name cut with "…" matches its start. */
function nameOf(name: string, params: [string, string][]): { name: string; match?: "starts" | "contains" } {
  const n = normText(name.replace(ELLIPSIS, ""));
  const cut = ELLIPSIS.test(name);
  for (const [k, v] of params) {
    const p = normText(v);
    if (n === p) return cut ? { name: `{${k}}`, match: "starts" } : { name: `{${k}}` };
    if (n.startsWith(p)) return { name: `{${k}}`, match: "starts" };
    if (n.includes(p)) return { name: `{${k}}`, match: "contains" };
  }
  const plain = escape(name.replace(ELLIPSIS, "").trim());
  return cut ? { name: plain, match: "starts" } : { name: plain };
}

/** A banner control: its name holds a word of DISMISS_WORDS as a whole word ("Accept all", "Close", "×"). */
export function dismissName(name: string): boolean {
  const n = normText(name);
  return DISMISS_WORDS.some((w) => {
    const esc = normText(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "u").test(n);
  });
}

/**
 * The name of a select control, with no param mapping: an unlabelled select is named by its option list ("01 02 ... 12"),
 * and a param value in that list is there by chance.
 */
function literalName(name: string): { name: string; match?: "starts" } {
  const plain = escape(name.replace(ELLIPSIS, "").replace(/\s+/g, " ").trim());
  return ELLIPSIS.test(name) ? { name: plain, match: "starts" } : { name: plain };
}

function targetOf(rec: StepRecord, name: string, fallbackRole: string, params: [string, string][] | null): Target {
  const mapped = params ? nameOf(name, params) : literalName(name);
  const under = rec.target?.under ?? "";
  return {
    role: rec.target?.role || fallbackRole,
    name: mapped.name,
    ...(mapped.match ? { match: mapped.match } : {}),
    ...(under ? { under: escape(under).slice(0, 200) } : {}),
  };
}

/** The end of the skip reason of a gated record (see gated). */
export const GATED_NOTE = "a scraper never submits or deletes with no confirmation";

/** A field that takes a search: a searchbox, or a name with the word "search". */
const SEARCH_FIELD = /\bsearch\b/i;

/**
 * A click or a key press that the engine gated as a submit or a destructive action ("Add to cart", "Place order",
 * "Delete") is not a step: a replay runs with no confirmation, on every run. One exception: a submit right after a
 * fill of a `{param}` value into a search field sends the search. A destructive action is never a step.
 */
function gated(rec: StepRecord, steps: readonly Step[]): boolean {
  if (rec.risk === "destructive") return true;
  if (rec.risk !== "submit") return false;
  const last = steps[steps.length - 1];
  const search = last?.op === "fill" && placeholders(last.value).length > 0 && (last.target.role === "searchbox" || SEARCH_FIELD.test(last.target.name));
  return !search;
}

/**
 * The steps of the records that ran (result ok), in order. A typed value, an option, or a target name that equals a
 * param value (or holds it) becomes its `{param}` placeholder. A secret value never goes into a step, and neither does a
 * click or a key that submits or deletes (gated).
 */
export function stepsFromRecords(records: readonly StepRecord[], params: Record<string, string>): RecordedSteps {
  const steps: Step[] = [];
  const skipped: string[] = [];
  const list = paramList(params);
  for (const rec of records) {
    const at = `step ${rec.step} ${rec.action}`;
    if (rec.result !== "ok") {
      if (rec.action !== "none") skipped.push(`${at}: ${rec.result}`);
      continue;
    }
    if ((rec.action === "click" || rec.action === "press_key") && gated(rec, steps)) {
      skipped.push(`${at}: a ${rec.risk} action is not replayed: ${GATED_NOTE}`);
      continue;
    }
    const name = (rec.target?.name ?? "").trim();
    switch (rec.action) {
      case "click": {
        if (!name) { skipped.push(`${at}: the target has no name`); break; }
        const target = targetOf(rec, name, "button", list);
        steps.push({ op: "click", target, ...(dismissName(name) ? { optional: true } : {}) });
        break;
      }
      case "fill": {
        const value = rec.value ?? "";
        if (SECRET_VALUES.some((s) => value.includes(s))) { skipped.push(`${at}: a secret value is not saved`); break; }
        if (!name) { skipped.push(`${at}: the target has no name`); break; }
        const text = valueOf(value, list);
        if (text.length > 2000) { skipped.push(`${at}: the value is longer than 2000 characters`); break; }
        steps.push({ op: "fill", target: targetOf(rec, name, "textbox", list), value: text });
        break;
      }
      case "select": {
        const [control = "", ...option] = name.split(" → ");
        const value = rec.value ?? option.join(" → ");
        const text = valueOf(value, list);
        if (!control.trim() || !value.trim() || text.length > 300) { skipped.push(`${at}: no select name or option`); break; }
        steps.push({ op: "select", target: targetOf(rec, control.trim(), "combobox", null), value: text });
        break;
      }
      case "press_key": {
        const key = PRESS_KEYS.find((k) => k === rec.value);
        if (!key) { skipped.push(`${at}: the key ${rec.value ?? "?"} is not replayed`); break; }
        steps.push({ op: "press", key });
        break;
      }
      case "scroll_down": case "scroll_up": {
        const direction = rec.action === "scroll_down" ? "down" : "up";
        const last = steps[steps.length - 1];
        if (last?.op === "scroll" && (last.direction ?? "down") === direction && (last.times ?? 1) < MAX_TIMES) last.times = (last.times ?? 1) + 1;
        else steps.push({ op: "scroll", direction, times: 1 });
        break;
      }
      case "wait": steps.push({ op: "wait", ms: 1000 }); break;
      case "go_back": steps.push({ op: "back" }); break;
      default: skipped.push(`${at}: not replayed`);
    }
  }
  return { steps: steps.slice(0, 40), skipped: steps.length > 40 ? [...skipped, `${steps.length - 40} steps over the cap of 40`] : skipped };
}

/**
 * The steps of a run that stalled (the loop saw no page change, or the step cap ended it): the steps before the first
 * step that repeats an earlier one. The steps after that repeat are attempts that did not move the page.
 */
export function beforeRepeat(steps: readonly Step[]): Step[] {
  const seen = new Set<string>();
  const out: Step[] = [];
  for (const s of steps) {
    const k = JSON.stringify(s);
    if (seen.has(k)) break;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * A recorded URL as a start URL template: a path segment or a query value that equals a param value after decoding (a
 * "+" in the query is a space) becomes its `{param}` placeholder, so a run with another value opens another page;
 * fillUrl encodes the value again. The rest is literal text with its braces escaped. The scheme and the host are never
 * mapped, and neither is a value of one character or a part of a segment.
 */
export function urlTemplate(url: string, params: Record<string, string>): string {
  const list = paramList(params).filter(([, v]) => normText(v).length >= 2);
  const decode = (s: string): string | null => { try { return decodeURIComponent(s); } catch { return null; } };
  const mapped = (raw: string, text: string | null): string => {
    const hit = text === null ? undefined : list.find(([, v]) => normText(v) === normText(text));
    return hit ? `{${hit[0]}}` : escape(raw);
  };
  const hash = url.indexOf("#");
  const main = hash >= 0 ? url.slice(0, hash) : url;
  const q = main.indexOf("?");
  const base = q >= 0 ? main.slice(0, q) : main;
  const scheme = base.indexOf("://");
  const at = base.indexOf("/", scheme >= 0 ? scheme + 3 : 0);
  const origin = at >= 0 ? base.slice(0, at) : base;
  const path = at >= 0 ? base.slice(at).split("/").map((seg) => (seg === "" ? "" : mapped(seg, decode(seg)))).join("/") : "";
  const query = q < 0 ? "" : `?${main.slice(q + 1).split("&").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq < 0) return escape(pair);
    const value = pair.slice(eq + 1);
    return `${escape(pair.slice(0, eq))}=${value === "" ? "" : mapped(value, decode(value.replace(/\+/g, " ")))}`;
  }).join("&")}`;
  return escape(origin) + path + query + (hash >= 0 ? escape(url.slice(hash)) : "");
}

/** The param names that a start URL template or a step uses. */
export function boundParams(startUrl: string, steps: readonly Step[]): Set<string> {
  const texts = [startUrl, ...steps.flatMap((s) => [
    ..."target" in s ? [s.target.name] : [], ...(s.op === "fill" || s.op === "select" ? [s.value] : []), ...(s.op === "wait" && s.for_text ? [s.for_text] : []),
  ])];
  return new Set(texts.flatMap(placeholders));
}

/**
 * Select steps for the params that no step and no start URL uses, from the selects of the start page. A select that
 * already shows the param value at the start (a default, such as the current month) gets no step from Jev, so a run
 * with another value would read the default. The step selects `{param}`. A value that no select or more than one
 * select shows gives no step. The steps go before the recorded steps: they act on the start page.
 */
export function startSelectSteps(selects: readonly Action[], params: Record<string, string>, bound: ReadonlySet<string>): Step[] {
  const controls: { node: number | null; name: string; value: string }[] = [];
  for (const a of selects) {
    if (a.kind !== "select" || controls.some((c) => c.node === a.node)) continue;
    // An unlabelled select is named by its option texts, with the page's own line breaks: squash them.
    controls.push({ node: a.node, name: (a.label.split(" → ")[0] ?? a.label).replace(/\s+/g, " ").trim(), value: normText(a.current_value ?? "") });
  }
  const steps: Step[] = [];
  for (const [key, value] of Object.entries(params)) {
    const v = normText(value);
    if (bound.has(key) || v === "") continue;
    const hits = controls.filter((c) => c.value === v);
    const hit = hits[0];
    if (hits.length !== 1 || !hit) continue;
    const name = hit.name;
    if (name === "" || name.length > 300) continue;
    const nth = controls.filter((c) => normText(c.name) === normText(name)).findIndex((c) => c === hit);
    steps.push({ op: "select", target: { role: "combobox", name: escape(name), ...(nth > 0 ? { nth } : {}) }, value: `{${key}}` });
  }
  return steps;
}
