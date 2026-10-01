// Find, copy, launch, and close Chrome for the fast engine. Pure I/O. No decisions.
// Parts ported from browser-use/jev-ultrafast (jev_ultrafast/browser.py). MIT License, Copyright (c) 2026 Browser Use.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Logger } from "../io.js";
import { connectPipe, connectWebSocket, type CdpOptions } from "./cdp.js";
import type { CdpClient, Chrome, ChromeLaunchOptions, GeoPoint } from "./model.js";

export interface ProfileEntry { directory: string; name: string }

export interface FindChromeOptions {
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  /** One browser only. Absent: the first browser that `detectBrowser` finds. */
  browser?: BrowserKind;
}

/** The Chromium-family browsers that the direct engines launch. The order is the auto-detect order. */
export const BROWSER_KINDS = ["chrome", "edge", "brave", "chromium"] as const;
export type BrowserKind = (typeof BROWSER_KINDS)[number];

interface BrowserSpec {
  label: string;
  /** The environment variable that overrides the binary. */
  envBin: string;
  /** App bundle binaries, relative to /Applications and ~/Applications. */
  darwin: string[];
  /** Binaries relative to %PROGRAMFILES%, %PROGRAMFILES(X86)%, and %LOCALAPPDATA%. */
  win32: string[];
  /** Command names on PATH. */
  linux: string[];
  /** The source user data dir, relative to the platform root (Application Support, %LOCALAPPDATA%, ~/.config). */
  data: { darwin: string; win32: string; linux: string };
  /** The client-hint brand next to "Chromium". Null for Chromium itself. */
  brand: string | null;
}

const BROWSERS: Record<BrowserKind, BrowserSpec> = {
  chrome: {
    label: "Google Chrome", envBin: "JEV_CHROME_BIN",
    darwin: ["Google Chrome.app/Contents/MacOS/Google Chrome", "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"],
    win32: ["Google/Chrome/Application/chrome.exe"], linux: ["google-chrome", "google-chrome-stable"],
    data: { darwin: "Google/Chrome", win32: "Google/Chrome/User Data", linux: "google-chrome" }, brand: "Google Chrome",
  },
  edge: {
    label: "Microsoft Edge", envBin: "JEV_EDGE_BIN",
    darwin: ["Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    win32: ["Microsoft/Edge/Application/msedge.exe"], linux: ["microsoft-edge", "microsoft-edge-stable"],
    data: { darwin: "Microsoft Edge", win32: "Microsoft/Edge/User Data", linux: "microsoft-edge" }, brand: "Microsoft Edge",
  },
  brave: {
    label: "Brave", envBin: "JEV_BRAVE_BIN",
    darwin: ["Brave Browser.app/Contents/MacOS/Brave Browser"],
    win32: ["BraveSoftware/Brave-Browser/Application/brave.exe"], linux: ["brave-browser", "brave"],
    data: { darwin: "BraveSoftware/Brave-Browser", win32: "BraveSoftware/Brave-Browser/User Data", linux: "BraveSoftware/Brave-Browser" }, brand: "Brave",
  },
  chromium: {
    label: "Chromium", envBin: "JEV_CHROMIUM_BIN",
    darwin: ["Chromium.app/Contents/MacOS/Chromium"],
    win32: ["Chromium/Application/chrome.exe"], linux: ["chromium", "chromium-browser"],
    data: { darwin: "Chromium", win32: "Chromium/User Data", linux: "chromium" }, brand: null,
  },
};

/** The display name of a browser, for example "Microsoft Edge". */
export function browserLabel(kind: BrowserKind): string {
  return BROWSERS[kind].label;
}

/** The client-hint brand of a browser next to "Chromium"; null for Chromium. */
export function browserBrand(kind: BrowserKind | undefined): string | null {
  return BROWSERS[kind ?? "chrome"].brand;
}

function onPath(name: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | null {
  for (const dir of (env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    if (exists(full)) return full;
  }
  return null;
}

/** The installed binary of one browser, or null. Ignores the env override. */
function installedBin(kind: BrowserKind, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean): string | null {
  const spec = BROWSERS[kind];
  let candidates: string[] = [];
  if (platform === "darwin") {
    const home = env["HOME"] ?? os.homedir();
    candidates = ["/Applications", path.join(home, "Applications")].flatMap((root) => spec.darwin.map((rel) => path.join(root, rel)));
  } else if (platform === "win32") {
    const roots = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]].filter((r): r is string => Boolean(r));
    candidates = roots.flatMap((r) => spec.win32.map((rel) => path.join(r, ...rel.split("/"))));
  } else {
    for (const name of spec.linux) {
      const hit = onPath(name, env, exists);
      if (hit) return hit;
    }
  }
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

/**
 * The browser that the direct engines use when none is named: the first one with a binary override in the
 * environment (`JEV_CHROME_BIN`, `JEV_EDGE_BIN`, `JEV_BRAVE_BIN`, `JEV_CHROMIUM_BIN`), else the first one installed, in
 * the order Chrome, Edge, Brave, Chromium. Null when none is found.
 */
export function detectBrowser(env: NodeJS.ProcessEnv, opts: Omit<FindChromeOptions, "browser"> = {}): BrowserKind | null {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  for (const kind of BROWSER_KINDS) if (env[BROWSERS[kind].envBin]) return kind;
  for (const kind of BROWSER_KINDS) if (installedBin(kind, env, platform, exists)) return kind;
  return null;
}

/** The browser of a run: `--browser`, else Chromium for `--engine chromium`, else `detectBrowser`. Undefined when none is installed. */
export function browserOf(cfg: { engine?: string | undefined; browser?: BrowserKind | undefined }, env: NodeJS.ProcessEnv, opts: Omit<FindChromeOptions, "browser"> = {}): BrowserKind | undefined {
  if (cfg.browser) return cfg.browser;
  if (cfg.engine === "chromium") return "chromium";
  return detectBrowser(env, opts) ?? undefined;
}

/** The text of a missing-browser error. It names the fix, so an agent tells the user instead of trying another engine. */
function notFound(kind: BrowserKind | undefined, platform: NodeJS.Platform): Error {
  const error = kind
    ? new Error(`${kind} not found: install ${BROWSERS[kind].label}, or set ${BROWSERS[kind].envBin} to the browser binary (platform ${platform}). Other engines need an installed browser too`)
    : new Error(`no supported browser found: install Google Chrome, Microsoft Edge, Brave, or Chromium, or set JEV_CHROME_BIN to the binary of one (platform ${platform}). Other engines need an installed browser too`);
  error.name = "ChromeError";
  return error;
}

/** The binary to launch. The browser's env override wins. Without `browser`, the first browser found. Throws `... not found` when none exists. */
export function findChrome(env: NodeJS.ProcessEnv, opts: FindChromeOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const kinds = opts.browser ? [opts.browser] : BROWSER_KINDS;
  for (const kind of kinds) {
    const override = env[BROWSERS[kind].envBin];
    if (override) return override;
  }
  for (const kind of kinds) {
    const hit = installedBin(kind, env, platform, exists);
    if (hit) return hit;
  }
  throw notFound(opts.browser, platform);
}

/** The source user data dir of a browser on this platform. */
export function defaultUserDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, browser: BrowserKind = "chrome"): string {
  const home = env["HOME"] ?? env["USERPROFILE"] ?? os.homedir();
  const rel = BROWSERS[browser].data[platform === "darwin" || platform === "win32" ? platform : "linux"].split("/");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", ...rel);
  if (platform === "win32") return path.join(env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local"), ...rel);
  // Chrome keeps its old path; the other browsers follow $XDG_CONFIG_HOME as they do on Linux.
  if (browser === "chrome") return path.join(home, ".config", ...rel);
  return path.join(env["XDG_CONFIG_HOME"] ?? path.join(home, ".config"), ...rel);
}

/** Profiles of a user data dir from `Local State`. Empty when the file is missing or malformed. */
export function listProfiles(userDataDir: string): ProfileEntry[] {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, "Local State"), "utf8");
    const state = JSON.parse(raw) as { profile?: { info_cache?: Record<string, { name?: unknown }> } };
    const cache = state.profile?.info_cache;
    if (!cache || typeof cache !== "object") return [];
    return Object.entries(cache).map(([directory, info]) => ({ directory, name: typeof info?.name === "string" ? info.name : directory }));
  } catch {
    return [];
  }
}

/** Where the copy of a profile lives: `$XDG_CONFIG_HOME/jev-browser/<browser>/<slug>`. */
export function profileCopyDir(env: NodeJS.ProcessEnv, profileDirectory: string, browser: BrowserKind = "chrome"): string {
  const base = env["XDG_CONFIG_HOME"] ?? path.join(env["HOME"] ?? os.homedir(), ".config");
  const slug = profileDirectory.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "profile";
  return path.join(base, "jev-browser", browser, slug);
}

/** Top-level entries of the profile dir that a copy skips: caches, extensions, history, and locks. */
export const SKIPPED_PROFILE_ENTRIES: ReadonlySet<string> = new Set([
  "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache", "ShaderCache",
  "Service Worker", "Extensions", "Extension Rules", "Extension Scripts", "Extension State", "Local Extension Settings",
  "Sync Extension Settings", "Managed Extension Settings", "Shared Dictionary", "Sessions", "History", "History-journal",
  "Favicons", "Favicons-journal", "Top Sites", "Top Sites-journal", "Visited Links", "Site Characteristics Database",
  "File System", "blob_storage", "Download Service", "optimization_guide_hint_cache_store",
  "optimization_guide_model_and_features_store", "Segmentation Platform", "commerce_subscription_db", "parcel_tracking_db",
  "PersistentOriginTrials", "Feature Engagement Tracker", "Safe Browsing Network", "shared_proto_db", "LOCK", "LOG", "LOG.old",
]);

function skipTopLevel(name: string): boolean {
  return SKIPPED_PROFILE_ENTRIES.has(name) || name.endsWith(".log");
}

/** The marker file that a complete profile copy carries. A copy without it is copied again. */
export const COPY_MARKER = "jev-copy.json";

/** Sidecar suffixes of a SQLite database. They are copied right after their database, in one pass. */
const SQLITE_SIDECARS = ["-journal", "-wal", "-shm"];

function isSidecar(name: string): boolean {
  return SQLITE_SIDECARS.some((x) => name.endsWith(x));
}

/**
 * Copy a tree file by file. A file that fails is logged at debug and skipped. A database and its
 * -journal, -wal, and -shm files are copied one after the other. A file whose size changed during
 * the copy is logged at warn: the user's Chrome wrote to it, and the copy can be torn.
 * Returns the file count.
 */
function copyTree(src: string, dest: string, log: Logger, skip?: (name: string) => boolean): number {
  let files = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (e) {
    log.debug(`profile copy: cannot read ${src}: ${(e as Error).message}`);
    return 0;
  }
  fs.mkdirSync(dest, { recursive: true });
  // Sorted by name, so "Cookies" is followed by "Cookies-journal" and "Cookies-wal".
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (skip?.(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) {
        files += copyTree(from, to, log);
      } else if (entry.isFile()) {
        const before = fs.statSync(from).size;
        fs.copyFileSync(from, to);
        files += 1;
        const after = fs.statSync(from).size;
        if (after !== before) {
          const what = isSidecar(entry.name) ? "database journal" : "file";
          log.warn(`profile copy: ${what} ${from} changed size during the copy (${before} -> ${after} bytes); the copy can be torn. Close Chrome and run with --refresh-profile`);
        }
      }
    } catch (e) {
      log.debug(`profile copy: skipped ${from}: ${(e as Error).message}`);
    }
  }
  return files;
}

export interface SyncProfileOptions {
  sourceUserDataDir: string;
  profileDirectory: string;
  dest: string;
  refresh: boolean;
  log: Logger;
}

/** Remove staging directories that an earlier copy left behind (`<dest>.tmp-<pid>`). */
function sweepStaging(dest: string, log: Logger): void {
  const parent = path.dirname(dest);
  const prefix = `${path.basename(dest)}.tmp-`;
  let names: string[];
  try { names = fs.readdirSync(parent); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try { fs.rmSync(path.join(parent, name), { recursive: true, force: true }); log.debug(`profile copy: removed stale staging dir ${name}`); } catch { /* best effort */ }
  }
}

/** Hold this lock for the copy and the full Chrome lifetime. Never remove another owner's lock. */
export function acquireProfileLock(dest: string): () => void {
  const file = `${dest}.jev-lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const error = new Error(`profile is locked: ${file}. Close the other jev-browser session. After a crash, verify that no Chrome uses ${dest} before removing this lock.`);
    error.name = "ChromeError";
    throw error;
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); }
  catch (e) { fs.closeSync(fd); fs.unlinkSync(file); throw e; }
  fs.closeSync(fd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { fs.unlinkSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  };
}

/** Chrome locks can also belong to an older client or a manually launched browser. */
function assertNoChromeLock(dest: string): void {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { fs.lstatSync(path.join(dest, name)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    const error = new Error(`Chrome lock exists at ${path.join(dest, name)}; close Chrome before copying or reusing this profile`);
    error.name = "ChromeError";
    throw error;
  }
}

/** Standalone copies use the same exclusive lock as browser launches. */
export async function syncProfile(opts: SyncProfileOptions): Promise<{ copied: boolean; ms: number; files: number }> {
  const release = acquireProfileLock(opts.dest);
  try { return await syncProfileLocked(opts); } finally { release(); }
}

/**
 * Copy one profile into `<dest>/Default`. Reuses an existing copy unless `refresh` is set.
 * The copy keeps cookies, storage, and preferences and skips caches, extensions, and history.
 *
 * The copy goes into `<dest>.tmp-<pid>` first. The marker `<dest>/jev-copy.json` is written as the
 * last step, then the staging dir is renamed to `<dest>`. A copy that ended early has no marker and
 * is never reused.
 */
async function syncProfileLocked(opts: SyncProfileOptions): Promise<{ copied: boolean; ms: number; files: number }> {
  assertNoChromeLock(opts.dest);
  const start = Date.now();
  const markerPath = path.join(opts.dest, COPY_MARKER);
  if (!opts.refresh && fs.existsSync(markerPath)) {
    return { copied: false, ms: Date.now() - start, files: 0 };
  }
  if (!opts.refresh && fs.existsSync(opts.dest)) opts.log.warn(`profile copy at ${opts.dest} has no ${COPY_MARKER} (an earlier copy ended early); copying again`);
  sweepStaging(opts.dest, opts.log);
  const staging = `${opts.dest}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const source = path.join(opts.sourceUserDataDir, opts.profileDirectory);
  let files = 0;
  try {
    fs.copyFileSync(path.join(opts.sourceUserDataDir, "Local State"), path.join(staging, "Local State"));
    files += 1;
  } catch (e) {
    opts.log.debug(`profile copy: no Local State: ${(e as Error).message}`);
  }
  files += copyTree(source, path.join(staging, "Default"), opts.log, skipTopLevel);
  const prefsPath = path.join(staging, "Default", "Preferences");
  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8")) as Record<string, unknown>;
    const profile = (typeof prefs["profile"] === "object" && prefs["profile"] !== null ? prefs["profile"] : {}) as Record<string, unknown>;
    profile["exit_type"] = "Normal";
    profile["exited_cleanly"] = true;
    prefs["profile"] = profile;
    fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch (e) {
    opts.log.debug(`profile copy: Preferences not rewritten: ${(e as Error).message}`);
  }
  removeSingletons(staging);
  let sourceMtime: number | null = null;
  try { sourceMtime = fs.statSync(source).mtimeMs; } catch { /* absent */ }
  const marker = { version: 1, source, profileDirectory: opts.profileDirectory, sourceMtime, files, copiedAt: new Date().toISOString(), ms: Date.now() - start };
  fs.writeFileSync(path.join(staging, COPY_MARKER), JSON.stringify(marker));
  fs.rmSync(opts.dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(opts.dest), { recursive: true });
  fs.renameSync(staging, opts.dest);
  return { copied: true, ms: Date.now() - start, files };
}

function removeSingletons(udd: string): void {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try { fs.rmSync(path.join(udd, name), { force: true }); } catch { /* absent */ }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The per-command timeout of the CDP client. `--step-timeout` sets it; the default is 30 s. */
function cdpOptions(opts: ChromeLaunchOptions): CdpOptions {
  return opts.commandTimeoutMs !== undefined ? { timeoutMs: opts.commandTimeoutMs } : {};
}

function chromeArgs(udd: string, headed: boolean): string[] {
  const args = [
    "--remote-debugging-pipe",
    `--user-data-dir=${udd}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=TranslateUI,MediaRouter,OptimizationHints",
    "--hide-crash-restore-bubble",
    "--disable-session-crashed-bubble",
    "--window-size=1280,860",
    "--new-window",
  ];
  if (!headed) args.push("--headless=new");
  args.push("about:blank");
  return args;
}

export interface AttachTargetOptions {
  /** The window is visible. A headless tab gets a fixed viewport. */
  headed: boolean;
  /** The Chrome belongs to the user (`--cdp`). The tab opens in the background and keeps the window's own viewport. */
  attached: boolean;
  /** The user agent of the tab, when Chrome's own one must not go out (see `plainUserAgent`). */
  userAgent?: string;
  /** The client hints that go with `userAgent` (see `userAgentMetadata`). */
  userAgentMetadata?: UserAgentMetadata;
  /** The geolocation that the tab reports (`ChromeLaunchOptions.geolocation`). Absent: Chrome's own behaviour. */
  geolocation?: GeoPoint;
  /** Debug lines, for example a geolocation permission that Chrome refused. */
  log?: Logger;
}

/** The `userAgentMetadata` of Emulation.setUserAgentOverride. */
export interface UserAgentMetadata {
  brands: { brand: string; version: string }[];
  fullVersionList: { brand: string; version: string }[];
  platform: string; platformVersion: string; architecture: string; model: string; mobile: boolean; bitness: string; wow64: boolean;
  formFactors: string[];
}

let osVersion: string | null = null;
/**
 * The OS version that Chrome sends as its platformVersion hint, read once per process: `sw_vers -productVersion` on macOS
 * ("26.6.2", as Chrome 154 reports it), the kernel version on Linux. Empty on Windows, where Chrome reads a Windows API
 * contract version that Node cannot read.
 */
export function platformVersionOf(platform: NodeJS.Platform = process.platform): string {
  if (osVersion !== null) return osVersion;
  let v = "";
  try {
    if (platform === "darwin") v = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 2000 }).trim();
    else if (platform === "linux") v = /^\d+\.\d+(?:\.\d+)?/.exec(os.release())?.[0] ?? "";
  } catch { v = ""; }
  // Chrome sends three numbers: "15.6" is "15.6.0".
  if (/^\d+\.\d+$/.test(v)) v = `${v}.0`;
  osVersion = /^\d+\.\d+\.\d+$/.test(v) ? v : "";
  return osVersion;
}

/**
 * The user agent without "HeadlessChrome": sites that block bots check for that word. Null when the agent does not
 * have it (a headed Chrome), so no override is set.
 */
export function plainUserAgent(ua: unknown): string | null {
  return typeof ua === "string" && ua.includes("HeadlessChrome") ? ua.replace(/HeadlessChrome/g, "Chrome") : null;
}

/**
 * The client hints of Chrome's own user agent, for Emulation.setUserAgentOverride. An override without them stops the
 * Sec-CH-UA headers and empties navigator.userAgentData, a mismatch that bot checks look for. `product` is the
 * product of Browser.getVersion ("HeadlessChrome/154.0.7727.56"). The brand list follows Chrome's own algorithm
 * (components/embedder_support/user_agent_utils.cc): the major version seeds the GREASE brand, its version, and the
 * order. For Chrome 154 on macOS that gives "Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99", as
 * Chrome sends with no override. `brand` is "Google Chrome", "Microsoft Edge", or "Brave"; null for Chromium. Null when the
 * product has no version.
 */
export function userAgentMetadata(product: unknown, brand: string | null, platform: NodeJS.Platform = process.platform, arch: string = process.arch, platformVersion = ""): UserAgentMetadata | null {
  const full = typeof product === "string" ? /\/(\d+)((?:\.\d+){0,3})/.exec(product) : null;
  if (!full) return null;
  const seed = Number(full[1]);
  const version = `${full[1]}${full[2] ?? ""}`;
  const chars = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
  const greased = ["8", "99", "24"][seed % 3] as string;
  const grease = { brand: `Not${chars[seed % chars.length]}A${chars[(seed + 1) % chars.length]}Brand`, major: greased, full: `${greased}.0.0.0` };
  const own = [{ brand: "Chromium", major: full[1] as string, full: version }, ...(brand ? [{ brand, major: full[1] as string, full: version }] : [])];
  // orders[seed % n]: the index of the GREASE brand, then of each own brand.
  const orders = own.length === 2 ? [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] : [[0, 1], [1, 0]];
  const order = orders[seed % orders.length] as number[];
  const list = new Array<{ brand: string; major: string; full: string }>(own.length + 1);
  [grease, ...own].forEach((b, i) => { list[order[i] as number] = b; });
  const plat = platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : "";
  return {
    brands: list.map((b) => ({ brand: b.brand, version: b.major })),
    fullVersionList: list.map((b) => ({ brand: b.brand, version: b.full })),
    platform: plat, platformVersion, architecture: arch.startsWith("arm") ? "arm" : "x86", model: "", mobile: false,
    bitness: arch === "arm64" || arch === "x64" ? "64" : "32", wow64: false, formFactors: ["Desktop"],
  };
}

/**
 * Attach one session to a new target and enable the domains the page layer needs. In attach mode the
 * tab opens in the background, so it never takes the tab the user works in (as browser-use/jev-ultrafast
 * browser.py does with `background=True`; MIT License, Copyright (c) 2026 Browser Use). With `geolocation`, the tab
 * reports that point: Browser.grantPermissions (geolocation), then Emulation.setGeolocationOverride (accuracy 50 m when
 * absent).
 */
export async function attachTarget(client: CdpClient, url: string, opts: AttachTargetOptions, existingTargetId?: string): Promise<{ targetId: string; sessionId: string }> {
  const created = existingTargetId === undefined
    ? await client.send("Target.createTarget", { url, newWindow: false, ...(opts.attached ? { background: true } : {}) }) : null;
  const targetId = existingTargetId ?? String(created?.["targetId"]);
  const attached = await client.send("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = String(attached["sessionId"]);
  // No Runtime.enable: evaluations need no domain, and it streams every console message of the page to this process.
  await client.send("Page.enable", {}, sessionId);
  await client.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  if (opts.userAgent) await client.send("Emulation.setUserAgentOverride", { userAgent: opts.userAgent, ...(opts.userAgentMetadata ? { userAgentMetadata: opts.userAgentMetadata } : {}) }, sessionId);
  if (opts.geolocation) {
    // The permission is for the browser (no session), so the page gets the position with no prompt. Without it the
    // override still answers a page that has the permission: a refusal does not fail the tab.
    try {
      await client.send("Browser.grantPermissions", { permissions: ["geolocation"] });
    } catch (e) {
      opts.log?.debug(`geolocation permission not granted: ${(e as Error).message}`);
    }
    const g = opts.geolocation;
    await client.send("Emulation.setGeolocationOverride", { latitude: g.latitude, longitude: g.longitude, accuracy: g.accuracy ?? 50 }, sessionId);
  }
  if (!opts.headed && !opts.attached) {
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false }, sessionId);
  }
  return { targetId, sessionId };
}

/** The geolocation part of the attach options of each new tab of a launched or attached Chrome. */
function geoOptions(opts: ChromeLaunchOptions): Pick<AttachTargetOptions, "geolocation" | "log"> {
  return opts.geolocation ? { geolocation: opts.geolocation, log: opts.log } : {};
}

async function attachChrome(opts: ChromeLaunchOptions, port: number): Promise<Chrome> {
  const start = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!res.ok) throw new Error(`cdp attach failed: HTTP ${res.status} from port ${port}`);
  const info = (await res.json()) as { webSocketDebuggerUrl?: string; Browser?: string; "User-Agent"?: string };
  if (!info.webSocketDebuggerUrl) throw new Error("cdp attach failed: no webSocketDebuggerUrl");
  const client = await connectWebSocket(info.webSocketDebuggerUrl, cdpOptions(opts));
  const launchMs = Date.now() - start;
  opts.log.info(`chrome ${info.Browser ?? "?"} attached port=${port} launchMs=${launchMs}`);
  const owned = new Set<string>();
  let closing: Promise<void> | null = null;
  const userAgent = plainUserAgent(info["User-Agent"]);
  const hints = userAgent ? userAgentMetadata(info.Browser, browserBrand(opts.browser), process.platform, process.arch, platformVersionOf()) : null;
  const geo = geoOptions(opts);
  return {
    client,
    userDataDir: null,
    profile: { directory: null, copyDir: null, copied: false, copyMs: 0 },
    launchMs,
    async newTarget(url) {
      const t = await attachTarget(client, url, { headed: opts.headed, attached: true, ...(userAgent ? { userAgent } : {}), ...(hints ? { userAgentMetadata: hints } : {}), ...geo });
      owned.add(t.targetId);
      return t;
    },
    async adoptTarget(targetId) {
      owned.add(targetId);
      return attachTarget(client, "", { headed: opts.headed, attached: true, ...(userAgent ? { userAgent } : {}), ...(hints ? { userAgentMetadata: hints } : {}), ...geo }, targetId);
    },
    async closeTarget(targetId) {
      if (!owned.delete(targetId)) return;
      await client.send("Target.closeTarget", { targetId }).catch(() => undefined);
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        for (const id of [...owned]) {
          owned.delete(id);
          if (!client.closed) await client.send("Target.closeTarget", { targetId: id }).catch(() => undefined);
        }
        await client.close();
      })();
      return closing;
    },
  };
}

/**
 * How long a close waits for a launch that is still in flight. A SIGINT during the launch (about 0.3 to 0.4 s)
 * then closes Chrome and removes its temporary profile. The launch itself gives up after 20 s.
 */
export const LAUNCH_WAIT_MS = 5_000;

/** Launch Chrome on a copied profile or a temporary one, or attach over `cdpPort`. */
export async function launchChrome(opts: ChromeLaunchOptions): Promise<Chrome> {
  if (opts.cdpPort !== undefined) return attachChrome(opts, opts.cdpPort);
  // Without a named browser, the binary, the source profiles, and the copy all follow the browser that discovery finds.
  const browser = opts.browser ?? detectBrowser(opts.env) ?? undefined;
  if (browser) opts = { ...opts, browser };
  const release = opts.profileDirectory ? acquireProfileLock(profileCopyDir(opts.env, opts.profileDirectory, opts.browser)) : () => undefined;
  let child: ChildProcess | null = null;
  try {
    return await launchOwnedChrome(opts, (c) => { child = c; c.once("exit", release); });
  } catch (e) {
    const spawned = child as ChildProcess | null;
    if (!spawned?.pid || spawned.exitCode !== null || spawned.signalCode !== null) release();
    else spawned.kill("SIGKILL"); // The exit event releases the lock only after Chrome stops.
    throw e;
  }
}

async function launchOwnedChrome(opts: ChromeLaunchOptions, onSpawn: (child: ChildProcess) => void): Promise<Chrome> {
  const browser = opts.browser;
  const bin = opts.chromeBin ?? findChrome(opts.env, { ...(browser ? { browser } : {}) });
  let udd: string;
  let tempUdd: string | null = null;
  let profile: Chrome["profile"];
  if (opts.profileDirectory) {
    const copyDir = profileCopyDir(opts.env, opts.profileDirectory, browser);
    const sync = await syncProfileLocked({
      sourceUserDataDir: opts.sourceUserDataDir ?? defaultUserDataDir(opts.env, undefined, browser),
      profileDirectory: opts.profileDirectory,
      dest: copyDir,
      refresh: opts.refreshProfile ?? false,
      log: opts.log,
    });
    opts.log.debug(`profile ${opts.profileDirectory}: ${sync.copied ? "copied" : "reused"} ${sync.files} files in ${sync.ms} ms`);
    udd = copyDir;
    profile = { directory: opts.profileDirectory, copyDir, copied: sync.copied, copyMs: sync.ms };
  } else {
    tempUdd = fs.mkdtempSync(path.join(os.tmpdir(), "jev-chrome-"));
    udd = tempUdd;
    profile = { directory: null, copyDir: null, copied: false, copyMs: 0 };
  }

  const spawnedAt = Date.now();
  const child: ChildProcess = spawn(bin, chromeArgs(udd, opts.headed), { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  onSpawn(child);
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => { exited = true; resolve(); });
  });
  child.once("error", (e) => opts.log.debug(`chrome spawn error: ${e.message}`));
  if (child.stderr) {
    readline.createInterface({ input: child.stderr }).on("line", (line) => { if (line.trim()) opts.log.debug(`chrome: ${line}`); });
  }

  /** Wait for the exit event or for `ms`. The timer is cleared when Chrome exits first, so it cannot hold the process open. */
  const exitOrTimeout = (ms: number): Promise<"exited" | "timeout"> => new Promise((resolve) => {
    if (exited) { resolve("exited"); return; }
    const timer = setTimeout(() => resolve("timeout"), ms);
    void exitPromise.then(() => { clearTimeout(timer); resolve("exited"); });
  });

  const cleanupUdd = () => { if (tempUdd) fs.rmSync(tempUdd, { recursive: true, force: true }); };
  let client: CdpClient;
  try {
    client = connectPipe(child, cdpOptions(opts));
  } catch (e) {
    child.kill("SIGKILL");
    cleanupUdd();
    throw e;
  }

  const deadline = spawnedAt + 20_000;
  let version: Record<string, unknown> | null = null;
  let lastError: Error | null = null;
  while (version === null) {
    try {
      version = await client.send("Browser.getVersion");
    } catch (e) {
      lastError = e as Error;
      if (client.closed || exited || Date.now() >= deadline) break;
      await sleep(100);
    }
  }
  if (version === null) {
    child.kill("SIGKILL");
    await client.close();
    cleanupUdd();
    throw new Error(`chrome did not answer over the CDP pipe: ${lastError?.message ?? "no reply"}`);
  }
  const launchMs = Date.now() - spawnedAt;
  opts.log.info(
    `${browser ?? "browser"} ${String(version["product"] ?? "?")} pid ${child.pid ?? "?"} udd=${udd} profile=${profile.directory ?? "none"} ` +
    `copy=${profile.directory === null ? "none" : profile.copied ? "copied" : "reused"} copyMs=${profile.copyMs} launchMs=${launchMs}`,
  );

  const owned = new Set<string>();
  let closing: Promise<void> | null = null;
  const userAgent = plainUserAgent(version["userAgent"]);
  const hints = userAgent ? userAgentMetadata(version["product"], /chromium/i.test(bin) ? null : browserBrand(browser), process.platform, process.arch, platformVersionOf()) : null;
  const geo = geoOptions(opts);
  const chrome: Chrome = {
    client,
    userDataDir: udd,
    profile,
    launchMs,
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    async newTarget(url) {
      const t = await attachTarget(client, url, { headed: opts.headed, attached: false, ...(userAgent ? { userAgent } : {}), ...(hints ? { userAgentMetadata: hints } : {}), ...geo });
      owned.add(t.targetId);
      return t;
    },
    async adoptTarget(targetId) {
      owned.add(targetId);
      return attachTarget(client, "", { headed: opts.headed, attached: false, ...(userAgent ? { userAgent } : {}), ...(hints ? { userAgentMetadata: hints } : {}), ...geo }, targetId);
    },
    async closeTarget(targetId) {
      if (!owned.delete(targetId)) return;
      if (client.closed) return;
      await client.send("Target.closeTarget", { targetId }).catch(() => undefined);
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        for (const id of [...owned]) {
          owned.delete(id);
          if (!client.closed) await client.send("Target.closeTarget", { targetId: id }).catch(() => undefined);
        }
        if (!client.closed) await client.send("Browser.close").catch(() => undefined);
        if (!exited) {
          const result = await exitOrTimeout(3000);
          if (result === "timeout") {
            opts.log.debug(`chrome pid ${child.pid ?? "?"} did not exit in 3 s; sending SIGKILL`);
            child.kill("SIGKILL");
            await exitOrTimeout(2000);
          }
        }
        await client.close();
        // Chrome helper processes inherit the stderr pipe. Drop it so they cannot keep this process alive.
        child.stderr?.destroy();
        cleanupUdd();
      })();
      return closing;
    },
  };
  return chrome;
}
