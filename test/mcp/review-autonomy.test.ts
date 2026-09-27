// Regressions of the open-points review (26 Sep), MCP side: groups 28, 29, 30, and 38. Each test failed on c093ea0.
import type { ChoiceQuestion, Questions } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { FastRunner } from "../../src/fast/loop.js";
import type { Observation } from "../../src/fast/model.js";
import { StalePage } from "../../src/fast/model.js";
import { emptyResult } from "../../src/io.js";
import { MCP } from "../../src/mcp/limits.js";
import type { BrowseInput, Run, RunHooks } from "../../src/mcp/runs.js";
import { RunManager } from "../../src/mcp/runs.js";
import { baseConfig, fastStarter } from "../../src/mcp/setup.js";
import { estTokens, viewOf } from "../../src/mcp/view.js";
import type { RunConfig, RunResult, StepRecord } from "../../src/types.js";
import { fakeHuman, fakeLogger, fakeOracle, fakeText, type PartialAnswers } from "../fakes.js";
import { el, fakeChrome, fakePage, obs } from "../fast/fakes.js";
import { KEY, MAIL, PROFILES, connect, fakeJev, mailSession, replyOracle } from "./helpers.js";

function cfg(task: string, over: Partial<RunConfig> = {}): RunConfig {
  return {
    task, headed: true, maxSteps: 6, stepTimeoutMs: 1000, runTimeoutMs: 60_000, pauseTimeoutMs: 1000, confirm: "auto", dryRun: false, session: "s",
    model: "m", logLevel: "info", logJson: false, keepOpen: false, agentBrowserBin: "ab", vars: {}, profile: "none", goal: "act", engine: "cdp", refreshProfile: false, ...over,
  };
}
function idx(questions: Questions, head: string, label: string): string {
  const q = questions[head] as ChoiceQuestion | undefined;
  for (const [key, v] of Object.entries(q?.criteria ?? {})) if (typeof v === "object" && v !== null && String((v as { element?: string }).element ?? "").includes(label)) return key;
  throw new Error(`no ${head} option for ${label}`);
}
type Decide = (q: Questions) => PartialAnswers;
const clickOn = (label: string): Decide => (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", label), confidence: 0.9 } });
const gen = (label: string): Decide => (q) => ({ page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", label), confidence: 0.8 }, type_text_value: { choice: "generate", confidence: 0.8 } });
const finish: Decide = () => ({ page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } });
const seq = (...steps: Decide[]) => { let i = 0; return (name: string, _s: unknown, q: Questions): PartialAnswers => (name === "step" ? (steps[Math.min(i++, steps.length - 1)] as Decide)(q) : {}); };
const tick = () => new Promise((r) => setTimeout(r, 30));

describe("group 28: RunAutonomy.sentAt", () => {
  it("a navigation click that discards unsent text is not a send: sentAt stays null and next does not say that text was sent", async () => {
    const A = "https://mail.example/t/1";
    const B = "https://mail.example/t/2";
    const st: Record<number, string> = {};
    const thread = (): Observation => obs(A, [
      el("e4", "fill", "Reply", "textbox", { value: st[4] ?? "", form: 7, multiline: true }),
      el("e5", "click", "Send", "button", { form: 7 }),
      el("e9", "click", "Next thread", "link", { form: null }),
    ], "Thread 1 from Ann", { doc: 1, filled: st[4] ? [4] : [], texts: st[4] ? [[4, st[4]]] : [] });
    const other = (): Observation => obs(B, [
      el("e14", "fill", "Reply", "textbox", { value: "", form: 8, multiline: true }),
      el("e15", "click", "Send", "button", { form: 8 }),
    ], "Thread 2 from Bob", { doc: 2, filled: [], texts: [] });
    let where = "a";
    const page = fakePage({ pages: {}, start: "a" });
    page.observe = async () => (where === "a" ? thread() : other());
    page.act = async (a, _o, text) => {
      page.calls.push({ op: "act", id: a.id, kind: a.kind, ...(text !== undefined ? { text } : {}) });
      if (a.kind === "fill" && a.node === 4) st[4] = text ?? "";
      if (a.label === "Next thread") where = "b";
    };
    const mgr = new RunManager({
      log: fakeLogger(),
      start: async (input: BrowseInput, hooks: RunHooks) => new FastRunner({
        cfg: cfg(input.task, { confirm: input.confirm, url: A }), profiles: [], chrome: async () => fakeChrome(), openPage: async () => page,
        oracle: fakeOracle(seq(gen("Reply"), clickOn("Next thread"), gen("Reply"), finish)), human: hooks.human, log: hooks.log, sleep: async () => undefined, fromAssistant: true,
        text: hooks.text, hints: hooks.hints, signal: hooks.signal, ...(hooks.attended !== undefined ? { attended: hooks.attended } : {}),
      }).run(),
    });
    const run = mgr.start({ task: "reply to Ann's thread that Tuesday works", headed: true, confirm: "autonomous", dry_run: false, user_said: "do it autonomously" }, { interactive: false });
    let r = await mgr.wait(run.id, 3000);
    expect(r.status).toBe("needs_text");
    mgr.answerText(run.id, "t1", { values: { f1: "Tuesday works." } });
    await tick();
    r = await mgr.wait(run.id, 3000);
    expect(r.status).toBe("needs_text");
    // No Send click ran: the text left with the navigation, it was not sent.
    expect(page.calls.some((c) => c.id === "e5" || c.id === "e15")).toBe(false);
    expect(r.sent).toEqual([]);
    const v = viewOf(r, Date.now(), () => null);
    // The old code set sentAt 2 from the audit's `left`, and next said "This run already sent text at step 2. ...".
    expect(v.next).not.toContain("already sent");
    mgr.answerText(run.id, (r.pending as { id: string } | null)?.id ?? "t2", { decline: "stop" });
    await tick();
  });
});

describe("group 29: fit() of a long autonomous audit", () => {
  function longRun(n: number, label: (i: number) => string, value: (i: number) => string): Run {
    const r: RunResult = { ...emptyResult("task", "act", undefined, "cdp"), outcome: "blocked", reason: "max_steps" };
    r.steps = Array.from({ length: n }, (_, k): StepRecord => ({
      step: k + 1, url: "https://app.example/x", title: "t", page_kind: "task_page", page_kind_conf: 0.9, done_p: 0.1, operation: "CLICK", operation_conf: 0.9,
      target: null, target_conf: 0.9, runner_up: null, action: "click", value: null, value_conf: null, risk: "submit", path: "fast",
      gate: "autonomous", result: "ok", error: null, jev_requests: 1, duration_ms: 10,
      unattended: { action: `click button "Next ${k}"`, host: "app.example", why: ["submit"], texts: [], fields: Array.from({ length: 8 }, (_, j) => ({ label: label(j), value: value(j) })) },
    }));
    return {
      id: "r1-abcd", task: "task", startedAt: 0, status: "blocked", pending: null, steps: n, lastStep: null, tail: [], textRequests: 1,
      result: r, endedAt: 1, confirmEnd: null, untyped: [], autonomous: { userSaid: "do it autonomously", unattended: n },
      sent: [{ field: "Reply", text: "Tuesday works for the team meeting." }], redact: (s) => s,
    };
  }

  it("a finished autonomous run of 25 audited steps (the default max_steps) with 8 fields each fits MCP.viewTokens", () => {
    const v = viewOf(longRun(25, (i) => `\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u306e\u8aac\u660e\u3068\u8a73\u7d30\u306a\u9805\u76ee${i}`, () => "\u3053\u308c\u306f\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u306e\u8aac\u660e\u3067\u3059\u3002".repeat(8)), 1, () => null);
    // Current code: about 14,000 estimated tokens, above the 7,000 budget and Codex's 10k cut.
    expect(estTokens(JSON.stringify(v))).toBeLessThanOrEqual(MCP.viewTokens);
  });

  it("a finished autonomous run of 50 ASCII audited steps with 8 fields each fits MCP.viewTokens", () => {
    const v = viewOf(longRun(50, (i) => `Project field number ${i}`, (i) => `value of the project field ${i} `.repeat(4)), 1, () => null);
    // Current code: about 12,000 estimated tokens.
    expect(estTokens(JSON.stringify(v))).toBeLessThanOrEqual(MCP.viewTokens);
  });
});

describe("group 30: JEV_MCP_AUTONOMOUS=0", () => {
  it("with the off switch, no hint or instruction tells the user to write \"autonomous\"", async () => {
    const env = { JEV_MCP_AUTONOMOUS: "0" };
    const log = fakeLogger();
    const mail = mailSession(log);
    const oracle = replyOracle();
    const start = fastStarter({ session: mail.session, jev: fakeJev(), base: baseConfig({}, log), env, profiles: () => PROFILES, oracle: () => oracle });
    const runs = new RunManager({ start, log, secret: () => KEY, forceStop: () => mail.session.close() });
    const c = await connect({ runs, version: "0.1.0", env, profiles: () => PROFILES, secret: () => KEY, log: fakeLogger(), closeBrowser: async () => true });
    // The server refuses the mode.
    const off = await c.client.callTool({ name: "browse", arguments: { task: "a", confirm: "autonomous", user_said: "don't ask me" } });
    expect(off.isError).toBe(true);
    // A client without elicitation: the send blocks with the noConfirm hint.
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await c.client.callTool({ name, arguments: args })).content as { text: string }[])[0]?.text ?? "{}");
    const v1 = await call("browse", { task: "reply to Ann", url: MAIL, profile: "none" });
    let v = await call("continue", { run: v1.run, request: "t1", values: { f1: "Tuesday at 10:00 works for me.", f2: "Re: Meeting" } });
    for (let i = 0; i < 5 && v.status !== "blocked"; i++) v = await call("wait", { run: v1.run, wait_s: 5 });
    expect(v.result?.blocked?.kind).toBe("needs_confirmation");
    // Current code: the hint ends with 'The user can write "autonomous" or "don't ask me" in their own message ...'.
    expect(v.result?.blocked?.hint).not.toMatch(/autonomous/);
    expect(c.client.getInstructions() ?? "").not.toMatch(/autonomous/);
    await c.close();
  });
});

describe("group 38: an audited action that ran and then blocked", () => {
  it("next tells the assistant that a blocked audit entry ran, as it does for a failed one", async () => {
    const URL = "https://mail.example/t/1";
    const st = { reply: "", sent: null as string | null, stale: false };
    const view = (): Observation => obs(URL, [
      el("e4", "fill", "Reply", "textbox", { value: st.reply, form: 7, multiline: true }),
      el("e5", "click", "Send", "button", { form: 7 }),
    ], "Thread from Ann", { doc: 1, filled: st.reply ? [4] : [], texts: st.reply ? [[4, st.reply]] : [] });
    const page = fakePage({ pages: {}, start: "m" });
    // After the Send click, the page keeps changing: every observation throws StalePage.
    page.observe = async () => { if (st.stale) throw new StalePage("the page keeps changing"); return view(); };
    page.act = async (a, _o, text) => {
      page.calls.push({ op: "act", id: a.id, kind: a.kind, ...(text !== undefined ? { text } : {}) });
      if (a.kind === "fill") st.reply = text ?? "";
      if (a.label === "Send") { st.sent = st.reply; st.reply = ""; st.stale = true; }
    };
    const human = fakeHuman({ interactive: false });
    human.confirm = async () => { throw new Error("dialog"); };
    const r = await new FastRunner({
      cfg: cfg("reply to Ann that Tuesday works", { confirm: "autonomous", url: URL }), profiles: [], chrome: async () => fakeChrome(), openPage: async () => page,
      oracle: fakeOracle(seq(gen("Reply"), clickOn("Send"), finish)), human, log: fakeLogger(), sleep: async () => undefined, fromAssistant: true,
      text: fakeText([{ kind: "text", values: { f1: "Tuesday works." } }]),
    }).run();
    // The Send ran: the page took the text. The record is blocked, with the audit.
    expect(st.sent).toBe("Tuesday works.");
    const send = r.steps.find((s) => s.unattended?.action === 'click button "Send"');
    expect(send).toMatchObject({ result: "blocked", error: "page keeps changing" });
    const run: Run = {
      id: "r1-abcd", task: "reply to Ann", startedAt: 0, status: "blocked", pending: null, steps: r.steps.length, lastStep: null, tail: [], textRequests: 1,
      result: r, endedAt: 1, confirmEnd: null, untyped: [], autonomous: { userSaid: "do it autonomously", unattended: 1 }, sent: [], redact: (s) => s,
    };
    const v = viewOf(run, 1, () => null);
    expect(v.result?.unattended?.[0]?.result).toBe("blocked");
    // Current code: "... An entry with result failed may have run." Nothing says that a blocked entry ran.
    expect(v.next).toMatch(/blocked[^.]*(ran|may have run)|every entry[^.]*(ran|may have run)|whatever its result/i);
  });
});
