import { describe, expect, it } from "vitest";
import type { ChoiceQuestion } from "@typesafe-ai/sdk";
import { assertOptionCount, BudgetError, checkBudget } from "../src/jev.js";
import { buildConfirm, buildExtract, buildObserve, buildVerify, RULES, TARGET_RULES, trimToBudget, type ObserveInput } from "../src/questions.js";
import { parseSnapshot } from "../src/snapshot.js";
import type { Element, Span } from "../src/types.js";
import { LIMITS } from "../src/types.js";
import { snap } from "./fakes.js";

const el = (ref: string, role: string, name: string, extra: Partial<Element> = {}): Element => ({ ref, role, name, depth: 0, under: "", key: `${role}|${name}|`, attrs: {}, state: "", value: "", seen: 1, index: Number(ref.slice(1)), ...extra });
const span = (id: string, text: string, secret = false): Span => ({ id, text, source: "quoted", secret });

function observeInput(over: Partial<ObserveInput> = {}): ObserveInput {
  const page = parseSnapshot({ url: "https://x", title: "t", interactive: snap('- searchbox "Search" [ref=e1]\n- link "Go" [ref=e2]\n- button "Save" [ref=e3]\n- combobox "Lang" [expanded=false, ref=e4]: English\n  - option "English" [selected, ref=e5]\n  - option "Deutsch" [ref=e6]') });
  return { task: "search for cats", goal: "act", step: 1, maxSteps: 25, page, textExcerpt: "hello", history: [], candidates: page.elements, banned: [], typedValues: [], spans: [span("s1", "cats")], keys: [], urls: [], stalled: false, ...over };
}

describe("buildObserve", () => {
  it("builds the operation head from what the page offers, with RULES", () => {
    const { questions, heads, state } = buildObserve(observeInput());
    const op = questions["operation"] as ChoiceQuestion;
    expect(Object.keys(op.criteria)).toEqual(["CLICK", "TYPE_TEXT", "SELECT", "PRESS_KEY", "SCROLL_DOWN", "SCROLL_UP", "GO_BACK", "WAIT", "DONE", "BLOCKED"]);
    expect(op.instructions).toEqual({ goal: "search for cats", rules: RULES });
    expect(heads.operations).toContain("SELECT");
    expect(state["goal"]).toBe("search for cats");
    expect((state["elements"] as unknown[]).length).toBe(4);
    expect(state["elements"]).toContainEqual({ index: "e4", role: "combobox", name: "Lang", state: "expanded=false", value: "English" });
  });
  it("omits TYPE_TEXT, SELECT and OPEN_URL when the page or task cannot use them", () => {
    const page = parseSnapshot({ url: "https://x", title: "t", interactive: snap('- link "Go" [ref=e2]') });
    const { questions } = buildObserve(observeInput({ page, candidates: page.elements, urls: [] }));
    const op = questions["operation"] as ChoiceQuestion;
    expect(Object.keys(op.criteria)).not.toContain("TYPE_TEXT");
    expect(Object.keys(op.criteria)).not.toContain("SELECT");
    expect(Object.keys(op.criteria)).not.toContain("OPEN_URL");
    expect(questions["type_text_target"]).toBeUndefined();
    expect(questions["open_url"]).toBeUndefined();
  });
  it("adds OPEN_URL and open_url when urls exist", () => {
    const { questions } = buildObserve(observeInput({ urls: [{ label: "u1", url: "https://a" }] }));
    expect(Object.keys((questions["operation"] as ChoiceQuestion).criteria)).toContain("OPEN_URL");
    expect(Object.keys((questions["open_url"] as ChoiceQuestion).criteria)).toEqual(["u1", "none"]);
  });
  it("builds speculative heads named after the operation with TARGET_RULES", () => {
    const { questions, heads } = buildObserve(observeInput());
    const click = questions["click_target_0"] as ChoiceQuestion;
    expect(Object.keys(click.criteria)).toEqual(["e2", "e3", "e4"]);
    expect(click.criteria["e4"]).toEqual({ element: '[e4] combobox "Lang"', state: "expanded=false", current_value: "English" });
    expect(click.instructions).toEqual({ goal: "search for cats", operation: "CLICK", rules: [RULES, TARGET_RULES] });
    const type = questions["type_text_target"] as ChoiceQuestion;
    expect(Object.keys(type.criteria)).toEqual(["e1", "e4"]);
    const sel = questions["select_target"] as ChoiceQuestion;
    expect(Object.keys(sel.criteria)).toEqual(["e4:0", "e4:1"]);
    expect(sel.criteria["e4:1"]).toEqual({ element: '[e4] combobox "Lang"', option: "Deutsch" });
    expect(heads.selectTargets[1]).toMatchObject({ label: "e4:1", option: "Deutsch", optionRef: "e6" });
    expect(heads.typeTargets.map((e) => e.ref)).toEqual(["e1", "e4"]);
  });
  it("adds none only when there are 2+ click chunks and keeps chunks in document order", () => {
    const lines = Array.from({ length: 450 }, (_, i) => `- link "L${i}" [ref=e${i + 1}]`).join("\n");
    const page = parseSnapshot({ url: "https://x", title: "t", interactive: snap(lines) });
    const { questions, heads, state } = buildObserve(observeInput({ page, candidates: page.elements }));
    expect(heads.clickChunks.length).toBe(2);
    expect(Object.keys((questions["click_target_0"] as ChoiceQuestion).criteria)).toContain("none");
    expect(Object.keys((questions["click_target_0"] as ChoiceQuestion).criteria).length).toBe(201);
    expect(state["elements_truncated"]).toBe(true);
    expect((state["elements"] as unknown[]).length).toBe(LIMITS.stateElements);
  });
  it("offers value only with non-secret spans, key with the task keys, and answer_state/evidence only for check", () => {
    const a = buildObserve(observeInput({ spans: [span("s1", "pw", true)] }));
    expect(a.questions["value"]).toBeUndefined();
    const b = buildObserve(observeInput({ keys: [{ label: "k1", key: "Meta+k" }], goal: "check" }));
    expect(Object.keys((b.questions["value"] as ChoiceQuestion).criteria)).toEqual(["s1", "none_of_these"]);
    expect(Object.keys((b.questions["key"] as ChoiceQuestion).criteria)).toContain("k1");
    expect(b.questions["answer_state"]).toBeDefined();
    expect(Object.keys((b.questions["evidence"] as ChoiceQuestion).criteria)).toContain("e2");
    expect(a.questions["answer_state"]).toBeUndefined();
    expect(a.questions["evidence"]).toBeUndefined();
  });
  it("skips disabled elements and puts banned names and typed values in state", () => {
    const page = parseSnapshot({ url: "https://x", title: "t", interactive: snap('- button "Off" [disabled, ref=e1]\n- button "On" [ref=e2]') });
    const { questions, state } = buildObserve(observeInput({ page, candidates: page.elements, banned: ['button "X"'], typedValues: ["cats"] }));
    expect(Object.keys((questions["click_target_0"] as ChoiceQuestion).criteria)).toEqual(["e2"]);
    expect(state["banned"]).toEqual(['button "X"']);
    expect(state["typed_values"]).toEqual(["cats"]);
    expect(state["recent_actions"]).toEqual([]);
  });
  it("puts the last 10 actions in recent_actions with the delta shape", () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ step: i + 1, operation: "CLICK", target: `link "L${i}"`, result: "ok", page_changed: true, url_after: "u", element_key: "k" }));
    const { state } = buildObserve(observeInput({ history }));
    const rows = state["recent_actions"] as Record<string, unknown>[];
    expect(rows.length).toBe(10);
    expect(rows[0]).toEqual({ step: 3, operation: "CLICK", target: 'link "L2"', result: "ok", page_changed: true });
  });
});

describe("buildConfirm", () => {
  const page = parseSnapshot({ url: "https://x", title: "t", interactive: snap('- textbox "Email" [ref=e1]') });
  it("offers allowed actions plus none, values by span id, and target_ok only when asked", () => {
    const chosen = page.elements[0] as Element;
    const { questions, state } = buildConfirm({ task: "t", goal: "act", step: 1, page, chosen, proposed: "fill", spans: [span("s1", "a"), span("s2", "pw", true)], pageLines: [], history: [], typedValues: [], askTargetOk: false });
    expect(Object.keys((questions["action"] as ChoiceQuestion).criteria)).toEqual(["fill", "click", "hover", "none"]);
    expect(Object.keys((questions["value"] as ChoiceQuestion).criteria)).toEqual(["s1", "none_of_these"]);
    expect(questions["target_ok"]).toBeUndefined();
    expect(questions["select_option"]).toBeUndefined();
    expect(state["proposed_action"]).toBe("fill");
    const withOk = buildConfirm({ task: "t", goal: "act", step: 1, page, chosen: el("e9", "combobox", "C", { options: ["a", "b"] }), proposed: "select", spans: [], pageLines: [], history: [], typedValues: [], askTargetOk: true });
    expect(withOk.questions["target_ok"]).toBeDefined();
    expect(Object.keys((withOk.questions["select_option"] as ChoiceQuestion).criteria)).toEqual(["o0", "o1", "none_of_these"]);
  });
});

describe("buildExtract and buildVerify", () => {
  const page = parseSnapshot({ url: "https://x", title: "t", interactive: snap('- heading "H" [ref=e1]') });
  const lines = Array.from({ length: 5 }, (_, i) => ({ id: `L${i}`, text: `line ${i}`, source: "page_line" as const, secret: false }));
  it("keeps lines only in criteria, one answer_k per chunk", () => {
    const { state, questions } = buildExtract({ task: "t", goal: "extract", page, history: [], chunks: [lines.slice(0, 3), lines.slice(3)] });
    expect(JSON.stringify(state)).not.toContain("line 0");
    expect(Object.keys(questions)).toEqual(["answer_0", "answer_1"]);
    expect(Object.keys((questions["answer_1"] as ChoiceQuestion).criteria)).toEqual(["L3", "L4", "none"]);
  });
  it("verify asks answer_ok only with a candidate", () => {
    const a = buildVerify({ task: "t", goal: "act", page, textExcerpt: "x", history: [], chunks: [lines], candidate: null });
    expect(Object.keys(a.questions)).toEqual(["done_final", "evidence_0"]);
    const b = buildVerify({ task: "t", goal: "extract", page, textExcerpt: "x", history: [], chunks: [lines], candidate: lines[0] as Span });
    expect(b.questions["answer_ok"]).toBeDefined();
    expect(b.state["candidate_answer"]).toBe("line 0");
  });
});

describe("trimToBudget", () => {
  it("applies the ladder in order and reports dropped rungs; oversize throws BudgetError", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `- link "Long link name number ${i} with padding text to make it heavier" [ref=e${i + 1}]`).join("\n");
    const page = parseSnapshot({ url: "https://x", title: "t", interactive: snap(lines) });
    const big = buildObserve(observeInput({ page, candidates: page.elements, textExcerpt: "x".repeat(6000), history: Array.from({ length: 10 }, (_, i) => ({ step: i, operation: "CLICK", result: "ok", page_changed: false })) }));
    expect(() => checkBudget(big.state, big.questions)).not.toThrow();
    const state = { ...big.state, page: { url: "u", title: "t", headings: [], visible_text: "y".repeat(6000) }, filler: "z".repeat(16_000) };
    const q = { ...big.questions, extra: (big.questions["click_target_0"] as ChoiceQuestion) };
    const r = trimToBudget(state, q);
    expect(r.dropped[0]).toBe("visible_text:2000");
    expect(() => checkBudget(r.state, r.questions)).not.toThrow();
    const hopeless = { filler: "z".repeat(LIMITS.tokenRequest * LIMITS.charsPerToken + 1000) };
    expect(() => trimToBudget(hopeless, { q: big.questions["operation"] as ChoiceQuestion })).toThrow(BudgetError);
  });
  it("assertOptionCount rejects 256 labels", () => {
    const criteria: Record<string, null> = {};
    for (let i = 0; i < 256; i++) criteria[`o${i}`] = null;
    expect(() => assertOptionCount({ q: { type: "choice", criteria } })).toThrow(/255/);
  });
});
