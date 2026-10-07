// jev-browser: parse argv and env, wire real dependencies, print stdout JSON, and map the outcome to an exit code.
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { USAGE, VERSION, UsageError, browserOpt, parseArgs, textModelDeps } from "@imanshu03/jev-core/args.js";
import { createBrowser } from "@imanshu03/jev-core/browser.js";
import { LAUNCH_WAIT_MS, browserOf, defaultUserDataDir, launchChrome, listProfiles } from "@imanshu03/jev-core/fast/chrome.js";
import { FastRunner } from "@imanshu03/jev-core/fast/loop.js";
import type { Chrome } from "@imanshu03/jev-core/fast/model.js";
import { openPage } from "@imanshu03/jev-core/fast/page.js";
import { createHuman, createLogger, exitCode, emptyResult } from "@imanshu03/jev-core/io.js";
import { createOracle } from "@imanshu03/jev-core/jev.js";
import { Runner } from "@imanshu03/jev-core/loop.js";
import { createTransport } from "@imanshu03/jev-core/transport.js";
import type { RunConfig, RunResult } from "@imanshu03/jev-core/types.js";
import { redactData } from "@imanshu03/jev-core/task.js";
import { LIMITS } from "@imanshu03/jev-core/types.js";

export { USAGE, VERSION, UsageError, browserKind, browserOpt, parseArgs, parseGeo, textModelDeps } from "@imanshu03/jev-core/args.js";

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
      ...browserOpt(cfg, io.env),
      headed: cfg.headed, ...(profileDirectory ? { profileDirectory } : {}), ...(cfg.refreshProfile ? { refreshProfile: true } : {}),
      ...(cfg.cdp !== undefined ? { cdpPort: cfg.cdp } : {}), ...(cfg.chromeBin ? { chromeBin: cfg.chromeBin } : {}),
      ...(cfg.geo ? { geolocation: cfg.geo } : {}),
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
    ? new FastRunner({ cfg, profiles: listProfiles(defaultUserDataDir(io.env, undefined, browserOf(cfg, io.env))), chrome: launch, openPage: (c) => openPage(c, { settleTimeoutMs: LIMITS.settleDomMs, log }), oracle, human, log, warm: () => transport.warm(client.baseURL), ...textModelDeps(io.env, log) })
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
