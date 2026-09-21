import type { ChoiceQuestion, Questions } from "@typesafe-ai/sdk";
import { TypeSafeError } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { FastRunner, actionKey, riskOf } from "../../src/fast/loop.js";
import type { FastRunnerDeps } from "../../src/fast/loop.js";
import type { Observation, Page } from "../../src/fast/model.js";
import { StalePage } from "../../src/fast/model.js";
import type { RunConfig } from "../../src/types.js";
import { GATES, LIMITS } from "../../src/types.js";
import { fakeHuman, fakeLogger, fakeOracle, type OracleScript, type PartialAnswers } from "../fakes.js";
import { el, fakeChrome, fakePage, obs, scrollDown, waitAction, type PageScript } from "./fakes.js";

const PROFILES = [{ directory: "Profile 14", name: "Parallelloop" }, { directory: "Profile 2", name: "BP" }];
const HOME = obs("https://www.wikipedia.org/", [el("e1", "fill", "Search Wikipedia", "searchbox", { value: "" }), el("e2", "click", "English", "link"), el("e3", "click", "Search", "button")], "Wikipedia\nThe Free Encyclopedia");
const ARTICLE = obs("https://en.wikipedia.org/wiki/Alan_Turing", [el("e1", "click", "Main menu", "button"), scrollDown()], "Alan Turing\nAlan Turing was a mathematician.\nBorn 23 June 1912");
const LOGIN = obs("https://app.example/login", [el("e1", "fill", "Email", "textbox", { value: "" }), el("e2", "fill", "Password", "textbox", { value: "" }), el("e3", "click", "Sign in", "button")], "Sign in to continue");
const DASH = obs("https://app.example/dash", [el("e1", "click", "Licious Sept3 Session", "button"), el("e2", "click", "Home", "link"), el("e3", "click", "Delete project", "button")], "Dashboard\nLicious Sept3 Session");

function cfg(task: string, over: Partial<RunConfig> = {}): RunConfig {
  return {
    task, headed: false, maxSteps: 8, stepTimeoutMs: 1000, runTimeoutMs: 60_000, pauseTimeoutMs: 1000, confirm: "auto", dryRun: false, session: "jev-test",
    model: "m", logLevel: "info", logJson: false, keepOpen: false, agentBrowserBin: "ab", vars: {}, profile: "none", goal: "act", engine: "cdp", refreshProfile: false, ...over,
  };
}

/** The target key whose element string carries `label`. */
function idx(questions: Questions, head: string, label: string): string {
  const q = questions[head] as ChoiceQuestion | undefined;
  for (const [key, v] of Object.entries(q?.criteria ?? {})) {
    if (typeof v === "object" && v !== null && String((v as { element?: string }).element ?? "").includes(label)) return key;
  }
  throw new Error(`no ${head} option for ${label}: ${Object.keys(q?.criteria ?? {}).join(",")}`);
}

/** Answers per page url for `step` requests; other request names read from `other`. */
const byUrl = (map: Record<string, PartialAnswers | ((q: Questions, state: unknown) => PartialAnswers)>, other: Record<string, PartialAnswers> = {}) =>
  (name: string, state: unknown, q: Questions): PartialAnswers => {
    if (name === "step") {
      const url = (state as { page: { url: string } }).page.url;
      const a = map[url];
      return typeof a === "function" ? a(q, state) : a ?? {};
    }
    return other[name] ?? {};
  };

function setup(task: string, script: PageScript, oracle: OracleScript, over: Partial<RunConfig> = {}, opts: { human?: ReturnType<typeof fakeHuman>; providePage?: boolean; now?: () => number; chromeFails?: Error; warm?: () => Promise<void> } = {}) {
  const page = fakePage(script);
  const chrome = fakeChrome();
  const o = fakeOracle(oracle);
  const log = fakeLogger();
  const human = opts.human ?? fakeHuman({ interactive: false });
  let launches = 0;
  let opened = 0;
  const deps: FastRunnerDeps = {
    cfg: cfg(task, over), profiles: PROFILES,
    chrome: async () => { launches += 1; if (opts.chromeFails) throw opts.chromeFails; return chrome; },
    openPage: async () => { opened += 1; return page; },
    oracle: o, human, log, sleep: async () => undefined, ...(opts.now ? { now: opts.now } : {}), ...(opts.providePage ? { page } : {}), ...(opts.warm ? { warm: opts.warm } : {}),
  };
  const runner = new FastRunner(deps);
  return { runner, page, chrome, oracle: o, log, human, counts: () => ({ launches, opened }) };
}

const stepStates = (t: { oracle: { requests: { name: string; state: unknown }[] } }) => t.oracle.requests.filter((r) => r.name === "step").map((r) => r.state as { recent_actions: { action: string; kind: string; text: string | null; page_changed: boolean | null }[] });

describe("FastRunner happy paths", () => {
  it.each(["cdp", "chromium"] as const)("reports %s for a completed task", async (engine) => {
    const t = setup("open https://en.wikipedia.org/wiki/Alan_Turing", { pages: { a: ARTICLE }, start: "a" },
      byUrl({ [ARTICLE.url]: { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9 } } }), { engine });
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(r.stats.engine).toBe(engine);
  });
  it("act: click then DONE at 0.9 -> done in 2 steps with one request per step; chrome closed", async () => {
    const t = setup("open wikipedia.org and click English", { pages: { home: HOME, article: ARTICLE }, start: "home", transitions: (c) => (c.op === "act" && c.id === "e2" ? "article" : undefined) },
      byUrl({
        [HOME.url]: (q) => ({ page_kind: "task_page", operation: { choice: "CLICK", confidence: 0.8, probabilities: { CLICK: 0.8, DONE: 0.1, WAIT: 0.1 } }, click_target: { choice: idx(q, "click_target", "English"), confidence: 0.7 } }),
        [ARTICLE.url]: { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, CLICK: 0.05, WAIT: 0.05 } } },
      }));
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(r.confidence).toBe(0.9);
    expect(r.steps).toHaveLength(2);
    expect(t.oracle.requests.map((x) => x.name)).toEqual(["step", "step"]);
    expect(r.steps[0]).toMatchObject({ step: 1, operation: "CLICK", action: "click", target: { ref: "e2", role: "link", name: "English", under: "" }, target_conf: 0.7, risk: "navigational", path: "fast", result: "ok", jev_requests: 1 });
    expect(r.steps[1]).toMatchObject({ step: 2, operation: "DONE", action: "none", done_p: 0.9, result: "done", jev_requests: 1 });
    expect(t.page.calls).toEqual([{ op: "navigate", url: "https://wikipedia.org" }, { op: "act", id: "e2", kind: "click" }]);
    expect(t.page.observes).toBe(2);
    expect(stepStates(t)[1]?.recent_actions).toEqual([{ action: "English", kind: "click", text: null, page_changed: true }]);
    expect(r.final_url).toBe(ARTICLE.url);
    expect(r.final_title).toBe("T");
    expect(r.start).toEqual({ url: "https://wikipedia.org", how: "task_url", confidence: null });
    expect(t.chrome.closes).toBe(1);
    expect(r.stats).toMatchObject({ steps: 2, jev_requests: 2, engine: "cdp", jev_ms: 14, pauses: 0 });
    expect(r.stats.browser_ms).toBeGreaterThan(0);
  });
  it("act: DONE below the gate bans DONE for two steps, then scroll and DONE again succeed", async () => {
    let n = 0;
    const t = setup("open https://en.wikipedia.org/wiki/Alan_Turing and read", { pages: { a: ARTICLE }, start: "a" },
      byUrl({ [ARTICLE.url]: (q) => { n += 1; const ops = Object.keys((q["operation"] as ChoiceQuestion).criteria); if (ops.includes("DONE")) return { operation: { choice: "DONE", confidence: n === 1 ? 0.3 : 0.8, probabilities: { DONE: n === 1 ? 0.3 : 0.8, SCROLL_DOWN: n === 1 ? 0.7 : 0.2 } } }; return { operation: "SCROLL_DOWN" }; } }));
    const r = await t.runner.run();
    expect(r.steps.map((s) => `${s.action}:${s.result}`)).toEqual(["none:skipped", "scroll_down:ok", "scroll_down:ok", "none:done"]);
    expect(r.steps[0]?.gate).toBe("done_low");
    expect(r.outcome).toBe("done");
  });
  it("TYPE_TEXT with a span fills that text and history shows it; PRESS_ENTER submits", async () => {
    const t = setup("open wikipedia.org and search for Alan Turing", { pages: { home: HOME, article: ARTICLE }, start: "home", transitions: (c) => (c.op === "press" ? "article" : undefined) },
      byUrl({
        [HOME.url]: (q, state) => {
          const typed = (state as { recent_actions: unknown[] }).recent_actions.length > 0;
          if (typed) return { page_kind: "task_page", operation: "PRESS_ENTER" };
          return { page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", "Search Wikipedia"), confidence: 0.8 }, type_text_value: { choice: "s1", confidence: 0.9 } };
        },
        [ARTICLE.url]: { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } },
      }));
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(t.page.calls).toContainEqual({ op: "act", id: "e1", kind: "fill", text: "Alan Turing" });
    expect(t.page.calls).toContainEqual({ op: "press", key: "Enter" });
    expect(r.steps[0]).toMatchObject({ operation: "TYPE_TEXT", action: "fill", value: "Alan Turing", value_conf: 0.9, risk: "data_entry", result: "ok" });
    expect(r.steps[1]).toMatchObject({ operation: "PRESS_KEY", action: "press_key", value: "Enter", result: "ok" });
    expect(stepStates(t)[1]?.recent_actions).toEqual([{ action: "Search Wikipedia", kind: "fill", text: "Alan Turing", page_changed: false }]);
    expect(stepStates(t)[2]?.recent_actions[1]).toEqual({ action: "PRESS_ENTER", kind: "key", text: null, page_changed: true });
  });
  it("secret var: typed in clear, history and StepRecord show <secret>, the request never holds the value", async () => {
    const t = setup("open https://app.example/login and sign in", { pages: { login: LOGIN, dash: DASH }, start: "login", transitions: (c) => (c.op === "act" && c.id === "e2" ? "dash" : undefined) },
      byUrl({
        [LOGIN.url]: (q) => ({ page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", "Password"), confidence: 0.8 }, type_text_value: { choice: "v_password", confidence: 0.9 } }),
        [DASH.url]: { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } },
      }), { vars: { password: "hunter2" } });
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(t.page.calls).toContainEqual({ op: "act", id: "e2", kind: "fill", text: "hunter2" });
    expect(r.steps[0]?.value).toBe("<secret>");
    expect(stepStates(t)[1]?.recent_actions[0]).toMatchObject({ kind: "fill", text: "<secret>" });
    expect(JSON.stringify(t.oracle.requests)).not.toContain("hunter2");
    expect(JSON.stringify(r)).not.toContain("hunter2");
    expect(t.log.lines.join("\n")).not.toContain("hunter2");
  });
  it("TYPE_TEXT with value none -> blocked needs_credential with the --var hint", async () => {
    const t = setup("open https://app.example/login and sign in", { pages: { login: LOGIN }, start: "login" },
      byUrl({ [LOGIN.url]: (q) => ({ page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", "Password"), confidence: 0.8 }, type_text_value: "none" }) }));
    const r = await t.runner.run();
    expect(r.outcome).toBe("blocked");
    expect(r.blocked?.kind).toBe("needs_credential");
    expect(r.blocked?.hint).toContain("--var key=value");
    expect(r.blocked?.hint).toContain("/var");
    expect(t.page.calls.filter((c) => c.op === "act")).toEqual([]);
  });
  it("SELECT executes the i:n option and records the option label as value", async () => {
    const FORM = obs("https://a.b/form", [el("e1", "select", "Size → Small", "combobox", { node: 4, value: "s", current_value: "Large" }), el("e2", "select", "Size → Medium", "combobox", { node: 4, value: "m", current_value: "Large" })]);
    const t = setup("open https://a.b/form and pick Medium", { pages: { f: FORM, d: DASH }, start: "f", transitions: (c) => (c.op === "act" && c.id === "e2" ? "d" : undefined) },
      byUrl({ [FORM.url]: { page_kind: "task_page", operation: "SELECT", select_target: { choice: "1:2", confidence: 0.8 } }, [DASH.url]: { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } } }));
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(t.page.calls).toContainEqual({ op: "act", id: "e2", kind: "select" });
    expect(r.steps[0]).toMatchObject({ operation: "SELECT", action: "select", value: "Medium", target: { ref: "e2", name: "Size → Medium" } });
  });
});

describe("FastRunner control", () => {
  it("StalePage once -> re-observe and retry inside the same step", async () => {
    const t = setup("open wikipedia.org and click English", { pages: { home: HOME, article: ARTICLE }, start: "home", staleTimes: 1, transitions: (c) => (c.op === "act" && c.id === "e2" ? "article" : undefined) },
      byUrl({
        [HOME.url]: (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "English"), confidence: 0.7 } }),
        [ARTICLE.url]: { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } },
      }));
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]).toMatchObject({ step: 1, result: "ok", jev_requests: 2 });
    expect(t.page.observes).toBe(3);
    expect(t.log.lines.some((l) => /stale page \(1\/3\)/.test(l))).toBe(true);
  });
  it("StalePage every time -> blocked ambiguous after fastStaleRetries", async () => {
    const t = setup("open wikipedia.org and click English", { pages: { home: HOME }, start: "home", staleTimes: 10 },
      byUrl({ [HOME.url]: (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "English"), confidence: 0.7 } }) }));
    const r = await t.runner.run();
    expect(r.blocked).toMatchObject({ kind: "ambiguous", hint: "page keeps changing" });
    expect(r.steps[0]?.jev_requests).toBe(LIMITS.fastStaleRetries + 1);
  });
  it("three unchanged non-WAIT actions -> loop_detected; a WAIT in between does not count", async () => {
    let m = 0;
    const t = setup("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" },
      byUrl({ [HOME.url]: (q) => { m += 1; return { page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", m % 2 ? "English" : "Search"), confidence: 0.7 } }; } }));
    const r = await t.runner.run();
    expect(r.steps.map((s) => s.result)).toEqual(["ok", "ok", "ok", "blocked"]);
    expect(r.blocked?.kind).toBe("loop_detected");
    expect(stepStates(t)).toHaveLength(3);
    expect(stepStates(t)[2]?.recent_actions.map((h) => h.page_changed)).toEqual([false, false]);
    let n = 0;
    const w = setup("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" },
      byUrl({ [HOME.url]: (q) => { n += 1; return n === 2 ? { page_kind: "task_page", operation: "WAIT" } : { page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", n === 3 ? "Search" : "English"), confidence: 0.7 } }; } }), { maxSteps: 4 });
    const r2 = await w.runner.run();
    expect(r2.steps.map((s) => s.action)).toEqual(["click", "wait", "click", "click", "none"]);
    expect(r2.blocked?.kind).toBe("max_steps");
  });
  it("the same action on the same url twice bans it; the re-ask goes to another target", async () => {
    const seen: string[][] = [];
    const t = setup("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" },
      byUrl({ [HOME.url]: (q) => { const keys = Object.keys((q["click_target"] as ChoiceQuestion).criteria); seen.push(keys); return { page_kind: "task_page", operation: "CLICK", click_target: { choice: keys[0] as string, confidence: 0.7 } }; } }));
    await t.runner.run();
    const acted = t.page.calls.filter((c) => c.op === "act").map((c) => c.id);
    expect(acted.slice(0, 3)).toEqual(["e2", "e2", "e3"]);
    expect(seen[3]).not.toContain("1");
  });
  it("low target confidence -> ban, re-ask once, then blocked ambiguous with top-3", async () => {
    const t = setup("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" },
      byUrl({ [HOME.url]: (q) => { const keys = Object.keys((q["click_target"] as ChoiceQuestion).criteria); return { page_kind: "task_page", operation: "CLICK", click_target: { choice: keys[0] as string, confidence: 0.1, probabilities: Object.fromEntries(keys.map((k) => [k, 1 / keys.length])) } }; } }));
    const r = await t.runner.run();
    expect(r.outcome).toBe("blocked");
    expect(r.blocked?.kind).toBe("ambiguous");
    expect(r.blocked?.top.length).toBeGreaterThan(0);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]?.jev_requests).toBe(2);
    expect(t.page.calls.filter((c) => c.op === "act")).toEqual([]);
  });
  it("destructive label under --confirm never -> needs_confirmation; with a TTY and y it runs; submit needs y under --confirm always", async () => {
    const script = byUrl({ [DASH.url]: (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "Delete project"), confidence: 0.9 } }) });
    const r = await setup("open https://app.example/dash and delete the project", { pages: { d: DASH }, start: "d" }, script, { confirm: "never" }).runner.run();
    expect(r.blocked?.kind).toBe("needs_confirmation");
    expect(r.steps[0]?.risk).toBe("destructive");
    const tty = setup("open https://app.example/dash and delete the project", { pages: { d: DASH }, start: "d" }, script, {}, { human: fakeHuman({ interactive: true, confirm: [true] }) });
    const r2 = await tty.runner.run();
    expect(tty.human.prompts[0]).toMatch(/^confirm:About to click button "Delete project"/);
    expect(tty.page.calls).toContainEqual({ op: "act", id: "e3", kind: "click" });
    expect(r2.steps[0]?.gate).toBe("confirmed");
    const submit = byUrl({ [LOGIN.url]: (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "Sign in"), confidence: 0.9 } }) });
    const r3 = await setup("open https://app.example/login and press Sign in", { pages: { l: LOGIN }, start: "l" }, submit, { confirm: "always" }).runner.run();
    expect(r3.blocked?.kind).toBe("needs_confirmation");
    expect(r3.steps[0]?.risk).toBe("submit");
    const r4 = await setup("open https://app.example/login and press Sign in", { pages: { l: LOGIN }, start: "l" }, submit, { confirm: "auto", maxSteps: 1 }).runner.run();
    expect(r4.steps[0]?.result).toBe("ok");
  });
  it("riskOf: keyword classes apply to clicks; fill and select are data entry", () => {
    expect(riskOf("CLICK", "Delete project")).toBe("destructive");
    expect(riskOf("CLICK", "Sign in")).toBe("submit");
    expect(riskOf("CLICK", "English")).toBe("navigational");
    expect(riskOf("TYPE_TEXT", "Confirm password")).toBe("data_entry");
    expect(riskOf("SELECT", "Delete reason")).toBe("data_entry");
  });
  it("max_steps, run_timeout with an injected clock, dry-run never acts", async () => {
    const click = byUrl({ [HOME.url]: (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "English"), confidence: 0.7 } }) });
    const r = await setup("open wikipedia.org and click English", { pages: { home: HOME, a: ARTICLE }, start: "home", transitions: (c, cur) => (c.op === "act" ? (cur === "home" ? "a" : "home") : undefined) },
      byUrl({ [HOME.url]: (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "English"), confidence: 0.7 } }), [ARTICLE.url]: (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "Main menu"), confidence: 0.7 } }) }), { maxSteps: 2 }).runner.run();
    expect(r.blocked?.kind).toBe("max_steps");
    expect(r.steps).toHaveLength(3);
    let clock = 0;
    const t = setup("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" }, click, { runTimeoutMs: 100 }, { now: () => { clock += 60; return clock; } });
    const r2 = await t.runner.run();
    expect(r2.blocked?.kind).toBe("run_timeout");
    const dry = setup("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" }, click, { dryRun: true, maxSteps: 2 });
    const r3 = await dry.runner.run();
    expect(dry.page.calls.filter((c) => c.op === "act")).toEqual([]);
    expect(r3.steps[0]).toMatchObject({ result: "skipped", error: "dry_run", action: "click" });
    expect(r3.steps[0]?.gate).toContain("dry_run");
  });
  it("BLOCKED below GATES.blocked falls back to the runner-up operation; at or above the gate it blocks", async () => {
    const low = setup("open wikipedia.org and click English", { pages: { home: HOME, article: ARTICLE }, start: "home", transitions: (c) => (c.op === "act" && c.id === "e2" ? "article" : undefined) },
      byUrl({
        [HOME.url]: (q) => ({ page_kind: "task_page", operation: { choice: "BLOCKED", confidence: 0.38, probabilities: { BLOCKED: 0.38, CLICK: 0.35, DONE: 0.2, WAIT: 0.07 } }, blocked_reason: "other", click_target: { choice: idx(q, "click_target", "English"), confidence: 0.7 } }),
        [ARTICLE.url]: { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, CLICK: 0.05, WAIT: 0.05 } } },
      }));
    const r = await low.runner.run();
    expect(r.outcome).toBe("done");
    expect(r.steps[0]).toMatchObject({ operation: "CLICK", operation_conf: 0.35, action: "click", target: { name: "English" }, result: "ok" });
    expect(low.log.lines.some((l) => /BLOCKED at 0\.38 below 0\.4; using CLICK@0\.35/.test(l))).toBe(true);
    const high = await setup("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" },
      byUrl({ [HOME.url]: { page_kind: "task_page", operation: { choice: "BLOCKED", confidence: 0.4, probabilities: { BLOCKED: 0.4, CLICK: 0.35, WAIT: 0.25 } }, blocked_reason: "other" } })).runner.run();
    expect(high.outcome).toBe("blocked");
    expect(high.blocked?.kind).toBe("ambiguous");
  });
  it("BLOCKED with a reason maps to the blocked kind with the operation top-3", async () => {
    const r = await setup("open wikipedia.org and buy a car", { pages: { home: HOME }, start: "home" },
      byUrl({ [HOME.url]: { page_kind: "task_page", operation: { choice: "BLOCKED", confidence: 0.8, probabilities: { BLOCKED: 0.8, CLICK: 0.15, WAIT: 0.05 } }, blocked_reason: "impossible" } })).runner.run();
    expect(r.blocked).toMatchObject({ kind: "impossible", top: [{ label: "BLOCKED", p: 0.8 }, { label: "CLICK", p: 0.15 }, { label: "WAIT", p: 0.05 }] });
    const r2 = await setup("open wikipedia.org and buy a car", { pages: { home: HOME }, start: "home" }, byUrl({ [HOME.url]: { page_kind: "task_page", operation: "BLOCKED", blocked_reason: "needs_credential_or_value" } })).runner.run();
    expect(r2.blocked?.kind).toBe("needs_credential");
  });
  it("error_page -> one GO_BACK, then blocked impossible when it repeats", async () => {
    const ERR = obs("https://a.b/404", [el("e1", "click", "Home", "link")], "404 Not Found");
    const t = setup("open https://a.b/404 and read", { pages: { e: ERR }, start: "e" }, byUrl({ [ERR.url]: { page_kind: { choice: "error_page", confidence: 0.9 }, operation: "GO_BACK" } }));
    const r = await t.runner.run();
    expect(t.page.calls).toContainEqual({ op: "back" });
    expect(r.steps.map((s) => `${s.action}:${s.result}`)).toEqual(["go_back:ok", "none:blocked"]);
    expect(r.blocked?.kind).toBe("impossible");
  });
  it("a 250-element page with long labels, values, and 6000 chars of text fits the budget after the caps and the trim ladder", async () => {
    const label = "L".repeat(200);
    const HUGE = obs("https://a.b/huge?" + "q".repeat(5000), Array.from({ length: 250 }, (_, i) => el(`e${i + 1}`, i % 2 ? "click" : "fill", `${label}${i}`, i % 2 ? "link" : "textbox", { value: "v".repeat(300) })), "t".repeat(6000), { title: "T".repeat(1000) });
    const t = setup("open https://a.b/huge and read the heading", { pages: { h: HUGE }, start: "h" }, byUrl({}), { goal: "extract", maxSteps: 1 });
    const r = await t.runner.run();
    expect(r.blocked?.kind).not.toBe("page_too_large");
    const steps = t.oracle.requests.filter((q) => q.name === "step");
    expect(steps.length).toBeGreaterThanOrEqual(1);
    const state = steps[0]?.state as { page: { url: string; title: string } };
    expect(state.page.title.length).toBeLessThanOrEqual(LIMITS.titleChars);
    expect(state.page.url.length).toBeLessThanOrEqual(LIMITS.urlChars);
  });
});

describe("FastRunner goals", () => {
  it("check: DONE + answer_state yes at 0.8 -> done with probability and evidence", async () => {
    const t = setup("open https://app.example/dash and check if the project has Sept 3 artifacts", { pages: { d: DASH }, start: "d" },
      byUrl({ [DASH.url]: (q) => ({ page_kind: "task_page", operation: "DONE", answer_state: { choice: "yes", confidence: 0.8, probabilities: { yes: 0.8, no: 0.1, not_visible_yet: 0.1 } }, evidence: idx(q, "evidence", "Licious Sept3 Session") }) }), { goal: "check" });
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(r.goal).toBe("check");
    expect(r.answer).toEqual({ kind: "check", answer: true, probability: 0.8, evidence: ["Licious Sept3 Session"] });
    expect(r.confidence).toBe(0.8);
    expect(t.oracle.requests.map((x) => x.name)).toEqual(["step"]);
  });
  it("check: two holds on the same page -> done with answer unknown and top probabilities", async () => {
    let n = 0;
    const t = setup("open https://app.example/dash and check if the project has Sept 3 artifacts", { pages: { d: DASH }, start: "d" },
      byUrl({ [DASH.url]: (q) => { n += 1; const ops = Object.keys((q["operation"] as ChoiceQuestion).criteria); if (!ops.includes("DONE")) return { page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "Home"), confidence: 0.7 } }; return { page_kind: "task_page", operation: "DONE", answer_state: { choice: "yes", confidence: 0.4, probabilities: { yes: 0.4, no: 0.3, not_visible_yet: 0.3 } } }; } }), { goal: "check" });
    const r = await t.runner.run();
    expect(r.steps.map((s) => `${s.action}:${s.result}:${s.gate}`)).toEqual(["none:skipped:check_hold", "click:ok:ok 0.70 (navigational)", "none:done:check_unknown"]);
    expect(r.outcome).toBe("done");
    expect(r.answer).toMatchObject({ kind: "check", answer: "unknown", probability: 0.4, top: [{ label: "yes", p: 0.4 }, { label: "no", p: 0.3 }, { label: "not_visible_yet", p: 0.3 }] });
    expect(n).toBe(3);
  });
  it("extract: DONE with answer_visible and a line -> done with the line text; not visible bans DONE and Jev scrolls", async () => {
    const t = setup("open https://en.wikipedia.org/wiki/Alan_Turing and tell me when he was born", { pages: { a: ARTICLE }, start: "a" },
      byUrl({ [ARTICLE.url]: (q) => { const lines = (q["answer_line"] as ChoiceQuestion).criteria; const key = Object.keys(lines).find((k) => lines[k] === "Born 23 June 1912") as string; return { page_kind: "task_page", operation: "DONE", answer_visible: 0.9, answer_line: { choice: key, confidence: 0.6 } }; } }), { goal: "extract" });
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(r.answer).toEqual({ kind: "extract", text: "Born 23 June 1912", line_id: "l3", evidence: ["Born 23 June 1912"] });
    expect(r.confidence).toBe(0.6);
    let n = 0;
    const t2 = setup("open https://en.wikipedia.org/wiki/Alan_Turing and tell me when he was born", { pages: { a: ARTICLE }, start: "a" },
      byUrl({ [ARTICLE.url]: (q) => { n += 1; const ops = Object.keys((q["operation"] as ChoiceQuestion).criteria); if (!ops.includes("DONE")) return { page_kind: "task_page", operation: "SCROLL_DOWN" }; return { page_kind: "task_page", operation: "DONE", answer_visible: n === 1 ? 0.2 : 0.9, answer_line: { choice: "l3", confidence: 0.6 } }; } }), { goal: "extract" });
    const r2 = await t2.runner.run();
    expect(r2.steps.map((s) => `${s.action}:${s.result}`)).toEqual(["none:skipped", "scroll_down:ok", "scroll_down:ok", "none:done"]);
    expect(t2.page.calls.filter((c) => c.op === "act" && c.id === "scroll_down")).toHaveLength(2);
    expect(r2.answer).toMatchObject({ kind: "extract", text: "Born 23 June 1912" });
  });
  it("extract: answer_line none keeps going until max_steps", async () => {
    const r = await setup("open https://en.wikipedia.org/wiki/Alan_Turing and tell me his shoe size", { pages: { a: ARTICLE }, start: "a" },
      byUrl({ [ARTICLE.url]: { page_kind: "task_page", operation: "DONE", answer_visible: 0.9, answer_line: "none" } }), { goal: "extract", maxSteps: 2 }).runner.run();
    expect(r.outcome).toBe("blocked");
    expect(r.blocked?.kind).toBe("max_steps");
  });
});

describe("FastRunner hand-off and plan", () => {
  it("sign-in wall headless -> blocked needs_sign_in with the --headed hint; BLOCKED + needs_sign_in also", async () => {
    const t = setup("open https://app.example/login and read the newest email", { pages: { l: LOGIN }, start: "l" },
      byUrl({ [LOGIN.url]: { page_kind: { choice: "sign_in_wall", confidence: 0.95, probabilities: { sign_in_wall: 0.95, task_page: 0.05 } }, operation: "WAIT" } }));
    const r = await t.runner.run();
    expect(r.blocked).toMatchObject({ kind: "needs_sign_in", resume: { session: "jev-test", url: LOGIN.url }, top: [{ label: "sign_in_wall", p: 0.95 }, { label: "task_page", p: 0.05 }] });
    expect(r.blocked?.hint).toContain("--headed");
    expect(r.blocked?.hint).toContain("/headed on");
    expect(t.page.calls.filter((c) => c.op !== "navigate")).toEqual([]);
    const r2 = await setup("open https://app.example/login and read the newest email", { pages: { l: LOGIN }, start: "l" }, byUrl({ [LOGIN.url]: { page_kind: "task_page", operation: "BLOCKED", blocked_reason: "needs_sign_in" } })).runner.run();
    expect(r2.blocked?.kind).toBe("needs_sign_in");
    const r3 = await setup("open https://app.example/login and read", { pages: { l: LOGIN }, start: "l" }, byUrl({ [LOGIN.url]: { page_kind: { choice: "captcha_or_bot_check", confidence: 0.9 }, operation: "WAIT" } })).runner.run();
    expect(r3.blocked?.kind).toBe("captcha");
  });
  it("headed + TTY: pause with a wall poll; resumed continues, q aborts, timeout blocks", async () => {
    const script = byUrl({ [LOGIN.url]: { page_kind: "sign_in_wall", operation: "BLOCKED", blocked_reason: "needs_sign_in" }, [DASH.url]: { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } } }, { wall: { wall: { choice: "app_page", confidence: 0.8 } } });
    const t = setup("open https://app.example/login and read", { pages: { l: LOGIN, d: DASH }, start: "l" }, script, { headed: true }, { human: fakeHuman({ interactive: true }) });
    const origPause = t.human.pause.bind(t.human);
    t.human.pause = async (m, ms, poll) => { t.page.current = "d"; return origPause(m, ms, poll); };
    const r = await t.runner.run();
    expect(r.steps.map((s) => s.result)).toEqual(["paused", "done"]);
    expect(r.stats.pauses).toBe(1);
    expect(t.oracle.requests.map((x) => x.name)).toEqual(["step", "wall", "step"]);
    const wallState = t.oracle.requests[1]?.state as { goal: string; page: { url: string; text: string } };
    expect(wallState.page.url).toBe(DASH.url);
    expect(stepStates(t)[1]?.recent_actions[0]).toMatchObject({ action: "user signed in", page_changed: true });
    const q = setup("open https://app.example/login and read", { pages: { l: LOGIN }, start: "l" }, script, { headed: true }, { human: fakeHuman({ interactive: true, pause: ["aborted"] }) });
    expect((await q.runner.run()).blocked?.kind).toBe("human_aborted");
    const to = setup("open https://app.example/login and read", { pages: { l: LOGIN }, start: "l" }, byUrl({ [LOGIN.url]: { page_kind: "sign_in_wall", operation: "BLOCKED", blocked_reason: "needs_sign_in" } }, { wall: { wall: { choice: "signin_wall", confidence: 0.9 } } }), { headed: true }, { human: fakeHuman({ interactive: true, pause: ["timeout"] }) });
    const r3 = await to.runner.run();
    expect(r3.blocked?.kind).toBe("needs_sign_in");
    expect(r3.blocked?.hint).toContain("pause used up or timed out");
  });
  it("warm hook: called before the Chrome launch when the plan sent no Jev request; a rejected warm does not fail the run", async () => {
    const DONE = byUrl({ [ARTICLE.url]: { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } } });
    let warms = 0;
    let launchesAtWarm = -1;
    const t = setup("open https://en.wikipedia.org/wiki/Alan_Turing and read", { pages: { a: ARTICLE }, start: "a" }, DONE, {}, { warm: async () => { warms += 1; launchesAtWarm = t.counts().launches; } });
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(t.oracle.requests.map((x) => x.name)).toEqual(["step"]);
    expect(warms).toBe(1);
    expect(launchesAtWarm).toBe(0);
    expect(t.counts().launches).toBe(1);
    const bad = setup("open https://en.wikipedia.org/wiki/Alan_Turing and read", { pages: { a: ARTICLE }, start: "a" }, DONE, {}, { warm: async () => { throw new Error("warm failed"); } });
    expect((await bad.runner.run()).outcome).toBe("done");
  });
  it("warm hook: not called when the plan asks Jev; that request opens the connection", async () => {
    let warms = 0;
    const t = setup("open https://en.wikipedia.org/wiki/Alan_Turing and read", { pages: { a: ARTICLE }, start: "a" },
      byUrl({ [ARTICLE.url]: { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } } }, { plan: { goal: { choice: "act", confidence: 0.9 } } }), {}, { warm: async () => { warms += 1; } });
    delete (t.runner as unknown as { cfg: RunConfig }).cfg.goal;
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(t.oracle.requests.map((x) => x.name)).toEqual(["plan", "step"]);
    expect(warms).toBe(0);
    expect(t.counts().launches).toBe(1);
  });
  it("plan blocks (ambiguous_profile, no_start_url) never launch Chrome", async () => {
    const t = setup("check my account", { pages: { home: HOME }, start: "home" }, (name) => (name === "plan" ? { profile_mentioned: 0.9, profile: { choice: "Profile 14", confidence: 0.6 }, goal: "act" } : {}));
    delete (t.runner as unknown as { cfg: RunConfig }).cfg.profile;
    delete (t.runner as unknown as { cfg: RunConfig }).cfg.goal;
    const r = await t.runner.run();
    expect(r.blocked?.kind).toBe("no_start_url");
    expect(t.counts()).toEqual({ launches: 0, opened: 0 });
    expect(t.chrome.closes).toBe(0);
    expect(r.stats.engine).toBe("cdp");
    expect(t.runner.page).toBeNull();
  });
  it("current_page with a provided page: no navigate, logs continue on; keepOpen leaves chrome open", async () => {
    const t = setup("click the English link", { pages: { home: HOME, article: ARTICLE }, start: "home", transitions: (c) => (c.op === "act" && c.id === "e2" ? "article" : undefined) },
      byUrl({ [HOME.url]: (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "English"), confidence: 0.7 } }), [ARTICLE.url]: { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } } }),
      { fallbackUrl: HOME.url, keepOpen: true }, { providePage: true });
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(r.start).toEqual({ url: HOME.url, how: "current_page", confidence: null });
    expect(t.page.calls.some((c) => c.op === "navigate")).toBe(false);
    expect(t.counts()).toEqual({ launches: 1, opened: 0 });
    expect(t.log.lines.some((l) => l.includes(`continue on ${HOME.url}`))).toBe(true);
    expect(t.chrome.closes).toBe(0);
    expect(t.runner.page).toBe(t.page);
  });
  it("current_page without a provided page -> no_start_url", async () => {
    const r = await setup("click the English link", { pages: { home: HOME }, start: "home" }, byUrl({}), { fallbackUrl: HOME.url }).runner.run();
    expect(r.blocked?.kind).toBe("no_start_url");
  });
  it("errors: CdpError -> browser, TypeSafeError -> jev, other -> internal; chrome is closed each time", async () => {
    const cdp = Object.assign(new Error("target closed"), { name: "CdpError" });
    const t = setup("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" }, byUrl({ [HOME.url]: { page_kind: "task_page", operation: "WAIT" } }));
    t.page.observe = async () => { throw cdp; };
    const r = await t.runner.run();
    expect(r.outcome).toBe("failed");
    expect(r.error).toEqual({ kind: "browser", message: "target closed" });
    expect(t.chrome.closes).toBe(1);
    const j = setup("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" }, () => { throw new TypeSafeError("rate limited"); });
    const r2 = await j.runner.run();
    expect(r2.error?.kind).toBe("jev");
    expect(j.chrome.closes).toBe(1);
    const i = setup("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" }, byUrl({}), {}, { chromeFails: new Error("boom") });
    const r3 = await i.runner.run();
    expect(r3.error?.kind).toBe("internal");
    expect(r3.stats.engine).toBe("cdp");
  });
  it("stats carry jev_ms from the oracle and browser_ms from the page", async () => {
    const t = setup("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" }, byUrl({ [HOME.url]: { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } } }));
    const r = await t.runner.run();
    expect(r.stats.jev_ms).toBe(7);
    expect(r.stats.browser_ms).toBe(t.page.stats.browserMs);
    expect(r.stats.browser_ms).toBeGreaterThan(0);
    expect(r.stats).toMatchObject({ engine: "cdp", jev_requests: 1, steps: 1 });
  });
  it("screenshots per step when screenshotDir is set; page.screenshot is called with step-N.jpg", async () => {
    const paths: string[] = [];
    const t = setup("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" }, byUrl({ [HOME.url]: { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } } }), { screenshotDir: "/tmp/shots" });
    (t.page as Page).screenshot = async (p: string) => { paths.push(p); };
    await t.runner.run();
    expect(paths).toEqual(["/tmp/shots/step-1.jpg"]);
  });
  it("GATES.done and GATES.answerLine exist with the specified values", () => {
    expect(GATES.done).toBe(0.5);
    expect(GATES.answerLine).toBe(0.2);
    expect(LIMITS.fastReasks).toBe(1);
    const o: Observation = HOME;
    expect(o.actions.at(-1)?.id).toBe("wait");
  });
});

describe("FastRunner review fixes", () => {
  const done = { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } } as const;

  it("browser_ms counts only this run: a second runner on the same page reports its own time (chat mode)", async () => {
    const page = fakePage({ pages: { home: HOME }, start: "home" });
    const mk = () => new FastRunner({ cfg: cfg("click English", { fallbackUrl: HOME.url, keepOpen: true }), profiles: PROFILES, chrome: async () => fakeChrome(), page, openPage: async () => page, oracle: fakeOracle(byUrl({ [HOME.url]: done })), human: fakeHuman({ interactive: false }), log: fakeLogger() });
    const r1 = await mk().run();
    const r2 = await mk().run();
    expect(r1.stats.browser_ms).toBeGreaterThan(0);
    expect(r2.stats.browser_ms).toBeGreaterThan(0);
    expect(r1.stats.browser_ms + r2.stats.browser_ms).toBe(page.stats.browserMs);
  });

  it("TYPE_TEXT: a task span below THRESHOLDS.data_entry.value is low_value -> re-ask, then blocked; a --var span passes at any confidence", async () => {
    const t = setup("search wikipedia for Alan Turing and tell me his birth year", { pages: { home: HOME }, start: "home" },
      byUrl({ [HOME.url]: (q) => {
        // After the ban the only fill target is gone, TYPE_TEXT is not offered, and the re-ask has no value head.
        const values = q["type_text_value"] as ChoiceQuestion | undefined;
        if (!values) return { page_kind: "task_page", operation: "BLOCKED", blocked_reason: "other" };
        const spans = Object.keys(values.criteria).filter((k) => k !== "none");
        const low = spans.find((k) => values.criteria[k] === "his birth year") ?? spans[0] as string;
        return { page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", "Search Wikipedia"), confidence: 0.8 }, type_text_value: { choice: low, confidence: 0.28 } };
      } }), { url: HOME.url });
    const r = await t.runner.run();
    expect(t.page.calls.filter((c) => c.op === "act")).toEqual([]);
    expect(r.steps[0]?.gate).toMatch(/^low_value 0\.28 < 0\.55/);
    expect(r.steps[0]?.value_conf).toBeNull();
    expect(r.blocked?.kind).toBe("ambiguous");
    const v = setup("open wikipedia.org and search", { pages: { home: HOME, a: ARTICLE }, start: "home", transitions: (c) => (c.op === "act" && c.kind === "fill" ? "a" : undefined) },
      byUrl({ [HOME.url]: (q) => ({ page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", "Search Wikipedia"), confidence: 0.8 }, type_text_value: { choice: "v_query", confidence: 0.2 } }), [ARTICLE.url]: done }), { vars: { query: "Alan Turing" } });
    const r2 = await v.runner.run();
    expect(v.page.calls).toContainEqual({ op: "act", id: "e1", kind: "fill", text: "Alan Turing" });
    expect(r2.steps[0]).toMatchObject({ value: "Alan Turing", value_conf: 1, result: "ok" });
  });

  it("TYPE_TEXT into a credential field with a non-secret span -> blocked needs_credential; the secret is never typed from the task", async () => {
    const t = setup("open https://app.example/login and type 123456 in the code field", { pages: { login: obs("https://app.example/login", [el("e1", "fill", "Verification code", "textbox", { value: "" })], "Enter the code") }, start: "login" },
      byUrl({ "https://app.example/login": (q) => { const spans = (q["type_text_value"] as ChoiceQuestion).criteria; const k = Object.keys(spans).find((x) => spans[x] === "123456") as string; return { page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", "Verification code"), confidence: 0.9 }, type_text_value: { choice: k, confidence: 0.9 } }; } }));
    const r = await t.runner.run();
    expect(r.blocked?.kind).toBe("needs_credential");
    expect(r.blocked?.hint).toContain("--var key=value");
    expect(t.page.calls.filter((c) => c.op === "act")).toEqual([]);
  });

  it("bans follow the element, not the per-snapshot ordinal", async () => {
    const url = "https://app.example/spa";
    const before = obs(url, [el("e1", "click", "Accordion", "button", { node: 1 }), el("e2", "click", "Alpha", "link", { node: 2 }), el("e3", "click", "Beta", "link", { node: 3 })], "list");
    const after = obs(url, [el("e1", "click", "Accordion", "button", { node: 1 }), el("e2", "click", "Alpha", "link", { node: 2 }), el("e3", "click", "Gamma", "link", { node: 9 }), el("e4", "click", "Beta", "link", { node: 3 })], "list\nGamma");
    const offered: string[][] = [];
    let n = 0;
    const t = setup("open https://app.example/spa and click Beta", { pages: { before, after }, start: "before", transitions: (c) => (c.op === "act" && c.id === "e1" ? "after" : undefined) },
      byUrl({ [url]: (q) => {
        n += 1;
        const crit = (q["click_target"] as ChoiceQuestion).criteria as Record<string, { element: string }>;
        offered.push(Object.values(crit).map((v) => v.element));
        if (n === 1) return { page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "Beta"), confidence: 0.18 } };
        if (n === 2) return { page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "Accordion"), confidence: 0.8 } };
        return done;
      } }), { maxSteps: 3 });
    await t.runner.run();
    expect(actionKey(el("e3", "click", "Beta", "link", { node: 3 }))).toBe("n:3|Beta");
    expect(actionKey(waitAction())).toBe("wait");
    expect(offered[0]).toEqual(["[1] Accordion", "[2] Alpha", "[3] Beta"]);
    expect(offered[1]).toEqual(["[1] Accordion", "[2] Alpha"]);
    expect(offered[2]).toEqual(["[1] Accordion", "[2] Alpha", "[3] Gamma"]);
  });

  it("observe that does not settle: retried, then blocked 'page keeps changing' (never failed/internal)", async () => {
    const t = setup("open wikipedia.org and click English", { pages: { home: HOME, article: ARTICLE }, start: "home", transitions: (c) => (c.op === "act" && c.id === "e2" ? "article" : undefined) },
      byUrl({ [HOME.url]: (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "English"), confidence: 0.7 } }), [ARTICLE.url]: done }));
    const orig = t.page.observe.bind(t.page);
    let fails = 1;
    t.page.observe = async () => { if (t.page.current === "article" && fails > 0) { fails -= 1; throw new StalePage("Page did not settle"); } return orig(); };
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(r.steps[0]?.result).toBe("ok");
    expect(t.log.lines.some((l) => /observe did not settle \(1\/3\)/.test(l))).toBe(true);
    const always = setup("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" }, byUrl({}));
    always.page.observe = async () => { throw new StalePage("Page did not settle"); };
    const r2 = await always.runner.run();
    expect(r2.outcome).toBe("blocked");
    expect(r2.error).toBeNull();
    expect(r2.blocked).toMatchObject({ kind: "ambiguous", hint: "page keeps changing" });
    const post = setup("open wikipedia.org and click English", { pages: { home: HOME, article: ARTICLE }, start: "home", transitions: (c) => (c.op === "act" && c.id === "e2" ? "article" : undefined) },
      byUrl({ [HOME.url]: (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "English"), confidence: 0.7 } }) }));
    const orig3 = post.page.observe.bind(post.page);
    post.page.observe = async () => { if (post.page.current === "article") throw new StalePage("Page did not settle"); return orig3(); };
    const r3 = await post.runner.run();
    expect(r3.blocked).toMatchObject({ kind: "ambiguous", hint: "page keeps changing" });
    expect(r3.error).toBeNull();
    expect(post.page.calls).toContainEqual({ op: "act", id: "e2", kind: "click" });
  });

  it("headed without a TTY still pauses on a sign-in wall; the hint never says to add --headed", async () => {
    const t = setup("open https://app.example/login and read", { pages: { l: LOGIN }, start: "l" },
      byUrl({ [LOGIN.url]: { page_kind: { choice: "sign_in_wall", confidence: 0.95 }, operation: "WAIT" } }, { wall: { wall: { choice: "signin_wall", confidence: 0.9 } } }), { headed: true }, { human: fakeHuman({ interactive: false }) });
    const r = await t.runner.run();
    expect(t.human.prompts.filter((p) => p.startsWith("pause:"))).toHaveLength(1);
    expect(r.stats.pauses).toBe(1);
    expect(r.blocked?.kind).toBe("needs_sign_in");
    expect(r.blocked?.hint).not.toContain("--headed");
    expect(r.blocked?.hint).toContain("pause used up or timed out");
  });

  it("BLOCKED needs_sign_in below the gate on a task page falls back to the runner-up operation", async () => {
    const t = setup("open wikipedia.org and click English", { pages: { home: HOME, article: ARTICLE }, start: "home", transitions: (c) => (c.op === "act" && c.id === "e2" ? "article" : undefined) },
      byUrl({
        [HOME.url]: (q) => ({ page_kind: { choice: "task_page", confidence: 0.9, probabilities: { task_page: 0.9, sign_in_wall: 0.05, error_page: 0.05 } }, operation: { choice: "BLOCKED", confidence: 0.27, probabilities: { BLOCKED: 0.27, CLICK: 0.25, WAIT: 0.24, DONE: 0.24 } }, blocked_reason: { choice: "needs_sign_in", confidence: 0.21 }, click_target: { choice: idx(q, "click_target", "English"), confidence: 0.7 } }),
        [ARTICLE.url]: done,
      }));
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(r.steps[0]).toMatchObject({ operation: "CLICK", action: "click", result: "ok" });
    // The same weak BLOCKED with the page kind head agreeing hands off.
    const wall = await setup("open https://app.example/login and read", { pages: { l: LOGIN }, start: "l" },
      byUrl({ [LOGIN.url]: { page_kind: { choice: "sign_in_wall", confidence: 0.45, probabilities: { sign_in_wall: 0.45, task_page: 0.55 } }, operation: { choice: "BLOCKED", confidence: 0.3, probabilities: { BLOCKED: 0.3, CLICK: 0.3, WAIT: 0.4 } }, blocked_reason: "needs_sign_in" } })).runner.run();
    expect(wall.blocked?.kind).toBe("needs_sign_in");
  });

  it("WAIT is capped per page: after LIMITS.waitsPerPage it scrolls, or blocks loop_detected when the page cannot scroll", async () => {
    const t = setup("open https://en.wikipedia.org/wiki/Alan_Turing and read", { pages: { a: ARTICLE }, start: "a" }, byUrl({ [ARTICLE.url]: { page_kind: "task_page", operation: "WAIT" } }), { maxSteps: 4 });
    const r = await t.runner.run();
    expect(r.steps.map((s) => `${s.action}:${s.result}`)).toEqual(["wait:ok", "wait:ok", "scroll_down:ok", "scroll_down:ok", "none:blocked"]);
    expect(r.steps[2]?.gate).toBe("wait_cap 2");
    expect(t.page.calls.filter((c) => c.op === "act" && c.id === "scroll_down")).toHaveLength(2);
    const flat = setup("open wikipedia.org and read", { pages: { home: HOME }, start: "home" }, byUrl({ [HOME.url]: { page_kind: "task_page", operation: "WAIT" } }), { maxSteps: 6 });
    const r2 = await flat.runner.run();
    expect(r2.steps.map((s) => `${s.action}:${s.result}`)).toEqual(["wait:ok", "wait:ok", "none:blocked"]);
    expect(r2.blocked?.kind).toBe("loop_detected");
    expect(flat.oracle.requests).toHaveLength(3);
  });

  it("a submit click with a near-tied runner-up is ambiguous_runner_up: re-ask, then blocked; a navigational click is not", async () => {
    const FORM = obs("https://app.example/edit", [el("e1", "click", "Save", "button"), el("e2", "click", "Save and publish", "button"), el("e3", "click", "Help", "link")], "Edit");
    const tied = (q: Questions) => { const save = idx(q, "click_target", "Save"); const both = Object.keys((q["click_target"] as ChoiceQuestion).criteria); const probs: Record<string, number> = Object.fromEntries(both.map((k) => [k, 0.03])); probs[save] = 0.5; const pub = both.find((k) => k !== save && String(((q["click_target"] as ChoiceQuestion).criteria[k] as { element: string }).element).includes("publish")); if (pub) probs[pub] = 0.47; return { page_kind: "task_page", operation: "CLICK", click_target: { choice: save, confidence: 0.5, probabilities: probs } }; };
    const t = setup("open https://app.example/edit and save", { pages: { f: FORM }, start: "f" }, byUrl({ [FORM.url]: tied }));
    const r = await t.runner.run();
    expect(t.page.calls.filter((c) => c.op === "act")).toEqual([]);
    expect(t.log.lines.some((l) => /retry 1\/1: ambiguous_runner_up 0\.47 >= 0\.5 \* 0\.50 \(submit\)/.test(l))).toBe(true);
    expect(r.steps[0]?.jev_requests).toBe(2);
    expect(r.blocked?.kind).toBe("ambiguous");
    const nav = setup("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" },
      byUrl({ [HOME.url]: (q) => { const en = idx(q, "click_target", "English"); const keys = Object.keys((q["click_target"] as ChoiceQuestion).criteria); const probs = Object.fromEntries(keys.map((k) => [k, k === en ? 0.5 : 0.5 / (keys.length - 1)])); return { page_kind: "task_page", operation: "CLICK", click_target: { choice: en, confidence: 0.5, probabilities: probs } }; } }), { maxSteps: 1 });
    const r2 = await nav.runner.run();
    expect(r2.steps[0]?.result).toBe("ok");
  });

  it("PRESS_ENTER passes the observation to the page so a changed document is stale", async () => {
    const t = setup("open wikipedia.org and search", { pages: { home: HOME }, start: "home" }, byUrl({ [HOME.url]: { page_kind: "task_page", operation: "PRESS_ENTER" } }), { maxSteps: 1 });
    const seen: unknown[] = [];
    t.page.press = async (key: string, o?: Observation) => { seen.push(o?.url); t.page.calls.push({ op: "press", key }); };
    await t.runner.run();
    expect(seen).toEqual([HOME.url]);
  });
});

describe("FastRunner loading pages and WAIT", () => {
  const EMPTY = obs("https://app.example/dash", [], "");
  const loadingBlocked = { page_kind: { choice: "empty_or_loading", confidence: 0.93, probabilities: { empty_or_loading: 0.93, sign_in_wall: 0.05, task_page: 0.02 } }, operation: { choice: "BLOCKED", confidence: 0.49, probabilities: { BLOCKED: 0.49, WAIT: 0.3, DONE: 0.21 } }, blocked_reason: "needs_sign_in" } as const;
  const loadingDone = { ...loadingBlocked, operation: { choice: "DONE", confidence: 0.6, probabilities: { DONE: 0.6, WAIT: 0.4 } } } as const;
  const done = { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } } as const;
  const app = (script: PageScript, answers: PartialAnswers) => setup("open https://app.example/dash and check the project", script, byUrl({
    [EMPTY.url]: (_q, state) => ((state as { page: { text: string } }).page.text ? done : answers),
  }));

  it("BLOCKED needs_sign_in on an empty or loading page waits instead of handing off; the run continues when the app renders", async () => {
    const t = app({ pages: { e: EMPTY, d: DASH }, start: "e", transitions: (c) => (c.op === "act" && c.id === "wait" ? "d" : undefined) }, loadingBlocked);
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(r.blocked).toBeNull();
    expect(r.steps[0]).toMatchObject({ action: "wait", gate: "loading BLOCKED", result: "ok" });
    expect(stepStates(t)[1]?.recent_actions[0]).toMatchObject({ kind: "wait", page_changed: true });
  });

  it("DONE on an empty or loading page also waits", async () => {
    const t = app({ pages: { e: EMPTY, d: DASH }, start: "e", transitions: (c) => (c.op === "act" && c.id === "wait" ? "d" : undefined) }, loadingDone);
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(r.steps[0]).toMatchObject({ action: "wait", gate: "loading DONE" });
    expect(r.steps).toHaveLength(2);
  });

  it("a target that stays covered is banned after two tries; the re-ask takes another route and Jev sees a covered entry", async () => {
    const t = setup("open https://app.example/dash and open the project", { pages: { d: DASH, a: ARTICLE }, start: "d", transitions: (c) => (c.op === "act" && c.id === "e2" ? "a" : undefined) },
      byUrl({
        [DASH.url]: (q) => {
          const offered = JSON.stringify((q["click_target"] as ChoiceQuestion | undefined)?.criteria ?? {}).includes("Licious");
          return { page_kind: "task_page", operation: { choice: "CLICK", confidence: 0.8, probabilities: { CLICK: 0.8, DONE: 0.2 } }, click_target: { choice: idx(q, "click_target", offered ? "Licious" : "Home"), confidence: 0.8 } };
        },
        [ARTICLE.url]: done,
      }));
    const realAct = t.page.act.bind(t.page);
    t.page.act = async (a, o, text) => { if (a.id === "e1") throw new StalePage("Target changed or is covered. Observe again."); return realAct(a, o, text); };
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(t.page.calls.filter((c) => c.op === "act").map((c) => c.id)).toEqual(["e2"]);
    expect(stepStates(t).at(-1)?.recent_actions.some((h) => h.kind === "covered" && h.action.startsWith("Licious"))).toBe(true);
  });

  it("WAIT polls until the page changes and stops after fastWaitMs worth of polls when it never does", async () => {
    const t = app({ pages: { e: EMPTY }, start: "e" }, loadingBlocked);
    const r = await t.runner.run();
    expect(r.outcome).toBe("blocked");
    const polls = Math.ceil(LIMITS.fastWaitMs / LIMITS.waitPollMs);
    // one observe at the start, then at most `polls` observes per WAIT step
    expect(t.page.observes).toBeLessThanOrEqual(1 + r.steps.length * polls);
    expect(t.page.observes).toBeGreaterThan(r.steps.length);
  });

});

describe("FastRunner overlap: Chrome launch during the plan request", () => {
  const DONE_ANY = { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } } as const;
  type Deferred = { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void };
  const deferred = (): Deferred => {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  /** Drain every pending microtask so the run reaches the point where it waits for the plan gate. */
  const tick = () => new Promise<void>((r) => setImmediate(r));

  /**
   * A runner whose plan request waits for `gate`. `events` records, in order: warm, chrome (deps.chrome called),
   * navigate, plan:ask (the oracle got the plan request), plan:resolve (the gate opened).
   */
  function gated(task: string, script: PageScript, over: Partial<RunConfig> = {}, opts: { providePage?: boolean; navigateFails?: Error; unset?: ("goal" | "profile")[]; plan?: PartialAnswers } = {}) {
    const events: string[] = [];
    const gate = deferred();
    const page = fakePage(script);
    const chrome = fakeChrome();
    const inner = fakeOracle(byUrl({ [HOME.url]: DONE_ANY, [ARTICLE.url]: DONE_ANY }, { plan: opts.plan ?? { goal: { choice: "act", confidence: 0.9 } } }));
    const oracle: typeof inner = {
      ...inner,
      async ask(name, state, questions) {
        if (name === "plan") { events.push("plan:ask"); await gate.promise; events.push("plan:resolve"); }
        return inner.ask(name, state, questions);
      },
    };
    const log = fakeLogger();
    const c = cfg(task, over);
    for (const k of opts.unset ?? []) delete c[k];
    const navigate = page.navigate.bind(page);
    page.navigate = async (url: string, ms: number) => { events.push("navigate"); if (opts.navigateFails) throw opts.navigateFails; await navigate(url, ms); };
    let launches = 0;
    const deps: FastRunnerDeps = {
      cfg: c, profiles: PROFILES,
      chrome: async () => { events.push("chrome"); launches += 1; return chrome; },
      openPage: async () => page,
      oracle, human: fakeHuman({ interactive: false }), log, sleep: async () => undefined,
      warm: async () => { events.push("warm"); },
      ...(opts.providePage ? { page } : {}),
    };
    return { runner: new FastRunner(deps), events, gate, page, chrome, oracle, log, launches: () => launches };
  }
  const OVERLAP_LINE = "DEBUG overlap: chrome launch and plan request run together";

  it("(a) URL in the task + --profile none: Chrome launches and the page loads before the plan resolves; result done", async () => {
    const t = gated("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" }, {}, { unset: ["goal"] });
    const run = t.runner.run();
    await tick();
    // deps.chrome is called before the plan request is even issued; the page loads while the plan waits.
    expect(t.events).toEqual(["chrome", "plan:ask", "navigate"]);
    t.gate.resolve();
    const r = await run;
    expect(r.outcome).toBe("done");
    expect(t.events.indexOf("plan:resolve")).toBeGreaterThan(t.events.indexOf("navigate"));
    expect(t.oracle.requests.map((x) => x.name)).toEqual(["plan", "step"]);
    expect(r.start).toEqual({ url: "https://wikipedia.org", how: "task_url", confidence: null });
    expect(r.profile).toBeNull();
    expect(t.page.calls[0]).toEqual({ op: "navigate", url: "https://wikipedia.org" });
    expect(t.log.lines).toContain(OVERLAP_LINE);
    expect(t.log.lines.filter((l) => l.startsWith("INFO open https://wikipedia.org"))).toHaveLength(1);
    expect(t.log.lines.filter((l) => l.startsWith("INFO plan profile=none via flag start=https://wikipedia.org via task_url goal=act(0.90) requests=1"))).toHaveLength(1);
    expect(t.events).not.toContain("warm");
    expect(t.chrome.closes).toBe(1);
    expect(t.launches()).toBe(1);
  });
  it("(b) task without a URL (Jev picks the site): Chrome launches only after the plan resolved", async () => {
    const t = gated("open gmail or drive and click English", { pages: { home: HOME }, start: "home" }, {}, { unset: ["goal"] });
    const run = t.runner.run();
    await tick();
    expect(t.events).toEqual(["plan:ask"]);
    t.gate.resolve();
    const r = await run;
    expect(r.outcome).toBe("blocked");
    expect(r.blocked?.kind).toBe("no_start_url");
    expect(t.events).toEqual(["plan:ask", "plan:resolve"]);
    expect(t.launches()).toBe(0);
    expect(t.log.lines).not.toContain(OVERLAP_LINE);
    const s = gated("open gmail or drive and click English", { pages: { home: HOME }, start: "home" }, {}, { unset: ["goal"], plan: { site: { choice: "gmail", confidence: 0.9 }, goal: "act" } });
    const run2 = s.runner.run();
    await tick();
    expect(s.events).toEqual(["plan:ask"]);
    s.gate.resolve();
    const r2 = await run2;
    expect(r2.outcome).toBe("done");
    expect(s.events).toEqual(["plan:ask", "plan:resolve", "chrome", "navigate"]);
    expect(r2.start).toMatchObject({ url: "https://mail.google.com", how: "catalog_jev" });
    expect(s.oracle.requests.map((x) => x.name)).toEqual(["plan", "step"]);
    expect(s.log.lines).not.toContain(OVERLAP_LINE);
  });
  it("(c) navigate rejects during the overlap: failed with error.kind browser; chrome closed exactly once", async () => {
    const t = gated("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" }, {}, { unset: ["goal"], navigateFails: Object.assign(new Error("net::ERR_NAME_NOT_RESOLVED"), { name: "CdpError" }) });
    const run = t.runner.run();
    await tick();
    expect(t.events).toContain("navigate");
    expect(t.events).not.toContain("plan:resolve");
    t.gate.resolve();
    const r = await run;
    expect(r.outcome).toBe("failed");
    expect(r.error).toEqual({ kind: "browser", message: "net::ERR_NAME_NOT_RESOLVED" });
    expect(t.oracle.requests.map((x) => x.name)).toEqual(["plan"]);
    expect(t.chrome.closes).toBe(1);
    expect(r.steps).toHaveLength(0);
  });
  it("(d) the plan throws a TypeSafeError during the overlap: failed with kind jev; chrome closed", async () => {
    const t = gated("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" }, {}, { unset: ["goal"] });
    const run = t.runner.run();
    await tick();
    expect(t.events).toEqual(expect.arrayContaining(["chrome", "navigate", "plan:ask"]));
    t.gate.reject(new TypeSafeError("rate limited"));
    const r = await run;
    expect(r.outcome).toBe("failed");
    expect(r.error).toEqual({ kind: "jev", message: "rate limited" });
    expect(t.chrome.closes).toBe(1);
    expect(t.runner.page).toBe(t.page);
    expect(r.stats.jev_requests).toBe(0);
  });
  it("(e) chat: a page is present and the task names a URL: navigate starts before the plan resolves; no openPage", async () => {
    let opened = 0;
    const t = gated("open https://en.wikipedia.org/wiki/Alan_Turing and read", { pages: { home: HOME, a: ARTICLE }, start: "home", transitions: (c) => (c.op === "navigate" ? "a" : undefined) }, { keepOpen: true }, { providePage: true, unset: ["goal"] });
    (t.runner as unknown as { deps: FastRunnerDeps }).deps.openPage = async () => { opened += 1; return t.page; };
    const run = t.runner.run();
    await tick();
    expect(t.events).toContain("navigate");
    expect(t.events).not.toContain("plan:resolve");
    t.gate.resolve();
    const r = await run;
    expect(r.outcome).toBe("done");
    expect(opened).toBe(0);
    expect(t.page.calls[0]).toEqual({ op: "navigate", url: "https://en.wikipedia.org/wiki/Alan_Turing" });
    expect(t.chrome.closes).toBe(0);
    expect(t.runner.page).toBe(t.page);
  });
  it("(f) current_page: no navigate; Chrome is asked for only after the plan resolved; without a page the run blocks and never launches", async () => {
    const t = gated("click the English link", { pages: { home: HOME }, start: "home" }, { fallbackUrl: HOME.url, keepOpen: true }, { providePage: true, unset: ["goal"] });
    const run = t.runner.run();
    await tick();
    expect(t.events).toEqual(["plan:ask"]);
    t.gate.resolve();
    const r = await run;
    expect(r.outcome).toBe("done");
    expect(t.events).toEqual(["plan:ask", "plan:resolve", "chrome"]);
    expect(r.start).toMatchObject({ how: "current_page" });
    expect(t.log.lines).not.toContain(OVERLAP_LINE);
    expect(t.log.lines.some((l) => l.includes(`continue on ${HOME.url}`))).toBe(true);
    const n = gated("click the English link", { pages: { home: HOME }, start: "home" }, { fallbackUrl: HOME.url }, { unset: ["goal"] });
    const run2 = n.runner.run();
    await tick();
    n.gate.resolve();
    const r2 = await run2;
    expect(r2.blocked?.kind).toBe("no_start_url");
    expect(n.events).toEqual(["plan:ask", "plan:resolve"]);
    expect(n.launches()).toBe(0);
  });
  it("(g) --goal given + URL: the warm hook fires as the Chrome launch starts; the plan sends 0 requests; no overlap line", async () => {
    const t = gated("open wikipedia.org and click English", { pages: { home: HOME }, start: "home" });
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(t.events).toEqual(["warm", "chrome", "navigate"]);
    expect(t.oracle.requests.map((x) => x.name)).toEqual(["step"]);
    expect(t.log.lines).not.toContain(OVERLAP_LINE);
    expect(t.log.lines.filter((l) => l.startsWith("INFO plan ")).at(0)).toContain("requests=0");
  });
});


describe("review regressions: Enter and secrets", () => {
  it.each([false, true])("Enter with confirm=always and user approval %s", async (allowed) => {
    const human = fakeHuman({ interactive: true, confirm: [allowed] });
    const t = setup("open example.com and submit", { pages: { home: HOME }, start: "home" },
      () => ({ page_kind: "task_page", operation: "PRESS_ENTER" }), { confirm: "always", maxSteps: 1 }, { human });
    const r = await t.runner.run();
    expect(human.prompts.filter((p) => p.startsWith("confirm:"))).toHaveLength(1);
    expect(t.page.calls.some((c) => c.op === "press")).toBe(allowed);
    if (!allowed) expect(r.blocked?.kind).toBe("needs_confirmation");
    expect(r.steps[0]?.risk).toBe("submit");
  });

  it.each(["always", "never"] as const)("Enter cannot bypass %s on a destructive form", async (confirm) => {
    const form = { ...HOME, focus: { node: 1, label: "Name", role: "textbox", submitLabel: "Delete account", editable: true, value: "test account" } };
    const t = setup("open example.com and submit", { pages: { form }, start: "form" },
      () => ({ page_kind: "task_page", operation: "PRESS_ENTER" }), { confirm, maxSteps: 1 });
    const r = await t.runner.run();
    expect(r.blocked?.kind).toBe("needs_confirmation");
    expect(r.steps[0]?.risk).toBe("destructive");
    expect(t.page.calls.some((c) => c.op === "press")).toBe(false);
  });

  it("keeps a typed secret out of later requests and the result while preserving browser input", async () => {
    const secret = 'secret"value\\with-newline\n';
    const initial = obs("https://example.com/form", [el("e1", "fill", "Verification code", "textbox", { value: "" })]);
    const filled = obs("https://example.com/form", [el("e1", "fill", "Verification code", "textbox", { value: secret })], `Echo: ${secret}`,
      { title: `Title: ${secret}`, focus: { node: 1, label: secret, role: "textbox", submitLabel: "Verify" } });
    const t = setup("open example.com and verify", { pages: { initial, filled }, start: "initial", transitions: (c) => c.op === "act" ? "filled" : undefined },
      (_name, state) => (state as { recent_actions: unknown[] }).recent_actions.length === 0
        ? { page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: "1", type_text_value: "v_otp" }
        : { page_kind: "task_page", operation: "DONE" }, { vars: { otp: secret } });
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(t.page.calls.find((c) => c.op === "act")?.text).toBe(secret);
    expect(JSON.stringify(t.oracle.requests)).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(r.final_title).toBe("Title: ***");
    expect(filled.actions[0]?.value).toBe(secret);
  });
});


describe("uncertain decision recovery", () => {
  it("observes new chat controls after a rejected click and fills before sending", async () => {
    const url = "https://example.com/dashboard";
    const initial = obs(url, [el("e1", "click", "Open user menu", "button")]);
    const ready = obs(url, [el("e1", "click", "Open user menu", "button"), el("e2", "click", "Open chat panel", "button")]);
    const editor = obs(url, [el("e3", "fill", "Message", "textbox", { value: "" })], "New chat");
    const filled = obs(url, [el("e3", "fill", "Message", "textbox", { value: "List my latest meetings" })], "New chat", { focus: { node: 3, label: "Message", role: "textbox", submitLabel: "Send" } });
    const sent = obs(url, [], "Message sent: List my latest meetings");
    let decisions = 0;
    const t = setup('open example.com and type "List my latest meetings" in a new chat and send it', {
      pages: { initial, ready, editor, filled, sent }, start: "initial",
      transitions: (c) => c.op === "press" ? "sent" : c.op === "act" ? c.kind === "fill" ? "filled" : "editor" : undefined,
    }, (_name, state, questions) => {
      decisions += 1;
      if (decisions === 1) {
        t.page.current = "ready";
        return { operation: "CLICK", click_target: { choice: "1", confidence: 0.21 } };
      }
      if (decisions === 2) {
        expect((state as { retry_reason: string }).retry_reason).toContain("was not executed: low_target");
        expect(JSON.stringify(questions.click_target)).not.toContain("Open user menu");
        return { operation: "CLICK", click_target: idx(questions, "click_target", "Open chat panel") };
      }
      if (decisions === 3) return { operation: "TYPE_TEXT", type_text_target: "1", type_text_value: "v_message" };
      if (decisions === 4) return { operation: "PRESS_ENTER" };
      return { operation: "DONE" };
    }, { vars: { message: "List my latest meetings" } }, { human: fakeHuman({ interactive: true, confirm: [true] }) });
    const r = await t.runner.run();
    expect(r.outcome, JSON.stringify({ reason: r.reason, logs: t.log.lines })).toBe("done");
    expect(t.page.calls.filter((c) => c.op !== "navigate")).toEqual([
      { op: "act", id: "e2", kind: "click" },
      { op: "act", id: "e3", kind: "fill", text: "List my latest meetings" },
      { op: "press", key: "Enter" },
    ]);
    expect(r.steps[0]?.gate).toMatch(/^ok/);
    expect(t.human.prompts.some((prompt) => prompt.includes("press Enter"))).toBe(true);
    expect(t.log.lines.some((line) => line.includes("retry 1/1"))).toBe(true);
  });

  it("retries uncertain Enter by filling the message and then submitting", async () => {
    const editor = obs("https://example.com/chat", [el("e1", "fill", "Message", "textbox", { value: "" })]);
    let calls = 0;
    const t = setup('open example.com and type "List my latest meetings" and send it', { pages: { editor }, start: "editor" }, (_name, state) => {
      calls += 1;
      if (calls === 1) return { operation: { choice: "PRESS_ENTER", confidence: 0.3 } };
      if (calls === 2) {
        expect((state as { retry_reason: string }).retry_reason).toContain("Enter confidence 0.30 below 0.5");
        return { operation: "TYPE_TEXT", type_text_target: "1", type_text_value: "v_message" };
      }
      if (calls === 3) return { operation: "PRESS_ENTER" };
      return { operation: "DONE" };
    }, { vars: { message: "List my latest meetings" }, engine: "chromium" });
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(t.page.calls.filter((c) => c.op !== "navigate").map((c) => c.op)).toEqual(["act", "press"]);
    expect(r.steps[0]?.risk).toBe("data_entry");
    expect(r.steps[1]?.target).toBeNull();
    expect(t.log.lines.some((line) => line.includes("engine=chromium"))).toBe(true);
  });

  it("blocks repeated uncertain Enter without sending a key", async () => {
    const editor = obs("https://example.com/chat", []);
    const t = setup("open example.com and send", { pages: { editor }, start: "editor" }, () => ({ operation: { choice: "PRESS_ENTER", confidence: 0.3 } }));
    const r = await t.runner.run();
    expect(r.blocked?.kind).toBe("ambiguous");
    expect(r.steps[0]?.jev_requests).toBe(2);
    expect(t.page.calls.some((c) => c.op === "press")).toBe(false);
  });
});


describe("empty editor execution guard", () => {
  it("never sends Enter when a model returns it for an empty editor", async () => {
    const editor = obs("https://example.com/chat", [el("e1", "fill", "Message", "textbox", { value: "" })], "", {
      focus: { node: 1, label: "Message", role: "textbox", submitLabel: "Send", editable: true, value: "" },
    });
    const t = setup('open example.com and type "List my latest meetings" and send it', { pages: { editor }, start: "editor" },
      () => ({ operation: "PRESS_ENTER" }));
    const r = await t.runner.run();
    expect(r.outcome).toBe("blocked");
    expect(r.reason).toContain("Enter unavailable");
    expect(t.page.calls.some((call) => call.op === "press")).toBe(false);
  });
});
