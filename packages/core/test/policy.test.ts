import { describe, expect, it } from "vitest";
import type { Answers } from "../src/jev.js";
import { actionClass, chooseWinners, decide, fastPathAllowed, gate, keywordClass, riskClass, top3, type DecideContext } from "../src/policy.js";
import type { ObserveHeads } from "../src/questions.js";
import type { Element, Span } from "../src/types.js";

const el = (ref: string, role: string, name: string, extra: Partial<Element> = {}): Element => ({ ref, role, name, depth: 0, under: "", key: `${role}|${name}|`, attrs: {}, state: "", value: "", seen: 1, index: Number(ref.slice(1)), ...extra });
const ch = (choice: string, confidence = 0.9, probabilities?: Record<string, number>) => ({ type: "choice" as const, choice, confidence, probabilities: probabilities ?? { [choice]: confidence } });
const nl = (noul: number) => ({ type: "noul" as const, noul });

describe("risk classes", () => {
  it("keywordClass and actionClass", () => {
    expect(keywordClass("Delete item")).toBe("destructive");
    expect(keywordClass("Sign in")).toBe("submit");
    expect(keywordClass("Next page")).toBe("submit");
    expect(keywordClass("Open article")).toBe("read_only");
    expect(keywordClass("Sharepoint")).toBe("read_only");
    expect(actionClass(null, "fill")).toBe("data_entry");
    expect(actionClass(null, "click")).toBe("navigational");
    expect(actionClass(null, "scroll_down")).toBe("read_only");
  });
  it("riskClass takes the max of keyword, action and jev", () => {
    expect(riskClass(el("e1", "link", "Open"), "click", { irreversible: 0.6, submits: 0 })).toBe("destructive");
    expect(riskClass(el("e1", "button", "Go"), "click", { irreversible: 0, submits: 0.7 })).toBe("submit");
    expect(riskClass(el("e1", "textbox", "Q"), "fill", { irreversible: 0, submits: 0 })).toBe("data_entry");
    expect(riskClass(el("e1", "button", "Delete"), "click", { irreversible: 0, submits: 0 })).toBe("destructive");
  });
});

describe("gate", () => {
  const base = { targetConf: 0.9, runnerUp: 0.05, top: 0.9, targetOk: null, valueConf: null, inScope: 1, actionConf: null };
  it("checks the rules in order", () => {
    expect(gate("navigational", { ...base, actionConf: 0.3 }, "auto")).toMatchObject({ ok: false, reason: "low_action" });
    expect(gate("navigational", { ...base, targetConf: 0.2 }, "auto")).toMatchObject({ ok: false, reason: "low_target" });
    expect(gate("navigational", { ...base, runnerUp: 0.5 }, "auto")).toMatchObject({ ok: true });
    expect(gate("submit", { ...base, runnerUp: 0.5, targetOk: 0.9 }, "auto")).toMatchObject({ ok: false, reason: "ambiguous_runner_up" });
    expect(gate("submit", { ...base, targetOk: 0.3 }, "auto")).toMatchObject({ ok: false, reason: "target_rejected" });
    expect(gate("navigational", { ...base, targetOk: 0.3 }, "auto")).toMatchObject({ ok: true });
    expect(gate("data_entry", { ...base, valueConf: 0.2 }, "auto")).toMatchObject({ ok: false, reason: "low_value" });
    expect(gate("data_entry", { ...base, inScope: 0.1 }, "auto")).toMatchObject({ ok: false, reason: "out_of_scope" });
  });
  it("human confirm per mode", () => {
    expect(gate("destructive", { ...base, targetOk: 0.95 }, "auto")).toMatchObject({ ok: false, reason: "needs_human_confirm" });
    expect(gate("destructive", { ...base, targetOk: 0.95 }, "never")).toMatchObject({ ok: false, reason: "needs_human_confirm" });
    expect(gate("submit", { ...base, targetOk: 0.9 }, "always")).toMatchObject({ ok: false, reason: "needs_human_confirm" });
    expect(gate("submit", { ...base, targetOk: 0.9 }, "auto")).toMatchObject({ ok: true, band: "high" });
    expect(gate("submit", { ...base, targetConf: 0.55, targetOk: 0.9 }, "auto")).toMatchObject({ ok: true, band: "medium" });
  });
});

describe("fastPathAllowed", () => {
  const spec = { irreversible: 0.05, submits: 0.05, value: { conf: null, span: null } };
  it("plain navigation at 0.9 yes; Delete no; two fields no; one field with value 0.85 yes; credential no; select never", () => {
    expect(fastPathAllowed({ chosen: el("e1", "link", "Open"), action: "click", targetConf: 0.9, top: 0.9, runnerUp: 0.05, spec, fillableCount: 0, valueFromPage: 0 })).toBe(true);
    expect(fastPathAllowed({ chosen: el("e1", "link", "Delete"), action: "click", targetConf: 0.9, top: 0.9, runnerUp: 0.05, spec, fillableCount: 0, valueFromPage: 0 })).toBe(false);
    expect(fastPathAllowed({ chosen: el("e1", "link", "Open"), action: "click", targetConf: 0.9, top: 0.9, runnerUp: 0.5, spec, fillableCount: 0, valueFromPage: 0 })).toBe(false);
    const vspec = { ...spec, value: { conf: 0.85, span: { id: "s1", text: "x", source: "quoted" as const, secret: false } } };
    expect(fastPathAllowed({ chosen: el("e1", "textbox", "Q"), action: "fill", targetConf: 0.9, top: 0.9, runnerUp: 0.05, spec: vspec, fillableCount: 2, valueFromPage: 0 })).toBe(false);
    expect(fastPathAllowed({ chosen: el("e1", "textbox", "Q"), action: "fill", targetConf: 0.9, top: 0.9, runnerUp: 0.05, spec: vspec, fillableCount: 1, valueFromPage: 0 })).toBe(true);
    expect(fastPathAllowed({ chosen: el("e1", "textbox", "Password"), action: "fill", targetConf: 0.9, top: 0.9, runnerUp: 0.05, spec: vspec, fillableCount: 1, valueFromPage: 0 })).toBe(false);
    expect(fastPathAllowed({ chosen: el("e1", "combobox", "L"), action: "select", targetConf: 0.99, top: 0.99, runnerUp: 0, spec, fillableCount: 0, valueFromPage: 0 })).toBe(false);
  });
});

function ctx(over: Partial<DecideContext> = {}, heads: Partial<ObserveHeads> = {}): DecideContext {
  const link = el("e2", "link", "Go");
  const box = el("e1", "searchbox", "Search");
  const page = { url: "https://x", title: "t", elements: [box, link], refCount: 2, headings: [], fingerprint: "f", truncated: false };
  return {
    page, heads: { clickChunks: [[link]], typeTargets: [box], selectTargets: [], operations: [], evidence: [link], ...heads },
    spans: [{ id: "s1", text: "cats", source: "quoted", secret: false } as Span], goal: "act",
    memory: { waits: 0, scrolled: false, checkHolds: 0 }, run: { doneSuppressed: 0, errorRetries: 0 },
    heuristics: { signInWall: false }, keys: [], urls: [{ label: "u1", url: "https://a" }], ...over,
  };
}
const pk = (choice: string, confidence = 0.9, extra: Record<string, number> = {}) => ch(choice, confidence, { task_page: 0, sign_in_wall: 0, captcha_or_bot_check: 0, ...extra, [choice]: confidence });

describe("decide", () => {
  it("routes sign-in walls, captcha, overlay, loading and error pages first", () => {
    expect(decide({ page_kind: pk("sign_in_wall"), operation: ch("CLICK") }, ctx())).toMatchObject({ kind: "handoff", blocked: "needs_sign_in" });
    expect(decide({ page_kind: pk("task_page", 0.6, { sign_in_wall: 0.35 }), operation: ch("CLICK") }, ctx({ heuristics: { signInWall: true } }))).toMatchObject({ kind: "handoff", blocked: "needs_sign_in" });
    expect(decide({ page_kind: pk("task_page", 0.6, { sign_in_wall: 0.35 }), operation: ch("CLICK"), click_target_0: ch("e2") }, ctx())).toMatchObject({ kind: "candidate" });
    expect(decide({ page_kind: pk("captcha_or_bot_check"), operation: ch("CLICK") }, ctx())).toMatchObject({ kind: "handoff", blocked: "captcha" });
    expect(decide({ page_kind: pk("consent_or_cookie_banner"), operation: ch("CLICK") }, ctx())).toMatchObject({ kind: "overlay" });
    expect(decide({ page_kind: pk("empty_or_loading"), operation: ch("CLICK") }, ctx())).toMatchObject({ kind: "wait" });
    expect(decide({ page_kind: pk("empty_or_loading"), operation: ch("CLICK"), click_target_0: ch("e2") }, ctx({ memory: { waits: 2, scrolled: false, checkHolds: 0 } }))).toMatchObject({ kind: "candidate" });
    expect(decide({ page_kind: pk("error_page"), operation: ch("CLICK") }, ctx())).toMatchObject({ kind: "go_back" });
    expect(decide({ page_kind: pk("error_page"), operation: ch("CLICK") }, ctx({ run: { doneSuppressed: 0, errorRetries: 1 } }))).toMatchObject({ kind: "blocked", blocked: "impossible" });
  });
  it("acts on the operation head: DONE per goal, BLOCKED with page_kind reason", () => {
    expect(decide({ page_kind: pk("task_page"), operation: ch("DONE") }, ctx())).toMatchObject({ kind: "verify" });
    expect(decide({ page_kind: pk("task_page"), operation: ch("DONE") }, ctx({ goal: "extract" }))).toMatchObject({ kind: "extract" });
    expect(decide({ page_kind: pk("task_page"), operation: ch("BLOCKED", 0.8) }, ctx())).toMatchObject({ kind: "blocked", blocked: "impossible" });
    expect(decide({ page_kind: pk("task_page", 0.5, { sign_in_wall: 0.4 }), operation: ch("BLOCKED", 0.8) }, ctx())).toMatchObject({ kind: "handoff", blocked: "needs_sign_in" });
    expect(decide({ page_kind: pk("task_page"), operation: ch("BLOCKED", 0.3, { BLOCKED: 0.3, CLICK: 0.29 }), click_target_0: ch("e2") }, ctx())).toMatchObject({ kind: "candidate" });
  });
  it("DONE suppressed falls to the next best operation; check goal done, hold, unknown", () => {
    const A: Answers = { page_kind: pk("task_page"), operation: ch("DONE", 0.7, { DONE: 0.7, CLICK: 0.2, WAIT: 0.1 }), click_target_0: ch("e2") };
    expect(decide(A, ctx({ run: { doneSuppressed: 2, errorRetries: 0 } }))).toMatchObject({ kind: "candidate", action: "click" });
    const yes: Answers = { ...A, answer_state: ch("yes", 0.8, { yes: 0.8, no: 0.1, not_visible_yet: 0.1 }), evidence: ch("e2") };
    expect(decide(yes, ctx({ goal: "check" }))).toMatchObject({ kind: "check_done", answer: true, pYes: 0.8, evidence: { ref: "e2" } });
    const low: Answers = { ...A, answer_state: ch("yes", 0.4, { yes: 0.4, no: 0.3, not_visible_yet: 0.3 }), evidence: ch("none") };
    expect(decide(low, ctx({ goal: "check" }))).toMatchObject({ kind: "check_hold" });
    expect(decide(low, ctx({ goal: "check", memory: { waits: 0, scrolled: false, checkHolds: 2 } }))).toMatchObject({ kind: "check_unknown", pYes: 0.4 });
    expect(decide(low, ctx({ goal: "check", excludeDone: true }))).toMatchObject({ kind: "candidate" });
  });
  it("reads only the head that matches the operation", () => {
    const A: Answers = { page_kind: pk("task_page"), operation: ch("TYPE_TEXT"), click_target_0: ch("e2"), type_text_target: ch("e1", 0.8, { e1: 0.8 }), value: ch("s1", 0.9), submit_with_enter: nl(0.9) };
    const d = decide(A, ctx());
    expect(d).toMatchObject({ kind: "candidate", action: "fill", chosen: { ref: "e1" }, targetConf: 0.8, specValue: { span: { text: "cats" }, conf: 0.9 } });
    expect(decide({ ...A, operation: ch("CLICK") }, ctx())).toMatchObject({ kind: "candidate", action: "click", chosen: { ref: "e2" } });
    expect(decide({ ...A, operation: ch("TYPE_TEXT"), type_text_target: ch("e99") }, ctx())).toMatchObject({ kind: "no_target" });
  });
  it("select, keys, scroll, back, wait, open_url", () => {
    const sel = el("e4", "combobox", "Lang", { options: ["a", "b"], optionRefs: ["e5", "e6"] });
    const c = ctx({}, { selectTargets: [{ label: "e4:1", el: sel, option: "b", optionRef: "e6" }] });
    expect(decide({ page_kind: pk("task_page"), operation: ch("SELECT"), select_target: ch("e4:1", 0.7, { "e4:1": 0.7 }) }, c)).toMatchObject({ kind: "candidate", action: "select", optionLabel: "b", optionRef: "e6" });
    expect(decide({ page_kind: pk("task_page"), operation: ch("PRESS_KEY"), key: ch("escape") }, ctx())).toMatchObject({ kind: "code_action", action: "press_key", key: "Escape" });
    expect(decide({ page_kind: pk("task_page"), operation: ch("PRESS_KEY"), key: ch("none") }, ctx())).toMatchObject({ kind: "code_action", key: "Enter" });
    // No key answer: the oracle dropped a bad one. A missing head runs no action (it pressed Enter before).
    expect(decide({ page_kind: pk("task_page"), operation: ch("PRESS_KEY") }, ctx())).toMatchObject({ kind: "no_target", reason: "no key answer" });
    expect(decide({ page_kind: pk("task_page"), operation: ch("PRESS_KEY"), key: ch("k1") }, ctx({ keys: [{ label: "k1", key: "Meta+k" }] }))).toMatchObject({ key: "Meta+k" });
    expect(decide({ page_kind: pk("task_page"), operation: ch("SCROLL_DOWN") }, ctx())).toMatchObject({ kind: "scroll", dir: "down" });
    expect(decide({ page_kind: pk("task_page"), operation: ch("GO_BACK") }, ctx())).toMatchObject({ kind: "code_action", action: "go_back" });
    expect(decide({ page_kind: pk("task_page"), operation: ch("WAIT") }, ctx())).toMatchObject({ kind: "wait" });
    expect(decide({ page_kind: pk("task_page"), operation: ch("WAIT") }, ctx({ memory: { waits: 2, scrolled: false, checkHolds: 0 } }))).toMatchObject({ kind: "scroll" });
    expect(decide({ page_kind: pk("task_page"), operation: ch("OPEN_URL"), open_url: ch("u1") }, ctx())).toMatchObject({ kind: "code_action", action: "open_url", url: "https://a" });
    expect(decide({ page_kind: pk("task_page"), operation: ch("OPEN_URL"), open_url: ch("none") }, ctx())).toMatchObject({ kind: "code_action", url: "https://a" });
  });
  it("tournament with two chunk winners; chooseWinners threshold; top3", () => {
    const a = el("e2", "link", "A"); const b = el("e300", "link", "B");
    const A: Answers = { page_kind: pk("task_page"), operation: ch("CLICK"), click_target_0: ch("e2", 0.5, { e2: 0.5, none: 0.5 }), click_target_1: ch("e300", 0.4, { e300: 0.4, none: 0.6 }) };
    expect(decide(A, ctx({}, { clickChunks: [[a], [b]] }))).toMatchObject({ kind: "tournament", winners: [{ ref: "e2" }, { ref: "e300" }] });
    expect(chooseWinners({ click_target_0: ch("e2", 0.1, { e2: 0.1, none: 0.9 }) }, [[a]])).toEqual([]);
    expect(decide({ ...A, click_target_0: ch("none"), click_target_1: ch("none") }, ctx({}, { clickChunks: [[a], [b]] }))).toMatchObject({ kind: "no_target" });
    expect(top3({ a: 0.1, b: 0.5, c: 0.3, d: 0.05 })).toEqual([{ label: "b", p: 0.5 }, { label: "c", p: 0.3 }, { label: "a", p: 0.1 }]);
  });
});
