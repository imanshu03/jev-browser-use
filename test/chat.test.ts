import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "../src/browser.js";
import type { Human } from "../src/io.js";
import { IDLE_PING_MS, chatLogger, metricsLine, parseChatArgs, runChat, type ChatDeps } from "../src/chat.js";
import type { KeyCheck } from "../src/config.js";
import { loadKey, saveKey } from "../src/config.js";
import { emptyResult } from "../src/io.js";
import { UsageError } from "../src/plan.js";
import type { RunConfig, RunResult } from "../src/types.js";
import { fakeOracle, fakeTransport } from "./fakes.js";
import { el, fakeChrome, fakePage, obs } from "./fast/fakes.js";

const GOOD = "good-key-0123456789abcdef";
const BAD = "bad-key-00123456789abcdef";
let dir = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-chat-"));
  env = { JEV_BROWSER_CONFIG: path.join(dir, "config.json") };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function fakeBrowser(url = "https://a.b/page") {
  const b = {
    url, closes: 0, urls: 0,
    async getUrl() { b.urls += 1; return b.url; },
    async close() { b.closes += 1; },
  };
  return b as unknown as Browser & typeof b;
}

function okResult(over: Partial<RunResult> = {}): RunResult {
  const r = emptyResult("t", "act", "jev-1");
  return {
    ...r, outcome: "done", reason: "done_final 0.9", final_url: "https://a.b/page", start: { url: "https://a.b", how: "task_url", confidence: null },
    stats: { steps: 2, jev_requests: 3, input_tokens: 44120, output_tokens: 61, duration_ms: 6789, model: "jev-1", pauses: 0, jev_ms: 2100, browser_ms: 1640, engine: "vercel" }, ...over,
  };
}

function session(lines: string[], envOver: NodeJS.ProcessEnv = env, deps: ChatDeps = {}, argv: string[] = []) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = "";
  stdout.on("data", (c) => { out += String(c); });
  const validated: string[] = [];
  const calls: RunConfig[] = [];
  const browser = fakeBrowser();
  const validate = deps.validate ?? (async (key: string): Promise<KeyCheck> => { validated.push(key); return key === GOOD ? { ok: true, model: "jev-1", usage: { input_tokens: 1, output_tokens: 1 } } : { ok: false, kind: "rejected", message: "401 unauthorized" }; });
  const runner = deps.runner ?? (async (cfg: RunConfig) => { calls.push(cfg); return okResult({ task: cfg.task }); });
  const transport = fakeTransport();
  stdin.end(lines.join("\n") + "\n");
  const code = runChat(argv, { stdin: stdin as unknown as NodeJS.ReadStream, stdout, env: envOver }, { validate, runner, browserFor: () => browser, exit: () => undefined, transport, ...deps });
  return { code, get out() { return out; }, validated, calls, browser, transport };
}

/** Poll with real timers until `cond` holds. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("until: timed out");
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

const API = process.env["TYPESAFE_BASE_URL"]?.replace(/\/+$/, "") ?? "https://api.typesafe.ai";

describe("runChat keep-alive transport", () => {
  it("warms the connection once after the key check and closes the transport on /quit", async () => {
    const s = session(["/quit"], { ...env, TYPESAFE_API_KEY: GOOD });
    expect(await s.code).toBe(0);
    expect(s.transport.warms).toEqual([API]);
    expect(s.transport.closes).toBe(1);
  });
  it("no warm when the key flow exits; the transport still closes", async () => {
    const s = session(["/quit"]);
    expect(await s.code).toBe(0);
    expect(s.transport.warms).toEqual([]);
    expect(s.transport.closes).toBe(1);
  });
  it("the default key check sends its request through the transport's fetch", async () => {
    const seen: { url: string; method: string; auth: string | null }[] = [];
    const transport = fakeTransport(async (url, init) => {
      seen.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ model: "jev-9", usage: { input_tokens: 3, output_tokens: 1 }, answers: { ok: { type: "noul", noul: 0.9 } } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (c) => { out += String(c); });
    stdin.end("/quit\n");
    const code = await runChat([], { stdin: stdin as unknown as NodeJS.ReadStream, stdout, env: { ...env, TYPESAFE_API_KEY: GOOD } }, { transport, runner: async (cfg) => okResult({ task: cfg.task }), browserFor: () => fakeBrowser(), exit: () => undefined });
    expect(code).toBe(0);
    expect(out).toContain("Key OK · model jev-9 · from env");
    expect(seen).toEqual([{ url: `${API}/v1/systemone`, method: "POST", auth: `Bearer ${GOOD}` }]);
    expect(transport.warms).toEqual([API]);
  });
  it("pings every 45 s while idle, skips a running task; the timer is unref'd and cleared on /quit", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      let out = "";
      stdout.on("data", (c) => { out += String(c); });
      const transport = fakeTransport();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => { release = r; });
      let started = false;
      const runner = async (cfg: RunConfig) => { started = true; await gate; return okResult({ task: cfg.task }); };
      const validate = async (): Promise<KeyCheck> => ({ ok: true, model: "jev-1", usage: { input_tokens: 1, output_tokens: 1 } });
      const code = runChat([], { stdin: stdin as unknown as NodeJS.ReadStream, stdout, env: { ...env, TYPESAFE_API_KEY: GOOD } }, { transport, runner, validate, browserFor: () => fakeBrowser(), exit: () => undefined });
      await until(() => out.includes("jev> "));
      expect(transport.warms).toHaveLength(1);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(IDLE_PING_MS);
      const timer = setIntervalSpy.mock.results[0]?.value as { hasRef(): boolean };
      expect(timer.hasRef()).toBe(false);
      await vi.advanceTimersByTimeAsync(IDLE_PING_MS);
      expect(transport.warms).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(IDLE_PING_MS);
      expect(transport.warms).toHaveLength(3);
      stdin.write("do the task\n");
      await until(() => started);
      await vi.advanceTimersByTimeAsync(IDLE_PING_MS);
      expect(transport.warms).toHaveLength(3);
      release();
      await until(() => out.includes("✔ done"));
      expect(clearIntervalSpy).not.toHaveBeenCalled();
      stdin.write("/quit\n");
      expect(await code).toBe(0);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
      expect(transport.closes).toBe(1);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });
  it("a warm that rejects never ends the chat: the startup warm and the idle ping are both caught", async () => {
    // The transport promises that warm never rejects. A rejection must still be harmless: the chat drops the
    // promise, and Node ends a process on an unhandled rejection.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => { rejections.push(e); };
    process.on("unhandledRejection", onRejection);
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      let out = "";
      stdout.on("data", (c) => { out += String(c); });
      const transport = fakeTransport();
      transport.warm = async (baseURL: string) => { transport.warms.push(baseURL); throw new TypeError("Invalid URL"); };
      const validate = async (): Promise<KeyCheck> => ({ ok: true, model: "jev-1", usage: { input_tokens: 1, output_tokens: 1 } });
      const code = runChat([], { stdin: stdin as unknown as NodeJS.ReadStream, stdout, env: { ...env, TYPESAFE_API_KEY: GOOD } }, { transport, validate, runner: async (cfg) => okResult({ task: cfg.task }), browserFor: () => fakeBrowser(), exit: () => undefined });
      await until(() => out.includes("jev> "));
      expect(transport.warms).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(IDLE_PING_MS);
      expect(transport.warms).toHaveLength(2);
      stdin.write("t1\n");
      await until(() => out.includes("✔ done"));
      stdin.write("/quit\n");
      expect(await code).toBe(0);
      await new Promise<void>((r) => setImmediate(r));
      expect(rejections).toEqual([]);
      expect(transport.closes).toBe(1);
    } finally {
      process.off("unhandledRejection", onRejection);
      vi.useRealTimers();
    }
  });
  it("no idle ping starts while a task reads the current URL", async () => {
    // The ping would queue ahead of the task's first Jev request on the one socket.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      let out = "";
      stdout.on("data", (c) => { out += String(c); });
      const transport = fakeTransport();
      const browser = fakeBrowser();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => { release = r; });
      let urlReads = 0;
      browser.getUrl = async () => { urlReads += 1; await gate; return browser.url; };
      const validate = async (): Promise<KeyCheck> => ({ ok: true, model: "jev-1", usage: { input_tokens: 1, output_tokens: 1 } });
      const code = runChat([], { stdin: stdin as unknown as NodeJS.ReadStream, stdout, env: { ...env, TYPESAFE_API_KEY: GOOD } }, { transport, validate, runner: async (cfg) => okResult({ task: cfg.task }), browserFor: () => browser, exit: () => undefined });
      await until(() => out.includes("jev> "));
      // The first task opens the browser. The second one reads its URL first, and that read is held.
      stdin.write("t1\n");
      await until(() => out.includes("✔ done"));
      expect(transport.warms).toHaveLength(1);
      stdin.write("t2\n");
      await until(() => urlReads === 1);
      await vi.advanceTimersByTimeAsync(IDLE_PING_MS);
      expect(transport.warms).toHaveLength(1);
      release();
      await until(() => out.split("✔ done").length === 3);
      stdin.write("/quit\n");
      expect(await code).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("parseChatArgs", () => {
  it("defaults to headed, keepOpen, and a jev-chat session; --headless and --reset-key work", () => {
    const o = parseChatArgs([], {});
    expect(o.cfg).toMatchObject({ headed: true, keepOpen: true, task: "", logLevel: "info" });
    expect(o.cfg.session).toMatch(/^jev-chat-[0-9a-f]{8}$/);
    expect(o).toMatchObject({ resetKey: false, help: false });
    const h = parseChatArgs(["--headless", "--reset-key", "--session", "s1", "--model", "m", "--max-steps", "3", "--profile", "BP", "--confirm", "never", "--log-level", "debug"], {});
    expect(h.cfg).toMatchObject({ headed: false, session: "s1", model: "m", maxSteps: 3, profile: "BP", confirm: "never", logLevel: "debug" });
    expect(h.resetKey).toBe(true);
  });
  it("engine flags: cdp is the default, JEV_BROWSER_ENGINE overrides it, --engine wins; --refresh-profile takes no value", () => {
    expect(parseChatArgs([], {}).cfg.engine).toBe("cdp");
    expect(parseChatArgs([], { JEV_BROWSER_ENGINE: "vercel" }).cfg.engine).toBe("vercel");
    const f = parseChatArgs(["--engine", "vercel", "--refresh-profile", "--profile", "BP", "--chrome-bin", "/x/chrome"], {});
    expect(f.cfg).toMatchObject({ engine: "vercel", refreshProfile: true, profile: "BP", chromeBin: "/x/chrome" });
    expect(() => parseChatArgs(["--engine", "slow"], {})).toThrow(UsageError);
  });
  it("accepts chromium and rejects removed engine names", () => {
    expect(parseChatArgs(["--engine", "chromium"], {}).cfg.engine).toBe("chromium");
    expect(parseChatArgs([], { JEV_BROWSER_ENGINE: "chromium" }).cfg.engine).toBe("chromium");
    for (const engine of ["fast", "legacy"]) expect(() => parseChatArgs(["--engine", engine], {})).toThrow(UsageError);
  });
  it("rejects a task argument and unknown flags", () => {
    expect(() => parseChatArgs(["open gmail"], {})).toThrow(/jev-browser "open gmail"/);
    expect(() => parseChatArgs(["--url", "https://x"], {})).toThrow(UsageError);
    expect(() => parseChatArgs(["--confirm", "maybe"], {})).toThrow(UsageError);
  });
  it("usage errors exit 4 and --help exits 0", async () => {
    const bad = session([], env, {}, ["--bogus"]);
    expect(await bad.code).toBe(4);
    expect(bad.out).toContain("unknown flag --bogus");
    const help = session([], env, {}, ["--help"]);
    expect(await help.code).toBe(0);
    expect(help.out).toContain("/headed on|off");
  });
});

describe("metricsLine and chatLogger", () => {
  it("formats seconds to one decimal and thousands separators", () => {
    expect(metricsLine(okResult().stats)).toBe("time 6.8 s (jev 2.1 s · browser 1.6 s) · input 44,120 tokens · output 61 tokens · 2 steps · 3 requests");
    expect(metricsLine(emptyResult("t", "act").stats)).toBe("time 0.0 s (jev 0.0 s · browser 0.0 s) · input 0 tokens · output 0 tokens · 0 steps · 0 requests");
  });
  it("prints steps and warnings, plan and open lines, and nothing at debug", () => {
    const outStream = new PassThrough(); let out = ""; outStream.on("data", (c) => { out += String(c); });
    const log = chatLogger(outStream);
    log.redactor = (s) => s.replace("hunter2", "***");
    log.info("plan profile=none"); log.info("chrome 153 pid 1 udd=/tmp/x"); log.info("open https://x"); log.info("continue on https://y"); log.info("something else"); log.debug("dbg"); log.warn("careful");
    log.step({ step: 1, url: "u", title: "t", page_kind: null, page_kind_conf: null, done_p: null, operation: "TYPE_TEXT", operation_conf: null, target: { ref: "e1", role: "textbox", name: "Password", under: "" }, target_conf: null, runner_up: null, action: "fill", value: "hunter2", value_conf: null, risk: null, path: null, gate: "ok", result: "ok", error: null, jev_requests: 1, duration_ms: 5 });
    log.step({ step: 2, url: "u", title: "t", page_kind: null, page_kind_conf: null, done_p: null, operation: "CLICK", operation_conf: null, target: null, target_conf: null, runner_up: null, action: "click", value: null, value_conf: null, risk: null, path: null, gate: "ok", result: "failed", error: "covered", jev_requests: 1, duration_ms: 5 });
    expect(out).toBe('  plan profile=none\n  chrome 153 pid 1 udd=/tmp/x\n  open https://x\n  continue on https://y\n  ! careful\n  1. fill textbox "Password" value="***" -> ok\n  2. click -> failed covered\n');
  });
});

describe("runChat key flow", () => {
  it("(a) no key -> prompts, rejected once, then accepted and saved", async () => {
    const s = session([BAD, GOOD, "/quit"]);
    expect(await s.code).toBe(0);
    expect(s.out).toContain(`Paste your TypeSafe API key (saved to ${env["JEV_BROWSER_CONFIG"]}): `);
    expect(s.out).toContain("Key rejected by TypeSafe (401 unauthorized). Try again.");
    expect(s.out).toContain(`Key saved to ${env["JEV_BROWSER_CONFIG"]} (mode 600). Run with --reset-key to change it.`);
    expect(s.out).toContain("Key OK · model jev-1");
    expect(s.validated).toEqual([BAD, GOOD]);
    expect(loadKey(env)).toEqual({ key: GOOD, source: "file" });
    expect(s.out).toContain("jev-browser chat");
  });
  it("/quit at the key prompt exits 0 without a key check or a saved file", async () => {
    const s = session(["/quit"]);
    expect(await s.code).toBe(0);
    expect(s.out).toContain("Paste your");
    expect(s.out).toContain("Bye.");
    expect(s.validated).toEqual([]);
    expect(fs.existsSync(env["JEV_BROWSER_CONFIG"] as string)).toBe(false);
  });
  it("(b) key in env -> no prompt", async () => {
    const s = session(["/quit"], { ...env, TYPESAFE_API_KEY: GOOD });
    expect(await s.code).toBe(0);
    expect(s.out).not.toContain("Paste your");
    expect(s.out).toContain("Key OK · model jev-1 · from env");
    expect(s.validated).toEqual([GOOD]);
    expect(fs.existsSync(env["JEV_BROWSER_CONFIG"] as string)).toBe(false);
  });
  it("(g) --reset-key deletes the saved file before prompting", async () => {
    saveKey(BAD, env);
    const s = session([GOOD, "/quit"], env, {}, ["--reset-key"]);
    expect(await s.code).toBe(0);
    expect(s.validated).toEqual([GOOD]);
    expect(s.out).toContain("Paste your");
    expect(loadKey(env)).toEqual({ key: GOOD, source: "file" });
  });
  it("a rejected saved key falls into the prompt; a rejected env key exits 4; three rejections exit 4", async () => {
    saveKey(BAD, env);
    const s = session([GOOD, "/quit"]);
    expect(await s.code).toBe(0);
    expect(s.out).toContain("Saved key rejected (401 unauthorized).");
    expect(s.validated).toEqual([BAD, GOOD]);
    const e = session(["/quit"], { ...env, TYPESAFE_API_KEY: BAD });
    expect(await e.code).toBe(4);
    expect(e.out).toContain("rejected");
    const three = session([BAD, BAD, BAD, "/quit"], { JEV_BROWSER_CONFIG: path.join(dir, "three.json") });
    expect(await three.code).toBe(4);
    expect(three.out).toContain("Too many failed attempts.");
    expect(three.validated).toEqual([BAD, BAD, BAD]);
  });
  it("a network error offers to save without a check", async () => {
    const validate = async (): Promise<KeyCheck> => ({ ok: false, kind: "network", message: "ECONNREFUSED" });
    const s = session([GOOD, "y", "/quit"], env, { validate });
    expect(await s.code).toBe(0);
    expect(s.out).toContain("Save the key without checking it? [y/N] ");
    expect(loadKey(env)).toEqual({ key: GOOD, source: "file" });
  });
});

describe("runChat tasks", () => {
  const withKey = () => ({ ...env, TYPESAFE_API_KEY: GOOD });
  it("(c) a task line runs the runner with task and keepOpen and prints the metrics line", async () => {
    const s = session(["open https://a.b and click English", "/quit"], withKey());
    expect(await s.code).toBe(0);
    expect(s.calls.length).toBe(1);
    expect(s.calls[0]).toMatchObject({ task: "open https://a.b and click English", keepOpen: true, headed: true });
    expect(s.calls[0]?.fallbackUrl).toBeUndefined();
    expect(s.out).toContain("✔ done · done_final 0.9\n  url https://a.b/page\ntime 6.8 s (jev 2.1 s · browser 1.6 s) · input 44,120 tokens · output 61 tokens · 2 steps · 3 requests\n");
  });
  it("(d) the second task gets fallbackUrl from the open browser", async () => {
    const s = session(["first task https://a.b", "second task", "/quit"], withKey());
    expect(await s.code).toBe(0);
    expect(s.calls.map((c) => c.fallbackUrl)).toEqual([undefined, "https://a.b/page"]);
    expect(s.browser.urls).toBe(1);
  });
  it("(e) /stats sums two tasks", async () => {
    const s = session(["t1", "t2", "/stats", "/quit"], withKey());
    expect(await s.code).toBe(0);
    expect(s.out).toContain("Session · 2 tasks · 13.6 s (jev 4.2 s · browser 3.3 s) · input 88,240 tokens · output 122 tokens · 6 requests\n");
    expect(s.out).toContain(`browser session ${s.calls[0]?.session} · run timeout 600000 ms · step timeout 30000 ms`);
  });
  it("(f) /quit closes the browser once and returns 0", async () => {
    const s = session(["t1", "/quit", "t2"], withKey());
    expect(await s.code).toBe(0);
    expect(s.browser.closes).toBe(1);
    expect(s.calls.length).toBe(1);
    expect(s.out).toContain("Session · 1 tasks · 6.8 s (jev 2.1 s · browser 1.6 s) · input 44,120 tokens · output 61 tokens\n");
    const never = session(["/quit"], withKey());
    expect(await never.code).toBe(0);
    expect(never.browser.closes).toBe(0);
  });
  it("(h) a runner that throws prints the failed line and a zero metrics line; the chat continues", async () => {
    let n = 0;
    const runner = async (cfg: RunConfig) => { n += 1; if (n === 1) throw new Error("kaboom"); if (n === 2) throw new UsageError("unknown profile \"x\""); return okResult({ task: cfg.task }); };
    const s = session(["t1", "t2", "t3", "/quit"], withKey(), { runner });
    expect(await s.code).toBe(0);
    expect(s.out).toContain("✖ failed · internal: kaboom\ntime 0.0 s (jev 0.0 s · browser 0.0 s) · input 0 tokens · output 0 tokens · 0 steps · 0 requests\n");
    expect(s.out).toContain("✖ usage · unknown profile \"x\"\ntime 0.0 s (jev 0.0 s · browser 0.0 s) · input 0 tokens · output 0 tokens · 0 steps · 0 requests\n");
    expect(s.out).toContain("✔ done");
    expect(n).toBe(3);
  });
  it("prints check, extract, blocked, and failed results", async () => {
    const results: RunResult[] = [
      okResult({ goal: "check", answer: { kind: "check", answer: true, probability: 0.987, evidence: ["treeitem \"Sept 3\""] } }),
      okResult({ goal: "extract", answer: { kind: "extract", text: "Alan Turing", line_id: "L1", evidence: [] } }),
      okResult({ outcome: "blocked", blocked: { kind: "needs_sign_in", hint: "sign in first", top: [], resume: { session: "s", url: null } } }),
      okResult({ outcome: "failed", error: { kind: "browser", message: "launch failed" }, final_url: null }),
    ];
    const runner = async () => results.shift() as RunResult;
    const s = session(["a", "b", "c", "d", "/url", "/quit"], withKey(), { runner });
    expect(await s.code).toBe(0);
    expect(s.out).toContain("✔ done · answer yes (p=0.99) · evidence: treeitem \"Sept 3\"");
    expect(s.out).toContain("✔ done · Alan Turing");
    expect(s.out).toContain("■ blocked · needs_sign_in: sign in first");
    expect(s.out).toContain("✖ failed · browser: launch failed");
    expect(s.out).toContain("no browser open");
    expect(s.browser.closes).toBe(0);
  });
  it("/headed, /profile, /close, /url, and /help", async () => {
    const s = session(["t1", "/url", "/headed off", "t2", "/close", "/close", "/profile none", "/help", "/exit"], withKey());
    expect(await s.code).toBe(0);
    expect(s.out).toContain("https://a.b/page\n");
    expect(s.out).toContain("Closed the browser. The next task starts a new one.\nheaded off\n");
    expect(s.calls.map((c) => c.headed)).toEqual([true, false]);
    expect(s.calls[1]?.fallbackUrl).toBeUndefined();
    expect(s.out).toContain("browser closed\njev> no browser open\njev> profile none\n");
    expect(s.out).toContain("Commands:");
    expect(s.browser.closes).toBe(2);
  });
  it("a line that starts with / but is not a command runs as a task (spec: anything else is a task)", async () => {
    const s = session(["/tmp/report.pdf open it in the browser", "/nope", "/quit"], withKey());
    expect(await s.code).toBe(0);
    expect(s.calls.map((c) => c.task)).toEqual(["/tmp/report.pdf open it in the browser", "/nope"]);
    expect(s.out).not.toContain("unknown command");
  });
  it("EOF without /quit closes the browser and exits 0", async () => {
    const s = session(["t1"], withKey());
    expect(await s.code).toBe(0);
    expect(s.browser.closes).toBe(1);
  });
});

// A stdin that looks like a terminal. readline runs in terminal mode and emits SIGINT on Ctrl-C.
function ttyStdin(): PassThrough & { isTTY: true; setRawMode: (v: boolean) => void; isRaw: boolean } {
  const s = new PassThrough() as PassThrough & { isTTY: true; setRawMode: (v: boolean) => void; isRaw: boolean };
  s.isTTY = true;
  s.isRaw = false;
  s.setRawMode = (v: boolean) => { s.isRaw = v; };
  return s;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(get: () => string, text: string, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!get().includes(text)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(text)} in:\n${get()}`);
    await delay(5);
  }
}

function ttySession(envOver: NodeJS.ProcessEnv, deps: ChatDeps = {}, argv: string[] = []) {
  const stdin = ttyStdin();
  const stdout = new PassThrough();
  let out = "";
  stdout.on("data", (c) => { out += String(c); });
  const validated: string[] = [];
  const calls: RunConfig[] = [];
  const exits: number[] = [];
  const browser = fakeBrowser();
  const validate = deps.validate ?? (async (key: string): Promise<KeyCheck> => { validated.push(key); return key === GOOD ? { ok: true, model: "jev-1", usage: { input_tokens: 1, output_tokens: 1 } } : { ok: false, kind: "rejected", message: "401 unauthorized" }; });
  const runner = deps.runner ?? (async (cfg: RunConfig) => { calls.push(cfg); return okResult({ task: cfg.task }); });
  const code = runChat(argv, { stdin: stdin as unknown as NodeJS.ReadStream, stdout, env: envOver }, { validate, runner, browserFor: () => browser, exit: (c) => { exits.push(c); }, ...deps });
  const get = () => out;
  return { code, stdin, get out() { return out; }, validated, calls, browser, exits, wait: (text: string) => waitFor(get, text), type: (s: string) => { stdin.write(s); } };
}

describe("runChat on a TTY", () => {
  const withKey = () => ({ ...env, TYPESAFE_API_KEY: GOOD });

  it("Ctrl-C at the prompt behaves like /quit: closes the browser, prints the totals, returns 0", async () => {
    const s = ttySession(withKey());
    await s.wait("jev> ");
    s.type("t1\r");
    await s.wait("time 6.8 s");
    await s.wait("jev> ");
    s.type("\u0003");
    const code = await Promise.race([s.code, delay(1500).then(() => "hung" as const)]);
    expect(code).toBe(0);
    expect(s.browser.closes).toBe(1);
    expect(s.out).toContain("Session · 1 tasks · 6.8 s (jev 2.1 s");
    expect(s.exits).toEqual([]);
  });

  it("Ctrl-C during a task prints interrupted, closes the browser, prints the totals, and exits 130", async () => {
    let release: () => void = () => undefined;
    const runner = async (cfg: RunConfig) => { await new Promise<void>((r) => { release = r; }); return okResult({ task: cfg.task, final_url: null, steps: [] }); };
    const s = ttySession(withKey(), { runner });
    await s.wait("jev> ");
    s.type("slow task\r");
    await delay(30);
    s.type("\u0003");
    await s.wait("Session · 0 tasks");
    expect(s.out).toContain("interrupted\n");
    expect(s.exits).toEqual([130]);
    expect(s.browser.closes).toBe(1);
    release();
    expect(await s.code).toBe(0);
    expect(s.browser.closes).toBe(1);
  });

  it("readMasked drops escape sequences and Ctrl-U clears the line", async () => {
    const s = ttySession(env);
    await s.wait("Paste your TypeSafe API key");
    s.type("abc\u0015");
    s.type(GOOD.slice(0, 10));
    s.type("\u001b[D");
    s.type(GOOD.slice(10));
    s.type("\u001bOA\u001b[3~");
    s.type("\r");
    await s.wait("jev> ");
    s.type("/quit\r");
    expect(await s.code).toBe(0);
    expect(s.validated).toEqual([GOOD]);
    const masked = s.out.slice(s.out.indexOf("Paste your"), s.out.indexOf("Key saved"));
    expect(masked.split("*").length - 1).toBe(GOOD.length + 3);
    expect(masked).toContain("\b \b\b \b\b \b");
  });

  it("confirm and pause ignore type-ahead and read a fresh line; the queued line becomes the next task", async () => {
    const seen: { confirm: boolean[]; pause: string[] } = { confirm: [], pause: [] };
    const tasks: string[] = [];
    let n = 0;
    const runner = async (cfg: RunConfig, ctx: { human: Human }) => {
      n += 1;
      tasks.push(cfg.task);
      if (n === 1) {
        await delay(40);
        seen.pause.push(await ctx.human.pause("sign in", 3000));
        seen.confirm.push(await ctx.human.confirm("Type y to allow: ", 3000));
        seen.confirm.push(await ctx.human.confirm("Type y to allow: ", 3000));
        seen.pause.push(await ctx.human.pause("again", 3000));
      }
      return okResult({ task: cfg.task });
    };
    const s = ttySession(withKey(), { runner });
    await s.wait("jev> ");
    s.type("task one\r");
    await delay(10);
    s.type("next task\r");
    await s.wait("Press Enter when the page is ready");
    await delay(50);
    expect(seen.pause).toEqual([]);
    s.type("\r");
    await s.wait("Type y to allow: ");
    s.type("y\r");
    await waitFor(() => String(seen.confirm.length), "1");
    s.type("nope\r");
    await waitFor(() => String(seen.confirm.length), "2");
    await s.wait("PAUSED again");
    s.type("q\r");
    await waitFor(() => String(tasks.length), "2");
    s.type("/quit\r");
    expect(await s.code).toBe(0);
    expect(seen).toEqual({ confirm: [true, false], pause: ["resumed", "aborted"] });
    expect(tasks).toEqual(["task one", "next task"]);
  });

  it("pause: a poll that wins aborts the pending question; a timeout gives timeout", async () => {
    const results: string[] = [];
    const runner = async (cfg: RunConfig, ctx: { human: Human }) => {
      let polls = 0;
      results.push(await ctx.human.pause("wall", 5000, async () => { polls += 1; return polls >= 2; }));
      results.push(await ctx.human.pause("wall", 30));
      return okResult({ task: cfg.task });
    };
    const s = ttySession(withKey(), { runner, pausePollMs: 10 });
    await s.wait("jev> ");
    s.type("t\r");
    await s.wait("time 6.8 s");
    s.type("/quit\r");
    expect(await s.code).toBe(0);
    expect(results).toEqual(["resumed", "timeout"]);
  });
});

describe("runChat browser state", () => {
  const withKey = () => ({ ...env, TYPESAFE_API_KEY: GOOD });

  it("a browser error that is not a launch failure still closes the browser on /quit, /headed, and /profile", async () => {
    const results: RunResult[] = [
      okResult({ outcome: "failed", error: { kind: "browser", message: "timeout: snapshot" } }),
      okResult(),
      okResult({ outcome: "failed", error: { kind: "browser", message: "tab_gone" }, final_url: null, steps: [] }),
      okResult(),
      okResult({ outcome: "failed", error: { kind: "browser", message: "timeout: get url" }, final_url: null, steps: [] }),
    ];
    const runner = async () => results.shift() as RunResult;
    const s = session(["t1", "/headed off", "t2", "t3", "/profile none", "t4", "t5", "/quit"], withKey(), { runner });
    expect(await s.code).toBe(0);
    expect(s.browser.closes).toBe(3);
  });

  it("a launch failure marks the browser closed", async () => {
    const results: RunResult[] = [okResult({ outcome: "failed", error: { kind: "browser", message: "failed to launch chrome" }, final_url: null, steps: [] })];
    const runner = async () => results.shift() as RunResult;
    const s = session(["t1", "/close", "/quit"], withKey(), { runner });
    expect(await s.code).toBe(0);
    expect(s.out).toContain("no browser open");
    expect(s.browser.closes).toBe(0);
  });

  it("a blocked ambiguous_profile result with start does not mark the browser open; about:blank is no fallback", async () => {
    const results: RunResult[] = [
      okResult({ outcome: "blocked", blocked: { kind: "ambiguous_profile", hint: "Name the profile", top: [], resume: { session: "s", url: null } }, final_url: null, steps: [], start: { url: "https://github.com", how: "catalog", confidence: null } }),
      okResult(),
      okResult(),
    ];
    const runner = async (cfg: RunConfig) => { calls.push(cfg); return results.shift() as RunResult; };
    const calls: RunConfig[] = [];
    const s = session(["t1", "t2", "t3", "/quit"], withKey(), { runner });
    s.browser.url = "about:blank";
    expect(await s.code).toBe(0);
    expect(calls.map((c) => c.fallbackUrl)).toEqual([undefined, undefined, undefined]);
    expect(s.browser.urls).toBe(1);
    expect(s.browser.closes).toBe(1);
  });

  it("a pause with a poll after stdin EOF finishes with a ref'd timer and prints the metrics line", async () => {
    const refs: [unknown, boolean][] = [];
    const orig = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const t = orig(fn, ms);
      queueMicrotask(() => { refs.push([ms, t.hasRef()]); });
      return t;
    }) as unknown as typeof setTimeout);
    try {
      let polls = 0;
      const runner = async (cfg: RunConfig, ctx: { human: Human }) => {
        const r = await ctx.human.pause("sign in", 20000, async () => { polls += 1; return polls >= 3; });
        return okResult({ task: cfg.task, reason: `pause ${r}` });
      };
      const s = session(["sign in task"], withKey(), { runner, pausePollMs: 15 });
      expect(await s.code).toBe(0);
      expect(polls).toBe(3);
      expect(s.out).toContain("PAUSED sign in\n");
      expect(s.out).toContain("✔ done · pause resumed");
      expect(s.out).toContain("time 6.8 s");
      const pollTimers = refs.filter(([ms]) => ms === 15);
      expect(pollTimers.length).toBe(2);
      expect(pollTimers.every(([, ref]) => ref)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("an unknown profile from the real Runner prints the usage line with zero metrics", async () => {
    let n = 0;
    const runner = async (cfg: RunConfig) => {
      n += 1;
      if (n === 1) return okResult({ outcome: "failed", error: { kind: "internal", message: "unknown profile \"bogus\". Available: Parallelloop (Profile 14)" }, final_url: null, steps: [], start: null, stats: { ...okResult().stats, duration_ms: 321 } });
      return okResult({ task: cfg.task });
    };
    const s = session(["t1", "/stats", "t2", "/quit"], withKey(), { runner });
    expect(await s.code).toBe(0);
    expect(s.out).toContain("✖ usage · unknown profile \"bogus\". Available: Parallelloop (Profile 14)\ntime 0.0 s (jev 0.0 s · browser 0.0 s) · input 0 tokens · output 0 tokens · 0 steps · 0 requests\n");
    expect(s.out).toContain("Session · 0 tasks");
    expect(s.out).toContain("✔ done");
  });

  it("--var and /var give the task vars; the credential hint names /var", async () => {
    const results: RunResult[] = [okResult({ outcome: "blocked", blocked: { kind: "needs_credential", hint: "field \"Password\" needs --var <key>=<value>", top: [], resume: { session: "s", url: null } } }), okResult()];
    const calls: RunConfig[] = [];
    const runner = async (cfg: RunConfig) => { calls.push(cfg); return results.shift() as RunResult; };
    const s = session(["t1", "/var Password=hunter2", "/var broken", "t2", "/quit"], withKey(), { runner }, ["--var", "user=me"]);
    expect(await s.code).toBe(0);
    expect(s.out).toContain("■ blocked · needs_credential: field \"Password\" needs /var <key>=<value> or --var <key>=<value>");
    expect(s.out).toContain("var password set\njev> usage: /var <key=value>\n");
    expect(calls[0]?.vars).toEqual({ user: "me" });
    expect(calls[1]?.vars).toEqual({ user: "me", password: "hunter2" });
  });
});

describe("runChat key edge cases", () => {
  const GOOD2 = "good-key-second-0123456789";
  const anyGood = async (key: string): Promise<KeyCheck> => key.startsWith("good-") ? { ok: true, model: "jev-1", usage: { input_tokens: 1, output_tokens: 1 } } : { ok: false, kind: "rejected", message: "401" };

  it("a valid saved key prints from file", async () => {
    saveKey(GOOD, env);
    const s = session(["/quit"], env);
    expect(await s.code).toBe(0);
    expect(s.out).toContain("Key OK · model jev-1 · from file");
    expect(s.validated).toEqual([GOOD]);
  });

  it("/key validates and saves a new key", async () => {
    saveKey(GOOD, env);
    const s = session(["/key", GOOD2, "/quit"], env, { validate: anyGood });
    expect(await s.code).toBe(0);
    expect(s.out).toContain(`Key saved to ${env["JEV_BROWSER_CONFIG"]} (mode 600).`);
    expect(loadKey(env)).toEqual({ key: GOOD2, source: "file" });
    expect(s.out).not.toContain("TYPESAFE_API_KEY is set");
  });

  it("--reset-key and /key explain that the environment key has priority", async () => {
    saveKey(GOOD, env);
    const s = session(["/key", GOOD2, "/quit"], { ...env, TYPESAFE_API_KEY: GOOD }, { validate: anyGood }, ["--reset-key"]);
    expect(await s.code).toBe(0);
    const note = "TYPESAFE_API_KEY is set in the environment (or .env). It has priority over the saved file. Unset it to use the saved key.";
    expect(s.out.split(note).length - 1).toBe(2);
    expect(s.out).toContain("Key OK · model jev-1 · from env");
    const idx = s.out.indexOf("Paste your");
    expect(idx).toBeGreaterThan(s.out.indexOf("jev> "));
    expect(loadKey({ JEV_BROWSER_CONFIG: env["JEV_BROWSER_CONFIG"] as string })).toEqual({ key: GOOD2, source: "file" });
  });

  it("a saveKey failure keeps the validated key for the session", async () => {
    fs.writeFileSync(path.join(dir, "afile"), "x");
    const bad = { JEV_BROWSER_CONFIG: path.join(dir, "afile", "config.json") };
    const s = session([GOOD, "t1", "/quit"], bad);
    expect(await s.code).toBe(0);
    expect(s.out).toContain(`Could not save the key to ${bad.JEV_BROWSER_CONFIG}: `);
    expect(s.out).toContain("Using it for this session only.");
    expect(s.out).toContain("Key OK · model jev-1");
    expect(s.calls.length).toBe(1);
  });
});

describe("runChat fast engine", () => {
  const withKey = () => ({ ...env, TYPESAFE_API_KEY: GOOD });
  const HOME = obs("https://www.wikipedia.org/", [el("e1", "click", "English", "link")], "Wikipedia");
  const ARTICLE = obs("https://en.wikipedia.org/wiki/Alan_Turing", [el("e1", "click", "Main menu", "button")], "Alan Turing");

  function fastSession(lines: string[], argv: string[] = []) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (c) => { out += String(c); });
    const chrome = fakeChrome();
    const page = fakePage({ pages: { home: HOME, article: ARTICLE }, start: "home", transitions: (c) => (c.op === "act" && c.id === "e1" ? "article" : undefined) });
    let launches = 0;
    let opened = 0;
    const launchOpts: { headed: boolean; profileDirectory?: string }[] = [];
    const oracle = fakeOracle((name, state, questions) => {
      if (name !== "step") return { goal: "act" };
      const url = (state as { page: { url: string } }).page.url;
      if (url === HOME.url) {
        const q = questions["click_target"] as { criteria?: Record<string, { element?: string }> } | undefined;
        const key = Object.entries(q?.criteria ?? {}).find(([, v]) => String(v?.element ?? "").includes("English"))?.[0] ?? "none";
        return { operation: { choice: "CLICK", confidence: 0.8, probabilities: { CLICK: 0.8, DONE: 0.1, WAIT: 0.1 } }, click_target: { choice: key, confidence: 0.7 } };
      }
      return { operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, CLICK: 0.05, WAIT: 0.05 } } };
    });
    const validate = async (): Promise<KeyCheck> => ({ ok: true, model: "jev-1", usage: { input_tokens: 1, output_tokens: 1 } });
    stdin.end(lines.join("\n") + "\n");
    const code = runChat(argv, { stdin: stdin as unknown as NodeJS.ReadStream, stdout, env: withKey() }, {
      validate, exit: () => undefined, profiles: [],
      launch: async (o) => { launches += 1; launchOpts.push({ headed: o.headed, ...(o.profileDirectory ? { profileDirectory: o.profileDirectory } : {}) }); return chrome; },
      openPage: async () => { opened += 1; return page; },
      oracle: () => oracle,
    });
    return { code, get out() { return out; }, chrome, page, oracle, counts: () => ({ launches, opened }), launchOpts };
  }

  it("keeps one Chrome and one Page across tasks; the second task continues on the page; /url reads the page; /quit closes Chrome once", async () => {
    const s = fastSession(["open wikipedia.org and click English", "/url", "click Main menu", "/url", "/quit"], ["--headless", "--profile", "none"]);
    expect(await s.code).toBe(0);
    expect(s.counts()).toEqual({ launches: 1, opened: 1 });
    expect(s.launchOpts).toEqual([{ headed: false }]);
    expect(s.chrome.closes).toBe(1);
    expect(s.out).toContain("engine cdp");
    expect(s.out).toContain("open https://wikipedia.org");
    expect(s.out).toContain("continue on https://en.wikipedia.org/wiki/Alan_Turing");
    expect(s.out).toContain("https://en.wikipedia.org/wiki/Alan_Turing\n");
    expect(s.out).toMatch(/time \d+\.\d s \(jev 0\.0 s · browser 0\.0 s\) · input 300 tokens · output 30 tokens · 2 steps · 3 requests/);
    expect(s.out).toContain("Session · 2 tasks");
    const navigations = s.page.calls.filter((c) => c.op === "navigate");
    expect(navigations).toEqual([{ op: "navigate", url: "https://wikipedia.org" }]);
  });

  it("/close closes Chrome, /url then says no browser, and the next task launches again; EOF closes Chrome", async () => {
    const s = fastSession(["open wikipedia.org and click English", "/close", "/url", "/close", "open wikipedia.org and click English"], ["--headless", "--profile", "none"]);
    expect(await s.code).toBe(0);
    expect(s.counts().launches).toBe(2);
    expect(s.chrome.closes).toBe(2);
    expect(s.out).toContain("browser closed\njev> no browser open\njev> no browser open\n");
  });

  it.each(["cdp", "chromium"] as const)("passes the %s browser selection and command timeout to launch", async (engine) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const timeouts: (number | undefined)[] = [];
    const browsers: (string | undefined)[] = [];
    const page = fakePage({ pages: { home: HOME }, start: "home" });
    const oracle = fakeOracle(() => ({ operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } }));
    stdin.end("open wikipedia.org\n/quit\n");
    const code = await runChat(["--engine", engine, "--headless", "--profile", "none"], { stdin: stdin as unknown as NodeJS.ReadStream, stdout, env: withKey() }, {
      validate: async (): Promise<KeyCheck> => ({ ok: true, model: "jev-1", usage: { input_tokens: 1, output_tokens: 1 } }), exit: () => undefined, profiles: [],
      launch: async (o) => { timeouts.push(o.commandTimeoutMs); browsers.push(o.browser); return fakeChrome(); }, openPage: async () => page, oracle: () => oracle,
    });
    expect(code).toBe(0);
    expect(timeouts).toEqual([30000]);
    expect(browsers).toEqual([engine === "chromium" ? "chromium" : "chrome"]);
  });

  it("a Chrome whose connection closed between tasks is closed and launched again; the next task does not fail as browser", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (c) => { out += String(c); });
    const chromes: ReturnType<typeof fakeChrome>[] = [];
    const page = fakePage({ pages: { home: HOME, article: ARTICLE }, start: "home", transitions: (c) => (c.op === "act" && c.id === "e1" ? "article" : undefined) });
    const oracle = fakeOracle((name, state, questions) => {
      if (name !== "step") return { goal: "act" };
      const url = (state as { page: { url: string } }).page.url;
      if (url === HOME.url) {
        const q = questions["click_target"] as { criteria?: Record<string, { element?: string }> } | undefined;
        const key = Object.entries(q?.criteria ?? {}).find(([, v]) => String(v?.element ?? "").includes("English"))?.[0] ?? "none";
        return { operation: { choice: "CLICK", confidence: 0.8, probabilities: { CLICK: 0.8, DONE: 0.1, WAIT: 0.1 } }, click_target: { choice: key, confidence: 0.7 } };
      }
      return { operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, CLICK: 0.05, WAIT: 0.05 } } };
    });
    const code = runChat(["--headless", "--profile", "none"], { stdin: stdin as unknown as NodeJS.ReadStream, stdout, env: withKey() }, {
      validate: async (): Promise<KeyCheck> => ({ ok: true, model: "jev-1", usage: { input_tokens: 1, output_tokens: 1 } }), exit: () => undefined, profiles: [],
      launch: async () => { const c = fakeChrome(); chromes.push(c); return c; }, openPage: async () => page, oracle: () => oracle,
    });
    const until = async (re: RegExp) => { for (let i = 0; i < 200 && !re.test(out); i++) await new Promise((r) => setTimeout(r, 5)); expect(out).toMatch(re); };
    await until(/jev> /);
    stdin.write("open wikipedia.org and click English\n");
    await until(/2 steps · 3 requests/);
    // The user quits the Chrome window: the connection closes, the page is gone.
    (chromes[0]?.client as { closed: boolean }).closed = true;
    page.current = "home";
    stdin.write("open wikipedia.org and click English\n");
    await until(/2 steps · 3 requests[^]*2 steps · \d+ requests/);
    stdin.end("/quit\n");
    expect(await code).toBe(0);
    expect(chromes).toHaveLength(2);
    expect(chromes[0]?.closes).toBe(1);
    expect(chromes[1]?.closes).toBe(1);
    expect(out).not.toContain("failed · browser");
    expect(out).not.toContain("continue on");
    expect(page.calls.filter((c) => c.op === "navigate")).toHaveLength(2);
  });

  it("each task reports its own browser time; the session total is their sum", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (c) => { out += String(c); });
    const page = fakePage({ pages: { home: HOME }, start: "home" });
    const observe = page.observe.bind(page);
    page.observe = async () => { page.stats.browserMs += 1000; return observe(); };
    const oracle = fakeOracle(() => ({ operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } }));
    stdin.end("open wikipedia.org\nread the page\n/quit\n");
    const code = await runChat(["--headless", "--profile", "none"], { stdin: stdin as unknown as NodeJS.ReadStream, stdout, env: withKey() }, {
      validate: async (): Promise<KeyCheck> => ({ ok: true, model: "jev-1", usage: { input_tokens: 1, output_tokens: 1 } }), exit: () => undefined, profiles: [],
      launch: async () => fakeChrome(), openPage: async () => page, oracle: () => oracle,
    });
    expect(code).toBe(0);
    const browser = [...out.matchAll(/^time .*browser (\d+\.\d) s\)/gm)].map((m) => m[1]);
    expect(browser).toEqual(["1.0", "1.0"]);
    expect(out).toMatch(/Session · 2 tasks · [\d.]+ s \(jev [\d.]+ s · browser 2\.0 s\)/);
  });

  it("/headed on closes Chrome and the next launch is headed", async () => {
    const s = fastSession(["open wikipedia.org and click English", "/headed on", "open wikipedia.org and click English", "/quit"], ["--headless", "--profile", "none"]);
    expect(await s.code).toBe(0);
    expect(s.launchOpts).toEqual([{ headed: false }, { headed: true }]);
    expect(s.chrome.closes).toBe(2);
    expect(s.out).toContain("Closed the browser. The next task starts a new one.\nheaded on\n");
  });

  it("Ctrl-C during the Chrome launch waits for the launch, then closes Chrome and exits 130", async () => {
    // The launch runs during the plan request, so a Ctrl-C lands inside it. A close that skips the Chrome
    // still in launch would leave its temporary profile behind.
    const stdin = ttyStdin();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (c) => { out += String(c); });
    const exits: number[] = [];
    const chrome = fakeChrome();
    const page = fakePage({ pages: { home: HOME }, start: "home" });
    let launches = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const oracle = fakeOracle((name) => (name === "step" ? { operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } } : { goal: "act" }));
    const code = runChat(["--headless", "--profile", "none"], { stdin: stdin as unknown as NodeJS.ReadStream, stdout, env: withKey() }, {
      validate: async (): Promise<KeyCheck> => ({ ok: true, model: "jev-1", usage: { input_tokens: 1, output_tokens: 1 } }), exit: (c) => { exits.push(c); }, profiles: [],
      launch: async () => { launches += 1; await gate; return chrome; }, openPage: async () => page, oracle: () => oracle,
    });
    const get = () => out;
    await waitFor(get, "jev> ");
    stdin.write("open wikipedia.org and click English\r");
    await until(() => launches === 1);
    stdin.write("\u0003");
    await waitFor(get, "interrupted");
    await delay(30);
    expect(chrome.closes).toBe(0);
    release();
    await waitFor(get, "Session · 0 tasks");
    expect(chrome.closes).toBe(1);
    expect(exits).toEqual([130]);
    expect(await code).toBe(0);
    expect(chrome.closes).toBe(1);
  });
});
