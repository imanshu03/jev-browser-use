// Live test of the page reader and the loader: one headless Chrome on a temporary profile, file:// fixtures, no network.
// Run with `npm run test:live` (JEV_LIVE=1).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChrome } from "../../src/fast/chrome.js";
import type { Chrome, Page } from "../../src/fast/model.js";
import { openPage } from "../../src/fast/page.js";
import { loadAll } from "../../src/fast/read.js";
import type { PageRead, RecordGroup, TableRead } from "../../src/fast/read-types.js";
import { normKey } from "../../src/fast/read-types.js";
import { fakeLogger } from "../fakes.js";

const FIXTURES = path.resolve(__dirname, "../fixtures/live");
const url = (name: string): string => pathToFileURL(path.join(FIXTURES, name)).href;
const NAV_MS = 5000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every string of a read, for "text X is nowhere" checks. */
function strings(read: PageRead): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk({ tables: read.tables, groups: read.groups, text: read.text, meta: read.meta });
  return out;
}

const tableBy = (read: PageRead, first: string): TableRead => {
  const t = read.tables.find((x) => x.headers[0] === first);
  if (!t) throw new Error(`no table with first header "${first}" among: ${read.tables.map((x) => x.headers.join("|")).join(", ")}`);
  return t;
};

describe.skipIf(process.env["JEV_LIVE"] !== "1")("page reader (live Chrome)", () => {
  let chrome: Chrome;
  let page: Page;
  const log = fakeLogger();
  const ms: Record<string, number> = {};

  async function readOf(name: string, opts: Parameters<NonNullable<Page["read"]>>[0] = {}): Promise<PageRead> {
    await page.navigate(url(name), NAV_MS);
    const r = await page.read!(opts);
    ms[name] = Math.max(ms[name] ?? 0, r.stats.ms);
    return r;
  }
  async function evaluate<T>(expression: string): Promise<T> {
    const res = await chrome.client.send("Runtime.evaluate", { expression, returnByValue: true }, page.sessionId);
    return (res["result"] as { value: T }).value;
  }

  beforeAll(async () => {
    chrome = await launchChrome({ headed: false, env: process.env, log });
    page = await openPage(chrome, { settleTimeoutMs: NAV_MS, log });
  }, 30_000);

  afterAll(async () => {
    await page?.close().catch(() => undefined);
    await chrome?.close().catch(() => undefined);
    if (chrome?.pid && processAlive(chrome.pid)) process.kill(chrome.pid, "SIGKILL");
  });

  it("NECC: one data table of width 32 with two sections, the rows below the fold, and the month and year", async () => {
    const r = await readOf("read-necc.html");
    expect(await evaluate<string>("document.compatMode")).toBe("BackCompat");
    expect(r.tables).toHaveLength(1);
    const t = r.tables[0] as TableRead;
    expect(t.id).toBe("t1");
    expect(t.kind).toBe("html");
    expect(t.width).toBe(32);
    expect(t.header_rows).toBe(1);
    expect(t.headers[0]).toBe("Name Of Zone / Day");
    expect(t.headers.slice(1, 31)).toEqual(Array.from({ length: 30 }, (_, i) => String(i + 1)));
    expect(t.headers[31]).toBe("Average");
    expect(t.row_count).toBe(34);
    expect(t.rows).toHaveLength(34);
    expect(t.truncated).toBe(false);
    expect(t.sections).toEqual(["NECC SUGGESTED EGG PRICES", "Prevailing Prices"]);
    expect(t.rows.filter((x) => x.section === "NECC SUGGESTED EGG PRICES")).toHaveLength(24);
    expect(t.rows.filter((x) => x.section === "Prevailing Prices")).toHaveLength(10);
    expect(t.rows.every((x) => x.cells.length === 32)).toBe(true);
    const hyd = t.rows.find((x) => x.cells[0] === "Hyderabad");
    expect(hyd?.cells[t.headers.indexOf("27")]).toBe("525");
    expect(hyd?.cells[31]).toBe("535.00");
    expect(hyd?.cells[28]).toBe("-");
    // The last rows are below the fold at scroll 0, and the reader has them.
    expect(await evaluate<boolean>("[...document.querySelectorAll('tr')].at(-1).getBoundingClientRect().top > innerHeight")).toBe(true);
    expect(t.rows.at(-1)?.cells[0]).toBe("Varanasi (CC)");
    expect(t.heading).toBe("DAILY/MONTHLY EGG PRICES SUGGESTED BY NECC AND PREVAILING PRICES");
    expect(t.signature).toEqual({ kind: "table", headers: t.headers.map(normKey), width: 32, caption: "", heading: normKey(t.heading) });
    // The form layout table is not a data table.
    expect(r.tables.some((x) => x.headers.some((h) => /Month|Year/.test(h)))).toBe(false);
    const month = r.meta.selected.find((x) => x.name === "ddlMonth");
    const year = r.meta.selected.find((x) => x.name === "ddlYear");
    expect(month).toMatchObject({ kind: "select", value: "08", text: "08" });
    expect(year).toMatchObject({ kind: "select", value: "2026", text: "2026" });
    expect(r.meta.selected.find((x) => x.name === "rblReportType")).toMatchObject({ kind: "radio", value: "DailyReport" });
    expect(r.meta.headings).toEqual(["NATIONAL EGG CO-ORDINATION COMMITTEE"]);
    expect(r.stats.scroll_height).toBeGreaterThan(r.stats.viewport_height);
    expect(r.stats.tables_seen).toBe(1);
  });

  it("cards: 24 Blinkit-like records and one merged group of 21 Zepto-like records with their facts", async () => {
    const r = await readOf("read-cards.html");
    const bk = r.groups.find((g) => g.count === 24) as RecordGroup;
    const zp = r.groups.find((g) => g.testid === "product-card") as RecordGroup;
    expect(bk).toBeDefined();
    expect(zp).toBeDefined();
    // The Zepto row wrappers (3+6+6+6 cards) and the page sections are not groups.
    expect(r.groups).toHaveLength(2);
    expect(r.groups.map((g) => g.id)).toEqual(["g1", "g2"]);
    expect(r.groups.some((g) => g.count === 4 || g.shape.startsWith("div.w-full"))).toBe(false);

    // Blinkit: plain div cards; one template gives the same keys, with or without the discount badge.
    expect(bk.shape).toBe("div");
    expect(bk.testid).toBeNull();
    expect(bk.heading).toBe("Showing results for chicken curry cut");
    expect(bk.records).toHaveLength(24);
    const bkKeys = ["div.tw-badge", "div.tw-eta>span", "div.tw-name", "div.tw-pack", "div.tw-price-row>div.tw-prices>div", "div.tw-price-row>div.tw-prices>div.strike", "div.tw-price-row>div.tw-add"];
    expect(bk.signature).toEqual({ kind: "records", shape: "div", parent: "div", testid: null, slot_keys: [...bkKeys].sort() });
    for (const rec of bk.records) {
      const keys = rec.slots.map((s) => s.key);
      expect(keys.every((k) => bkKeys.includes(k))).toBe(true);
      expect(keys).toContain("div.tw-name");
      if (keys.includes("div.tw-badge")) expect(keys).toEqual(bkKeys);
      else expect(keys).toEqual(bkKeys.filter((k) => k !== "div.tw-badge" && !k.endsWith(".strike")));
    }
    const info = new Map(bk.slots.map((s) => [s.key, s]));
    expect(bk.slots.map((s) => s.key)).toEqual(bkKeys);
    expect(info.get("div.tw-badge")?.filled).toBe(21);
    expect(info.get("div.tw-name")?.filled).toBe(24);
    expect(info.get("div.tw-price-row>div.tw-prices>div.strike")).toMatchObject({ filled: 21, struck: 21 });
    expect(info.get("div.tw-price-row>div.tw-prices>div")).toMatchObject({ filled: 24, struck: 0, samples: ["₹120", "₹127", "₹134"] });
    expect(info.get("div.tw-price-row>div.tw-add")).toMatchObject({ filled: 24, button: 24, samples: ["ADD", "Out of stock"] });
    const first = bk.records[0]?.slots ?? [];
    // The price is in aria-hidden text: it stays.
    expect(first.find((s) => s.key === "div.tw-price-row>div.tw-prices>div")?.text).toBe("₹120");
    expect(first.find((s) => s.key.endsWith(".strike"))).toMatchObject({ text: "₹142", struck: true });
    const adds = bk.records.flatMap((x) => x.slots).filter((s) => s.text === "ADD");
    expect(adds).toHaveLength(23);
    expect(adds.every((s) => s.button === true && s.disabled === undefined)).toBe(true);
    expect(bk.records.flatMap((x) => x.slots).find((s) => s.text === "Out of stock")).toMatchObject({ button: true, disabled: true });
    expect(bk.records.every((x) => x.href === undefined)).toBe(true);

    // Zepto: link cards with a testid, merged over 4 row containers; the price comes before the name.
    expect(zp.shape).toBe("a.b#vnq.oikwp[testid=product-card]");
    expect(zp.count).toBe(21);
    expect(zp.records).toHaveLength(21);
    expect(zp.heading).toBe("More results");
    expect(zp.signature.parent).toBe("div.grid.grid-cols-#");
    const zKeys = ["div.c#szxs>img", "div.c#szxs>button.cptqt#", "div.cp#rg#>p.price-tag", "div.cp#rg#>p.line-through.mrp-tag", "div.cqajo#>h5.name-tag", "div.cqajo#>p.pack-tag"];
    expect(zp.slots.map((s) => s.key)).toEqual(zKeys);
    expect(zp.signature.slot_keys).toEqual([...zKeys].sort());
    for (const rec of zp.records) {
      expect(rec.slots.map((s) => s.key)).toEqual(zKeys);
      expect(rec.href).toMatch(/^file:\/\/\/pn\/[a-z0-9-]+\/pvid\/p\d\d$/);
      expect(rec.slots.every((s) => s.href === rec.href)).toBe(true);
    }
    const z0 = zp.records[0]?.slots ?? [];
    expect(z0[0]).toMatchObject({ key: "div.c#szxs>img", text: "", alt: "Licious Goat Curry Cut (Mini Pack)" });
    expect(z0[1]).toMatchObject({ text: "ADD", button: true });
    // "₹", a comment, and "150" in one element are one slot.
    expect(z0[2]).toMatchObject({ text: "₹150" });
    expect(z0[3]).toMatchObject({ text: "₹160", struck: true });
    expect(z0[4]).toMatchObject({ text: "Licious Goat Curry Cut (Mini Pack)", heading: true });
    const zInfo = new Map(zp.slots.map((s) => [s.key, s]));
    expect(zInfo.get("div.cqajo#>h5.name-tag")).toMatchObject({ filled: 21, heading: 21 });
    expect(zInfo.get("div.cp#rg#>p.line-through.mrp-tag")).toMatchObject({ filled: 21, struck: 21 });
    expect(zInfo.get("div.c#szxs>button.cptqt#")).toMatchObject({ filled: 21, button: 21, samples: ["ADD"] });

    // Hidden text is nowhere: the sr-only price words and the display:none card.
    const all = strings(r).join("\n");
    expect(all).not.toContain("rupees");
    expect(all).not.toContain("Hidden Chicken Product");
    expect(all).not.toContain("₹999");
    expect(r.stats.groups_seen).toBe(2);
  });

  it("grid: an ARIA grid, rowspan and colspan, a table in an open shadow root, a nested layout table, and the number rule", async () => {
    const r = await readOf("read-grid.html");
    expect(r.tables.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
    const aria = tableBy(r, "Name");
    expect(aria).toMatchObject({ id: "t1", kind: "aria", width: 3, header_rows: 1, caption: "Roster", heading: "Team roster", row_count: 5 });
    expect(aria.headers).toEqual(["Name", "Team", "Score"]);
    expect(aria.rows.map((x) => x.cells[0])).toEqual(["Ada", "Grace", "Linus", "Margaret", "Alan"]);

    const sales = tableBy(r, "Region");
    expect(sales).toMatchObject({ kind: "html", width: 5, header_rows: 2, caption: "Sales by region", heading: "Quarterly sales", row_count: 4, nested: false });
    expect(sales.headers).toEqual(["Region", "Q1 / Jan", "Q1 / Feb", "Q1 / Mar", "Total"]);
    expect(sales.rows.map((x) => x.cells)).toEqual([
      ["North", "1", "2", "3", "6"],
      ["North", "4", "5", "6", "15"],
      ["South", "n/a", "n/a", "n/a", "0"],
      ["East", "7", "8", "9", "24"],
    ]);
    expect(sales.rows[3]?.links).toEqual({ 1: url("east/jan.html") });
    expect(sales.rows[0]?.links).toBeUndefined();
    expect(sales.signature).toEqual({ kind: "table", headers: ["region", "q1 / jan", "q1 / feb", "q1 / mar", "total"], width: 5, caption: "sales by region", heading: "quarterly sales" });

    const shadow = tableBy(r, "Item");
    expect(shadow).toMatchObject({ heading: "Shadow prices", row_count: 3, nested: false });
    expect(shadow.rows.map((x) => x.cells)).toEqual([["Tea", "10"], ["Coffee", "20"], ["Milk", "5"]]);

    // The layout table that holds the stock table is skipped; the inner table is read.
    const stock = tableBy(r, "Part");
    expect(stock).toMatchObject({ nested: true, heading: "Inner stock", row_count: 2 });
    expect(r.tables.some((t) => t.rows.some((x) => x.cells.some((c) => c.includes("Side note"))))).toBe(false);

    // No th: row 1 is the header row by the number rule.
    const plain = tableBy(r, "City");
    expect(plain).toMatchObject({ header_rows: 1, row_count: 2, heading: "Weather" });
    expect(plain.headers).toEqual(["City", "Temp", "Rain"]);

    const long = tableBy(r, "#");
    expect(long).toMatchObject({ row_count: 25, truncated: false });
    expect(r.stats.tables_seen).toBe(6);
    expect(r.stats.truncated).toBe(false);

    // Form values: search, select, and a checked checkbox; never a password, a credential field, or a hidden input.
    expect(r.meta.selected).toEqual([
      { kind: "input", name: "q", label: "Find", value: "bolts", text: "bolts" },
      { kind: "select", name: "size", label: "Size", value: "m", text: "Medium" },
      { kind: "checkbox", name: "stock", label: "In stock only", value: "yes", text: "In stock only" },
    ]);
    expect(strings(r).join("\n")).not.toMatch(/hunter22|123456|482913|4111111111111111|731|774411|000123456789|909090|4321/);
    expect(r.meta.lang).toBe("en");
    expect(r.meta.headings).toEqual(["Tables fixture", "Team roster", "Quarterly sales", "Shadow prices", "Inner stock", "Weather", "Long list", "Offers"]);
  });

  it("plain-div cards: a card and a part of a card are never one group, and the parts of each card are dropped", async () => {
    const r = await readOf("read-grid.html", { text: false });
    const slots = r.groups.flatMap((g) => g.records.flatMap((x) => x.slots.map((s) => s.text)));
    for (let i = 1; i <= 4; i++) expect(slots.filter((t) => t === `CODE${i}`)).toHaveLength(1);
    const deals = r.groups.find((g) => g.records.some((x) => x.slots.some((s) => s.text === "Deal 1")));
    expect(deals?.heading).toBe("Offers");
    const cards = deals?.records.filter((x) => x.slots[0]?.key === "h4") ?? [];
    expect(cards.map((x) => x.slots.map((s) => s.key))).toEqual(Array(4).fill(["h4", "div>b", "div>i", "div>b@2", "div>i@2", "p"]));
    expect(cards[3]?.slots.map((s) => s.text)).toEqual(["Deal 4", "Code", "CODE4", "Ends", "Day 4", "Terms apply 4"]);
    // No group of card parts (records of only "b" and "i" with a code).
    expect(r.groups.some((g) => g.records.some((x) => x.slots.length === 2 && x.slots[1]?.text.startsWith("CODE")))).toBe(false);
  });

  it("sections: a text between same-testid rows keeps the cards below it apart; rows with no text between merge", async () => {
    const r = await readOf("read-sections.html", { text: true });
    const names = (g: RecordGroup): string[] => g.records.map((x) => x.slots.find((s) => s.text.endsWith(` item ${x.href?.split("-").pop()}`))?.text ?? "");
    expect(r.groups.map((g) => [g.count, g.testid])).toEqual([[8, "product-card"], [3, "product-card"], [6, "product-card"]]);
    const [results, similar, explore] = r.groups as [RecordGroup, RecordGroup, RecordGroup];
    expect(names(results)).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((i) => `Result item ${i}`));
    expect(names(similar)).toEqual([9, 10, 11].map((i) => `Similar item ${i}`));
    expect(names(explore)).toEqual([12, 13, 14, 15, 16, 17].map((i) => `Explore item ${i}`));
    // The three groups have one signature: a scraper picks the first (the results) on a tie.
    expect(new Set(r.groups.map((g) => JSON.stringify(g.signature.slot_keys))).size).toBe(1);
  });

  it("flat sections: a row after a section label joins the earlier set of its own section, not the results", async () => {
    const r = await readOf("read-sections-flat.html", { text: true });
    const names = (g: RecordGroup): string[] => g.records.map((x) => x.slots.find((s) => s.text.endsWith(` item ${x.href?.split("-").pop()}`))?.text ?? "");
    expect(r.groups.map((g) => g.count)).toEqual([6, 6]);
    const [results, explore] = r.groups as [RecordGroup, RecordGroup];
    expect(names(results)).toEqual([1, 2, 3, 4, 5, 6].map((i) => `Result item ${i}`));
    expect(names(explore)).toEqual([7, 8, 9, 10, 11, 12].map((i) => `Explore item ${i}`));
  });

  it("limits cut the rows: truncated with the full row_count", async () => {
    const r = await readOf("read-grid.html", { limits: { rows: 10 }, text: false });
    const long = tableBy(r, "#");
    expect(long.rows).toHaveLength(10);
    expect(long).toMatchObject({ row_count: 25, truncated: true });
    expect(long.rows.at(-1)?.cells).toEqual(["10", "word 10"]);
    expect(r.stats.truncated).toBe(true);
    expect(r.text).toEqual([]);
    const one = await page.read!({ limits: { tables: 1 }, text: false });
    expect(one.tables.map((t) => t.headers[0])).toEqual(["Name"]);
    expect(one.stats.tables_seen).toBe(6);
  });

  it("text blocks come in document order with heading levels, `in` for tables and groups, and no hidden text", async () => {
    const r = await readOf("read-grid.html");
    const texts = r.text.map((b) => b.text);
    expect(r.text[0]).toEqual({ text: "Tables fixture", tag: "h1", level: 1 });
    expect(texts).toContain("Intro text before the tables.");
    expect(texts.join("\n")).not.toMatch(/Skip to the tables|Invisible words|Hidden|Gray/);
    const at = (s: string): number => texts.indexOf(s);
    expect(at("Team roster")).toBeLessThan(at("Quarterly sales"));
    expect(at("Quarterly sales")).toBeLessThan(at("Shadow prices"));
    expect(at("Shadow prices")).toBeLessThan(at("Light text in the host"));
    expect(at("Light text in the host")).toBeLessThan(at("Inner stock"));
    expect(at("Inner stock")).toBeLessThan(at("Long list"));
    expect(r.text.find((b) => b.text === "Quarterly sales")).toEqual({ text: "Quarterly sales", tag: "h2", level: 2 });
    const sales = tableBy(r, "Region");
    expect(r.text.find((b) => b.text === "Sales by region")).toMatchObject({ tag: "caption", in: sales.id });
    expect(r.text.find((b) => b.text === "Margaret")).toMatchObject({ in: "t1" });
    expect(r.text.find((b) => b.text === "Side note")?.in).toBeUndefined();
    expect(r.text.find((b) => b.text === "Intro text before the tables.")?.in).toBeUndefined();

    const cards = await readOf("read-cards.html");
    const bk = cards.groups.find((g) => g.count === 24) as RecordGroup;
    const zp = cards.groups.find((g) => g.count === 21) as RecordGroup;
    expect(cards.text.find((b) => b.text === "Search results")).toMatchObject({ tag: "h1", level: 1 });
    expect(cards.text.find((b) => b.text === "Licious Chicken Curry Cut (Small Pieces)")).toMatchObject({ in: bk.id });
    expect(cards.text.find((b) => b.text === "₹120")).toMatchObject({ in: bk.id });
    expect(cards.text.find((b) => b.text === "Relish Chicken Curry Cut Without Skin")).toMatchObject({ tag: "h5", level: 5, in: zp.id });
    expect(cards.text.find((b) => b.text === "About us")?.in).toBeUndefined();
  });

  it("loadAll scrolls read-load from 12 to 60 records and ends stable", async () => {
    const before = await readOf("read-load.html");
    expect(before.groups.map((g) => g.count)).toEqual([12]);
    const report = await loadAll(page, { maxScrolls: 12, stableRounds: 2, pauseMs: 400, maxMs: 20_000 });
    expect(report.end).toBe("stable");
    expect(report.stable).toBe(true);
    expect(report.scrolls).toBeLessThanOrEqual(12);
    const after = await page.read!();
    expect(after.groups.map((g) => g.count)).toEqual([60]);
    expect(after.groups[0]?.records.at(-1)?.slots.map((s) => s.text)).toEqual(["Item 60", "Rs 160"]);
    expect(report.height).toBe(after.stats.scroll_height);
    ms["read-load.html"] = Math.max(ms["read-load.html"] ?? 0, after.stats.ms);
  }, 30_000);

  it("loadAll: a page that does not grow ends stable; maxScrolls ends scrolls", async () => {
    await page.navigate(url("read-grid.html"), NAV_MS);
    await expect(loadAll(page, { maxScrolls: 12, stableRounds: 2, pauseMs: 150, maxMs: 10_000 })).resolves.toMatchObject({ end: "stable", stable: true });
    await page.navigate(url("read-load.html"), NAV_MS);
    await expect(loadAll(page, { maxScrolls: 2, stableRounds: 2, pauseMs: 300, maxMs: 10_000 })).resolves.toMatchObject({ end: "scrolls", scrolls: 2, stable: false });
  }, 30_000);

  it("read after a click waits for the settle: a table that a 300 ms timer adds shows", async () => {
    await page.navigate(url("read-grid.html"), NAV_MS);
    await evaluate("(document.getElementById('add').scrollIntoView({ block: 'center' }), true)");
    const obs = await page.observe();
    const add = obs.actions.find((a) => a.label === "Add table");
    if (!add) throw new Error(`no "Add table" among ${obs.actions.map((a) => a.label).join(", ")}`);
    await page.act(add, obs);
    const r = await page.read!();
    const late = tableBy(r, "Late");
    expect(late).toMatchObject({ heading: "Late table", row_count: 2 });
    expect(late.rows.map((x) => x.cells)).toEqual([["a", "1"], ["b", "2"]]);
    expect(page.pending?.() ?? false).toBe(false);
  });

  it("the reader changes nothing on the page: the scroll position and the focus stay", async () => {
    await page.navigate(url("read-grid.html"), NAV_MS);
    await evaluate("(window.scrollTo(0, 400), document.querySelector('input[name=q]').focus({ preventScroll: true }), true)");
    const before = await evaluate<[number, string, number]>("[scrollY, document.activeElement.name, document.getElementsByTagName('*').length]");
    expect(before[0]).toBe(400);
    const r = await page.read!();
    expect(r.tables.length).toBeGreaterThan(0);
    const after = await evaluate<[number, string, number]>("[scrollY, document.activeElement.name, document.getElementsByTagName('*').length]");
    expect(after).toEqual(before);
    expect(await evaluate<number>("getSelection().rangeCount && getSelection().toString().length")).toBe(0);
  });

  it("each fixture reads in under 500 ms", async () => {
    for (const name of ["read-necc.html", "read-cards.html", "read-grid.html", "read-load.html", "read-sections.html"]) {
      if (ms[name] === undefined) await readOf(name);
      expect(ms[name], name).toBeLessThan(500);
    }
  });
});
