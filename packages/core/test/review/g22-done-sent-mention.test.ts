// Group 22: after a send that left out the requested mention, the operation question offers DONE_SENT ("... or the goal
// ends with sending a text and a recent action sent that text"), which licenses DONE although the mention is missing.
import type { ChoiceQuestion, Questions } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { FastRunner } from "../../src/fast/loop.js";
import type { FastRunnerDeps } from "../../src/fast/loop.js";
import type { Action, Observation } from "../../src/fast/model.js";
import { DONE_SENT, DONE_TEXT } from "../../src/fast/policy.js";
import type { RunConfig } from "../../src/types.js";
import { fakeHuman, fakeLogger, fakeOracle, type PartialAnswers } from "../fakes.js";
import { el, fakeChrome, fakePage, obs } from "../fast/fakes.js";

const CHAT = "https://chat.example/c/1";
const PLACEHOLDER = "Type a message";

describe("group 22: DONE after a send without the requested mention", () => {
  it("offers DONE_TEXT, not DONE_SENT, when the sent message had no chip for the requested name", async () => {
    const s = { text: "", chips: [] as string[], sent: [] as { text: string; chips: string[] }[] };
    const page0 = (): Observation => {
      const value = [s.text, ...s.chips.map((c) => `@${c}`)].filter(Boolean).join(" ");
      const actions: Action[] = [
        el("e1", "fill", PLACEHOLDER, "textbox", { node: 1, value, form: 1, multiline: true }),
        el("e3", "click", "Mention", "button", { node: 2, form: 1 }),
        el("e4", "click", "Send message", "button", { node: 3, form: 1 }),
      ];
      return obs(CHAT, actions, `chat\n${s.sent.map((m) => `You: ${m.text}`).join("\n")}`,
        { doc: 1, focus: { node: 1, label: PLACEHOLDER, role: "textbox", submitLabel: "", editable: true, value, form: 1, submitDefault: "", multiline: true }, filled: value ? [1] : [], texts: value ? [[1, value]] : [] } as Partial<Observation>);
    };
    const page = fakePage({ pages: { c: page0() }, start: "c" });
    page.observe = async () => { page.observes += 1; return page0(); };
    const act = page.act.bind(page);
    page.act = async (a, o, text, fill) => {
      const r = await act(a, o, text, fill);
      if (a.kind === "fill") s.text = text ?? "";
      else if (a.label === "Send message") { s.sent.push({ text: s.text, chips: [...s.chips] }); s.text = ""; }
      return r;
    };
    const idx = (q: Questions, head: string, label: string): string => {
      for (const [k, v] of Object.entries((q[head] as ChoiceQuestion | undefined)?.criteria ?? {})) if (String((v as { element?: string })?.element ?? "").includes(label)) return k;
      throw new Error(`no ${head} for ${label}`);
    };
    // Jev types the text and sends it before it adds the mention; the user allows the send.
    const steps: ((q: Questions) => PartialAnswers)[] = [
      (q) => ({ page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", PLACEHOLDER), confidence: 0.9 }, type_text_value: { choice: "v_message", confidence: 0.9 } }),
      (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "Send message"), confidence: 0.9 } }),
      () => ({ page_kind: "task_page", operation: { choice: "DONE", confidence: 0.61, probabilities: { DONE: 0.66, CLICK: 0.2, BLOCKED: 0.07, TYPE_TEXT: 0.07 } } }),
    ];
    let i = 0;
    const oracle = fakeOracle((n, _s, q) => (n === "step" ? (steps[Math.min(i++, steps.length - 1)] as (q: Questions) => PartialAnswers)(q) : {}));
    const deps: FastRunnerDeps = {
      cfg: { task: "mention Ann Lee and ask her for the report status", headed: false, maxSteps: 6, stepTimeoutMs: 1000, runTimeoutMs: 60_000, pauseTimeoutMs: 1000, confirm: "auto", dryRun: false, session: "s", model: "m", logLevel: "info", logJson: false, keepOpen: false, agentBrowserBin: "ab", vars: { message: "Hi Ann, could you share the current status of the report?" }, profile: "none", goal: "act", engine: "cdp", refreshProfile: false, url: CHAT } as RunConfig,
      profiles: [], chrome: async () => fakeChrome(), openPage: async () => page, oracle, human: fakeHuman({ interactive: true, confirm: [true, true, true] }),
      log: fakeLogger(), sleep: async () => undefined, fromAssistant: true,
    };
    const runner = new FastRunner(deps);
    const r = await runner.run();
    // Precondition: the text went out with no chip, and the run recorded the send.
    expect(s.sent).toEqual([{ text: "Hi Ann, could you share the current status of the report?", chips: [] }]);
    expect(runner.sentTexts()).toHaveLength(1);
    const last = oracle.requests.filter((x) => x.name === "step").at(-1);
    const done = ((last?.questions as Questions)["operation"] as ChoiceQuestion).criteria["DONE"];
    expect(done).not.toBe(DONE_SENT);
    expect(done).toBe(DONE_TEXT);
    // As it stands, finish() also takes the scripted pDone 0.66 >= GATES.done and reports a pass.
    expect(r.outcome).toBe("done");
  });
});
