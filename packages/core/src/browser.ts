// Typed wrapper over the agent-browser CLI. Pure I/O. No decisions.
import { execFile } from "node:child_process";
import { LIMITS } from "./types.js";
import type { Logger } from "./io.js";

export type BrowserErrorKind = "covered" | "unknown_ref" | "timeout" | "usage" | "tab_gone" | "not_visible" | "launch" | "other";

export class BrowserError extends Error {
  kind: BrowserErrorKind;
  coveringSelector: string | undefined;
  raw: string;
  constructor(kind: BrowserErrorKind, message: string, raw: string, coveringSelector?: string) {
    super(message);
    this.name = "BrowserError";
    this.kind = kind;
    this.raw = raw;
    this.coveringSelector = coveringSelector;
  }
}

export interface RawRef { role: string; name: string }
export interface SnapshotData { origin: string; refs: Record<string, RawRef>; removedRefs: string[]; snapshot: string }
export interface ProfileEntry { directory: string; name: string }

export interface Browser {
  profiles(): Promise<ProfileEntry[]>;
  open(url: string): Promise<{ url: string; title: string }>;
  snapshot(opts: { interactive: boolean; compact?: boolean; depth?: number; selector?: string; urls?: boolean }): Promise<SnapshotData>;
  click(ref: string): Promise<void>;
  fill(ref: string, text: string): Promise<void>;
  press(key: string): Promise<void>;
  select(ref: string, label: string): Promise<void>;
  check(ref: string): Promise<void>;
  uncheck(ref: string): Promise<void>;
  hover(ref: string): Promise<void>;
  scroll(dir: "up" | "down", px: number): Promise<void>;
  scrollIntoView(ref: string): Promise<void>;
  back(): Promise<void>;
  waitLoad(state: "domcontentloaded" | "load" | "networkidle", timeoutMs: number): Promise<boolean>;
  waitMs(ms: number): Promise<void>;
  getUrl(): Promise<string>;
  getTitle(): Promise<string>;
  getText(selector: string): Promise<string>;
  getValue(ref: string): Promise<string>;
  dialogDismiss(): Promise<void>;
  screenshot(path: string): Promise<void>;
  close(): Promise<void>;
  readonly lastWarning: string | null;
}

export interface BrowserLaunchOptions {
  bin: string; session: string; profileDirectory?: string; headed: boolean; cdp?: number; commandTimeoutMs: number; log?: Logger;
}

export type SpawnFn = (bin: string, args: string[], timeoutMs: number, env: NodeJS.ProcessEnv)
  => Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>;

export interface Envelope { success: boolean; data: unknown; error: string | null; type?: string; code?: string; warning?: string }

export const defaultSpawn: SpawnFn = (bin, args, timeoutMs, env) => new Promise((resolve) => {
  execFile(bin, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, env }, (err, stdout, stderr) => {
    const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string | null }) | null;
    const timedOut = Boolean(e && e.killed);
    const code = e ? (typeof e.code === "number" ? e.code : null) : 0;
    resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code, timedOut });
  });
});

export function parseEnvelope(stdout: string): Envelope {
  const text = stdout.trim();
  if (!text) return { success: false, data: null, error: "empty response from agent-browser" };
  const start = text.indexOf("{");
  try {
    const obj = JSON.parse(start > 0 ? text.slice(start) : text) as Record<string, unknown>;
    const env: Envelope = {
      success: obj["success"] === true,
      data: obj["data"] ?? null,
      error: typeof obj["error"] === "string" ? obj["error"] : null,
    };
    if (typeof obj["type"] === "string") env.type = obj["type"];
    if (typeof obj["code"] === "string") env.code = obj["code"];
    if (typeof obj["warning"] === "string") env.warning = obj["warning"];
    return env;
  } catch {
    return { success: false, data: null, error: `unparseable response: ${text.slice(0, 200)}` };
  }
}

export function classifyError(envelope: { error: string | null; type?: string; code?: string }, timedOut: boolean): BrowserErrorKind {
  const msg = envelope.error ?? "";
  if (/covered by (<[^>]+>)/i.test(msg)) return "covered";
  if (/unknown ref/i.test(msg)) return "unknown_ref";
  if (timedOut || /timeout|timed out/i.test(msg)) return "timeout";
  if (envelope.type === "missing_arguments") return "usage";
  if (envelope.code === "tab_gone") return "tab_gone";
  if (/not visible|hidden/i.test(msg)) return "not_visible";
  if (/failed to launch|could not start|daemon|ENOENT/i.test(msg)) return "launch";
  return "other";
}

export function coveringSelectorOf(message: string): string | undefined {
  const m = message.match(/covered by (<[^>]+>)/i);
  return m ? m[1] : undefined;
}

export function createBrowser(opts: BrowserLaunchOptions, spawn: SpawnFn = defaultSpawn): Browser {
  let lastWarning: string | null = null;
  const globalArgs = (): string[] => {
    const a = ["--session", opts.session];
    if (opts.cdp !== undefined) a.push("--cdp", String(opts.cdp));
    else if (opts.profileDirectory) a.push("--profile", opts.profileDirectory);
    if (opts.headed) a.push("--headed");
    return a;
  };
  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    AGENT_BROWSER_DEFAULT_TIMEOUT: String(Math.max(1000, opts.commandTimeoutMs - 5000)),
  });

  async function run(args: string[], timeoutMs = opts.commandTimeoutMs, withGlobals = true): Promise<unknown> {
    const argv = [...(withGlobals ? globalArgs() : []), ...args, "--json"];
    const r = await spawn(opts.bin, argv, timeoutMs, env());
    const envl = parseEnvelope(r.stdout);
    opts.log?.debug(`agent-browser ${args.join(" ")}`, { success: envl.success, error: envl.error, timedOut: r.timedOut });
    if (envl.warning) {
      lastWarning = envl.warning;
      if (/dialog/i.test(envl.warning)) {
        opts.log?.warn(`dialog pending: ${envl.warning}; dismissing`);
        await spawn(opts.bin, [...globalArgs(), "dialog", "dismiss", "--json"], timeoutMs, env()).catch(() => undefined);
      }
    }
    if (!envl.success) {
      const message = envl.error ?? (r.timedOut ? "command timed out" : r.stderr.trim() || "unknown agent-browser error");
      const kind = classifyError({ error: message, ...(envl.type ? { type: envl.type } : {}), ...(envl.code ? { code: envl.code } : {}) }, r.timedOut);
      throw new BrowserError(kind, message, r.stdout, coveringSelectorOf(message));
    }
    return envl.data;
  }
  const field = (data: unknown, key: string): string => {
    const v = (data as Record<string, unknown> | null)?.[key];
    return typeof v === "string" ? v : "";
  };

  return {
    get lastWarning() { return lastWarning; },
    async profiles() {
      const data = await run(["profiles"], opts.commandTimeoutMs, false);
      const list = Array.isArray(data) ? data : [];
      return list
        .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
        .map((p) => ({ directory: String(p["directory"] ?? ""), name: String(p["name"] ?? "") }))
        .filter((p) => p.directory.length > 0);
    },
    async open(url) {
      const data = await run(["open", url], LIMITS.openTimeoutMs);
      return { url: field(data, "url"), title: field(data, "title") };
    },
    async snapshot(o) {
      const args = ["snapshot"];
      if (o.interactive) args.push("-i");
      if (o.compact) args.push("--compact");
      if (o.urls) args.push("--urls");
      if (o.depth !== undefined) args.push("-d", String(o.depth));
      if (o.selector) args.push("-s", o.selector);
      const data = (await run(args)) as Record<string, unknown> | null;
      const refsRaw = (data?.["refs"] ?? {}) as Record<string, { name?: string; role?: string }>;
      const refs: Record<string, RawRef> = {};
      for (const [k, v] of Object.entries(refsRaw)) refs[k] = { role: String(v?.role ?? ""), name: String(v?.name ?? "") };
      return {
        origin: field(data, "origin"),
        refs,
        removedRefs: Array.isArray(data?.["removedRefs"]) ? (data["removedRefs"] as string[]) : [],
        snapshot: field(data, "snapshot"),
      };
    },
    async click(ref) { await run(["click", `@${ref}`]); },
    async fill(ref, text) { await run(["fill", `@${ref}`, text]); },
    async press(key) { await run(["press", key]); },
    async select(ref, label) { await run(["select", `@${ref}`, label]); },
    async check(ref) { await run(["check", `@${ref}`]); },
    async uncheck(ref) { await run(["uncheck", `@${ref}`]); },
    async hover(ref) { await run(["hover", `@${ref}`]); },
    async scroll(dir, px) { await run(["scroll", dir, String(px)]); },
    async scrollIntoView(ref) { await run(["scrollintoview", `@${ref}`]); },
    async back() { await run(["back"]); },
    async waitLoad(state, timeoutMs) {
      try { await run(["wait", "--load", state, "--timeout", String(timeoutMs)], timeoutMs + 5000); return true; } catch { return false; }
    },
    async waitMs(ms) { try { await run(["wait", String(ms)], ms + opts.commandTimeoutMs); } catch { /* a timed wait never blocks the loop */ } },
    async getUrl() { return field(await run(["get", "url"]), "url"); },
    async getTitle() { return field(await run(["get", "title"]), "title"); },
    async getText(selector) { return field(await run(["get", "text", selector]), "text"); },
    async getValue(ref) { return field(await run(["get", "value", `@${ref}`]), "value"); },
    async dialogDismiss() { try { await run(["dialog", "dismiss"]); } catch { /* nothing pending */ } },
    async screenshot(path) { await run(["screenshot", path]); },
    async close() { try { await run(["close"]); } catch { /* already closed */ } },
  };
}
