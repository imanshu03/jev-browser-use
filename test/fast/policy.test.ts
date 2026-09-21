import type { ChoiceQuestion } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { checkBudget } from "../../src/jev.js";
import type { Answers } from "../../src/jev.js";
import type { Span } from "../../src/types.js";
import { LIMITS } from "../../src/types.js";
import { RULES, TARGET_RULES, actionSpace, answerLines, buildStep, cutText, readStep, rulesFor } from "../../src/fast/policy.js";
import type { StepInput } from "../../src/fast/policy.js";
import { el, obs, scrollDown, scrollUp } from "./fakes.js";

const criteriaKeys = (q: unknown): string[] => Object.keys((q as ChoiceQuestion | undefined)?.criteria ?? {});
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
    expect(b.questions["type_text_value"]).toBeUndefined();
    const b2 = buildStep(input({ doneBanned: true, obs: obs("https://a.b/", [el("e1", "fill", "Query", "searchbox"), scrollDown()]), spans: [span("s1", "Alan")] }));
    const ops = criteriaKeys(b2.questions["operation"]);
    expect(ops).toContain("TYPE_TEXT");
    expect(ops).toContain("SCROLL_DOWN");
    expect(ops).not.toContain("SCROLL_UP");
    expect(ops).not.toContain("CLICK");
    expect(ops).not.toContain("DONE");
    expect(criteriaKeys(b2.questions["type_text_value"])).toEqual(["s1", "none"]);
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
  it("secret spans are masked in the state and in type_text_value; the value never appears in the request", () => {
    const o = obs("https://a.b/login", [el("e1", "fill", "Password", "textbox")]);
    const b = buildStep(input({ obs: o, spans: [span("v_password", "hunter2", true, "var"), span("s1", "alice", false)] }));
    const json = JSON.stringify({ state: b.state, questions: b.questions });
    expect(json).not.toContain("hunter2");
    expect(json).toContain("<secret value for password>");
    const state = b.state as { typed_values: { id: string; text: string; secret: boolean }[] };
    expect(state.typed_values).toEqual([{ id: "v_password", text: "<secret value for password>", secret: true }, { id: "s1", text: "alice", secret: false }]);
    const q = b.questions["type_text_value"] as ChoiceQuestion;
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
    expect(criteriaKeys(built.questions.type_text_value)).toContain("s1");
  });
  it("offers Enter after text is present, and excludes it without focus", () => {
    const page = obs("https://example.com/chat", [], "", { focus: { node: 1, label: "Message", role: "textbox", submitLabel: "Send", editable: true, value: "List my latest meetings" } });
    expect(criteriaKeys(buildStep(input({ obs: page })).questions.operation)).toContain("PRESS_ENTER");
    page.focus = null;
    expect(criteriaKeys(buildStep(input({ obs: page })).questions.operation)).not.toContain("PRESS_ENTER");
  });
});
