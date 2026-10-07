import { describe, expect, it } from "vitest";
import type { Observation } from "../../src/fast/model.js";
import type { PageRead } from "../../src/fast/read-types.js";
import { buildExtract, extractRows, fingerprintOf } from "../../src/scrape/extract.js";
import { bodyOf, nextSpec } from "../../src/scrape/heal.js";
import type { NavigatorDeps, RunScraperOptions } from "../../src/scrape/runner.js";
import { runParams, runScraper } from "../../src/scrape/runner.js";
import type { RecordsExtract, ScraperSpec } from "../../src/scrape/spec.js";
import { HISTORY_MAX, SpecError, parseDraft, parseScraper } from "../../src/scrape/spec.js";
import type { RunConfig } from "../../src/types.js";
import { fakeHuman, fakeLogger, fakeOracle, type OracleScript, type PartialAnswers } from "../fakes.js";
import { el, obs } from "../fast/fakes.js";
import { clone, contextOf, fakeBrowser, fakeLlm, idx, loadRead, readPage, valueKey } from "./fakes.js";

const T0 = Date.parse("2026-09-27T08:00:00Z");
const HOME_URL = "https://shop.example/";
const RES_URL = "https://shop.example/s?q=eggs";
const HOME = obs(HOME_URL, [el("e1", "fill", "Search products", "searchbox", { value: "" }), el("e2", "click", "Search", "button")], "Shop home");
const HOME_V3 = obs(HOME_URL, [el("e1", "fill", "Search products", "searchbox", { value: "" }), el("e2", "click", "Find", "button")], "Shop home");
const RESULTS = obs(RES_URL, [el("e1", "click", "ADD", "button")], "Results\nADD");
const BLANK = obs("about:blank", [], "");
const BLINKIT = loadRead("blinkit");
const READ = (): PageRead => ({ ...clone(BLINKIT), url: RES_URL });

const EXTRACT = buildExtract(parseDraft({
  set: "g2",
  fields: {
    name: { from: "slot", pick: [{ by: "key", key: "div.tw-text-300" }] },
    pack: { from: "slot", pick: [{ by: "key", key: "div.tw-text-200" }], parser: "quantity" },
    price: { from: "slot", pick: [{ by: "key", key: "div.tw-flex@2>div>div.tw-text-200" }], parser: "price" },
    mrp: { from: "slot", pick: [{ by: "key", key: "div.tw-flex@2>div>div.tw-text-200@2" }], parser: "price" },
    can_add: { from: "slot", pick: [{ by: "key", key: "div.tw-flex@2>div.tw-rounded>div" }], parser: { kind: "boolean", true_words: ["add"], false_words: ["out of stock"] } },
  },
  key: ["name", "pack"],
}), READ());
const ROWS = extractRows(READ(), EXTRACT, { params: {} }).rows;

function shopSpec(): ScraperSpec {
  return parseScraper({
    kind: "jev-scraper", format: 1, name: "shop", version: 1, created_at: "2026-09-26T00:00:00.000Z", updated_at: "2026-09-26T00:00:00.000Z",
    task: "search the shop for {query}", want: "one row per product: name, pack, price, mrp, can add", params: { query: "eggs" },
    start_url: HOME_URL,
    steps: [{ op: "fill", target: { role: "searchbox", name: "Search products" }, value: "{query}" }, { op: "click", target: { role: "button", name: "Search" } }],
    load: { mode: "none" }, extract: EXTRACT, validate: { min_rows: 3, required: ["name", "price"] },
    fingerprint: fingerprintOf(EXTRACT, READ(), "g2", ROWS),
    history: [{ at: "2026-09-26T00:00:00.000Z", level: "author", reason: "jev-scrape new", from_version: 0, previous: null }],
  });
}

/** The read with every slot key renamed: a site release with new class names. */
function renamedRead(): PageRead {
  const r = READ();
  const g = r.groups[1];
  if (!g) throw new Error("no g2");
  const ren = (k: string): string => k.replace(/tw-/g, "qx-");
  for (const rec of g.records) for (const s of rec.slots) s.key = ren(s.key);
  for (const s of g.slots) s.key = ren(s.key);
  g.signature.slot_keys = g.signature.slot_keys.map(ren);
  return r;
}

/** The results as a table: a new layout. */
function tableRead(): PageRead {
  const r = READ();
  r.groups = [];
  const headers = ["Product", "Pack", "Price", "MRP", "Stock"];
  const rows = [["Brown Eggs", "6 pcs", "₹90", "₹100", "Add"], ["Milk", "1 l", "₹72", "₹75", "Add"], ["Paneer", "200 g", "₹95", "₹99", "Out of stock"], ["Bread", "400 g", "₹45", "₹50", "Add"]];
  r.tables = [{
    id: "t1", kind: "html", caption: "", heading: "Results", headers, header_rows: 1, width: 5, rows: rows.map((cells) => ({ section: null, cells })),
    sections: [], row_count: 4, truncated: false, nested: false, signature: { kind: "table", headers: headers.map((h) => h.toLowerCase()), width: 5, caption: "", heading: "results" },
  }];
  return r;
}

const TABLE_FIELDS = {
  name: { from: "column", header: "Product" }, pack: { from: "column", header: "Pack", parser: "quantity" }, price: { from: "column", header: "Price", parser: "price" },
  mrp: { from: "column", header: "MRP", parser: "price" }, can_add: { from: "column", header: "Stock", parser: { kind: "boolean", true_words: ["add"], false_words: ["out of stock"] } },
};
const TABLE_DRAFT = JSON.stringify({ set: "t1", fields: TABLE_FIELDS });

function clock() {
  let t = T0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

function setup(o: { home?: Observation; results?: () => PageRead; resultsObs?: Observation } = {}) {
  const page = readPage({
    pages: { blank: BLANK, home: o.home ?? HOME, results: o.resultsObs ?? RESULTS }, start: "blank",
    transitions: (c, cur) => (c.op === "navigate" ? "home" : cur === "home" && c.op === "act" && c.id === "e2" ? "results" : undefined),
    reads: { results: o.results ?? READ },
  });
  const browser = fakeBrowser(page);
  const saved: ScraperSpec[] = [];
  const log = fakeLogger();
  const c = clock();
  const opts = (over: Partial<RunScraperOptions> = {}): RunScraperOptions => ({
    heal: "full", browser, headed: false, log, now: c.now, sleep: c.sleep, stepTimeoutMs: 1000,
    save: (s) => { saved.push(s); return "/tmp/scrapers/shop.json"; }, ...over,
  });
  return { page, browser, saved, log, opts };
}

const BASE: RunConfig = {
  task: "", headed: false, maxSteps: 8, stepTimeoutMs: 1000, runTimeoutMs: 60_000, pauseTimeoutMs: 1000, confirm: "auto", dryRun: false, session: "jev-test",
  model: "m", logLevel: "info", logJson: false, keepOpen: true, agentBrowserBin: "", vars: {}, engine: "cdp",
};
const PROFILES = [{ directory: "Profile 14", name: "Parallelloop" }];

/** L2 Jev: type the query into the search box, click the button, then DONE on the results. */
const NAV_SCRIPT = (button: string): OracleScript => (name, state, q) => {
  if (name !== "step") return {};
  const s = state as { page: { url: string }; recent_actions: unknown[] };
  if (s.page.url === RES_URL) return { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } } as PartialAnswers;
  if (s.recent_actions.length === 0) return { page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", "Search products"), confidence: 0.9 }, type_text_value: { choice: valueKey(q, "eggs"), confidence: 0.9 } };
  return { page_kind: "task_page", operation: { choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 0.9, DONE: 0.05, WAIT: 0.05 } }, click_target: { choice: idx(q, "click_target", button), confidence: 0.9 } };
};

function navigator(script: OracleScript): NavigatorDeps & { oracle: ReturnType<typeof fakeOracle> } {
  return { oracle: fakeOracle(script), human: fakeHuman({ interactive: false }), profiles: PROFILES, base: BASE };
}

describe("runParams", () => {
  it("merges the overrides; an unknown param or an empty used param is a SpecError", () => {
    expect(runParams(shopSpec(), { query: "milk" })).toEqual({ query: "milk" });
    expect(() => runParams(shopSpec(), { nope: "1" })).toThrow(SpecError);
    expect(() => runParams(shopSpec(), { nope: "1" })).toThrow("--param nope: not a param of shop. Params: query");
    expect(() => runParams(shopSpec(), { query: " " })).toThrow("{query} has no value: pass --param query=<value>");
  });
});

describe("runScraper: the plain path", () => {
  it("a matching page gives ok with 0 Jev requests and 0 LLM calls; the navigator and the LLM are never called", async () => {
    const t = setup();
    const nav = navigator(() => { throw new Error("no Jev on the plain path"); });
    const llm = fakeLlm([]);
    const r = await runScraper(shopSpec(), t.opts({ navigator: nav, llm }));
    expect(r).toMatchObject({ scraper: "shop", version: 1, params: { query: "eggs" }, url: RES_URL, status: "ok", healed: null, reason: null, blocked: null, saved: null, row_count: 4 });
    expect(r.rows).toEqual(ROWS);
    expect(r.stats).toMatchObject({ jev_requests: 0, llm_calls: 0, steps: 2, scrolls: 0 });
    expect(nav.oracle.requests).toEqual([]);
    expect(llm.calls).toEqual([]);
    expect(t.saved).toEqual([]);
    expect(t.page.calls).toEqual([{ op: "navigate", url: HOME_URL }, { op: "act", id: "e1", kind: "fill", text: "eggs", edit: { mode: "replace" } }, { op: "act", id: "e2", kind: "click" }]);
    // The second read checks that the rows stopped growing.
    expect(t.page.reads).toEqual([{ text: false, limits: { rows: 5000 } }, { text: false, limits: { rows: 5000 } }]);
  });
  it("rows that render in parts: the read goes on until the row count stops growing, and keeps the most rows", async () => {
    let n = 0;
    const part = (): PageRead => {
      n += 1;
      const r = READ();
      const g = r.groups[1];
      if (g && n === 1) { g.records = g.records.slice(0, 3); g.count = 3; }
      return r;
    };
    const t = setup({ results: part });
    const r = await runScraper(shopSpec(), t.opts({ stepTimeoutMs: 5000 }));
    expect(r).toMatchObject({ status: "ok", healed: null, row_count: ROWS.length });
    expect(r.rows).toEqual(ROWS);
    expect(t.page.reads).toHaveLength(3);
  });
  it("rows that show after the last step are read by the poll, with no heal", async () => {
    let n = 0;
    const t = setup({ results: () => { n += 1; return n < 3 ? { ...READ(), groups: [] } : READ(); } });
    const r = await runScraper(shopSpec(), t.opts({ llm: fakeLlm([]) }));
    expect(r).toMatchObject({ status: "ok", healed: null, row_count: 4 });
    expect(t.page.reads).toHaveLength(3);
  });
  it("a start URL that the params turn into another scheme is refused before the page opens; file: needs allowFile", async () => {
    const t = setup();
    const spec = parseScraper({ ...shopSpec(), start_url: "{u}", params: { query: "eggs", u: HOME_URL } });
    for (const u of ["file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "not a url"]) {
      await expect(runScraper(spec, t.opts({ params: { u } })), u).rejects.toThrow(SpecError);
    }
    await expect(runScraper(spec, t.opts({ params: { u: "file:///etc/passwd" } }))).rejects.toThrow("the start URL uses file: with these params. Use an http or https URL");
    expect(t.page.calls).toEqual([]);
    await runScraper(spec, t.opts({ params: { u: "file:///tmp/shop.html" }, allowFile: true, heal: "none" }));
    expect(t.page.calls[0]).toEqual({ op: "navigate", url: "file:///tmp/shop.html" });
  });
  it("the result shows a secret param as ***", async () => {
    const t = setup();
    const spec = parseScraper({ ...shopSpec(), params: { query: "eggs", otp: "482913" } });
    const r = await runScraper(spec, t.opts());
    expect(r.params).toEqual({ query: "eggs", otp: "***" });
  });
  it("params override the defaults", async () => {
    const t = setup();
    const r = await runScraper(shopSpec(), t.opts({ params: { query: "milk" } }));
    expect(r.params).toEqual({ query: "milk" });
    expect(t.page.calls[1]).toMatchObject({ text: "milk" });
  });
  it("a param value in the start URL is URL-encoded: \"&\", \"#\", and \"%\" stay part of the value", async () => {
    const t = setup();
    const spec = parseScraper({ ...shopSpec(), start_url: `${HOME_URL}?q={query}&page=1` });
    await runScraper(spec, t.opts({ params: { query: "M&M chocolate #1 50% off" }, heal: "none" }));
    const url = t.page.calls.find((c) => c.op === "navigate")?.url ?? "";
    expect(url).toBe("https://shop.example/?q=M%26M%20chocolate%20%231%2050%25%20off&page=1");
    expect(new URL(url).searchParams.get("q")).toBe("M&M chocolate #1 50% off");
  });
  it("a scroll load rule runs the loader before the read", async () => {
    const t = setup();
    const spec = { ...shopSpec(), load: { mode: "scroll" as const, max_scrolls: 3 } };
    const loads: unknown[] = [];
    const r = await runScraper(spec, t.opts({ load: async (_p, o) => { loads.push(o); return { scrolls: 3, ms: 5, stable: true, height: 1, nodes: 1, end: "stable" }; } }));
    expect(r.status).toBe("ok");
    expect(r.stats.scrolls).toBe(3);
    expect(loads).toEqual([{ maxScrolls: 3, stableRounds: 2, pauseMs: 600, maxMs: 30_000 }]);
  });
  it("a browser that does not start gives failed", async () => {
    const t = setup();
    const r = await runScraper(shopSpec(), t.opts({ browser: { page: async () => { throw new Error("profile is locked"); }, chrome: async () => { throw new Error("x"); }, close: async () => undefined } }));
    expect(r).toMatchObject({ status: "failed", reason: "browser: profile is locked", rows: [] });
  });
});

describe("runScraper: heal ladder", () => {
  it("L1: an extract failure heals by code and saves version + 1 with a history entry that holds the previous body", async () => {
    const t = setup({ results: renamedRead });
    const spec = shopSpec();
    const llm = fakeLlm([]);
    const r = await runScraper(spec, t.opts({ llm }));
    expect(r.status).toBe("ok");
    expect(r.healed?.level).toBe("L1");
    expect(r.healed?.reason).toMatch(/^validate: /);
    expect(r).toMatchObject({ version: 2, saved: "/tmp/scrapers/shop.json", row_count: 4 });
    expect(r.rows).toEqual(ROWS);
    expect(r.stats).toMatchObject({ jev_requests: 0, llm_calls: 0 });
    expect(llm.calls).toEqual([]);
    const next = t.saved[0] as ScraperSpec;
    expect(next.version).toBe(2);
    // The failed reads waited the step timeout (1 s on the test clock) for the rows.
    expect(next.updated_at).toBe("2026-09-27T08:00:01.000Z");
    expect(next.history).toHaveLength(2);
    expect(next.history[1]).toMatchObject({ level: "L1", from_version: 1, at: "2026-09-27T08:00:01.000Z" });
    expect(next.history[1]?.previous).toEqual(bodyOf(spec));
    expect((next.extract as RecordsExtract).fields["price"]).toMatchObject({ pick: [{ by: "parse", parser: "price", struck: false }] });
    expect(next.fingerprint.slot_keys.every((k) => k.includes("qx-"))).toBe(true);
    expect(next.steps).toEqual(spec.steps);
    // The healed version runs with no heal.
    const again = await runScraper(next, setup({ results: renamedRead }).opts({ heal: "none" }));
    expect(again).toMatchObject({ status: "ok", healed: null, version: 2 });
  });
  it("L2: a replay failure heals with Jev on the same tab and re-records the steps", async () => {
    const t = setup({ home: HOME_V3 });
    const nav = navigator(NAV_SCRIPT("Find"));
    const r = await runScraper(shopSpec(), t.opts({ navigator: nav }));
    expect(r.status).toBe("ok");
    expect(r.healed).toEqual({ level: "L2", reason: "step 2: no button \"Search\"" });
    expect(r.rows).toEqual(ROWS);
    expect(r.stats.jev_requests).toBe(nav.oracle.requests.length);
    expect(r.stats.jev_requests).toBeGreaterThanOrEqual(3);
    expect(r.stats.llm_calls).toBe(0);
    const next = t.saved[0] as ScraperSpec;
    expect(next.steps).toEqual([
      { op: "fill", target: { role: "searchbox", name: "Search products" }, value: "{query}" },
      { op: "click", target: { role: "button", name: "Find" } },
    ]);
    expect(next.extract).toEqual(shopSpec().extract);
    expect(next.history[1]).toMatchObject({ level: "L2", reason: "step 2: no button \"Search\"", from_version: 1 });
    // The browser stays open for the caller.
    expect(t.browser.closes).toBe(0);
  });
  it("L3: the LLM rebuilds the extract from the page context; the new version keeps the old validate checks", async () => {
    const t = setup({ results: tableRead });
    const llm = fakeLlm([(req) => { expect(contextOf(req.user).tables[0]?.id).toBe("t1"); return TABLE_DRAFT; }]);
    const r = await runScraper(shopSpec(), t.opts({ llm }));
    expect(r.status).toBe("ok");
    expect(r.healed?.level).toBe("L3");
    expect(r.healed?.reason).toMatch(/^extract: no record group matches/);
    expect(r.rows[0]).toEqual({ name: "Brown Eggs", pack: "6 pcs", price: 90, mrp: 100, can_add: true });
    expect(r.stats).toMatchObject({ llm_calls: 1, jev_requests: 0 });
    const next = t.saved[0] as ScraperSpec;
    expect(next.extract.source).toBe("table");
    expect(next.validate).toMatchObject({ min_rows: 3, required: ["name", "price"] });
    expect(next.fingerprint.source).toBe("table");
    expect(next.history[1]).toMatchObject({ level: "L3", from_version: 1 });
    expect(llm.calls[0]?.user).toContain("WANT: one row per product");
    expect(llm.calls[0]?.timeoutMs).toBe(180_000);
    expect(t.page.reads.at(-1)).toEqual({ text: true, limits: { rows: 5000 } });
  });
  it("L3 keeps the field names, the field types, min_rows, and the required fields of the scraper", async () => {
    const t = setup({ results: tableRead });
    const { mrp: _mrp, ...fewer } = TABLE_FIELDS;
    const renamed = JSON.stringify({ set: "t1", fields: { ...fewer, price_inr: TABLE_FIELDS.price }, validate: { min_rows: 1, required: [] } });
    const retyped = JSON.stringify({ set: "t1", fields: { ...TABLE_FIELDS, price: { from: "column", header: "Price" } } });
    const loose = JSON.stringify({ set: "t1", fields: TABLE_FIELDS, validate: { min_rows: 1, required: ["pack"] } });
    const llm = fakeLlm([renamed, retyped, loose]);
    const spec = shopSpec();
    const r = await runScraper(spec, t.opts({ llm, heal: "full" }));
    // Two calls per L3 heal: the renamed and the retyped drafts do not pass, and nothing is saved.
    expect(r.status).toBe("failed");
    expect(t.saved).toEqual([]);
    expect(llm.calls[0]?.user).toContain('FIELDS: {"name":"string","pack":"string","price":"number","mrp":"number","can_add":"boolean"}');
    expect(llm.calls[1]?.user).toContain("field mrp is missing");
    expect(llm.calls[1]?.user).toContain("price_inr is not a field of the scraper");
    const again = await runScraper(spec, setup({ results: tableRead }).opts({ llm: fakeLlm([loose]) }));
    expect(again).toMatchObject({ status: "ok", healed: { level: "L3" } });
    const t2 = setup({ results: tableRead });
    await runScraper({ ...spec, validate: { ...spec.validate, min_rows: 4 } }, t2.opts({ llm: fakeLlm([loose]) }));
    // The draft's min_rows 1 does not replace the scraper's 4; its required field is added to the old ones.
    expect((t2.saved[0] as ScraperSpec).validate).toMatchObject({ min_rows: 4, required: ["name", "price", "pack"] });
    const t3 = setup({ results: tableRead });
    const r3 = await runScraper(spec, t3.opts({ llm: fakeLlm([retyped, retyped]) }));
    expect(r3.status).toBe("failed");
    expect(r3.reason).toContain("field price is a string; the scraper gives a number");
  });
  it("two bad LLM answers give failed; the second call gets the problems of the first; nothing is saved", async () => {
    const t = setup({ results: tableRead });
    const llm = fakeLlm(["I cannot help", JSON.stringify({ set: "t1", fields: { name: { from: "column", header: "Nope" } } })]);
    const r = await runScraper(shopSpec(), t.opts({ llm }));
    expect(r.status).toBe("failed");
    expect(r.healed).toBeNull();
    expect(r.stats.llm_calls).toBe(2);
    expect(r.reason).toMatch(/^extract: no record group matches .*; L3: the answer is not a usable draft: fields\.name\.header: /);
    expect(llm.calls[1]?.user).toContain("Your last answer failed: the answer holds no JSON object. Answer again.");
    expect(t.saved).toEqual([]);
  });
  it("heal none gives failed with no heal; heal code tries L1 only", async () => {
    const t = setup({ results: tableRead });
    const llm = fakeLlm([TABLE_DRAFT]);
    const nav = navigator(NAV_SCRIPT("Search"));
    const none = await runScraper(shopSpec(), t.opts({ heal: "none", llm, navigator: nav }));
    expect(none).toMatchObject({ status: "failed", healed: null, saved: null });
    expect(none.reason).toMatch(/^extract: no record group matches/);
    const code = await runScraper(shopSpec(), t.opts({ heal: "code", llm, navigator: nav }));
    expect(code.status).toBe("failed");
    expect(code.reason).toMatch(/; L1: no set of the page fits the fingerprint/);
    expect(llm.calls).toEqual([]);
    expect(nav.oracle.requests).toEqual([]);
    expect(t.saved).toEqual([]);
  });
  it("L2 that reaches a page with the old extract failing goes on to L3 on that page, and saves the new steps too", async () => {
    const t = setup({ home: HOME_V3, results: tableRead });
    const nav = navigator(NAV_SCRIPT("Find"));
    const llm = fakeLlm([TABLE_DRAFT]);
    const r = await runScraper(shopSpec(), t.opts({ navigator: nav, llm }));
    expect(r.status).toBe("ok");
    expect(r.healed?.level).toBe("L3");
    const next = t.saved[0] as ScraperSpec;
    expect(next.steps[1]).toEqual({ op: "click", target: { role: "button", name: "Find" } });
    expect(next.extract.source).toBe("table");
    expect(r.stats.llm_calls).toBe(1);
    expect(r.stats.jev_requests).toBeGreaterThan(0);
  });
  it("a replay failure with no navigator does not ask the LLM: the page is not the page of the rows", async () => {
    const t = setup({ home: HOME_V3 });
    const llm = fakeLlm([TABLE_DRAFT]);
    const r = await runScraper(shopSpec(), t.opts({ llm }));
    expect(r).toMatchObject({ status: "failed", reason: "step 2: no button \"Search\"; L3: skipped (the steps do not reach the page of the rows)" });
    expect(llm.calls).toEqual([]);
    const bare = await runScraper(shopSpec(), t.opts());
    expect(bare.reason).toBe("step 2: no button \"Search\"; L3: skipped (no LLM: install Claude Code, or set JEV_SCRAPE_LLM=text with JEV_TEXT_*)");
  });
});

/** L2 Jev that does the path of NAV_SCRIPT but never says done: on `stopAt` it answers BLOCKED (impossible). */
const NO_DONE = (button: string, stopAt: string, extra?: { url: string; click: string }): OracleScript => (name, state, q) => {
  if (name !== "step") return {};
  const s = state as { page: { url: string }; recent_actions: unknown[] };
  if (extra && s.page.url === extra.url) return { page_kind: "task_page", operation: { choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 0.9, DONE: 0.05, WAIT: 0.05 } }, click_target: { choice: idx(q, "click_target", extra.click), confidence: 0.9 } };
  if (s.page.url === stopAt) return { page_kind: "task_page", operation: { choice: "BLOCKED", confidence: 0.95, probabilities: { BLOCKED: 0.95, DONE: 0.05 } }, blocked_reason: { choice: "impossible", confidence: 0.95 } };
  return (NAV_SCRIPT(button) as Extract<OracleScript, (...a: never[]) => unknown>)(name, state, q);
};

describe("runScraper: L2 when Jev does not say done", () => {
  it("the prefix with the submit after the query step gives the rows: it is the new path", async () => {
    const t = setup({ home: HOME_V3 });
    const nav = navigator(NO_DONE("Find", RES_URL));
    const r = await runScraper(shopSpec(), t.opts({ navigator: nav, llm: fakeLlm([]) }));
    expect(r).toMatchObject({ status: "ok", healed: { level: "L2" }, row_count: ROWS.length, stats: { llm_calls: 0 } });
    expect(r.stats.jev_requests).toBeGreaterThan(0);
    expect((t.saved[0] as ScraperSpec).steps).toEqual([
      { op: "fill", target: { role: "searchbox", name: "Search products" }, value: "{query}" },
      { op: "click", target: { role: "button", name: "Find" } },
    ]);
  });
  it("a search that shows results as the user types: Jev went on to another page, the prefix without the click wins", async () => {
    const HELP_URL = "https://shop.example/help";
    const LIVE = obs(HOME_URL, [el("e1", "fill", "Search products", "searchbox", { value: "" })], "Shop home");
    const LIVE_RES = obs(RES_URL, [el("e1", "fill", "Search products", "searchbox", { value: "eggs" }), el("e7", "click", "Help", "link")], "Results\nADD");
    const page = readPage({
      pages: { blank: BLANK, home: LIVE, results: LIVE_RES, help: obs(HELP_URL, [], "Help") }, start: "blank",
      transitions: (c, cur) => (c.op === "navigate" ? "home" : c.op === "act" && c.id === "e1" && c.text ? "results" : cur === "results" && c.op === "act" && c.id === "e7" ? "help" : undefined),
      reads: { results: READ },
    });
    const saved: ScraperSpec[] = [];
    const c = clock();
    const nav = navigator(NO_DONE("Help", HELP_URL, { url: RES_URL, click: "Help" }));
    const r = await runScraper(shopSpec(), {
      heal: "full", browser: fakeBrowser(page), headed: false, log: fakeLogger(), now: c.now, sleep: c.sleep, stepTimeoutMs: 1000, navigator: nav,
      save: (sp) => { saved.push(sp); return "/tmp/scrapers/shop.json"; },
    });
    expect(r).toMatchObject({ status: "ok", healed: { level: "L2" }, row_count: ROWS.length });
    expect((saved[0] as ScraperSpec).steps).toEqual([{ op: "fill", target: { role: "searchbox", name: "Search products" }, value: "{query}" }]);
  });
  it("a task with no param gives no prefix trial: a part of the path is no proof of the page", async () => {
    // Each page shows product cards of the same template. The site renamed "Bestsellers"; Jev clicks the category
    // and then gives up.
    const FRUITS_URL = "https://shop.example/c/fruits";
    const page = readPage({
      pages: {
        blank: BLANK, home: obs(HOME_URL, [el("e3", "click", "Fruits & Vegetables", "link")], "Shop home"),
        fruits: obs(FRUITS_URL, [el("e4", "click", "Top sellers", "link")], "Fruits"),
      },
      start: "blank",
      transitions: (c, cur) => (c.op === "navigate" ? "home" : cur === "home" && c.op === "act" && c.id === "e3" ? "fruits" : undefined),
      reads: { home: READ, fruits: READ },
    });
    const spec = parseScraper({
      ...shopSpec(), name: "bestsellers", task: "show the bestsellers in Fruits & Vegetables", params: {},
      steps: [{ op: "click", target: { role: "link", name: "Fruits & Vegetables" } }, { op: "click", target: { role: "link", name: "Bestsellers" } }],
    });
    const nav = navigator((name, state, q) => {
      if (name !== "step") return {};
      if ((state as { page: { url: string } }).page.url === FRUITS_URL) return { page_kind: "task_page", operation: { choice: "BLOCKED", confidence: 0.95, probabilities: { BLOCKED: 0.95, DONE: 0.05 } }, blocked_reason: { choice: "impossible", confidence: 0.95 } };
      return { page_kind: "task_page", operation: { choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 0.9, DONE: 0.05, WAIT: 0.05 } }, click_target: { choice: idx(q, "click_target", "Fruits & Vegetables"), confidence: 0.9 } };
    });
    const saved: ScraperSpec[] = [];
    const c = clock();
    const r = await runScraper(spec, {
      heal: "full", browser: fakeBrowser(page), headed: false, log: fakeLogger(), now: c.now, sleep: c.sleep, stepTimeoutMs: 1000, navigator: nav, llm: fakeLlm([]),
      save: (sp) => { saved.push(sp); return "/tmp/scrapers/bestsellers.json"; },
    });
    expect(r.status).toBe("failed");
    expect(r.reason).toBe("step 2: no link \"Bestsellers\"; L3: skipped (the steps do not reach the page of the rows)");
    expect(saved).toEqual([]);
    // Page loads: the replay and Jev's own. No prefix trial loads the page again.
    expect(page.calls.filter((x) => x.op === "navigate")).toHaveLength(2);
  });
  it("a Jev run with no step that types the query gives no prefix trial", async () => {
    const t = setup({ home: HOME_V3 });
    const nav = navigator(NO_DONE("Find", HOME_URL));
    const r = await runScraper(shopSpec(), t.opts({ navigator: nav }));
    expect(r.status).toBe("failed");
    expect(t.saved).toEqual([]);
    // Page loads: the replay, the start page before Jev, and Jev's own. No prefix trial loads the page again.
    expect(t.page.calls.filter((c) => c.op === "navigate")).toHaveLength(3);
  });
});

describe("runScraper: blocked", () => {
  it("a blocked L2 (needs_sign_in) gives blocked", async () => {
    const t = setup({ home: HOME_V3 });
    const nav = navigator((name) => (name === "step" ? { page_kind: { choice: "sign_in_wall", confidence: 0.95, probabilities: { sign_in_wall: 0.95, task_page: 0.05 } }, operation: "WAIT" } : {}));
    const r = await runScraper(shopSpec(), t.opts({ navigator: nav, llm: fakeLlm([]) }));
    expect(r.status).toBe("blocked");
    expect(r.blocked?.kind).toBe("sign_in");
    expect(r.blocked?.hint).toContain("--headed");
    expect(t.saved).toEqual([]);
  });
  it("a captcha in L2 gives blocked captcha", async () => {
    const t = setup({ home: HOME_V3 });
    const nav = navigator((name) => (name === "step" ? { page_kind: { choice: "captcha_or_bot_check", confidence: 0.9 }, operation: "WAIT" } : {}));
    const r = await runScraper(shopSpec(), t.opts({ navigator: nav }));
    expect(r).toMatchObject({ status: "blocked", blocked: { kind: "captcha" } });
  });
  it("a sign-in wall at a missing step target blocks with no heal", async () => {
    const t = setup({ home: obs("https://accounts.google.com/v3/signin", [], "Sign in", { title: "Sign in - Google Accounts" }) });
    const nav = navigator(NAV_SCRIPT("Search"));
    const r = await runScraper(shopSpec(), t.opts({ navigator: nav }));
    expect(r).toMatchObject({ status: "blocked", blocked: { kind: "sign_in" } });
    expect(r.reason).toMatch(/sign-in wall/);
    expect(nav.oracle.requests).toEqual([]);
  });
  it("a captcha page after the steps blocks with no heal", async () => {
    const t = setup({ resultsObs: obs(RES_URL, [], "Please verify you are human"), results: () => ({ ...READ(), groups: [] }) });
    const r = await runScraper(shopSpec(), t.opts({ llm: fakeLlm([TABLE_DRAFT]) }));
    expect(r).toMatchObject({ status: "blocked", blocked: { kind: "captcha" } });
  });
});

describe("nextSpec", () => {
  it("drops the oldest history entries above HISTORY_MAX", () => {
    let s = shopSpec();
    for (let i = 0; i < 12; i++) s = nextSpec(s, "L1", `heal ${i}`, {}, `2026-09-27T0${i % 10}:00:00Z`);
    expect(s.version).toBe(13);
    expect(s.history).toHaveLength(HISTORY_MAX);
    expect(s.history[0]?.reason).toBe("heal 2");
    expect(s.history.at(-1)?.from_version).toBe(12);
  });
});
