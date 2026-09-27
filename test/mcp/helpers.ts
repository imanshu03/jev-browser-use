// Shared helpers of the MCP tests: a scripted Jev for the reply flow, a fake mail page on a BrowserSession, an
// in-memory MCP client, page reads, and a fake scrape kit. No network, no real key, and no Chrome.
import type { ChoiceQuestion, Questions } from "@typesafe-ai/sdk";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ProfileEntry } from "../../src/browser.js";
import type { Chrome, ChromeLaunchOptions, Observation } from "../../src/fast/model.js";
import type { PageRead, ReadOptions, RecordGroup, RecordRead, Slot, SlotInfo, TableRead } from "../../src/fast/read-types.js";
import { normKey } from "../../src/fast/read-types.js";
import type { LoadOptions } from "../../src/fast/read.js";
import { BrowserSession } from "../../src/fast/session.js";
import type { Logger } from "../../src/io.js";
import type { RunManager } from "../../src/mcp/runs.js";
import type { ScrapeKit } from "../../src/mcp/scraper-tool.js";
import { buildServer } from "../../src/mcp/server.js";
import type { ServerDeps } from "../../src/mcp/server.js";
import type { JevLink } from "../../src/mcp/setup.js";
import { baseConfig } from "../../src/mcp/setup.js";
import type { RunScraperOptions } from "../../src/scrape/runner.js";
import type { RecordField, Row, RowValue, ScrapeResult, ScraperSpec, Step, TableField } from "../../src/scrape/spec.js";
import { SpecError, parseScraper } from "../../src/scrape/spec.js";
import type { PartialAnswers } from "../fakes.js";
import { fakeLogger, fakeOracle } from "../fakes.js";
import { el, fakeChrome, fakePage, obs, type FakePage } from "../fast/fakes.js";

export const KEY = "tsk-test-key-0123456789abcdef";
export const PROFILES: ProfileEntry[] = [{ directory: "Profile 14", name: "Parallelloop" }, { directory: "Profile 2", name: "BP" }];

/** The target key of `head` whose element string holds `label`. */
export function idx(questions: Questions, head: string, label: string): string {
  const q = questions[head] as ChoiceQuestion | undefined;
  for (const [key, v] of Object.entries(q?.criteria ?? {})) {
    if (typeof v === "object" && v !== null && String((v as { element?: string }).element ?? "").includes(label)) return key;
  }
  throw new Error(`no ${head} option for ${label}: ${Object.keys(q?.criteria ?? {}).join(",")}`);
}

export interface StepState { recent_actions: { action: string; kind: string; text: string | null }[] }
export type Decide = (q: Questions, state: StepState) => PartialAnswers;

export const gen = (label: string, conf = 0.8): Decide => (q) => ({ page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", label), confidence: 0.8 }, type_text_value: { choice: "generate", confidence: conf } });
export const clickOn = (label: string): Decide => (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", label), confidence: 0.9 } });
export const finish: Decide = () => ({ page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } });

/**
 * Jev for the reply flow. The step decision comes from the number of executed actions:
 * 0 -> generate for Reply, 1 -> generate for Subject, 2 -> click Send, then DONE.
 */
export function replyOracle(plan: PartialAnswers = { goal: "act" }, steps: Decide[] = [gen("Reply"), gen("Subject"), clickOn("Send"), finish]) {
  return fakeOracle((name, state, q) => {
    if (name === "plan") return plan;
    if (name !== "step") return {};
    const n = (state as StepState).recent_actions.length;
    return (steps[Math.min(n, steps.length - 1)] as Decide)(q, state as StepState);
  });
}

export const MAIL = "https://mail.example/t/1";

/** A fake reply page on a real BrowserSession: Subject and Reply in form 7, and Send. Send posts the texts and clears them. */
export function mailSession(log: Logger) {
  const state = { values: {} as Record<number, string>, sent: null as string | null, doc: 1_727_000_000_000.5 };
  const view = (): Observation => obs(MAIL, [
    el("e1", "fill", "Cc", "textbox", { value: state.values[1] ?? "", inputType: "email", form: 7 }),
    el("e2", "fill", "Subject", "textbox", { value: state.values[2] ?? "", inputType: "text", form: 7, maxLength: 120 }),
    el("e3", "fill", "Reply", "textbox", { value: state.values[3] ?? "", form: 7, multiline: true }),
    el("e4", "click", "Send", "button", { form: 7 }),
  ], `Meeting on Tuesday\nFrom: Ann Lee\nCan we meet on Tuesday at 10:00?${state.sent !== null ? `\nSent: ${state.sent}` : ""}`, { doc: state.doc, title: "Meeting" });
  const page: FakePage = fakePage({ pages: { m: view() }, start: "m" });
  page.observe = async () => { page.observes += 1; return view(); };
  page.url = async () => MAIL;
  const act = page.act.bind(page);
  page.act = async (a, o, text) => {
    await act(a, o, text);
    if (a.kind === "fill" && a.node !== null) state.values[a.node] = text ?? "";
    if (a.label === "Send") { state.sent = `${state.values[2] ?? ""} | ${state.values[3] ?? ""}`; state.values = {}; }
  };
  const launches: ChromeLaunchOptions[] = [];
  const chromes: Chrome[] = [];
  const session = new BrowserSession({
    env: {}, log,
    launch: async (o) => { launches.push(o); const c = fakeChrome(); chromes.push(c); return c; },
    open: async () => page,
  });
  return { state, page, session, launches, chromes };
}

/** A JevLink that never connects. The tests inject the oracle. */
export function fakeJev(key: string | null = KEY): JevLink & { warms: number } {
  const j = {
    warms: 0,
    client: () => { throw new Error("no Jev client in tests"); },
    warm: async () => { j.warms += 1; },
    key: () => key,
    close: async () => undefined,
  };
  return j as unknown as JevLink & { warms: number };
}

export interface ElicitParams { message: string; requestedSchema: unknown; mode?: string }
export type ElicitAnswer = { action: "accept"; content: Record<string, string | number | boolean | string[]> } | { action: "decline" } | { action: "cancel" };

/** Connect an in-memory client to a server built from `deps`. With `elicit`, the client declares form elicitation and answers with it. */
export async function connect(deps: Omit<ServerDeps, "runs"> & { runs: RunManager }, elicit?: (p: ElicitParams) => ElicitAnswer | Promise<ElicitAnswer>) {
  const server = buildServer(deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
  const dialogs: ElicitParams[] = [];
  if (elicit) {
    client.setRequestHandler("elicitation/create", async (req) => {
      const p = req.params as ElicitParams;
      dialogs.push(p);
      return elicit(p);
    });
  }
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server, dialogs, close: async () => { await client.close(); await server.close(); } };
}

// ---------------------------------------------------------------------------------------------------------------
// The scrape tools: page reads, a session whose page can read, and a fake scrape kit. No Chrome, no file, no model.

export const SHOP = "https://shop.example/s?q=eggs";

export function pageRead(over: Partial<PageRead> = {}): PageRead {
  return {
    version: 1, url: SHOP, title: "Eggs - Shop", meta: { headings: ["Search results"], selected: [], lang: "en" },
    tables: [], groups: [], text: [],
    stats: { ms: 5, tables_seen: 0, groups_seen: 0, nodes: 120, scroll_height: 2400, viewport_height: 800, truncated: false },
    ...over,
  };
}

/** A table with one header row. `rows` are the cells; a row can start a section with `section`. */
export function table(id: string, headers: string[], rows: string[][], over: Partial<TableRead> = {}): TableRead {
  return {
    id, kind: "html", caption: "", heading: "", headers, header_rows: 1, width: headers.length,
    rows: rows.map((cells) => ({ section: null, cells })), sections: [], row_count: rows.length, truncated: false, nested: false,
    signature: { kind: "table", headers: headers.map(normKey), width: headers.length, caption: "", heading: "" }, ...over,
  };
}

/** A product card: name, price, a struck MRP when given, and an ADD or Out of stock button. */
export function card(name: string, price: number, mrp: number | null = null, inStock = true): RecordRead {
  const slots: Slot[] = [
    { key: "div>div.name", text: name },
    { key: "div>div.price", text: `\u20b9${price}` },
    ...(mrp !== null ? [{ key: "div>div.mrp", text: `\u20b9${mrp}`, struck: true as const }] : []),
    { key: "div>button", text: inStock ? "ADD" : "Out of stock", button: true, ...(inStock ? {} : { disabled: true as const }) },
  ];
  return { slots, href: `https://shop.example/p/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` };
}

/** A record group of `records`; its slot infos and signature come from them. */
export function group(id: string, records: RecordRead[], over: Partial<RecordGroup> = {}): RecordGroup {
  const keys: string[] = [];
  for (const r of records) for (const s of r.slots) if (!keys.includes(s.key)) keys.push(s.key);
  const slots: SlotInfo[] = keys.map((key) => {
    const all = records.flatMap((r) => r.slots.filter((s) => s.key === key));
    return {
      key, filled: all.length, samples: [...new Set(all.map((s) => s.text))].slice(0, 3),
      struck: all.filter((s) => s.struck).length, button: all.filter((s) => s.button).length, heading: all.filter((s) => s.heading).length,
    };
  });
  return {
    id, shape: "div.card", testid: null, heading: "Results", count: records.length, records, slots, truncated: false,
    signature: { kind: "records", shape: "div.card", parent: "div.grid", testid: null, slot_keys: [...keys].sort() }, ...over,
  };
}

/** A shop page: a price table t1 and a card group g1. */
export function shopRead(over: Partial<PageRead> = {}): PageRead {
  return pageRead({
    tables: [table("t1", ["Zone", "Rate", "Average"], [["Hyderabad", "525", "535.00"], ["Pune", "560", "561.20"], ["Chennai", "540", "538.10"]], { heading: "Egg prices" })],
    groups: [group("g1", [card("Farm Eggs 6 pcs", 54, 60), card("Brown Eggs 12 pcs", 120), card("Duck Eggs 6 pcs", 150, 170, false)])],
    ...over,
  });
}

/**
 * A BrowserSession on fake Chrome whose page reads `read` (a value or a function). `open()` opens the session page as a
 * run would. `reads` records the options of each Page.read.
 */
export function readSession(read: PageRead | (() => PageRead), log: Logger = fakeLogger()) {
  const first = typeof read === "function" ? read() : read;
  const page = fakePage({ pages: { a: obs(first.url, []) }, start: "a" });
  const reads: (ReadOptions | undefined)[] = [];
  page.read = async (o?: ReadOptions) => { reads.push(o); return typeof read === "function" ? read() : read; };
  const launches: ChromeLaunchOptions[] = [];
  const session = new BrowserSession({ env: {}, log, launch: async (o) => { launches.push(o); return fakeChrome(); }, open: async () => page });
  const base = baseConfig({}, log);
  const open = async () => session.openPage(await session.chromeFor({ ...base, task: "x", headed: true })(undefined));
  return { session, page, reads, launches, base, open };
}

/** A small, literal parser for the fake kit: price and number read the first number; text squashes. */
function fakeParse(text: string | undefined, parser: unknown): RowValue {
  if (text === undefined) return null;
  if (parser === "price" || parser === "number") {
    const m = /[0-9][0-9,]*(?:\.[0-9]+)?/.exec(text);
    return m ? Number(m[0].replace(/,/g, "")) : null;
  }
  const t = text.replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
}

export interface FakeKit extends ScrapeKit {
  files: Map<string, ScraperSpec>;
  runs: { spec: ScraperSpec; opts: RunScraperOptions }[];
  loads: LoadOptions[];
  /** The result of the next run; default: ok with the rows of `rows`. */
  result: (spec: ScraperSpec, opts: RunScraperOptions) => Promise<ScrapeResult> | ScrapeResult;
}

/** A ScrapeResult of `rows`. */
export function scrapeResult(spec: ScraperSpec, rows: Row[], over: Partial<ScrapeResult> = {}): ScrapeResult {
  return {
    scraper: spec.name, version: spec.version, params: { ...spec.params }, url: spec.start_url, rows, row_count: rows.length, status: "ok",
    healed: null, reason: null, blocked: null, saved: null, stats: { duration_ms: 12, jev_requests: 0, llm_calls: 0, steps: spec.steps.length, scrolls: 0 }, ...over,
  };
}

/**
 * Fakes of the scrape-core functions with the contract's behaviour in small: the store is a map, extraction reads
 * columns by header and slots by key or parse pick, validation checks min_rows, and the recorder maps param values.
 */
export function fakeKit(): FakeKit {
  const files = new Map<string, ScraperSpec>();
  const runs: FakeKit["runs"] = [];
  const loads: LoadOptions[] = [];
  const path = (n: string): string => `/home/u/.config/jev-browser/scrapers/${n}.json`;
  const kit: FakeKit = {
    files, runs, loads,
    result: (spec) => scrapeResult(spec, [{ name: "Farm Eggs 6 pcs", price: 54 }]),
    store: {
      scraperPath: (n) => path(n),
      loadScraper: (n) => {
        const s = files.get(n);
        if (!s) throw Object.assign(new Error(`ENOENT: no such file ${path(n)}`), { code: "ENOENT" });
        return { spec: structuredClone(s), path: path(n) };
      },
      saveScraper: (spec, _env, opts) => {
        const s = parseScraper(spec);
        if (files.has(s.name) && !opts?.overwrite) throw new SpecError(`${path(s.name)} exists`);
        files.set(s.name, structuredClone(s));
        return opts?.path ?? path(s.name);
      },
      listScrapers: () => [...files.values()].map((s) => ({ name: s.name, path: path(s.name), version: s.version, task: s.task, updated_at: s.updated_at, heals: s.history.filter((h) => h.level === "L1" || h.level === "L2" || h.level === "L3").length })),
      deleteScraper: (n) => files.delete(n),
    },
    extract: {
      buildExtract: (draft, read) => {
        const t = read.tables.find((x) => x.id === draft.set);
        if (t) {
          for (const [name, f] of Object.entries(draft.fields)) {
            if (f.from === "slot" || f.from === "href") throw new SpecError(`fields.${name}: a ${f.from} field needs a record group`);
            if (f.from === "column" && !t.headers.some((h) => normKey(h) === normKey(f.header))) throw new SpecError(`fields.${name}: the table ${t.id} has no header "${f.header}"`);
          }
          return { source: "table", match: { headers: t.signature.headers }, fields: draft.fields as Record<string, TableField>, ...(draft.key ? { key: draft.key } : {}) };
        }
        const g = read.groups.find((x) => x.id === draft.set);
        if (g) return { source: "records", match: { shape: g.shape, slot_keys: g.signature.slot_keys }, fields: draft.fields as Record<string, RecordField>, ...(draft.key ? { key: draft.key } : {}) };
        throw new SpecError(`set: ${draft.set} is not a set of the read`);
      },
      extractRows: (read, x, ctx) => {
        const value = (f: TableField | RecordField): RowValue | undefined =>
          f.from === "param" ? ctx.params[f.name] ?? null : f.from === "const" ? f.value : f.from === "url" ? ctx.url ?? read.url : undefined;
        if (x.source === "table") {
          const t = read.tables.find((tt) => x.match.headers.every((h, i) => normKey(tt.headers[i] ?? "") === h));
          if (!t) return { rows: [], set: null, score: 0, problems: [`no table has the headers ${x.match.headers.join(", ")}`] };
          const rows = t.rows.map((r) => Object.fromEntries(Object.entries(x.fields).map(([n, f]): [string, RowValue] => {
            if (f.from === "column") return [n, fakeParse(r.cells[t.headers.findIndex((h) => normKey(h) === normKey(f.header))], f.parser)];
            if (f.from === "section") return [n, r.section];
            return [n, value(f) ?? null];
          })));
          return { rows, set: t.id, score: 1, problems: [] };
        }
        const g = read.groups.find((gg) => gg.shape === x.match.shape);
        if (!g) return { rows: [], set: null, score: 0, problems: [`no record group matches ${x.match.shape ?? ""}`] };
        const rows = g.records.map((rec) => Object.fromEntries(Object.entries(x.fields).map(([n, f]): [string, RowValue] => {
          if (f.from === "href") return [n, rec.href ?? null];
          if (f.from !== "slot") return [n, value(f) ?? null];
          for (const p of f.pick) {
            const s = p.by === "key" ? rec.slots.find((sl) => sl.key === p.key)
              : p.by === "parse" ? rec.slots.find((sl) => !sl.button && (p.struck === undefined || (sl.struck === true) === p.struck) && fakeParse(sl.text, p.parser) !== null)
              : p.by === "fact" ? rec.slots.find((sl) => (sl as unknown as Record<string, unknown>)[p.fact] !== undefined)
              : [...rec.slots].sort((a, b) => b.text.length - a.text.length)[0];
            if (s) return [n, fakeParse(s.text, f.parser ?? "text")];
          }
          return [n, null];
        })));
        return { rows, set: g.id, score: 1, problems: [] };
      },
      fingerprintOf: (x, read, _set, rows) => ({
        source: x.source, headers: x.source === "table" ? x.match.headers : [], slot_keys: x.source === "records" ? x.match.slot_keys ?? [] : [],
        fields: Object.fromEntries(Object.keys(x.fields).map((f) => [f, { type: "string" as const }])), keys: [], row_count: rows.length, url_path: new URL(read.url).pathname,
      }),
    },
    validate: {
      validateRows: (rows, v) => (rows.length >= v.min_rows ? { ok: true, problems: [] } : { ok: false, problems: [`${rows.length} rows < min_rows ${v.min_rows}`] }),
      defaultValidate: (rows) => ({ min_rows: Math.max(1, Math.floor(rows.length / 2)), required: [] }),
      mergeValidate: (base, d, fields) => ({ ...base, ...(d?.min_rows !== undefined ? { min_rows: d.min_rows } : {}), ...(d?.required ? { required: d.required.filter((f) => fields.includes(f)) } : {}) }),
    },
    record: {
      stepsFromRecords: (records, params) => {
        const param = (v: string): string => { const e = Object.entries(params).find(([, x]) => x === v); return e ? `{${e[0]}}` : v; };
        const steps: Step[] = [];
        const skipped: string[] = [];
        for (const r of records) {
          if (r.result !== "ok" || !r.target) { skipped.push(`step ${r.step}: ${r.action}`); continue; }
          const target = { role: r.target.role, name: param(r.target.name) };
          if (r.action === "fill") steps.push({ op: "fill", target, value: param(r.value ?? "") });
          else if (r.action === "click") steps.push({ op: "click", target });
          else skipped.push(`step ${r.step}: ${r.action}`);
        }
        return { steps, skipped };
      },
    },
    run: async (spec, opts) => {
      runs.push({ spec, opts });
      await opts.browser.page();
      return kit.result(spec, opts);
    },
    load: async (_page, opts) => { loads.push(opts); return { scrolls: 2, ms: 10, stable: true, height: 2400, nodes: 120, end: "stable" }; },
  };
  return kit;
}
