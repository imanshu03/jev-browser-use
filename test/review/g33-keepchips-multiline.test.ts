// Group 33: after the chip (mention first), chipPlan forces an append with keepChips. The text request still lets the
// assistant write several lines (multiline: true, mode append), and page.ts refuses an append with line breaks into a
// composer before any change. The re-ask types the same cached text, is refused again, and the run blocks.
import type { ChoiceQuestion, Questions } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { FastRunner } from "../../src/fast/loop.js";
import type { FastRunnerDeps } from "../../src/fast/loop.js";
import type { Action, CdpClient, Chrome, Observation } from "../../src/fast/model.js";
import { EditRefused } from "../../src/fast/model.js";
import { openPage } from "../../src/fast/page.js";
import { SNAPSHOT_SCRIPT } from "../../src/fast/snapshot.js";
import type { TextReply } from "../../src/io.js";
import type { RunConfig } from "../../src/types.js";
import { fakeHuman, fakeLogger, fakeOracle, fakeText, type PartialAnswers } from "../fakes.js";
import { el, fakeChrome, fakePage, obs } from "../fast/fakes.js";

const CHAT = "https://chat.example/c/1";
const PLACEHOLDER = "Type a message";
const TEXT = "Hi Ann,\nCould you share the current status of the report?\nThanks";

describe("group 33: a keepChips append with a multi-line assistant text", () => {
  it("page.ts: a keepChips append into a chip-only composer refuses text with line breaks before any change", async () => {
    const key = [123, CHAT, 0, 0, 1280, 860, []];
    const guard = [7, "textbox", PLACEHOLDER, "", null, null, false, false, null, null, null, null, null, PLACEHOLDER];
    const snap = { url: CHAT, title: "T", text: "chat", scroll: { y: 0, height: 100 }, w: 1280, h: 860, actions: [], marker: null, page_key: key, guards: { "7": guard }, omitted_actions: 0, readyState: "complete" };
    const inserts: string[] = [];
    const client: CdpClient = {
      closed: false,
      async send(method, params) {
        if (method === "Input.insertText") inserts.push(String(params?.["text"]));
        if (method !== "Runtime.evaluate") return {};
        const expr = String(params?.["expression"] ?? "");
        let value: unknown = null;
        if (expr === SNAPSHOT_SCRIPT) value = snap;
        else if (/c\.guard\(c\.nodes\.get\(7\)\)/.test(expr)) value = [key, guard];
        else if (/__jevFast\?\.nodes\.get\(action\.node\)/.test(expr)) value = { x: 10, y: 10 };
        else if (/"step":"(read|check|blank)"/.test(expr)) value = { ok: true, why: "", text: "", kind: "editable", blank: true, shape: "composer" };
        return { result: { value } };
      },
      on() { return () => undefined; },
      async close() { /* nothing */ },
    };
    const chrome: Chrome = { client, userDataDir: null, profile: { directory: null, copyDir: null, copied: false, copyMs: 0 }, launchMs: 0,
      async newTarget() { return { targetId: "t1", sessionId: "s1" }; }, async closeTarget() { /* nothing */ }, async close() { /* nothing */ } };
    const page = await openPage(chrome, { settleTimeoutMs: 500, log: fakeLogger() });
    const o = await page.observe();
    const composer: Action = { id: "e1", kind: "fill", node: 7, role: "textbox", label: PLACEHOLDER, value: "@Ann Lee", multiline: true, mentions: ["Ann Lee"], bareText: "" };
    const e = await page.act(composer, o, TEXT, { mode: "append", keepChips: true }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EditRefused);
    expect((e as Error).message).toContain("line breaks");
    expect(inserts).toEqual([]);
  });

  it("loop: a mention-first MCP run with a two-line assistant text types it and does not block", async () => {
    const s = { text: "", chips: [] as string[], open: false, staged: [] as string[], sent: [] as { text: string; chips: string[] }[] };
    const page0 = (): Observation => {
      const value = [s.text, ...s.chips.map((c) => `@${c}`)].filter(Boolean).join(" ");
      const actions: Action[] = [
        el("e1", "fill", PLACEHOLDER, "textbox", { node: 1, value, form: 1, multiline: true, ...(s.chips.length > 0 ? { mentions: [...s.chips], bareText: s.text } : {}) }),
        el("e3", "click", "Mention", "button", { node: 2, form: 1 }),
        el("e4", "click", "Send message", "button", { node: 3, form: 1 }),
      ];
      if (s.open) {
        actions.push(el("e7", "click", "Ann Lee", "option", { node: 11, form: 2, checked: String(s.staged.includes("Ann Lee")), popup: [4, 2] }));
        if (s.staged.length > 0) actions.push(el("e9", "click", `Done (${s.staged.length})`, "button", { node: 13, form: 2, popup: [2] }));
      }
      return obs(CHAT, actions, `chat\n${s.sent.map((m) => `You: ${m.text} ${m.chips.map((c) => `@${c}`).join(" ")}`).join("\n")}`,
        { doc: 1, focus: { node: 1, label: PLACEHOLDER, role: "textbox", submitLabel: "", editable: true, value, form: 1, submitDefault: "", multiline: true }, filled: value ? [1] : [], texts: value ? [[1, value]] : [] } as Partial<Observation>);
    };
    // The page side as page.ts decides it: an append with line breaks into a composer is refused before any change.
    const page = fakePage({ pages: { c: page0() }, start: "c",
      edits: (call) => (call.edit?.mode === "append" && /\n/.test(call.text ?? "") ? new EditRefused("the text has line breaks, and a new line can send the message in this field") : undefined) });
    page.observe = async () => { page.observes += 1; return page0(); };
    const act = page.act.bind(page);
    page.act = async (a, o, text, fill) => {
      const r = await act(a, o, text, fill);
      if (a.kind === "fill") { s.text = fill?.mode === "append" ? [s.text, text ?? ""].filter(Boolean).join(" ") : text ?? ""; if (fill?.mode !== "append") s.chips = []; return r; }
      if (a.label === "Mention") s.open = !s.open;
      else if (a.label === "Send message") { s.sent.push({ text: s.text, chips: [...s.chips] }); s.text = ""; s.chips = []; }
      else if (a.role === "option") s.staged = [...s.staged, "Ann Lee"];
      else if (/^Done/.test(a.label)) { s.chips.push(...s.staged); s.staged = []; s.open = false; }
      return r;
    };
    const idx = (q: Questions, head: string, label: string): string => {
      for (const [k, v] of Object.entries((q[head] as ChoiceQuestion | undefined)?.criteria ?? {})) if (String((v as { element?: string })?.element ?? "").includes(label)) return k;
      throw new Error(`no ${head} for ${label}`);
    };
    const click = (label: string) => (q: Questions): PartialAnswers => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", label), confidence: 0.9 } });
    // Jev takes the next picker step from the page state; with the chip and no text, it types the text.
    const decide = (q: Questions): PartialAnswers => {
      if (s.sent.length > 0) return { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9 } } };
      if (s.chips.length === 0) return s.open ? click(s.staged.length > 0 ? "Done (1)" : "Ann Lee")(q) : click("Mention")(q);
      if (s.text === "") return { page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", PLACEHOLDER), confidence: 0.9 }, type_text_value: { choice: "generate", confidence: 0.9 } };
      return click("Send message")(q);
    };
    const oracle = fakeOracle((n, _s, q) => (n === "step" ? decide(q) : {}));
    const writer = fakeText([{ kind: "text", values: { f1: TEXT } } as TextReply, { kind: "text", values: { f1: TEXT } } as TextReply]);
    const deps: FastRunnerDeps = {
      cfg: { task: "mention Ann Lee and ask her for the report status", headed: false, maxSteps: 10, stepTimeoutMs: 1000, runTimeoutMs: 60_000, pauseTimeoutMs: 1000, confirm: "auto", dryRun: false, session: "s", model: "m", logLevel: "info", logJson: false, keepOpen: false, agentBrowserBin: "ab", vars: {}, profile: "none", goal: "act", engine: "cdp", refreshProfile: false, url: CHAT } as RunConfig,
      profiles: [], chrome: async () => fakeChrome(), openPage: async () => page, oracle, human: fakeHuman({ interactive: true, confirm: [true, true, true, true] }),
      log: fakeLogger(), sleep: async () => undefined, text: writer, fromAssistant: true,
    };
    const r = await new FastRunner(deps).run();
    // The request for the field after the chip is an append that keeps the mentions.
    expect(writer.requests[0]?.fields[0]).toMatchObject({ id: "f1", mode: "append" });
    expect(r.blocked?.hint ?? "").not.toContain("line breaks");
    expect(r.outcome).toBe("done");
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.chips).toEqual(["Ann Lee"]);
    expect(s.sent[0]?.text).toContain("Could you share the current status of the report?");
  });
});
