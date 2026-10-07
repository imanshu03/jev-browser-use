// Regressions of the open-points review (26 Sep), loop side: groups 26, 27, and 34. Each test failed on c093ea0.
import type { ChoiceQuestion, Questions } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { FastRunner } from "../../src/fast/loop.js";
import type { FastRunnerDeps } from "../../src/fast/loop.js";
import type { Observation } from "../../src/fast/model.js";
import type { RunConfig } from "../../src/types.js";
import { KEY_PATTERN } from "../../src/types.js";
import { fakeHuman, fakeLogger, fakeOracle, fakeText, type PartialAnswers } from "../fakes.js";
import { el, fakeChrome, fakePage, obs } from "./fakes.js";

function cfg(task: string, over: Partial<RunConfig> = {}): RunConfig {
  return {
    task, headed: true, maxSteps: 6, stepTimeoutMs: 1000, runTimeoutMs: 60_000, pauseTimeoutMs: 1000, confirm: "auto", dryRun: false, session: "s",
    model: "m", logLevel: "info", logJson: false, keepOpen: false, agentBrowserBin: "ab", vars: {}, profile: "none", goal: "act", engine: "cdp", refreshProfile: false, ...over,
  };
}
function idx(questions: Questions, head: string, label: string): string {
  const q = questions[head] as ChoiceQuestion | undefined;
  for (const [key, v] of Object.entries(q?.criteria ?? {})) if (typeof v === "object" && v !== null && String((v as { element?: string }).element ?? "").includes(label)) return key;
  throw new Error(`no ${head} option for ${label}`);
}
type Decide = (q: Questions) => PartialAnswers;
const clickOn = (label: string): Decide => (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", label), confidence: 0.9 } });
const genAppend = (label: string): Decide => (q) => ({ page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", label), confidence: 0.8 }, type_text_value: { choice: "generate", confidence: 0.8 }, type_text_mode: { choice: "append", confidence: 0.95 } });
const finish: Decide = () => ({ page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } });
const seq = (...steps: Decide[]) => { let i = 0; return (name: string, _s: unknown, q: Questions): PartialAnswers => (name === "step" ? (steps[Math.min(i++, steps.length - 1)] as Decide)(q) : {}); };
const noDialog = () => { const h = fakeHuman({ interactive: false }); h.confirm = async () => { throw new Error("an autonomous run opened a dialog"); }; return h; };

describe("group 26: the autonomous audit fields", () => {
  it("an autonomous Save lists no key-shaped value and no private-key or access-key field", async () => {
    const URL = "https://vercel.example/project/settings/env";
    const page = obs(URL, [
      el("e1", "fill", "Key", "textbox", { value: "OPENAI_API_KEY", form: 7 }),
      el("e2", "fill", "Value", "textbox", { value: "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", form: 7 }),
      el("e4", "fill", "Private key", "textbox", { value: "-----BEGIN RSA PRIVATE KEY-----MIIEow", form: 7, multiline: true }),
      el("e6", "fill", "Access key", "textbox", { value: "AKIAABCDEFGHIJKLMNOP", form: 7 }),
      el("e9", "click", "Save", "button", { form: 7 }),
    ], "Environment variables", { doc: 1 });
    const deps: FastRunnerDeps = {
      cfg: cfg("save the env settings", { confirm: "autonomous", url: URL }), profiles: [], chrome: async () => fakeChrome(),
      openPage: async () => fakePage({ pages: { m: page }, start: "m" }), oracle: fakeOracle(seq(clickOn("Save"), finish)),
      human: noDialog(), log: fakeLogger(), sleep: async () => undefined, fromAssistant: true, text: fakeText([]),
    };
    const r = await new FastRunner(deps).run();
    const fields = r.steps[0]?.unattended?.fields ?? [];
    expect(r.steps[0]?.unattended).toBeDefined();
    // Probe: fields hold "Value" = sk-proj-..., "Private key" = -----BEGIN RSA PRIVATE KEY-----..., "Access key" = AKIA...
    for (const f of fields) expect(KEY_PATTERN.test(f.value), `${f.label}: ${f.value}`).toBe(false);
    expect(fields.map((f) => f.label)).not.toContain("Private key");
    expect(fields.map((f) => f.label)).not.toContain("Access key");
  });
});

describe("group 27: the autonomous audit of a send", () => {
  it("lists the mention chip and the draft text that no assistant wrote, as the dialog of confirm auto does", async () => {
    const URL = "https://chat.example/c/1";
    const st = { value: "@Dana Boss\nDraft: the Q3 numbers are 42", sent: null as string | null };
    const view = (): Observation => obs(URL, [
      el("e4", "fill", "Message", "textbox", { value: st.value, form: 7, multiline: true, mentions: ["Dana Boss"], bareText: "Draft: the Q3 numbers are 42" }),
      el("e5", "click", "Send", "button", { form: 7 }),
    ], "Chat with the team", { doc: 1, filled: st.value ? [4] : [], texts: st.value ? [[4, st.value]] : [] });
    const page = fakePage({ pages: {}, start: "m" });
    page.observe = async () => view();
    page.act = async (a, _o, text, edit) => {
      page.calls.push({ op: "act", id: a.id, kind: a.kind, ...(text !== undefined ? { text } : {}) });
      if (a.kind === "fill") st.value = edit?.mode === "append" ? `${st.value}\n${text}` : text ?? "";
      if (a.label === "Send") { st.sent = st.value; st.value = ""; }
      return edit?.mode === "append" ? { mode: "append" as const, shape: "composer" as const, before: "", after: st.value } : undefined;
    };
    const r = await new FastRunner({
      cfg: cfg("reply in the chat that Tuesday works", { confirm: "autonomous", url: URL }), profiles: [], chrome: async () => fakeChrome(), openPage: async () => page,
      oracle: fakeOracle(seq(genAppend("Message"), clickOn("Send"), finish)), human: noDialog(), log: fakeLogger(), sleep: async () => undefined, fromAssistant: true,
      text: fakeText([{ kind: "text", values: { f1: "Tuesday works." } }]),
    }).run();
    // The page sent the chip and the draft with the assistant text.
    expect(st.sent).toBe("@Dana Boss\nDraft: the Q3 numbers are 42\nTuesday works.");
    const audit = r.steps.find((s) => s.unattended?.action === 'click button "Send"')?.unattended;
    expect(audit).toBeDefined();
    // Current code: { texts: [{ text: "Tuesday works.", left: true }], fields: [] }. Neither Dana nor the draft shows.
    expect(JSON.stringify(audit)).toContain("Dana Boss");
    expect(JSON.stringify(audit)).toContain("Draft: the Q3 numbers are 42");
  });
});

describe("group 34: a send that finishes in a confirmation step", () => {
  const URL = "https://app.example/channel";
  const TEXT = "Ship it";
  function scenario(confirmLabel: string) {
    const a = obs(URL, [el("e1", "fill", "Message #general", "textbox", { value: "", form: 4, multiline: true }), el("e2", "click", "Send", "button", { form: 4 })], "general");
    const a2 = obs(URL, [el("e1", "fill", "Message #general", "textbox", { value: TEXT, form: 4, multiline: true }), el("e2", "click", "Send", "button", { form: 4 })], "general.", { texts: [[1, TEXT]], filled: [1] });
    // The dialog: the composer is aria-hidden behind it (not in actions or texts, still in filled).
    const b = obs(URL, [el("e30", "click", "Cancel", "button", { form: 9 }), el("e31", "click", confirmLabel, "button", { form: 9 })], "Notify 120 people?", { texts: [], filled: [1] });
    const c = obs(URL, [el("e1", "fill", "Message #general", "textbox", { value: "", form: 4, multiline: true }), el("e2", "click", "Send", "button", { form: 4 })], "general\nShip it\nsent just now", { texts: [], filled: [] });
    const fp = fakePage({ pages: { a, a2, b, c }, start: "a", transitions: (call, cur) => {
      if (call.op === "act" && call.id === "e1") return "a2";
      if (call.op === "act" && call.id === "e2" && cur === "a2") return "b";
      if (call.op === "act" && call.id === "e31") return "c";
      return undefined;
    } });
    const has = (q: Questions, head: string, label: string) => { try { idx(q, head, label); return true; } catch { return false; } };
    const oracle = fakeOracle((nm, _s, q) => {
      if (nm !== "step") return {};
      if (has(q, "click_target", confirmLabel)) return clickOn(confirmLabel)(q);
      if (fp.current === "a") {
        const target = idx(q, "type_text_target", "Message");
        const value = Object.keys((q[`value_${target}`] as ChoiceQuestion).criteria).find((k) => k !== "none" && k !== "generate") ?? "none";
        return { page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: target, confidence: 0.9 }, type_text_value: { choice: value, confidence: 0.95 } };
      }
      if (fp.current === "a2") return clickOn("Send")(q);
      return finish(q);
    });
    const runner = new FastRunner({
      cfg: cfg(`open ${URL} and send "${TEXT}" to #general`, { headed: false }), profiles: [], chrome: async () => fakeChrome(), openPage: async () => fp, oracle,
      human: fakeHuman({ interactive: true, confirm: [true, true, true] }), log: fakeLogger(), sleep: async () => undefined, fromAssistant: true,
    });
    return { runner, fp };
  }

  it("with a button that has no send word (Confirm), the send is recorded as with 'Send now'", async () => {
    const now = scenario("Send now");
    await now.runner.run();
    expect(now.runner.sentTexts()).toEqual([{ field: "Message #general", text: TEXT }]);
    const t = scenario("Confirm");
    await t.runner.run();
    expect(t.fp.calls.filter((x) => x.op === "act").map((x) => x.id)).toEqual(["e1", "e2", "e31"]);
    // Current code: [] (the watch of the Send click ended at the Confirm click, which starts no watch).
    expect(t.runner.sentTexts()).toEqual([{ field: "Message #general", text: TEXT }]);
  });
});
