// Regressions of the open-points review (26 Sep). Each test failed on c093ea0.
// fails on the current code.
import type { ChoiceQuestion, Questions } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { FastRunner } from "../../src/fast/loop.js";
import type { FastRunnerDeps } from "../../src/fast/loop.js";
import { assignDates, dateGate } from "../../src/fast/dates.js";
import type { Action, Observation, Popup, TokenFacts } from "../../src/fast/model.js";
import { extractSpans } from "../../src/task.js";
import type { RunConfig } from "../../src/types.js";
import { fakeHuman, fakeLogger, fakeOracle, type OracleScript, type PartialAnswers } from "../fakes.js";
import { el, fakeChrome, fakePage, obs, type PageScript } from "./fakes.js";

function cfg(task: string, over: Partial<RunConfig> = {}): RunConfig {
  return {
    task, headed: false, maxSteps: 8, stepTimeoutMs: 1000, runTimeoutMs: 60_000, pauseTimeoutMs: 1000, confirm: "auto", dryRun: false, session: "jev-test",
    model: "m", logLevel: "info", logJson: false, keepOpen: false, agentBrowserBin: "ab", vars: {}, profile: "none", goal: "act", engine: "cdp", refreshProfile: false, ...over,
  };
}
function idx(questions: Questions, head: string, label: string): string {
  const q = questions[head] as ChoiceQuestion | undefined;
  for (const [key, v] of Object.entries(q?.criteria ?? {})) {
    if (typeof v === "object" && v !== null && String((v as { element?: string }).element ?? "").includes(label)) return key;
  }
  throw new Error(`no ${head} option for ${label}: ${Object.keys(q?.criteria ?? {}).join(",")}`);
}
function setup(task: string, script: PageScript, oracle: OracleScript, over: Partial<RunConfig> = {}, human = fakeHuman({ interactive: false })) {
  const page = fakePage(script);
  const o = fakeOracle(oracle);
  const log = fakeLogger();
  const deps: FastRunnerDeps = {
    cfg: cfg(task, over), profiles: [], chrome: async () => fakeChrome(), openPage: async () => page, oracle: o,
    human, log, sleep: async () => undefined,
  };
  return { runner: new FastRunner(deps), page, oracle: o, log };
}
type Decide = (q: Questions, state: { retry_reason?: string }) => PartialAnswers;
const seq = (...steps: Decide[]) => {
  let i = 0;
  return (name: string, state: unknown, q: Questions): PartialAnswers => (name === "step" ? (steps[Math.min(i++, steps.length - 1)] as Decide)(q, state as never) : {});
};
const click = (label: string): Decide => (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", label), confidence: 0.9 } });
const finish: Decide = () => ({ page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } });
const wait: Decide = () => ({ page_kind: "task_page", operation: "WAIT" });
const acts = (t: { page: { calls: { op: string; id?: string }[] } }) => t.page.calls.filter((c) => c.op === "act").map((c) => c.id);

describe("group 14: the date gate 'unread/lost' rule and a numeric date that is message text or part of a name", () => {
  it("dateGate: a dotted date inside the event name does not hold Save or DONE when the date field shows its assigned date", () => {
    const task = 'Create an event named "Retro for sprint 3.4.2026" with the date 2026-04-10 and click Save';
    const spans = extractSpans(task);
    const date = el("e2", "fill", "Date (date)", "textbox", { node: 2, form: 1, inputType: "date", value: "2026-04-10", date: { kind: "date", sep: "/", order: "MDY" } });
    const o = obs("https://cal.test/new", [el("e1", "fill", "Name", "textbox", { node: 1, form: 1, value: "Retro for sprint 3.4.2026" }), date, el("e3", "click", "Save", "button", { node: 3, form: 1 })], "New event");
    const iso = spans.find((s) => s.text === "2026-04-10");
    expect(iso).toBeDefined();
    const assigned = assignDates({ e2: { [iso!.id]: 0.99 } }, o, spans);
    expect(assigned.map((a) => a.field.label)).toEqual(["Date (date)"]);
    // Current code: 'the task date 3.4.2026 fits no date field here, because its day and month can change places ...'.
    expect(dateGate(o, assigned, spans, 1)).toBeNull();
    expect(dateGate(o, assigned, spans, "page")).toBeNull();
  });

  it("DONE after the message was sent is not refused because a date filter elsewhere on the page has another separator", async () => {
    const SENT = obs("https://app.test/chat", [
      el("e1", "fill", "Message", "textbox", { node: 1, value: "", multiline: true, form: 2 }),
      el("e2", "click", "Send", "button", { node: 2, form: 2 }),
      el("e3", "fill", "Filter from (date)", "textbox", { node: 3, value: "", inputType: "date", form: 9, date: { kind: "date", order: "MDY", sep: "/" } }),
    ], "Chat\nAnn: hi\nMe: The invoice from 04.03.2026 is paid");
    const t = setup('Send "The invoice from 04.03.2026 is paid" to Ann', { pages: { a: SENT }, start: "a" }, seq(finish), { url: SENT.url });
    const r = await t.runner.run();
    // Current code: blocked ambiguous, 'date_unset: the task date 04.03.2026 fits no date field here ...'.
    expect(r.outcome).toBe("done");
  });

  it("a Send click in a form with an optional date field runs when the only numeric date is message text", async () => {
    const FORM = obs("https://app.test/reply", [
      el("e1", "fill", "Message", "textbox", { node: 1, value: "Paid on 04.03.2026", multiline: true, form: 2 }),
      el("e2", "fill", "Send later (date)", "textbox", { node: 2, value: "", inputType: "date", form: 2, date: { kind: "date", order: "MDY", sep: "/" } }),
      el("e3", "click", "Send", "button", { node: 3, form: 2 }),
    ], "Reply");
    const DONE = obs("https://app.test/reply", [], "Sent");
    const t = setup('Reply "Paid on 04.03.2026" to the ticket', { pages: { a: FORM, b: DONE }, start: "a", transitions: (c) => (c.op === "act" && c.id === "e3" ? "b" : undefined) },
      seq(click("Send"), wait, wait, finish), { url: FORM.url }, fakeHuman({ interactive: true, confirm: [true, true, true, true] }));
    const r = await t.runner.run();
    expect(r.steps.map((x) => `${x.operation}:${x.result}:${x.gate}`).join(" | ")).not.toContain("date_unset");
    // Current code: the click is gated with date_unset at every step; only WAITs run.
    expect(acts(t)).toContain("e3");
  });
});

describe("group 15: the open-step rule after an SPA route change to a new form", () => {
  it("a Create click that routes (same document, new hash) to a settings form with Cancel / Save changes / Delete project does not hold DONE", async () => {
    const NEW = obs("https://app.test/projects/new", [
      el("e1", "fill", "Project name", "textbox", { node: 1, value: "Apollo", form: 1 }),
      el("e2", "click", "Create project", "button", { node: 2, form: 1 }),
    ], "New project", { doc: 7 });
    const SETTINGS = obs("https://app.test/projects/new#settings", [
      el("e1", "click", "Projects", "link", { node: 20, form: null }),
      el("e2", "fill", "Description", "textbox", { node: 21, value: "", form: 2 }),
      el("e3", "click", "Cancel", "button", { node: 22, form: 2 }),
      el("e4", "click", "Save changes", "button", { node: 23, form: 2 }),
      el("e5", "click", "Delete project", "button", { node: 24, form: 2 }),
    ], "Project Apollo created\nSettings", { doc: 7 });
    const t = setup('Create a project named "Apollo"', { pages: { n: NEW, s: SETTINGS }, start: "n", transitions: (c) => (c.op === "act" && c.id === "e2" ? "s" : undefined) },
      seq(click("Create project"), finish, wait, finish, wait, finish), { url: NEW.url });
    const r = await t.runner.run();
    // Current code: '"Create project" opened a step with "Save changes", "Delete project"', DONE refused, then blocked
    // ambiguous: 'The task is not done while that step is open'.
    expect(t.log.lines.some((l) => l.includes('"Create project" opened a step'))).toBe(false);
    expect(r.outcome).toBe("done");
  });
});

describe("group 18: the gate text of a re-asked action goes into the record of another action", () => {
  const URL = "https://app.example/doc";
  const EDIT = obs(URL, [el("e1", "click", "Cancel", "button", { node: 1 }), el("e2", "click", "Save", "button", { node: 2, expanded: "false" })], "Release notes", { doc: 5 });
  const POPOVER = obs(URL, [
    el("e1", "click", "Cancel", "button", { node: 1 }), el("e2", "click", "Save", "button", { node: 2, expanded: "true" }),
    el("e4", "click", "Cancel", "button", { node: 34, form: 1 }), el("e5", "click", "Confirm", "button", { node: 35, form: 1 }),
  ], "Release notes\nSave Changes\nCancel\nConfirm", { doc: 5 });

  it("a WAIT that runs after the open-step re-ask of DONE records its own gate, not the DONE refusal", async () => {
    const t = setup("edit the notes and save them", { pages: { e: EDIT, p: POPOVER }, start: "e", transitions: (c) => (c.op === "act" && c.id === "e2" ? "p" : undefined) },
      seq(click("Save"), finish, wait), { url: URL, maxSteps: 2 });
    const r = await t.runner.run();
    const w = r.steps.find((s) => s.operation === "WAIT");
    expect(w).toBeDefined();
    expect(w?.result).toBe("ok");
    // Current code: 'the click on "Save" opened a step that is still open, with "Confirm". The click did not finish the action'.
    expect(w?.gate).toBe("ok");
  });

  it("control: after a low_target re-ask the WAIT record shows gate 'ok'", async () => {
    const low: Decide = (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "Save"), confidence: 0.2 } });
    const t = setup("edit the notes and save them", { pages: { e: EDIT }, start: "e" }, seq(low, wait), { url: URL, maxSteps: 1 });
    const r = await t.runner.run();
    expect(r.steps.find((s) => s.operation === "WAIT")?.gate).toBe("ok");
  });
});

describe("group 19: the chip gate's script Enter writes no StepRecord", () => {
  const UPLOAD = "https://app.example/upload";
  const DOC = 1727000000002.5;
  const FIRST = "Search org members or type a name...";
  const SUBMIT = "Submit & Finalize (1 file)";
  const CLOSED: Popup = { open: false, text: "", picks: [], busy: false };
  interface ChipState { draft: string; title: string; chips: string[]; focus: number | null; submitted: string | null }
  function chipPage(s: ChipState): Observation {
    const token: TokenFacts = { items: [[90, "Meeting Participants (Optional)", 0], ...s.chips.map((c, i): [number, string, number] => [100 + i, `${c} Remove participant`, 2])], chips: s.chips.map((c) => `${c} Remove participant`), multi: true };
    const actions: Action[] = [
      el("e1", "fill", s.chips.length === 0 ? FIRST : "textbox", "textbox", { node: 1, value: s.draft, form: 3, inputType: "text", token }),
      el("e2", "fill", "Title (Optional)", "textbox", { node: 2, value: s.title, form: 3, inputType: "text", token: { items: [[91, "Title (Optional)", 0]], chips: [] } }),
      el("e3", "click", "Open Title (Optional)", "textbox", { node: 2, form: 3 }),
      el("e4", "click", SUBMIT, "button", { node: 4, form: 3 }),
    ];
    const f = actions.find((a) => a.kind === "fill" && a.node === s.focus);
    const values = ([[1, s.draft], [2, s.title]] as [number, string][]).filter(([, v]) => v.trim() !== "");
    return obs(UPLOAD, actions, ["Upload Source", ...s.chips, s.submitted !== null ? `Submitted: ${s.submitted}` : ""].filter(Boolean).join("\n"), {
      doc: DOC, filled: values.map(([n]) => n), texts: values,
      focus: f ? { node: f.node as number, label: f.label, role: "textbox", submitLabel: SUBMIT, editable: true, value: f.value ?? "", form: 3, submitDefault: SUBMIT, multiline: false } : null,
    });
  }

  it("the gate's script Enter that adds a chip before a submit is in result.steps (press_key, Enter)", async () => {
    const s: ChipState = { draft: "", title: "Weekly sync", chips: ["x"], focus: null, submitted: null };
    const fill: Decide = (q) => ({ page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", "textbox"), confidence: 0.8 }, type_text_value: { choice: "v_b", confidence: 0.9 } });
    const t = setup("add the participants, set the title, then submit", {
      pages: { u: chipPage(s) }, start: "u",
      popup: (a, _c, focus) => { if (focus && a.node !== null) s.focus = a.node; return CLOSED; },
      commit: (a) => { if (s.focus !== a.node) return { skipped: "focus" }; if (s.draft.trim() === "") return { prevented: false }; s.chips.push(s.draft); s.draft = ""; return { prevented: true }; },
    }, seq(fill, click(SUBMIT), click(SUBMIT), finish), { url: UPLOAD, vars: { b: "bob@example.com" }, maxSteps: 10 });
    t.page.observe = async () => { t.page.observes += 1; return chipPage(s); };
    const act = t.page.act.bind(t.page);
    t.page.act = async (a, o, text) => {
      await act(a, o, text);
      if (a.kind === "fill" && a.node === 1) { s.draft = text ?? ""; s.focus = 1; }
      else if (a.node === 4) { s.submitted = [...s.chips, s.title].join(" | "); s.focus = null; }
    };
    const r = await t.runner.run();
    expect(r.outcome).toBe("done");
    expect(t.page.calls.filter((c) => c.op !== "navigate").map((c) => (c.op === "act" ? `${c.kind} ${c.id}` : `${c.op} ${c.id ?? ""}`.trim()))).toEqual(["fill e1", "commit e1", "click e4"]);
    expect(s.submitted).toBe("x | bob@example.com | Weekly sync");
    // Current code: steps are fill:ok, click:ok, none:done. The script Enter that added "bob@example.com" has no record.
    expect(r.steps.map((x) => `${x.action}:${x.result}`)).toContain("press_key:ok");
  });
});
