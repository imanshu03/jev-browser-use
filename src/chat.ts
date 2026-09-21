// Chat mode. Asks for the key once, then runs one task per line in the same browser session.
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { Browser } from "./browser.js";
import { createBrowser } from "./browser.js";
import { parseArgs, VERSION } from "./cli.js";
import type { KeyCheck, KeySource } from "./config.js";
import { configPath, forgetKey, loadKey, looksLikeKey, saveKey, validateKey } from "./config.js";
import { LAUNCH_WAIT_MS, defaultUserDataDir, launchChrome, listProfiles } from "./fast/chrome.js";
import { FastRunner } from "./fast/loop.js";
import type { Chrome, ChromeLaunchOptions, Page } from "./fast/model.js";
import { openPage } from "./fast/page.js";
import type { Human, Logger, PauseResult } from "./io.js";
import { createLogger, emptyResult } from "./io.js";
import type { Oracle } from "./jev.js";
import { createOracle } from "./jev.js";
import { Runner } from "./loop.js";
import { UsageError } from "./plan.js";
import type { ProfileEntry } from "./browser.js";
import type { Transport } from "./transport.js";
import { createTransport } from "./transport.js";
import type { RunConfig, RunResult } from "./types.js";
import { LIMITS } from "./types.js";

export const CHAT_USAGE = `jev-chat [options]

Interactive mode. Type one task per line. The browser stays open between tasks.
Run one task without the chat: jev-browser "<task>"

Options:
  --engine <cdp|chromium|vercel>     cdp: direct Chrome CDP. chromium: Chromium over CDP. vercel: agent-browser. Default: cdp (env JEV_BROWSER_ENGINE).
  --profile <name|dir|none>  Chrome profile. Default: Parallelloop. none: a temporary profile.
  --refresh-profile          cdp/chromium: copy the browser profile again, even when a copy exists.
  --chrome-bin <path>        cdp/chromium: browser binary override (env JEV_CHROME_BIN / JEV_CHROMIUM_BIN).
  --session <name>           Session name. Default: jev-chat-<8 hex>. The vercel engine uses it as the agent-browser session.
  --model <name>             Default: jev-latest.
  --max-steps <n>            Default 25, max 100.
  --confirm <auto|always|never>  auto: destructive asks. always: submit asks too. never: destructive -> blocked.
  --log-level <info|debug>   debug prints the full step trace. Default: info.
  --var <key=value>          A value Jev may type. Repeatable. Keys with pass/pin/otp/secret/token/code are secret.
  --headless                 Hide the Chrome window. Chat mode shows it by default.
  --reset-key                Forget the saved key, then ask for it again.
                             TYPESAFE_API_KEY in the environment or in .env has priority over the saved key.
  --help

Commands:
  /help                 List commands and flags.
  /quit, /exit          Close the browser and exit.
  /key                  Enter a new API key.
  /headed on|off        Show or hide the window for the next task.
  /profile <name|none>  Set the Chrome profile for the next task.
  /var <key=value>      Add a value Jev may type in later tasks.
  /stats                Session totals.
  /url                  Current page URL.
  /close                Close the browser. The chat stays open.
  Any other line runs as a task.
`;

const CHAT_FLAGS = new Set(["--engine", "--profile", "--refresh-profile", "--chrome-bin", "--session", "--model", "--max-steps", "--confirm", "--log-level", "--var", "--headless", "--headed", "--reset-key", "--help"]);
const OWN_FLAGS = new Set(["--headless", "--headed", "--reset-key", "--help"]);
/** Shared flags that take no value. */
const BOOL_FLAGS = new Set(["--refresh-profile"]);

/** Chat mode blocks a task on this hint instead of the one-shot --var hint. */
const CREDENTIAL_HINT = /needs --var <key>=<value>/;

/** While the chat waits for input, it pings the API at this interval so the connection stays warm. */
export const IDLE_PING_MS = 45_000;

export interface ChatOptions { cfg: RunConfig; resetKey: boolean; help: boolean }

/** Parse chat flags. Reuses parseArgs for the shared flags. */
export function parseChatArgs(argv: string[], env: NodeJS.ProcessEnv): ChatOptions {
  const shared: string[] = [];
  let headless = false;
  let resetKey = false;
  let help = false;
  let sessionGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("--")) throw new UsageError(`chat mode takes no task argument. Run one task with: jev-browser "${a}"`);
    if (!CHAT_FLAGS.has(a)) throw new UsageError(`unknown flag ${a}`);
    if (a === "--headless") { headless = true; continue; }
    if (a === "--reset-key") { resetKey = true; continue; }
    if (a === "--help") { help = true; continue; }
    if (OWN_FLAGS.has(a)) continue;
    if (a === "--session") sessionGiven = true;
    shared.push(a);
    if (BOOL_FLAGS.has(a)) continue;
    const v = argv[i + 1];
    if (v !== undefined && !v.startsWith("--")) { shared.push(v); i++; }
  }
  const cfg = parseArgs(shared, env);
  cfg.headed = !headless;
  cfg.keepOpen = true;
  if (!sessionGiven) cfg.session = `jev-chat-${randomBytes(4).toString("hex")}`;
  return { cfg, resetKey, help };
}

export interface ChatIo { stdout: NodeJS.WritableStream; stdin: NodeJS.ReadStream; env: NodeJS.ProcessEnv }

export interface RunContext { browserFor: (profileDirectory: string | undefined) => Browser; human: Human; log: Logger }

export interface ChatDeps {
  /** Replaces both engines. The chat then tracks the browser through `browserFor`. */
  runner?: (cfg: RunConfig, ctx: RunContext) => Promise<RunResult>;
  validate?: (key: string, model: string) => Promise<KeyCheck>;
  browserFor?: (cfg: RunConfig, profileDirectory: string | undefined) => Browser;
  /** Fast engine: replaces launchChrome. Tests pass a fake Chrome. */
  launch?: (opts: ChromeLaunchOptions) => Promise<Chrome>;
  /** Fast engine: replaces openPage. Tests pass a fake Page. */
  openPage?: (chrome: Chrome, log: Logger) => Promise<Page>;
  /** Replaces the TypeSafe oracle. Tests pass a fake. */
  oracle?: (model: string, log: Logger) => Oracle;
  /** Chrome profiles the fast engine offers to the plan. Default: the profiles of the Chrome user data dir. */
  profiles?: ProfileEntry[];
  exit?: (code: number) => void;
  /** Poll interval for Human.pause. Tests set a small value. */
  pausePollMs?: number;
  /** Replaces the keep-alive Jev transport. Tests pass a fake that never opens a socket. */
  transport?: Transport;
}

interface Totals { tasks: number; ms: number; jevMs: number; browserMs: number; input: number; output: number; requests: number }

const nf = new Intl.NumberFormat("en-US");
const secs = (ms: number): string => (ms / 1000).toFixed(1);

/** `time 4.2 s (jev 2.1 s · browser 1.6 s) · input ...`. The split shows where the time went. */
export function metricsLine(s: RunResult["stats"]): string {
  return `time ${secs(s.duration_ms)} s (jev ${secs(s.jev_ms)} s · browser ${secs(s.browser_ms)} s) · input ${nf.format(s.input_tokens)} tokens · output ${nf.format(s.output_tokens)} tokens · ${s.steps} steps · ${s.jev_requests} requests`;
}

export function resultLines(r: RunResult): string[] {
  const lines: string[] = [];
  if (r.outcome === "done") {
    const a = r.answer;
    if (a && a.kind === "check") {
      const yn = a.answer === true ? "yes" : a.answer === false ? "no" : "unknown";
      lines.push(`✔ done · answer ${yn} (p=${a.probability.toFixed(2)}) · evidence: ${a.evidence[0] ?? "none"}`);
    } else if (a && a.kind === "extract") lines.push(`✔ done · ${a.text}`);
    else lines.push(`✔ done · ${r.reason || "task complete"}`);
  } else if (r.outcome === "blocked") {
    const hint = (r.blocked?.hint ?? r.reason).replace(CREDENTIAL_HINT, "needs /var <key>=<value> or --var <key>=<value>");
    lines.push(`■ blocked · ${r.blocked?.kind ?? "unknown"}: ${hint}`);
  } else lines.push(`✖ failed · ${r.error?.kind ?? "internal"}: ${r.error?.message ?? r.reason}`);
  if (r.final_url) lines.push(`  url ${r.final_url}`);
  lines.push(metricsLine(r.stats));
  return lines;
}

/** Compact logger for chat mode. Prints steps, warnings, and the plan, chrome, open, and continue lines. */
export function chatLogger(out: NodeJS.WritableStream): Logger {
  const log: Logger = {
    redactor: (s) => s,
    info(msg) { if (/^(plan |chrome |open |continue on )/.test(msg)) out.write(`  ${log.redactor(msg)}\n`); },
    warn(msg) { out.write(`  ! ${log.redactor(msg)}\n`); },
    debug() { /* silent at info level */ },
    step(rec) {
      const tgt = rec.target ? ` ${rec.target.role} "${rec.target.name}"` : "";
      const val = rec.value !== null ? ` value="${rec.value}"` : "";
      const err = rec.error ? ` ${rec.error}` : "";
      out.write(log.redactor(`  ${rec.step}. ${rec.action}${tgt}${val} -> ${rec.result}${err}`) + "\n");
    },
  };
  return log;
}

/** A logger that also reports when the Runner opens or continues on a page. */
function launchWatcher(inner: Logger, onLaunch: () => void): Logger {
  const log: Logger = {
    get redactor() { return inner.redactor; },
    set redactor(r) { inner.redactor = r; },
    info(msg) { if (/^(open |continue on )/.test(msg)) onLaunch(); inner.info(msg); },
    warn(msg) { inner.warn(msg); },
    debug(msg, data) { inner.debug(msg, data); },
    step(rec) { inner.step(rec); },
  };
  return log;
}

/** A timer that keeps the process alive. A pause after stdin EOF has no other handle. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => { setTimeout(r, ms); });
}

/** True for a browser error that means Chrome did not start. Any other browser error leaves the session alive. */
function isLaunchFailure(r: RunResult): boolean {
  return r.error?.kind === "browser" && /launch|could not start|daemon|ENOENT/i.test(r.error.message);
}

/** True when the Runner had a browser during this task. */
function hadBrowser(r: RunResult): boolean {
  return r.final_url !== null || r.steps.length > 0;
}

/** Read one line with echo off. Returns null on Ctrl-C or Ctrl-D. Skips terminal escape sequences. */
function readMasked(stdin: NodeJS.ReadStream, out: NodeJS.WritableStream, prompt: string): Promise<string | null> {
  out.write(prompt);
  return new Promise((resolve) => {
    let buf = "";
    let esc: "none" | "esc" | "csi" | "ss3" = "none";
    const wasRaw = Boolean(stdin.isRaw);
    const finish = (v: string | null) => {
      stdin.off("data", onData);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
      out.write("\n");
      resolve(v);
    };
    const erase = (n: number) => { if (n > 0) out.write("\b \b".repeat(n)); };
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (esc === "esc") { esc = ch === "[" ? "csi" : ch === "O" ? "ss3" : "none"; continue; }
        if (esc === "csi") { if (ch >= "@" && ch <= "~") esc = "none"; continue; }
        if (esc === "ss3") { esc = "none"; continue; }
        if (ch === "\u001b") { esc = "esc"; continue; }
        if (ch === "\u0003" || ch === "\u0004") { finish(null); return; }
        if (ch === "\r" || ch === "\n") { finish(buf); return; }
        if (ch === "\u007f" || ch === "\b") { if (buf) { buf = buf.slice(0, -1); erase(1); } continue; }
        if (ch === "\u0015") { erase(buf.length); buf = ""; continue; }
        if (ch >= " ") { buf += ch; out.write("*"); }
      }
    };
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

interface AskOptions {
  signal?: AbortSignal;
  /** Ignore lines typed before the prompt. Used by confirm and pause during a task. */
  fresh?: boolean;
}

/**
 * Lines from stdin through readline. Lines that arrive while no prompt waits are queued,
 * so piped input keeps its order. `ask` resolves null at EOF or when the signal aborts.
 */
class LineInput {
  private rl: ReadlineInterface | null = null;
  private readonly queue: string[] = [];
  private readonly waiters: ((line: string | null) => void)[] = [];
  eof = false;
  constructor(private readonly stdin: NodeJS.ReadStream, private readonly stdout: NodeJS.WritableStream, readonly terminal: boolean, private readonly onSigint: () => void) {}

  open(): void {
    const rl = createInterface({ input: this.stdin, output: this.stdout, terminal: this.terminal });
    this.rl = rl;
    rl.on("line", (line: string) => {
      const w = this.waiters.shift();
      if (w) w(line); else this.queue.push(line);
    });
    rl.on("close", () => {
      if (this.rl !== rl) return;
      this.rl = null;
      this.eof = true;
      for (const w of this.waiters.splice(0)) w(null);
    });
    rl.on("SIGINT", () => this.onSigint());
  }

  /** Close the readline for a moment. readKey reopens it. Pending asks stay pending. */
  close(): void {
    const rl = this.rl;
    this.rl = null;
    rl?.close();
  }

  /** Stop input for good. Every pending ask resolves null. */
  end(): void {
    this.eof = true;
    this.close();
    for (const w of this.waiters.splice(0)) w(null);
  }

  ask(prompt: string, opts: AskOptions = {}): Promise<string | null> {
    const { signal, fresh } = opts;
    if (!fresh) {
      const queued = this.queue.shift();
      if (queued !== undefined) { this.stdout.write(prompt); return Promise.resolve(queued); }
    }
    if (this.eof || !this.rl) return Promise.resolve(null);
    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return new Promise((resolve) => {
      const w = (line: string | null) => { signal?.removeEventListener("abort", onAbort); resolve(line); };
      const onAbort = () => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      };
      if (signal?.aborted) { resolve(null); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(w);
    });
  }

  /** Read a key: masked on a TTY, one plain line otherwise. */
  async readKey(prompt: string): Promise<string | null> {
    if (!this.terminal) return this.ask(prompt);
    this.close();
    const v = await readMasked(this.stdin, this.stdout, prompt);
    this.open();
    return v;
  }
}

/** A Human on the chat's readline. Off a TTY, confirm says no and pause polls only. Type-ahead lines are not answers. */
function readlineHuman(input: LineInput, out: NodeJS.WritableStream, interactive: boolean, pollMs: number): Human {
  return {
    interactive,
    async confirm(message, timeoutMs) {
      if (!interactive) return false;
      const line = await input.ask(message, { signal: AbortSignal.timeout(timeoutMs), fresh: true });
      return line !== null && /^y(es)?$/i.test(line.trim());
    },
    async pause(message, timeoutMs, poll) {
      out.write(`PAUSED ${message}\n`);
      out.write("Press Enter when the page is ready, or q to abort.\n");
      const deadline = Date.now() + timeoutMs;
      const ac = new AbortController();
      let keyResult: PauseResult | null = null;
      const keyPromise = interactive
        ? input.ask("", { signal: AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)]), fresh: true }).then((line) => {
          if (line === null) return;
          keyResult = line.trim().toLowerCase() === "q" ? "aborted" : "resumed";
        })
        : null;
      while (Date.now() < deadline) {
        if (keyResult) return keyResult;
        if (poll) {
          const clear = await poll().catch(() => false);
          if (clear) { ac.abort(); return "resumed"; }
        } else if (!interactive) break;
        const slice = Math.min(pollMs, Math.max(0, deadline - Date.now()));
        if (keyPromise) await Promise.race([keyPromise, sleep(slice)]);
        else await sleep(slice);
      }
      ac.abort();
      return keyResult ?? "timeout";
    },
  };
}

export async function runChat(argv: string[], io: ChatIo = { stdout: process.stdout, stdin: process.stdin, env: process.env }, deps: ChatDeps = {}): Promise<number> {
  const out = (s: string) => io.stdout.write(s + "\n");
  let opts: ChatOptions;
  try {
    opts = parseChatArgs(argv, io.env);
    if (!opts.help && !deps.runner && opts.cfg.engine === "vercel" && !existsSync(opts.cfg.agentBrowserBin)) throw new UsageError(`agent-browser binary not found at ${opts.cfg.agentBrowserBin}`);
  } catch (e) {
    if (e instanceof UsageError) { io.stdout.write(`error: ${e.message}\n\n${CHAT_USAGE}`); return 4; }
    throw e;
  }
  if (opts.help) { io.stdout.write(CHAT_USAGE); return 0; }

  const base = opts.cfg;
  const env = io.env;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const terminal = Boolean(io.stdin.isTTY);
  const pollMs = deps.pausePollMs ?? LIMITS.pausePollMs;
  const totals: Totals = { tasks: 0, ms: 0, jevMs: 0, browserMs: 0, input: 0, output: 0, requests: 0 };
  const fastEngine = base.engine !== "vercel";

  let key = "";
  let keySource: KeySource | null = null;
  let client: TypeSafeClient | null = null;
  let headed = base.headed;
  let profile: string | undefined = base.profile;
  /** The browser answers commands. Used for fallbackUrl and /url. */
  let browserOpen = false;
  /** A browser session may exist and needs a close. Cleared only by a close or a launch failure. */
  let everLaunched = false;
  /** Fast engine: the Chrome and the tab that stay open between tasks. */
  let chrome: Chrome | null = null;
  /** A launch in flight. closeChrome waits for it, so a Ctrl-C during the launch still removes a temporary profile. */
  let launching: Promise<Chrome> | null = null;
  let page: Page | null = null;
  let running = false;
  let quitting = false;

  const markLaunched = () => { everLaunched = true; };
  const log = launchWatcher(base.logLevel === "debug" ? createLogger(io.stdout, "debug", false) : chatLogger(io.stdout), markLaunched);
  /** One keep-alive connection for the key check, every task, and the idle pings. */
  const transport = deps.transport ?? createTransport({ log });
  const validate = deps.validate ?? ((k: string, m: string) => validateKey(k, m, (c) => new TypeSafeClient({ ...c, fetch: transport.fetch })));

  const browserFor = (cfg: RunConfig) => (profileDirectory: string | undefined): Browser =>
    deps.browserFor ? deps.browserFor(cfg, profileDirectory) : createBrowser({
      bin: cfg.agentBrowserBin, session: cfg.session, headed: cfg.headed, commandTimeoutMs: cfg.stepTimeoutMs, log,
      ...(profileDirectory ? { profileDirectory } : {}),
    });
  const chatBrowser = (): Browser => browserFor({ ...base, headed })(undefined);

  const launch = deps.launch ?? launchChrome;
  const open = deps.openPage ?? ((c: Chrome, l: Logger) => openPage(c, { settleTimeoutMs: LIMITS.settleDomMs, log: l }));
  const oracleFor = deps.oracle ?? ((model: string, l: Logger) => createOracle(clientFor(), model, l));
  const profiles = deps.profiles ?? (fastEngine && !deps.runner ? listProfiles(defaultUserDataDir(env, undefined, base.engine === "chromium" ? "chromium" : "chrome")) : []);

  /** Fast engine: launch Chrome for the first task, then reuse it. */
  async function chromeFor(cfg: RunConfig, profileDirectory: string | undefined): Promise<Chrome> {
    // The user can quit the window between tasks. A Chrome whose connection is gone is closed, then launched again.
    if (chrome && chrome.client.closed) {
      log.warn("chrome connection is closed; launching a new one");
      await closeChrome();
    }
    if (chrome) {
      if (profileDirectory && chrome.profile.directory !== profileDirectory) log.warn(`chrome is open on profile ${chrome.profile.directory ?? "none"}; use /profile to switch`);
      return chrome;
    }
    launching = launch({
      browser: cfg.engine === "chromium" ? "chromium" : "chrome",
      headed: cfg.headed, ...(profileDirectory ? { profileDirectory } : {}), ...(cfg.refreshProfile ? { refreshProfile: true } : {}),
      ...(cfg.cdp !== undefined ? { cdpPort: cfg.cdp } : {}), ...(cfg.chromeBin ? { chromeBin: cfg.chromeBin } : {}),
      commandTimeoutMs: cfg.stepTimeoutMs, env, log,
    }).then((c) => { chrome = c; return c; });
    try { const c = await launching; everLaunched = true; return c; } finally { launching = null; }
  }

  /** Fast engine: close the tab and Chrome. Idempotent. Waits at most LAUNCH_WAIT_MS for a launch in flight. */
  async function closeChrome(): Promise<void> {
    if (launching) await Promise.race([launching.then(() => undefined, () => undefined), sleep(LAUNCH_WAIT_MS)]);
    const c = chrome;
    chrome = null;
    page = null;
    browserOpen = false;
    everLaunched = false;
    if (!c) return;
    await c.close().catch(() => undefined);
  }

  /** True when the chat owns Chrome directly (fast engine, real run). Otherwise agent-browser owns the session. */
  const ownsChrome = fastEngine && !deps.runner;

  const totalsLine = () => `Session · ${totals.tasks} tasks · ${secs(totals.ms)} s (jev ${secs(totals.jevMs)} s · browser ${secs(totals.browserMs)} s) · input ${nf.format(totals.input)} tokens · output ${nf.format(totals.output)} tokens`;

  const envKeyNote = () => out("TYPESAFE_API_KEY is set in the environment (or .env). It has priority over the saved file. Unset it to use the saved key.");

  async function closeBrowser(): Promise<void> {
    if (ownsChrome) { await closeChrome(); return; }
    if (!browserOpen && !everLaunched) return;
    browserOpen = false;
    everLaunched = false;
    await chatBrowser().close().catch(() => undefined);
  }

  const input = new LineInput(io.stdin, io.stdout, terminal, () => { void onSigint(); });

  async function onSigint(): Promise<void> {
    if (quitting) return;
    quitting = true;
    if (!running) { input.end(); return; }
    out("interrupted");
    browserOpen = false;
    everLaunched = false;
    if (ownsChrome) await closeChrome();
    else { try { await browserFor({ ...base, headed })(undefined).close(); } catch { /* already closed */ } }
    out(totalsLine());
    exit(130);
  }
  const onProcessSigint = () => { void onSigint(); };

  function trySave(candidate: string): void {
    try {
      const p = saveKey(candidate, env);
      out(`Key saved to ${p} (mode 600). Run with --reset-key to change it.`);
    } catch (e) {
      out(`Could not save the key to ${configPath(env)}: ${(e as Error)?.message ?? String(e)}. Using it for this session only.`);
    }
  }

  // Key flow. Returns the key, or the exit code when the user wants to leave.
  async function promptForKey(): Promise<{ key: string } | { exit: number }> {
    const file = configPath(env);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const line = await input.readKey(`Paste your TypeSafe API key (saved to ${file}): `);
      if (line === null) { out(""); return { exit: 130 }; }
      const candidate = line.trim();
      if (/^\/(quit|exit)$/i.test(candidate)) { out("Bye."); return { exit: 0 }; }
      if (!looksLikeKey(candidate)) { out("That does not look like a key. A key has 20 or more characters and no spaces. Try again."); continue; }
      const r = await validate(candidate, base.model);
      if (r.ok) {
        trySave(candidate);
        out(`Key OK · model ${r.model}`);
        return { key: candidate };
      }
      if (r.kind === "rejected") { out(`Key rejected by TypeSafe (${r.message}). Try again.`); continue; }
      out(`Could not check the key: ${r.message}`);
      const yn = await input.ask("Save the key without checking it? [y/N] ");
      if (yn !== null && /^y(es)?$/i.test(yn.trim())) {
        trySave(candidate);
        return { key: candidate };
      }
    }
    out("Too many failed attempts.");
    return { exit: 4 };
  }

  async function startKey(): Promise<number | null> {
    if (opts.resetKey) forgetKey(env);
    const loaded = loadKey(env);
    if (loaded) {
      if (opts.resetKey && loaded.source === "env") envKeyNote();
      const r = await validate(loaded.key, base.model);
      if (r.ok) { key = loaded.key; keySource = loaded.source; out(`Key OK · model ${r.model} · from ${loaded.source}`); return null; }
      if (r.kind === "rejected") {
        if (loaded.source === "env") { out(`The TYPESAFE_API_KEY in the environment was rejected (${r.message}). Fix it or unset it.`); return 4; }
        out(`Saved key rejected (${r.message}).`);
      } else {
        out(`Warning: could not check the key (${r.message}). Continuing.`);
        key = loaded.key;
        keySource = loaded.source;
        return null;
      }
    }
    const p = await promptForKey();
    if ("exit" in p) return p.exit;
    key = p.key;
    keySource = "file";
    return null;
  }

  function clientFor(): TypeSafeClient {
    if (!client) client = new TypeSafeClient({ apiKey: key, defaultModel: base.model, logLevel: "off", fetch: transport.fetch });
    return client;
  }

  /**
   * Open or refresh the Jev connection. A task's own requests keep it warm, so the idle timer skips a running task.
   * The transport promises that warm never rejects. The catch protects the chat from one that breaks the promise:
   * the callers drop the result, and an unhandled rejection ends the process.
   */
  const warmJev = (): Promise<void> => {
    try { return transport.warm(clientFor().baseURL).catch(() => undefined); } catch { return Promise.resolve(); }
  };

  /** The URL of the open page, or undefined when no page is open or it shows about:blank. */
  async function currentUrl(): Promise<string | undefined> {
    let url: string | undefined;
    if (page && chrome?.client.closed) { await closeChrome(); return undefined; }
    if (page) {
      try { url = await page.url(); } catch { page = null; browserOpen = false; }
    } else if (browserOpen) {
      try { url = await chatBrowser().getUrl(); } catch { browserOpen = false; }
    }
    if (url !== undefined && (url.trim() === "" || url.trim() === "about:blank")) url = undefined;
    return url;
  }

  async function runTask(task: string): Promise<void> {
    // Set before the first await: an idle ping that starts here would queue ahead of the task's first request.
    running = true;
    const fallbackUrl = await currentUrl();
    const cfg: RunConfig = { ...base, task, keepOpen: true, headed, vars: { ...base.vars } };
    delete cfg.profile;
    if (profile !== undefined) cfg.profile = profile;
    if (fallbackUrl) cfg.fallbackUrl = fallbackUrl;
    const human = readlineHuman(input, io.stdout, terminal, pollMs);
    const ctx: RunContext = { browserFor: browserFor(cfg), human, log };
    process.once("SIGINT", onProcessSigint);
    let result: RunResult;
    try {
      if (deps.runner) result = await deps.runner(cfg, ctx);
      else if (!fastEngine) {
        result = await new Runner({ cfg, browserFor: ctx.browserFor, oracle: oracleFor(cfg.model, log), human, log }).run();
      } else {
        const runner = new FastRunner({
          cfg, profiles, chrome: (dir) => chromeFor(cfg, dir), ...(page ? { page } : {}), openPage: (c) => open(c, log), oracle: oracleFor(cfg.model, log), human, log, warm: warmJev,
        });
        result = await runner.run();
        if (runner.page) page = runner.page;
        if (result.error?.kind === "browser") await closeChrome();
        browserOpen = page !== null;
      }
    } catch (e) {
      result = emptyResult(task, cfg.goal ?? "act", cfg.model, cfg.engine ?? "cdp");
      if (e instanceof UsageError) { out(`✖ usage · ${e.message}`); out(metricsLine(result.stats)); return; }
      out(`✖ failed · internal: ${(e as Error)?.message ?? String(e)}`);
      out(metricsLine(result.stats));
      return;
    } finally {
      running = false;
      process.off("SIGINT", onProcessSigint);
    }
    // The Runner turns a UsageError from the plan into a failed/internal result. Show it as a usage error.
    if (result.outcome === "failed" && result.error?.kind === "internal" && /^unknown profile/.test(result.error.message)) {
      out(`✖ usage · ${result.error.message}`);
      out(metricsLine(emptyResult(task, cfg.goal ?? "act", cfg.model, cfg.engine ?? "cdp").stats));
      return;
    }
    if (deps.runner || !fastEngine) {
      if (isLaunchFailure(result)) { browserOpen = false; everLaunched = false; }
      else if (hadBrowser(result)) { browserOpen = true; everLaunched = true; }
      else if (result.error?.kind === "browser") browserOpen = false;
    }
    for (const line of resultLines(result)) out(line);
    totals.tasks += 1;
    totals.ms += result.stats.duration_ms;
    totals.jevMs += result.stats.jev_ms;
    totals.browserMs += result.stats.browser_ms;
    totals.input += result.stats.input_tokens;
    totals.output += result.stats.output_tokens;
    totals.requests += result.stats.jev_requests;
  }

  async function command(line: string): Promise<"continue" | "quit"> {
    const [head = "", ...rest] = line.split(/\s+/);
    const cmd = head.toLowerCase();
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "/help": io.stdout.write(CHAT_USAGE); return "continue";
      case "/quit": case "/exit": return "quit";
      case "/key": {
        const p = await promptForKey();
        if ("key" in p) {
          key = p.key;
          client = null;
          if (keySource === "env") envKeyNote();
          keySource = "file";
        } else if (p.exit === 130) return "quit";
        return "continue";
      }
      case "/headed": {
        const v = arg.toLowerCase();
        if (v !== "on" && v !== "off") { out("usage: /headed on|off"); return "continue"; }
        headed = v === "on";
        if (browserOpen || everLaunched) { await closeBrowser(); out("Closed the browser. The next task starts a new one."); }
        out(`headed ${v}`);
        return "continue";
      }
      case "/profile": {
        if (!arg) { out("usage: /profile <name|none>"); return "continue"; }
        profile = arg;
        if (browserOpen || everLaunched) { await closeBrowser(); out("Closed the browser. The next task starts a new one."); }
        out(`profile ${arg}`);
        return "continue";
      }
      case "/var": {
        const eq = arg.indexOf("=");
        if (eq <= 0) { out("usage: /var <key=value>"); return "continue"; }
        const k = arg.slice(0, eq).toLowerCase();
        base.vars[k] = arg.slice(eq + 1);
        out(`var ${k} set`);
        return "continue";
      }
      case "/stats":
        out(`${totalsLine()} · ${totals.requests} requests`);
        out(`engine ${base.engine ?? "cdp"} · browser session ${base.session} · run timeout ${base.runTimeoutMs} ms · step timeout ${base.stepTimeoutMs} ms`);
        return "continue";
      case "/url": {
        if (page) {
          try { out(await page.url()); } catch (e) { page = null; browserOpen = false; out(`no browser open (${(e as Error).message})`); }
          return "continue";
        }
        if (!browserOpen) { out("no browser open"); return "continue"; }
        try { out(await chatBrowser().getUrl()); } catch (e) { browserOpen = false; out(`no browser open (${(e as Error).message})`); }
        return "continue";
      }
      case "/close":
        if (!browserOpen && !everLaunched) { out("no browser open"); return "continue"; }
        await closeBrowser();
        out("browser closed");
        return "continue";
      default:
        await runTask(line);
        return "continue";
    }
  }

  input.open();
  /** Idle ping timer. unref'd: it never keeps the process alive. */
  let idlePing: NodeJS.Timeout | null = null;
  try {
    const keyExit = await startKey();
    if (keyExit !== null) return keyExit;
    // Open the connection now, while the user reads the prompt. Then keep it warm between tasks.
    void warmJev();
    idlePing = setInterval(() => { if (!running && !quitting) void warmJev(); }, IDLE_PING_MS);
    idlePing.unref();
    out(`jev-browser chat ${VERSION} · engine ${base.engine ?? "cdp"} · profile ${profile ?? "Parallelloop"} · ${headed ? "headed" : "headless"} · session ${base.session}`);
    out("Type a task. /help lists commands. /quit exits.");
    for (;;) {
      if (quitting) break;
      const line = await input.ask("jev> ");
      if (line === null) break;
      const trimmed = line.trim();
      if (!trimmed) continue;
      if ((await command(trimmed)) === "quit") break;
    }
    await closeBrowser();
    out(totalsLine());
  } finally {
    if (idlePing) clearInterval(idlePing);
    transport.close().catch(() => undefined);
    input.end();
    process.off("SIGINT", onProcessSigint);
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runChat(process.argv.slice(2)).then((code) => {
    process.stdout.write("", () => process.exit(code));
  }).catch((e: unknown) => {
    process.stderr.write(`fatal: ${(e as Error)?.stack ?? String(e)}\n`);
    process.exit(3);
  });
}
