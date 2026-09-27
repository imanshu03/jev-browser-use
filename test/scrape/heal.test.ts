// navigate() (L2 and `jev-scrape new`) with a scripted FastRunner result, and the prefix rules of L2. No Chrome, no Jev.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunResult, StepRecord } from "../../src/types.js";

const runs: { result: RunResult; cfg?: unknown }[] = [];
vi.mock("../../src/fast/loop.js", () => ({
  FastRunner: class {
    constructor(private deps: { cfg: unknown }) {}
    async run(): Promise<RunResult> {
      const next = runs.shift();
      if (!next) throw new Error("no scripted run");
      next.cfg = this.deps.cfg;
      return next.result;
    }
  },
}));

const { minPrefix, navigate, prefixOrder } = await import("../../src/scrape/heal.js");
const { fakeHuman, fakeLogger, fakeOracle } = await import("../fakes.js");
const { el, obs } = await import("../fast/fakes.js");
const { fakeBrowser, readPage } = await import("./fakes.js");
type Step = import("../../src/scrape/spec.js").Step;

const URL = "https://www.e2necc.com/home/eggprice";
let n = 0;
function rec(action: StepRecord["action"], target: { role: string; name: string } | null, result: StepRecord["result"] = "ok"): StepRecord {
  n += 1;
  return {
    step: n, url: URL, title: "", page_kind: "task_page", page_kind_conf: 0.9, done_p: 0.2, operation: null, operation_conf: 0.9,
    target: target ? { ref: `e${n}`, role: target.role, name: target.name, under: "" } : null, target_conf: 0.9, runner_up: null,
    action, value: null, value_conf: null, risk: "navigational", path: "fast", gate: "ok", result, error: null, jev_requests: 1, duration_ms: 10,
  };
}
function result(outcome: RunResult["outcome"], steps: StepRecord[], kind: string | null = null): RunResult {
  return {
    version: 1, task: "t", outcome, reason: kind ? `${kind} reason` : "", confidence: null, goal: "act", answer: null, final_url: URL, final_title: "",
    profile: null, start: { url: URL, how: "flag", confidence: null }, steps,
    blocked: kind ? { kind: kind as never, hint: "hint", top: [], resume: { session: "s", url: URL } } : null, error: null,
    stats: { steps: steps.length, jev_requests: 0, input_tokens: 0, output_tokens: 0, duration_ms: 1, model: "m", pauses: 0, jev_ms: 0, browser_ms: 0, engine: "cdp" },
  };
}

// The NECC start page: two unlabelled selects that show the current month and year, and the submit button.
const START = obs(URL, [
  el("e2", "select", "01 \n 02 \n 09 → 01", "combobox", { node: 2, current_value: "09" }),
  el("e3", "select", "01 \n 02 \n 09 → 02", "combobox", { node: 2, current_value: "09" }),
  el("e4", "select", "2026 \n 2025 → 2025", "combobox", { node: 3, current_value: "2026" }),
  el("e5", "click", "Get Sheet", "button"),
]);

function args(over: Record<string, unknown> = {}) {
  const page = readPage({ pages: { start: START }, start: "start" });
  const oracle = fakeOracle(() => ({}));
  const nav = { oracle, human: fakeHuman({ interactive: false }), profiles: [{ directory: "Profile 14", name: "Parallelloop" }], base: {} as never };
  return {
    page, a: {
      task: "Show the NECC daily egg prices for {month} {year}", url: URL, urlTemplate: URL, params: { month: "09", year: "2026" }, profile: undefined,
      page, browser: fakeBrowser(page), nav, headed: false, log: fakeLogger(), ...over,
    },
  };
}

const GET: Step = { op: "click", target: { role: "button", name: "Get Sheet" } };
const MONTH: Step = { op: "select", target: { role: "combobox", name: "01 02 09" }, value: "{month}" };
const YEAR: Step = { op: "select", target: { role: "combobox", name: "2026 2025" }, value: "{year}" };

describe("navigate", () => {
  beforeEach(() => { runs.length = 0; });

  it("a run that stalls (loop_detected) is judged by the rows: the steps before the first repeat, after the select steps", async () => {
    runs.push({ result: result("blocked", [rec("click", { role: "button", name: "Get Sheet" }), rec("none", null, "skipped"), rec("click", { role: "button", name: "Get Sheet" }), rec("click", { role: "button", name: "Print Sheet" })], "loop_detected") });
    const { page, a } = args();
    const r = await navigate(a);
    expect(r).toMatchObject({ status: "done", stalled: true, steps: [MONTH, YEAR, GET] });
    // The start page was opened and observed before Jev ran.
    expect(page.calls[0]).toMatchObject({ op: "navigate" });
    expect(page.observes).toBeGreaterThanOrEqual(1);
  });
  it("a done run keeps all of its steps; a param that a step uses gets no select step", async () => {
    runs.push({ result: result("done", [{ ...rec("select", { role: "combobox", name: "01 02 09 → 08" }), value: "08" }, rec("click", { role: "button", name: "Get Sheet" })]) });
    const { a } = args({ params: { month: "08", year: "2026" } });
    const r = await navigate(a);
    expect(r).toMatchObject({ status: "done", steps: [YEAR, { op: "select", target: { role: "combobox", name: "01 02 09" }, value: "{month}" }, GET] });
    expect(r).not.toHaveProperty("stalled");
  });
  it("a done run keeps a step that repeats: only a stall cuts at the first repeat", async () => {
    const next = (): ReturnType<typeof rec> => rec("click", { role: "button", name: "Next page" });
    runs.push({ result: result("done", [next(), next()]) });
    const { a } = args({ params: {}, task: "Show the NECC daily egg prices" });
    const r = await navigate(a);
    expect(r).toMatchObject({ status: "done", steps: [{ op: "click", target: { role: "button", name: "Next page" } }, { op: "click", target: { role: "button", name: "Next page" } }] });
  });
  it("a param that the start URL template uses gets no select step", async () => {
    runs.push({ result: result("done", [rec("click", { role: "button", name: "Get Sheet" })]) });
    const { a } = args({ urlTemplate: `${URL}?m={month}` });
    const r = await navigate(a);
    expect(r).toMatchObject({ status: "done", steps: [YEAR, GET] });
  });
  it("a run that blocks for another reason fails, with its steps for the prefix test", async () => {
    runs.push({ result: result("blocked", [rec("click", { role: "button", name: "Get Sheet" }), rec("click", { role: "link", name: "Home Page" })], "ambiguous") });
    const { a } = args();
    const r = await navigate(a);
    expect(r).toMatchObject({ status: "failed", reason: "jev blocked: ambiguous reason", steps: [MONTH, YEAR, GET, { op: "click", target: { role: "link", name: "Home Page" } }] });
  });
  it("a sign-in wall or a captcha is blocked; a stall with no action that ran is a failure", async () => {
    runs.push({ result: result("blocked", [], "needs_sign_in") }, { result: result("blocked", [], "captcha") }, { result: result("blocked", [rec("none", null, "skipped")], "loop_detected") });
    const { a } = args();
    expect(await navigate(a)).toMatchObject({ status: "blocked", wall: "sign_in" });
    expect(await navigate(a)).toMatchObject({ status: "blocked", wall: "captcha" });
    expect(await navigate(a)).toMatchObject({ status: "failed" });
  });
  it("with no url or no params, the start page is not opened before the run", async () => {
    runs.push({ result: result("done", []) }, { result: result("done", []) });
    const noUrl = args({ url: null });
    await navigate(noUrl.a);
    expect(noUrl.page.calls).toEqual([]);
    const noParams = args({ params: {}, task: "Show the NECC daily egg prices" });
    await navigate(noParams.a);
    expect(noParams.page.calls).toEqual([]);
  });
});

describe("minPrefix and prefixOrder", () => {
  const LINK: Step = { op: "click", target: { role: "link", name: "Search" } };
  const FILL: Step = { op: "fill", target: { role: "textbox", name: "Search for atta dal" }, value: "{query}" };
  const LOGO: Step = { op: "click", target: { role: "link", name: "link" } };
  it("minPrefix holds every step that uses a param; null when a param has no step, or when there is no param", () => {
    expect(minPrefix([LINK, FILL, LOGO], ["query"])).toBe(2);
    expect(minPrefix([MONTH, YEAR, GET], ["month", "year"])).toBe(2);
    expect(minPrefix([LINK, LOGO], ["query"])).toBeNull();
    expect(minPrefix([LINK, LOGO], [])).toBeNull();
    expect(minPrefix([], [])).toBeNull();
    expect(prefixOrder([LINK, FILL, LOGO, GET], [], 6)).toEqual([]);
  });
  it("prefixOrder tries the submit after the last param step first, then without it, then the longer prefixes", () => {
    expect(prefixOrder([MONTH, YEAR, GET, LOGO], ["month", "year"], 6)).toEqual([3, 2, 4]);
    expect(prefixOrder([LINK, FILL, LOGO], ["query"], 6)).toEqual([3, 2]);
    expect(prefixOrder([LINK, FILL, { op: "scroll", times: 1 }, LOGO], ["query"], 6)).toEqual([2, 3, 4]);
    expect(prefixOrder([LINK, FILL, LOGO], ["query"], 1)).toEqual([3]);
    expect(prefixOrder([LINK, LOGO], ["query"], 6)).toEqual([]);
  });
});
