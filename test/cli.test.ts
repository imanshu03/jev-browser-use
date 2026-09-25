import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { main, parseArgs, UsageError } from "../src/cli.js";
import { emptyResult } from "../src/io.js";
import type { RunResult } from "../src/types.js";

const env = { TYPESAFE_API_KEY: "k" } as NodeJS.ProcessEnv;

describe("parseArgs", () => {
  it("defaults", () => {
    const c = parseArgs(["do it"], env);
    expect(c).toMatchObject({ task: "do it", headed: false, maxSteps: 25, stepTimeoutMs: 30000, runTimeoutMs: 600000, pauseTimeoutMs: 300000, confirm: "auto", dryRun: false, model: "jev-latest", logLevel: "info", logJson: false, keepOpen: false, vars: {} });
    expect(c.session).toMatch(/^jev-[0-9a-f]{8}$/);
    expect(c.agentBrowserBin).toMatch(/agent-browser$/);
    expect(c.profile).toBeUndefined();
  });
  it("every flag", () => {
    const c = parseArgs(["t", "--profile", "BP", "--url", "https://x", "--goal", "check", "--headed", "--cdp", "9222", "--var", "Email=a@b", "--var", "password=pw",
      "--max-steps", "5", "--step-timeout", "5000", "--run-timeout", "9000", "--pause-timeout", "7000", "--confirm", "never", "--dry-run", "--session", "s", "--model", "m",
      "--log-level", "debug", "--log-json", "--keep-open", "--screenshot-dir", "/tmp/x"], env);
    expect(c).toMatchObject({ task: "t", profile: "BP", url: "https://x", goal: "check", headed: true, cdp: 9222, vars: { email: "a@b", password: "pw" }, maxSteps: 5, stepTimeoutMs: 5000, runTimeoutMs: 9000, pauseTimeoutMs: 7000, confirm: "never", dryRun: true, session: "s", model: "m", logLevel: "debug", logJson: true, keepOpen: true, screenshotDir: "/tmp/x" });
  });
  it("engine flags: cdp by default, JEV_BROWSER_ENGINE overrides, --engine wins, --refresh-profile and --chrome-bin", () => {
    expect(parseArgs(["t"], env).engine).toBe("cdp");
    expect(parseArgs(["t"], { ...env, JEV_BROWSER_ENGINE: "vercel" }).engine).toBe("vercel");
    expect(parseArgs(["t", "--engine", "vercel"], env).engine).toBe("vercel");
    expect(parseArgs(["t", "--engine", "cdp"], { ...env, JEV_BROWSER_ENGINE: "vercel" }).engine).toBe("cdp");
    expect(parseArgs(["t", "--refresh-profile", "--chrome-bin", "/x/chrome"], env)).toMatchObject({ refreshProfile: true, chromeBin: "/x/chrome" });
    expect(parseArgs(["t"], env).refreshProfile).toBeUndefined();
    expect(() => parseArgs(["t", "--engine", "slow"], env)).toThrow(UsageError);
    expect(() => parseArgs(["t"], { ...env, JEV_BROWSER_ENGINE: "slow" })).toThrow(UsageError);
  });
  it("accepts chromium and rejects removed engine names", () => {
    expect(parseArgs(["task", "--engine", "chromium"], env).engine).toBe("chromium");
    expect(parseArgs(["task"], { ...env, JEV_BROWSER_ENGINE: "chromium" }).engine).toBe("chromium");
    for (const engine of ["fast", "legacy"]) expect(() => parseArgs(["task", "--engine", engine], env)).toThrow(UsageError);
  });
  it("env defaults and errors", () => {
    expect(parseArgs(["t"], { ...env, TYPESAFE_DEFAULT_MODEL: "jev-2", JEV_BROWSER_MAX_STEPS: "7", JEV_BROWSER_BIN: "/bin/ab", AGENT_BROWSER_SESSION: "env-s" })).toMatchObject({ model: "jev-2", maxSteps: 7, agentBrowserBin: "/bin/ab", session: "env-s" });
    expect(() => parseArgs(["t", "--confirm", "maybe"], env)).toThrow(UsageError);
    expect(() => parseArgs(["t", "--max-steps", "101"], env)).toThrow(UsageError);
    expect(() => parseArgs(["t", "--var", "novalue"], env)).toThrow(UsageError);
    expect(() => parseArgs(["t", "--bogus"], env)).toThrow(UsageError);
    expect(() => parseArgs(["t", "--url"], env)).toThrow(UsageError);
  });
  it("a JEV_BROWSER_MAX_STEPS value that is not a number gives a UsageError", () => {
    for (const v of ["abc", "NaN"]) expect(() => parseArgs(["t"], { ...env, JEV_BROWSER_MAX_STEPS: v })).toThrow(/--max-steps must be between 1 and 100/);
    expect(() => parseArgs(["t"], { ...env, JEV_BROWSER_MAX_STEPS: "abc" })).toThrow(UsageError);
    expect(parseArgs(["t", "--max-steps", "9"], { ...env, JEV_BROWSER_MAX_STEPS: "abc" }).maxSteps).toBe(9);
  });
});

function io(envOver: NodeJS.ProcessEnv = env) {
  const out = new PassThrough(); const err = new PassThrough();
  let stdout = ""; let stderr = "";
  out.on("data", (c) => { stdout += String(c); });
  err.on("data", (c) => { stderr += String(c); });
  return { io: { stdout: out, stderr: err, stdin: { isTTY: false } as unknown as NodeJS.ReadStream, env: envOver }, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

describe("main", () => {
  it("prints exactly one JSON document and maps exit codes", async () => {
    for (const [outcome, code] of [["done", 0], ["blocked", 2], ["failed", 3]] as const) {
      const t = io();
      const r: RunResult = { ...emptyResult("task with secret hunter2", "act"), outcome };
      const exit = await main(["task with secret hunter2"], t.io, { runner: async (_cfg, mio) => { mio.stderr.write("log line\n"); return r; } });
      expect(exit).toBe(code);
      expect(JSON.parse(t.stdout)).toMatchObject({ version: 1, outcome });
      expect(t.stderr).toContain("log line");
    }
  });
  it("usage errors exit 4 with usage text", async () => {
    const noTask = io();
    expect(await main(["--headed"], noTask.io, { runner: async () => emptyResult("", "act") })).toBe(4);
    expect(noTask.stderr).toContain("missing task");
    const noKey = io({});
    expect(await main(["task"], noKey.io, { runner: async () => emptyResult("", "act") })).toBe(4);
    expect(noKey.stderr).toContain("TYPESAFE_API_KEY");
    const bad = io();
    expect(await main(["task", "--nope"], bad.io, { runner: async () => emptyResult("", "act") })).toBe(4);
    const keep = io();
    expect(await main(["task", "--keep-open"], keep.io, { runner: async () => emptyResult("", "act") })).toBe(4);
    expect(keep.stderr).toContain("--keep-open needs --cdp <port> with cdp or chromium");
    expect(keep.stderr).toContain("jev-chat");
    const keepCdp = io();
    expect(await main(["task", "--keep-open", "--cdp", "9222"], keepCdp.io, { runner: async () => emptyResult("", "act") })).toBe(3);
    const keepLegacy = io();
    expect(await main(["task", "--keep-open", "--engine", "vercel"], keepLegacy.io, { runner: async () => emptyResult("", "act") })).toBe(3);
    expect(bad.stderr).toContain("Options:");
    const help = io();
    expect(await main(["--help"], help.io)).toBe(0);
    expect(help.stderr).toContain("jev-browser");
  });
});
