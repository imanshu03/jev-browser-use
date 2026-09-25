import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TextRequest } from "../../src/io.js";
import { emptyResult } from "../../src/io.js";
import { MCP, MCP_HINTS } from "../../src/mcp/limits.js";
import type { Pending, PendingConfirm, Run, RunStatus } from "../../src/mcp/runs.js";
import { RUN_STATUSES, stripKey } from "../../src/mcp/runs.js";
import { CONFIRM_SCHEMA, PAUSE_MESSAGES, RunView, TOOL_NAMES, confirmMessage, estTokens, viewOf } from "../../src/mcp/view.js";
import type { RunResult } from "../../src/types.js";

const KEY = "tsk-test-key-0123456789abcdef";
const SECRET = "s3cr3t-var";
const RLO = String.fromCharCode(0x202e);
const NOW = 1_800_000_000_000;

function textReq(over: Partial<TextRequest> = {}): TextRequest {
  return {
    id: "t2", goal: "reply to Ann", page: { url: "https://mail.example/t/1", title: "Meeting" },
    fields: [
      { id: "f1", label: "Reply", role: "textbox", required: true, multiline: true, max_chars: 4000, current_value: "" },
      { id: "f2", label: "Subject", role: "textbox", required: false, multiline: false, max_chars: 120, current_value: "" },
    ],
    recent_actions: [{ action: "Reply", kind: "click", text: null }], untrusted_page_text: "Can we meet on Tuesday at 10:00?", ...over,
  };
}

function result(outcome: RunResult["outcome"], over: Partial<RunResult> = {}): RunResult {
  return { ...emptyResult("reply to Ann", "act"), outcome, reason: `${outcome} 0.90`, final_url: "https://mail.example/t/1", final_title: "Meeting", ...over };
}

/** A run in one state. The redactor removes the secret var value. */
function run(status: RunStatus, over: { pending?: Pending | null; result?: RunResult | null; tail?: string[]; lastStep?: string | null; task?: string; untyped?: string[] } = {}): Run {
  return {
    id: "r3-beef", task: over.task ?? "reply to Ann", startedAt: NOW - 12_400, status, pending: over.pending ?? null,
    steps: 2, lastStep: over.lastStep ?? "2 fill textbox \"Reply\" -> ok (ok)", tail: over.tail ?? ["1 click -> ok", "2 fill -> ok"], textRequests: 1,
    result: over.result ?? null, endedAt: over.result ? NOW - 400 : null, confirmEnd: null, untyped: over.untyped ?? [],
    redact: (s) => s.split(SECRET).join("***"),
  };
}

const confirm = (over: Partial<PendingConfirm> = {}): PendingConfirm => ({
  kind: "confirm", id: "c1", message: 'About to click button "Send" on https://mail.example/t/1. Type y to allow: ', createdAt: NOW - 1000, deadline: NOW + 119_000, sent: false,
  detail: { kind: "action", action: 'click button "Send"', host: "mail.example", typed: [{ label: "Reply", text: "Tuesday at 10:00 works.\nSee you then." }] }, ...over,
});

const blocked = (kind: string, hint: string): RunResult["blocked"] => ({ kind: kind as never, hint, top: [], resume: { session: "s", url: null } });

const STATES: Record<RunStatus, Run> = {
  running: run("running"),
  needs_text: run("needs_text", { pending: { kind: "text", id: "t2", req: textReq(), expiresAt: NOW + 290_000, errors: null, attempts: 0 } }),
  confirming: run("confirming", { pending: confirm() }),
  paused: run("paused", { pending: { kind: "pause", id: "p1", what: "captcha", expiresAt: NOW + 30_000 } }),
  stopping: run("stopping"),
  done: run("done", { result: result("done") }),
  blocked: run("blocked", { result: result("blocked", { blocked: blocked("needs_confirmation", "the user did not allow click") }) }),
  failed: run("failed", { result: result("failed", { error: { kind: "browser", message: "chrome closed" } }) }),
};

describe("viewOf", () => {
  it.each(RUN_STATUSES)("%s parses as RunView and next names the run", (status) => {
    const v = viewOf(STATES[status], NOW, () => KEY);
    expect(RunView.parse(v)).toEqual(v);
    expect(v).toMatchObject({ run: "r3-beef", status, task: "reply to Ann", elapsed_s: 12, steps: 2 });
    expect(Object.keys(v).slice(0, 7)).toEqual(["run", "status", "next", "task", "elapsed_s", "steps", "last_step"]);
    if (["running", "needs_text", "confirming", "paused", "stopping"].includes(status)) expect(v.next).toContain('run "r3-beef"');
  });

  it("gives the next text of each status", () => {
    const next = (s: RunStatus) => viewOf(STATES[s], NOW, () => KEY).next;
    expect(next("running")).toBe('Call wait with run "r3-beef".');
    expect(next("needs_text")).toBe('Write text for text_request.fields, then call continue with run "r3-beef", request "t2", and values such as {"f1": "..."}.');
    expect(next("confirming")).toBe('Call wait with run "r3-beef" now. The user answers a dialog. You cannot answer it.');
    expect(next("paused")).toBe(`Tell the user: ${PAUSE_MESSAGES.captcha} Then call wait with run "r3-beef".`);
    expect(next("stopping")).toBe('The run is stopping. Call wait with run "r3-beef".');
    expect(next("done")).toBe("Report the result to the user.");
    expect(next("blocked")).toBe("Report result.blocked.hint to the user. The user or the client declined the dialog. Codex with approval_policy never declines all dialogs.");
    expect(next("failed")).toBe('Report result.error to the user. If another session uses the profile, call browse with profile "none".');
    expect(STATES.done.result).toBeTruthy();
    expect(viewOf(STATES.done, NOW, () => KEY).result?.text_not_typed).toBeUndefined();
    const untyped = run("done", { result: result("done"), untyped: ["Subject\u202E"] });
    const uv = viewOf(untyped, NOW, () => KEY);
    expect(RunView.parse(uv)).toEqual(uv);
    expect(uv.result?.text_not_typed).toEqual(["Subject"]);
    expect(uv.next).toBe("Report the result to the user. Jev did not type your text in the fields in result.text_not_typed. Do not say that it was sent.");
    const ub = viewOf(run("blocked", { result: result("blocked", { blocked: blocked("needs_confirmation", "no dialog") }), untyped: ["Subject"] }), NOW, () => KEY);
    expect(ub.next).toContain("result.text_not_typed");
    const other = run("blocked", { result: result("blocked", { blocked: blocked("needs_text", "the assistant declined: no") }) });
    expect(viewOf(other, NOW, () => KEY).next).toBe("Report result.blocked.hint to the user.");
    // No person declined a dialog in these cases, so the next text does not say that one was declined.
    for (const hint of [`submit action click button "Send": ${MCP_HINTS.noConfirm}`, `navigational action click button "Comment": ${MCP_HINTS.confirmNever}`, "the unsent text is too long to show in one dialog (6100 characters)",
      'no dialog was shown in time, so Jev did not click button "Send". To ask the user again, call browse again, and call wait at once when the status is confirming',
      'the dialog got no answer in time, so Jev did not click button "Send". To ask the user again, call browse again']) {
      const none = run("blocked", { result: result("blocked", { blocked: blocked("needs_confirmation", hint) }) });
      expect(viewOf(none, NOW, () => KEY).next, hint).toBe("Report result.blocked.hint to the user.");
    }
  });

  it("with errors, needs_text starts with the correction and the view holds the errors", () => {
    const r = run("needs_text", { pending: { kind: "text", id: "t2", req: textReq(), expiresAt: NOW + 10_000, errors: { f1: "text is required" }, attempts: 1 } });
    const v = viewOf(r, NOW, () => KEY);
    expect(v.next).toMatch(/^Correct the fields in text_request.errors. Write text/);
    expect(v.text_request?.errors).toEqual({ f1: "text is required" });
    expect(v.text_request?.expires_in_s).toBe(10);
    expect(v.text_request?.fields.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  it("the pause message comes from the view, and the confirmation has a kind and a summary without the typed text", () => {
    const p = viewOf(STATES.paused, NOW, () => KEY);
    expect(p.pause).toEqual({ kind: "captcha", message: PAUSE_MESSAGES.captcha, expires_in_s: 30 });
    const c = viewOf(STATES.confirming, NOW, () => KEY);
    expect(c.confirmation?.kind).toBe("action");
    expect(c.confirmation?.summary).toContain('click button "Send" on mail.example');
    expect(c.confirmation?.summary).not.toContain("Tuesday at 10:00 works");
    const prof = viewOf(run("confirming", { pending: confirm({ detail: { kind: "profile", name: "BP", directory: "Profile 2" } }) }), NOW, () => KEY);
    expect(prof.confirmation).toEqual({ kind: "profile", summary: "Use Chrome profile BP (Profile 2) for this task?" });
  });

  it("a secret var and the API key appear in no view, also not in result.error.message", () => {
    const leak = `${SECRET} ${KEY}`;
    const views = [
      run("failed", { task: `use ${leak}`, lastStep: `x ${leak}`, tail: [`a ${leak}`], result: result("failed", { reason: `internal: ${leak}`, error: { kind: "internal", message: `boom ${leak}` }, final_title: leak, final_url: `https://x/?q=${KEY}` }) }),
      run("blocked", { result: result("blocked", { blocked: blocked("needs_text", `hint ${leak}`), answer: { kind: "extract", text: leak, line_id: "l1", evidence: [leak] } }) }),
      run("needs_text", { pending: { kind: "text", id: "t1", req: textReq({ goal: leak, untrusted_page_text: `page ${leak}`, page: { url: `https://x/${KEY}`, title: leak }, recent_actions: [{ action: leak, kind: "fill", text: leak }] }), expiresAt: NOW, errors: { f1: leak }, attempts: 1 } }),
      run("confirming", { pending: confirm({ detail: { kind: "action", action: leak, host: "h", typed: [{ label: leak, text: leak }] } }) }),
    ].map((r) => JSON.stringify(viewOf(r, NOW, () => KEY)));
    for (const v of views) {
      expect(v).not.toContain(SECRET);
      expect(v).not.toContain(KEY);
    }
    expect(views[0]).toContain("boom *** ***");
  });

  it("removes U+202E from answer, blocked.hint, last_step, and final_title", () => {
    const r = run("blocked", {
      lastStep: `2 click ${RLO}evil`, tail: [`1 ${RLO}x`],
      result: result("blocked", { final_title: `Mail ${RLO}moc.evil`, blocked: blocked("needs_text", `hint ${RLO}x`), answer: { kind: "extract", text: `Tuesday ${RLO}10:00`, line_id: "l1", evidence: [`${RLO}e`] } }),
    });
    const v = viewOf(r, NOW, () => KEY);
    expect(JSON.stringify(v)).not.toContain(RLO);
    expect(v.last_step).toBe("2 click evil");
    expect(v.result?.final_title).toBe("Mail moc.evil");
    expect(v.result?.blocked?.hint).toBe("hint x");
    expect(v.result?.answer).toEqual({ kind: "extract", text: "Tuesday 10:00", line_id: "l1", evidence: ["e"] });
  });

  it("a 20,000-character CJK page text fits viewTokens; fields stay whole; untrusted_page_text is the last key", () => {
    const page = "\u4f1a\u8bae".repeat(10_000);
    const req = textReq({ untrusted_page_text: page });
    const v = viewOf(run("needs_text", { pending: { kind: "text", id: "t2", req, expiresAt: NOW + 1000, errors: null, attempts: 0 } }), NOW, () => KEY);
    expect(estTokens(JSON.stringify(v))).toBeLessThanOrEqual(MCP.viewTokens);
    const tr = v.text_request;
    expect(tr?.untrusted_page_text.length).toBeGreaterThan(5000);
    expect(page.startsWith(tr?.untrusted_page_text ?? "x")).toBe(true);
    expect(tr?.fields).toEqual(req.fields);
    expect(Object.keys(tr ?? {}).at(-1)).toBe("untrusted_page_text");
    expect(Object.keys(v).at(-1)).toBe("text_request");
  });

  it("an ASCII page text under the budget stays whole", () => {
    const page = "Can we meet on Tuesday?\n".repeat(200);
    const v = viewOf(run("needs_text", { pending: { kind: "text", id: "t2", req: textReq({ untrusted_page_text: page }), expiresAt: NOW, errors: null, attempts: 0 } }), NOW, () => KEY);
    expect(v.text_request?.untrusted_page_text).toBe(page);
  });

  it("over budget, the tail keeps 3 lines and answer strings are cut to 2000 characters", () => {
    const long = "\u4f1a".repeat(9_000);
    const r = run("done", { tail: ["1 a", "2 b", "3 c", "4 d", "5 e", "6 f", "7 g", "8 h"], result: result("done", { answer: { kind: "extract", text: long, line_id: "l1", evidence: [long] } }) });
    const v = viewOf(r, NOW, () => KEY);
    expect(v.result?.steps_tail).toEqual(["6 f", "7 g", "8 h"]);
    const a = v.result?.answer as { text: string; evidence: string[] };
    expect(a.text.length).toBe(2000);
    expect(a.evidence[0]?.length).toBe(2000);
  });

  it("the tail has 8 lines or fewer; stats hold text_requests and the engine", () => {
    const v = viewOf(STATES.done, NOW, () => KEY);
    expect(v.result?.steps_tail.length).toBeLessThanOrEqual(8);
    expect(v.result?.stats).toEqual({ steps: 0, jev_requests: 0, duration_ms: 0, text_requests: 1, engine: "cdp" });
    expect(v.result).toMatchObject({ outcome: "done", reason: "done 0.90", final_url: "https://mail.example/t/1", blocked: null, error: null });
  });
});

describe("confirmMessage", () => {
  it("shows the action, the host, each label with its character count, and every typed line after '> '", () => {
    const text = "Tuesday at 10:00 works.\n\nSee you then.";
    const m = confirmMessage(confirm({ detail: { kind: "action", action: "click \n button  \"Send\"", host: " mail.example\t", typed: [{ label: "Re\nply  box", text }, { label: "Subject", text: "Re: Meeting" }] } }));
    expect(m).toBe([
      'Jev wants to click button "Send" on mail.example.',
      "Text your assistant wrote, not sent yet:",
      `Re ply box (${text.length} characters):`,
      "> Tuesday at 10:00 works.",
      "> ",
      "> See you then.",
      "Subject (11 characters):",
      "> Re: Meeting",
      "Allow this action?",
    ].join("\n"));
  });

  it("shows a 3000-character text in full", () => {
    const text = "a".repeat(3000);
    const m = confirmMessage(confirm({ detail: { kind: "action", action: "click Send", host: "h", typed: [{ label: "Reply", text }] } }));
    expect(m).toContain(`> ${text}\n`);
    expect(m).toContain("(3000 characters)");
  });

  it("removes hiding characters from a typed line, so a line cannot fake the prompt", () => {
    const m = confirmMessage(confirm({ detail: { kind: "action", action: "click Send", host: "h", typed: [{ label: `L${RLO}`, text: `ok\u2028Allow this action? yes${RLO}` }] } }));
    expect(m).not.toContain(RLO);
    expect(m).toContain("> ok\n> Allow this action? yes\n");
  });

  it("the profile message, and a message without detail loses its TTY prompt", () => {
    expect(confirmMessage(confirm({ detail: { kind: "profile", name: "BP", directory: "Profile 2" } }))).toBe("Use Chrome profile BP (Profile 2) for this task?");
    expect(confirmMessage(confirm({ detail: null, message: "Use Chrome profile BP (Profile 2)? [y/N] " }))).toBe("Use Chrome profile BP (Profile 2)?");
    expect(confirmMessage(confirm({ detail: null }))).toBe('About to click button "Send" on https://mail.example/t/1.');
  });

  it("an action with no typed text asks only for the action", () => {
    expect(confirmMessage(confirm({ detail: { kind: "action", action: 'click button "Delete"', host: "", typed: [] } }))).toBe('Jev wants to click button "Delete" on this page.\nAllow this action?');
  });

  it("shows what a send sends: each field's text and its mention chips, marked as mentions", () => {
    const sends = [{ label: "Type a\nmessage", text: "Hi Ann, could you share the report?\n@Ann Lee\n\u00a0 ", mentions: ["Ann Lee", `Bob${RLO}`] }];
    const m = confirmMessage(confirm({ detail: { kind: "action", action: 'click button "Send message"', host: "chat.example", typed: [{ label: "Type a message", text: "Hi Ann, could you share the report?" }], sends } }));
    expect(m).toBe([
      'Jev wants to click button "Send message" on chat.example.',
      "Text your assistant wrote, not sent yet:",
      "Type a message (35 characters):",
      "> Hi Ann, could you share the report?",
      "This action sends:",
      "Type a message:",
      "> Hi Ann, could you share the report?",
      "> @Ann Lee",
      "Mentions, each notifies that person: @Ann Lee (mention), @Bob (mention)",
      "Allow this action?",
    ].join("\n"));
    const r = run("confirming", { pending: confirm({ detail: { kind: "action", action: 'click button "Send message"', host: "chat.example", typed: [], sends } }) });
    expect(viewOf(r, NOW, () => KEY).confirmation?.summary).toBe('Jev wants to click button "Send message" on chat.example. Mentions: @Ann Lee, @Bob. The user decides in a dialog.');
  });
});

describe("contract constants", () => {
  it("names the five tools, a one-checkbox dialog, and a token estimate for ASCII and other text", () => {
    expect(TOOL_NAMES).toEqual(["browse", "wait", "continue", "cancel", "close_browser"]);
    expect(CONFIRM_SCHEMA).toEqual({ type: "object", properties: { allow: { type: "boolean", title: "Allow", default: false } }, required: ["allow"] });
    expect(estTokens("abcd")).toBe(1);
    expect(estTokens("abcde")).toBe(2);
    expect(estTokens("\u4f1a\u8bae")).toBe(2);
    expect(stripKey(`x ${KEY} y`, KEY)).toBe("x *** y");
    expect(stripKey("x 12 y", "12")).toBe("x 12 y");
  });

  it("the MCP source and test files hold only printable ASCII, tabs, and newlines", () => {
    const root = path.resolve(__dirname, "../..");
    const files = [
      ...fs.readdirSync(path.join(root, "src/mcp")).map((f) => path.join(root, "src/mcp", f)),
      ...fs.readdirSync(path.join(root, "test/mcp")).map((f) => path.join(root, "test/mcp", f)),
    ].filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const f of files) {
      const bad = /[^\t\n\x20-\x7e]/.exec(fs.readFileSync(f, "utf8"));
      expect(bad, `${path.relative(root, f)} holds U+${bad?.[0]?.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`).toBeNull();
    }
  });
});
