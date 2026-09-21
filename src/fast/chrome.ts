// Find, copy, launch, and close Chrome for the fast engine. Pure I/O. No decisions.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Logger } from "../io.js";
import { connectPipe, connectWebSocket, type CdpOptions } from "./cdp.js";
import type { CdpClient, Chrome, ChromeLaunchOptions } from "./model.js";

export interface ProfileEntry { directory: string; name: string }

export interface FindChromeOptions {
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  browser?: "chrome" | "chromium";
}

const DARWIN_BINS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const LINUX_BINS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

function onPath(name: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | null {
  for (const dir of (env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    if (exists(full)) return full;
  }
  return null;
}

/** The Chrome binary to launch. `JEV_CHROME_BIN` wins. Throws `chrome not found ...` when none exists. */
export function findChrome(env: NodeJS.ProcessEnv, opts: FindChromeOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const chromium = opts.browser === "chromium";
  const override = env[chromium ? "JEV_CHROMIUM_BIN" : "JEV_CHROME_BIN"];
  if (override) return override;
  let candidates: string[] = [];
  if (platform === "darwin") {
    candidates = chromium ? DARWIN_BINS.filter((p) => p.includes("Chromium.app")) : DARWIN_BINS;
  } else if (platform === "win32") {
    const roots = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]].filter((r): r is string => Boolean(r));
    candidates = roots.map((r) => chromium ? path.join(r, "Chromium", "Application", "chrome.exe") : path.join(r, "Google", "Chrome", "Application", "chrome.exe"));
  } else {
    for (const name of chromium ? ["chromium", "chromium-browser"] : LINUX_BINS) {
      const hit = onPath(name, env, exists);
      if (hit) return hit;
    }
  }
  for (const c of candidates) if (exists(c)) return c;
  throw new Error(`${chromium ? "chromium" : "chrome"} not found: set ${chromium ? "JEV_CHROMIUM_BIN" : "JEV_CHROME_BIN"} to the browser binary (platform ${platform})`);
}

/** The Chrome user data dir of this platform. */
export function defaultUserDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, browser: "chrome" | "chromium" = "chrome"): string {
  const home = env["HOME"] ?? env["USERPROFILE"] ?? os.homedir();
  if (browser === "chromium") {
    if (platform === "darwin") return path.join(home, "Library", "Application Support", "Chromium");
    if (platform === "win32") return path.join(env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local"), "Chromium", "User Data");
    return path.join(env["XDG_CONFIG_HOME"] ?? path.join(home, ".config"), "chromium");
  }
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Google", "Chrome");
  if (platform === "win32") return path.join(env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
  return path.join(home, ".config", "google-chrome");
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

/** Where the copy of a profile lives: `$XDG_CONFIG_HOME/jev-browser/chrome/<slug>`. */
export function profileCopyDir(env: NodeJS.ProcessEnv, profileDirectory: string, browser: "chrome" | "chromium" = "chrome"): string {
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
}

/**
 * Attach one session to a new target and enable the domains the page layer needs. In attach mode the
 * tab opens in the background, so it never takes the tab the user works in (as browser-use/jev-ultrafast
 * browser.py does with `background=True`; MIT License, Copyright (c) 2026 Browser Use).
 */
export async function attachTarget(client: CdpClient, url: string, opts: AttachTargetOptions): Promise<{ targetId: string; sessionId: string }> {
  const created = await client.send("Target.createTarget", { url, newWindow: false, ...(opts.attached ? { background: true } : {}) });
  const targetId = String(created["targetId"]);
  const attached = await client.send("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = String(attached["sessionId"]);
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  await client.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  if (!opts.headed && !opts.attached) {
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false }, sessionId);
  }
  return { targetId, sessionId };
}

async function attachChrome(opts: ChromeLaunchOptions, port: number): Promise<Chrome> {
  const start = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!res.ok) throw new Error(`cdp attach failed: HTTP ${res.status} from port ${port}`);
  const info = (await res.json()) as { webSocketDebuggerUrl?: string; Browser?: string };
  if (!info.webSocketDebuggerUrl) throw new Error("cdp attach failed: no webSocketDebuggerUrl");
  const client = await connectWebSocket(info.webSocketDebuggerUrl, cdpOptions(opts));
  const launchMs = Date.now() - start;
  opts.log.info(`chrome ${info.Browser ?? "?"} attached port=${port} launchMs=${launchMs}`);
  const owned = new Set<string>();
  let closing: Promise<void> | null = null;
  return {
    client,
    userDataDir: null,
    profile: { directory: null, copyDir: null, copied: false, copyMs: 0 },
    launchMs,
    async newTarget(url) {
      const t = await attachTarget(client, url, { headed: opts.headed, attached: true });
      owned.add(t.targetId);
      return t;
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
  const bin = opts.chromeBin ?? findChrome(opts.env, { ...(opts.browser ? { browser: opts.browser } : {}) });
  let udd: string;
  let tempUdd: string | null = null;
  let profile: Chrome["profile"];
  if (opts.profileDirectory) {
    const copyDir = profileCopyDir(opts.env, opts.profileDirectory, opts.browser);
    const sync = await syncProfileLocked({
      sourceUserDataDir: opts.sourceUserDataDir ?? defaultUserDataDir(opts.env, undefined, opts.browser),
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
    `chrome ${String(version["product"] ?? "?")} pid ${child.pid ?? "?"} udd=${udd} profile=${profile.directory ?? "none"} ` +
    `copy=${profile.directory === null ? "none" : profile.copied ? "copied" : "reused"} copyMs=${profile.copyMs} launchMs=${launchMs}`,
  );

  const owned = new Set<string>();
  let closing: Promise<void> | null = null;
  const chrome: Chrome = {
    client,
    userDataDir: udd,
    profile,
    launchMs,
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
    async newTarget(url) {
      const t = await attachTarget(client, url, { headed: opts.headed, attached: false });
      owned.add(t.targetId);
      return t;
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
