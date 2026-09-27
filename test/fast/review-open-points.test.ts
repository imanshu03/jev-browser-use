// Regressions of the open-points review (26 Sep): groups 31, 35, 36, 37. Each test failed on c093ea0.
import type { ChoiceQuestion, Questions } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { FastRunner } from "../../src/fast/loop.js";
import type { FastRunnerDeps } from "../../src/fast/loop.js";
import type { Action, Observation, UnsentText } from "../../src/fast/model.js";
import type { RunConfig } from "../../src/types.js";
import { varSpans } from "../../src/task.js";
import { fakeHuman, fakeLogger, fakeOracle, fakeText, type PartialAnswers } from "../fakes.js";
import { el, fakeChrome, fakePage, obs, type FakePage } from "./fakes.js";

function cfg(task: string, over: Partial<RunConfig> = {}): RunConfig {
  return {
    task, headed: false, maxSteps: 6, stepTimeoutMs: 1000, runTimeoutMs: 60_000, pauseTimeoutMs: 1000, confirm: "auto", dryRun: false, session: "jev-test",
    model: "m", logLevel: "info", logJson: false, keepOpen: false, agentBrowserBin: "ab", vars: {}, profile: "none", goal: "act", engine: "cdp", refreshProfile: false, ...over,
  };
}

function idx(questions: Questions, head: string, label: string): string {
  const q = questions[head] as ChoiceQuestion | undefined;
  for (const [key, v] of Object.entries(q?.criteria ?? {})) {
    if (typeof v === "object" && v !== null && String((v as { element?: string }).element ?? "").includes(label)) return key;
  }
  throw new Error(`no ${head} option for ${label}`);
}

type Decide = (q: Questions) => PartialAnswers;
const seq = (...steps: Decide[]) => {
  let i = 0;
  return (name: string, _s: unknown, q: Questions): PartialAnswers => (name === "step" ? (steps[Math.min(i++, steps.length - 1)] as Decide)(q) : {});
};
const done: Decide = () => ({ page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } });

function runner(page: FakePage, task: string, oracle: ReturnType<typeof seq>, over: Partial<RunConfig>, extra: Partial<FastRunnerDeps> = {}) {
  const log = fakeLogger();
  const human = (extra.human as ReturnType<typeof fakeHuman> | undefined) ?? fakeHuman({ interactive: false });
  const deps: FastRunnerDeps = {
    cfg: cfg(task, over), profiles: [], chrome: async () => fakeChrome(), openPage: async () => page,
    oracle: fakeOracle(oracle), human, log, sleep: async () => undefined, ...extra,
  };
  return { r: new FastRunner(deps), log, human };
}

describe("group 31: Enter that picks an option never becomes a click on the submit button", () => {
  const enterThenClick = (enterP: number, clickP: number, click: string): Decide => (q) => ({
    page_kind: "task_page",
    operation: { choice: "PRESS_ENTER", confidence: enterP, probabilities: { PRESS_ENTER: enterP, CLICK: clickP, DONE: Number((1 - enterP - clickP).toFixed(2)) } },
    click_target: { choice: idx(q, "click_target", click), confidence: 0.9, probabilities: { [idx(q, "click_target", click)]: 0.95 } },
  });

  it("create form, confirm auto: Enter@0.45 picks 'Ann Lee', click head on 'Create issue': the run asks again and clicks nothing", async () => {
    const URL = "https://app.example/issues/new";
    const form = obs(URL, [
      el("e1", "fill", "Assignee", "combobox", { value: "Ann", form: 3 }),
      el("e2", "click", "Create issue", "button", { form: 3 }),
      el("e14", "click", "Ann Lee", "option", { selected: "true" }),
    ], "New issue", { focus: { node: 1, label: "Assignee", role: "combobox", submitLabel: "Create issue", submitDefault: "Create issue", editable: true, value: "Ann", form: 3, multiline: false, enterOption: { node: 14, label: "Ann Lee" } } });
    const page = fakePage({ pages: { a: form, b: obs(URL, [el("e9", "click", "Done view", "button")], "Created") }, start: "a", transitions: (c) => (c.op === "act" || c.op === "press" ? "b" : undefined) });
    const { r } = runner(page, "create an issue assigned to Ann Lee", seq(enterThenClick(0.45, 0.4, "Create issue"), enterThenClick(0.45, 0.4, "Create issue")), { url: URL, maxSteps: 1 });
    await r.run();
    expect(page.calls.filter((c) => c.op === "act" || c.op === "press")).toEqual([]);
  });

  it("chat, autonomous: Enter@0.55 picks the mention 'Ann Lee', click head on 'Send message': the half-typed message is not sent", async () => {
    const URL = "https://app.example/chat";
    const chat = obs(URL, [
      el("e1", "fill", "Message", "textbox", { value: "Hi @An", form: 5, multiline: true }),
      el("e2", "click", "Send message", "button", { form: 5 }),
      el("e14", "click", "Ann Lee", "option", { selected: "true" }),
    ], "Chat", { focus: { node: 1, label: "Message", role: "textbox", submitLabel: "Send message", submitDefault: "Send message", editable: true, value: "Hi @An", form: 5, multiline: true, enterOption: { node: 14, label: "Ann Lee" } } });
    const page = fakePage({ pages: { a: chat, b: obs(URL, [el("e9", "click", "Done view", "button")], "Sent") }, start: "a", transitions: (c) => (c.op === "act" || c.op === "press" ? "b" : undefined) });
    const { r } = runner(page, "send a message to Ann Lee", seq(enterThenClick(0.55, 0.3, "Send message"), enterThenClick(0.55, 0.3, "Send message")), { url: URL, maxSteps: 1, confirm: "autonomous" });
    await r.run();
    expect(page.calls.filter((c) => c.op === "act" && c.id === "e2")).toEqual([]);
  });
});

describe("group 35: a rerun after a needs_confirmation block does not add the same line a second time", () => {
  const URL = "https://app.example/doc";
  const DOC = "Release 4.2 notes\nThe QA team tested it.";
  const LINE = "Reviewed by QA";
  const TASK = 'Edit the document, add the line "Reviewed by QA" at the end, and save it';

  it("run 1 appends and blocks at Save (no dialogs); run 2 (autonomous, same task, same page, seeded unsent text) does not type the line again", async () => {
    const state = { value: DOC, saved: null as string | null };
    const docPage = (): Observation => obs(URL, [
      el("e1", "fill", "Document", "textbox", { node: 1, value: state.value, multiline: true, form: null }),
      el("e2", "click", "Save", "button", { node: 2, form: null }),
    ], `Notes\n${state.value}`, { doc: 5, texts: [[1, state.value]] });
    const page = fakePage({ pages: { d: docPage() }, start: "d", edits: (c) => {
      const before = state.value;
      state.value = c.edit?.mode === "append" ? `${before}\n${c.text ?? ""}` : c.text ?? "";
      return { mode: c.edit?.mode === "append" ? "append" : "replace", shape: "document", before, after: state.value };
    } });
    page.observe = async () => { page.observes += 1; return docPage(); };
    const act = page.act.bind(page);
    page.act = async (a: Action, o: Observation, text?: string, edit?: Parameters<typeof page.act>[3]) => { const res = await act(a, o, text, edit); if (a.id === "e2") state.saved = state.value; return res; };
    const fill: Decide = (q) => ({
      page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", "Document"), confidence: 0.9 },
      type_text_value: { choice: "s1", confidence: 0.9 }, type_text_mode: { choice: "append", confidence: 0.97 },
    });
    const save: Decide = (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "Save"), confidence: 0.9 } });

    const one = runner(page, TASK, seq(fill, save, done), { url: URL }, { fromAssistant: true, human: fakeHuman({ interactive: false }) });
    const r1 = await one.r.run();
    expect(r1.blocked?.kind).toBe("needs_confirmation");
    expect(state.value).toBe(`${DOC}\n${LINE}`);
    const unsent: UnsentText[] = one.r.unsentText();
    expect(unsent).toMatchObject([{ node: 1, text: LINE }]);

    const two = runner(page, TASK, seq(fill, save, done), { fallbackUrl: URL, confirm: "autonomous" }, { fromAssistant: true, page, unsent, human: fakeHuman({ interactive: false }) });
    const r2 = await two.r.run();
    expect(r2.outcome).toBe("done");
    // Wanted: the document holds the line once. On c093ea0 run 2 types it again and Save keeps both.
    expect(state.saved).toBe(`${DOC}\n${LINE}`);
  });
});

describe("group 36: a var key that holds a secret word only as a substring is not secret", () => {
  it("varSpans: opinion, shipping_notes, passenger_note are not secret; password, pin, otp_code stay secret", () => {
    expect(varSpans({ opinion: "x", shipping_notes: "x", passenger_note: "x" }).map((s) => s.secret)).toEqual([false, false, false]);
    expect(varSpans({ password: "x", pin: "x", otp_code: "x" }).map((s) => s.secret)).toEqual([true, true, true]);
    // Keys are often lower-cased: a strong word counts inside a compound key.
    expect(varSpans({ apitoken: "x", userpassword: "x", apiToken: "x" }).map((s) => s.secret)).toEqual([true, true, true]);
  });

  it("an MCP var 'opinion' in a multiline field is sanitized and gates the next submit click with a dialog that shows it", async () => {
    const URL = "https://shop.example/checkout";
    const TEXT = "Leave it at the back door‮ please";
    const state: Record<number, string> = {};
    const page0 = (): Observation => obs(URL, [
      el("e4", "fill", "Your opinion", "textbox", { value: state[4] ?? "", form: 7, multiline: true }),
      el("e6", "click", "Save draft", "button", { form: 7 }),
    ], "Checkout", { doc: 1, texts: Object.entries(state).filter(([, v]) => v).map(([k, v]) => [Number(k), v]) });
    const page = fakePage({ pages: { m: page0() }, start: "m" });
    page.observe = async () => { page.observes += 1; return page0(); };
    const act = page.act.bind(page);
    page.act = async (a: Action, o: Observation, text?: string, edit?: Parameters<typeof page.act>[3]) => { const res = await act(a, o, text, edit); if (a.kind === "fill" && a.node !== null) state[a.node] = text ?? ""; return res; };
    const human = fakeHuman({ interactive: true, confirm: [true, true] });
    const { r } = runner(page, "add my opinion and save the draft", seq(
      (q) => ({ page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", "Your opinion"), confidence: 0.9 }, type_text_value: { choice: "v_opinion", confidence: 0.9 } }),
      (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "Save draft"), confidence: 0.95 } }),
      done,
    ), { url: URL, vars: { opinion: TEXT } }, { fromAssistant: true, human, text: fakeText() });
    await r.run();
    const typed = page.calls.find((c) => c.kind === "fill")?.text;
    expect(typed).toBe("Leave it at the back door please");
    expect(human.prompts).toHaveLength(1);
  });
});

describe("group 37: an MCP var that the assistant wrote into a single-line field gates the next submit, as generated text does", () => {
  it("var 'subject' into Subject, then Save draft: one dialog that shows the subject", async () => {
    const URL = "https://mail.example/t/1";
    const state: Record<number, string> = {};
    const page0 = (): Observation => obs(URL, [
      el("e3", "fill", "Subject", "textbox", { value: state[3] ?? "", inputType: "text", form: 7, maxLength: 120 }),
      el("e4", "fill", "Reply", "textbox", { value: state[4] ?? "", form: 7, multiline: true }),
      el("e5", "click", "Send", "button", { form: 7 }),
      el("e6", "click", "Save draft", "button", { form: 7 }),
    ], "Meeting", { doc: 1, texts: Object.entries(state).filter(([, v]) => v).map(([k, v]) => [Number(k), v]) });
    const page = fakePage({ pages: { m: page0() }, start: "m" });
    page.observe = async () => { page.observes += 1; return page0(); };
    const act = page.act.bind(page);
    page.act = async (a: Action, o: Observation, text?: string, edit?: Parameters<typeof page.act>[3]) => { const res = await act(a, o, text, edit); if (a.kind === "fill" && a.node !== null) state[a.node] = text ?? ""; return res; };
    const human = fakeHuman({ interactive: true, confirm: [true, true] });
    const { r } = runner(page, "reply to Ann with a subject line and save the draft", seq(
      (q) => ({ page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", "Subject"), confidence: 0.9 }, type_text_value: { choice: "v_subject", confidence: 0.9 } }),
      (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "Save draft"), confidence: 0.95 } }),
      done,
    ), { url: URL, vars: { subject: "Re: Q3 layoffs list attached" } }, { fromAssistant: true, human, text: fakeText() });
    await r.run();
    expect(page.calls.filter((c) => c.kind === "fill")).toHaveLength(1);
    expect(human.prompts).toHaveLength(1);
    expect((human.details[0] as { typed?: unknown } | undefined)?.typed).toEqual([{ label: "Subject", text: "Re: Q3 layoffs list attached" }]);
  });
});
