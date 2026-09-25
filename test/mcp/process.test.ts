// Process test of src/mcp/main.ts: stdout carries only JSON-RPC, startup sends no API request, and the
// process exits 0 on stdin EOF and on SIGTERM. No real key: the key is empty or a dummy, the config and the
// home directory are temporary, and the API URL is a local server that counts requests.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

interface Server { child: ChildProcessWithoutNullStreams; lines: string[]; stderr: () => string; exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }> }

let api: http.Server;
let apiUrl = "";
let apiRequests = 0;
let home = "";

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-mcp-proc-"));
  api = http.createServer((req, res) => { apiRequests += 1; req.resume(); res.writeHead(500).end("{}"); });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => api.close(() => r()));
  fs.rmSync(home, { recursive: true, force: true });
});

/** A dummy key, not a real one. With it, a startup request would reach the counting server. */
const DUMMY_KEY = "tsk-test-key-0123456789abcdef";

function start(key = ""): Server {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "", HOME: home, XDG_CONFIG_HOME: home, JEV_BROWSER_CONFIG: path.join(home, "none.json"),
    TYPESAFE_API_KEY: key, TYPESAFE_BASE_URL: apiUrl,
  };
  const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "src/mcp/main.ts")], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  let buf = "";
  let err = "";
  child.stdout.on("data", (c: Buffer) => {
    buf += String(c);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  child.stderr.on("data", (c: Buffer) => { err += String(c); });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((resolve) => {
    child.on("exit", (code, signal) => { if (buf) lines.push(buf); resolve({ code, signal, at: Date.now() }); });
  });
  return { child, lines, stderr: () => err, exit };
}

const send = (s: Server, msg: unknown): void => { s.child.stdin.write(JSON.stringify(msg) + "\n"); };

async function response(s: Server, id: number, ms = 15_000): Promise<Record<string, unknown>> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    for (const l of s.lines) {
      const m = JSON.parse(l) as Record<string, unknown>;
      if (m["id"] === id) return m;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no response ${id}; stderr:\n${s.stderr()}`);
}

async function initialize(s: Server): Promise<void> {
  send(s, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "process-test", version: "1" } } });
  await response(s, 1);
  send(s, { jsonrpc: "2.0", method: "notifications/initialized" });
}

describe("jev-mcp process", () => {
  it("stdout holds only JSON-RPC, startup and tools/list send no API request, and stdin EOF exits 0 within 5 s", async () => {
    const s = start();
    await initialize(s);
    send(s, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await response(s, 2);
    expect(((list["result"] as { tools: { name: string }[] }).tools).map((t) => t.name)).toEqual(["browse", "wait", "continue", "cancel", "close_browser"]);
    // Without a key, browse is a wrong call and still sends nothing.
    send(s, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browse", arguments: { task: "open https://example.com", profile: "none" } } });
    const browse = (await response(s, 3))["result"] as { isError?: boolean; content: { text: string }[] };
    expect(browse.isError).toBe(true);
    expect(browse.content[0]?.text).toMatch(/^no TypeSafe API key/);
    expect(apiRequests).toBe(0);
    const t0 = Date.now();
    s.child.stdin.end();
    const e = await s.exit;
    expect(e.code, s.stderr()).toBe(0);
    expect(e.at - t0).toBeLessThan(5_000);
    for (const l of s.lines) expect((JSON.parse(l) as { jsonrpc?: string }).jsonrpc, l).toBe("2.0");
    expect(s.lines.length).toBeGreaterThanOrEqual(3);
    expect(s.stderr()).toContain("jev-browser MCP server");
    expect(apiRequests).toBe(0);
  }, 30_000);

  it("with a key, startup and tools/list send no API request either", async () => {
    // Without a key no request can leave, so the check above cannot see a startup request. This one can.
    const before = apiRequests;
    const s = start(DUMMY_KEY);
    await initialize(s);
    send(s, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    await response(s, 2);
    // Give a startup warm or ping time to reach the counting server.
    await new Promise((r) => setTimeout(r, 300));
    s.child.stdin.end();
    const e = await s.exit;
    expect(e.code, s.stderr()).toBe(0);
    expect(apiRequests - before).toBe(0);
    expect(s.stderr()).not.toContain(DUMMY_KEY);
  }, 30_000);

  it("SIGTERM exits 0 within 5 s", async () => {
    const s = start();
    await initialize(s);
    const t0 = Date.now();
    s.child.kill("SIGTERM");
    const e = await s.exit;
    expect(e.code, s.stderr()).toBe(0);
    expect(e.at - t0).toBeLessThan(5_000);
    for (const l of s.lines) expect((JSON.parse(l) as { jsonrpc?: string }).jsonrpc).toBe("2.0");
    expect(apiRequests).toBe(0);
  }, 30_000);
});
