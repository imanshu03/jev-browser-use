// Live test of the scrape kit: one headless Chrome on a temporary profile, the file:// fixture scrape-shop.html, a
// scripted Jev oracle and a scripted LLM. No network, no key. Run with `npm run test:live` (JEV_LIVE=1).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChrome } from "@imanshu03/jev-core/fast/chrome.js";
import type { Chrome, Page } from "@imanshu03/jev-core/fast/model.js";
import { openPage } from "@imanshu03/jev-core/fast/page.js";
import { main } from "../../src/scrape/cli.js";
import type { NavigatorDeps, RunScraperOptions, ScrapeBrowser } from "@imanshu03/jev-core/scrape/runner.js";
import { runScraper } from "@imanshu03/jev-core/scrape/runner.js";
import type { Row, ScraperSpec } from "@imanshu03/jev-core/scrape/spec.js";
import { parseScraper } from "@imanshu03/jev-core/scrape/spec.js";
import { loadScraper, saveScraper } from "@imanshu03/jev-core/scrape/store.js";
import type { RunConfig } from "@imanshu03/jev-core/types.js";
import { fakeHuman, fakeLogger, fakeOracle, type OracleScript } from "@imanshu03/jev-core/test/fakes.js";
import { contextOf, fakeLlm, idx, valueKey } from "@imanshu03/jev-core/test/scrape/fakes.js";

const SHOP = pathToFileURL(path.resolve(__dirname, "../../../core/test/fixtures/live/scrape-shop.html")).href;
const AT = "2026-09-27T00:00:00.000Z";
const BOOL = { kind: "boolean" as const, true_words: ["add", "in stock"], false_words: ["out of stock"] };

/** The rows of every version: the same six products. */
const ROWS: Row[] = [
  { name: "Brown Eggs", pack: "6 pcs", price: 90, mrp: 100, can_add: true },
  { name: "White Eggs Tray", pack: "30 pcs", price: 210, mrp: null, can_add: true },
  { name: "Country Eggs", pack: "12 pcs", price: 160, mrp: 180, can_add: false },
  { name: "Toned Milk", pack: "1 l", price: 72, mrp: null, can_add: true },
  { name: "Paneer Block", pack: "200 g", price: 95, mrp: 110, can_add: true },
  { name: "Whole Wheat Bread", pack: "400 g", price: 45, mrp: null, can_add: true },
];

const slot = (key: string, extra: Partial<{ struck: boolean; button: boolean }> = {}) => ({ key, struck: extra.struck ?? false, button: extra.button ?? false, heading: false });
const KEYS = ["button.add", "div.badge", "div.name", "div.pack", "div.prices>div.mrp>s", "div.prices>div.price"];

/** A hand-written scraper of the result cards. */
function cardSpec(steps?: ScraperSpec["steps"]): ScraperSpec {
  return parseScraper({
    kind: "jev-scraper", format: 1, name: "shop-cards", version: 1, created_at: AT, updated_at: AT,
    task: "search the shop for {query}", want: "one row per product card: name, pack, price, MRP, and whether it can be added",
    params: { query: "eggs", v: "1" }, start_url: `${SHOP}?v={v}`,
    steps: steps ?? [
      { op: "fill", target: { role: "searchbox", name: "Search products" }, value: "{query}" },
      { op: "click", target: { role: "button", name: "Search" } },
      { op: "wait", for_text: "Results for", ms: 3000 },
    ],
    load: { mode: "none" },
    extract: {
      source: "records", match: { shape: "div.card", parent: "div.grid", testid: null, slot_keys: KEYS },
      fields: {
        name: { from: "slot", pick: [{ by: "key", key: "div.name" }] },
        pack: { from: "slot", pick: [{ by: "key", key: "div.pack" }], parser: "quantity" },
        price: { from: "slot", pick: [{ by: "key", key: "div.prices>div.price" }], parser: "price" },
        mrp: { from: "slot", pick: [{ by: "key", key: "div.prices>div.mrp>s" }], parser: "price" },
        can_add: { from: "slot", pick: [{ by: "key", key: "button.add" }], parser: BOOL },
      },
      key: ["name"],
    },
    validate: { min_rows: 5, required: ["name", "price", "can_add"], expect_keys: { field: "name", values: ["Brown Eggs"] } },
    fingerprint: {
      source: "records", headers: [], slot_keys: KEYS,
      fields: {
        name: { type: "string", slot: slot("div.name") }, pack: { type: "string", slot: slot("div.pack") }, price: { type: "number", slot: slot("div.prices>div.price") },
        mrp: { type: "number", slot: slot("div.prices>div.mrp>s", { struck: true }) }, can_add: { type: "boolean", slot: slot("button.add", { button: true }) },
      },
      keys: ["Brown Eggs", "White Eggs Tray", "Country Eggs", "Toned Milk", "Paneer Block"], row_count: 6, url_path: "/",
    },
    history: [{ at: AT, level: "author", reason: "hand-written", from_version: 0, previous: null }],
  });
}

/** A hand-written scraper of the price table. */
function tableSpec(): ScraperSpec {
  const card = cardSpec();
  return parseScraper({
    ...card, name: "shop-prices", want: "one row per item: item and price",
    extract: {
      source: "table", match: { headers: ["item", "price", "unit"], width: 3, heading: "price list", index: 0 },
      fields: { item: { from: "column", header: "Item", index_hint: 0 }, price: { from: "column", header: "Price", parser: "number", index_hint: 1 } },
    },
    validate: { min_rows: 5, required: ["item", "price"] },
    fingerprint: { source: "table", headers: ["item", "price", "unit"], slot_keys: [], fields: { item: { type: "string", column: "item" }, price: { type: "number", column: "price" } }, keys: ["Brown Eggs", "White Eggs Tray"], row_count: 6, url_path: "/" },
  });
}

const BASE: RunConfig = {
  task: "", headed: false, maxSteps: 8, stepTimeoutMs: 10_000, runTimeoutMs: 60_000, pauseTimeoutMs: 1000, confirm: "auto", dryRun: false, session: "jev-scrape-live",
  model: "jev-fake", logLevel: "info", logJson: false, keepOpen: true, agentBrowserBin: "", vars: {}, engine: "cdp",
};

/** Scripted Jev for L2: type the query, click the button, DONE when the results show. */
const NAV: OracleScript = (name, state, q) => {
  if (name !== "step") return {};
  const s = state as { page: { url: string }; recent_actions: unknown[] };
  if (s.page.url.includes("#q=")) return { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.95, probabilities: { DONE: 0.95, WAIT: 0.05 } } };
  if (s.recent_actions.length === 0) return { page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", "Search products"), confidence: 0.9 }, type_text_value: { choice: valueKey(q, "eggs"), confidence: 0.9 } };
  return { page_kind: "task_page", operation: { choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 0.9, DONE: 0.05, WAIT: 0.05 } }, click_target: { choice: idx(q, "click_target", "Find"), confidence: 0.9 } };
};

describe.skipIf(process.env["JEV_LIVE"] !== "1")("scrape kit (live Chrome)", () => {
  let chrome: Chrome;
  let dir: string;
  const log = fakeLogger();

  beforeAll(async () => {
    chrome = await launchChrome({ headed: false, env: process.env, log });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-scrape-live-"));
  }, 30_000);
  afterAll(async () => {
    await chrome?.close().catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A ScrapeBrowser with its own tab on the shared Chrome; close ends only the tab. */
  function browser(): ScrapeBrowser & { tab: () => Page | null } {
    let page: Promise<Page> | null = null;
    let open: Page | null = null;
    return {
      tab: () => open,
      page() { page ??= openPage(chrome, { settleTimeoutMs: 5000, log }).then((p) => { open = p; return p; }); return page; },
      async chrome() { return chrome; },
      async close() { await open?.close().catch(() => undefined); },
    };
  }

  const env = (): NodeJS.ProcessEnv => ({ XDG_CONFIG_HOME: path.join(dir, "config"), HOME: dir });
  async function run(spec: ScraperSpec, over: Partial<RunScraperOptions> = {}) {
    const b = browser();
    const file = path.join(dir, `${spec.name}.json`);
    try {
      const r = await runScraper(spec, { heal: "full", browser: b, headed: false, log, stepTimeoutMs: 3000, allowFile: true, save: (s) => saveScraper(s, env(), { path: file, overwrite: true }), ...over });
      return { r, file };
    } finally { await b.close(); }
  }

  it("replays a hand-written spec: rows with no model call", async () => {
    const nav: NavigatorDeps = { oracle: fakeOracle(() => { throw new Error("no Jev on the plain path"); }), human: fakeHuman({ interactive: false }), profiles: [], base: BASE };
    const llm = fakeLlm([]);
    const { r } = await run(cardSpec(), { navigator: nav, llm });
    expect(r).toMatchObject({ status: "ok", healed: null, version: 1, row_count: 6, stats: { jev_requests: 0, llm_calls: 0, steps: 3 } });
    expect(r.rows).toEqual(ROWS);
    expect(llm.calls).toEqual([]);
  }, 30_000);

  it("replays through a pointer-row suggestion (rule B)", async () => {
    const spec = cardSpec([
      { op: "fill", target: { role: "searchbox", name: "Search products" }, value: "{query}" },
      { op: "click", target: { role: "button", name: "{query}", match: "starts" } },
      { op: "wait", for_text: "Results for", ms: 3000 },
    ]);
    const { r } = await run(spec, { heal: "none" });
    expect(r).toMatchObject({ status: "ok", row_count: 6 });
  }, 30_000);

  it("?v=2 (new class names, a renamed header) heals at L1 and saves the new version", async () => {
    const { r, file } = await run(cardSpec(), { params: { v: "2" }, llm: fakeLlm([]) });
    expect(r).toMatchObject({ status: "ok", healed: { level: "L1" }, version: 2, saved: file, stats: { jev_requests: 0, llm_calls: 0 } });
    expect(r.rows).toEqual(ROWS);
    const saved = loadScraper(file, env()).spec;
    expect(saved.version).toBe(2);
    expect(saved.history.at(-1)).toMatchObject({ level: "L1", from_version: 1 });
    const again = await run(saved, { params: { v: "2" }, heal: "none" });
    expect(again.r).toMatchObject({ status: "ok", healed: null, version: 2, row_count: 6 });

    const t = await run(tableSpec(), { params: { v: "2" } });
    expect(t.r).toMatchObject({ status: "ok", healed: { level: "L1" }, version: 2 });
    expect(t.r.rows[0]).toEqual({ item: "Brown Eggs", price: 90 });
    expect(loadScraper(t.file, env()).spec.extract).toMatchObject({ fields: { price: { header: "Price (Rs)", index_hint: 1 } } });
  }, 60_000);

  it("?v=3 (the button is Find) heals at L2 with Jev and re-records the steps", async () => {
    const oracle = fakeOracle(NAV);
    const nav: NavigatorDeps = { oracle, human: fakeHuman({ interactive: false }), profiles: [{ directory: "Profile 14", name: "Parallelloop" }], base: BASE };
    const { r, file } = await run(cardSpec(), { params: { v: "3" }, navigator: nav, llm: fakeLlm([]) });
    expect(r).toMatchObject({ status: "ok", healed: { level: "L2", reason: "step 2: no button \"Search\"" }, version: 2, row_count: 6 });
    expect(r.rows).toEqual(ROWS);
    expect(r.stats.jev_requests).toBe(oracle.requests.length);
    expect(r.stats.llm_calls).toBe(0);
    const saved = loadScraper(file, env()).spec;
    expect(saved.steps).toEqual([
      { op: "fill", target: { role: "searchbox", name: "Search products" }, value: "{query}" },
      { op: "click", target: { role: "button", name: "Find" } },
    ]);
    const again = await run(saved, { params: { v: "3" }, heal: "none" });
    expect(again.r).toMatchObject({ status: "ok", healed: null, row_count: 6 });
  }, 60_000);

  it("?v=4 (a new layout) heals at L3 with the LLM", async () => {
    const llm = fakeLlm([(req) => {
      const t = contextOf(req.user).tables.find((x) => x.headers.includes("Product"));
      return JSON.stringify({
        set: t?.id ?? "t1",
        fields: {
          name: { from: "column", header: "Product" }, pack: { from: "column", header: "Size", parser: "quantity" }, price: { from: "column", header: "Price", parser: "price" },
          mrp: { from: "column", header: "MRP", parser: "price" }, can_add: { from: "column", header: "Stock", parser: BOOL },
        },
      });
    }]);
    const { r, file } = await run(cardSpec(), { params: { v: "4" }, llm });
    expect(r).toMatchObject({ status: "ok", healed: { level: "L3" }, version: 2, stats: { llm_calls: 1, jev_requests: 0 } });
    expect(r.rows).toEqual(ROWS);
    expect(llm.calls[0]?.user).toContain("<<<UNTRUSTED_PAGE_DATA");
    const saved = loadScraper(file, env()).spec;
    expect(saved.extract.source).toBe("table");
    expect(saved.validate.expect_keys).toEqual({ field: "name", values: ["Brown Eggs"] });
    const again = await run(saved, { params: { v: "4" }, heal: "none" });
    expect(again.r).toMatchObject({ status: "ok", healed: null, row_count: 6 });
  }, 60_000);

  it("CSV and --out through main", async () => {
    saveScraper(cardSpec(), env());
    const deps = { browser: () => browser(), profiles: [{ directory: "Profile 14", name: "Parallelloop" }], llm: null, navigator: null };
    const streams = () => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let out = "";
      stdout.on("data", (d: Buffer) => { out += d.toString(); });
      stderr.resume();
      return { io: { stdout, stderr, stdin: new PassThrough() as unknown as NodeJS.ReadStream, env: env() }, out: () => out };
    };
    const a = streams();
    expect(await main(["run", "shop-cards", "--format", "csv"], a.io, deps)).toBe(0);
    const lines = a.out().trim().split("\r\n");
    expect(lines[0]).toBe("name,pack,price,mrp,can_add");
    expect(lines[1]).toBe("Brown Eggs,6 pcs,90,100,true");
    expect(lines).toHaveLength(7);
    const file = path.join(dir, "rows.json");
    const b = streams();
    expect(await main(["run", "shop-cards", "--out", file], b.io, deps)).toBe(0);
    expect(JSON.parse(b.out())).toMatchObject({ status: "ok", out: file, row_count: 6 });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(ROWS);
  }, 60_000);
});
