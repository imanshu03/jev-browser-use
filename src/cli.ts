// Parse argv and env. Build RunConfig. Wire real dependencies. Print stdout JSON. Map outcome to exit code.
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBrowser } from "./browser.js";
import { LAUNCH_WAIT_MS, defaultUserDataDir, launchChrome, listProfiles } from "./fast/chrome.js";
import { FastRunner } from "./fast/loop.js";
import type { Chrome } from "./fast/model.js";
import { openPage } from "./fast/page.js";
import { createHuman, createLogger, exitCode, emptyResult } from "./io.js";
import { createOracle } from "./jev.js";
import { Runner } from "./loop.js";
import { UsageError } from "./plan.js";
import { createTransport } from "./transport.js";
import type { Goal, RunConfig, RunResult } from "./types.js";
import { redactData } from "./task.js";
import { LIMITS } from "./types.js";

export { UsageError };

export const USAGE = `jev-browser "<task>" [options]

Options:
  --engine <cdp|chromium|vercel>     cdp: direct Chrome CDP. chromium: Chromium over CDP. vercel: agent-browser. Default: cdp (env JEV_BROWSER_ENGINE).
  --profile <name|dir|none>  Chrome profile. Overrides a profile named in the task. Default: Parallelloop. none: a temporary profile.
  --refresh-profile          cdp/chromium: copy the browser profile again, even when a copy exists.
  --chrome-bin <path>        cdp/chromium: browser binary override (env JEV_CHROME_BIN / JEV_CHROMIUM_BIN).
  --url <start url>          Start page. Overrides URL resolution.
  --goal <act|extract|check> Skip the goal question.
  --headed                   Show the window. Enables the pause hand-off.
  --cdp <port>               Attach to a running Chrome. cdp/chromium: over its WebSocket. vercel: through agent-browser. Replaces --profile.
  --var <key=value>          A value Jev may type. Repeatable. Keys with pass/pin/otp/secret/token/code are secret.
  --max-steps <n>            Default 25, max 100.
  --step-timeout <ms>        Per browser command. Default 30000.
  --run-timeout <ms>         Default 600000.
  --pause-timeout <ms>       Default 300000.
  --confirm <auto|always|never>  auto: destructive asks. always: submit asks too. never: destructive -> blocked.
  --dry-run                  Decide and log; never act.
  --session <name>           Default jev-<8 hex>.
  --model <name>             Default jev-latest.
  --log-level <info|debug>   Default info.
  --log-json                 stderr lines as JSON.
  --keep-open                Do not close the browser at the end. cdp/chromium: only with --cdp (a launched Chrome exits with the process).
  --screenshot-dir <path>    Save a PNG per step.
  --version, --help
`;

export const VERSION = "0.1.0";

export function packageDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): RunConfig {
  const positional: string[] = [];
  const envEngine = env["JEV_BROWSER_ENGINE"];
  if (envEngine !== undefined && envEngine !== "cdp" && envEngine !== "chromium" && envEngine !== "vercel") throw new UsageError("JEV_BROWSER_ENGINE must be cdp, chromium, or vercel");
  const cfg: RunConfig = {
    task: "", engine: envEngine ?? "cdp", headed: false, maxSteps: Number(env["JEV_BROWSER_MAX_STEPS"] ?? 25), stepTimeoutMs: 30_000, runTimeoutMs: 600_000, pauseTimeoutMs: 300_000,
    confirm: "auto", dryRun: false, session: env["AGENT_BROWSER_SESSION"] ?? `jev-${randomBytes(4).toString("hex")}`,
    model: env["TYPESAFE_DEFAULT_MODEL"] ?? "jev-latest", logLevel: "info", logJson: false, keepOpen: false,
    agentBrowserBin: env["JEV_BROWSER_BIN"] ?? path.join(packageDir(), "node_modules", ".bin", "agent-browser"), vars: {},
  };
  if (env["AGENT_BROWSER_PROFILE"]) cfg.profile = env["AGENT_BROWSER_PROFILE"];
  const next = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  const num = (v: string, flag: string, min: number, max: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`${flag} must be a number between ${min} and ${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    switch (a) {
      case "--engine": {
        const e = next(i, a); i++;
        if (e !== "cdp" && e !== "chromium" && e !== "vercel") throw new UsageError("--engine must be cdp, chromium, or vercel");
        cfg.engine = e; break;
      }
      case "--refresh-profile": cfg.refreshProfile = true; break;
      case "--chrome-bin": cfg.chromeBin = next(i, a); i++; break;
      case "--profile": cfg.profile = next(i, a); i++; break;
      case "--url": cfg.url = next(i, a); i++; break;
      case "--goal": {
        const g = next(i, a); i++;
        if (g !== "act" && g !== "extract" && g !== "check") throw new UsageError("--goal must be act, extract, or check");
        cfg.goal = g as Goal; break;
      }
      case "--headed": cfg.headed = true; break;
      case "--cdp": cfg.cdp = num(next(i, a), a, 1, 65535); i++; break;
      case "--var": {
        const kv = next(i, a); i++;
        const eq = kv.indexOf("=");
        if (eq <= 0) throw new UsageError("--var needs key=value");
        cfg.vars[kv.slice(0, eq).toLowerCase()] = kv.slice(eq + 1);
        break;
      }
      case "--max-steps": cfg.maxSteps = num(next(i, a), a, 1, 100); i++; break;
      case "--step-timeout": cfg.stepTimeoutMs = num(next(i, a), a, 1000, 600_000); i++; break;
      case "--run-timeout": cfg.runTimeoutMs = num(next(i, a), a, 1000, 86_400_000); i++; break;
      case "--pause-timeout": cfg.pauseTimeoutMs = num(next(i, a), a, 1000, 86_400_000); i++; break;
      case "--confirm": {
        const c = next(i, a); i++;
        if (c !== "auto" && c !== "always" && c !== "never") throw new UsageError("--confirm must be auto, always, or never");
        cfg.confirm = c; break;
      }
      case "--dry-run": cfg.dryRun = true; break;
      case "--session": cfg.session = next(i, a); i++; break;
      case "--model": cfg.model = next(i, a); i++; break;
      case "--log-level": {
        const l = next(i, a); i++;
        if (l !== "info" && l !== "debug") throw new UsageError("--log-level must be info or debug");
        cfg.logLevel = l; break;
      }
      case "--log-json": cfg.logJson = true; break;
      case "--keep-open": cfg.keepOpen = true; break;
      case "--screenshot-dir": cfg.screenshotDir = next(i, a); i++; break;
      case "--help": case "--version": break;
      default: throw new UsageError(`unknown flag ${a}`);
    }
  }
  // An env value such as "abc" gives NaN, which the old range check let through.
  if (!Number.isFinite(cfg.maxSteps) || cfg.maxSteps > 100 || cfg.maxSteps < 1) throw new UsageError("--max-steps must be between 1 and 100");
  cfg.task = positional.join(" ").trim();
  return cfg;
}

export interface MainIo { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream; stdin: NodeJS.ReadStream; env: NodeJS.ProcessEnv }

export interface MainDeps {
  runner?: (cfg: RunConfig, io: MainIo) => Promise<RunResult>;
}

export async function main(argv: string[], io: MainIo = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env }, deps: MainDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.length === 0) { io.stderr.write(USAGE); return argv.includes("--help") ? 0 : 4; }
  if (argv.includes("--version")) { io.stdout.write(`jev-browser ${VERSION}\n`); return 0; }
  let cfg: RunConfig;
  try {
    cfg = parseArgs(argv, io.env);
    if (!cfg.task) throw new UsageError("missing task");
    if (!io.env["TYPESAFE_API_KEY"]) throw new UsageError("TYPESAFE_API_KEY is not set (put it in .env)");
    if (!deps.runner && cfg.engine === "vercel" && !existsSync(cfg.agentBrowserBin)) throw new UsageError(`agent-browser binary not found at ${cfg.agentBrowserBin}`);
    if (cfg.engine !== "vercel" && cfg.keepOpen && cfg.cdp === undefined) throw new UsageError("--keep-open needs --cdp <port> with cdp or chromium: a Chrome the engine launched exits with the process. Use jev-chat to keep a browser open between tasks, or --engine vercel.");
  } catch (e) {
    if (e instanceof UsageError) { io.stderr.write(`error: ${e.message}\n\n${USAGE}`); return 4; }
    throw e;
  }
  const result = deps.runner ? await deps.runner(cfg, io) : await realRun(cfg, io);
  io.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return exitCode(result);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function realRun(cfg: RunConfig, io: MainIo): Promise<RunResult> {
  const log = createLogger(io.stderr, cfg.logLevel, cfg.logJson);
  const human = createHuman({ stdin: io.stdin, stderr: io.stderr, forceNonInteractive: false });
  /** One keep-alive connection for every Jev request of this run. */
  const transport = createTransport({ log });
  const client = new TypeSafeClient({ defaultModel: cfg.model, logLevel: "off", fetch: transport.fetch });
  const oracle = createOracle(client, cfg.model, log);
  const fast = cfg.engine !== "vercel";
  const browserFor = (profileDirectory: string | undefined) => createBrowser({
    bin: cfg.agentBrowserBin, session: cfg.session, headed: cfg.headed, commandTimeoutMs: cfg.stepTimeoutMs, log,
    ...(profileDirectory ? { profileDirectory } : {}), ...(cfg.cdp !== undefined ? { cdp: cfg.cdp } : {}),
  });
  /** The Chrome the fast engine launched. SIGINT closes it. */
  let chrome: Chrome | null = null;
  /** A launch in flight. SIGINT waits for it, so close() can remove a temporary profile. */
  let launching: Promise<Chrome> | null = null;
  const launch = async (profileDirectory: string | undefined): Promise<Chrome> => {
    launching = launchChrome({
      browser: cfg.engine === "chromium" ? "chromium" : "chrome",
      headed: cfg.headed, ...(profileDirectory ? { profileDirectory } : {}), ...(cfg.refreshProfile ? { refreshProfile: true } : {}),
      ...(cfg.cdp !== undefined ? { cdpPort: cfg.cdp } : {}), ...(cfg.chromeBin ? { chromeBin: cfg.chromeBin } : {}),
      commandTimeoutMs: cfg.stepTimeoutMs, env: io.env, log,
    }).then((c) => { chrome = c; return c; });
    try { return await launching; } finally { launching = null; }
  };
  /** Close the launched Chrome. Waits at most LAUNCH_WAIT_MS for a launch in flight. */
  const closeChrome = async (): Promise<void> => {
    if (launching) await Promise.race([launching.then(() => undefined, () => undefined), sleep(LAUNCH_WAIT_MS)]);
    if (chrome) await chrome.close();
  };
  const runner = fast
    ? new FastRunner({ cfg, profiles: listProfiles(defaultUserDataDir(io.env, undefined, cfg.engine === "chromium" ? "chromium" : "chrome")), chrome: launch, openPage: (c) => openPage(c, { settleTimeoutMs: LIMITS.settleDomMs, log }), oracle, human, log, warm: () => transport.warm(client.baseURL) })
    : new Runner({ cfg, browserFor, oracle, human, log });
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) return;
    interrupted = true;
    log.warn("SIGINT: closing the browser");
    const r = emptyResult(cfg.task, cfg.goal ?? "act", cfg.model, cfg.engine ?? "cdp");
    r.outcome = "blocked"; r.reason = "human_aborted: SIGINT";
    r.blocked = { kind: "human_aborted", hint: "interrupted with SIGINT", top: [], resume: { session: cfg.session, url: null } };
    const done = () => { io.stdout.write(JSON.stringify(redactData(r, log.redactor), null, 2) + "\n"); process.exit(130); };
    if (cfg.keepOpen) done();
    else if (fast) closeChrome().catch(() => undefined).finally(done);
    else browserFor(undefined).close().finally(done);
  };
  process.once("SIGINT", onSigint);
  try {
    let result: RunResult;
    try { result = await runner.run(); } catch (e) {
      if (e instanceof UsageError) throw e;
      result = emptyResult(cfg.task, cfg.goal ?? "act", cfg.model, cfg.engine ?? "cdp");
      result.outcome = "failed"; result.reason = `internal: ${(e as Error).message}`;
      result.error = { kind: "internal", message: String((e as Error).message) };
      if (fast && !cfg.keepOpen) await closeChrome().catch(() => undefined);
    }
    return result;
  } finally {
    process.off("SIGINT", onSigint);
    if (fast && cfg.keepOpen && chrome) await (chrome as Chrome).client.close().catch(() => undefined);
    transport.close().catch(() => undefined);
  }
}

// In a bundle every module shares the bundle URL. Only a direct run of this file starts the CLI.
const entry = fileURLToPath(import.meta.url);
const isMain = process.argv[1] !== undefined && /^cli\.[cm]?[jt]s$/.test(path.basename(entry)) && path.resolve(process.argv[1]) === entry;
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((e: unknown) => {
    if (e instanceof UsageError) { process.stderr.write(`error: ${e.message}\n`); process.exitCode = 4; return; }
    process.stderr.write(`fatal: ${(e as Error)?.stack ?? String(e)}\n`);
    process.exitCode = 3;
  });
}
