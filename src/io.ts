// Logger, Human hand-off, exit code, and the empty RunResult.
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

export interface Human {
  readonly interactive: boolean;
  /** Wait for the user. `poll` returns true when the page is usable again (used without a TTY, and also with one). */
  pause(message: string, timeoutMs: number, poll?: () => Promise<boolean>): Promise<PauseResult>;
  confirm(message: string, timeoutMs: number): Promise<boolean>;
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
