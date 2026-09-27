// Group 17: chipBase is set per document at its first observation. When that observation is a loading shell with no
// composer, the user's saved draft chip that renders later counts as "added by this run", and D4b blocks its send.
import type { ChoiceQuestion, Questions } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { FastRunner } from "../../src/fast/loop.js";
import type { FastRunnerDeps } from "../../src/fast/loop.js";
import type { Observation } from "../../src/fast/model.js";
import type { RunConfig } from "../../src/types.js";
import { fakeHuman, fakeLogger, fakeOracle, type PartialAnswers } from "../fakes.js";
import { el, fakeChrome, fakePage, obs } from "../fast/fakes.js";

const URL = "https://chat.test/general";
const cfg = (task: string): RunConfig => ({
  task, headed: false, maxSteps: 6, stepTimeoutMs: 1000, runTimeoutMs: 60_000, pauseTimeoutMs: 1000, confirm: "auto", dryRun: false, session: "jev-test",
  model: "m", logLevel: "info", logJson: false, keepOpen: false, agentBrowserBin: "ab", vars: {}, profile: "none", goal: "act", engine: "cdp", refreshProfile: false, url: URL,
}) as RunConfig;
const key = (q: Questions, label: string): string | null => {
  for (const [k, v] of Object.entries((q["click_target"] as ChoiceQuestion | undefined)?.criteria ?? {})) if (String((v as { element?: string })?.element ?? "").includes(label)) return k;
  return null;
};

describe("group 17: a draft chip that renders after a loading shell", () => {
  it("is the user's draft, not a chip that this run added: the Send of 'Send my draft' runs", async () => {
    const loading = obs(URL, [], "Loading...", { doc: 1 } as Partial<Observation>);
    const ready = obs(URL, [
      el("e1", "fill", "Message #general", "textbox", { node: 1, value: "@Ann Lee please review the Q3 plan", multiline: true, form: 2, mentions: ["Ann Lee"], bareText: "please review the Q3 plan", otherAtoms: 0 }),
      el("e3", "click", "Send", "button", { node: 3, form: 2 }),
    ], "general\nDraft", { doc: 1 } as Partial<Observation>);
    const sent = obs(URL, [el("e1", "fill", "Message #general", "textbox", { node: 1, value: "", multiline: true, form: 2 }), el("e3", "click", "Send", "button", { node: 3, form: 2 })],
      "general\nMe: @Ann Lee please review the Q3 plan", { doc: 1 } as Partial<Observation>);
    const page = fakePage({ pages: { loading, ready, sent }, start: "loading", transitions: (c) => (c.op === "act" && c.id === "wait" ? "ready" : c.op === "act" && c.id === "e3" ? "sent" : undefined) });
    const oracle = fakeOracle((n, st, q): PartialAnswers => {
      if (n !== "step") return {};
      const s = st as { page: { text: string } };
      if (s.page.text === "Loading...") return { page_kind: "task_page", operation: { choice: "WAIT", confidence: 0.9, probabilities: { WAIT: 0.9 } } };
      if (s.page.text.startsWith("general\nMe:")) return { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9 } } };
      const k = key(q, "Send");
      return k ? { page_kind: "task_page", operation: { choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 0.9, DONE: 0.1 } }, click_target: { choice: k, confidence: 0.95 } }
        : { page_kind: "task_page", operation: { choice: "WAIT", confidence: 0.5, probabilities: { WAIT: 0.5 } } };
    });
    const deps: FastRunnerDeps = { cfg: cfg("Send my draft in #general"), profiles: [], chrome: async () => fakeChrome(), openPage: async () => page, oracle,
      human: fakeHuman({ interactive: true, confirm: [true, true, true] }), log: fakeLogger(), sleep: async () => undefined };
    const r = await new FastRunner(deps).run();
    expect(r.steps.map((s) => s.gate ?? "").join(" | ")).not.toContain("this run added it");
    expect(page.calls.filter((c) => c.op === "act" && c.id === "e3")).toHaveLength(1);
    expect(r.outcome).toBe("done");
  });
});
