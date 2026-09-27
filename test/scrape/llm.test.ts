import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CLAUDE_MODEL, claudeArgs, claudeBackend, claudeBin, llmFromEnv, llmTimeoutMs, textBackend } from "../../src/scrape/llm.js";
import { fakeLogger } from "../fakes.js";

let dir: string;
let bin: string;
const log = fakeLogger();

/** A fake claude binary: it logs what it got to FAKE_CLAUDE_LOG and answers by FAKE_CLAUDE_MODE. */
const SCRIPT = `
const fs = require("node:fs");
let stdin = "";
process.stdin.on("data", (d) => { stdin += d; });
process.stdin.on("end", () => {
  const rec = { pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), stdin,
    env: { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY ?? null, JEV_TEXT_API_KEY: process.env.JEV_TEXT_API_KEY ?? null,
      AGENT_BROWSER_SESSION: process.env.AGENT_BROWSER_SESSION ?? null, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null } };
  fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(rec));
  const mode = process.env.FAKE_CLAUDE_MODE;
  if (mode === "sleep") { setTimeout(() => {}, 60000); return; }
  if (mode === "error") { process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "rate limited" })); return; }
  if (mode === "nojson") { process.stdout.write("Hello, I am not JSON"); return; }
  if (mode === "empty") { process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "" })); return; }
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: '{"set":"t1","fields":{"a":{"from":"url"}}}' }));
});
`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-scrape-llmtest-"));
  bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!${process.execPath}\n${SCRIPT}`, { mode: 0o755 });
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function envFor(mode: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv & { FAKE_CLAUDE_LOG: string } {
  return {
    PATH: process.env["PATH"], HOME: dir, JEV_SCRAPE_CLAUDE_BIN: bin, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: path.join(dir, `log-${mode}-${Math.random()}.json`),
    TYPESAFE_API_KEY: "tk-test-secret", JEV_TEXT_API_KEY: "text-test-secret", AGENT_BROWSER_SESSION: "s1", CLAUDE_CONFIG_DIR: "/tmp/claude-config", ...extra,
  };
}
const logOf = (env: { FAKE_CLAUDE_LOG: string }) => JSON.parse(fs.readFileSync(env.FAKE_CLAUDE_LOG, "utf8")) as { pid: number; argv: string[]; cwd: string; entries: string[]; stdin: string; env: Record<string, string | null> };

describe("claudeBackend", () => {
  it("spawns claude with the exact argv, the user text on stdin, an empty temp cwd, and no keys in the env", async () => {
    const env = envFor("ok");
    const b = claudeBackend(env, log);
    expect(b?.name).toBe(`claude:${DEFAULT_CLAUDE_MODEL}`);
    const reply = await b?.complete({ system: "SYS", user: "USER TEXT", timeoutMs: 20_000 });
    expect(reply?.text).toBe('{"set":"t1","fields":{"a":{"from":"url"}}}');
    const rec = logOf(env);
    expect(rec.argv).toEqual(["-p", "--model", "claude-sonnet-5", "--system-prompt", "SYS", "--tools", "", "--max-turns", "1", "--output-format", "json",
      "--no-session-persistence", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands"]);
    expect(rec.argv).toEqual(claudeArgs("claude-sonnet-5", "SYS"));
    expect(rec.stdin).toBe("USER TEXT");
    expect(path.basename(rec.cwd)).toMatch(/^jev-scrape-llm-/);
    expect(rec.entries).toEqual([]);
    expect(fs.existsSync(rec.cwd)).toBe(false);
    expect(rec.env).toEqual({ TYPESAFE_API_KEY: null, JEV_TEXT_API_KEY: null, AGENT_BROWSER_SESSION: null, CLAUDE_CONFIG_DIR: "/tmp/claude-config" });
  });
  it("JEV_SCRAPE_MODEL names the model", async () => {
    const env = envFor("ok", { JEV_SCRAPE_MODEL: "claude-opus-5" });
    const b = claudeBackend(env, log);
    expect(b?.name).toBe("claude:claude-opus-5");
    await b?.complete({ system: "S", user: "U", timeoutMs: 20_000 });
    expect(logOf(env).argv.slice(0, 3)).toEqual(["-p", "--model", "claude-opus-5"]);
  });
  it("an is_error answer, output that is not JSON, and an empty result reject", async () => {
    await expect(claudeBackend(envFor("error"), log)?.complete({ system: "S", user: "U", timeoutMs: 20_000 })).rejects.toThrow("claude error: rate limited");
    await expect(claudeBackend(envFor("nojson"), log)?.complete({ system: "S", user: "U", timeoutMs: 20_000 })).rejects.toThrow(/the output is not JSON: Hello/);
    await expect(claudeBackend(envFor("empty"), log)?.complete({ system: "S", user: "U", timeoutMs: 20_000 })).rejects.toThrow("claude gave no text");
  });
  it("a timeout kills the child and rejects", async () => {
    const env = envFor("sleep");
    await expect(claudeBackend(env, log)?.complete({ system: "S", user: "U", timeoutMs: 1500 })).rejects.toThrow("claude timed out after 1500 ms");
    const { pid, cwd } = logOf(env);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(fs.existsSync(cwd)).toBe(false);
  });
  it("an abort signal kills the child", async () => {
    const ctl = new AbortController();
    const p = claudeBackend(envFor("sleep"), log)?.complete({ system: "S", user: "U", timeoutMs: 20_000, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 300);
    await expect(p).rejects.toThrow("claude call aborted");
  });
  it("a binary that does not start rejects", async () => {
    const b = claudeBackend({ HOME: dir, JEV_SCRAPE_CLAUDE_BIN: path.join(dir, "missing") }, log);
    await expect(b?.complete({ system: "S", user: "U", timeoutMs: 5000 })).rejects.toThrow(/claude did not start/);
  });
});

describe("claudeBin", () => {
  it("JEV_SCRAPE_CLAUDE_BIN, then ~/.local/bin/claude, then claude on PATH, then null", () => {
    const has = (set: string[]) => (p: string) => set.includes(p);
    expect(claudeBin({ JEV_SCRAPE_CLAUDE_BIN: "/opt/c", HOME: "/h", PATH: "/a:/b" }, has(["/h/.local/bin/claude", "/b/claude"]))).toBe("/opt/c");
    expect(claudeBin({ HOME: "/h", PATH: "/a:/b" }, has(["/h/.local/bin/claude", "/b/claude"]))).toBe("/h/.local/bin/claude");
    expect(claudeBin({ HOME: "/h", PATH: "/a:/b" }, has(["/b/claude"]))).toBe("/b/claude");
    expect(claudeBin({ HOME: "/h", PATH: "/a:/b" }, has([]))).toBeNull();
  });
  it("llmTimeoutMs reads JEV_SCRAPE_LLM_TIMEOUT_MS", () => {
    expect(llmTimeoutMs({})).toBe(180_000);
    expect(llmTimeoutMs({ JEV_SCRAPE_LLM_TIMEOUT_MS: "60000" })).toBe(60_000);
    expect(llmTimeoutMs({ JEV_SCRAPE_LLM_TIMEOUT_MS: "5" })).toBe(180_000);
  });
});

describe("textBackend", () => {
  const cfg = { baseUrl: "https://llm.example/v1", model: "m-1", apiKey: "k-1" };
  it("one chat call with a JSON object answer", async () => {
    const seen: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
    const b = textBackend(cfg, log, async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{\"set\":\"g1\"}" } }] }) };
    });
    expect(b.name).toBe("text:m-1");
    const reply = await b.complete({ system: "SYS", user: "USR", timeoutMs: 5000 });
    expect(reply.text).toBe("{\"set\":\"g1\"}");
    expect(seen[0]?.url).toBe("https://llm.example/v1/chat/completions");
    expect(seen[0]?.init.headers["authorization"]).toBe("Bearer k-1");
    expect(JSON.parse(seen[0]?.init.body ?? "{}")).toEqual({
      model: "m-1", max_tokens: 4096, response_format: { type: "json_object" },
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "USR" }],
    });
  });
  it("HTTP errors, no text, and connection errors reject", async () => {
    await expect(textBackend(cfg, log, async () => ({ ok: false, status: 429, json: async () => ({}) })).complete({ system: "", user: "", timeoutMs: 5000 })).rejects.toThrow("HTTP 429");
    await expect(textBackend(cfg, log, async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) })).complete({ system: "", user: "", timeoutMs: 5000 })).rejects.toThrow("no text");
    await expect(textBackend(cfg, log, async () => { throw new Error("ECONNRESET"); }).complete({ system: "", user: "", timeoutMs: 5000 })).rejects.toThrow(/connection failed: ECONNRESET/);
  });
});

describe("llmFromEnv", () => {
  const none = { HOME: "/nonexistent-home", PATH: "" };
  const text = { JEV_TEXT_MODEL: "tm", JEV_TEXT_API_KEY: "tk" };
  it("off, claude, text, and the default order", () => {
    expect(llmFromEnv({ ...none, JEV_SCRAPE_LLM: "off", JEV_SCRAPE_CLAUDE_BIN: "/c" }, log)).toBeNull();
    expect(llmFromEnv({ ...none, JEV_SCRAPE_LLM: "claude", JEV_SCRAPE_CLAUDE_BIN: "/c" }, log)?.name).toBe("claude:claude-sonnet-5");
    expect(llmFromEnv({ ...none, JEV_SCRAPE_LLM: "claude" }, log)).toBeNull();
    expect(llmFromEnv({ ...none, ...text, JEV_SCRAPE_LLM: "text", JEV_SCRAPE_CLAUDE_BIN: "/c" }, log)?.name).toBe("text:tm");
    expect(llmFromEnv({ ...none, JEV_SCRAPE_LLM: "text" }, log)).toBeNull();
    expect(llmFromEnv({ ...none, ...text, JEV_SCRAPE_CLAUDE_BIN: "/c" }, log)?.name).toBe("claude:claude-sonnet-5");
    expect(llmFromEnv({ ...none, ...text }, log)?.name).toBe("text:tm");
    expect(llmFromEnv(none, log)).toBeNull();
  });
});
