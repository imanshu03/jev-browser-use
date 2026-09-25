// Setup of the MCP server: the package .env, the base RunConfig, input checks, the lazy Jev link, and the
// starter that runs one browse input on the shared BrowserSession. No SDK imports.
//
// Nothing here launches Chrome or opens a connection before the first browse call.
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { ProfileEntry } from "../browser.js";
import { loadKey } from "../config.js";
import { parseArgs } from "../cli.js";
import { FastRunner } from "../fast/loop.js";
import type { BrowserSession, SessionKey } from "../fast/session.js";
import type { Logger } from "../io.js";
import type { Oracle } from "../jev.js";
import { createOracle } from "../jev.js";
import { UsageError, prePlan } from "../plan.js";
import type { Transport } from "../transport.js";
import { createTransport } from "../transport.js";
import type { RunConfig } from "../types.js";
import type { BrowseInput, RunStarter } from "./runs.js";
import { MCP_ENV } from "./limits.js";

/** No TypeSafe API key in the environment, the package .env, or the saved config file. */
export class NoKeyError extends Error { override name = "NoKeyError"; }

const PACKAGE_NAME = "jev-browser-use";
const DEFAULT_MAX_STEPS = 25;

/**
 * The package root: `fromDir` or one of its 4 parents that has a package.json named jev-browser-use. null when
 * the server runs from a copy outside the repository, for example the Codex plugin cache.
 */
export function findPackageRoot(fromDir: string): string | null {
  let dir = path.resolve(fromDir);
  for (let up = 0; up <= 4; up++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: unknown };
      if (pkg.name === PACKAGE_NAME) return dir;
    } catch { /* no package.json here, or not JSON */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Read the .env of the package root (see findPackageRoot). Only keys that `env` does not define are set.
 * Returns the .env path, or null when none was read.
 */
export function loadPackageEnv(fromDir: string, env: NodeJS.ProcessEnv): string | null {
  const root = findPackageRoot(fromDir);
  if (root === null) return null;
  const file = path.join(root, ".env");
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  for (const [k, v] of Object.entries(parseEnv(text))) if (env[k] === undefined) env[k] = v;
  return file;
}

/**
 * The RunConfig every browse input starts from: parseArgs([], env), with bad environment values replaced by
 * the defaults. vercel becomes cdp. headed and keepOpen are true, and the session name is jev-mcp-<8 hex>.
 */
export function baseConfig(env: NodeJS.ProcessEnv, log: Logger): RunConfig {
  const e: NodeJS.ProcessEnv = { ...env };
  const engine = e["JEV_BROWSER_ENGINE"];
  if (engine !== undefined && engine !== "cdp" && engine !== "chromium" && engine !== "vercel") {
    log.warn(`JEV_BROWSER_ENGINE="${engine}" is not cdp, chromium, or vercel; using cdp`);
    delete e["JEV_BROWSER_ENGINE"];
  }
  const steps = e["JEV_BROWSER_MAX_STEPS"];
  if (steps !== undefined) {
    const n = Number(steps);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      log.warn(`JEV_BROWSER_MAX_STEPS="${steps}" is not a number from 1 to 100; using ${DEFAULT_MAX_STEPS}`);
      delete e["JEV_BROWSER_MAX_STEPS"];
    }
  }
  let cfg: RunConfig;
  try {
    cfg = parseArgs([], e);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    log.warn(`${err.message}; using the defaults`);
    delete e["JEV_BROWSER_ENGINE"];
    delete e["JEV_BROWSER_MAX_STEPS"];
    cfg = parseArgs([], e);
  }
  if (cfg.engine === "vercel") {
    log.warn("JEV_BROWSER_ENGINE=vercel is not supported by the MCP server; using cdp");
    cfg.engine = "cdp";
  }
  if (env["AGENT_BROWSER_SESSION"]) log.info(`AGENT_BROWSER_SESSION is ignored by the MCP server`);
  if (env["AGENT_BROWSER_PROFILE"]) log.info(`default profile from AGENT_BROWSER_PROFILE: ${env["AGENT_BROWSER_PROFILE"]}`);
  if (env["TYPESAFE_DEFAULT_MODEL"]) log.info(`model from TYPESAFE_DEFAULT_MODEL: ${env["TYPESAFE_DEFAULT_MODEL"]}`);
  if (e["JEV_BROWSER_MAX_STEPS"]) log.info(`max steps from JEV_BROWSER_MAX_STEPS: ${cfg.maxSteps}`);
  cfg.headed = true;
  cfg.keepOpen = true;
  cfg.session = `jev-mcp-${randomBytes(4).toString("hex")}`;
  return cfg;
}

/** The RunConfig of one browse input. profile = input.profile ?? base.profile; var keys are lowercased. */
export function configFor(input: BrowseInput, base: RunConfig): RunConfig {
  const cfg: RunConfig = {
    ...base, task: input.task, headed: input.headed, confirm: input.confirm, dryRun: input.dry_run,
    maxSteps: input.max_steps ?? base.maxSteps, engine: input.engine ?? (base.engine === "chromium" ? "chromium" : "cdp"),
    vars: Object.fromEntries(Object.entries(input.vars ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  };
  delete cfg.url;
  delete cfg.goal;
  delete cfg.fallbackUrl;
  delete cfg.profile;
  const profile = input.profile ?? base.profile;
  if (profile !== undefined) cfg.profile = profile;
  if (input.url !== undefined) cfg.url = input.url;
  if (input.goal !== undefined) cfg.goal = input.goal;
  return cfg;
}

/** null when the input is valid. url: http: or https:, or file: with JEV_MCP_ALLOW_FILE=1. profile: "none" or a listed name or directory. */
export function checkInput(input: BrowseInput, env: NodeJS.ProcessEnv, profiles: ProfileEntry[]): string | null {
  if (input.url !== undefined) {
    let u: URL;
    try { u = new URL(input.url); } catch { return `url "${input.url}" is not an absolute URL. Use an http or https URL`; }
    if (u.protocol === "file:") {
      if (env[MCP_ENV.allowFile] !== "1") return `url uses file:. Use an http or https URL, or set ${MCP_ENV.allowFile}=1 in the server environment`;
    } else if (u.protocol !== "http:" && u.protocol !== "https:") {
      return `url uses ${u.protocol} Use an http or https URL`;
    }
  }
  if (input.profile !== undefined) {
    const want = input.profile.toLowerCase();
    const known = want === "none" || profiles.some((p) => p.name.toLowerCase() === want || p.directory.toLowerCase() === want);
    if (!known) {
      const names = [...profiles.map((p) => `${p.name} (${p.directory})`), "none"].join(", ");
      return `unknown profile "${input.profile}". Use one of: ${names}`;
    }
  }
  return null;
}

/** The Jev connection. client() reads the key until it finds one, else throws NoKeyError. Nothing connects before that. */
export interface JevLink { client(): TypeSafeClient; warm(): Promise<void>; key(): string | null; close(): Promise<void> }

/**
 * `packageEnv`: the server can read the package .env, because it runs from the repository. When it runs from a
 * copy (the Codex plugin cache), the no-key error does not name the .env.
 */
export function createJevLink(env: NodeJS.ProcessEnv, log: Logger, transport?: Transport, opts: { packageEnv?: boolean } = {}): JevLink {
  let t: Transport | null = transport ?? null;
  const where = opts.packageEnv === false
    ? "Set TYPESAFE_API_KEY in the environment that starts this server (for the Codex plugin, the shell that starts Codex), or save a key with jev-chat. This copy of the server does not read a .env file"
    : "Set TYPESAFE_API_KEY in the server environment or in the package .env, or save a key with jev-chat";
  let client: TypeSafeClient | null = null;
  let key: string | null = null;
  const tr = (): Transport => (t ??= createTransport({ log }));
  const link: JevLink = {
    client() {
      if (client) return client;
      const loaded = loadKey(env);
      if (!loaded) throw new NoKeyError(`no TypeSafe API key. ${where}. Then call browse again`);
      key = loaded.key;
      const base = env["TYPESAFE_BASE_URL"];
      client = new TypeSafeClient({ apiKey: loaded.key, logLevel: "off", fetch: tr().fetch, ...(base ? { baseURL: base } : {}) });
      log.info(`jev key from ${loaded.source}`);
      return client;
    },
    async warm() {
      try { await tr().warm(link.client().baseURL); } catch { /* no key yet, or the warm failed; the first request connects */ }
    },
    key() { return key; },
    async close() { if (t) await t.close().catch(() => undefined); },
  };
  return link;
}

export interface StarterDeps {
  session: BrowserSession; jev: JevLink; base: RunConfig; env: NodeJS.ProcessEnv;
  profiles: (engine: "cdp" | "chromium") => ProfileEntry[];
  oracle?: (model: string, log: Logger) => Oracle;
}

/**
 * Run one browse input on the shared session. The profile is resolved before the run, so a different profile
 * closes Chrome first, and a profile that Jev must decide closes it too. The run then launches the right one.
 */
export function fastStarter(d: StarterDeps): RunStarter {
  return async (input, hooks) => {
    const cfg = configFor(input, d.base);
    const engine = cfg.engine === "chromium" ? "chromium" : "cdp";
    const profiles = d.profiles(engine);
    let key: SessionKey | null = null;
    try {
      const pre = prePlan(cfg, profiles);
      if (pre.profileDirectory !== null) key = { engine, headed: cfg.headed, profileDirectory: pre.profileDirectory ?? null };
    } catch { /* an unknown profile: the runner reports it */ }
    await d.session.prepare(key);
    const url = await d.session.currentUrl();
    if (url !== undefined) cfg.fallbackUrl = url;
    const epoch = d.session.epoch;
    const page = d.session.page;
    const oracle = (d.oracle ?? ((model: string, log: Logger) => createOracle(d.jev.client(), model, log)))(cfg.model, hooks.log);
    // Text that an earlier run typed and did not send stays in its field. The gate of this run covers it too.
    const runner = new FastRunner({
      cfg, profiles, chrome: d.session.chromeFor(cfg), ...(page ? { page, unsent: d.session.unsent } : {}), openPage: (c) => d.session.openPage(c),
      oracle, human: hooks.human, log: hooks.log, warm: () => d.jev.warm(),
      text: hooks.text, signal: hooks.signal, hints: hooks.hints, fromAssistant: true,
    });
    const result = await runner.run();
    hooks.untyped?.(runner.untypedText());
    d.session.keep(runner.page, epoch, runner.unsentText());
    if (result.error?.kind === "browser") await d.session.close();
    return result;
  };
}
