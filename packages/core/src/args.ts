// Shared run settings of every front end: argv and env to RunConfig, --geo and --browser values, the text model, the version.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_KINDS, browserOf } from "./fast/chrome.js";
import type { BrowserKind } from "./fast/chrome.js";
import type { GeoPoint } from "./fast/model.js";
import type { Logger, TextSource } from "./io.js";
import { UsageError } from "./plan.js";
import type { Goal, RunConfig } from "./types.js";
import { createTextModel, textModelFromEnv } from "./writer.js";

export { UsageError };

export const USAGE = `jev-browser "<task>" [options]

Options:
  --engine <cdp|chromium|vercel>     cdp: direct Chrome CDP. chromium: Chromium over CDP. vercel: agent-browser. Default: cdp (env JEV_BROWSER_ENGINE).
  --browser <chrome|edge|brave|chromium>  cdp: the browser to launch (env JEV_BROWSER). Default: the first installed, in that order.
  --profile <name|dir|none>  Chrome profile. Overrides a profile named in the task. Default: Parallelloop. none: a temporary profile.
  --refresh-profile          cdp/chromium: copy the browser profile again, even when a copy exists.
  --chrome-bin <path>        cdp/chromium: browser binary override (env JEV_CHROME_BIN / JEV_EDGE_BIN / JEV_BRAVE_BIN / JEV_CHROMIUM_BIN).
  --url <start url>          Start page. Overrides URL resolution.
  --goal <act|extract|check> Skip the goal question.
  --headed                   Show the window. Enables the pause hand-off.
  --cdp <port>               Attach to a running Chrome. cdp/chromium: over its WebSocket. vercel: through agent-browser. Replaces --profile.
  --geo <lat,lon[,accuracy]> cdp/chromium: the location that pages get from the geolocation API ("Detect my location").
                             Degrees; accuracy in metres, default 50. Example: --geo 12.9352,77.6245
  --var <key=value>          A value Jev may type. Repeatable. Keys with pass/pin/otp/secret/token/code are secret,
                             except pin_code and postal_code.
  --max-steps <n>            Default 25, max 100.
  --step-timeout <ms>        Per browser command. Default 30000.
  --run-timeout <ms>         Default 600000.
  --pause-timeout <ms>       Default 300000.
  --confirm <auto|always|never|autonomous>  auto: destructive asks. always: submit asks too. never: destructive -> blocked.
                             autonomous: no action asks or blocks for a person; each step record of such an action
                             holds an "unattended" audit. cdp and chromium only.
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

/** The directory of the jev-core package. */
export function packageDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** The agent-browser binary of the nearest node_modules/.bin up from this package (a workspace hoists it to the root). */
export function agentBrowserBin(from: string = packageDir(), exists: (p: string) => boolean = existsSync): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const bin = path.join(dir, "node_modules", ".bin", "agent-browser");
    if (exists(bin)) return bin;
    if (path.dirname(dir) === dir) return path.join(from, "node_modules", ".bin", "agent-browser");
  }
}

/** A decimal number: digits with an optional sign and fraction. No exponent, no hex, no empty text. */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * The value of `--geo`: "lat,lon" or "lat,lon,accuracy". Latitude -90..90, longitude -180..180, accuracy in metres
 * 0..100000. Throws UsageError for any other value.
 */
export function parseGeo(value: string, flag = "--geo"): GeoPoint {
  const parts = value.split(",").map((p) => p.trim());
  const usage = `${flag} needs lat,lon or lat,lon,accuracy (for example 12.9352,77.6245)`;
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !DECIMAL.test(p))) throw new UsageError(usage);
  const [lat, lon, acc] = parts.map(Number) as [number, number, number | undefined];
  if (lat < -90 || lat > 90) throw new UsageError(`${flag}: latitude must be between -90 and 90`);
  if (lon < -180 || lon > 180) throw new UsageError(`${flag}: longitude must be between -180 and 180`);
  if (acc !== undefined && (acc < 0 || acc > 100_000)) throw new UsageError(`${flag}: accuracy must be between 0 and 100000 metres`);
  return { latitude: lat, longitude: lon, ...(acc !== undefined ? { accuracy: acc } : {}) };
}

/** A `--browser` or JEV_BROWSER value. */
export function browserKind(value: string, flag: string): BrowserKind {
  const v = value.toLowerCase();
  if (!(BROWSER_KINDS as readonly string[]).includes(v)) throw new UsageError(`${flag} must be ${BROWSER_KINDS.join(", ")}`);
  return v as BrowserKind;
}

/** The `browser` launch option of a run; absent when no browser is installed, so the launch reports that. */
export function browserOpt(cfg: RunConfig, env: NodeJS.ProcessEnv): { browser?: BrowserKind } {
  const b = browserOf(cfg, env);
  return b ? { browser: b } : {};
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): RunConfig {
  const positional: string[] = [];
  const envEngine = env["JEV_BROWSER_ENGINE"];
  if (envEngine !== undefined && envEngine !== "cdp" && envEngine !== "chromium" && envEngine !== "vercel") throw new UsageError("JEV_BROWSER_ENGINE must be cdp, chromium, or vercel");
  const cfg: RunConfig = {
    task: "", engine: envEngine ?? "cdp", headed: false, maxSteps: Number(env["JEV_BROWSER_MAX_STEPS"] ?? 25), stepTimeoutMs: 30_000, runTimeoutMs: 600_000, pauseTimeoutMs: 300_000,
    confirm: "auto", dryRun: false, session: env["AGENT_BROWSER_SESSION"] ?? `jev-${randomBytes(4).toString("hex")}`,
    model: env["TYPESAFE_DEFAULT_MODEL"] ?? "jev-latest", logLevel: "info", logJson: false, keepOpen: false,
    agentBrowserBin: env["JEV_BROWSER_BIN"] ?? agentBrowserBin(), vars: {},
  };
  if (env["AGENT_BROWSER_PROFILE"]) cfg.profile = env["AGENT_BROWSER_PROFILE"];
  const envBrowser = env["JEV_BROWSER"];
  if (envBrowser) cfg.browser = browserKind(envBrowser, "JEV_BROWSER");
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
      case "--browser": cfg.browser = browserKind(next(i, a), a); i++; break;
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
      case "--geo": cfg.geo = parseGeo(next(i, a), a); i++; break;
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
        if (c !== "auto" && c !== "always" && c !== "never" && c !== "autonomous") throw new UsageError("--confirm must be auto, always, never, or autonomous");
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
  // --engine chromium is the old name of --browser chromium.
  if (cfg.engine === "chromium" && cfg.browser !== undefined && cfg.browser !== "chromium") throw new UsageError(`--engine chromium launches Chromium; use --engine cdp --browser ${cfg.browser}`);
  // The vercel engine has no audit of the actions that a run does with no dialog.
  if (cfg.confirm === "autonomous" && cfg.engine === "vercel") throw new UsageError("--confirm autonomous needs --engine cdp or chromium");
  // agent-browser has no geolocation override.
  if (cfg.geo && cfg.engine === "vercel") throw new UsageError("--geo needs --engine cdp or chromium");
  // An env value such as "abc" gives NaN, which the old range check let through.
  if (!Number.isFinite(cfg.maxSteps) || cfg.maxSteps > 100 || cfg.maxSteps < 1) throw new UsageError("--max-steps must be between 1 and 100");
  cfg.task = positional.join(" ").trim();
  return cfg;
}

/**
 * The text model of the environment (JEV_TEXT_MODEL, JEV_TEXT_API_KEY; src/writer.ts) as the text source of a fast run:
 * it writes new text for fields that can take it, as the text helper of browser-use/jev-ultrafast does. Off: no text
 * source, and a field without a value in the task blocks with the hint to pass --var.
 */
export function textModelDeps(env: NodeJS.ProcessEnv, log: Logger): { text?: TextSource } {
  const cfg = textModelFromEnv(env);
  if (!cfg) return {};
  log.info(`text model ${cfg.model} at ${new URL(cfg.baseUrl).host} writes new field text`);
  return { text: createTextModel(cfg, log) };
}
