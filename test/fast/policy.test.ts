import type { ChoiceQuestion } from "@typesafe-ai/sdk";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkBudget } from "../../src/jev.js";
import type { Answers } from "../../src/jev.js";
import { extractSpans } from "../../src/task.js";
import type { Span } from "../../src/types.js";
import { LIMITS } from "../../src/types.js";
import { BLOCKED_VALUE_GEN, DONE_SENT, DONE_TEXT, ENTER_PICKS, GENERATE, MODES, MODE_Q, NONE_VALUE, RULES, TARGET_RULES, TYPE_TEXT_GEN, TYPE_TEXT_HELD, TYPE_TEXT_HELD_GEN, VALUE_Q, VALUE_Q_GEN, VALUE_Q_NEW, VALUE_Q_NEW_GEN, actionSpace, answerLines, buildStep, buildValueStep, canWriteInto, cutText, fieldLines, readEdit, readStep, readValue, rulesFor, tokenEvidence } from "../../src/fast/policy.js";
import type { StepInput } from "../../src/fast/policy.js";
import type { Observation, TokenFacts } from "../../src/fast/model.js";
import { el, obs, scrollDown, scrollUp } from "./fakes.js";

const criteriaKeys = (q: unknown): string[] => Object.keys((q as ChoiceQuestion | undefined)?.criteria ?? {});
const valueHeads = (questions: Record<string, unknown>): string[] => Object.keys(questions).filter((k) => k.startsWith("value_"));
const span = (id: string, text: string, secret = false, source: Span["source"] = "quoted"): Span => ({ id, text, source, secret });

function input(over: Partial<StepInput> = {}): StepInput {
  return {
    task: "click English", goal: "act", history: [], spans: [], keys: [], bannedActionIds: new Set(), doneBanned: false,
    obs: obs("https://a.b/", [el("e1", "click", "English", "link"), el("e2", "click", "Search", "button")]),
    ...over,
  };
}

describe("RULES", () => {
  it("keeps the proto rules and adds the jev-ultrafast lines", () => {
    const all = RULES.join("\n");
    expect(all).toContain("detailed view");
    expect(all).toContain("autocomplete suggestion");
    expect(all).toContain("date pickers");
    expect(all).toContain("Recent WAIT actions are not evidence of loading");
    expect(all).toContain("PRESS_ENTER submits the focused field. GO_BACK returns to the previous page.");
    expect(rulesFor("extract").join("\n")).toContain("SCROLL_DOWN when it is not");
    expect(rulesFor("act")).toEqual(RULES);
    expect(TARGET_RULES).toContain("Choose only an offered element");
  });
});

describe("actionSpace", () => {
  it("one index per node, select options as i:n, scroll and wait as controls", () => {
    const actions = [
      el("e1", "fill", "Query", "searchbox", { node: 10, value: "" }),
      el("e2", "click", "Open Query", "searchbox", { node: 10, value: "" }),
      el("e3", "select", "Size → Small", "combobox", { node: 11, value: "s", current_value: "Large" }),
      el("e4", "select", "Size → Medium", "combobox", { node: 11, value: "m", current_value: "Large" }),
      el("e5", "click", "Go", "button", { node: 12 }),
      scrollDown(), scrollUp(), { id: "wait", kind: "wait" as const, node: null, label: "Wait" },
    ];
    const s = actionSpace(actions);
    expect(s.elements.map((e) => e.index)).toEqual(["1", "2", "3"]);
    expect(s.elements[0]).toMatchObject({ index: "1", label: "Query", operations: ["TYPE_TEXT", "CLICK"] });
    expect(s.elements[1]).toMatchObject({ index: "2", label: "Size", value: "Large", operations: ["SELECT"], options: [{ index: "2:1", label: "Size → Small", value: "s" }, { index: "2:2", label: "Size → Medium", value: "m" }] });
    expect(Object.keys(s.targets.SELECT)).toEqual(["2:1", "2:2"]);
    expect(s.targets.CLICK["1"]?.id).toBe("e2");
    expect(s.targets.TYPE_TEXT["1"]?.id).toBe("e1");
    expect(s.targets.CLICK["3"]?.id).toBe("e5");
    expect(Object.keys(s.controls).sort()).toEqual(["SCROLL_DOWN", "SCROLL_UP", "WAIT"]);
  });
});

describe("buildStep", () => {
  it("operation options follow the page: no TYPE_TEXT or SELECT without such fields, scroll only when offered, DONE unless banned", () => {
    const b = buildStep(input());
    expect(criteriaKeys(b.questions["operation"])).toEqual(["CLICK", "WAIT", "PRESS_ENTER", "GO_BACK", "DONE", "BLOCKED"]);
    expect(b.questions["type_text_target"]).toBeUndefined();
    expect(b.questions["select_target"]).toBeUndefined();
    expect(valueHeads(b.questions)).toEqual([]);
    const b2 = buildStep(input({ doneBanned: true, obs: obs("https://a.b/", [el("e1", "fill", "Query", "searchbox"), scrollDown()]), spans: [span("s1", "Alan")] }));
    const ops = criteriaKeys(b2.questions["operation"]);
    expect(ops).toContain("TYPE_TEXT");
    expect(ops).toContain("SCROLL_DOWN");
    expect(ops).not.toContain("SCROLL_UP");
    expect(ops).not.toContain("CLICK");
    expect(ops).not.toContain("DONE");
    expect(criteriaKeys(b2.questions["value_1"])).toEqual(["s1", "none"]);
    expect(b2.questions["type_text_target"]).toBeDefined();
    expect(b2.questions["page_kind"]).toBeDefined();
    expect(b2.questions["blocked_reason"]).toBeDefined();
    expect(b2.questions["answer_state"]).toBeUndefined();
    expect(b2.questions["answer_line"]).toBeUndefined();
  });
  it("target heads exclude banned ids and vanish when empty; the operation is not offered then", () => {
    const b = buildStep(input({ bannedActionIds: new Set(["e1"]) }));
    expect(criteriaKeys(b.questions["click_target"])).toEqual(["2"]);
    expect(b.meta.targets.CLICK).toEqual({ "2": "e2" });
    const b2 = buildStep(input({ bannedActionIds: new Set(["e1", "e2"]) }));
    expect(b2.questions["click_target"]).toBeUndefined();
    expect(criteriaKeys(b2.questions["operation"])).not.toContain("CLICK");
  });
  it("select targets are keyed i:n and map to action ids; the state row carries the current value", () => {
    const o = obs("https://a.b/", [el("e1", "select", "Size → Small", "combobox", { node: 4, value: "s", current_value: "Large" }), el("e2", "select", "Size → Medium", "combobox", { node: 4, value: "m", current_value: "Large" })]);
    const b = buildStep(input({ obs: o }));
    expect(criteriaKeys(b.questions["select_target"])).toEqual(["1:1", "1:2"]);
    expect(b.meta.targets.SELECT).toEqual({ "1:1": "e1", "1:2": "e2" });
    const q = b.questions["select_target"] as ChoiceQuestion;
    expect(q.criteria["1:2"]).toMatchObject({ element: "[1:2] Size → Medium", current_value: "Large", role: "combobox" });
    const state = b.state as { elements: { index: string; value?: string; options?: unknown[] }[] };
    expect(state.elements[0]).toMatchObject({ index: "1", value: "Large" });
    expect(state.elements[0]?.options).toHaveLength(2);
  });
  it("secret spans are masked in the state and in the value head; the value never appears in the request", () => {
    const o = obs("https://a.b/login", [el("e1", "fill", "Password", "textbox")]);
    const b = buildStep(input({ obs: o, spans: [span("v_password", "hunter2", true, "var"), span("s1", "alice", false)] }));
    const json = JSON.stringify({ state: b.state, questions: b.questions });
    expect(json).not.toContain("hunter2");
    expect(json).toContain("<secret value for password>");
    const state = b.state as { typed_values: { id: string; text: string; secret: boolean }[] };
    expect(state.typed_values).toEqual([{ id: "v_password", text: "<secret value for password>", secret: true }, { id: "s1", text: "alice", secret: false }]);
    const q = b.questions["value_1"] as ChoiceQuestion;
    expect(q.criteria["v_password"]).toBe("<secret value for password>");
    expect(q.criteria["s1"]).toBe("alice");
  });
  it("check heads exist only for check goals; extract heads only for extract goals", () => {
    const c = buildStep(input({ goal: "check" }));
    expect(criteriaKeys(c.questions["answer_state"])).toEqual(["yes", "no", "not_visible_yet"]);
    expect(criteriaKeys(c.questions["evidence"])).toEqual(["1", "2", "none"]);
    expect(c.questions["answer_line"]).toBeUndefined();
    const x = buildStep(input({ goal: "extract", obs: obs("https://a.b/", [el("e1", "click", "Home", "link")], "Alan Turing\nAlan Turing\n\n  was a mathematician  \n") }));
    expect(x.questions["answer_state"]).toBeUndefined();
    expect(criteriaKeys(x.questions["answer_line"])).toEqual(["l1", "l2", "none"]);
    expect(x.meta.lines).toEqual({ l1: "Alan Turing", l2: "was a mathematician" });
    expect(x.questions["answer_visible"]?.type).toBe("noul");
    const rules = ((x.questions["operation"] as ChoiceQuestion).instructions as { rules: string[] }).rules;
    expect(rules[rules.length - 1]).toContain("SCROLL_DOWN when it is not");
  });
  it("answer lines are deduplicated, cut to answerLineChars, and capped at answerLines", () => {
    const long = "x".repeat(400);
    const lines = answerLines([long, "a", "a", ...Array.from({ length: 400 }, (_, i) => `line ${i}`)].join("\n"));
    expect(lines).toHaveLength(LIMITS.answerLines);
    expect(lines[0]).toHaveLength(LIMITS.answerLineChars);
    expect(lines.filter((l) => l === "a")).toHaveLength(1);
  });
  it("recent_actions carries the last ten history entries with four fields", () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ action: `a${i}`, kind: "click", text: null, page_changed: true, step: i + 1, url: "u", operation: "CLICK" }));
    const b = buildStep(input({ history }));
    const ra = (b.state as { recent_actions: unknown[] }).recent_actions;
    expect(ra).toHaveLength(10);
    expect(ra[0]).toEqual({ action: "a2", kind: "click", text: null, page_changed: true });
  });
  it("the trim ladder brings an oversized state under budget and records each cut", () => {
    const label = "Long label ".repeat(11);
    const actions = Array.from({ length: 250 }, (_, i) => el(`e${i + 1}`, "click", `${label}${i}`, "link"));
    const big = obs("https://a.b/", actions, "t".repeat(6000));
    const raw = input({ obs: big, goal: "extract" });
    const b = buildStep(raw);
    expect(b.meta.cuts.length).toBeGreaterThan(0);
    expect(() => checkBudget(b.state, b.questions)).not.toThrow();
    const state = b.state as { elements: unknown[]; page: { text: string } };
    expect(state.elements.length).toBeLessThanOrEqual(LIMITS.fastElementsTrimmed);
    expect(state.page.text.length).toBeLessThanOrEqual(LIMITS.textCharsTrimmed);
    expect(criteriaKeys(b.questions["click_target"]).length).toBeLessThanOrEqual(LIMITS.fastElementsTrimmed);
  });
});

describe("readStep", () => {
  const ans = (o: Record<string, { choice: string; confidence?: number; probabilities?: Record<string, number> } | number>): Answers => {
    const out: Answers = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "number") out[k] = { type: "noul", noul: v };
      else out[k] = { type: "choice", choice: v.choice, confidence: v.confidence ?? 0.9, probabilities: v.probabilities ?? { [v.choice]: v.confidence ?? 0.9 } };
    }
    return out;
  };
  it("reads the operation, its target head, the value, page kind, and the goal heads", () => {
    const inp = input({ goal: "check", spans: [span("s1", "Alan")] });
    const b = buildStep(inp);
    const d = readStep(ans({
      operation: { choice: "CLICK", confidence: 0.8, probabilities: { CLICK: 0.8, DONE: 0.15, WAIT: 0.05 } },
      click_target: { choice: "2", confidence: 0.7, probabilities: { "1": 0.3, "2": 0.7 } },
      page_kind: { choice: "task_page", confidence: 0.95 },
      blocked_reason: { choice: "other" },
      answer_state: { choice: "yes", confidence: 0.75, probabilities: { yes: 0.75, no: 0.2, not_visible_yet: 0.05 } },
      evidence: { choice: "1" },
    }), b.meta, inp);
    expect(d.operation).toBe("CLICK");
    expect(d.pDone).toBe(0.15);
    expect(d.target).toMatchObject({ actionId: "e2", key: "2", conf: 0.7, runnerUp: 0.3, label: "Search" });
    expect(d.pageKind).toBe("task_page");
    expect(d.blockedReason).toBe("other");
    expect(d.answerState).toMatchObject({ choice: "yes", conf: 0.75, pYes: 0.75 });
    expect(d.evidence).toBe("English");
  });
  it("tolerates missing and unknown heads without throwing", () => {
    const inp = input({ goal: "extract" });
    const b = buildStep(inp);
    const d = readStep({}, b.meta, inp);
    expect(d.operation).toBeNull();
    expect(d.operationConf).toBe(0);
    expect(d.pDone).toBe(0);
    expect(d.target).toBeUndefined();
    expect(d.pageKind).toBeNull();
    expect(d.answerLine).toBeUndefined();
    expect(d.answerVisible).toBeUndefined();
    const d2 = readStep(ans({ operation: { choice: "TYPE_TEXT" }, answer_line: { choice: "zz" }, evidence: { choice: "99" }, page_kind: { choice: "weird" } }), b.meta, inp);
    expect(d2.operation).toBe("TYPE_TEXT");
    expect(d2.target).toBeUndefined();
    expect(d2.answerLine).toBe("none");
    expect(d2.evidence).toBeUndefined();
    expect(d2.pageKind).toBeNull();
  });
});

describe("label and value caps", () => {
  it("cuts long labels and values in elements, target criteria, and meta labels", () => {
    const long = "Account card ".repeat(40);
    const value = "v".repeat(300);
    const actions = [el("e1", "click", long, "link"), el("e2", "fill", "Email", "textbox", { value }), el("e3", "select", "Size → " + long, "combobox", { value: "s", current_value: value })];
    const s = actionSpace(actions);
    expect(s.elements[0]?.label.length).toBeLessThanOrEqual(LIMITS.nameChars);
    expect(s.elements[1]?.value?.length).toBeLessThanOrEqual(LIMITS.valueChars);
    expect(s.elements[2]?.options?.[0]?.label.length).toBeLessThanOrEqual(LIMITS.nameChars);
    const built = buildStep({ task: "open a.b and click the card", goal: "act", obs: obs("https://a.b/", actions), history: [], spans: [], keys: [], bannedActionIds: new Set(), doneBanned: false });
    const q = built.questions["click_target"] as ChoiceQuestion;
    const row = Object.values(q.criteria)[0] as { element: string };
    expect(row.element.length).toBeLessThanOrEqual(LIMITS.nameChars + 6);
    const fill = built.questions["type_text_target"] as ChoiceQuestion;
    const frow = Object.values(fill.criteria)[0] as { current_value: string };
    expect(frow.current_value.length).toBeLessThanOrEqual(LIMITS.valueChars);
    for (const l of Object.values(built.meta.labels)) expect(l.length).toBeLessThanOrEqual(LIMITS.nameChars);
    expect(cutText("  a   b  ", 10)).toBe("a b");
  });
});


describe("Enter readiness", () => {
  it.each(["", "  ", "\n"])("offers fill but excludes Enter for an empty focused editor (%j)", (value) => {
    const page = obs("https://example.com/chat", [el("e1", "fill", "Message", "textbox", { value })], "", {
      focus: { node: 1, label: "Message", role: "textbox", submitLabel: "Send", editable: true, value },
    });
    const built = buildStep(input({ obs: page, spans: [span("s1", "List my latest meetings")] }));
    expect(criteriaKeys(built.questions.operation)).toContain("TYPE_TEXT");
    expect(criteriaKeys(built.questions.operation)).not.toContain("PRESS_ENTER");
    expect(criteriaKeys(built.questions.value_1)).toContain("s1");
  });
  it("offers Enter after text is present, and excludes it without focus", () => {
    const page = obs("https://example.com/chat", [], "", { focus: { node: 1, label: "Message", role: "textbox", submitLabel: "Send", editable: true, value: "List my latest meetings" } });
    expect(criteriaKeys(buildStep(input({ obs: page })).questions.operation)).toContain("PRESS_ENTER");
    page.focus = null;
    expect(criteriaKeys(buildStep(input({ obs: page })).questions.operation)).not.toContain("PRESS_ENTER");
  });
});

describe("the option that Enter picks", () => {
  const LABEL = "Ask AI: “Q3 Roadmap” press ↵ to chat";
  const page = (enterOption?: { node: number; label: string }): Observation => obs("https://app.example/dash", [
    el("e1", "fill", "Search or ask AI anything...", "textbox", { value: "Q3 Roadmap", multiline: true }),
    el("e14", "click", LABEL, "option", { selected: "true" }),
    el("e15", "click", "Q3 Roadmap press ↵ to open", "option", { selected: "false" }),
  ], "Q3 Roadmap", { focus: { node: 1, label: "Q3 Roadmap", role: "textbox", submitLabel: "Send message", editable: true, value: "Q3 Roadmap", multiline: true, ...(enterOption ? { enterOption } : {}) } });

  it("the state shows the option label as focus.enter_picks, never its node; the Enter text names focus.enter_picks and holds no page text", () => {
    const built = buildStep(input({ task: "open the Q3 Roadmap artifact", obs: page({ node: 14, label: LABEL }) }));
    const focus = (built.state as { focus: Record<string, unknown> }).focus;
    expect(focus).toEqual({ node: 1, label: "Q3 Roadmap", role: "textbox", submitLabel: "Send message", editable: true, value: "Q3 Roadmap", enter_picks: LABEL });
    const enter = (built.questions.operation as ChoiceQuestion).criteria["PRESS_ENTER"];
    expect(enter).toBe(ENTER_PICKS);
    expect(JSON.stringify(built.questions.operation)).not.toContain("Ask AI");
  });

  it("a long option label is cut, and without an option the Enter text and the focus stay as before", () => {
    const long = "Ask AI: " + "x".repeat(200);
    const built = buildStep(input({ obs: page({ node: 14, label: long }) }));
    expect(((built.state as { focus: { enter_picks: string } }).focus.enter_picks).length).toBeLessThanOrEqual(LIMITS.nameChars);
    const plain = buildStep(input({ obs: page() }));
    expect((plain.questions.operation as ChoiceQuestion).criteria["PRESS_ENTER"]).toBe("Press Enter to submit the focused field.");
    expect((plain.state as { focus: Record<string, unknown> }).focus).not.toHaveProperty("enter_picks");
  });

  it("a secret in the option label is redacted like the page", () => {
    const built = buildStep(input({ obs: page({ node: 14, label: "Ask AI: s3cr3tvalue" }), spans: [span("v_token", "s3cr3tvalue", true, "var")] }));
    expect(JSON.stringify(built.state)).not.toContain("s3cr3tvalue");
  });
});

describe("requests without a text source (regression)", () => {
  const digest = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  const reply = (over: Partial<Observation> = {}): Observation => obs("https://mail.example/t/1", [
    el("e1", "fill", "Search mail", "searchbox", { value: "", inputType: "search", form: null, multiline: false }),
    el("e2", "fill", "Cc", "textbox", { value: "", inputType: "email", form: 7, multiline: false, autocomplete: "email" }),
    el("e3", "fill", "Subject", "textbox", { value: "Re: Tuesday", inputType: "text", form: 7, multiline: false, maxLength: 120 }),
    el("e4", "fill", "Reply", "textbox", { value: "", form: 7, multiline: true }),
    el("e5", "click", "Send", "button", { form: 7, multiline: false }),
    el("e6", "select", "Priority → High", "combobox", { node: 9, value: "h", current_value: "Normal", form: 7 }),
    scrollDown(),
  ], "Meeting on Tuesday\nFrom: Ann Lee\nCan we meet on Tuesday at 10:00?\ntoken s3cr3t", { doc: 1727000000000.5, focus: { node: 4, label: "Reply", role: "textbox", submitLabel: "Send", editable: true, value: "" }, ...over });
  const spans: Span[] = [
    span("s1", "red shoes"), span("s2", "Ann that Tuesday at 10:00 works", false, "after_verb"), span("s3", "Ann", false, "after_verb"),
    span("s4", "10:00", false, "number"), span("s5", "reply to Ann that Tuesday at 10:00 works", false, "clause"),
    span("s6", "open mail.example and reply to Ann that Tuesday at 10:00 works", false, "whole_task"),
    span("v_token", "s3cr3t", true, "var"), span("v_name", "Ann Lee", false, "var"),
  ];
  const history = [
    { action: "Search mail", kind: "fill", text: "Ann", page_changed: false, step: 1, url: "https://mail.example/", operation: "TYPE_TEXT" },
    { action: "Meeting on Tuesday", kind: "click", text: null, page_changed: true, step: 2, url: "https://mail.example/t/1", operation: "CLICK" },
  ];
  const cases = (): StepInput[] => {
    const label = "Long label ".repeat(11);
    const big = obs("https://a.b/", Array.from({ length: 250 }, (_, i) => el(`e${i + 1}`, i % 25 ? "click" : "fill", `${label}${i}`, i % 25 ? "link" : "textbox", { multiline: i % 2 === 0, form: 3 })), "t".repeat(6000));
    return [
      input(),
      input({ task: "open mail.example and reply to Ann that Tuesday at 10:00 works", obs: reply(), spans, history, keys: [{ label: "k1", key: "Enter" }], retryReason: "CLICK on \"Send\" was not executed: low_target. token s3cr3t" }),
      input({ task: "check if Ann wrote about Tuesday", goal: "check", obs: reply(), spans, history }),
      input({ task: "read the time Ann proposes", goal: "extract", obs: reply({ focus: null }), spans: [...spans.slice(0, 3), span("v_token", "s3cr3t", true, "var")] }),
      input({ task: "reply to Ann", obs: reply(), spans, bannedActionIds: new Set(["e4", "e1"]), doneBanned: true }),
      input({ task: "open a.b and read the heading", goal: "extract", obs: big, spans }),
    ];
  };

  it("buildStep state and questions without a text source keep their digest", () => {
    const out = cases().map((c) => { const b = buildStep(c); return { state: b.state, questions: b.questions }; });
    expect(JSON.stringify(out)).not.toContain("s3cr3t");
    // Taken again on 2026-09-23, when one value head per field replaced the shared type_text_value head and a field that
    // can take new text stopped offering the whole task and clauses.
    expect(digest(out)).toBe("178a072984aa987ea32ac9fd740b7ab5dc35d88cd51db2e887485cab5ee72209");
  });
});

describe("value heads: one per TYPE_TEXT field", () => {
  const reply = () => obs("https://mail.example/t/1", [
    el("e1", "fill", "Search mail", "searchbox", { value: "" }),
    el("e2", "fill", "Reply", "textbox", { value: "", form: 7, multiline: true }),
    el("e3", "click", "Send", "button", { form: 7 }),
  ], "Can we meet on Tuesday at 10:00?", { doc: 1.5 });
  const generated = (id: string, text: string, label = "Reply", node = 2): Span => ({ id, text, source: "generated", secret: false, field: { key: `1.5|${node}`, label, request: "t1" } });
  const taskSpans = [span("s1", "red shoes"), span("s2", "Ann that Tuesday at 10:00 works", false, "after_verb"), span("s3", "Ann that Tuesday", false, "after_verb"),
    span("s4", "reply to Ann", false, "clause"), span("s5", "open mail and reply to Ann", false, "whole_task"), span("v_token", "s3cr3t", true, "var")];
  const ask = (over: Partial<StepInput>) => buildStep(input({ task: "reply to Ann that Tuesday at 10:00 works", obs: reply(), ...over }));
  const json = (b: ReturnType<typeof buildStep>) => JSON.stringify({ state: b.state, questions: b.questions });
  const instr = (q: unknown) => (q as ChoiceQuestion).instructions as Record<string, unknown>;

  it("each head names its field, with its role and current value; without a text source it offers every span and none", () => {
    for (const spans of [[], taskSpans]) {
      const off = ask({ spans, canGenerate: false });
      expect(off).toEqual(ask({ spans }));
      expect(off.meta.generate).toBe(false);
      const text = json(off);
      for (const t of [GENERATE, VALUE_Q_GEN, TYPE_TEXT_GEN, BLOCKED_VALUE_GEN]) expect(text).not.toContain(t);
      expect((off.questions["operation"] as ChoiceQuestion).criteria["TYPE_TEXT"]).toBe("Enter or replace text in an editable field. Another question chooses the value from the offered typed_values.");
      expect((off.questions["blocked_reason"] as ChoiceQuestion).criteria["needs_credential_or_value"]).toBe("A field needs a value that the goal and the offered typed_values do not contain");
    }
    const off = ask({ spans: taskSpans });
    expect(valueHeads(off.questions)).toEqual(["value_1", "value_2"]);
    for (const k of ["value_1", "value_2"]) expect((off.questions[k] as ChoiceQuestion).criteria["none"]).toBe(NONE_VALUE);
    // The search box takes an exact value and offers every span. Reply can take new text: without a text source it
    // leaves out the clause, the whole task, and the long after-verb fragment.
    expect(criteriaKeys(off.questions["value_1"])).toEqual(["s1", "s2", "s3", "s4", "s5", "v_token", "none"]);
    expect(criteriaKeys(off.questions["value_2"])).toEqual(["s1", "s3", "v_token", "none"]);
    // typed_values still lists every span in a run without a text source.
    expect((off.state as { typed_values: { id: string }[] }).typed_values.map((v) => v.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "v_token"]);
    expect(instr(off.questions["value_2"])).toEqual({ question: VALUE_Q, field: "[2] Reply", role: "textbox" });
    const filled = ask({ spans: taskSpans, obs: obs("https://a.b/", [el("e1", "fill", "Name", "textbox", { value: "Old Name" })]) });
    expect(instr(filled.questions["value_1"])).toEqual({ question: VALUE_Q, field: "[1] Name", role: "textbox", current_value: "Old Name" });
    expect(off.meta.values).toEqual({ "1": { spans: { s1: "s1", s2: "s2", s3: "s3", s4: "s4", s5: "s5", v_token: "v_token" }, generate: false }, "2": { spans: { s1: "s1", s3: "s3", v_token: "v_token" }, generate: false } });
    expect(valueHeads(ask({ spans: [] }).questions)).toEqual([]);
    expect(Object.keys(ask({}).questions)).not.toContain("type_text_value");
  });

  it("with a text source, only a field that can take new text offers generate, with the _GEN texts", () => {
    const b = ask({ spans: [], canGenerate: true });
    expect(b.meta.generate).toBe(true);
    expect(valueHeads(b.questions)).toEqual(["value_2"]);
    expect((b.questions["value_2"] as ChoiceQuestion).criteria).toEqual({ generate: GENERATE, none: NONE_VALUE });
    expect(instr(b.questions["value_2"])).toMatchObject({ question: VALUE_Q_GEN, field: "[2] Reply" });
    expect((b.questions["operation"] as ChoiceQuestion).criteria["TYPE_TEXT"]).toBe(TYPE_TEXT_GEN);
    expect((b.questions["blocked_reason"] as ChoiceQuestion).criteria["needs_credential_or_value"]).toBe(BLOCKED_VALUE_GEN);
    expect(criteriaKeys(b.questions["blocked_reason"])).toEqual(criteriaKeys(ask({ spans: [] }).questions["blocked_reason"]));
    expect((b.state as Record<string, unknown>)["typed_values"]).toBeUndefined();
    const search = obs("https://a.b/", [el("e1", "fill", "Search", "searchbox", { value: "" }), el("e2", "click", "Go", "button")]);
    const s1 = buildStep(input({ obs: search, spans: [], canGenerate: true }));
    expect(s1.meta.generate).toBe(false);
    expect(valueHeads(s1.questions)).toEqual([]);
    expect(json(s1)).not.toContain(TYPE_TEXT_GEN);
    expect(criteriaKeys(buildStep(input({ obs: search, spans: [span("s1", "shoes")], canGenerate: true })).questions["value_1"])).toEqual(["s1", "none"]);
    expect(ask({ spans: [], canGenerate: true, bannedActionIds: new Set(["e2"]) }).meta.generate).toBe(false);
    const to = obs("https://a.b/", [el("e1", "fill", "To", "textbox", { value: "" }), el("e2", "fill", "Email", "textbox", { value: "", inputType: "email" })]);
    const t = buildStep(input({ obs: to, spans: [span("s1", "ann@example.com")], canGenerate: true }));
    expect(t.meta.generate).toBe(false);
    expect(criteriaKeys(t.questions["value_1"])).toEqual(["s1", "none"]);
  });

  it("a head that can take new text leaves out clause, whole_task, and long after_verb spans; typed_values keeps every span", () => {
    const on = ask({ spans: taskSpans, canGenerate: true });
    expect(criteriaKeys(on.questions["value_2"])).toEqual(["s1", "s3", "v_token", "generate", "none"]);
    // The search box takes an exact value: it keeps every span and gets no generate.
    expect(criteriaKeys(on.questions["value_1"])).toEqual(["s1", "s2", "s3", "s4", "s5", "v_token", "none"]);
    // The operation and target heads read typed_values; it stays the same as in a request without a text source.
    expect((on.state as { typed_values: unknown }).typed_values).toEqual((ask({ spans: taskSpans }).state as { typed_values: unknown }).typed_values);
    expect(json(on)).not.toContain("s3cr3t");
  });

  it("orders a head as the text written for its field, the other spans, generate, none; text written for another field is not offered", () => {
    const b = ask({ spans: [span("s1", "red shoes"), span("v_name", "Ann Lee", false, "var"), generated("g1", "Tuesday works."), generated("g2", "Re: Tuesday", "Search mail", 1)], canGenerate: true });
    expect(criteriaKeys(b.questions["value_2"])).toEqual(["g1", "s1", "v_name", "generate", "none"]);
    expect((b.questions["value_2"] as ChoiceQuestion).criteria["g1"]).toBe("Tuesday works.");
    expect(b.meta.values["2"]).toEqual({ spans: { g1: "g1", s1: "s1", v_name: "v_name" }, generate: true });
    // Search mail cannot take new text, so it gets no generated value, not even its own.
    expect(criteriaKeys(b.questions["value_1"])).toEqual(["s1", "v_name", "none"]);
    expect((b.state as { typed_values: { id: string }[] }).typed_values.map((v) => v.id)).toEqual(["g1", "g2", "s1", "v_name"]);
  });

  it("a task value that repeats the text written for the field is left out of that head only", () => {
    const name = obs("https://a.b/", [el("e1", "fill", "Name", "textbox", { value: "", form: 3 }), el("e2", "fill", "Email", "textbox", { value: "", inputType: "email", form: 3 }), el("e3", "fill", "Nickname", "textbox", { value: "", form: 3 })], "form", { doc: 1.5 });
    const spans = [span("s1", "Ann Lee"), span("s2", "ann@example.com"), generated("g1", "ann  lee", "Name", 1)];
    const b = buildStep(input({ obs: name, spans, canGenerate: true }));
    expect(criteriaKeys(b.questions["value_1"])).toEqual(["g1", "s2", "generate", "none"]);
    expect(criteriaKeys(b.questions["value_3"])).toEqual(["s1", "s2", "generate", "none"]);
    // The longer value of a pair shows only with its cut: when the cut repeats the written text, both go.
    const task = "Type hello and send it to Ann";
    const pair = [...extractSpans(task), generated("g1", "hello", "Reply", 2)];
    const texts = (q: unknown) => criteriaKeys(q).map((k) => pair.find((x) => x.id === k)?.text ?? k);
    expect(texts(ask({ task, spans: pair, canGenerate: true }).questions["value_2"])).toEqual(["hello", "Ann", "generate", "none"]);
    expect(criteriaKeys(ask({ task, spans: pair, canGenerate: true }).questions["value_2"])[0]).toBe("g1");
    // Without written text, the plugin head offers both values of the pair.
    expect(texts(ask({ task, spans: extractSpans(task), canGenerate: true }).questions["value_2"])).toEqual(["hello", "hello and send it to Ann", "Ann", "generate", "none"]);
  });

  it("formats a generated span in typed_values with its source, field, and a text cut to 120 characters", () => {
    const long = `Tuesday at 10:00 works for me. ${"More words follow here. ".repeat(20)}`;
    for (const canGenerate of [false, true]) {
      const b = ask({ spans: [span("s1", "red shoes"), generated("g1", long)], canGenerate });
      const tv = (b.state as { typed_values: Record<string, unknown>[] }).typed_values;
      expect(tv[0]).toEqual({ id: "g1", text: cutText(long, LIMITS.spanChars), secret: false, source: "generated", field: "Reply" });
      expect(tv[1]).toEqual({ id: "s1", text: "red shoes", secret: false });
      expect(criteriaKeys(b.questions["value_2"]).includes("g1")).toBe(canGenerate);
      expect(criteriaKeys(b.questions["value_2"]).includes("generate")).toBe(canGenerate);
    }
    expect((ask({ spans: [generated("g1", long)], canGenerate: true }).questions["value_2"] as ChoiceQuestion).criteria["g1"]).toBe(cutText(long, LIMITS.spanChars));
  });

  it("readStep reads the head of the chosen field; generate only where it was offered", () => {
    const ans = (target: string, head: string, value: string): Answers => ({
      operation: { type: "choice", choice: "TYPE_TEXT", confidence: 0.9, probabilities: { TYPE_TEXT: 0.9 } },
      type_text_target: { type: "choice", choice: target, confidence: 0.8, probabilities: { [target]: 0.8 } },
      [head]: { type: "choice", choice: value, confidence: 0.7, probabilities: { [value]: 0.7 } },
    });
    const on = input({ obs: reply(), spans: [span("s1", "red shoes")], canGenerate: true });
    const b = buildStep(on);
    expect(readStep(ans("2", "value_2", "generate"), b.meta, on).value).toEqual({ generate: true, conf: 0.7 });
    expect(readStep(ans("2", "value_2", "s1"), b.meta, on).value).toEqual({ spanId: "s1", conf: 0.7 });
    expect(readStep(ans("2", "value_2", "none"), b.meta, on).value).toBe("none");
    // The search box has no generate option: a generate answer reads as none. Another field's answer is not read.
    expect(readStep(ans("1", "value_1", "generate"), b.meta, on).value).toBe("none");
    expect(readStep(ans("1", "value_2", "s1"), b.meta, on).value).toBeUndefined();
    expect(readValue(ans("1", "value_1", "s1"), b.meta, "1")).toEqual({ spanId: "s1", conf: 0.7 });
    const off = input({ obs: reply(), spans: [span("s1", "red shoes")] });
    expect(readStep(ans("2", "value_2", "generate"), buildStep(off).meta, off).value).toBe("none");
  });

  it("the step request holds LIMITS.valueHeads heads: the focused field, then the empty fields, then the rest", () => {
    const fields = Array.from({ length: 12 }, (_, i) => el(`e${i + 1}`, "fill", `Field ${i + 1}`, "textbox", { value: i < 3 ? "x" : "", form: 1 }));
    const page = obs("https://a.b/", fields, "form", { focus: { node: 2, label: "Field 2", role: "textbox", submitLabel: "", editable: true, value: "x" } });
    const b = buildStep(input({ obs: page, spans: [span("s1", "Ann")] }));
    expect(valueHeads(b.questions)).toHaveLength(LIMITS.valueHeads);
    expect(Object.keys(b.meta.values)).toEqual(["2", "4", "5", "6", "7", "8", "9", "10"]);
    // The value request of a field without a head: the same state and one head.
    const v = buildValueStep(input({ obs: page, spans: [span("s1", "Ann")] }), "1");
    expect(v).not.toBeNull();
    expect(Object.keys(v?.questions ?? {})).toEqual(["value_1"]);
    expect(v?.state).toEqual(b.state);
    expect(instr(v?.questions["value_1"])).toMatchObject({ field: "[1] Field 1", current_value: "x" });
    // A field with no value to offer has no head and no value request.
    expect(buildValueStep(input({ obs: page, spans: [] }), "1")).toBeNull();
  });

  it("an oversized request drops the extra value heads first, and a fill then asks in a value request", () => {
    const label = "Long label ".repeat(11);
    const fields = Array.from({ length: 40 }, (_, i) => el(`e${i + 1}`, "fill", `${label}${i}`, "textbox", { value: "" }));
    const many = Array.from({ length: 120 }, (_, i) => span(`s${i + 1}`, `value number ${i} `.repeat(7).slice(0, 118)));
    const b = buildStep(input({ obs: obs("https://a.b/", fields, "t".repeat(6000)), spans: many }));
    expect(() => checkBudget(b.state, b.questions)).not.toThrow();
    expect(b.meta.cuts[0]).toBe("over budget: value heads left out; a fill asks for its value in a second request");
    expect(valueHeads(b.questions)).toEqual([]);
    expect(buildValueStep(input({ obs: obs("https://a.b/", fields, "t".repeat(6000)), spans: many }), "1")?.questions["value_1"]).toBeDefined();
  });

  it("without a text source, a field that can take new text keeps a long name after a naming verb and drops other long fragments and descriptions of text", () => {
    const form = obs("https://a.b/", [el("e1", "fill", "Project Name", "textbox", { value: "" }), el("e2", "fill", "Search projects", "searchbox", { value: "" })]);
    const spans = [
      { ...span("s1", "QA Regression Suite Nightly Run", false, "after_verb"), verb: "called" },
      { ...span("s2", "a polite message that confirms our meeting", false, "after_verb"), verb: "write" },
      { ...span("s3", "a short note", false, "after_verb"), verb: "with" },
      span("s4", "send it", false, "clause"), span("s5", "Create a project called QA Regression Suite Nightly Run", false, "whole_task"),
      { ...span("s6", "Notes", false, "after_verb"), verb: "with" },
      { ...span("s7", "A Note on Style", false, "after_verb"), verb: "titled" },
    ];
    const b = buildStep(input({ obs: form, spans }));
    // "a short note" describes the text; "A Note on Style" after "titled" is a name.
    expect(criteriaKeys(b.questions["value_1"])).toEqual(["s1", "s6", "s7", "none"]);
    expect(criteriaKeys(b.questions["value_2"])).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "none"]);
  });

  it("a field that can take new text hides the cuts of a hidden fragment (CLI and plugin)", () => {
    const heads = (task: string, label: string, canGenerate = false): string[] => {
      const page = obs("https://a.b/", [el("e1", "fill", label, "textbox", { value: "", form: 1 }), el("e2", "click", "Save", "button", { form: 1 })]);
      const spans = extractSpans(task);
      const q = buildStep(input({ obs: page, spans, canGenerate })).questions["value_1"];
      return criteriaKeys(q).filter((k) => k !== "none" && k !== "generate").map((k) => spans.find((x) => x.id === k)?.text ?? k);
    };
    // The full value after "to" is hidden in the CLI, and so are its first words: the field answers none.
    expect(heads("set the subject to Quarterly budget review for Q3 planning, then send it", "Subject")).not.toEqual(expect.arrayContaining(["Quarterly budget review"]));
    expect(heads("set the subject to Quarterly budget review for Q3 planning, then send it", "Subject")).not.toContain("Quarterly");
    expect(heads("save it as My Quarterly Report Draft 2026", "Title")).not.toContain("My Quarterly Report Draft");
    expect(heads("set my status to Out of office until Monday", "Status")).not.toContain("Out");
    // The bench task: the cut "a short description" of the hidden fragment is not offered.
    const action = "Add an action with a short description of the follow-up on the API contract review, and assign it to Ann Lee";
    expect(heads(action, "What needs to be done?")).not.toContain("a short description");
    expect(heads(action, "What needs to be done?", true)).not.toContain("a short description");
    // "type" names the value, but a description after it is still a description.
    const typed = heads("type a polite message that confirms our meeting on Tuesday and send it", "Message");
    expect(typed).not.toContain("a polite message that confirms our meeting on Tuesday and send it");
    expect(typed).not.toContain("a polite message that confirms our meeting");
    // A short value after "to" stays, and so does a long name after "called".
    expect(heads("set my status to Out of office", "Status")).toContain("Out of office");
    // A message after "type" keeps its words; a message that the task only describes is not offered at all.
    expect(heads("Type we will review and approve it in the comment box", "Comment")).toContain("we will review and approve it");
    expect(heads("Type we will review and approve it in the comment box", "Comment")).not.toContain("we will review");
    expect(heads("Write thanks and confirm the meeting time in the reply", "Reply")).toEqual([]);
    expect(heads("Reply with we will review and approve it", "Reply")).toEqual([]);
    expect(heads("Answer with I will check and update the doc tomorrow", "Reply")).toEqual([]);
    // A message ends before the step that sends it, and a value before a step that acts on the page (CLI and plugin).
    for (const gen of [false, true]) {
      expect(heads("Type hello and press Enter", "Message", gen)).toEqual(["hello", "Enter"]);
      expect(heads("Write thanks and send it", "Message", gen)).toEqual(["thanks"]);
      expect(heads("Type lgtm and click Comment", "Comment", gen)).toEqual(["lgtm", "Comment"]);
      expect(heads("Rename the file to budget and click Save", "Name", gen)).toEqual(["budget", "Save"]);
      expect(heads("Set the title to weekly sync and press Enter", "Title", gen)).toEqual(["weekly sync", "Enter"]);
    }
    // A value that ends before the next step, a name before a qualifier, and a title in title case stay (CLI and plugin).
    for (const gen of [false, true]) {
      expect(heads("Rename the artifact to Q3 Budget Review and save it", "Artifact name", gen)).toContain("Q3 Budget Review");
      expect(heads("Change the display name to Ann Marie Lee and save", "Display name", gen)).toContain("Ann Marie Lee");
      expect(heads("Create a folder named Test Reports and open it", "Folder name", gen)).toContain("Test Reports");
      expect(heads("set the owner to Sarah Connor from the Berlin office", "Owner", gen)).toContain("Sarah Connor");
      expect(heads("set the subject to A Note on Pricing", "Subject", gen)).toContain("A Note on Pricing");
    }
    expect(heads("Create a project called QA Regression Suite Nightly Run", "Project Name")).toContain("QA Regression Suite Nightly Run");
  });

  it("the two values of a maybe cut show together when one passes; a longer value that shows only by its pair keeps its own cuts hidden", () => {
    const form = obs("https://a.b/", [el("e1", "fill", "Topic", "textbox", { value: "", form: 1 }), el("e2", "fill", "Search", "searchbox", { value: "", form: 1 })]);
    const av = (id: string, text: string, verb: string, extra: Partial<Span> = {}): Span => ({ ...span(id, text, false, "after_verb"), verb, ...extra });
    const spans: Span[] = [
      // The cut passes, so the head offers both values of the pair.
      av("s1", "Launch prep", "to", { pair: "s2" }), av("s2", "Launch prep and open Settings", "to", { pair: "s1" }),
      // Cuts of the longer value (a proper noun, a cut before a preposition) stay hidden with it.
      { ...span("s3", "Launch", false, "proper_noun"), parent: "s2" }, av("s4", "Launch prep and open", "to", { parent: "s2" }),
      // Both values fail their own rules: the head hides both.
      av("s5", "Quarterly budget review for Q3", "to", { pair: "s6" }), av("s6", "Quarterly budget review for Q3 and open Settings", "to", { pair: "s5" }),
      av("s7", "a short note", "write", { pair: "s8" }), av("s8", "a short note and send it to Ann", "write", { pair: "s7" }),
      // A cut of a value of more than 10 words.
      av("s9", "can you summarize the key points", "type", { longCut: true }),
    ];
    for (const canGenerate of [false, true]) {
      const q = buildStep(input({ obs: form, spans, canGenerate })).questions;
      expect(criteriaKeys(q["value_1"]).filter((k) => k !== "none" && k !== "generate")).toEqual(["s1", "s2"]);
      // A search box takes an exact value and offers every span.
      expect(criteriaKeys(q["value_2"]).filter((k) => k !== "none")).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]);
    }
  });

  it("with a text source, typed_values lists every span until the assistant's text is typed, then every span except the whole task and clauses", () => {
    const writable = obs("https://mail.example/t/1", [el("e2", "fill", "Reply", "textbox", { value: "", form: 7, multiline: true }), el("e3", "click", "Send", "button", { form: 7 })], "Can we meet?", { doc: 1.5 });
    const ids = (b: ReturnType<typeof buildStep>) => ((b.state as { typed_values?: { id: string }[] }).typed_values ?? []).map((v) => v.id);
    expect(ids(ask({ obs: writable, spans: taskSpans, canGenerate: true }))).toEqual(["s1", "s2", "s3", "s4", "s5", "v_token"]);
    expect(ids(ask({ obs: writable, spans: taskSpans, canGenerate: true, textTyped: true }))).toEqual(["s1", "s2", "s3", "v_token"]);
    // The same on a page whose fields offer every span: the list does not depend on the fields.
    expect(ids(ask({ spans: taskSpans, canGenerate: true, textTyped: true }))).toEqual(["s1", "s2", "s3", "v_token"]);
    // Without a text source, textTyped changes nothing.
    expect(ids(ask({ obs: writable, spans: taskSpans, textTyped: true }))).toEqual(["s1", "s2", "s3", "s4", "s5", "v_token"]);
    // Only a clause: no typed_values at all.
    expect((ask({ obs: writable, spans: [span("s4", "reply to Ann", false, "clause")], canGenerate: true, textTyped: true }).state as Record<string, unknown>)["typed_values"]).toBeUndefined();
  });

  it("the focus in the state leaves out the form facts", () => {
    const page = obs("https://chat.example/", [el("e1", "fill", "Message", "textbox", { value: "hi", form: 2 })], "chat",
      { focus: { node: 1, label: "Message", role: "textbox", submitLabel: "Send", editable: true, value: "hi", form: 2, submitDefault: "Send" } });
    expect((buildStep(input({ obs: page })).state as { focus: unknown }).focus).toEqual({ node: 1, label: "Message", role: "textbox", submitLabel: "Send", editable: true, value: "hi" });
  });

  it("readStep reads the click_target answer as `click` when the operation is PRESS_ENTER", () => {
    const page = obs("https://chat.example/", [el("e1", "fill", "Message", "textbox", { value: "hi", form: 2 }), el("e2", "click", "Send", "button", { form: 2 })], "chat",
      { focus: { node: 1, label: "Message", role: "textbox", submitLabel: "Send", editable: true, value: "hi" } });
    const inp = input({ obs: page });
    const b = buildStep(inp);
    const answers: Answers = {
      operation: { type: "choice", choice: "PRESS_ENTER", confidence: 0.45, probabilities: { PRESS_ENTER: 0.5, CLICK: 0.45, DONE: 0.05 } },
      click_target: { type: "choice", choice: "2", confidence: 0.9, probabilities: { "2": 0.95 } },
    };
    expect(readStep(answers, b.meta, inp).click).toMatchObject({ actionId: "e2", key: "2", label: "Send", conf: 0.9 });
    expect(readStep({ ...answers, operation: { type: "choice", choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 0.9 } } }, b.meta, inp).click).toBeUndefined();
  });
});

describe("mode heads: a field that holds text that the run did not type", () => {
  const doc = "Release 4.2 notes\nThis release improves the editor.\n\nChanges\n- Faster saving";
  const page = () => obs("https://a.b/doc", [
    el("e1", "fill", "Title", "textbox", { value: "Release 4.2 notes", inputType: "text" }),
    el("e2", "fill", "Document", "textbox", { value: doc, multiline: true }),
    el("e3", "fill", "Comment", "textbox", { value: "", multiline: true }),
    el("e4", "click", "Save", "button"),
  ], doc, { doc: 1.5 });
  const spans = [span("s1", "Reviewed by QA")];
  const ask = (over: Partial<StepInput> = {}) => buildStep(input({ task: 'add the line "Reviewed by QA" at the end and save', obs: page(), spans, ...over }));
  const instr = (q: unknown) => (q as ChoiceQuestion).instructions as Record<string, unknown>;
  const modeHeads = (q: Record<string, unknown>) => Object.keys(q).filter((k) => k.startsWith("mode_"));

  it("only a field in heldText gets a mode head, next to its value head, with the field's lines", () => {
    expect(modeHeads(ask().questions)).toEqual([]);
    const b = ask({ heldText: new Set([2]) });
    expect(modeHeads(b.questions)).toEqual(["mode_2"]);
    expect(b.meta.modes).toEqual({ "2": true });
    expect(criteriaKeys(b.questions["mode_2"])).toEqual(["replace_all", "append"]);
    expect((b.questions["mode_2"] as ChoiceQuestion).criteria).toEqual(MODES);
    expect(instr(b.questions["mode_2"])).toEqual({ question: MODE_Q, goal: 'add the line "Reviewed by QA" at the end and save', field: "[2] Document", current_lines: ["Release 4.2 notes", "This release improves the editor.", "Changes", "- Faster saving"] });
    // A banned field gets no head.
    expect(modeHeads(ask({ heldText: new Set([2]), bannedActionIds: new Set(["e2"]) }).questions)).toEqual([]);
  });

  it("the value head of a held field asks for the new text; the TYPE_TEXT text says a fill can add to a field", () => {
    const b = ask({ heldText: new Set([2]) });
    expect(instr(b.questions["value_2"])).toMatchObject({ question: VALUE_Q_NEW, field: "[2] Document" });
    expect(instr(b.questions["value_3"])).toMatchObject({ question: VALUE_Q });
    expect((b.questions["operation"] as ChoiceQuestion).criteria["TYPE_TEXT"]).toBe(TYPE_TEXT_HELD);
    const g = ask({ heldText: new Set([2]), canGenerate: true });
    expect(instr(g.questions["value_2"])).toMatchObject({ question: VALUE_Q_NEW_GEN });
    expect((g.questions["operation"] as ChoiceQuestion).criteria["TYPE_TEXT"]).toBe(TYPE_TEXT_HELD_GEN);
    // Without a held field, the texts stay as they were.
    expect((ask().questions["operation"] as ChoiceQuestion).criteria["TYPE_TEXT"]).toBe("Enter or replace text in an editable field. Another question chooses the value from the offered typed_values.");
    expect((ask({ canGenerate: true }).questions["operation"] as ChoiceQuestion).criteria["TYPE_TEXT"]).toBe(TYPE_TEXT_GEN);
  });

  it("the value request of a held field carries its mode head too", () => {
    const v = buildValueStep(input({ task: "add a line", obs: page(), spans, heldText: new Set([2]) }), "2");
    expect(Object.keys(v?.questions ?? {})).toEqual(["value_2", "mode_2"]);
    expect(v?.meta.modes).toEqual({ "2": true });
    // A value request of the var fallback asks for the value only: the loop keeps the mode of the first answer.
    const withVar = [...spans, span("v_note", "Reviewed by QA today", false, "var")];
    const only = buildValueStep(input({ task: "add a line", obs: page(), spans: withVar, heldText: new Set([2]), canGenerate: true }), "2", { vars: ["v_note"] });
    expect(Object.keys(only?.questions ?? {})).toEqual(["value_2"]);
    expect(criteriaKeys(only?.questions["value_2"])).toEqual(["v_note", "none"]);
    expect(instr(only?.questions["value_2"])).toMatchObject({ question: VALUE_Q_NEW });
    expect(only?.meta.modes).toEqual({});
    const rest = buildValueStep(input({ task: "add a line", obs: page(), spans: withVar, heldText: new Set([2]), canGenerate: true }), "2", { noVars: true });
    expect(Object.keys(rest?.questions ?? {})).toEqual(["value_2"]);
    expect(instr(rest?.questions["value_2"])).toMatchObject({ question: VALUE_Q_NEW_GEN });
  });

  it("readEdit maps replace_all to replace and append to append; readStep reads the chosen field's mode", () => {
    const inp = input({ task: "add a line", obs: page(), spans, heldText: new Set([2]) });
    const b = buildStep(inp);
    const mode = (choice: string, confidence: number): Answers => ({ mode_2: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } } });
    expect(readEdit(mode("append", 0.97), b.meta, "2")).toEqual({ mode: "append", conf: 0.97, probs: { append: 0.97 } });
    expect(readEdit(mode("replace_all", 0.85), b.meta, "2")).toMatchObject({ mode: "replace", conf: 0.85 });
    expect(readEdit(mode("prepend", 0.9), b.meta, "2")).toBeUndefined();
    expect(readEdit({}, b.meta, "2")).toBeUndefined();
    expect(readEdit(mode("append", 0.97), b.meta, "3")).toBeUndefined();
    const answers: Answers = { operation: { type: "choice", choice: "TYPE_TEXT", confidence: 0.8, probabilities: { TYPE_TEXT: 0.8 } }, type_text_target: { type: "choice", choice: "2", confidence: 0.9, probabilities: { "2": 0.9 } }, ...mode("append", 0.97) };
    expect(readStep(answers, b.meta, inp).edit).toMatchObject({ mode: "append", conf: 0.97 });
  });

  it("fieldLines drops zero-width characters and blank lines", () => {
    expect(fieldLines("\uFEFFRelease\n\n  two   words \n\u200B\n")).toEqual(["Release", "two words"]);
  });
});

describe("sends and the var fallback", () => {
  const brief = () => obs("https://app.example/workflows/new", [
    el("e1", "fill", "Workflow title", "textbox", { value: "", form: null }),
    el("e5", "fill", "Describe the workflow", "textbox", { value: "", form: 3, multiline: true }),
    el("e6", "click", "Send message", "button", { form: 3 }),
    el("e7", "fill", "Search", "searchbox", { value: "", inputType: "search", form: null }),
  ], "New workflow", { doc: 2.5 });
  const vars = [span("v_brief", "Send me a daily summary of new artifacts", false, "var"), span("v_channel", "#team-updates", false, "var"), span("v_token", "s3cr3t", true, "var")];
  const spans = [span("s1", "the workflow", false, "after_verb"), span("s2", "Describe the workflow and send it", false, "whole_task"), ...vars];
  const at = (over: Partial<StepInput> = {}) => input({ task: "Describe the workflow and send it", obs: brief(), spans, ...over });
  const criteria = (q: unknown) => (q as ChoiceQuestion).criteria;
  const instr = (q: unknown) => (q as ChoiceQuestion).instructions as Record<string, unknown>;

  it("a text source shows each non-secret var with its key; the CLI and a secret var keep their text", () => {
    const on = buildStep(at({ canGenerate: true }));
    expect(criteria(on.questions["value_2"])).toMatchObject({ v_brief: { var: "brief", value: "Send me a daily summary of new artifacts" }, v_channel: { var: "channel", value: "#team-updates" }, v_token: "<secret value for token>", generate: GENERATE });
    expect(criteria(on.questions["value_4"])).toMatchObject({ v_brief: { var: "brief", value: "Send me a daily summary of new artifacts" } });
    const off = buildStep(at());
    expect(criteria(off.questions["value_2"])).toMatchObject({ v_brief: "Send me a daily summary of new artifacts", v_token: "<secret value for token>" });
    expect(JSON.stringify(on)).not.toContain("s3cr3t");
  });

  it("the vars-only value request offers the listed vars and none with VALUE_Q; noVars offers the head without its vars", () => {
    const only = buildValueStep(at({ canGenerate: true }), "2", { vars: ["v_brief", "v_channel"] });
    expect(Object.keys(only?.questions ?? {})).toEqual(["value_2"]);
    expect(criteriaKeys(only?.questions["value_2"])).toEqual(["v_brief", "v_channel", "none"]);
    expect(instr(only?.questions["value_2"])).toMatchObject({ question: VALUE_Q, field: "[2] Describe the workflow" });
    expect(only?.meta.values["2"]).toEqual({ spans: { v_brief: "v_brief", v_channel: "v_channel" }, generate: false });
    // The state is the state of the step request.
    expect(only?.state).toEqual(buildStep(at({ canGenerate: true })).state);
    const rest = buildValueStep(at({ canGenerate: true }), "2", { noVars: true });
    expect(criteriaKeys(rest?.questions["value_2"])).toEqual(["s1", "generate", "none"]);
    expect(instr(rest?.questions["value_2"])).toMatchObject({ question: VALUE_Q_GEN });
    // A field with none of the listed vars has no head: no request.
    expect(buildValueStep(at({ canGenerate: true }), "2", { vars: [] })).toBeNull();
    expect(buildValueStep(at({ canGenerate: true, spans: [span("s1", "the workflow", false, "after_verb")] }), "2", { vars: ["v_brief"] })).toBeNull();
  });

  it("sentTexts adds sent_texts (redacted, cut) and the DONE_SENT text; without it the DONE text stays", () => {
    const long = `Every Friday, write a weekly status report with token s3cr3t. ${"More words. ".repeat(20)}`;
    const b = buildStep(at({ canGenerate: true, sentTexts: [{ field: "Describe the workflow", text: long }] }));
    expect(criteria(b.questions["operation"])["DONE"]).toBe(DONE_SENT);
    const state = b.state as Record<string, unknown>;
    expect(state["sent_texts"]).toEqual([{ field: "Describe the workflow", text: cutText(long.replace("s3cr3t", "***"), LIMITS.spanChars) }]);
    expect(Object.keys(state).slice(-2)).toEqual(["typed_values", "sent_texts"]);
    expect(JSON.stringify(b)).not.toContain("s3cr3t");
    const none = buildStep(at({ canGenerate: true }));
    expect(criteria(none.questions["operation"])["DONE"]).toBe(DONE_TEXT);
    expect((none.state as Record<string, unknown>)["sent_texts"]).toBeUndefined();
    expect(buildStep(at({ canGenerate: true, sentTexts: [] }))).toEqual(none);
    // DONE banned: no DONE option, but the state still holds the sent texts.
    const banned = buildStep(at({ canGenerate: true, doneBanned: true, sentTexts: [{ field: "Reply", text: "Tuesday works." }] }));
    expect(criteriaKeys(banned.questions["operation"])).not.toContain("DONE");
    expect((banned.state as Record<string, unknown>)["sent_texts"]).toEqual([{ field: "Reply", text: "Tuesday works." }]);
  });
});

describe("chip (token) fields", () => {
  const facts = (over: Partial<TokenFacts> = {}): TokenFacts => ({ items: [[1, "Meeting Participants (Optional)", 0]], chips: [], ...over });
  const field = (token?: TokenFacts) => el("e1", "fill", "textbox", "textbox", { node: 1, value: "", inputType: "text", ...(token ? { token } : {}) });

  it("tokenEvidence: strong for a learned field or a multiselect listbox, weak for the chip shape, null otherwise", () => {
    expect(tokenEvidence(field(facts({ learned: true })))).toBe("strong");
    expect(tokenEvidence(field(facts({ multi: true })))).toBe("strong");
    expect(tokenEvidence(field(facts({ chips: ["ann@example.com Remove participant"] })))).toBe("weak");
    // An open popup alone is not evidence here: the loop counts only a popup that opened with a fill.
    expect(tokenEvidence(field(facts({ popup: true })))).toBeNull();
    expect(tokenEvidence(field(facts()))).toBeNull();
    expect(tokenEvidence(field())).toBeNull();
    expect(tokenEvidence({ ...field(facts({ learned: true })), kind: "click" })).toBeNull();
  });

  it("canWriteInto: false only on strong evidence; the chip shape alone keeps a text field writable", () => {
    expect(canWriteInto(field(facts({ learned: true })))).toBe(false);
    expect(canWriteInto(field(facts({ multi: true })))).toBe(false);
    expect(canWriteInto(field(facts({ chips: ["Default branch"] })))).toBe(true);
    expect(canWriteInto(field(facts({ popup: true })))).toBe(true);
  });

  it("the chip facts never reach the request; a strong field's value head offers no generate", () => {
    const page = obs("https://a.b/upload", [
      field(facts({ learned: true, chips: ["ann@example.com Remove participant"], popup: true })),
      el("e2", "fill", "Title", "textbox", { node: 2, value: "", inputType: "text", token: facts() }),
    ]);
    const b = buildStep(input({ obs: page, canGenerate: true, spans: [span("s1", "bob@example.com")] }));
    const request = JSON.stringify([b.state, b.questions]);
    for (const key of ["token", "items", "chips", "learned", "multi", "popup"]) expect(request).not.toContain(`"${key}":`);
    expect(criteriaKeys(b.questions["value_1"])).not.toContain("generate");
    expect(criteriaKeys(b.questions["value_2"])).toContain("generate");
  });
});
