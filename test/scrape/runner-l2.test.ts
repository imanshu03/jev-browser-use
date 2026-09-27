// runScraper L2 with a scripted FastRunner result: a Jev run that stalls or fails, the page that it leaves, the prefix
// trials, and the page that L3 reads after them. No Chrome, no Jev.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Observation } from "../../src/fast/model.js";
import type { PageRead, TableRead } from "../../src/fast/read-types.js";
import type { RunResult, StepRecord } from "../../src/types.js";

const runs: { result: RunResult; end?: string }[] = [];
vi.mock("../../src/fast/loop.js", () => ({
  FastRunner: class {
    constructor(private deps: { page: { current: string } }) {}
    async run(): Promise<RunResult> {
      const next = runs.shift();
      if (!next) throw new Error("no scripted run");
      // The page as Jev left it.
      if (next.end) this.deps.page.current = next.end;
      return next.result;
    }
  },
}));

const { buildExtract, extractRows, fingerprintOf } = await import("../../src/scrape/extract.js");
const { PREFIX_WAIT_MS, READ_POLL_MS, runScraper } = await import("../../src/scrape/runner.js");
const { parseDraft, parseScraper } = await import("../../src/scrape/spec.js");
const { fakeHuman, fakeLogger, fakeOracle } = await import("../fakes.js");
const { el, obs } = await import("../fast/fakes.js");
const { clone, contextOf, emptyRead, fakeBrowser, fakeLlm, loadRead, readPage } = await import("./fakes.js");
type ScraperSpec = import("../../src/scrape/spec.js").ScraperSpec;
type RunScraperOptions = import("../../src/scrape/runner.js").RunScraperOptions;

let n = 0;
function rec(action: StepRecord["action"], target: { role: string; name: string } | null, value: string | null = null): StepRecord {
  n += 1;
  return {
    step: n, url: "", title: "", page_kind: "task_page", page_kind_conf: 0.9, done_p: 0.2, operation: null, operation_conf: 0.9,
    target: target ? { ref: `e${n}`, role: target.role, name: target.name, under: "" } : null, target_conf: 0.9, runner_up: null,
    action, value, value_conf: null, risk: "navigational", path: "fast", gate: "ok", result: "ok", error: null, jev_requests: 1, duration_ms: 10,
  };
}
function result(outcome: RunResult["outcome"], steps: StepRecord[], kind: string, url: string): RunResult {
  return {
    version: 1, task: "t", outcome, reason: `${kind} reason`, confidence: null, goal: "act", answer: null, final_url: url, final_title: "",
    profile: null, start: { url, how: "flag", confidence: null }, steps,
    blocked: { kind: kind as never, hint: "hint", top: [], resume: { session: "s", url } }, error: null,
    stats: { steps: steps.length, jev_requests: 0, input_tokens: 0, output_tokens: 0, duration_ms: 1, model: "m", pauses: 0, jev_ms: 0, browser_ms: 0, engine: "cdp" },
  };
}

function clock() {
  let t = Date.parse("2026-09-27T08:00:00Z");
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}
function navigator() {
  return { oracle: fakeOracle(() => ({})), human: fakeHuman({ interactive: false }), profiles: [{ directory: "Profile 14", name: "Parallelloop" }], base: {} as never };
}
function run(spec: ScraperSpec, page: ReturnType<typeof readPage>, over: Partial<RunScraperOptions> = {}) {
  const saved: ScraperSpec[] = [];
  const c = clock();
  const opts: RunScraperOptions = {
    heal: "full", browser: fakeBrowser(page), headed: false, log: fakeLogger(), now: c.now, sleep: c.sleep, stepTimeoutMs: 1000, navigator: navigator(),
    save: (s) => { saved.push(s); return "/tmp/scrapers/x.json"; }, ...over,
  };
  return { saved, result: runScraper(spec, opts) };
}

// ---------------------------------------------------------------------------------------------------------------
// NECC: a form that always shows a table. The default month shows until "Show Sheet" is clicked.

const NECC_URL = "https://www.e2necc.com/home/eggprice";
const MONTHS = "01 02 08 09";
function sheet(month: string, rates: string[]): PageRead {
  const headers = ["Name Of Zone / Day", "1", "2"];
  const t: TableRead = {
    id: "t1", kind: "html", caption: "", heading: "Daily egg prices", headers, header_rows: 1, width: 3,
    rows: [{ section: null, cells: ["Hyderabad", rates[0] ?? "", rates[1] ?? ""] }, { section: null, cells: ["Pune", rates[2] ?? "", rates[3] ?? ""] }],
    sections: [], row_count: 2, truncated: false, nested: false,
    signature: { kind: "table", headers: headers.map((h) => h.toLowerCase()), width: 3, caption: "", heading: "daily egg prices" },
  };
  // The month select's value is a form value of the page: it changes with the select, before the submit.
  return { ...emptyRead(NECC_URL), tables: [t], meta: { headings: [], selected: [{ kind: "select", name: "ddlMonth", label: "", value: month, text: month }], lang: "" } };
}
const SEPT = (m = "09"): PageRead => sheet(m, ["525", "530", "540", "545"]);
const AUG = (): PageRead => sheet("08", ["500", "505", "510", "515"]);
const neccExtract = buildExtract(parseDraft({
  set: "t1", fields: { zone: { from: "column", header: "Name Of Zone / Day" }, month: { from: "meta", key: "ddlMonth" } },
  melt: { name_field: "day", value_field: "rate", value_parser: "number" },
}), SEPT());
function neccSpec(): ScraperSpec {
  return parseScraper({
    kind: "jev-scraper", format: 1, name: "necc", version: 1, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
    task: "Show the NECC daily egg prices for month {month}", want: "zone, day, rate", params: { month: "09" },
    start_url: NECC_URL,
    steps: [{ op: "select", target: { role: "combobox", name: MONTHS }, value: "{month}" }, { op: "click", target: { role: "button", name: "Get Sheet" } }],
    load: { mode: "none" }, extract: neccExtract, validate: { min_rows: 4, required: ["zone", "rate"] },
    fingerprint: fingerprintOf(neccExtract, SEPT(), "t1", extractRows(SEPT(), neccExtract, { params: {} }).rows),
    history: [{ at: "2026-09-01T00:00:00.000Z", level: "author", reason: "jev-scrape new", from_version: 0, previous: null }],
  });
}
/** The NECC page after a release: the submit is now "Show Sheet". The month select shows `m`. */
function neccForm(m: string): Observation {
  return obs(NECC_URL, [
    ...MONTHS.split(" ").filter((o) => o !== m).map((o) => el(`m${o}`, "select", `${MONTHS} → ${o}`, "combobox", { node: 2, current_value: m })),
    el("e9", "click", "Show Sheet", "button"),
  ], "NECC egg prices");
}
function neccPage() {
  return readPage({
    pages: { blank: obs("about:blank", [], ""), form09: neccForm("09"), form08: neccForm("08"), sheet08: neccForm("08") }, start: "blank",
    transitions: (c, cur) => {
      if (c.op === "navigate") return "form09";
      if (c.op === "act" && c.id === "m08") return "form08";
      if (cur === "form08" && c.op === "act" && c.id === "e9") return "sheet08";
      return undefined;
    },
    reads: { form09: () => SEPT(), form08: () => SEPT("08"), sheet08: AUG },
  });
}
const SELECT_08 = (): StepRecord => ({ ...rec("select", { role: "combobox", name: `${MONTHS} → 08` }), value: "08" });

describe("runScraper L2: a Jev run that stalls", () => {
  beforeEach(() => { runs.length = 0; });

  it("a stall after the select, before the submit: the form shows the default month, so the steps are no proof", async () => {
    runs.push({ result: result("blocked", [SELECT_08(), SELECT_08()], "loop_detected", NECC_URL), end: "form08" });
    const page = neccPage();
    const t = run(neccSpec(), page, { params: { month: "08" }, llm: fakeLlm([]) });
    const r = await t.result;
    expect(r.status).toBe("failed");
    expect(t.saved).toEqual([]);
  });
  it("a stall after the submit: the kept steps replay to the month of the param, and they are the new path", async () => {
    const show = (): StepRecord => rec("click", { role: "button", name: "Show Sheet" });
    runs.push({ result: result("blocked", [SELECT_08(), show(), show()], "loop_detected", NECC_URL), end: "sheet08" });
    const page = neccPage();
    const t = run(neccSpec(), page, { params: { month: "08" } });
    const r = await t.result;
    expect(r).toMatchObject({ status: "ok", healed: { level: "L2" } });
    expect(r.rows[0]).toMatchObject({ zone: "Hyderabad", day: "1", rate: 500, month: "08" });
    const next = t.saved[0] as ScraperSpec;
    expect(next.steps).toEqual([
      { op: "select", target: { role: "combobox", name: MONTHS }, value: "{month}" },
      { op: "click", target: { role: "button", name: "Show Sheet" } },
    ]);
    // The saved version runs with no heal.
    const again = await run(next, neccPage(), { params: { month: "08" }, heal: "none" }).result;
    expect(again).toMatchObject({ status: "ok", healed: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A shop search whose button is gone: typing shows suggestions; only a click on a suggestion opens the results.

const HOME_URL = "https://shop.example/";
const RES_URL = "https://shop.example/s?q=eggs";
const HELP_URL = "https://shop.example/help";
const READ = (): PageRead => ({ ...clone(loadRead("blinkit")), url: RES_URL });
const shopExtract = buildExtract(parseDraft({
  set: "g2",
  fields: {
    name: { from: "slot", pick: [{ by: "key", key: "div.tw-text-300" }] },
    price: { from: "slot", pick: [{ by: "key", key: "div.tw-flex@2>div>div.tw-text-200" }], parser: "price" },
  },
}), READ());
function shopSpec(over: Record<string, unknown> = {}): ScraperSpec {
  return parseScraper({
    kind: "jev-scraper", format: 1, name: "shop", version: 1, created_at: "2026-09-26T00:00:00.000Z", updated_at: "2026-09-26T00:00:00.000Z",
    task: "search the shop for {query}", want: "name and price of each product", params: { query: "eggs" }, start_url: HOME_URL,
    steps: [{ op: "fill", target: { role: "searchbox", name: "Search products" }, value: "{query}" }, { op: "click", target: { role: "button", name: "Search" } }],
    load: { mode: "none" }, extract: shopExtract, validate: { min_rows: 3, required: ["name", "price"] },
    fingerprint: fingerprintOf(shopExtract, READ(), "g2", extractRows(READ(), shopExtract, { params: {} }).rows),
    history: [{ at: "2026-09-26T00:00:00.000Z", level: "author", reason: "jev-scrape new", from_version: 0, previous: null }],
    ...over,
  });
}
/** The renamed read: a site release with new class names (L1 maps the fields again). */
function renamedRead(): PageRead {
  const r = READ();
  const g = r.groups[1];
  if (!g) throw new Error("no g2");
  const ren = (k: string): string => k.replace(/tw-/g, "qx-");
  for (const x of g.records) for (const s of x.slots) s.key = ren(s.key);
  for (const s of g.slots) s.key = ren(s.key);
  g.signature.slot_keys = g.signature.slot_keys.map(ren);
  return r;
}

describe("runScraper L2: the steps of a stalled run are replayed before a save", () => {
  beforeEach(() => { runs.length = 0; });

  it("Jev reached the rows only after the repeat: the kept steps do not reach them, so nothing is saved", async () => {
    const page = readPage({
      pages: {
        blank: obs("about:blank", [], ""), home: obs(HOME_URL, [el("e1", "fill", "Search products", "searchbox", { value: "" })], "Shop home"),
        suggest: obs(HOME_URL, [el("e1", "fill", "Search products", "searchbox", { value: "eggs" }), el("e5", "click", "eggs in Dairy", "option")], "Suggestions"),
        results: obs(RES_URL, [], "Results"),
      },
      start: "blank",
      transitions: (c, cur) => (c.op === "navigate" ? "home" : c.op === "act" && c.id === "e1" && c.text ? "suggest" : cur === "suggest" && c.op === "act" && c.id === "e5" ? "results" : undefined),
      reads: { results: READ },
    });
    const enter = (): StepRecord => ({ ...rec("press_key", null), value: "Enter" });
    runs.push({ result: result("blocked", [{ ...rec("fill", { role: "searchbox", name: "Search products" }), value: "eggs" }, enter(), enter(), rec("click", { role: "option", name: "eggs in Dairy" })], "loop_detected", HOME_URL), end: "results" });
    const t = run(shopSpec(), page);
    const r = await t.result;
    expect(r.status).toBe("failed");
    expect(t.saved).toEqual([]);
  });
});

describe("runScraper L2: prefix trials and the page of L3", () => {
  beforeEach(() => { runs.length = 0; });

  /** The shop with the button renamed to "Find"; `results` is the read of the results page. */
  function findPage(results: () => PageRead = READ) {
    return readPage({
      pages: {
        blank: obs("about:blank", [], ""),
        home: obs(HOME_URL, [el("e1", "fill", "Search products", "searchbox", { value: "" }), el("e2", "click", "Find", "button")], "Shop home"),
        results: obs(RES_URL, [el("e7", "click", "Help", "link")], "Results"), help: obs(HELP_URL, [], "Help"),
      },
      start: "blank",
      transitions: (c, cur) => (c.op === "navigate" ? "home" : cur === "home" && c.op === "act" && c.id === "e2" ? "results" : cur === "results" && c.op === "act" && c.id === "e7" ? "help" : undefined),
      reads: { results },
    });
  }
  const FAILED = (end: string) => ({
    result: result("blocked", [{ ...rec("fill", { role: "searchbox", name: "Search products" }), value: "eggs" }, rec("click", { role: "button", name: "Find" }), rec("click", { role: "link", name: "Help" })], "impossible", HOME_URL),
    end,
  });

  it("a prefix whose page needs L1 (new class names) heals at L2 with the re-anchored extract", async () => {
    runs.push(FAILED("help"));
    const t = run(shopSpec(), findPage(renamedRead));
    const r = await t.result;
    expect(r).toMatchObject({ status: "ok", healed: { level: "L2" } });
    const next = t.saved[0] as ScraperSpec;
    expect(next.steps).toEqual([{ op: "fill", target: { role: "searchbox", name: "Search products" }, value: "{query}" }, { op: "click", target: { role: "button", name: "Find" } }]);
    expect(next.fingerprint.slot_keys.every((k) => k.includes("qx-"))).toBe(true);
  });
  it("a task param that the start URL uses needs no step: the trial runs for the other params", async () => {
    runs.push(FAILED("help"));
    const spec = shopSpec({ task: "search the shop for {query} in {city}", params: { query: "eggs", city: "pune" }, start_url: `${HOME_URL}?city={city}` });
    const page = findPage();
    const t = run(spec, page);
    const r = await t.result;
    expect(r).toMatchObject({ status: "ok", healed: { level: "L2" } });
    expect(page.calls.filter((c) => c.op === "navigate").map((c) => c.url)).toContain("https://shop.example/?city=pune");
  });
  it("after a failed Jev run that left the page of the rows, L3 reads the page that the old steps reach again", async () => {
    // The old steps reach the results, but a new layout (a table) fails the old extract; Jev ends on the help page.
    const table = (): PageRead => {
      const r = READ();
      r.groups = [];
      const headers = ["Product", "Price"];
      r.tables = [{
        id: "t1", kind: "html", caption: "", heading: "Results", headers, header_rows: 1, width: 2, rows: [["Eggs", "₹90"], ["Milk", "₹72"], ["Bread", "₹45"]].map((cells) => ({ section: null, cells })),
        sections: [], row_count: 3, truncated: false, nested: false, signature: { kind: "table", headers: ["product", "price"], width: 2, caption: "", heading: "results" },
      }];
      return r;
    };
    const page = readPage({
      pages: {
        blank: obs("about:blank", [], ""),
        home: obs(HOME_URL, [el("e1", "fill", "Search products", "searchbox", { value: "" }), el("e2", "click", "Search", "button")], "Shop home"),
        results: obs(RES_URL, [el("e7", "click", "Help", "link")], "Results"), help: obs(HELP_URL, [], "Help"),
      },
      start: "blank",
      transitions: (c, cur) => (c.op === "navigate" ? "home" : cur === "home" && c.op === "act" && c.id === "e2" ? "results" : cur === "results" && c.op === "act" && c.id === "e7" ? "help" : undefined),
      reads: { results: table },
    });
    // Jev clicks Help and gives up: no step uses {query}, so there is no prefix trial.
    runs.push({ result: result("blocked", [rec("click", { role: "link", name: "Help" })], "impossible", HOME_URL), end: "help" });
    const draft = JSON.stringify({ set: "t1", fields: { name: { from: "column", header: "Product" }, price: { from: "column", header: "Price", parser: "price" } } });
    const llm = fakeLlm([(req) => { expect(contextOf(req.user).tables.map((x) => x.id)).toEqual(["t1"]); return draft; }]);
    const t = run(shopSpec(), page, { llm });
    const r = await t.result;
    expect(r).toMatchObject({ status: "ok", healed: { level: "L3" }, url: RES_URL });
    expect(llm.calls).toHaveLength(1);
  });
  it("a prefix trial waits at most PREFIX_WAIT_MS for the rows, not the step timeout", async () => {
    // The results page never shows the rows; the step timeout is 8 s.
    runs.push(FAILED("help"));
    const page = findPage(() => emptyRead(RES_URL));
    const c = clock();
    const t0 = c.now();
    const reads: number[] = [];
    const orig = page.read?.bind(page);
    page.read = async (o) => { reads.push(c.now() - t0); return (orig as NonNullable<typeof orig>)(o); };
    const r = await runScraper(shopSpec(), {
      heal: "full", browser: fakeBrowser(page), headed: false, log: fakeLogger(), now: c.now, sleep: c.sleep, stepTimeoutMs: 8000, navigator: navigator(), save: () => "x",
    });
    expect(r.status).toBe("failed");
    // Page loads: the plain replay, the start page before Jev, the start page with no step, then one per trial.
    const trials = page.calls.filter((x) => x.op === "navigate").length - 3;
    expect(trials).toBe(3);
    // One read of the start page, then each trial reads every READ_POLL_MS until PREFIX_WAIT_MS, not until 8 s.
    expect(reads.length - 1).toBeLessThanOrEqual(trials * (PREFIX_WAIT_MS / READ_POLL_MS + 1));
  });
});
