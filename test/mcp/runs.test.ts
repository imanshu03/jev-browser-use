import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmDetail, PauseResult, TextReply, TextRequest } from "../../src/io.js";
import { emptyResult } from "../../src/io.js";
import { MCP, MCP_HINTS } from "../../src/mcp/limits.js";
import type { BrowseInput, RunHooks, RunStarter } from "../../src/mcp/runs.js";
import { BusyError, RunManager, StaleRequestError, UnknownRunError } from "../../src/mcp/runs.js";
import type { RunResult, StepRecord } from "../../src/types.js";
import { LIMITS } from "../../src/types.js";
import { fakeLogger } from "../fakes.js";

const KEY = "tsk-test-key-0123456789abcdef";

const input = (task = "reply to Ann", over: Partial<BrowseInput> = {}): BrowseInput => ({ task, headed: true, confirm: "auto", dry_run: false, ...over });

function result(outcome: RunResult["outcome"], over: Partial<RunResult> = {}): RunResult {
  return { ...emptyResult("reply to Ann", "act"), outcome, reason: outcome, ...over };
}

function request(id = "t1"): TextRequest {
  return {
    id, goal: "reply to Ann", page: { url: "https://mail.example/t/1", title: "Mail" },
    fields: [{ id: "f1", label: "Reply", role: "textbox", required: true, multiline: true, max_chars: 4000, current_value: "" }],
    recent_actions: [], untrusted_page_text: "Can we meet on Tuesday?",
  };
}

/** f1 must be non-empty. */
const check = (v: Record<string, string>): Record<string, string> => ((v["f1"] ?? "").trim() === "" ? { f1: "text is required" } : {});

/** A starter that the test settles by hand. */
function manual() {
  const calls: { input: BrowseInput; hooks: RunHooks; resolve: (r: RunResult) => void; reject: (e: unknown) => void }[] = [];
  const start: RunStarter = (i, hooks) => new Promise((resolve, reject) => { calls.push({ input: i, hooks, resolve, reject }); });
  const last = () => { const c = calls[calls.length - 1]; if (!c) throw new Error("no start"); return c; };
  return { start, calls, last };
}

function setup(over: { precheck?: () => void; forceStop?: () => Promise<void>; secret?: () => string | null } = {}) {
  const m = manual();
  const log = fakeLogger();
  const runs = new RunManager({ start: m.start, log, secret: over.secret ?? (() => KEY), ...(over.precheck ? { precheck: over.precheck } : {}), ...(over.forceStop ? { forceStop: over.forceStop } : {}) });
  return { runs, m, log };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("RunManager: start, busy, get", () => {
  it("passes the hooks: MCP hints, a live signal, the interactive flag", () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: true });
    expect(run.id).toMatch(/^r1-[0-9a-f]{4}$/);
    expect(run.status).toBe("running");
    const h = m.last().hooks;
    expect(h.hints).toBe(MCP_HINTS);
    expect(h.signal.aborted).toBe(false);
    expect(h.human.interactive).toBe(true);
    expect(runs.active()).toBe(run);
  });

  it("hooks.untyped records the labels on the run; the view reports them after the run ends", async () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: false });
    expect(run.untyped).toEqual([]);
    m.last().hooks.untyped?.(["Subject"]);
    m.last().resolve({ ...emptyResult("t", "act"), outcome: "done", reason: "done 0.97" });
    await flush();
    expect(runs.get(run.id).untyped).toEqual(["Subject"]);
  });

  it("hooks.sent records the sent texts on the run", async () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: false });
    expect(run.sent).toEqual([]);
    m.last().hooks.sent?.([{ field: "Reply", text: "Tuesday works." }]);
    m.last().resolve({ ...emptyResult("t", "act"), outcome: "done", reason: "done 0.97" });
    await flush();
    expect(runs.get(run.id).sent).toEqual([{ field: "Reply", text: "Tuesday works." }]);
  });

  it("the same task while active gives the same run; another task is BusyError", () => {
    const { runs, m } = setup();
    const run = runs.start(input("a"), { interactive: false });
    expect(runs.start(input("a"), { interactive: false })).toBe(run);
    expect(() => runs.start(input("b"), { interactive: false })).toThrow(BusyError);
    expect(() => runs.start(input("b"), { interactive: false })).toThrow(`run ${run.id} is active. Call wait with run "${run.id}", or call cancel.`);
    expect(m.calls).toHaveLength(1);
  });

  it("precheck runs first and its error goes to the caller", () => {
    const { runs, m } = setup({ precheck: () => { throw new Error("no key"); } });
    expect(() => runs.start(input(), { interactive: false })).toThrow("no key");
    expect(m.calls).toHaveLength(0);
    expect(runs.active()).toBeNull();
  });

  it("an unknown id throws UnknownRunError with the restart hint", () => {
    const { runs } = setup();
    expect(() => runs.get("r9-abcd")).toThrow(UnknownRunError);
    expect(() => runs.get("r9-abcd")).toThrow('no run "r9-abcd". The server may have restarted. Call browse.');
  });

  it("lastRunEndedAt is null before the first run ends; a finished run keeps its result", async () => {
    const { runs, m } = setup();
    expect(runs.lastRunEndedAt()).toBeNull();
    const run = runs.start(input(), { interactive: false });
    m.last().resolve(result("done"));
    await flush();
    expect(run.status).toBe("done");
    expect(run.result?.outcome).toBe("done");
    expect(run.endedAt).not.toBeNull();
    expect(runs.lastRunEndedAt()).toBe(run.endedAt);
    expect(runs.active()).toBeNull();
  });

  it("keeps the last 10 finished runs", async () => {
    const { runs, m } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      ids.push(runs.start(input(`task ${i}`), { interactive: false }).id);
      m.last().resolve(result("done"));
      await flush();
    }
    expect(() => runs.get(ids[0] as string)).toThrow(UnknownRunError);
    for (const id of ids.slice(1)) expect(runs.get(id).status).toBe("done");
  });

  it("a starter throw becomes a failed/internal result, redacted and without the key", async () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: false });
    m.last().hooks.log.redactor = (s) => s.split("s3cr3t").join("***");
    m.last().reject(new Error(`boom s3cr3t ${KEY}`));
    await flush();
    expect(run.status).toBe("failed");
    expect(run.result?.error).toEqual({ kind: "internal", message: "boom *** ***" });
    expect(run.result?.reason).toBe("internal: boom *** ***");
  });
});

describe("RunManager: per-run logger", () => {
  it("the redactor setter also sets the stderr logger's redactor, both with the key removed", () => {
    const { runs, m, log } = setup();
    const run = runs.start(input(), { interactive: false });
    const hooks = m.last().hooks;
    hooks.log.redactor = (s) => s.split("s3cr3t").join("***");
    expect(log.redactor(`a s3cr3t ${KEY}`)).toBe("a *** ***");
    expect(run.redact(`a s3cr3t ${KEY}`)).toBe("a *** ***");
    expect(hooks.log.redactor(`b ${KEY}`)).toBe("b ***");
  });

  it("step records update steps, last_step, and a tail of at most 8 flat lines", () => {
    const { runs, m, log } = setup();
    const run = runs.start(input(), { interactive: false });
    const hooks = m.last().hooks;
    hooks.log.redactor = (s) => s.split("s3cr3t").join("***");
    const rec = (n: number): StepRecord => ({
      step: n, url: "https://x", title: "t", page_kind: null, page_kind_conf: null, done_p: null, operation: "CLICK", operation_conf: 0.9,
      target: { ref: "e1", role: "button", name: `Go\n\u202E${n} s3cr3t`, under: "" }, target_conf: 0.9, runner_up: 0, action: "click", value: null, value_conf: null,
      risk: "navigational", path: "fast", gate: "ok", result: "ok", error: null, jev_requests: 1, duration_ms: 5,
    });
    for (let i = 1; i <= 10; i++) hooks.log.step(rec(i));
    expect(run.steps).toBe(10);
    expect(run.tail).toHaveLength(MCP.viewSteps);
    expect(run.tail[0]).toMatch(/^3 click button "Go 3 \*\*\*" -> ok \(ok\)$/);
    expect(run.lastStep).toBe('10 click button "Go 10 ***" -> ok (ok)');
    expect(log.steps).toHaveLength(10);
  });

  it("redacts the value and the target name before the 60-character cut, so no part of a secret stays", () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: false });
    const hooks = m.last().hooks;
    hooks.log.redactor = (s) => s.split("Hunter2222").join("***");
    hooks.log.step({
      step: 1, url: "https://x", title: "t", page_kind: null, page_kind_conf: null, done_p: null, operation: "TYPE_TEXT", operation_conf: 0.9,
      target: { ref: "e1", role: "textbox", name: `${"n".repeat(55)}Hunter2222`, under: "" }, target_conf: 0.9, runner_up: 0, action: "fill",
      value: `${"x".repeat(55)}Hunter2222 is new`, value_conf: 1, risk: "data_entry", path: "fast", gate: "ok", result: "ok", error: null, jev_requests: 1, duration_ms: 5,
    });
    expect(run.lastStep).not.toContain("Hunt");
    expect(run.lastStep).toContain(`"${"x".repeat(55)}***`);
  });
});

describe("RunManager: text requests", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function open() {
    const t = setup();
    const run = t.runs.start(input(), { interactive: false });
    const replies: TextReply[] = [];
    const p = t.m.last().hooks.text.write(request("t1"), { timeoutMs: LIMITS.textWaitMs, check }).then((r) => { replies.push(r); return r; });
    return { ...t, run, replies, p };
  }

  it("write sets needs_text; valid values resolve text and the status goes back to running", async () => {
    const { runs, run, p } = open();
    expect(run.status).toBe("needs_text");
    expect(run.pending).toMatchObject({ kind: "text", id: "t1", errors: null, attempts: 0 });
    expect(run.textRequests).toBe(1);
    runs.answerText(run.id, "t1", { values: { f1: "Tuesday works." } });
    await expect(p).resolves.toEqual({ kind: "text", values: { f1: "Tuesday works." } });
    expect(run.status).toBe("running");
    expect(run.pending).toBeNull();
  });

  it("errors keep needs_text and count attempts; at 3 attempts the text goes to the runner anyway", async () => {
    const { runs, run, replies, p } = open();
    runs.answerText(run.id, "t1", { values: { f1: " " } });
    expect(run.status).toBe("needs_text");
    expect(run.pending).toMatchObject({ errors: { f1: "text is required" }, attempts: 1 });
    runs.answerText(run.id, "t1", { values: { f1: "" } });
    expect(run.pending).toMatchObject({ attempts: 2 });
    await flush();
    expect(replies).toEqual([]);
    runs.answerText(run.id, "t1", { values: { f1: "" } });
    await expect(p).resolves.toEqual({ kind: "text", values: { f1: "" } });
    expect(run.status).toBe("running");
  });

  it("a value with the API key gets 'holds a secret value' and never reaches the runner", async () => {
    const { runs, run, p } = open();
    runs.answerText(run.id, "t1", { values: { f1: `my key is ${KEY}` } });
    expect(run.pending).toMatchObject({ errors: { f1: "holds a secret value" }, attempts: 1 });
    runs.answerText(run.id, "t1", { values: { f1: KEY } });
    runs.answerText(run.id, "t1", { values: { f1: `x${KEY}` } });
    const r = await p;
    expect(r.kind).toBe("declined");
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("a key split by format characters is found after the runner's normalization; a decline reason loses the key", async () => {
    const { runs, run, p } = open();
    const split = Array.from(KEY).join("\u00ad");
    runs.answerText(run.id, "t1", { values: { f1: `Here it is: ${split}` } });
    expect(run.pending).toMatchObject({ errors: { f1: "holds a secret value" }, attempts: 1 });
    runs.answerText(run.id, "t1", { values: { f1: `a ${Array.from(KEY).join("\u200d")}` } });
    expect(run.pending).toMatchObject({ errors: { f1: "holds a secret value" }, attempts: 2 });
    runs.answerText(run.id, "t1", { decline: `no: ${split}` });
    const r = await p;
    expect(r.kind).toBe("declined");
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(r)).not.toContain(split);
  });

  it("decline resolves declined with the reason", async () => {
    const { runs, run, p } = open();
    runs.answerText(run.id, "t1", { decline: "I do not know the time" });
    await expect(p).resolves.toEqual({ kind: "declined", reason: "I do not know the time" });
  });

  it("an answered request is a no-op; an id that was never issued is stale", async () => {
    const { runs, run, p } = open();
    expect(() => runs.answerText(run.id, "t2", { values: { f1: "x" } })).toThrow(StaleRequestError);
    runs.answerText(run.id, "t1", { values: { f1: "Tuesday works." } });
    await p;
    expect(runs.answerText(run.id, "t1", { values: { f1: "again" } })).toBe(run);
    expect(run.status).toBe("running");
  });

  it("no answer in timeoutMs resolves timeout", async () => {
    const { run, p } = open();
    await vi.advanceTimersByTimeAsync(LIMITS.textWaitMs);
    await expect(p).resolves.toEqual({ kind: "timeout" });
    expect(run.status).toBe("running");
  });
});

describe("RunManager: wait", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns at once for needs_text and for a finished run", async () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: false });
    void m.last().hooks.text.write(request(), { timeoutMs: 1000, check });
    await expect(runs.wait(run.id, 40_000)).resolves.toBe(run);
    runs.answerText(run.id, "t1", { values: { f1: "x" } });
    m.last().resolve(result("done"));
    await flush();
    await expect(runs.wait(run.id, 40_000)).resolves.toBe(run);
  });

  it("wakes on a status change", async () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: false });
    let woke = false;
    const w = runs.wait(run.id, 40_000).then(() => { woke = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(woke).toBe(false);
    void m.last().hooks.text.write(request(), { timeoutMs: 100_000, check });
    await w;
    expect(woke).toBe(true);
    expect(run.status).toBe("needs_text");
  });

  it("times out with the run unchanged, and returns on the signal", async () => {
    const { runs } = setup();
    const run = runs.start(input(), { interactive: false });
    const w = runs.wait(run.id, 2000);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(w).resolves.toBe(run);
    expect(run.status).toBe("running");
    const ac = new AbortController();
    const w2 = runs.wait(run.id, 40_000, ac.signal);
    ac.abort();
    await expect(w2).resolves.toBe(run);
  });
});

describe("RunManager: confirmations", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const action: ConfirmDetail = { kind: "action", action: 'click button "Send"', host: "mail.example", typed: [{ label: "Reply", text: "Tuesday works." }] };

  it("take once, then settle; wait returns at once only while the confirmation is unsent", async () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: true });
    const answer = m.last().hooks.human.confirm("About to click. Type y to allow: ", LIMITS.confirmPromptMs, action);
    expect(run.status).toBe("confirming");
    await expect(runs.wait(run.id, 40_000)).resolves.toBe(run);
    const taken = runs.takeConfirm(run.id);
    expect(taken?.confirm).toMatchObject({ kind: "confirm", detail: action, sent: true });
    expect(taken?.dialogMs).toBe(MCP.confirmDialogMs);
    expect(runs.takeConfirm(run.id)).toBeNull();
    let woke = false;
    const w = runs.wait(run.id, 40_000).then(() => { woke = true; });
    await vi.advanceTimersByTimeAsync(10);
    expect(woke).toBe(false);
    runs.settleConfirm(run.id, "c-other", false);
    runs.settleConfirm(run.id, taken?.confirm.id ?? "", true);
    await expect(answer).resolves.toBe(true);
    await w;
    expect(run.status).toBe("running");
  });

  it("a confirmation that no call picks up in 60 s is denied", async () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: true });
    const answer = m.last().hooks.human.confirm("q", LIMITS.confirmPromptMs, action);
    await vi.advanceTimersByTimeAsync(MCP.confirmPickupMs - 1);
    expect(run.status).toBe("confirming");
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toBe(false);
    expect(run.status).toBe("running");
    expect(runs.takeConfirm(run.id)).toBeNull();
  });

  it("a result after a dialog that no one answered does not say that the user declined", async () => {
    const declined = (desc: string): RunResult => result("blocked", { reason: `needs_confirmation: the user did not allow ${desc}`, blocked: { kind: "needs_confirmation", hint: `the user did not allow ${desc}`, top: [], resume: { session: "s", url: null } } });
    // No call picks the confirmation up.
    const a = setup();
    const r1 = a.runs.start(input(), { interactive: true });
    const answer = a.m.last().hooks.human.confirm("q", LIMITS.confirmPromptMs, action);
    await vi.advanceTimersByTimeAsync(MCP.confirmPickupMs);
    expect(await answer).toBe(false);
    expect(r1.confirmEnd).toBe("no_pickup");
    a.m.last().resolve(declined('click button "Send"'));
    await vi.advanceTimersByTimeAsync(0);
    expect(r1.result?.blocked?.hint).toBe('no dialog was shown in time, so Jev did not click button "Send". To ask the user again, call browse again, and call wait at once when the status is confirming');
    expect(r1.result?.reason).toBe(`needs_confirmation: ${r1.result?.blocked?.hint}`);
    // The dialog failed or got no answer in time.
    const b = setup();
    const r2 = b.runs.start(input(), { interactive: true });
    const second = b.m.last().hooks.human.confirm("q", LIMITS.confirmPromptMs, action);
    const taken = b.runs.takeConfirm(r2.id);
    b.runs.settleConfirm(r2.id, taken?.confirm.id ?? "", true, false);
    expect(await second).toBe(false);
    expect(r2.confirmEnd).toBe("no_answer");
    b.m.last().resolve(declined('click button "Send"'));
    await vi.advanceTimersByTimeAsync(0);
    expect(r2.result?.blocked?.hint).toMatch(/^the dialog got no answer in time, so Jev did not click button "Send"/);
    // A real no keeps the loop's hint.
    const c = setup();
    const r3 = c.runs.start(input(), { interactive: true });
    const third = c.m.last().hooks.human.confirm("q", LIMITS.confirmPromptMs, action);
    c.runs.settleConfirm(r3.id, c.runs.takeConfirm(r3.id)?.confirm.id ?? "", false);
    expect(await third).toBe(false);
    expect(r3.confirmEnd).toBe("denied");
    c.m.last().resolve(declined('click button "Send"'));
    await vi.advanceTimersByTimeAsync(0);
    expect(r3.result?.blocked?.hint).toBe('the user did not allow click button "Send"');
  });

  it("dialogMs is at most deadline - now", async () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: true });
    void m.last().hooks.human.confirm("q", 30_000, action);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(runs.takeConfirm(run.id)?.dialogMs).toBe(18_000);
  });

  it("a sent confirmation that nobody settles is denied after the dialog time", async () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: true });
    const answer = m.last().hooks.human.confirm("q", LIMITS.confirmPromptMs, action);
    const taken = runs.takeConfirm(run.id);
    await vi.advanceTimersByTimeAsync((taken?.dialogMs ?? 0) + 5_000);
    await expect(answer).resolves.toBe(false);
  });

  it("keeps the profile kind", () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: true });
    void m.last().hooks.human.confirm("Use Chrome profile BP (Profile 2)? [y/N] ", LIMITS.confirmPromptMs, { kind: "profile", name: "BP", directory: "Profile 2" });
    expect(run.pending).toMatchObject({ kind: "confirm", detail: { kind: "profile", name: "BP", directory: "Profile 2" } });
  });
});

describe("RunManager: pauses", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("resumes when the poll returns true; what comes from the kind", async () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: false });
    let polls = 0;
    const r = m.last().hooks.human.pause("(captcha): ...", 60_000, async () => { polls += 1; return polls >= 2; }, "captcha");
    expect(run.status).toBe("paused");
    expect(run.pending).toMatchObject({ kind: "pause", what: "captcha" });
    await vi.advanceTimersByTimeAsync(LIMITS.pausePollMs * 2);
    await expect(r).resolves.toBe("resumed");
    expect(polls).toBe(2);
    expect(run.status).toBe("running");
  });

  it("a poll that throws counts as not clear; the pause then times out; the kind defaults to sign_in", async () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: false });
    let polls = 0;
    const r = m.last().hooks.human.pause("(needs_sign_in): ...", 12_000, async () => { polls += 1; throw new Error("tab gone"); });
    expect(run.pending).toMatchObject({ what: "sign_in" });
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(r).resolves.toBe("timeout" satisfies PauseResult);
    expect(polls).toBe(2);
  });

  it("a cancel aborts the pause", async () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: false });
    const r = m.last().hooks.human.pause("p", 60_000, async () => false, "sign_in");
    const c = runs.cancel(run.id);
    await expect(r).resolves.toBe("aborted");
    m.last().resolve(result("blocked"));
    await c;
    expect(run.status).toBe("blocked");
  });
});

describe("RunManager: cancel and shutdown", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(["running", "needs_text", "confirming", "paused"] as const)("cancel while %s: abort, resolve the wait, stopping, then the runner's result", async (state) => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: true });
    const hooks = m.last().hooks;
    let waited: unknown = "none";
    if (state === "needs_text") void hooks.text.write(request(), { timeoutMs: 100_000, check }).then((r) => { waited = r; });
    if (state === "confirming") void hooks.human.confirm("q", 100_000).then((r) => { waited = r; });
    if (state === "paused") void hooks.human.pause("p", 100_000, async () => false).then((r) => { waited = r; });
    expect(run.status).toBe(state);
    const c = runs.cancel(run.id);
    expect(hooks.signal.aborted).toBe(true);
    expect(run.status).toBe("stopping");
    expect(runs.active()).toBe(run);
    await flush();
    expect(waited).toEqual({ running: "none", needs_text: { kind: "aborted" }, confirming: false, paused: "aborted" }[state]);
    // A write or confirm after the abort resolves at once.
    await expect(hooks.text.write(request("t2"), { timeoutMs: 1000, check })).resolves.toEqual({ kind: "aborted" });
    await expect(hooks.human.confirm("q", 1000)).resolves.toBe(false);
    m.last().resolve(result("blocked", { blocked: { kind: "human_aborted", hint: "the run was cancelled", top: [], resume: { session: "s", url: null } } }));
    await expect(c).resolves.toBe(run);
    expect(run.status).toBe("blocked");
    expect(runs.active()).toBeNull();
  });

  it("a runner that ignores the signal stays stopping; forceStop runs after 5 s; start is busy until it settles", async () => {
    let forced = 0;
    const t = setup({ forceStop: async () => { forced += 1; } });
    const run = t.runs.start(input("a"), { interactive: false });
    let cancelled = false;
    const c = t.runs.cancel(run.id).then(() => { cancelled = true; });
    expect(run.status).toBe("stopping");
    expect(() => t.runs.start(input("a"), { interactive: false })).toThrow(BusyError);
    expect(() => t.runs.start(input("b"), { interactive: false })).toThrow(BusyError);
    await vi.advanceTimersByTimeAsync(MCP.cancelWaitMs - 1);
    expect(forced).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(forced).toBe(1);
    expect(cancelled).toBe(false);
    t.m.last().resolve(result("failed", { error: { kind: "browser", message: "chrome closed" } }));
    await c;
    expect(run.status).toBe("failed");
    expect(() => t.runs.start(input("b"), { interactive: false })).not.toThrow();
  });

  it("a finished run returns from cancel as it is", async () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: false });
    m.last().resolve(result("done"));
    await flush();
    await expect(runs.cancel(run.id)).resolves.toBe(run);
    expect(run.status).toBe("done");
  });

  it("shutdown cancels the active run; later starts throw", async () => {
    const { runs, m } = setup();
    const run = runs.start(input(), { interactive: false });
    const s = runs.shutdown();
    expect(m.last().hooks.signal.aborted).toBe(true);
    m.last().resolve(result("blocked"));
    await s;
    expect(run.status).toBe("blocked");
    expect(() => runs.start(input("next"), { interactive: false })).toThrow(BusyError);
  });
});
