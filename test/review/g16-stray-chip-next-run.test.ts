// Group 16: the D4b gate (a chip that the run added and no task name asks for) is lost when the MCP session gives the
// same page to the next run. fastStarter passes only unsentText() to that run, so the next run's first observation puts
// the stray chip into chipBase, and a Send goes out with it (no dialog in an autonomous run).
import type { ChoiceQuestion, Questions } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import type { Observation } from "../../src/fast/model.js";
import { BrowserSession } from "../../src/fast/session.js";
import { MCP_HINTS } from "../../src/mcp/limits.js";
import type { RunHooks } from "../../src/mcp/runs.js";
import { baseConfig, fastStarter } from "../../src/mcp/setup.js";
import { fakeHuman, fakeLogger, fakeOracle, fakeText, type PartialAnswers } from "../fakes.js";
import { el, fakeChrome, fakePage, obs } from "../fast/fakes.js";

const URL = "https://chat.test/general";
const key = (q: Questions, label: string): string | null => {
  for (const [k, v] of Object.entries((q["click_target"] as ChoiceQuestion | undefined)?.criteria ?? {})) if (String((v as { element?: string })?.element ?? "").includes(label)) return k;
  return null;
};
const click = (q: Questions, label: string): PartialAnswers => {
  const k = key(q, label);
  return k ? { page_kind: "task_page", operation: { choice: "CLICK", confidence: 0.9, probabilities: { CLICK: 0.9, DONE: 0.1 } }, click_target: { choice: k, confidence: 0.92 } }
    : { page_kind: "task_page", operation: { choice: "BLOCKED", confidence: 0.9, probabilities: { BLOCKED: 0.9 } }, blocked_reason: "other" };
};
const done: PartialAnswers = { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9 } } };

function stack() {
  const draft = obs(URL, [
    el("e1", "fill", "Message #general", "textbox", { node: 1, value: "", multiline: true, form: 2 }),
    el("e3", "click", "Send", "button", { node: 3, form: 2 }),
    el("e4", "click", "Ann Lee", "option", { node: 4, popup: [5] }),
    el("e5", "click", "Anna Li", "option", { node: 5, popup: [5] }),
  ], "general", { doc: 1 } as Partial<Observation>);
  const chip = obs(URL, [
    el("e1", "fill", "Message #general", "textbox", { node: 1, value: "@Ann Lee hi", multiline: true, form: 2, mentions: ["Ann Lee"], bareText: "hi", otherAtoms: 0 }),
    el("e3", "click", "Send", "button", { node: 3, form: 2 }),
  ], "general ", { doc: 1 } as Partial<Observation>);
  const sent = obs(URL, [
    el("e1", "fill", "Message #general", "textbox", { node: 1, value: "", multiline: true, form: 2 }),
    el("e3", "click", "Send", "button", { node: 3, form: 2 }),
  ], "general\nMe: @Ann Lee hi", { doc: 1 } as Partial<Observation>);
  const page = fakePage({ pages: { draft, chip, sent }, start: "draft", transitions: (c) => (c.op === "act" && c.id === "e4" ? "chip" : c.op === "act" && c.id === "e3" ? "sent" : undefined) });
  const log = fakeLogger();
  const session = new BrowserSession({ env: {}, log, launch: async () => fakeChrome(), open: async () => page });
  let run = 1;
  const oracle = fakeOracle((name, st, q) => {
    if (name === "plan") return { goal: "act" };
    if (name !== "step") return {};
    const text = (st as { page: { text: string } }).page.text;
    // Run 1: Jev picks the wrong person ("Ann Lee" for "Anna Li"), then tries Send. Run 2: Jev sends.
    if (run === 1) return text === "general" && key(q, "Ann Lee") ? click(q, "Ann Lee") : click(q, "Send");
    return text.startsWith("general\nMe:") ? done : click(q, "Send");
  });
  const start = fastStarter({ session, jev: { client: () => { throw new Error("no client"); }, warm: async () => undefined, key: () => null, close: async () => undefined } as never,
    base: baseConfig({}, log), env: {}, profiles: () => [], oracle: () => oracle });
  const hooks = (attended: boolean): RunHooks => ({ text: fakeText(), human: fakeHuman({ interactive: false }), signal: new AbortController().signal, log: fakeLogger(), hints: MCP_HINTS, attended });
  return { page, session, start, hooks, next: () => { run += 1; } };
}

describe("group 16: a stray chip of an earlier run on the same MCP session page", () => {
  for (const [name, task2] of [["a send-only follow-up", "Send the message in #general"], ["the same task again", 'Mention Anna Li in #general and say "hi"']] as const) {
    it(`the next autonomous run does not send it (${name})`, async () => {
      const t = stack();
      const one = await t.start({ task: 'Mention Anna Li in #general and say "hi"', headed: false, confirm: "auto", dry_run: false, url: URL, profile: "none" }, t.hooks(true));
      expect(one.steps.some((x) => /holds the mention @Ann Lee, which the task does not ask for/.test(x.gate ?? ""))).toBe(true);
      expect(t.page.calls.filter((c) => c.op === "act" && c.id === "e3")).toEqual([]);
      expect(t.session.page).toBe(t.page);
      t.next();
      await t.start({ task: task2, headed: false, confirm: "autonomous", dry_run: false, profile: "none" }, t.hooks(false));
      expect(t.page.calls.filter((c) => c.op === "act" && c.id === "e3")).toEqual([]);
    });
  }
});
