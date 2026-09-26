import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Human, TextRequest } from "../../src/io.js";
import { emptyResult } from "../../src/io.js";
import { MCP, MCP_HINTS } from "../../src/mcp/limits.js";
import type { RunHooks, RunStarter } from "../../src/mcp/runs.js";
import { RunManager } from "../../src/mcp/runs.js";
import { NoKeyError, baseConfig, fastStarter } from "../../src/mcp/setup.js";
import type { RunViewData } from "../../src/mcp/view.js";
import { RunView, TOOL_NAMES } from "../../src/mcp/view.js";
import type { RunResult } from "../../src/types.js";
import { LIMITS } from "../../src/types.js";
import { BrowserSession } from "../../src/fast/session.js";
import { fakeLogger, fakeOracle } from "../fakes.js";
import { el, fakeChrome, fakePage, obs } from "../fast/fakes.js";
import { KEY, MAIL, PROFILES, connect, fakeJev, idx, mailSession, replyOracle, type ElicitAnswer, type ElicitParams } from "./helpers.js";

type Result = Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["client"]["callTool"]>>;

const text = (r: Result): string => ((r.content as { type: string; text: string }[])[0] as { text: string }).text;
const view = (r: Result): RunViewData => {
  expect(r.isError).toBeFalsy();
  expect(r.structuredContent).toEqual(JSON.parse(text(r)));
  return RunView.parse(r.structuredContent);
};

function request(id = "t1"): TextRequest {
  return {
    id, goal: "reply to Ann", page: { url: MAIL, title: "Meeting" },
    fields: [{ id: "f1", label: "Reply", role: "textbox", required: true, multiline: true, max_chars: 4000, current_value: "" }],
    recent_actions: [], untrusted_page_text: "Can we meet on Tuesday at 10:00?",
  };
}
const done = (over: Partial<RunResult> = {}): RunResult => ({ ...emptyResult("reply to Ann", "act"), outcome: "done", reason: "done 0.90", ...over });

/** A starter that the test drives: it records the hooks and waits for `finish`. */
function held() {
  const s = { hooks: null as RunHooks | null, finish: (_r: RunResult) => undefined as void };
  const start: RunStarter = (_i, hooks) => new Promise((resolve) => { s.hooks = hooks; s.finish = resolve; });
  return { s, start };
}

/** The real fastStarter on a fake mail page and a scripted Jev. */
function realStack(opts: { plan?: Parameters<typeof replyOracle>[0] } = {}) {
  const log = fakeLogger();
  const mail = mailSession(log);
  const oracle = replyOracle(opts.plan);
  const base = baseConfig({}, log);
  const start = fastStarter({ session: mail.session, jev: fakeJev(), base, env: {}, profiles: () => PROFILES, oracle: () => oracle });
  const runs = new RunManager({ start, log, secret: () => KEY, forceStop: () => mail.session.close() });
  return { log, mail, oracle, runs };
}

const deps = (runs: RunManager, over: { env?: NodeJS.ProcessEnv; now?: () => number; closeBrowser?: () => Promise<boolean> } = {}) => ({
  runs, version: "0.1.0", env: over.env ?? {}, profiles: () => PROFILES, secret: () => KEY, log: fakeLogger(),
  closeBrowser: over.closeBrowser ?? (async () => true), ...(over.now ? { now: over.now } : {}),
});

const accept = (allow: boolean) => (): ElicitAnswer => ({ action: "accept", content: { allow } });
const REPLY = "Tuesday at 10:00 works for me.";

let stdout: ReturnType<typeof vi.spyOn>;
beforeEach(() => { stdout = vi.spyOn(process.stdout, "write"); });
afterEach(() => {
  // The server writes nothing to this process's stdout.
  expect(stdout).not.toHaveBeenCalled();
  stdout.mockRestore();
});

describe("tools/list", () => {
  it("lists the 5 tools with their annotations; continue has no _meta by default", async () => {
    const c = await connect(deps(new RunManager({ start: held().start, log: fakeLogger() })));
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by["browse"]?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(by["wait"]?.annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
    expect(by["continue"]?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    expect(by["cancel"]?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(by["close_browser"]?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(by["continue"]?._meta?.["anthropic/requiresUserInteraction"]).toBeUndefined();
    expect(by["browse"]?.inputSchema).toMatchObject({ additionalProperties: false, required: ["task"], properties: { headed: { default: true }, wait_s: { default: 40, maximum: 50 }, vars: { propertyNames: { pattern: "^[a-z0-9_]{1,40}$" } } } });
    expect(by["continue"]?.inputSchema).toMatchObject({ required: ["run", "request"], properties: { request: { pattern: "^t[0-9]{1,2}$" }, values: { propertyNames: { pattern: "^f[0-9]{1,2}$" } } } });
    await c.close();
  });

  it("continue requires user interaction only with JEV_MCP_REVIEW_TEXT=1", async () => {
    const c = await connect(deps(new RunManager({ start: held().start, log: fakeLogger() }), { env: { JEV_MCP_REVIEW_TEXT: "1" } }));
    const { tools } = await c.client.listTools();
    expect(tools.find((t) => t.name === "continue")?._meta).toEqual({ "anthropic/requiresUserInteraction": true });
    expect(tools.filter((t) => t._meta?.["anthropic/requiresUserInteraction"] !== undefined).map((t) => t.name)).toEqual(["continue"]);
    await c.close();
  });
});

describe("the reply flow", () => {
  it("browse -> needs_text -> continue -> dialog -> done; structuredContent equals the text JSON", async () => {
    const t = realStack();
    const c = await connect(deps(t.runs), accept(true));
    const v1 = view(await c.client.callTool({ name: "browse", arguments: { task: "reply to Ann that the time she proposes works", url: MAIL, profile: "none" } }));
    expect(v1.status).toBe("needs_text");
    expect(v1.text_request?.request).toBe("t1");
    expect(v1.text_request?.fields.map((f) => [f.id, f.label, f.required])).toEqual([["f1", "Reply", true], ["f2", "Subject", false]]);
    expect(v1.text_request?.untrusted_page_text).toContain("Can we meet on Tuesday at 10:00?");
    expect(v1.next).toContain(`continue with run "${v1.run}", request "t1"`);
    const v2 = view(await c.client.callTool({ name: "continue", arguments: { run: v1.run, request: "t1", values: { f1: REPLY, f2: "Re: Meeting" } } }));
    expect(c.dialogs).toHaveLength(1);
    const d = c.dialogs[0] as ElicitParams;
    expect(d.mode).toBe("form");
    expect(d.message).toContain('Jev wants to click button "Send" on mail.example.');
    expect(d.message).toContain(`Reply (${REPLY.length} characters):\n> ${REPLY}`);
    expect(d.message).toContain("Subject (11 characters):\n> Re: Meeting");
    expect(d.requestedSchema).toEqual({ type: "object", properties: { allow: { type: "boolean", title: "Allow", default: false } }, required: ["allow"] });
    let v = v2;
    for (let i = 0; i < 5 && v.status !== "done"; i++) v = view(await c.client.callTool({ name: "wait", arguments: { run: v1.run, wait_s: 5 } }));
    expect(v.status).toBe("done");
    expect(v.result).toMatchObject({ outcome: "done", stats: { text_requests: 1 } });
    expect(t.mail.state.sent).toBe(`Re: Meeting | ${REPLY}`);
    expect(t.mail.launches).toHaveLength(1);
    await c.close();
  });

  it("a denied dialog blocks needs_confirmation; nothing is sent", async () => {
    const t = realStack();
    const c = await connect(deps(t.runs), accept(false));
    const v1 = view(await c.client.callTool({ name: "browse", arguments: { task: "reply to Ann", url: MAIL, profile: "none" } }));
    let v = view(await c.client.callTool({ name: "continue", arguments: { run: v1.run, request: "t1", values: { f1: REPLY, f2: "Re: Meeting" } } }));
    for (let i = 0; i < 5 && v.status !== "blocked"; i++) v = view(await c.client.callTool({ name: "wait", arguments: { run: v1.run, wait_s: 5 } }));
    expect(v.result?.blocked).toEqual({ kind: "needs_confirmation", hint: 'the user did not allow click button "Send"' });
    expect(v.next).toContain("The user or the client declined the dialog.");
    expect(t.mail.state.sent).toBeNull();
    await c.close();
  });

  it.each([["decline", { action: "decline" }], ["cancel", { action: "cancel" }], ["accept without allow", { action: "accept", content: {} }]] as const)("a dialog answer of %s denies the action", async (_n, answer) => {
    const t = realStack();
    const c = await connect(deps(t.runs), () => answer as ElicitAnswer);
    const v1 = view(await c.client.callTool({ name: "browse", arguments: { task: "reply to Ann", url: MAIL, profile: "none" } }));
    let v = view(await c.client.callTool({ name: "continue", arguments: { run: v1.run, request: "t1", values: { f1: REPLY, f2: "Re: Meeting" } } }));
    for (let i = 0; i < 5 && v.status !== "blocked"; i++) v = view(await c.client.callTool({ name: "wait", arguments: { run: v1.run, wait_s: 5 } }));
    expect(v.result?.blocked?.kind).toBe("needs_confirmation");
    expect(c.dialogs).toHaveLength(1);
    expect(t.mail.state.sent).toBeNull();
    await c.close();
  });

  it("a client without elicitation gets no dialog: the send blocks with the noConfirm hint and the text stays in the field", async () => {
    const t = realStack();
    const c = await connect(deps(t.runs));
    const v1 = view(await c.client.callTool({ name: "browse", arguments: { task: "reply to Ann", url: MAIL, profile: "none" } }));
    let v = view(await c.client.callTool({ name: "continue", arguments: { run: v1.run, request: "t1", values: { f1: REPLY, f2: "Re: Meeting" } } }));
    for (let i = 0; i < 5 && v.status !== "blocked"; i++) v = view(await c.client.callTool({ name: "wait", arguments: { run: v1.run, wait_s: 5 } }));
    expect(v.result?.blocked?.kind).toBe("needs_confirmation");
    expect(v.result?.blocked?.hint).toContain(MCP_HINTS.noConfirm);
    expect(v.next).toBe("Report result.blocked.hint to the user.");
    expect(t.mail.state.sent).toBeNull();
    expect(t.mail.state.values[3]).toBe(REPLY);
    await c.close();
  });

  it("the profile dialog: an allowed profile question runs on that profile", async () => {
    const t = realStack({ plan: { goal: "act", profile_mentioned: 0.9, profile: { choice: "Profile 2", confidence: 0.6 } } });
    const c = await connect(deps(t.runs), accept(true));
    const v1 = view(await c.client.callTool({ name: "browse", arguments: { task: "reply to Ann with my work profile", url: MAIL } }));
    expect(c.dialogs[0]?.message).toBe("Use Chrome profile BP (Profile 2) for this task?");
    expect(v1.status).toBe("running");
    const v2 = view(await c.client.callTool({ name: "wait", arguments: { run: v1.run } }));
    expect(v2.status).toBe("needs_text");
    expect(t.mail.launches[0]?.profileDirectory).toBe("Profile 2");
    await c.client.callTool({ name: "cancel", arguments: { run: v1.run } });
    await c.close();
  });
});

describe("dialog rules", () => {
  /** A starter that asks one confirmation when the test says so, then reports what the human answered. */
  function asking(detail: Parameters<Human["confirm"]>[2] = { kind: "action", action: 'click button "Send"', host: "mail.example", typed: [] }) {
    const s = { go: () => undefined as void, interactive: null as boolean | null };
    const start: RunStarter = async (_i, hooks) => {
      s.interactive = hooks.human.interactive;
      await new Promise<void>((r) => { s.go = r; });
      const ok = await hooks.human.confirm("About to click. Type y to allow: ", LIMITS.confirmPromptMs, detail);
      return done({ reason: ok ? "allowed" : "denied" });
    };
    return { s, start };
  }

  it.each([
    [{}, true],
    [{ CLAUDE_CODE_SESSION_ATTENDED: "0" }, false],
    [{ CLAUDE_CODE_SESSION_ATTENDED: "0", JEV_MCP_TRUST_ELICITATION: "1" }, true],
    [{ CLAUDE_CODE_SESSION_ATTENDED: "1" }, true],
  ] as const)("env %j gives interactive %s", async (env, interactive) => {
    const a = asking();
    const runs = new RunManager({ start: a.start, log: fakeLogger() });
    const c = await connect(deps(runs, { env }), accept(true));
    const v = view(await c.client.callTool({ name: "browse", arguments: { task: "x", wait_s: 0 } }));
    expect(a.s.interactive).toBe(interactive);
    a.s.go();
    await c.client.callTool({ name: "wait", arguments: { run: v.run, wait_s: 5 } });
    await c.close();
  });

  it("a client without the capability is not interactive", async () => {
    const a = asking();
    const c = await connect(deps(new RunManager({ start: a.start, log: fakeLogger() })));
    await c.client.callTool({ name: "browse", arguments: { task: "x", wait_s: 0 } });
    expect(a.s.interactive).toBe(false);
    a.s.go();
    await c.close();
  });

  it("a confirmation raised mid-wait in a call older than 5 s returns confirming; the next wait opens the dialog", async () => {
    let clock = 1_000_000;
    const a = asking();
    const runs = new RunManager({ start: a.start, log: fakeLogger() });
    const c = await connect(deps(runs, { now: () => clock }), accept(true));
    const v0 = view(await c.client.callTool({ name: "browse", arguments: { task: "x", wait_s: 0 } }));
    const waiting = c.client.callTool({ name: "wait", arguments: { run: v0.run, wait_s: 30 } });
    await new Promise((r) => setTimeout(r, 20));
    clock += MCP.freshCallMs + 1;
    a.s.go();
    const v1 = view(await waiting);
    expect(v1.status).toBe("confirming");
    expect(v1.confirmation?.kind).toBe("action");
    expect(v1.next).toBe(`Call wait with run "${v0.run}" now. The user answers a dialog. You cannot answer it.`);
    expect(c.dialogs).toHaveLength(0);
    const v2 = view(await c.client.callTool({ name: "wait", arguments: { run: v0.run, wait_s: 5 } }));
    expect(c.dialogs).toHaveLength(1);
    expect(["running", "done"]).toContain(v2.status);
    const v3 = view(await c.client.callTool({ name: "wait", arguments: { run: v0.run, wait_s: 5 } }));
    expect(v3.result?.reason).toBe("allowed");
    await c.close();
  });

  it("a dialog that the client does not answer in time denies the action", async () => {
    const a = asking();
    const runs = new RunManager({ start: a.start, log: fakeLogger() });
    let answered = false;
    const c = await connect(deps(runs), async () => { await new Promise((r) => setTimeout(r, 200)); answered = true; return { action: "accept", content: { allow: true } }; });
    const v0 = view(await c.client.callTool({ name: "browse", arguments: { task: "x", wait_s: 0 } }));
    const take = vi.spyOn(runs, "takeConfirm").mockImplementation((id) => {
      const r = RunManager.prototype.takeConfirm.call(runs, id);
      return r ? { ...r, dialogMs: 50 } : r;
    });
    a.s.go();
    view(await c.client.callTool({ name: "wait", arguments: { run: v0.run, wait_s: 5 } }));
    const v = view(await c.client.callTool({ name: "wait", arguments: { run: v0.run, wait_s: 5 } }));
    expect(v.result?.reason).toBe("denied");
    take.mockRestore();
    await new Promise((r) => setTimeout(r, 250));
    expect(answered).toBe(true);
    await c.close();
  });
});

describe("autonomous runs", () => {
  const AUTO = { confirm: "autonomous", user_said: "Reply to Ann and send it, don't ask me" } as const;
  const run = async (c: Awaited<ReturnType<typeof connect>>) => {
    const views: RunViewData[] = [];
    const v1 = view(await c.client.callTool({ name: "browse", arguments: { task: "reply to Ann that the time she proposes works", url: MAIL, profile: "none", ...AUTO } }));
    views.push(v1);
    expect(v1.status).toBe("needs_text");
    expect(v1.next).toContain("Autonomous run: this text goes out with no dialog.");
    let v = view(await c.client.callTool({ name: "continue", arguments: { run: v1.run, request: "t1", values: { f1: REPLY, f2: "Re: Meeting" } } }));
    views.push(v);
    for (let i = 0; i < 5 && !["done", "blocked", "failed"].includes(v.status); i++) { v = view(await c.client.callTool({ name: "wait", arguments: { run: v1.run, wait_s: 5 } })); views.push(v); }
    return { v, views };
  };

  it("a client with dialogs gets none: every view has the banner, and the result lists the Send with the texts that left the page", async () => {
    const t = realStack();
    const c = await connect(deps(t.runs), accept(false));
    const { v, views } = await run(c);
    expect(c.dialogs).toHaveLength(0);
    expect(v.status).toBe("done");
    expect(t.mail.state.sent).toBe(`Re: Meeting | ${REPLY}`);
    for (const x of views) expect(x.autonomous?.user_said).toBe(AUTO.user_said);
    expect(v.autonomous).toEqual({ user_said: AUTO.user_said, unattended_actions: 1, profile: null });
    expect(v.result?.unattended).toEqual([{
      step: 3, action: 'click button "Send"', host: "mail.example", risk: "destructive", result: "ok", why: ["destructive", "unsent_text"],
      texts: [{ label: "Reply", chars: REPLY.length, text: REPLY, left: true }, { label: "Subject", chars: 11, text: "Re: Meeting", left: true }], fields: [],
    }]);
    expect(v.next).toContain("This run was autonomous: tell the user each action in result.unattended");
    expect(t.log.lines.some((l) => l.includes("started (autonomous: no dialogs; the user said"))).toBe(true);
    expect(t.log.lines.some((l) => l.startsWith("WARN") && l.includes('unattended: click button "Send"'))).toBe(true);
    await c.close();
  });

  it("a client without dialogs ends done, not needs_confirmation", async () => {
    const t = realStack();
    const c = await connect(deps(t.runs));
    const { v } = await run(c);
    expect(v.status).toBe("done");
    expect(v.result?.blocked).toBeNull();
    expect(t.mail.state.sent).toBe(`Re: Meeting | ${REPLY}`);
    await c.close();
  });

  it("the words, the off switch, and one confirm value per run are checked before a run starts", async () => {
    const h = held();
    const runs = new RunManager({ start: h.start, log: fakeLogger() });
    const c = await connect(deps(runs, { env: { JEV_MCP_AUTONOMOUS: "0" } }));
    const off = await c.client.callTool({ name: "browse", arguments: { task: "a", ...AUTO } });
    expect(off.isError).toBe(true);
    expect(text(off)).toContain("JEV_MCP_AUTONOMOUS=0");
    await c.close();
    const c2 = await connect(deps(runs));
    for (const [args, want] of [
      [{ confirm: "autonomous" }, /needs user_said/],
      [{ confirm: "autonomous", user_said: "yes, go ahead" }, /must hold the user's own words/],
      [{ user_said: "don't ask me" }, /goes only with confirm "autonomous"/],
    ] as const) {
      const r = await c2.client.callTool({ name: "browse", arguments: { task: "a", ...args } });
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(text(r)).toMatch(want);
    }
    const long = await c2.client.callTool({ name: "browse", arguments: { task: "a", confirm: "autonomous", user_said: `autonomously ${"x".repeat(300)}` } });
    expect(long.isError).toBe(true);
    expect(h.s.hooks).toBeNull();
    const v = view(await c2.client.callTool({ name: "browse", arguments: { task: "a", wait_s: 0 } }));
    const again = await c2.client.callTool({ name: "browse", arguments: { task: "a", wait_s: 0, ...AUTO } });
    expect(again.isError).toBe(true);
    expect(text(again)).toBe(`run ${v.run} is active with confirm "auto". Call wait with run "${v.run}", or call cancel.`);
    h.s.finish(done());
    await c2.close();
  });

  it("the browse schema has the four confirm values and user_said of at most 300 characters", async () => {
    const c = await connect(deps(new RunManager({ start: held().start, log: fakeLogger() })));
    const { tools } = await c.client.listTools();
    const browse = tools.find((x) => x.name === "browse");
    expect(browse?.inputSchema).toMatchObject({ properties: { confirm: { enum: ["auto", "always", "never", "autonomous"], default: "auto" }, user_said: { type: "string", minLength: 1, maxLength: 300 } } });
    expect(browse?.description).toContain('Set confirm to "autonomous" only when the user\'s own message asks for it');
    await c.close();
  });
});

describe("isError means a wrong call", () => {
  it("busy and stopping name the active run; unknown runs and stale requests say what to call", async () => {
    const h = held();
    const runs = new RunManager({ start: h.start, log: fakeLogger() });
    const c = await connect(deps(runs));
    const v = view(await c.client.callTool({ name: "browse", arguments: { task: "a", wait_s: 0 } }));
    const busy = await c.client.callTool({ name: "browse", arguments: { task: "b", wait_s: 0 } });
    expect(busy.isError).toBe(true);
    expect(text(busy)).toBe(`run ${v.run} is active. Call wait with run "${v.run}", or call cancel.`);
    const same = view(await c.client.callTool({ name: "browse", arguments: { task: "a", wait_s: 0 } }));
    expect(same.run).toBe(v.run);
    const closeBusy = await c.client.callTool({ name: "close_browser", arguments: {} });
    expect(closeBusy.isError).toBe(true);
    expect(text(closeBusy)).toContain(`run ${v.run} is active`);
    const unknown = await c.client.callTool({ name: "wait", arguments: { run: "r9-dead" } });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toBe('no run "r9-dead". The server may have restarted. Call browse.');
    void h.s.hooks?.text.write(request("t1"), { timeoutMs: 100_000, check: () => ({}) });
    const stale = await c.client.callTool({ name: "continue", arguments: { run: v.run, request: "t2", values: { f1: "x" } } });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toBe(`request "t2" is not open in run "${v.run}". Call wait with run "${v.run}" to see the current request.`);
    const both = await c.client.callTool({ name: "continue", arguments: { run: v.run, request: "t1", values: { f1: "x" }, decline: "no" } });
    expect(both.isError).toBe(true);
    expect(text(both)).toContain("not both");
    const neither = await c.client.callTool({ name: "continue", arguments: { run: v.run, request: "t1" } });
    expect(neither.isError).toBe(true);
    // Stopping: a runner that has not settled keeps the server busy.
    void runs.cancel(v.run);
    const stopping = await c.client.callTool({ name: "browse", arguments: { task: "a", wait_s: 0 } });
    expect(stopping.isError).toBe(true);
    expect(text(stopping)).toContain(`run ${v.run} is active`);
    const w = view(await c.client.callTool({ name: "wait", arguments: { run: v.run, wait_s: 0 } }));
    expect(w.status).toBe("stopping");
    h.s.finish(done({ outcome: "blocked", reason: "human_aborted: the run was cancelled" }));
    const end = view(await c.client.callTool({ name: "wait", arguments: { run: v.run, wait_s: 5 } }));
    expect(end.status).toBe("blocked");
    const closed = await c.client.callTool({ name: "close_browser", arguments: {} });
    expect(closed.structuredContent).toEqual({ closed: true });
    await c.close();
  });

  it("no key, a bad url, an unknown profile, and a bad argument", async () => {
    const runs = new RunManager({ start: held().start, log: fakeLogger(), precheck: () => { throw new NoKeyError("no TypeSafe API key. Set TYPESAFE_API_KEY"); } });
    const c = await connect(deps(runs));
    const nokey = await c.client.callTool({ name: "browse", arguments: { task: "a" } });
    expect(nokey.isError).toBe(true);
    expect(text(nokey)).toBe("no TypeSafe API key. Set TYPESAFE_API_KEY");
    const url = await c.client.callTool({ name: "browse", arguments: { task: "a", url: "javascript:alert(1)" } });
    expect(url.isError).toBe(true);
    expect(text(url)).toMatch(/http or https/);
    const file = await c.client.callTool({ name: "browse", arguments: { task: "a", url: "file:///etc/passwd" } });
    expect(text(file)).toContain("JEV_MCP_ALLOW_FILE=1");
    const prof = await c.client.callTool({ name: "browse", arguments: { task: "a", profile: "Work" } });
    expect(prof.isError).toBe(true);
    expect(text(prof)).toBe('unknown profile "Work". Use one of: Parallelloop (Profile 14), BP (Profile 2), none');
    const extra = await c.client.callTool({ name: "browse", arguments: { task: "a", approve: true } });
    expect(extra.isError).toBe(true);
    const badWait = await c.client.callTool({ name: "wait", arguments: { run: "r1", wait_s: 51 } });
    expect(badWait.isError).toBe(true);
    await c.close();
  });

  it("the API key is removed from error text", async () => {
    const runs = new RunManager({ start: held().start, log: fakeLogger(), precheck: () => { throw new Error(`upstream said ${KEY}`); } });
    const c = await connect(deps(runs));
    const r1 = await c.client.callTool({ name: "browse", arguments: { task: "a", profile: KEY } });
    expect(text(r1)).not.toContain(KEY);
    expect(text(r1)).toContain('unknown profile "***"');
    const r2 = await c.client.callTool({ name: "browse", arguments: { task: "a" } });
    expect(r2.isError).toBe(true);
    expect(text(r2)).toBe("internal error: upstream said ***");
    await c.close();
  });

  it("a run's failed result is a normal result, and its error has no key", async () => {
    const start: RunStarter = async () => { throw new Error(`chrome said ${KEY}`); };
    const c = await connect(deps(new RunManager({ start, log: fakeLogger(), secret: () => KEY })));
    const v = view(await c.client.callTool({ name: "browse", arguments: { task: "a" } }));
    expect(v.status).toBe("failed");
    expect(v.result?.error).toEqual({ kind: "internal", message: "chrome said ***" });
    expect(JSON.stringify(v)).not.toContain(KEY);
    await c.close();
  });
});

describe("unsent text across runs on the kept page", () => {
  const ISSUE = "https://code.example/issues/1";
  const WROTE = "I will look at it tomorrow.";

  /** An issue page: a comment box and a "Comment" button in one form. "Comment" is not a risk word. */
  function issueStack() {
    const log = fakeLogger();
    const state = { values: {} as Record<number, string>, posted: null as string | null };
    const page = () => obs(ISSUE, [
      el("e3", "fill", "Leave a comment", "textbox", { value: state.values[3] ?? "", form: 7, multiline: true }),
      el("e4", "click", "Comment", "button", { form: 7 }),
    ], `Issue 1\nPlease reply.${state.posted !== null ? `\nPosted: ${state.posted}` : ""}`, { doc: 42.5, title: "Issue 1" });
    const tab = fakePage({ pages: { m: page() }, start: "m" });
    tab.observe = async () => page();
    tab.url = async () => ISSUE;
    const act = tab.act.bind(tab);
    tab.act = async (a, o, value) => {
      await act(a, o, value);
      if (a.kind === "fill" && a.node !== null) state.values[a.node] = value ?? "";
      if (a.label === "Comment") { state.posted = state.values[3] ?? ""; state.values = {}; }
    };
    const session = new BrowserSession({ env: {}, log, launch: async () => fakeChrome(), open: async () => tab });
    let run = 0;
    const oracle = fakeOracle((name, st, q) => {
      if (name === "plan") return { goal: "act" };
      if (name !== "step") return {};
      const n = (st as { recent_actions: unknown[] }).recent_actions.length;
      if (run === 1 && n === 0) return { page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", "Leave a comment"), confidence: 0.8 }, type_text_value: { choice: "generate", confidence: 0.8 } };
      if (run === 2 && n > 0) return { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } };
      return { page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", "Comment"), confidence: 0.9 } };
    });
    const start = fastStarter({ session, jev: fakeJev(), base: baseConfig({}, log), env: {}, profiles: () => PROFILES, oracle: () => oracle });
    const runs = new RunManager({ start, log, secret: () => KEY, forceStop: () => session.close() });
    return { state, session, runs, next: () => { run += 1; } };
  }

  const until = async (c: Awaited<ReturnType<typeof connect>>, v0: RunViewData): Promise<RunViewData> => {
    let v = v0;
    for (let i = 0; i < 8 && !["done", "blocked", "failed"].includes(v.status); i++) v = view(await c.client.callTool({ name: "wait", arguments: { run: v0.run, wait_s: 5 } }));
    return v;
  };

  it("after a denied dialog, a new browse that clicks a button that is not a risk word asks again, and nothing is posted", async () => {
    const t = issueStack();
    const c = await connect(deps(t.runs), accept(false));
    t.next();
    const v1 = view(await c.client.callTool({ name: "browse", arguments: { task: "reply to the issue", url: ISSUE, profile: "none" } }));
    expect(v1.status).toBe("needs_text");
    const e1 = await until(c, view(await c.client.callTool({ name: "continue", arguments: { run: v1.run, request: "t1", values: { f1: WROTE } } })));
    expect(e1.result?.blocked).toEqual({ kind: "needs_confirmation", hint: 'the user did not allow click button "Comment"' });
    expect(t.state.values[3]).toBe(WROTE);
    expect(t.session.unsent).toMatchObject([{ label: "Leave a comment", text: WROTE }]);
    t.next();
    const e2 = await until(c, view(await c.client.callTool({ name: "browse", arguments: { task: "click the Comment button", profile: "none" } })));
    expect(c.dialogs).toHaveLength(2);
    expect(c.dialogs[1]?.message).toContain(`Leave a comment (${WROTE.length} characters):\n> ${WROTE}`);
    expect(e2.result?.blocked).toEqual({ kind: "needs_confirmation", hint: 'the user did not allow click button "Comment"' });
    expect(t.state.posted).toBeNull();
    await c.close();
  });

  it("without dialogs, the second run blocks too; close_browser ends the page and its unsent text", async () => {
    const t = issueStack();
    const c = await connect(deps(t.runs, { closeBrowser: async () => { await t.session.close(); return true; } }));
    t.next();
    const v1 = view(await c.client.callTool({ name: "browse", arguments: { task: "reply to the issue", url: ISSUE, profile: "none" } }));
    await until(c, view(await c.client.callTool({ name: "continue", arguments: { run: v1.run, request: "t1", values: { f1: WROTE } } })));
    t.next();
    const e2 = await until(c, view(await c.client.callTool({ name: "browse", arguments: { task: "click the Comment button", profile: "none" } })));
    expect(e2.result?.blocked?.kind).toBe("needs_confirmation");
    expect(e2.result?.blocked?.hint).toContain(MCP_HINTS.noConfirm);
    expect(t.state.posted).toBeNull();
    await c.client.callTool({ name: "close_browser", arguments: {} });
    expect(t.session.unsent).toEqual([]);
    await c.close();
  });

  it("confirm never blocks with the hint that names the confirm setting", async () => {
    const t = issueStack();
    const c = await connect(deps(t.runs), accept(true));
    t.next();
    const v1 = view(await c.client.callTool({ name: "browse", arguments: { task: "reply to the issue", url: ISSUE, profile: "none", confirm: "never" } }));
    const e1 = await until(c, view(await c.client.callTool({ name: "continue", arguments: { run: v1.run, request: "t1", values: { f1: WROTE } } })));
    expect(e1.result?.blocked?.hint).toBe(`navigational action click button "Comment": ${MCP_HINTS.confirmNever}`);
    expect(e1.result?.blocked?.hint).not.toContain("JEV_MCP_TRUST_ELICITATION");
    expect(c.dialogs).toHaveLength(0);
    await c.close();
  });
});
