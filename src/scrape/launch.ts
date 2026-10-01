// The browser and the Jev navigator of the jev-scrape CLI. Chrome starts on the first page() call, on the copy of the
// named profile (default "Parallelloop"). The Jev client starts only when L2 sends its first request, so a plain run
// needs no TYPESAFE_API_KEY.
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { randomBytes } from "node:crypto";
import type { ProfileEntry } from "../browser.js";
import { browserKind, parseGeo as parseCliGeo, textModelDeps } from "../cli.js";
import { LAUNCH_WAIT_MS, browserOf, launchChrome } from "../fast/chrome.js";
import type { BrowserKind } from "../fast/chrome.js";
import type { Chrome, ChromeLaunchOptions, GeoPoint, Page, PageOptions } from "../fast/model.js";
import { openPage } from "../fast/page.js";
import type { Human, Logger } from "../io.js";
import type { Oracle } from "../jev.js";
import { createOracle } from "../jev.js";
import { UsageError } from "../plan.js";
import { createTransport } from "../transport.js";
import type { Transport } from "../transport.js";
import type { RunConfig } from "../types.js";
import { LIMITS } from "../types.js";
import type { NavigatorDeps, ScrapeBrowser } from "./runner.js";

/** The profile of a name or a directory (case-insensitive). "none" is a temporary profile (null). */
export function resolveProfile(want: string, profiles: readonly ProfileEntry[]): ProfileEntry | null {
  if (want.toLowerCase() === "none") return null;
  const low = want.toLowerCase();
  const hit = profiles.find((p) => p.name.toLowerCase() === low || p.directory.toLowerCase() === low);
  if (!hit) throw new UsageError(`unknown profile "${want}". Available: ${profiles.map((p) => `${p.name} (${p.directory})`).join(", ") || "none"}`);
  return hit;
}

/**
 * Parse `lat,lon[,accuracy]` with the rules of jev-browser's --geo (plain decimals only). The scraper file needs an
 * accuracy above 0. Throws UsageError for a bad value.
 */
export function parseGeo(text: string): GeoPoint {
  const geo = parseCliGeo(text, "--geo");
  if (geo.accuracy === 0) throw new UsageError("--geo: accuracy must be above 0 metres");
  return geo;
}

/** Select JEV_BROWSER, the saved browser, the Chromium engine alias, or the first installed browser. */
export function envBrowser(env: NodeJS.ProcessEnv, saved?: BrowserKind): BrowserKind | undefined {
  const named = env["JEV_BROWSER"];
  return browserOf({ engine: env["JEV_BROWSER_ENGINE"], ...(named ? { browser: browserKind(named, "JEV_BROWSER") } : saved ? { browser: saved } : {}) }, env);
}

export interface BrowserOptions {
  headed: boolean;
  /** The browser to launch. Absent: the first installed one. */
  browser?: BrowserKind;
  /** The profile directory ("Profile 14"); absent is a temporary profile. */
  profileDirectory?: string;
  geo?: GeoPoint;
  env: NodeJS.ProcessEnv;
  log: Logger;
}

export interface BrowserDeps {
  launch?: (opts: ChromeLaunchOptions) => Promise<Chrome>;
  open?: (chrome: Chrome, opts: PageOptions) => Promise<Page>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** One Chrome and one tab for one command. Close ends both; a close during the launch waits for it (LAUNCH_WAIT_MS). */
export function cliBrowser(o: BrowserOptions, deps: BrowserDeps = {}): ScrapeBrowser {
  const launch = deps.launch ?? launchChrome;
  const open = deps.open ?? openPage;
  let chrome: Chrome | null = null;
  let launching: Promise<Chrome> | null = null;
  let tab: Promise<Page> | null = null;
  let closed = false;
  const start = (): Promise<Chrome> => {
    if (closed) return Promise.reject(new Error("the browser is closed"));
    launching ??= launch({
      headed: o.headed, ...(o.browser ? { browser: o.browser } : {}), ...(o.profileDirectory ? { profileDirectory: o.profileDirectory } : {}), ...(o.geo ? { geolocation: o.geo } : {}),
      env: o.env, log: o.log, commandTimeoutMs: 30_000,
    }).then((c) => { chrome = c; return c; });
    return launching;
  };
  return {
    chrome: start,
    page() {
      tab ??= start().then((c) => open(c, { settleTimeoutMs: LIMITS.settleDomMs, log: o.log }));
      return tab;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (launching) await Promise.race([launching.then(() => undefined, () => undefined), sleep(LAUNCH_WAIT_MS)]);
      const c = chrome as Chrome | null;
      if (c) await c.close().catch(() => undefined);
    },
  };
}

/** The RunConfig that L2 and `jev-scrape new` start from. */
export function navBase(env: NodeJS.ProcessEnv, o: { headed: boolean; maxSteps?: number; logLevel?: "info" | "debug"; logJson?: boolean }, saved?: BrowserKind): RunConfig {
  const browser = envBrowser(env, saved);
  return {
    ...(browser ? { browser } : {}),
    task: "", headed: o.headed, maxSteps: o.maxSteps ?? 25, stepTimeoutMs: 30_000, runTimeoutMs: 600_000, pauseTimeoutMs: 300_000,
    confirm: "auto", dryRun: false, session: `jev-scrape-${randomBytes(4).toString("hex")}`, model: env["TYPESAFE_DEFAULT_MODEL"] ?? "jev-latest",
    logLevel: o.logLevel ?? "info", logJson: o.logJson ?? false, keepOpen: true, agentBrowserBin: "", vars: {}, engine: "cdp",
  };
}

/**
 * The Jev navigator of the CLI. Null without TYPESAFE_API_KEY (L2 is then skipped). The client and its connection start
 * with the first request; `close` ends the connection.
 */
export function lazyNavigator(env: NodeJS.ProcessEnv, log: Logger, human: Human, profiles: ProfileEntry[], base: RunConfig): { navigator: NavigatorDeps | null; close(): Promise<void> } {
  if (!env["TYPESAFE_API_KEY"]) return { navigator: null, close: async () => undefined };
  let transport: Transport | null = null;
  let client: TypeSafeClient | null = null;
  let oracle: Oracle | null = null;
  const idle = { requests: 0, inputTokens: 0, outputTokens: 0, model: base.model, ms: 0 };
  const make = (): { oracle: Oracle; transport: Transport; client: TypeSafeClient } => {
    transport ??= createTransport({ log });
    client ??= new TypeSafeClient({ defaultModel: base.model, logLevel: "off", fetch: transport.fetch });
    oracle ??= createOracle(client, base.model, log);
    return { oracle, transport, client };
  };
  const lazy: Oracle = {
    get stats() { return oracle ? oracle.stats : idle; },
    ask: (name, state, questions) => make().oracle.ask(name, state, questions),
  };
  return {
    navigator: { oracle: lazy, human, profiles, base, warm: () => { const m = make(); return m.transport.warm(m.client.baseURL); }, ...textModelDeps(env, log) },
    close: async () => { const t = transport as Transport | null; if (t) await t.close().catch(() => undefined); },
  };
}
