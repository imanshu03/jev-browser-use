// jev-scrape: build, run, and heal saved scrapers. Parse argv, wire the browser, Jev, and the LLM, print the result.
// stdout carries only the output (rows, a result, a file); logs go to stderr. Rows go to stdout or the --out file and
// nowhere else. Exit: 0 ok, 2 blocked (a person is needed), 3 failed, 4 usage.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProfileEntry } from "../browser.js";
import { defaultUserDataDir, listProfiles } from "../fast/chrome.js";
import type { GeoPoint } from "../fast/model.js";
import { loadAll } from "../fast/read.js";
import type { Human, Logger } from "../io.js";
import { createHuman, createLogger } from "../io.js";
import { UsageError } from "../plan.js";
import { DEFAULT_PROFILE_NAME } from "../types.js";
import type { AuthorOptions } from "./author.js";
import { authorScraper, secretProblem } from "./author.js";
import { toCsv } from "./csv.js";
import { loadOptions } from "./heal.js";
import type { BrowserOptions } from "./launch.js";
import { cliBrowser, envBrowser, lazyNavigator, navBase, parseGeo, resolveProfile } from "./launch.js";
import type { LlmBackend } from "./llm.js";
import { llmFromEnv, llmTimeoutMs } from "./llm.js";
import { buildContext, contextChars } from "./prompt.js";
import { replaySteps, stepTimeoutMs } from "./replay.js";
import type { NavigatorDeps, RunScraperOptions, ScrapeBrowser } from "./runner.js";
import { runParams, runScraper, specFields } from "./runner.js";
import type { HealMode, ScrapeResult, ScraperSpec } from "./spec.js";
import { LOAD_DEFAULTS, NAME_RE, PARAM_RE, SCRAPE_EXIT, SpecError, fillUrl, placeholders } from "./spec.js";
import { deleteScraper, listScrapers, loadScraper, saveScraper, scraperPath } from "./store.js";
import { LIMITS } from "../types.js";

export const VERSION = "0.1.0";

export const USAGE = `jev-scrape <command> [options]

Commands:
  new <name> --task "<task>" --want "<rows and fields, in words>" [--url <start url>] [--param k=v]...
             [--no-nav] [--force] [--max-steps n] [--headed] [--geo lat,lon[,acc]] [--profile <name|dir>]
             [--out <file>] [--format json|csv]
      Build a scraper: Jev reaches the page (unless --no-nav), the LLM writes the extraction, code tests it, and the
      file is saved. --no-nav needs --url. {param} placeholders in --task and --url take the --param values.
  run <name|path> [--param k=v]... [--out <file>] [--format json|csv] [--no-heal | --heal full|code|none]
             [--headed] [--geo lat,lon[,acc]] [--profile <name|dir>]
      Replay a scraper with no model calls. When the site changed, it heals (L1 code, L2 Jev, L3 LLM) and saves the
      new version.
  read (--url <url> | <name|path> [--param k=v]...) [--load] [--context] [--headed] [--geo ...] [--profile ...]
      Print what the page reader sees (debugging). --context: the LLM page context.
  list                 The saved scrapers.
  show <name|path>     A scraper file.
  rm <name|path>       Delete a scraper file.

Common: --log-level info|debug, --log-json, --help, --version

Output: stdout is the result JSON. --format csv without --out: stdout is the CSV rows and the result goes to stderr.
--out <file>: the rows go to the file; stdout is the result without rows, with "out".
Exit: 0 ok, 2 blocked (a person is needed), 3 failed, 4 usage.
Files: $XDG_CONFIG_HOME/jev-browser/scrapers/<name>.json (default ~/.config). No rows or pages are stored.
Environment: TYPESAFE_API_KEY (Jev, for new and L2), JEV_SCRAPE_LLM claude|text|off, JEV_SCRAPE_MODEL (default
claude-sonnet-5), JEV_SCRAPE_CLAUDE_BIN, JEV_SCRAPE_LLM_TIMEOUT_MS, JEV_SCRAPE_CONTEXT_CHARS, JEV_SCRAPE_STEP_MS.
`;

export interface Args {
  command: string;
  target?: string;
  task?: string;
  want?: string;
  url?: string;
  params: Record<string, string>;
  noNav: boolean;
  force: boolean;
  maxSteps?: number;
  headed: boolean;
  geo?: GeoPoint;
  profile?: string;
  out?: string;
  format: "json" | "csv";
  heal: HealMode;
  load: boolean;
  context: boolean;
  logLevel: "info" | "debug";
  logJson: boolean;
}

const COMMANDS = new Set(["new", "run", "read", "list", "show", "rm"]);
/** The flags of each command, besides the common ones. */
const FLAGS: Record<string, Set<string>> = {
  new: new Set(["--task", "--want", "--url", "--param", "--no-nav", "--force", "--max-steps", "--headed", "--geo", "--profile", "--out", "--format"]),
  run: new Set(["--param", "--out", "--format", "--no-heal", "--heal", "--headed", "--geo", "--profile"]),
  read: new Set(["--url", "--param", "--load", "--context", "--headed", "--geo", "--profile"]),
  list: new Set(),
  show: new Set(),
  rm: new Set(),
};
const COMMON = new Set(["--log-level", "--log-json", "--help", "--version"]);

export function parseArgs(argv: string[]): Args {
  const [command = "", ...rest] = argv;
  if (!COMMANDS.has(command)) throw new UsageError(command ? `unknown command ${command}` : "missing command");
  const a: Args = { command, params: {}, noNav: false, force: false, headed: false, format: "json", heal: "full", load: false, context: false, logLevel: "info", logJson: false };
  const allowed = FLAGS[command] as Set<string>;
  const positional: string[] = [];
  const next = (i: number, flag: string): string => {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < rest.length; i++) {
    const f = rest[i] as string;
    if (!f.startsWith("--")) { positional.push(f); continue; }
    if (!allowed.has(f) && !COMMON.has(f)) throw new UsageError(`${f} is not a flag of ${command}`);
    switch (f) {
      case "--task": a.task = next(i, f); i++; break;
      case "--want": a.want = next(i, f); i++; break;
      case "--url": a.url = next(i, f); i++; break;
      case "--param": {
        const kv = next(i, f); i++;
        const eq = kv.indexOf("=");
        const key = eq > 0 ? kv.slice(0, eq) : "";
        if (!PARAM_RE.test(key)) throw new UsageError("--param needs key=value; a key is a-z, 0-9 and _, starting with a letter");
        a.params[key] = kv.slice(eq + 1);
        break;
      }
      case "--no-nav": a.noNav = true; break;
      case "--force": a.force = true; break;
      case "--max-steps": {
        const n = Number(next(i, f)); i++;
        if (!Number.isInteger(n) || n < 1 || n > 100) throw new UsageError("--max-steps must be a number between 1 and 100");
        a.maxSteps = n; break;
      }
      case "--headed": a.headed = true; break;
      case "--geo": a.geo = parseGeo(next(i, f)); i++; break;
      case "--profile": a.profile = next(i, f); i++; break;
      case "--out": a.out = next(i, f); i++; break;
      case "--format": {
        const v = next(i, f); i++;
        if (v !== "json" && v !== "csv") throw new UsageError("--format must be json or csv");
        a.format = v; break;
      }
      case "--no-heal": a.heal = "none"; break;
      case "--heal": {
        const v = next(i, f); i++;
        if (v !== "full" && v !== "code" && v !== "none") throw new UsageError("--heal must be full, code, or none");
        a.heal = v; break;
      }
      case "--load": a.load = true; break;
      case "--context": a.context = true; break;
      case "--log-level": {
        const v = next(i, f); i++;
        if (v !== "info" && v !== "debug") throw new UsageError("--log-level must be info or debug");
        a.logLevel = v; break;
      }
      case "--log-json": a.logJson = true; break;
      default: break;
    }
  }
  if (positional.length > 1) throw new UsageError(`${command} takes one name, not: ${positional.join(" ")}`);
  if (positional[0] !== undefined) a.target = positional[0];
  if (["new", "run", "show", "rm"].includes(command) && !a.target) throw new UsageError(`${command} needs a scraper name`);
  if (command === "read" && !a.url === !a.target) throw new UsageError("read needs --url <url> or a scraper name (one of them)");
  if (command === "new") {
    if (!NAME_RE.test(a.target ?? "")) throw new UsageError(`"${a.target}" is not a scraper name: use 1-63 characters a-z, 0-9, _ and -`);
    if (!a.task?.trim()) throw new UsageError("new needs --task \"<task>\"");
    if (!a.want?.trim()) throw new UsageError("new needs --want \"<rows and fields, in words>\"");
    if (a.noNav && !a.url) throw new UsageError("--no-nav needs --url <start url>");
    const missing = [...placeholders(a.task), ...placeholders(a.url ?? "")].filter((p) => !a.params[p]?.trim());
    if (missing.length > 0) throw new UsageError(`{${missing[0]}} has no value: pass --param ${missing[0]}=<value>`);
  }
  return a;
}

export interface MainIo { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream; stdin: NodeJS.ReadStream; env: NodeJS.ProcessEnv }

/** Test seams. Absent: the real parts. */
export interface ScrapeDeps {
  browser?: (opts: BrowserOptions) => ScrapeBrowser;
  run?: (spec: ScraperSpec, opts: RunScraperOptions) => Promise<ScrapeResult>;
  author?: (opts: AuthorOptions) => Promise<{ result: ScrapeResult; spec: ScraperSpec | null }>;
  /** The LLM backend; null: none. Absent: llmFromEnv. */
  llm?: LlmBackend | null;
  /** The Jev navigator; null: none. Absent: a lazy one when TYPESAFE_API_KEY is set. */
  navigator?: NavigatorDeps | null;
  profiles?: ProfileEntry[];
  human?: Human;
  now?: () => number;
}

const exitOf = (s: ScrapeResult["status"]): number => (s === "ok" ? SCRAPE_EXIT.ok : s === "blocked" ? SCRAPE_EXIT.blocked : SCRAPE_EXIT.failed);

/** Write a file through a temporary file and a rename. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

/** Print a result by the output rules. Returns the exit code. */
function emit(result: ScrapeResult, a: Args, io: MainIo, log: Logger, columns: string[]): number {
  const { rows, ...summary } = result;
  if (a.out) {
    const file = path.resolve(a.out);
    // A run that failed leaves an earlier rows file as it was.
    if (result.status === "ok") writeAtomic(file, a.format === "csv" ? toCsv(rows, columns) : JSON.stringify(rows, null, 2) + "\n");
    io.stdout.write(JSON.stringify({ ...summary, ...(result.status === "ok" ? { out: file } : {}) }, null, 2) + "\n");
  } else if (a.format === "csv") {
    io.stdout.write(toCsv(rows, columns));
    log.info(`result ${JSON.stringify(summary)}`);
  } else {
    io.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
  return exitOf(result.status);
}

function profilesOf(io: MainIo, deps: ScrapeDeps): ProfileEntry[] {
  return deps.profiles ?? listProfiles(defaultUserDataDir(io.env, undefined, envBrowser(io.env)));
}

/** The browser of a command: the profile `want`, and the geolocation of --geo, else `geo` (the geo of the scraper file). */
function browserFor(a: Args, want: string, geo: ScraperSpec["geo"], io: MainIo, log: Logger, deps: ScrapeDeps): ScrapeBrowser {
  const profile = resolveProfile(want, profilesOf(io, deps));
  const where: GeoPoint | undefined = a.geo ?? (geo ? { latitude: geo.latitude, longitude: geo.longitude, ...(geo.accuracy !== undefined ? { accuracy: geo.accuracy } : {}) } : undefined);
  const kind = envBrowser(io.env);
  const opts: BrowserOptions = { headed: a.headed, ...(kind ? { browser: kind } : {}), env: io.env, log, ...(profile ? { profileDirectory: profile.directory } : {}), ...(where ? { geo: where } : {}) };
  return deps.browser ? deps.browser(opts) : cliBrowser(opts);
}

/** Close the browser on SIGINT, then exit 130. Returns the remover. */
function onSigint(browser: ScrapeBrowser, abort: AbortController, log: Logger): () => void {
  let fired = false;
  const handler = (): void => {
    if (fired) return;
    fired = true;
    log.warn("SIGINT: closing the browser");
    abort.abort();
    browser.close().catch(() => undefined).finally(() => process.exit(130));
  };
  process.once("SIGINT", handler);
  return () => { process.off("SIGINT", handler); };
}

const secretsOf = (env: NodeJS.ProcessEnv): string[] => [env["TYPESAFE_API_KEY"], env["JEV_TEXT_API_KEY"]].filter((s): s is string => typeof s === "string" && s.length > 0);

async function commandRun(a: Args, io: MainIo, log: Logger, deps: ScrapeDeps): Promise<number> {
  const { spec, path: file } = loadScraper(a.target as string, io.env);
  const params = runParams(spec, a.params);
  const browser = browserFor(a, a.profile ?? spec.profile ?? DEFAULT_PROFILE_NAME, spec.geo, io, log, deps);
  const human = deps.human ?? createHuman({ stdin: io.stdin, stderr: io.stderr, forceNonInteractive: false });
  const nav = deps.navigator !== undefined ? { navigator: deps.navigator, close: async () => undefined }
    : lazyNavigator(io.env, log, human, profilesOf(io, deps), navBase(io.env, { headed: a.headed, logLevel: a.logLevel, logJson: a.logJson }));
  const llm = deps.llm !== undefined ? deps.llm : a.heal === "full" ? llmFromEnv(io.env, log) : null;
  const abort = new AbortController();
  const off = onSigint(browser, abort, log);
  let result: ScrapeResult;
  // The rows of a healed run have the fields of the healed version: the CSV header comes from it.
  let last = spec;
  try {
    result = await (deps.run ?? runScraper)(spec, {
      params, heal: a.heal, browser, llm, human, headed: a.headed, log, signal: abort.signal,
      ...(nav.navigator ? { navigator: nav.navigator } : {}), ...(deps.now ? { now: deps.now } : {}),
      save: (s) => { last = s; return saveScraper(s, io.env, { path: file, overwrite: true }); },
      stepTimeoutMs: stepTimeoutMs(io.env), llmTimeoutMs: llmTimeoutMs(io.env), contextChars: contextChars(io.env), secrets: secretsOf(io.env),
      allowFile: true,
    });
  } finally {
    off();
    await browser.close().catch(() => undefined);
    await nav.close();
  }
  return emit(result, a, io, log, specFields(last));
}

async function commandNew(a: Args, io: MainIo, log: Logger, deps: ScrapeDeps): Promise<number> {
  const secret = secretProblem(a.task as string, a.params);
  if (secret) throw new UsageError(secret);
  const name = a.target as string;
  const file = scraperPath(name, io.env);
  if (!a.force && fs.existsSync(file)) throw new UsageError(`the scraper ${name} exists (${file}): pass --force to replace it`);
  const llm = deps.llm !== undefined ? deps.llm : llmFromEnv(io.env, log);
  if (!llm) throw new UsageError("new needs an LLM: install Claude Code (claude on PATH or JEV_SCRAPE_CLAUDE_BIN), or set JEV_SCRAPE_LLM=text with JEV_TEXT_MODEL and JEV_TEXT_API_KEY");
  if (!a.noNav && deps.navigator === undefined && !io.env["TYPESAFE_API_KEY"]) throw new UsageError("new needs TYPESAFE_API_KEY for the Jev navigation (put it in .env), or --no-nav with --url");
  const human = deps.human ?? createHuman({ stdin: io.stdin, stderr: io.stderr, forceNonInteractive: false });
  const nav = deps.navigator !== undefined ? { navigator: deps.navigator, close: async () => undefined }
    : a.noNav ? { navigator: null, close: async () => undefined }
      : lazyNavigator(io.env, log, human, profilesOf(io, deps), navBase(io.env, { headed: a.headed, ...(a.maxSteps !== undefined ? { maxSteps: a.maxSteps } : {}), logLevel: a.logLevel, logJson: a.logJson }));
  const browser = browserFor(a, a.profile ?? DEFAULT_PROFILE_NAME, undefined, io, log, deps);
  const abort = new AbortController();
  const off = onSigint(browser, abort, log);
  let out: { result: ScrapeResult; spec: ScraperSpec | null };
  try {
    out = await (deps.author ?? authorScraper)({
      name, task: a.task as string, want: a.want as string, params: a.params, noNav: a.noNav, headed: a.headed, browser, llm, log, signal: abort.signal,
      navigator: nav.navigator, save: (s) => saveScraper(s, io.env, { path: file, overwrite: a.force }),
      ...(a.url ? { url: a.url } : {}), ...(a.maxSteps !== undefined ? { maxSteps: a.maxSteps } : {}), ...(a.profile ? { profile: a.profile } : {}),
      ...(a.geo ? { geo: a.geo } : {}), ...(deps.now ? { now: deps.now } : {}),
      stepTimeoutMs: stepTimeoutMs(io.env), llmTimeoutMs: llmTimeoutMs(io.env), contextChars: contextChars(io.env), secrets: secretsOf(io.env),
    });
  } finally {
    off();
    await browser.close().catch(() => undefined);
    await nav.close();
  }
  return emit(out.result, a, io, log, out.spec ? specFields(out.spec) : []);
}

async function commandRead(a: Args, io: MainIo, log: Logger, deps: ScrapeDeps): Promise<number> {
  const loaded = a.target ? loadScraper(a.target, io.env) : null;
  const params = loaded ? runParams(loaded.spec, a.params) : a.params;
  const browser = browserFor(a, a.profile ?? loaded?.spec.profile ?? DEFAULT_PROFILE_NAME, loaded?.spec.geo, io, log, deps);
  const abort = new AbortController();
  const off = onSigint(browser, abort, log);
  try {
    const page = await browser.page();
    if (loaded) {
      await page.navigate(fillUrl(loaded.spec.start_url, params), LIMITS.openTimeoutMs);
      const r = await replaySteps(page, loaded.spec.steps, params, { log, stepTimeoutMs: stepTimeoutMs(io.env), headed: a.headed, signal: abort.signal });
      if (!r.ok) log.warn(`replay: ${r.reason}; reading the page as it is`);
    } else await page.navigate(a.url as string, LIMITS.openTimeoutMs);
    if (a.load) {
      const report = await loadAll(page, loadOptions({ mode: "scroll", ...LOAD_DEFAULTS }));
      log.info(`load: ${report.scrolls} scrolls, end ${report.end}`);
    }
    if (!page.read) throw new Error("this page cannot be read");
    const read = await page.read({ text: true });
    if (a.context) io.stdout.write(buildContext(read, loaded?.spec.want ?? "", contextChars(io.env), { secrets: secretsOf(io.env) }) + "\n");
    else io.stdout.write(JSON.stringify(read, null, 2) + "\n");
    return SCRAPE_EXIT.ok;
  } finally {
    off();
    await browser.close().catch(() => undefined);
  }
}

export async function main(argv: string[], io: MainIo = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, env: process.env }, deps: ScrapeDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.length === 0) { io.stderr.write(USAGE); return argv.includes("--help") ? SCRAPE_EXIT.ok : SCRAPE_EXIT.usage; }
  if (argv.includes("--version")) { io.stdout.write(`jev-scrape ${VERSION}\n`); return SCRAPE_EXIT.ok; }
  let a: Args;
  try { a = parseArgs(argv); } catch (e) {
    if (e instanceof UsageError) { io.stderr.write(`error: ${e.message}\n\n${USAGE}`); return SCRAPE_EXIT.usage; }
    throw e;
  }
  const log = createLogger(io.stderr, a.logLevel, a.logJson);
  try {
    switch (a.command) {
      case "run": return await commandRun(a, io, log, deps);
      case "new": return await commandNew(a, io, log, deps);
      case "read": return await commandRead(a, io, log, deps);
      case "list": io.stdout.write(JSON.stringify(listScrapers(io.env), null, 2) + "\n"); return SCRAPE_EXIT.ok;
      case "show": {
        const { spec, path: file } = loadScraper(a.target as string, io.env);
        log.info(`scraper file ${file}`);
        io.stdout.write(JSON.stringify(spec, null, 2) + "\n");
        return SCRAPE_EXIT.ok;
      }
      case "rm": {
        const file = scraperPath(a.target as string, io.env);
        if (!deleteScraper(a.target as string, io.env)) { io.stderr.write(`error: no scraper at ${file}\n`); return SCRAPE_EXIT.failed; }
        io.stdout.write(JSON.stringify({ deleted: true, path: file }, null, 2) + "\n");
        return SCRAPE_EXIT.ok;
      }
      default: return SCRAPE_EXIT.usage;
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof SpecError) { io.stderr.write(`error: ${e.message}\n`); return SCRAPE_EXIT.usage; }
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT" && /^no scraper /.test((e as Error).message)) { io.stderr.write(`error: ${(e as Error).message}\n`); return SCRAPE_EXIT.usage; }
    io.stderr.write(`error: ${(e as Error)?.message ?? String(e)}\n`);
    return SCRAPE_EXIT.failed;
  }
}

// Only a direct run of this file starts the CLI.
const entry = fileURLToPath(import.meta.url);
const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === entry;
if (isMain) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((e: unknown) => {
    process.stderr.write(`fatal: ${(e as Error)?.stack ?? String(e)}\n`);
    process.exitCode = SCRAPE_EXIT.failed;
  });
}
