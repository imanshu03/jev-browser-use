// Group 32: "Comment" (and "Queue") are SEND_WORDS but not DESTRUCTIVE_WORDS or SUBMIT_WORDS, so riskOf gives
// "navigational", `sends` is false, and the D4b stray-chip gate, the D1 send path, and the dialog `sends` list skip it.
import type { ChoiceQuestion, Questions } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { FastRunner } from "../../src/fast/loop.js";
import type { FastRunnerDeps } from "../../src/fast/loop.js";
import type { RunConfig } from "../../src/types.js";
import { fakeHuman, fakeLogger, fakeOracle, type PartialAnswers } from "../fakes.js";
import { el, fakeChrome, fakePage, obs } from "../fast/fakes.js";

const key = (q: Questions, label: string): string | null => {
  for (const [k, v] of Object.entries((q["click_target"] as ChoiceQuestion | undefined)?.criteria ?? {})) if (String((v as { element?: string })?.element ?? "").includes(label)) return k;
  return null;
};

async function scenario(button: string) {
  const URL = "https://app.example/task/7";
  const a = obs(URL, [
    el("e1", "fill", "Add a comment", "textbox", { value: "Looks good", form: 4, multiline: true }),
    el("e2", "click", button, "button", { form: 4 }),
    el("e20", "click", "Research Agent", "option", { popup: [9] }),
  ], "Task 7");
  const b = obs(URL, [
    el("e1", "fill", "Add a comment", "textbox", { value: "Looks good @Research Agent", form: 4, multiline: true, mentions: ["Research Agent"], bareText: "Looks good" }),
    el("e2", "click", button, "button", { form: 4 }),
  ], "Task 7 ");
  const c = obs(URL, [el("e1", "fill", "Add a comment", "textbox", { value: "", form: 4, multiline: true })], "Task 7\nLooks good @Research Agent");
  const page = fakePage({ pages: { a, b, c }, start: "a", transitions: (call, cur) => (call.op === "act" && call.id === "e20" ? "b" : call.op === "act" && call.id === "e2" && cur === "b" ? "c" : undefined) });
  let n = 0;
  const oracle = fakeOracle((nm, _s, q): PartialAnswers => {
    if (nm !== "step") return {};
    n += 1;
    if (n === 1) return { page_kind: "task_page", operation: { choice: "CLICK", confidence: 0.6, probabilities: { CLICK: 0.6 } }, click_target: { choice: key(q, "Research Agent") as string, confidence: 0.4 } };
    const k = key(q, button);
    if (k) return { page_kind: "task_page", operation: { choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 0.9 } }, click_target: { choice: k, confidence: 0.95 } };
    return { page_kind: "task_page", operation: { choice: "BLOCKED", confidence: 0.9, probabilities: { BLOCKED: 0.9 } }, blocked_reason: "impossible" };
  });
  const human = fakeHuman({ interactive: true, confirm: [true, true, true] });
  const deps: FastRunnerDeps = {
    cfg: { task: 'open https://app.example/task/7 and comment "Looks good"', headed: false, maxSteps: 4, stepTimeoutMs: 1000, runTimeoutMs: 60_000, pauseTimeoutMs: 1000, confirm: "auto", dryRun: false, session: "s", model: "m", logLevel: "info", logJson: false, keepOpen: false, agentBrowserBin: "ab", vars: {}, profile: "none", goal: "act", engine: "cdp", refreshProfile: false } as RunConfig,
    profiles: [], chrome: async () => fakeChrome(), openPage: async () => page, oracle, human, log: fakeLogger(), sleep: async () => undefined,
  };
  const r = await new FastRunner(deps).run();
  return { r, page, human };
}

describe("group 32: a send button named Comment", () => {
  it("control: a Send click with a chip that no task name asks for is refused", async () => {
    const { page } = await scenario("Send");
    expect(page.calls.filter((c) => c.op === "act" && c.id === "e2")).toEqual([]);
  });

  it("a Comment click with a chip that no task name asks for is refused too (D4b)", async () => {
    const { page, r } = await scenario("Comment");
    expect(page.calls.filter((c) => c.op === "act" && c.id === "e2")).toEqual([]);
    expect(r.steps.map((s) => s.gate ?? "").join(" | ")).toContain("which the task does not ask for");
  });
});
