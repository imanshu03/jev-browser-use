import { TypeSafeError } from "@typesafe-ai/sdk";
import type { Questions, ChoiceQuestion } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { BrowserError } from "../src/browser.js";
import { Runner, act, varForField } from "../src/loop.js";
import type { RunConfig } from "../src/types.js";
import { fakeBrowser, fakeHuman, fakeLogger, fakeOracle, snap, type BrowserScript, type FakePage, type OracleScript, type PartialAnswers } from "./fakes.js";

const PROFILES = [{ directory: "Profile 14", name: "Parallelloop" }, { directory: "Profile 2", name: "BP" }];
const HOME: FakePage = { url: "https://www.wikipedia.org/", title: "Wikipedia", interactive: snap('- searchbox "Search Wikipedia" [ref=e34]\n- link "English" [ref=e8, url=https://en.wikipedia.org/]\n- button "Search" [ref=e32]'), text: "Wikipedia\nThe Free Encyclopedia" };
const ARTICLE: FakePage = {
  url: "https://en.wikipedia.org/wiki/Alan_Turing", title: "Alan Turing - Wikipedia",
  interactive: snap('- heading "Alan Turing" [level=1, ref=e1]\n- link "Main menu" [ref=e2]'),
  full: snap('- heading "Alan Turing" [level=1, ref=e1]\n- paragraph\n  - StaticText "Alan Turing was a mathematician."\n- link "Main menu" [ref=e2]'),
  text: "Alan Turing\nAlan Turing was a mathematician.",
};
const page = (url: string, tree: string, text = "page"): FakePage => ({ url, title: "T", interactive: snap(tree), text });

function cfg(task: string, over: Partial<RunConfig> = {}): RunConfig {
  return { task, headed: false, maxSteps: 8, stepTimeoutMs: 1000, runTimeoutMs: 60_000, pauseTimeoutMs: 1000, confirm: "auto", dryRun: false, session: "jev-test", model: "m", logLevel: "info", logJson: false, keepOpen: false, agentBrowserBin: "ab", vars: {}, profile: "none", ...over };
}

/** Label of the criteria entry whose text (or element name) equals `text`. */
function labelOf(questions: Questions, name: string, text: string): string {
  const q = questions[name] as ChoiceQuestion | undefined;
  for (const [label, v] of Object.entries(q?.criteria ?? {})) {
    const o = v as Record<string, unknown> | string | null;
    if (o && typeof o === "object" && (o["text"] === text || String(o["element"] ?? "").includes(`"${text}"`))) return label;
    if (o === text) return label;
  }
  throw new Error(`no label for ${text} in ${name}: ${Object.keys(q?.criteria ?? {}).join(",")}`);
}

function setup(task: string, script: BrowserScript, oracle: OracleScript, over: Partial<RunConfig> = {}, human = fakeHuman({ interactive: false }), now?: () => number) {
  const browser = fakeBrowser({ profiles: PROFILES, ...script });
  const o = fakeOracle(oracle);
  const log = fakeLogger();
  const dirs: (string | undefined)[] = [];
  const runner = new Runner({ cfg: cfg(task, over), browserFor: (d) => { dirs.push(d); return browser; }, oracle: o, human, log, ...(now ? { now } : {}) });
  return { runner, browser, oracle: o, log, dirs, human };
}
const byUrl = (map: Record<string, PartialAnswers | ((q: Questions) => PartialAnswers)>, other: Record<string, PartialAnswers> = {}) => (name: string, state: unknown, q: Questions): PartialAnswers => {
  if (name === "observe") {
    const url = ((state as { page: { url: string } }).page.url);
    const a = map[url];
    return typeof a === "function" ? a(q) : a ?? {};
  }
  return other[name] ?? {};
};
const TASK = "open wikipedia.org and search for Alan Turing, then tell me the title of the article";

describe("Runner happy path", () => {
  it("wikipedia: fast-path fill + Enter, DONE -> EXTRACT -> VERIFY -> done with the line text", async () => {
    const t = setup(TASK, { pages: { home: HOME, article: ARTICLE }, start: "home", transitions: (call) => (call[0] === "press" && call[1] === "Enter" ? "article" : undefined) },
      byUrl({
        [HOME.url]: (q) => ({ page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: "e34", value: { choice: labelOf(q, "value", "Alan Turing"), confidence: 0.95 }, submit_with_enter: 0.9 }),
        [ARTICLE.url]: { page_kind: "task_page", operation: "DONE" },
      }, { plan: { goal: "extract" }, extract: { answer_0: { choice: "L1", confidence: 0.6, probabilities: { L1: 0.6, none: 0.4 } } }, verify: { done_final: 0.9, answer_ok: 0.9, evidence_0: { choice: "L2", confidence: 0.5, probabilities: { L2: 0.5 } } } }));
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(r.goal).toBe("extract");
    expect(r.answer).toEqual({ kind: "extract", text: "heading: Alan Turing", line_id: "L1", evidence: ["text: Alan Turing was a mathematician."] });
    expect(r.final_url).toBe(ARTICLE.url);
    expect(t.oracle.requests.map((x) => x.name)).toEqual(["plan", "observe", "observe", "extract", "verify"]);
    expect(t.browser.calls).toContainEqual(["fill", "@e34", "Alan Turing"]);
    expect(t.browser.calls).toContainEqual(["press", "Enter"]);
    expect(t.browser.calls[t.browser.calls.length - 1]).toEqual(["close"]);
    expect(r.steps[0]).toMatchObject({ step: 1, operation: "TYPE_TEXT", action: "fill", value: "Alan Turing", path: "fast", gate: "ok:high", result: "ok", jev_requests: 1 });
    expect(r.steps[1]).toMatchObject({ step: 2, operation: "DONE", result: "done", jev_requests: 3 });
    expect(r.stats.jev_requests).toBe(5);
    expect(r.profile).toBeNull();
    expect(r.start).toEqual({ url: "https://wikipedia.org", how: "task_url", confidence: null });
  });
  it("current_page: does not open, waitLoad, or waitMs; logs continue on; keepOpen leaves the browser open", async () => {
    const t = setup("click the English link", { pages: { home: HOME, article: ARTICLE }, start: "home", transitions: (c) => (c[0] === "click" && c[1] === "@e8" ? "article" : undefined) },
      byUrl({ [HOME.url]: { page_kind: "task_page", operation: "CLICK", click_target_0: "e8" }, [ARTICLE.url]: { page_kind: "task_page", operation: "DONE" } }, { plan: { goal: "act" }, verify: { done_final: 0.9 } }),
      { fallbackUrl: HOME.url, keepOpen: true });
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(r.start).toEqual({ url: HOME.url, how: "current_page", confidence: null });
    expect(t.browser.calls.some((c) => c[0] === "open")).toBe(false);
    const firstSnapshot = t.browser.calls.findIndex((c) => c[0] === "snapshot");
    expect(t.browser.calls.slice(0, firstSnapshot).map((c) => c[0])).toEqual(["profiles", "get", "get"]);
    expect(t.browser.calls.some((c) => c[0] === "close")).toBe(false);
    expect(t.browser.calls).toContainEqual(["click", "@e8"]);
    expect(t.log.lines).toContainEqual(`INFO continue on ${HOME.url} session=jev-test`);
    expect(t.log.lines.some((l) => l.startsWith("INFO open "))).toBe(false);
    expect(r.final_url).toBe(ARTICLE.url);
  });
  it("uses the workspace default profile when the task names none", async () => {
    const t = setup("open https://a.b and click English", { pages: { home: HOME }, start: "home" }, byUrl({ [HOME.url]: { operation: "BLOCKED", page_kind: "task_page" } }, { plan: { goal: "act" } }), { profile: undefined as unknown as string });
    delete (t.runner as unknown as { cfg: RunConfig }).cfg.profile;
    const r = await t.runner.run();
    expect(r.profile).toEqual({ directory: "Profile 14", name: "Parallelloop", how: "workspace_default" });
    expect(t.dirs).toEqual([undefined, "Profile 14"]);
    expect(r.outcome).toBe("blocked");
    expect(r.blocked?.kind).toBe("impossible");
  });
  it("plain click at 0.9 takes the fast path with no CONFIRM; page_changed is recorded", async () => {
    const t = setup("open wikipedia.org and open the English edition", { pages: { home: HOME, article: ARTICLE }, start: "home", transitions: (c) => (c[0] === "click" && c[1] === "@e8" ? "article" : undefined) },
      byUrl({ [HOME.url]: { page_kind: "task_page", operation: "CLICK", click_target_0: "e8" }, [ARTICLE.url]: { page_kind: "task_page", operation: "DONE" } }, { plan: { goal: "act" }, verify: { done_final: 0.9 } }));
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(t.oracle.requests.map((x) => x.name)).toEqual(["plan", "observe", "observe", "verify"]);
    expect(r.steps[0]).toMatchObject({ action: "click", path: "fast", risk: "navigational", target: { ref: "e8", name: "English" } });
    expect(t.runner.st.history[0]).toMatchObject({ operation: "CLICK", target: 'link "English"', result: "ok", page_changed: true });
    expect(r.confidence).toBe(0.9);
  });
  it("click below 0.60 goes through CONFIRM and still acts when the action is confirmed", async () => {
    const t = setup("open wikipedia.org and open the English edition", { pages: { home: HOME, article: ARTICLE }, start: "home", transitions: (c) => (c[0] === "click" && c[1] === "@e8" ? "article" : undefined) },
      byUrl({ [HOME.url]: { page_kind: "task_page", operation: "CLICK", click_target_0: { choice: "e8", confidence: 0.45 } }, [ARTICLE.url]: { page_kind: "task_page", operation: "DONE" } }, { plan: { goal: "act" }, confirm: { action: "click", in_task_scope: 0.9 }, verify: { done_final: 0.9 } }));
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(t.oracle.requests.map((x) => x.name)).toEqual(["plan", "observe", "confirm", "observe", "verify"]);
    expect(r.steps[0]).toMatchObject({ path: "confirm", result: "ok" });
  });
});

describe("destructive and credentials", () => {
  const DEL = page("https://x/", '- link "Delete account" [ref=e1]\n- link "Home" [ref=e2]');
  const obs = byUrl({ [DEL.url]: { page_kind: "task_page", operation: "CLICK", click_target_0: "e1", irreversible: 0.8 } }, { plan: { goal: "act" }, confirm: { action: "click", target_ok: 0.95, irreversible: 0.9, in_task_scope: 0.95 } });
  it("human no -> blocked needs_confirmation; yes -> click runs; --confirm never -> blocked", async () => {
    const no = setup("delete my account on https://x/", { pages: { d: DEL }, start: "d" }, obs, {}, fakeHuman({ interactive: true, confirm: [false] }));
    const r1 = await no.runner.run();
    expect(r1.blocked?.kind).toBe("needs_confirmation");
    expect(no.human.prompts.some((p) => p.startsWith("confirm:About to click"))).toBe(true);
    expect(no.browser.calls.some((c) => c[0] === "click")).toBe(false);
    const yes = setup("delete my account on https://x/", { pages: { d: DEL }, start: "d" }, obs, { maxSteps: 1 }, fakeHuman({ interactive: true, confirm: [true] }));
    const r2 = await yes.runner.run();
    expect(yes.browser.calls).toContainEqual(["click", "@e1"]);
    expect(r2.steps[0]).toMatchObject({ risk: "destructive", path: "confirm", result: "ok" });
    const never = setup("delete my account on https://x/", { pages: { d: DEL }, start: "d" }, obs, { confirm: "never" }, fakeHuman({ interactive: true, confirm: [true] }));
    expect((await never.runner.run()).blocked?.kind).toBe("needs_confirmation");
    const nonTty = setup("delete my account on https://x/", { pages: { d: DEL }, start: "d" }, obs);
    expect((await nonTty.runner.run()).blocked?.hint).toContain("TTY");
  });
  it("credential field without var -> needs_credential; with --var it fills and redacts", async () => {
    const LOGIN = page("https://x/login", '- textbox "Email" [ref=e1]\n- textbox "Password" [ref=e2]\n- button "Sign in" [ref=e3]');
    const obs2 = byUrl({ [LOGIN.url]: { page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: "e2" } }, { plan: { goal: "act" } });
    const noVar = setup("log in at https://x/login", { pages: { l: LOGIN }, start: "l" }, obs2);
    const r1 = await noVar.runner.run();
    expect(r1.blocked?.kind).toBe("needs_credential");
    expect(r1.blocked?.hint).toContain("--var");
    const withVar = setup("log in at https://x/login", { pages: { l: LOGIN }, start: "l" }, obs2, { vars: { password: "hunter2" }, maxSteps: 1 });
    const r2 = await withVar.runner.run();
    expect(withVar.browser.calls).toContainEqual(["fill", "@e2", "hunter2"]);
    expect(r2.steps[0]).toMatchObject({ action: "fill", value: "***", path: "code", value_conf: 1, result: "ok" });
    expect(JSON.stringify(r2)).not.toContain("hunter2");
    expect(withVar.runner.st.history[0]?.value).toBe("***");
    expect(withVar.log.lines.join("\n")).not.toContain("hunter2");
    expect(t2Requests(withVar.oracle.requests.map((x) => x.name))).toEqual(["plan", "observe"]);
  });
  it("--var email fills the Email textbox without a value question", async () => {
    const LOGIN = page("https://x/login", '- textbox "Email" [ref=e1]\n- textbox "Password" [ref=e2]');
    const t = setup("log in at https://x/login", { pages: { l: LOGIN }, start: "l" }, byUrl({ [LOGIN.url]: { page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: "e1" } }, { plan: { goal: "act" } }), { vars: { email: "a@b.c" }, maxSteps: 1 });
    await t.runner.run();
    expect(t.browser.calls).toContainEqual(["fill", "@e1", "a@b.c"]);
    expect(t.oracle.requests.map((x) => x.name)).toEqual(["plan", "observe"]);
    expect(varForField({ ref: "e1", role: "textbox", name: "Work Email", depth: 0, under: "", key: "", attrs: {}, state: "", value: "", seen: 1, index: 0 }, { email: "z" })).toEqual({ key: "email", text: "z" });
  });
});
const t2Requests = (n: string[]) => n.slice(0, 2);

describe("covered clicks and overlays", () => {
  const covered = () => ({ error: new BrowserError("covered", "Element '@e1' is covered by <div#banner> at its click point", "", "<div#banner>") });
  const P = page("https://x/", '- button "Open" [ref=e1]\n- link "Next" [ref=e3]');
  const P2 = page("https://x/", '- button "Open" [ref=e1]\n- button "Accept all" [ref=e2]\n- link "Next" [ref=e3]');
  const DONE = page("https://x/done", '- heading "Done" [ref=e1]');
  it("covered once -> scrollintoview then click succeeds in code, no request", async () => {
    let n = 0;
    const t = setup("open https://x/ and press Open", { pages: { p: P, d: DONE }, start: "p", transitions: (c) => { if (c[0] === "click" && c[1] === "@e1") { n += 1; return n === 1 ? covered() : "d"; } return undefined; } },
      byUrl({ [P.url]: { page_kind: "task_page", operation: "CLICK", click_target_0: "e1" }, [DONE.url]: { page_kind: "task_page", operation: "DONE" } }, { plan: { goal: "act" }, verify: { done_final: 0.9 } }));
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(t.browser.calls).toContainEqual(["scrollintoview", "@e1"]);
    expect(t.browser.calls.filter((c) => c[0] === "click" && c[1] === "@e1").length).toBe(2);
    expect(t.oracle.requests.map((x) => x.name)).not.toContain("recover");
  });
  it("covered twice on the same page -> Escape, then RECOVER dismisses, then the click succeeds", async () => {
    let clicks = 0;
    const t = setup("open https://x/ and press Open", { pages: { p: P2, clean: P, d: DONE }, start: "p", transitions: (c) => { if (c[0] === "click" && c[1] === "@e2") return "clean"; if (c[0] === "click" && c[1] === "@e1") { clicks += 1; return clicks <= 6 ? covered() : "d"; } return undefined; } },
      byUrl({ [P.url]: { page_kind: "task_page", operation: "CLICK", click_target_0: "e1" }, [DONE.url]: { page_kind: "task_page", operation: "DONE" } }, { plan: { goal: "act" }, recover: { is_dismissible: 0.9, dismiss_target: "e2" }, verify: { done_final: 0.9 } }));
    const r = await t.runner.run();
    expect(r.steps.map((s) => s.result)).toEqual(["failed", "recovered", "ok", "done"]);
    expect(t.browser.calls).toContainEqual(["press", "Escape"]);
    expect(t.browser.calls).toContainEqual(["click", "@e2"]);
    expect(t.oracle.requests.map((x) => x.name)).toContain("recover");
    expect(r.steps[1]).toMatchObject({ gate: "recover", target: { ref: "e2" } });
  });
  it("consent banner page kind: Escape changes the fingerprint -> no RECOVER; cannot dismiss -> blocked overlay", async () => {
    const BANNER = page("https://x/", '- button "Open" [ref=e1]\n- dialog "Cookies" [ref=e9]\n  - button "Accept all" [ref=e2]');
    const t = setup("open https://x/ and press Open", { pages: { b: BANNER, p: P, d: DONE }, start: "b", transitions: (c, cur) => (c[0] === "press" && c[1] === "Escape" && cur === "b" ? "p" : c[0] === "click" && c[1] === "@e1" ? "d" : undefined) },
      byUrl({ [P.url]: (q) => ((q["click_target_0"] as ChoiceQuestion).criteria["e2"] ? { page_kind: "consent_or_cookie_banner", operation: "CLICK", click_target_0: "e1" } : { page_kind: "task_page", operation: "CLICK", click_target_0: "e1" }), [DONE.url]: { page_kind: "task_page", operation: "DONE" } }, { plan: { goal: "act" }, verify: { done_final: 0.9 } }));
    const r = await t.runner.run();
    expect(r.steps[0]).toMatchObject({ result: "recovered", gate: "escape" });
    expect(t.oracle.requests.map((x) => x.name)).not.toContain("recover");
    expect(r.outcome).toBe("done");
    const stuck = setup("open https://x/ and press Open", { pages: { b: BANNER }, start: "b" }, byUrl({ [P.url]: { page_kind: "blocking_dialog", operation: "CLICK", click_target_0: "e1" } }, { plan: { goal: "act" }, recover: { is_dismissible: 0.2, dismiss_target: "none" } }));
    const r2 = await stuck.runner.run();
    expect(r2.blocked?.kind).toBe("overlay");
  });
  it("unknown_ref re-observes once within the same step; timeout waits and re-observes; tab_gone fails", async () => {
    let first = true;
    const t = setup("open https://x/ and press Open", { pages: { p: P, d: DONE }, start: "p", transitions: (c) => { if (c[0] === "click" && c[1] === "@e1") { if (first) { first = false; return { error: new BrowserError("unknown_ref", "Unknown ref: e1", "") }; } return "d"; } return undefined; } },
      byUrl({ [P.url]: { page_kind: "task_page", operation: "CLICK", click_target_0: "e1" }, [DONE.url]: { page_kind: "task_page", operation: "DONE" } }, { plan: { goal: "act" }, verify: { done_final: 0.9 } }));
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(r.steps[0]?.step).toBe(1);
    expect(r.steps[0]?.jev_requests).toBe(2);
    const gone = setup("open https://x/ and press Open", { pages: { p: P }, start: "p", transitions: (c) => (c[0] === "click" ? { error: new BrowserError("tab_gone", "tab closed", "") } : undefined) }, byUrl({ [P.url]: { page_kind: "task_page", operation: "CLICK", click_target_0: "e1" } }, { plan: { goal: "act" } }));
    const r2 = await gone.runner.run();
    expect(r2.outcome).toBe("failed");
    expect(r2.error?.kind).toBe("browser");
  });
});

describe("sign-in walls and pauses", () => {
  const WALL = page("https://accounts.google.com/signin", '- heading "Choose an account" [level=1, ref=e1]\n- button "Use another account" [ref=e2]');
  const APP = page("https://mail.google.com/mail/u/0/", '- link "Inbox" [ref=e1]');
  it("headless -> blocked needs_sign_in with resume, top-3 and a --headed hint; probability 0.35 + heuristic -> same", async () => {
    const t = setup("open mail.google.com and read the newest email", { pages: { w: WALL }, start: "w" }, byUrl({ [WALL.url]: { page_kind: { choice: "sign_in_wall", confidence: 0.95 }, operation: "BLOCKED" } }, { plan: { goal: "extract" } }));
    const r = await t.runner.run();
    expect(r.blocked).toMatchObject({ kind: "needs_sign_in", resume: { session: "jev-test", url: WALL.url } });
    expect(r.blocked?.hint).toContain("--headed");
    expect(r.blocked?.top[0]).toEqual({ label: "sign_in_wall", p: 0.95 });
    const t2 = setup("open mail.google.com and read the newest email", { pages: { w: WALL }, start: "w" }, byUrl({ [WALL.url]: { page_kind: { choice: "task_page", confidence: 0.5, probabilities: { task_page: 0.5, sign_in_wall: 0.35, captcha_or_bot_check: 0.15 } }, operation: "CLICK", click_target_0: "e2" } }, { plan: { goal: "extract" } }));
    expect((await t2.runner.run()).blocked?.kind).toBe("needs_sign_in");
  });
  it("headed: pause resumes, second wall pauses again, third blocks; non-TTY poll asks wall", async () => {
    let walls = 0;
    const script = byUrl({ [WALL.url]: { page_kind: "sign_in_wall", operation: "BLOCKED" }, [APP.url]: { page_kind: "task_page", operation: "DONE" } }, { plan: { goal: "act" }, verify: { done_final: 0.9 } });
    const t = setup("open mail.google.com", { pages: { w: WALL, a: APP }, start: "w", transitions: (c) => { if (c[0] === "get" && c[1] === "url") { return undefined; } return undefined; } }, script, { headed: true }, fakeHuman({ interactive: true, pause: ["resumed", "resumed"] }));
    const origPause = t.human.pause.bind(t.human);
    t.human.pause = async (m, ms, poll) => { walls += 1; t.browser.current = walls >= 3 ? "a" : "w"; return origPause(m, ms, poll); };
    const r = await t.runner.run();
    expect(r.steps.map((s) => s.result)).toEqual(["paused", "paused", "blocked"]);
    expect(r.stats.pauses).toBe(2);
    expect(r.blocked?.kind).toBe("needs_sign_in");
    const poll = setup("open mail.google.com", { pages: { w: WALL, a: APP }, start: "w" }, (name, state, q) => {
      if (name === "wall") { poll.browser.current = "a"; return { wall: { choice: "app_page", confidence: 0.8 } }; }
      return script(name, state, q);
    }, { headed: true }, fakeHuman({ interactive: false }));
    const r2 = await poll.runner.run();
    expect(poll.oracle.requests.map((x) => x.name)).toContain("wall");
    expect(r2.steps.map((s) => s.result)).toEqual(["paused", "done"]);
    expect(poll.runner.st.history[0]).toMatchObject({ operation: "HUMAN_SIGNIN" });
    expect(poll.human.prompts[0]).toContain("pause:(needs_sign_in)");
  });
});

describe("select, keys, urls, tournament, code actions", () => {
  it("SELECT from the head at >= 0.60 runs select @ref label; below it CONFIRMs select_option", async () => {
    const SEL = page("https://x/", '- combobox "Language" [ref=e4]: English\n  - option "English" [selected, ref=e5]\n  - option "Deutsch" [ref=e6]');
    const t = setup("open https://x/ and set language to Deutsch", { pages: { s: SEL }, start: "s" }, byUrl({ [SEL.url]: { page_kind: "task_page", operation: "SELECT", select_target: { choice: "e4:1", confidence: 0.8 } } }, { plan: { goal: "act" } }), { maxSteps: 1 });
    await t.runner.run();
    expect(t.browser.calls).toContainEqual(["select", "@e4", "Deutsch"]);
    const low = setup("open https://x/ and set language to Deutsch", { pages: { s: SEL }, start: "s" }, byUrl({ [SEL.url]: { page_kind: "task_page", operation: "SELECT", select_target: { choice: "e4:1", confidence: 0.4 } } }, { plan: { goal: "act" }, confirm: { action: "select", select_option: { choice: "o1", confidence: 0.9 } } }), { maxSteps: 1 });
    await low.runner.run();
    expect(low.oracle.requests.map((x) => x.name)).toContain("confirm");
    expect(low.browser.calls).toContainEqual(["select", "@e4", "Deutsch"]);
  });
  it("press_key from a task literal and open_url over task URLs; GO_BACK; WAIT twice then scroll", async () => {
    const P = page("https://x/", '- link "A" [ref=e1]');
    const Y = page("https://y.z/", '- link "B" [ref=e1]');
    const t = setup("open https://x/ then press Cmd+K and go to https://y.z/", { pages: { p: P, y: Y }, start: "p", transitions: (c, cur) => (c[0] === "open" && c[1] === "https://y.z/" ? "y" : c[0] === "back" ? "p" : cur === "y" && c[0] === "wait" ? undefined : undefined) }, (name, _s, q) => {
      if (name === "plan") return { goal: "act" };
      const n = t.oracle.requests.filter((r) => r.name === "observe").length;
      const key = Object.keys((q["key"] as ChoiceQuestion).criteria).find((k) => k.startsWith("k")) ?? "none";
      const url = n === 2 ? labelOf(q, "open_url", "https://y.z/") : "none";
      return [{ operation: "PRESS_KEY", key }, { operation: "OPEN_URL", open_url: url }, { operation: "GO_BACK" }, { operation: "WAIT" }, { operation: "WAIT" }, { operation: "WAIT" }][n - 1] ?? {};
    }, { maxSteps: 6 });
    const r = await t.runner.run();
    expect(t.browser.calls).toContainEqual(["press", "Meta+k"]);
    expect(t.browser.calls).toContainEqual(["open", "https://y.z/"]);
    expect(t.browser.calls).toContainEqual(["back"]);
    expect(r.steps.map((s) => s.action)).toEqual(["press_key", "open_url", "go_back", "wait", "wait", "scroll_down", "none"]);
    expect(r.blocked?.kind).toBe("max_steps");
    expect(t.runner.st.history.map((h) => h.operation)).toEqual(["PRESS_KEY", "OPEN_URL", "GO_BACK", "WAIT", "WAIT", "SCROLL_DOWN"]);
  });
  it("450-link page: 2 click chunks in one OBSERVE, two winners -> TOURNAMENT -> click", async () => {
    const lines = Array.from({ length: 450 }, (_, i) => `- link "Item ${i}" [ref=e${i + 1}]`).join("\n");
    const BIG = page("https://x/", lines);
    const t = setup("open https://x/ and open Item 300", { pages: { b: BIG }, start: "b" }, byUrl({ [BIG.url]: { page_kind: "task_page", operation: "CLICK", click_target_0: { choice: "e5", confidence: 0.4, probabilities: { e5: 0.4, none: 0.6 } }, click_target_1: { choice: "e301", confidence: 0.5, probabilities: { e301: 0.5, none: 0.5 } } } }, { plan: { goal: "act" }, tournament: { target_final: { choice: "e301", confidence: 0.9 } } }), { maxSteps: 1 });
    const r = await t.runner.run();
    const obs = t.oracle.requests.find((x) => x.name === "observe");
    expect(Object.keys(obs?.questions ?? {}).filter((k) => k.startsWith("click_target_"))).toEqual(["click_target_0", "click_target_1"]);
    expect(t.oracle.requests.map((x) => x.name)).toEqual(["plan", "observe", "tournament"]);
    expect(t.browser.calls).toContainEqual(["click", "@e301"]);
    expect(r.steps[0]).toMatchObject({ target: { ref: "e301" }, target_conf: 0.9, result: "ok" });
  });
});

describe("loop detection, gates, finishing", () => {
  const P = page("https://x/", '- link "A" [ref=e1]\n- link "B" [ref=e2]\n- link "C" [ref=e3]');
  it("three actions without a page change -> loop_detected", async () => {
    const t = setup("open https://x/ and click around", { pages: { p: P }, start: "p" }, (name, _s) => {
      if (name === "plan") return { goal: "act" };
      const n = t.oracle.requests.filter((r) => r.name === "observe").length;
      return { page_kind: "task_page", operation: "CLICK", click_target_0: `e${n}` };
    });
    const r = await t.runner.run();
    expect(r.blocked?.kind).toBe("loop_detected");
    expect(r.steps.map((s) => s.result)).toEqual(["ok", "ok", "ok", "blocked"]);
    expect(t.runner.st.history.every((h) => h.page_changed === false)).toBe(true);
  });
  it("loopCheck: repeated signature bans then blocks; fp repeats without a new signature blocks", () => {
    const st = { step: 10, fingerprints: ["f", "f", "f", "f", "g", "f"], actionSigs: new Map([["s", 2]]), lastNewSigStep: 2 } as unknown as Parameters<typeof Runner.loopCheck>[0];
    expect(Runner.loopCheck(st, "f", "s")).toBe("ban_target");
    st.actionSigs.set("s", 3);
    expect(Runner.loopCheck(st, "f", "s")).toBe("blocked");
    expect(Runner.loopCheck(st, "f", "new")).toBe("blocked");
    st.lastNewSigStep = 9;
    expect(Runner.loopCheck(st, "f", "new")).toBe("none");
    expect(Runner.loopCheck(st, "f", null)).toBe("none");
  });
  it("low target twice -> scroll once; third -> blocked ambiguous with top-3", async () => {
    const t = setup("open https://x/ and click the thing", { pages: { p: P }, start: "p" }, byUrl({ [P.url]: { page_kind: "task_page", operation: "CLICK", click_target_0: { choice: "e1", confidence: 0.22, probabilities: { e1: 0.22, e2: 0.2, e3: 0.2 } } } }, { plan: { goal: "act" }, confirm: { action: "click" } }));
    const r = await t.runner.run();
    expect(r.steps.map((s) => s.result)).toEqual(["skipped", "ok", "blocked"]);
    expect(r.steps[0]?.gate).toBe("low_target");
    expect(r.steps[1]?.action).toBe("scroll_down");
    expect(r.blocked?.kind).toBe("ambiguous");
  });
  it("VERIFY rejected twice suppresses DONE for two steps, then a later verify succeeds", async () => {
    let verifies = 0;
    const t = setup("open https://x/ and finish", { pages: { p: P }, start: "p" }, (name) => {
      if (name === "plan") return { goal: "act" };
      if (name === "verify") { verifies += 1; return { done_final: verifies <= 2 ? 0.2 : 0.95 }; }
      return { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.7, probabilities: { DONE: 0.7, CLICK: 0.2, WAIT: 0.1 } }, click_target_0: "e1" };
    });
    const r = await t.runner.run();
    expect(r.steps.map((s) => s.gate)).toEqual(["verify_failed", "verify_failed", "ok:high", "ok:high", "verify"]);
    expect(r.outcome).toBe("done");
    expect(t.runner.st.doneRejections).toBe(2);
  });
  it("check goal: DONE + answer_state yes -> done with probability and evidence; low confidence holds then blocks with answer unknown", async () => {
    const DASH = page("https://app/dash", '- button "Licious Sept3 Session" [ref=e1]\n- link "Home" [ref=e2]');
    const t = setup("open https://app/dash and check if the project has Sept 3 artifacts", { pages: { d: DASH }, start: "d" }, byUrl({ [DASH.url]: { page_kind: "task_page", operation: "DONE", answer_state: { choice: "yes", confidence: 0.8, probabilities: { yes: 0.8, no: 0.1, not_visible_yet: 0.1 } }, evidence: "e1" } }, { plan: { goal: "check" } }));
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(r.answer).toEqual({ kind: "check", answer: true, probability: 0.8, evidence: ['button "Licious Sept3 Session"'] });
    expect(r.confidence).toBe(0.8);
    expect(t.oracle.requests.map((x) => x.name)).toEqual(["plan", "observe"]);
    const hold = setup("open https://app/dash and check if the project has Sept 3 artifacts", { pages: { d: DASH }, start: "d" }, byUrl({ [DASH.url]: { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.6, probabilities: { DONE: 0.6, CLICK: 0.3, WAIT: 0.1 } }, click_target_0: "e2", answer_state: { choice: "yes", confidence: 0.4, probabilities: { yes: 0.4, no: 0.3, not_visible_yet: 0.3 } } } }, { plan: { goal: "check" } }));
    const r2 = await hold.runner.run();
    expect(r2.steps.slice(0, 2).map((s) => s.action)).toEqual(["click", "click"]);
    expect(r2.outcome).toBe("blocked");
    expect(r2.blocked?.kind).toBe("ambiguous");
    expect(r2.answer).toMatchObject({ kind: "check", answer: "unknown", probability: 0.4 });
  });
  it("max_steps, run_timeout with an injected clock, dry-run never acts, --keep-open skips close", async () => {
    const obs = byUrl({ [P.url]: { page_kind: "task_page", operation: "CLICK", click_target_0: "e1" } }, { plan: { goal: "act" } });
    const t = setup("open https://x/ and click A", { pages: { p: P }, start: "p" }, obs, { maxSteps: 2, dryRun: true, keepOpen: true });
    const r = await t.runner.run();
    expect(r.blocked?.kind).toBe("max_steps");
    expect(r.steps.map((s) => s.result)).toEqual(["skipped", "skipped", "blocked"]);
    expect(t.browser.calls.some((c) => c[0] === "click")).toBe(false);
    expect(t.browser.calls.some((c) => c[0] === "close")).toBe(false);
    let clock = 0;
    const slow = setup("open https://x/ and click A", { pages: { p: P }, start: "p" }, obs, { runTimeoutMs: 100 }, fakeHuman({ interactive: false }), () => (clock += 60));
    expect((await slow.runner.run()).blocked?.kind).toBe("run_timeout");
  });
  it("Jev error -> failed jev; error page -> back then blocked impossible", async () => {
    const t = setup("open https://x/ and click A", { pages: { p: P }, start: "p" }, (name) => { if (name === "observe") throw new TypeSafeError("boom"); return { goal: "act" }; });
    const r = await t.runner.run();
    expect(r.outcome).toBe("failed");
    expect(r.error).toEqual({ kind: "jev", message: "boom" });
    const err = setup("open https://x/ and click A", { pages: { p: P }, start: "p" }, byUrl({ [P.url]: { page_kind: { choice: "error_page", confidence: 0.9 }, operation: "GO_BACK" } }, { plan: { goal: "act" } }));
    const r2 = await err.runner.run();
    expect(err.browser.calls).toContainEqual(["back"]);
    expect(r2.blocked?.kind).toBe("impossible");
  });
  it("act() never throws and maps unsupported actions", async () => {
    const b = fakeBrowser({ pages: { p: P }, start: "p" });
    expect(await act(b, "click", null, {})).toMatchObject({ ok: false });
    expect(await act(b, "wait", null, {})).toEqual({ ok: true });
    expect(await act(b, "none", null, {})).toMatchObject({ ok: false, kind: "other" });
  });
});
