// Logger, Human hand-off, assistant text hand-off, exit code, and the empty RunResult.
import type { Engine, Goal, RunResult, StepRecord } from "./types.js";
import { redactData } from "./task.js";
import { LIMITS } from "./types.js";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string, data?: unknown): void;
  step(rec: StepRecord): void;
  redactor: (s: string) => string;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function createLogger(stderr: NodeJS.WritableStream, level: "info" | "debug", json: boolean): Logger {
  const log: Logger = {
    redactor: (s) => s,
    info(msg) { emit("INFO", "log", msg); },
    warn(msg) { emit("WARN", "log", msg); },
    debug(msg, data) {
      if (level !== "debug") return;
      emit("DEBUG", "log", msg, data);
    },
    step(rec) {
      const tgt = rec.target ? `${rec.target.role} "${rec.target.name}"` : "-";
      const val = rec.value !== null ? ` value="${rec.value}"` : "";
      const conf = rec.target_conf !== null ? ` target=${rec.target_conf.toFixed(2)}` : "";
      const rup = rec.runner_up !== null ? ` rup=${rec.runner_up.toFixed(2)}` : "";
      const vconf = rec.value_conf !== null ? ` value=${rec.value_conf.toFixed(2)}` : "";
      const err = rec.error ? ` error=${rec.error}` : "";
      emit("INFO", "step", `step ${rec.step} ${rec.action} ${tgt}${val}${conf}${rup}${vconf} risk=${rec.risk ?? "-"} path=${rec.path ?? "-"} gate=${rec.gate} -> ${rec.result}${err} url=${rec.url} (${rec.jev_requests} req, ${rec.duration_ms}ms)`, rec);
    },
  };
  function emit(lvl: string, event: string, msg: string, data?: unknown): void {
    const text = log.redactor(msg);
    if (json) {
      const payload: Record<string, unknown> = { t: new Date().toISOString(), level: lvl, event, msg: text };
      if (data !== undefined) payload["data"] = redactData(data, log.redactor);
      stderr.write(JSON.stringify(payload) + "\n");
      return;
    }
    let line = `${stamp()} ${lvl} ${text}`;
    if (data !== undefined && level === "debug" && event === "log") line += " " + JSON.stringify(redactData(data, log.redactor));
    stderr.write(line + "\n");
  }
  return log;
}

export type PauseResult = "resumed" | "aborted" | "timeout";

/** One field of a text request. The ids are "f1", "f2", and so on. */
export interface TextField {
  id: string; label: string; role: string;
  required: boolean;              // true only for f1, the field Jev chose
  multiline: boolean;
  max_chars: number;              // min(maxLength, LIMITS.generatedChars)
  current_value: string;          // redacted, sanitized, cut to LIMITS.valueChars
}

export interface TextRequest {    // key order is fixed; untrusted_page_text is last
  id: string;                     // "t1".."t3"
  goal: string;                   // redacted task
  page: { url: string; title: string };
  fields: TextField[];
  recent_actions: { action: string; kind: string; text: string | null }[];
  sent_texts?: { field: string; text: string }[];   // texts that a send of this run took out of the page; absent when none
  untrusted_page_text: string;    // redacted + sanitizeText(obs.text), <= LIMITS.textChars
}

export type TextReply =
  | { kind: "text"; values: Record<string, string> }   // missing optional id = leave empty
  | { kind: "declined"; reason: string }
  | { kind: "timeout" }
  | { kind: "aborted" };

export interface TextWriteOptions {
  timeoutMs: number;
  /** Field id -> error; {} when valid. Pure. Never echoes a value. */
  check: (values: Record<string, string>) => Record<string, string>;
}

/** The harness model writes field text. It is never the human. */
export interface TextSource { write(req: TextRequest, opts: TextWriteOptions): Promise<TextReply> }

/** What a confirmation is about. A front end that shows a dialog uses it; the CLI and chat ignore it. */
export type ConfirmDetail =
  | { kind: "action"; action: string; host: string; typed: { label: string; text: string }[] }
  | { kind: "profile"; name: string; directory: string };

export type PauseKind = "sign_in" | "captcha";

export interface Human {
  readonly interactive: boolean;
  /** Wait for the user. `poll` returns true when the page is usable again (used without a TTY, and also with one). `kind` tells a front end what the user must do. */
  pause(message: string, timeoutMs: number, poll?: () => Promise<boolean>, kind?: PauseKind): Promise<PauseResult>;
  /** Ask the user. `detail` gives the structured content of the question. */
  confirm(message: string, timeoutMs: number, detail?: ConfirmDetail): Promise<boolean>;
}

/** Front-end hint text. An absent field keeps the CLI text. */
export interface RunnerHints {
  headed?: string;      // replaces "Run with --headed (or /headed on in chat) and sign in when the run pauses"
  noConfirm?: string;   // replaces "run on a TTY with confirmation enabled"
  noConfirmHeadless?: string; // used instead of `noConfirm` when the run is headless
  confirmNever?: string; // used when the run's confirm setting is "never"; absent uses `noConfirm`, then the CLI text
  value?: string;       // replaces "pass --var key=value (or /var key=value in chat)" for other fields
  credential?: string;  // used for credential fields; absent uses `value`, then the CLI text
}

export function createHuman(opts: { stdin: NodeJS.ReadStream; stderr: NodeJS.WritableStream; forceNonInteractive: boolean; pollMs?: number }): Human {
  const interactive = Boolean(opts.stdin.isTTY) && !opts.forceNonInteractive;
  const pollMs = opts.pollMs ?? LIMITS.pausePollMs;

  function readLine(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const stdin = opts.stdin;
      let done = false;
      const finish = (v: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        stdin.off("data", onData);
        stdin.pause();
        resolve(v);
      };
      const onData = (chunk: Buffer | string) => finish(String(chunk).trim());
      const timer = setTimeout(() => finish(null), timeoutMs);
      stdin.setEncoding("utf8");
      stdin.resume();
      stdin.on("data", onData);
    });
  }

  return {
    interactive,
    async pause(message, timeoutMs, poll) {
      opts.stderr.write(`PAUSED ${message}\n`);
      const deadline = Date.now() + timeoutMs;
      let keyResult: PauseResult | null = null;
      let keyPromise: Promise<void> | null = null;
      if (interactive) {
        keyPromise = readLine(timeoutMs).then((line) => {
          if (line === null) return;
          keyResult = line.toLowerCase() === "q" ? "aborted" : "resumed";
        });
      }
      while (Date.now() < deadline) {
        if (keyResult) return keyResult;
        if (poll) {
          const clear = await poll().catch(() => false);
          if (clear) return "resumed";
        } else if (!interactive) {
          break;
        }
        const slice = Math.min(pollMs, Math.max(0, deadline - Date.now()));
        if (keyPromise) await Promise.race([keyPromise, sleep(slice)]);
        else await sleep(slice);
      }
      return keyResult ?? "timeout";
    },
    async confirm(message, timeoutMs) {
      if (!interactive) return false;
      opts.stderr.write(message);
      const line = await readLine(timeoutMs);
      return line !== null && /^y(es)?$/i.test(line);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function exitCode(r: RunResult): 0 | 2 | 3 {
  return r.outcome === "done" ? 0 : r.outcome === "blocked" ? 2 : 3;
}

export function emptyResult(task: string, goal: Goal, model = "jev-latest", engine: Engine = "cdp"): RunResult {
  return {
    version: 1, task, outcome: "failed", reason: "not started", confidence: null, goal, answer: null,
    final_url: null, final_title: null, profile: null, start: null, steps: [], blocked: null, error: null,
    stats: { steps: 0, jev_requests: 0, input_tokens: 0, output_tokens: 0, duration_ms: 0, model, pauses: 0, jev_ms: 0, browser_ms: 0, engine },
  };
}
