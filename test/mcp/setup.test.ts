import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastRunnerDeps } from "../../src/fast/loop.js";
import type { Page } from "../../src/fast/model.js";
import { BrowserSession } from "../../src/fast/session.js";
import { emptyResult } from "../../src/io.js";
import { MCP_HINTS } from "../../src/mcp/limits.js";
import type { BrowseInput, RunHooks } from "../../src/mcp/runs.js";
import { AUTONOMY_WORDS, NoKeyError, baseConfig, checkAutonomy, checkInput, configFor, createJevLink, fastStarter, findPackageRoot, loadPackageEnv } from "../../src/mcp/setup.js";
import type { RunResult } from "../../src/types.js";
import { fakeHuman, fakeLogger, fakeOracle, fakeText, fakeTransport } from "../fakes.js";
import { fakeChrome, fakePage, obs } from "../fast/fakes.js";

// fastStarter builds a FastRunner. This stand-in records its deps and returns a scripted result.
const runner = vi.hoisted(() => ({ deps: [] as unknown[], result: null as unknown, page: null as unknown, unsent: [] as unknown[], untyped: [] as string[] }));
vi.mock("../../src/fast/loop.js", () => ({
  FastRunner: class {
    page: unknown;
    constructor(deps: unknown) { runner.deps.push(deps); this.page = runner.page; }
    async run(): Promise<unknown> { return runner.result; }
    unsentText(): unknown[] { return runner.unsent; }
    untypedText(): string[] { return runner.untyped; }
  },
}));

const PROFILES = [{ directory: "Profile 14", name: "Parallelloop" }, { directory: "Profile 2", name: "BP" }];

const tmpDirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "jev-mcp-setup-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const input = (over: Partial<BrowseInput> = {}): BrowseInput => ({ task: "open https://mail.example and reply", headed: true, confirm: "auto", dry_run: false, ...over });

describe("loadPackageEnv", () => {
  it("finds the package root up to 4 levels up and sets only keys that are not defined", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "jev-browser-use" }));
    fs.writeFileSync(path.join(root, ".env"), "TYPESAFE_API_KEY=from-file\nJEV_X=1\n# comment\nJEV_EMPTY=\n");
    const dist = path.join(root, "plugin", "dist");
    fs.mkdirSync(dist, { recursive: true });
    const env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: "", JEV_EMPTY: "kept" };
    expect(loadPackageEnv(dist, env)).toBe(path.join(root, ".env"));
    expect(env).toEqual({ TYPESAFE_API_KEY: "", JEV_EMPTY: "kept", JEV_X: "1" });
  });

  it("gives null for another package, a missing .env, or a root more than 4 levels up", () => {
    const other = tmp();
    fs.writeFileSync(path.join(other, "package.json"), JSON.stringify({ name: "other" }));
    fs.writeFileSync(path.join(other, ".env"), "JEV_X=1\n");
    const env: NodeJS.ProcessEnv = {};
    expect(loadPackageEnv(other, env)).toBeNull();
    const root = tmp();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "jev-browser-use" }));
    expect(loadPackageEnv(root, env)).toBeNull();
    fs.writeFileSync(path.join(root, ".env"), "JEV_X=1\n");
    const deep = path.join(root, "a", "b", "c", "d", "e");
    fs.mkdirSync(deep, { recursive: true });
    expect(loadPackageEnv(deep, env)).toBeNull();
    expect(env).toEqual({});
    expect(loadPackageEnv(path.join(root, "a", "b", "c", "d"), env)).toBe(path.join(root, ".env"));
  });
});

describe("findPackageRoot", () => {
  it("gives the package root, or null for a copy outside the repository", () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "jev-browser-use" }));
    const dist = path.join(root, "plugin", "dist");
    fs.mkdirSync(dist, { recursive: true });
    expect(findPackageRoot(dist)).toBe(root);
    const cache = path.join(tmp(), "plugins", "cache", "jev-browser-use", "jev-browser", "0.1.0", "dist");
    fs.mkdirSync(cache, { recursive: true });
    expect(findPackageRoot(cache)).toBeNull();
  });
});

describe("baseConfig", () => {
  it("a bad JEV_BROWSER_ENGINE gives a warning and cdp", () => {
    const log = fakeLogger();
    const cfg = baseConfig({ JEV_BROWSER_ENGINE: "firefox" }, log);
    expect(cfg.engine).toBe("cdp");
    expect(log.lines.some((l) => l.startsWith("WARN") && l.includes("JEV_BROWSER_ENGINE"))).toBe(true);
  });

  it.each(["abc", "0", "101", ""])("JEV_BROWSER_MAX_STEPS=%j gives 25 and a warning", (v) => {
    const log = fakeLogger();
    expect(baseConfig({ JEV_BROWSER_MAX_STEPS: v }, log).maxSteps).toBe(25);
    expect(log.lines.some((l) => l.startsWith("WARN") && l.includes("JEV_BROWSER_MAX_STEPS"))).toBe(true);
  });

  it("vercel gives cdp with a warning; chromium stays", () => {
    const log = fakeLogger();
    expect(baseConfig({ JEV_BROWSER_ENGINE: "vercel" }, log).engine).toBe("cdp");
    expect(log.lines.some((l) => l.startsWith("WARN") && l.includes("vercel"))).toBe(true);
    expect(baseConfig({ JEV_BROWSER_ENGINE: "chromium" }, fakeLogger()).engine).toBe("chromium");
  });

  it("keeps AGENT_BROWSER_PROFILE, the model, and valid max steps; headed, keepOpen, and a jev-mcp session", () => {
    const log = fakeLogger();
    const cfg = baseConfig({ AGENT_BROWSER_PROFILE: "BP", TYPESAFE_DEFAULT_MODEL: "jev-x", JEV_BROWSER_MAX_STEPS: "40", AGENT_BROWSER_SESSION: "mine" }, log);
    expect(cfg).toMatchObject({ profile: "BP", model: "jev-x", maxSteps: 40, headed: true, keepOpen: true, engine: "cdp" });
    expect(cfg.session).toMatch(/^jev-mcp-[0-9a-f]{8}$/);
    expect(log.lines.some((l) => l.includes("AGENT_BROWSER_SESSION is ignored"))).toBe(true);
    expect(log.lines.some((l) => l.includes("AGENT_BROWSER_PROFILE: BP"))).toBe(true);
  });
});

describe("configFor", () => {
  const base = baseConfig({ AGENT_BROWSER_PROFILE: "Parallelloop" }, fakeLogger());

  it("maps the browse input; var keys are lowercased; the base profile is the default", () => {
    const cfg = configFor(input({ url: "https://mail.example/t/1", goal: "act", vars: { Name: "Ann", token: "x" }, max_steps: 7, confirm: "always", dry_run: true, headed: false, engine: "chromium" }), base);
    expect(cfg).toMatchObject({ task: "open https://mail.example and reply", url: "https://mail.example/t/1", goal: "act", vars: { name: "Ann", token: "x" }, maxSteps: 7, confirm: "always", dryRun: true, headed: false, engine: "chromium", profile: "Parallelloop", keepOpen: true, session: base.session });
    expect(configFor(input({ profile: "none" }), base).profile).toBe("none");
  });

  it("leaves url, goal, and fallbackUrl absent when the input has none", () => {
    const cfg = configFor(input(), { ...base, url: "https://old", goal: "check", fallbackUrl: "https://old" });
    expect("url" in cfg || "goal" in cfg || "fallbackUrl" in cfg).toBe(false);
    expect(cfg.maxSteps).toBe(base.maxSteps);
    expect(cfg.engine).toBe("cdp");
  });
});

describe("checkInput", () => {
  it.each(["javascript:alert(1)", "chrome://settings", "file:///etc/passwd", "data:text/html,x", "about:blank", "mail.example"])("rejects %s without the opt-in", (url) => {
    expect(checkInput(input({ url }), {}, PROFILES)).toMatch(/http or https/);
  });

  it("accepts http and https, and file: only with JEV_MCP_ALLOW_FILE=1", () => {
    expect(checkInput(input({ url: "http://127.0.0.1:8765/reply.html" }), {}, PROFILES)).toBeNull();
    expect(checkInput(input({ url: "https://mail.example" }), {}, PROFILES)).toBeNull();
    expect(checkInput(input({ url: "file:///tmp/reply.html" }), { JEV_MCP_ALLOW_FILE: "1" }, PROFILES)).toBeNull();
    expect(checkInput(input({ url: "file:///tmp/reply.html" }), { JEV_MCP_ALLOW_FILE: "0" }, PROFILES)).toMatch(/JEV_MCP_ALLOW_FILE=1/);
    expect(checkInput(input(), {}, PROFILES)).toBeNull();
  });

  it("an unknown profile gives an error that lists the names; none, a name, or a directory pass", () => {
    expect(checkInput(input({ profile: "Work" }), {}, PROFILES)).toBe('unknown profile "Work". Use one of: Parallelloop (Profile 14), BP (Profile 2), none');
    for (const profile of ["none", "NONE", "bp", "Profile 14"]) expect(checkInput(input({ profile }), {}, PROFILES)).toBeNull();
  });
});

describe("checkAutonomy", () => {
  const auto = (user_said?: string): BrowseInput => input({ confirm: "autonomous", ...(user_said !== undefined ? { user_said } : {}) });

  it("accepts the user's own words; the apostrophe can be straight, curly, or missing", () => {
    for (const said of ["Send it autonomously.", "do it autonomous", "Reply to Ann, don't ask me", "don\u2019t ask me", "dont ask me", "Do NOT ask me again, just send", "post it without asking", "you can act autonomously today"]) {
      expect(checkAutonomy(auto(said), {}), said).toBeNull();
    }
    // No page-text store: "autonomous" alone passes also after a page showed "AI AUTONOMOUS".
    expect(checkAutonomy(auto("autonomous"), {})).toBeNull();
  });

  it("confirm autonomous without user_said, or without the words, is a wrong call", () => {
    expect(checkAutonomy(auto(), {})).toMatch(/^confirm "autonomous" needs user_said/);
    expect(checkAutonomy(auto("   "), {})).toMatch(/^confirm "autonomous" needs user_said/);
    for (const said of ["yes", "go ahead", "ok, send it", "don't ask", "the user approved", "autonomy"]) {
      expect(checkAutonomy(auto(said), {}), said).toMatch(/^user_said must hold the user's own words/);
    }
    expect(AUTONOMY_WORDS.test("semiautonomous")).toBe(false);
  });

  it("user_said goes only with confirm autonomous; the other values need nothing", () => {
    expect(checkAutonomy(input({ user_said: "do it autonomously" }), {})).toBe('user_said goes only with confirm "autonomous". Leave out user_said');
    expect(checkAutonomy(input({ confirm: "always", user_said: "don't ask me" }), {})).toMatch(/goes only with/);
    for (const confirm of ["auto", "always", "never"] as const) expect(checkAutonomy(input({ confirm }), {})).toBeNull();
  });

  it("JEV_MCP_AUTONOMOUS=0 turns the mode off; other values leave it on", () => {
    expect(checkAutonomy(auto("do it autonomously"), { JEV_MCP_AUTONOMOUS: "0" })).toMatch(/JEV_MCP_AUTONOMOUS=0/);
    expect(checkAutonomy(auto("do it autonomously"), { JEV_MCP_AUTONOMOUS: "1" })).toBeNull();
    expect(checkAutonomy(input(), { JEV_MCP_AUTONOMOUS: "0" })).toBeNull();
  });

  it("configFor passes confirm autonomous through", () => {
    expect(configFor(auto("don't ask me"), baseConfig({}, fakeLogger())).confirm).toBe("autonomous");
  });
});

describe("createJevLink", () => {
  it("client() throws NoKeyError until a key exists; nothing connects before a warm", async () => {
    const dir = tmp();
    const env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: "", JEV_BROWSER_CONFIG: path.join(dir, "none.json") };
    const t = fakeTransport();
    const jev = createJevLink(env, fakeLogger(), t);
    expect(() => jev.client()).toThrow(NoKeyError);
    expect(jev.key()).toBeNull();
    await jev.warm();
    expect(t.warms).toEqual([]);
    env["TYPESAFE_API_KEY"] = "tsk-test-key-0123456789abcdef";
    env["TYPESAFE_BASE_URL"] = "http://127.0.0.1:9";
    const c = jev.client();
    expect(jev.client()).toBe(c);
    expect(jev.key()).toBe("tsk-test-key-0123456789abcdef");
    await jev.warm();
    expect(t.warms).toEqual(["http://127.0.0.1:9"]);
    await jev.close();
    expect(t.closes).toBe(1);
  });

  it("the no-key error names the package .env only when the server can read it", () => {
    const dir = tmp();
    const env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: "", JEV_BROWSER_CONFIG: path.join(dir, "none.json") };
    expect(() => createJevLink(env, fakeLogger(), fakeTransport()).client()).toThrow(/in the server environment or in the package \.env, or save a key with jev-chat/);
    const copy = createJevLink(env, fakeLogger(), fakeTransport(), { packageEnv: false });
    expect(() => copy.client()).toThrow(NoKeyError);
    expect(() => copy.client()).toThrow(/^no TypeSafe API key\. Set TYPESAFE_API_KEY in the environment that starts this server/);
    expect(() => copy.client()).not.toThrow(/package \.env/);
  });

  it("reads a saved key from the config file", () => {
    const dir = tmp();
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ typesafe_api_key: "tsk-saved-key-0123456789" }));
    const jev = createJevLink({ JEV_BROWSER_CONFIG: file }, fakeLogger(), fakeTransport());
    jev.client();
    expect(jev.key()).toBe("tsk-saved-key-0123456789");
  });
});

describe("fastStarter", () => {
  beforeEach(() => { runner.deps.length = 0; runner.page = null; runner.unsent = []; runner.untyped = []; runner.result = emptyResult("t", "act"); });

  function setup(opts: { page?: boolean } = {}) {
    const log = fakeLogger();
    const chrome = fakeChrome();
    const page = fakePage({ pages: { a: obs("https://mail.example/t/1", []) }, start: "a" });
    const session = new BrowserSession({ env: {}, log, launch: async () => chrome, open: async () => page });
    const prepare = vi.spyOn(session, "prepare");
    const keep = vi.spyOn(session, "keep");
    const close = vi.spyOn(session, "close");
    const jev = { client: () => { throw new Error("no client in tests"); }, warm: vi.fn(async () => undefined), key: () => null, close: async () => undefined };
    const base = baseConfig({}, log);
    const oracle = fakeOracle([]);
    const start = fastStarter({ session, jev: jev as never, base, env: {}, profiles: () => PROFILES, oracle: () => oracle });
    const hooks: RunHooks = { text: fakeText(), human: fakeHuman({ interactive: true }), signal: new AbortController().signal, log: fakeLogger(), hints: MCP_HINTS };
    const open = async (): Promise<Page> => {
      const c = await session.chromeFor({ ...base, task: "x" })(undefined);
      return session.openPage(c);
    };
    return { session, prepare, keep, close, jev, start, hooks, oracle, open, page, opts };
  }
  const deps = (): FastRunnerDeps => runner.deps[runner.deps.length - 1] as FastRunnerDeps;

  it("reports the labels of assistant texts that no fill typed through hooks.untyped", async () => {
    const t = setup();
    runner.untyped = ["Subject"];
    const untyped = vi.fn();
    await t.start(input({ profile: "none" }), { ...t.hooks, untyped });
    expect(untyped).toHaveBeenCalledWith(["Subject"]);
  });

  it("a task with a profile word closes Chrome first: prepare(null)", async () => {
    const t = setup();
    await t.start(input({ task: "open https://mail.example in my chrome profile and reply" }), t.hooks);
    expect(t.prepare).toHaveBeenCalledWith(null);
  });

  it("a flag profile gives prepare(key); none gives a temporary key; no profile uses the workspace default", async () => {
    const t = setup();
    await t.start(input({ profile: "BP" }), t.hooks);
    expect(t.prepare).toHaveBeenLastCalledWith({ engine: "cdp", headed: true, profileDirectory: "Profile 2" });
    await t.start(input({ profile: "none", headed: false, engine: "chromium" }), t.hooks);
    expect(t.prepare).toHaveBeenLastCalledWith({ engine: "chromium", headed: false, profileDirectory: null });
    await t.start(input(), t.hooks);
    expect(t.prepare).toHaveBeenLastCalledWith({ engine: "cdp", headed: true, profileDirectory: "Profile 14" });
  });

  it("an unknown profile gives prepare(null); the runner reports the error", async () => {
    const t = setup();
    await t.start(input({ profile: "Work" }), t.hooks);
    expect(t.prepare).toHaveBeenLastCalledWith(null);
    expect(deps().cfg.profile).toBe("Work");
  });

  it("passes the hooks, the MCP hints, fromAssistant, the session page, and the current URL as fallbackUrl", async () => {
    const t = setup();
    const page = await t.open();
    await t.start(input({ profile: "none", vars: { name: "Ann" } }), t.hooks);
    const d = deps();
    expect(d).toMatchObject({ text: t.hooks.text, human: t.hooks.human, signal: t.hooks.signal, log: t.hooks.log, hints: MCP_HINTS, fromAssistant: true, page, profiles: PROFILES });
    expect("attended" in d).toBe(false);
    await t.start(input({ profile: "none" }), { ...t.hooks, attended: false });
    expect(deps().attended).toBe(false);
    expect(d.cfg).toMatchObject({ fallbackUrl: "https://mail.example/t/1", vars: { name: "Ann" }, keepOpen: true, headed: true });
    expect(d.oracle).toBe(t.oracle);
    await d.warm?.();
    expect(t.jev.warm).toHaveBeenCalledTimes(1);
    await expect(d.openPage(t.session.chrome as never)).resolves.toBe(t.page);
  });

  it("keeps the runner page with the epoch from before the run", async () => {
    const t = setup();
    await t.open();
    const epoch = t.session.epoch;
    runner.page = t.page;
    await t.start(input({ profile: "none", headed: true }), t.hooks);
    expect(t.keep).toHaveBeenCalledWith(t.page, epoch, []);
    expect(t.session.page).toBe(t.page);
  });

  it("keeps the unsent text of a run with its page and gives it to the next run on that page", async () => {
    const t = setup();
    await t.open();
    const entry = { doc: 1.5, node: 4, label: "Reply", text: "Tuesday works.", request: null };
    runner.page = t.page;
    runner.unsent = [entry];
    await t.start(input({ profile: "none" }), t.hooks);
    expect(t.keep).toHaveBeenLastCalledWith(t.page, expect.any(Number), [entry]);
    expect(t.session.unsent).toEqual([entry]);
    await t.start(input({ profile: "none", task: "click the Comment button" }), t.hooks);
    expect(deps()).toMatchObject({ page: t.page, unsent: [entry] });
    // A close ends the page, and its unsent text goes with it.
    await t.session.close();
    expect(t.session.unsent).toEqual([]);
    runner.page = null;
    await t.start(input({ profile: "none" }), t.hooks);
    expect("unsent" in deps()).toBe(false);
  });

  it("closes the session on a browser error, and not on other results", async () => {
    const t = setup();
    runner.result = { ...emptyResult("t", "act"), outcome: "failed", error: { kind: "jev", message: "x" } } satisfies RunResult;
    await t.start(input(), t.hooks);
    expect(t.close).not.toHaveBeenCalled();
    runner.result = { ...emptyResult("t", "act"), outcome: "failed", error: { kind: "browser", message: "chrome closed" } } satisfies RunResult;
    await t.start(input(), t.hooks);
    expect(t.close).toHaveBeenCalledTimes(1);
  });
});
