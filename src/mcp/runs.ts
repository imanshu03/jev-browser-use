// Run bookkeeping for the MCP server. One run at a time, its open hand-off (text, confirmation, or pause),
// cancel, and the last finished runs. No SDK imports: the runner reaches this file only through the
// TextSource, Human, and Logger it gets, and the tool handlers reach it through RunManager.
//
// The model never approves one action here. A confirmation settles only through settleConfirm, which the server
// calls with the answer of a dialog that the client showed to the user. A run is autonomous only when its browse call
// says so with the user's own words (user_said). The loop then asks no one, and the step record of each action that
// ran with no dialog holds its audit.
import { randomBytes } from "node:crypto";
import { flatText, sanitizeText } from "../fast/generate.js";
import { cutText } from "../fast/policy.js";
import type { ConfirmDetail, Human, Logger, PauseKind, PauseResult, RunnerHints, TextReply, TextRequest, TextSource, TextWriteOptions } from "../io.js";
import { emptyResult } from "../io.js";
import type { Goal, RunResult, StepRecord } from "../types.js";
import { LIMITS } from "../types.js";
import { MCP, MCP_HINTS } from "./limits.js";

export const RUN_STATUSES = ["running", "needs_text", "confirming", "paused", "stopping", "done", "blocked", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface BrowseInput {
  task: string; url?: string; profile?: string; headed: boolean; engine?: "cdp" | "chromium";
  goal?: Goal; vars?: Record<string, string>; max_steps?: number; confirm: "auto" | "always" | "never" | "autonomous"; dry_run: boolean;
  /** With confirm "autonomous" only: the words of the user's own message that turn the mode on. */
  user_said?: string;
}
export interface RunHooks {
  text: TextSource; human: Human; signal: AbortSignal; log: Logger; hints: RunnerHints;
  /**
   * A person can answer in this session. An autonomous run's Human is never interactive, so the runner reads this for a
   * sign-in wall. Absent: `human.interactive`.
   */
  attended?: boolean;
  /** The starter reports the fields whose assistant text no fill typed. */
  untyped?: (labels: string[]) => void;
}
export type RunStarter = (input: BrowseInput, hooks: RunHooks) => Promise<RunResult>;
export interface PendingText { kind: "text"; id: string; req: TextRequest; expiresAt: number; errors: Record<string, string> | null; attempts: number }
export interface PendingConfirm { kind: "confirm"; id: string; message: string; detail: ConfirmDetail | null; createdAt: number; deadline: number; sent: boolean }
export interface PendingPause { kind: "pause"; id: string; what: PauseKind; expiresAt: number }
export type Pending = PendingText | PendingConfirm | PendingPause;

/**
 * How the last confirmation of a run ended. `denied`: the user or the client answered no. `no_pickup`: no tool
 * call opened a dialog in time. `no_answer`: the dialog failed or got no answer in time. `cancelled`: a cancel.
 */
export type ConfirmEnd = "allowed" | "denied" | "no_pickup" | "no_answer" | "cancelled";

/**
 * An autonomous run: the user's words, the number of step records with an audit so far, and the first step after which
 * an audited text left the page.
 */
export interface RunAutonomy { readonly userSaid: string; unattended: number; sentAt: number | null }

export interface Run {
  readonly id: string;            // `r${n}-${4 hex}`
  readonly task: string; readonly startedAt: number;
  status: RunStatus; pending: Pending | null;
  steps: number; lastStep: string | null; tail: string[]; textRequests: number;
  result: RunResult | null; endedAt: number | null;
  confirmEnd: ConfirmEnd | null;  // the last confirmation; null before the first one
  untyped: string[];              // labels of fields whose assistant text no fill typed
  autonomous?: RunAutonomy | null; // set for confirm "autonomous"
  redact(s: string): string;      // the runner's redactor, via the per-run logger, plus the API key removal
}

export class BusyError extends Error { override name = "BusyError"; }
export class UnknownRunError extends Error { override name = "UnknownRunError"; }
export class StaleRequestError extends Error { override name = "StaleRequestError"; }

export interface RunManagerDeps {
  start: RunStarter; log: Logger;
  precheck?: () => void;                 // throws NoKeyError
  forceStop?: () => Promise<void>;       // main wires session.close()
  secret?: () => string | null;          // the API key
  now?: () => number;
}

/** Replace every copy of `key` in `s` with "***". A missing key, or one shorter than LIMITS.secretMinChars, changes nothing. */
export function stripKey(s: string, key: string | null | undefined): string {
  return key && key.length >= LIMITS.secretMinChars ? s.split(key).join("***") : s;
}

/**
 * True when `s` holds the key as sent, or after the runner's normalization: line breaks become "\n" and
 * sanitizeText removes format characters. A soft hyphen or a zero-width space between the key's characters
 * therefore does not hide it. sanitizeText keeps a joiner between two visible characters, so the key is also
 * looked for with every format character removed.
 */
export function holdsKey(s: string, key: string | null | undefined): boolean {
  const has = (v: string): boolean => stripKey(v, key) !== v;
  return has(s) || has(sanitizeText(s.replace(/\r\n?/g, "\n"))) || has(s.replace(/\p{Cf}/gu, ""));
}

/** The loop's needs_confirmation hint after a dialog that got the answer no. */
export const DECLINED_HINT = /^the user did not allow /;

/** Extra time after a dialog ends. The tool handler settles the confirmation in it; after it, the confirmation is denied. */
const DIALOG_GRACE_MS = 5_000;

/** The open hand-off and the function that settles it one time. */
type Opened =
  | { kind: "text"; finish: (r: TextReply) => void }
  | { kind: "confirm"; finish: (ok: boolean, end: ConfirmEnd) => void; timers: ReturnType<typeof setTimeout>[] }
  | { kind: "pause"; finish: (r: PauseResult) => void };

class RunState implements Run {
  status: RunStatus = "running";
  pending: Pending | null = null;
  steps = 0;
  lastStep: string | null = null;
  tail: string[] = [];
  textRequests = 0;
  result: RunResult | null = null;
  endedAt: number | null = null;
  confirmEnd: ConfirmEnd | null = null;
  untyped: string[] = [];
  autonomous: RunAutonomy | null = null;
  confirm: BrowseInput["confirm"] = "auto";
  /** The runner's redactor followed by the key removal. The per-run logger replaces it. */
  redactor: (s: string) => string;
  readonly controller = new AbortController();
  /** Settles when the starter settled and the result is recorded. Never rejects. */
  promise: Promise<void> = Promise.resolve();
  opened: Opened | null = null;
  /** The check of the open text request. */
  check: ((values: Record<string, string>) => Record<string, string>) | null = null;
  readonly issued = new Set<string>();
  readonly answered = new Set<string>();
  readonly listeners = new Set<() => void>();
  cancelling: Promise<Run> | null = null;
  seq = 0;

  constructor(readonly id: string, readonly task: string, readonly startedAt: number, redactor: (s: string) => string) {
    this.redactor = redactor;
  }

  redact(s: string): string { return this.redactor(s); }
  get finished(): boolean { return this.result !== null; }
}

/** True when a wait must return at once: the model has something to do, or the run ended. */
function ready(run: Run): boolean {
  if (run.status === "needs_text" || run.status === "done" || run.status === "blocked" || run.status === "failed") return true;
  return run.status === "confirming" && run.pending?.kind === "confirm" && !run.pending.sent;
}

/** Resolve when `p` settles or after `ms`. The timer is cleared when `p` settles first. */
function within(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void p.then(() => undefined, () => undefined).then(() => { clearTimeout(timer); resolve(); });
  });
}

/** One short line for a step record: `3 click button "Send" -> ok (confirmed)`. Redacts before each cut, so a cut secret cannot stay. */
function stepLine(rec: StepRecord, redact: (s: string) => string): string {
  const target = rec.target ? ` ${rec.target.role} "${redact(rec.target.name)}"` : "";
  const value = rec.value !== null ? ` "${cutText(redact(rec.value), 60)}"` : "";
  const gate = rec.gate ? ` (${rec.gate})` : "";
  const error = rec.error ? `: ${rec.error}` : "";
  return cutText(`${rec.step} ${rec.action}${target}${value} -> ${rec.result}${gate}${error}`, 300);
}

/**
 * The loop says "the user did not allow <action>" for every false answer. When no person answered the dialog,
 * the result says that instead, so the assistant does not report a decline that did not happen.
 */
function unseen(r: RunResult, end: ConfirmEnd | null): RunResult {
  const b = r.blocked;
  if ((end !== "no_pickup" && end !== "no_answer") || b?.kind !== "needs_confirmation" || !DECLINED_HINT.test(b.hint)) return r;
  const action = b.hint.replace(DECLINED_HINT, "");
  const hint = end === "no_pickup"
    ? `no dialog was shown in time, so Jev did not ${action}. To ask the user again, call browse again, and call wait at once when the status is confirming`
    : `the dialog got no answer in time, so Jev did not ${action}. To ask the user again, call browse again`;
  return { ...r, reason: `needs_confirmation: ${hint}`, blocked: { ...b, hint } };
}

export class RunManager {
  private readonly deps: RunManagerDeps;
  private readonly log: Logger;
  private readonly now: () => number;
  /** The active run and the finished runs, in start order. */
  private readonly runs = new Map<string, RunState>();
  private current: RunState | null = null;
  private count = 0;
  private lastEnded: number | null = null;
  private closed = false;

  constructor(deps: RunManagerDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.now = deps.now ?? (() => Date.now());
  }

  private secret(): string | null {
    return this.deps.secret?.() ?? null;
  }

  /**
   * Start a run. The same task while a run is active gives that run. Another task, or the same task with another confirm
   * value, gives BusyError: no call turns autonomous mode on or off in the middle of a run.
   */
  start(input: BrowseInput, opts: { interactive: boolean }): Run {
    if (this.closed) throw new BusyError("the server is shutting down");
    this.deps.precheck?.();
    const active = this.current;
    if (active) {
      if (active.status !== "stopping" && active.task === input.task) {
        if (active.confirm === input.confirm) return active;
        throw new BusyError(`run ${active.id} is active with confirm "${active.confirm}". Call wait with run "${active.id}", or call cancel.`);
      }
      throw new BusyError(`run ${active.id} is active. Call wait with run "${active.id}", or call cancel.`);
    }
    const run = new RunState(`r${++this.count}-${randomBytes(2).toString("hex")}`, input.task, this.now(), (s) => stripKey(s, this.secret()));
    run.confirm = input.confirm;
    if (input.confirm === "autonomous") run.autonomous = { userSaid: input.user_said ?? "", unattended: 0, sentAt: null };
    this.runs.set(run.id, run);
    this.current = run;
    let p: Promise<RunResult>;
    try { p = this.deps.start(input, this.hooks(run, opts.interactive)); } catch (e) { p = Promise.reject(e); }
    run.promise = p.then((r) => this.finish(run, r), (e: unknown) => this.finish(run, this.failed(run, input, e)));
    const mode = run.autonomous ? ` (autonomous: no dialogs; the user said "${cutText(flatText(run.redact(run.autonomous.userSaid)), 300)}")` : opts.interactive ? "" : " (no dialogs)";
    this.log.info(`run ${run.id} started${mode}`);
    return run;
  }

  get(id: string): Run {
    const run = this.runs.get(id);
    if (!run) throw new UnknownRunError(`no run "${id}". The server may have restarted. Call browse.`);
    return run;
  }

  /** The running run, also while it is stopping. */
  active(): Run | null {
    return this.current;
  }

  /** Wait for the next status or pending change, `ms`, or `signal`. Returns at once when the model has something to do. */
  wait(id: string, ms: number, signal?: AbortSignal): Promise<Run> {
    const run = this.state(id);
    if (ready(run) || ms <= 0 || signal?.aborted) return Promise.resolve(run);
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        run.listeners.delete(done);
        signal?.removeEventListener("abort", done);
        resolve(run);
      };
      const timer = setTimeout(done, ms);
      run.listeners.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * Answer the open text request. Values go through the runner's check and the key screen. A request that
   * was answered before is a no-op; an id that this run never issued throws StaleRequestError.
   */
  answerText(id: string, request: string, a: { values: Record<string, string> } | { decline: string }): Run {
    const run = this.state(id);
    const p = run.pending;
    const o = run.opened;
    if (!p || p.kind !== "text" || p.id !== request || !o || o.kind !== "text") {
      if (run.answered.has(request)) return run;
      throw new StaleRequestError(`request "${request}" is not open in run "${id}". Call wait with run "${id}" to see the current request.`);
    }
    if ("decline" in a) {
      // The reason goes into the block hint. The key never goes there, also when format characters split it.
      const key = this.secret();
      o.finish({ kind: "declined", reason: holdsKey(a.decline, key) ? stripKey(sanitizeText(stripKey(a.decline, key)), key) : a.decline });
      return run;
    }
    const errors: Record<string, string> = { ...(run.check ? run.check(a.values) : {}) };
    const key = this.secret();
    const keyed: string[] = [];
    for (const [field, value] of Object.entries(a.values)) {
      if (holdsKey(value, key)) { errors[field] = "holds a secret value"; keyed.push(field); }
    }
    if (Object.keys(errors).length === 0) { o.finish({ kind: "text", values: a.values }); return run; }
    p.errors = errors;
    p.attempts += 1;
    if (p.attempts < MCP.textAttempts) { this.changed(run); return run; }
    // The runner checks the text again and blocks. It cannot see the API key, so text with the key never goes to it.
    if (keyed.length > 0) o.finish({ kind: "declined", reason: `the text was rejected ${p.attempts} times: ${keyed.join(", ")} holds a secret value` });
    else o.finish({ kind: "text", values: a.values });
    return run;
  }

  /** Take the unsent confirmation for a dialog. Marks it sent. `dialogMs` never goes past the runner's deadline. */
  takeConfirm(id: string): { confirm: PendingConfirm; dialogMs: number } | null {
    const run = this.state(id);
    const p = run.pending;
    const o = run.opened;
    if (!p || p.kind !== "confirm" || p.sent || !o || o.kind !== "confirm") return null;
    const dialogMs = Math.min(MCP.confirmDialogMs, p.deadline - this.now());
    if (dialogMs <= 0) { o.finish(false, "no_pickup"); return null; }
    p.sent = true;
    o.timers.push(setTimeout(() => o.finish(false, "no_answer"), dialogMs + DIALOG_GRACE_MS));
    return { confirm: p, dialogMs };
  }

  /**
   * The answer of the dialog. Only the server calls this, with what the client returned. `answered` is false when
   * the dialog failed or timed out: the action is then not allowed, and the result does not say that the user said no.
   */
  settleConfirm(id: string, confirmId: string, allowed: boolean, answered = true): void {
    const run = this.state(id);
    const o = run.opened;
    if (run.pending?.kind === "confirm" && run.pending.id === confirmId && o?.kind === "confirm") o.finish(allowed && answered, allowed && answered ? "allowed" : answered ? "denied" : "no_answer");
  }

  /** Stop a run. It stays `stopping` until the runner settles; after cancelWaitMs the browser is closed. */
  cancel(id: string): Promise<Run> {
    const run = this.state(id);
    if (run.finished) return Promise.resolve(run);
    if (run.cancelling) return run.cancelling;
    run.cancelling = (async () => {
      run.controller.abort();
      this.abortOpened(run);
      if (!run.finished) { run.status = "stopping"; this.changed(run); }
      await within(run.promise, MCP.cancelWaitMs);
      if (!run.finished && this.deps.forceStop) {
        this.log.warn(`run ${run.id} did not stop in ${MCP.cancelWaitMs} ms; closing the browser`);
        await this.deps.forceStop().catch(() => undefined);
        await within(run.promise, MCP.cancelWaitMs);
      }
      return run;
    })();
    return run.cancelling;
  }

  /** null before the first run ends. */
  lastRunEndedAt(): number | null {
    return this.lastEnded;
  }

  /** Cancel the active run, as cancel does. Later starts throw. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const run = this.current;
    if (run) await this.cancel(run.id);
  }

  private state(id: string): RunState {
    return this.get(id) as RunState;
  }

  private changed(run: RunState): void {
    for (const l of [...run.listeners]) l();
  }

  /**
   * An autonomous run gets a Human that is never interactive and never opens a dialog: the plan then takes the workspace
   * default profile, as a run without dialogs does. `attended` still tells the runner if a person can sign in.
   */
  private hooks(run: RunState, interactive: boolean): RunHooks {
    const text: TextSource = { write: (req, opts) => this.write(run, req, opts) };
    const autonomous = run.autonomous !== null;
    const human: Human = {
      interactive: interactive && !autonomous,
      pause: (_message, timeoutMs, poll, kind) => this.pause(run, timeoutMs, poll, kind),
      confirm: autonomous ? async () => false : (message, timeoutMs, detail) => this.confirm(run, message, timeoutMs, detail),
    };
    return { text, human, signal: run.controller.signal, log: this.runLogger(run), hints: MCP_HINTS, attended: interactive, untyped: (labels) => { run.untyped = [...labels]; } };
  }

  /**
   * The logger the runner gets. Setting its redactor also sets the stderr logger's redactor, both with the key
   * removal. Each step record updates the run's step count, last step, and tail.
   */
  private runLogger(run: RunState): Logger {
    const base = this.log;
    const self = this;
    return {
      get redactor(): (s: string) => string { return run.redactor; },
      set redactor(r: (s: string) => string) {
        run.redactor = (s) => stripKey(r(s), self.secret());
        base.redactor = run.redactor;
      },
      info: (msg) => base.info(msg),
      warn: (msg) => base.warn(msg),
      debug: (msg, data) => base.debug(msg, data),
      step: (rec) => {
        run.steps += 1;
        const a = run.autonomous;
        if (rec.unattended && a) {
          a.unattended += 1;
          if (a.sentAt === null && rec.unattended.texts.some((t) => t.left === true)) a.sentAt = rec.step;
        }
        const line = flatText(run.redact(stepLine(rec, (s) => run.redact(s))));
        run.lastStep = line;
        run.tail.push(line);
        if (run.tail.length > MCP.viewSteps) run.tail.splice(0, run.tail.length - MCP.viewSteps);
        base.step(rec);
      },
    };
  }

  /** Open one hand-off. Its finish runs once: it clears the timers and the pending entry, and sets the status back to running. */
  private open<T>(run: RunState, pending: Pending, status: RunStatus, resolve: (v: T) => void): { finish: (v: T) => void; timers: ReturnType<typeof setTimeout>[]; done: () => boolean } {
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (v: T): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      if (run.pending === pending) { run.pending = null; run.opened = null; }
      if (run.status === status) run.status = "running";
      resolve(v);
      this.changed(run);
    };
    run.pending = pending;
    run.status = status;
    return { finish, timers, done: () => settled };
  }

  private write(run: RunState, req: TextRequest, opts: TextWriteOptions): Promise<TextReply> {
    return new Promise((resolve) => {
      if (run.controller.signal.aborted || run.finished) { resolve({ kind: "aborted" }); return; }
      const pending: PendingText = { kind: "text", id: req.id, req, expiresAt: this.now() + opts.timeoutMs, errors: null, attempts: 0 };
      run.issued.add(req.id);
      run.textRequests += 1;
      run.check = opts.check;
      const h = this.open<TextReply>(run, pending, "needs_text", (r) => { run.answered.add(req.id); resolve(r); });
      run.opened = { kind: "text", finish: h.finish };
      h.timers.push(setTimeout(() => h.finish({ kind: "timeout" }), opts.timeoutMs));
      this.changed(run);
    });
  }

  private confirm(run: RunState, message: string, timeoutMs: number, detail: ConfirmDetail | undefined): Promise<boolean> {
    return new Promise((resolve) => {
      if (run.controller.signal.aborted || run.finished) { resolve(false); return; }
      const createdAt = this.now();
      const pending: PendingConfirm = { kind: "confirm", id: `c${++run.seq}`, message, detail: detail ?? null, createdAt, deadline: createdAt + timeoutMs, sent: false };
      const h = this.open<boolean>(run, pending, "confirming", resolve);
      run.confirmEnd = null;
      const finish = (ok: boolean, end: ConfirmEnd): void => {
        if (h.done()) return;
        run.confirmEnd = end;
        if (end === "no_pickup" || end === "no_answer") this.log.warn(`run ${run.id} confirmation ${pending.id}: ${end === "no_pickup" ? "no call opened the dialog in time" : "the dialog got no answer in time"}`);
        h.finish(ok);
      };
      run.opened = { kind: "confirm", finish, timers: h.timers };
      // No call opened a dialog in time: the user never saw the question, so the action is not allowed.
      h.timers.push(setTimeout(() => { if (!pending.sent) finish(false, "no_pickup"); }, Math.max(0, Math.min(MCP.confirmPickupMs, timeoutMs))));
      this.changed(run);
    });
  }

  private pause(run: RunState, timeoutMs: number, poll: (() => Promise<boolean>) | undefined, kind: PauseKind | undefined): Promise<PauseResult> {
    return new Promise((resolve) => {
      if (run.controller.signal.aborted || run.finished) { resolve("aborted"); return; }
      const pending: PendingPause = { kind: "pause", id: `p${++run.seq}`, what: kind ?? "sign_in", expiresAt: this.now() + timeoutMs };
      const h = this.open<PauseResult>(run, pending, "paused", resolve);
      run.opened = { kind: "pause", finish: h.finish };
      h.timers.push(setTimeout(() => h.finish("timeout"), timeoutMs));
      // A poll that throws counts as "not clear yet".
      const tick = (): void => {
        h.timers.push(setTimeout(() => {
          if (h.done()) return;
          void Promise.resolve().then(() => (poll ? poll() : false)).catch(() => false).then((clear) => {
            if (h.done()) return;
            if (clear) h.finish("resumed");
            else tick();
          });
        }, LIMITS.pausePollMs));
      };
      tick();
      this.changed(run);
    });
  }

  /** Resolve the open hand-off as a cancel: text aborted, confirmation denied, pause aborted. */
  private abortOpened(run: RunState): void {
    const o = run.opened;
    if (!o) return;
    if (o.kind === "text") o.finish({ kind: "aborted" });
    else if (o.kind === "confirm") o.finish(false, "cancelled");
    else o.finish("aborted");
  }

  private finish(run: RunState, result0: RunResult): void {
    if (run.finished) return;
    this.abortOpened(run);
    const result = unseen(result0, run.confirmEnd);
    run.result = result;
    run.status = result.outcome;
    run.endedAt = this.now();
    if (this.current === run) this.current = null;
    this.lastEnded = run.endedAt;
    const finished = [...this.runs.values()].filter((r) => r.finished);
    while (finished.length > MCP.finishedRuns) {
      const old = finished.shift();
      if (old) this.runs.delete(old.id);
    }
    this.log.info(`run ${run.id} ${result.outcome}: ${flatText(run.redact(result.reason))}`);
    this.changed(run);
  }

  /** A starter throw as a failed/internal result, redacted, without the key. */
  private failed(run: RunState, input: BrowseInput, e: unknown): RunResult {
    const r = emptyResult(run.redact(input.task), input.goal ?? "act", undefined, input.engine ?? "cdp");
    const message = run.redact(String((e as Error | null)?.message ?? e));
    r.outcome = "failed";
    r.reason = `internal: ${message}`;
    r.error = { kind: "internal", message };
    return r;
  }
}
