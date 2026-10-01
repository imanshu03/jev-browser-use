// Group 12: the post-fill value check of an input without a selection API (email, number) refuses a value that the page
// normalized (lower case, a parsed number), with changed=true. The loop then blocks "ambiguous" at once.
import { describe, expect, it } from "vitest";
import type { CdpClient, Chrome } from "../../src/fast/model.js";
import { EditRefused } from "../../src/fast/model.js";
import { openPage } from "../../src/fast/page.js";
import { SNAPSHOT_SCRIPT } from "../../src/fast/snapshot.js";
import { fakeLogger } from "../fakes.js";

type Sent = { method: string; params: Record<string, unknown>; sessionId?: string };

function scriptedChrome(answer: (expression: string) => unknown) {
  const sent: Sent[] = [];
  const client: CdpClient = {
    closed: false,
    async send(method, params, sessionId) {
      sent.push({ method, params: params ?? {}, ...(sessionId !== undefined ? { sessionId } : {}) });
      if (method === "Runtime.evaluate") return { result: { value: answer(String(params?.["expression"] ?? "")) } };
      return {};
    },
    on() { return () => undefined; },
    async close() { /* nothing */ },
  };
  const chrome: Chrome = {
    client, userDataDir: null, profile: { directory: null, copyDir: null, copied: false, copyMs: 0 }, launchMs: 0,
    async newTarget() { return { targetId: "t1", sessionId: "s1" }; },
    async adoptTarget(targetId) { return { targetId, sessionId: `s-${targetId}` }; },
    async closeTarget() { /* nothing */ },
    async close() { /* nothing */ },
  };
  return { chrome, sent };
}

describe("group 12: post-fill check on email/number inputs", () => {
  const key = [123, "https://example.test/profile", 0, 0, 1280, 860, []];
  const guard = [7, "textbox", "Email", "", null, null, false, false, null, null, null, null, null, "Email"];
  const snap = { url: "https://example.test/profile", title: "T", text: "Profile", scroll: { y: 0, height: 100 }, w: 1280, h: 860, actions: [], marker: null, page_key: key, guards: { "7": guard }, omitted_actions: 0, readyState: "complete" };
  type Step = { ok: boolean; text?: string; kind?: string; blank?: boolean; shape?: string; selectable?: boolean };
  function editPage(read: Step, after: Step) {
    let reads = 0;
    return scriptedChrome((expr) => {
      if (expr === SNAPSHOT_SCRIPT) return snap;
      if (/c\.guard\(c\.nodes\.get\(7\)\)/.test(expr)) return [key, guard];
      if (/__jevFast\?\.nodes\.get\(action\.node\)/.test(expr)) return { x: 10, y: 10 };
      const step = /"step":"(read|check|blank)"/.exec(expr)?.[1];
      const base = { why: "", text: "", kind: "input", blank: false };
      if (step === "read") return { ...base, ...(reads++ === 0 ? read : after) };
      if (step === "check") return { ...base, ok: true, selectable: false };
      return null;
    });
  }
  const open = async (c: ReturnType<typeof scriptedChrome>) => { const page = await openPage(c.chrome, { settleTimeoutMs: 500, log: fakeLogger() }); return { page, obs: await page.observe() }; };

  it("an email input that lowercases its value holds the typed address: the fill is not refused", async () => {
    const email = { id: "e1", kind: "fill" as const, node: 7, role: "textbox", label: "Email", value: "old@example.com", inputType: "email" };
    const c = editPage({ ok: true, text: "old@example.com", shape: "input" }, { ok: true, text: "ann.lee@example.com" });
    const { page, obs } = await open(c);
    const r = await page.act(email, obs, "Ann.Lee@Example.com").catch((e: unknown) => e);
    // Current code: EditRefused('the field shows "ann.lee@example.com" after the fill, not the typed text', changed=true).
    expect(r).not.toBeInstanceOf(EditRefused);
  });

  it("a number input that shows its parsed value (12.50 -> 12.5) holds the typed number: the fill is not refused", async () => {
    const amount = { id: "e1", kind: "fill" as const, node: 7, role: "spinbutton", label: "Amount", value: "10", inputType: "number" };
    const c = editPage({ ok: true, text: "10", shape: "input" }, { ok: true, text: "12.5" });
    const { page, obs } = await open(c);
    const r = await page.act(amount, obs, "12.50").catch((e: unknown) => e);
    expect(r).not.toBeInstanceOf(EditRefused);
  });

  it("control: text inserted into the old value (a select-all that did not happen) is still refused", async () => {
    const amount = { id: "e1", kind: "fill" as const, node: 7, role: "spinbutton", label: "Amount", value: "10", inputType: "number" };
    const c = editPage({ ok: true, text: "10", shape: "input" }, { ok: true, text: "1025" });
    const { page, obs } = await open(c);
    const r = await page.act(amount, obs, "25").catch((e: unknown) => e);
    expect(r).toBeInstanceOf(EditRefused);
    expect((r as EditRefused).changed).toBe(true);
  });
});
