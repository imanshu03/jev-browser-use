// The keep-alive transport against a local http server. No network beyond 127.0.0.1.
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SOCKETS, WARM_TIMEOUT_MS, createTransport, type Transport } from "../src/transport.js";
import { fakeLogger } from "./fakes.js";

interface Seen { method: string; url: string; auth: string | undefined; body: string }

/** A server that counts sockets and records requests. keepAliveTimeout 0 sends no Keep-Alive header, so the client decides the idle timeout. */
async function serve() {
  const seen: Seen[] = [];
  let sockets = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers["authorization"], body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, n: seen.length }));
    });
  });
  server.keepAliveTimeout = 0;
  server.on("connection", () => { sockets += 1; });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`, seen, sockets: () => sockets,
    close: () => { server.closeAllConnections(); return new Promise<void>((r) => server.close(() => r())); },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hasOpenssl = (): boolean => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } };
const drain = async (r: Response) => { await r.text(); };

let transports: Transport[] = [];
let servers: Awaited<ReturnType<typeof serve>>[] = [];
afterEach(async () => {
  for (const t of transports) await t.close();
  for (const s of servers) await s.close();
  transports = []; servers = [];
});

describe("createTransport", () => {
  it("(a) requests use at most two sockets; two at once use both; method, headers, and body pass through", async () => {
    const s = await serve(); servers.push(s);
    const log = fakeLogger();
    const t = createTransport({ log }); transports.push(t);
    const r1 = await t.fetch(`${s.base}/v1/systemone`, { method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
    expect(await r1.json()).toEqual({ ok: true, n: 1 });
    // Issued right after the first response: the pool can use the second socket for it.
    await drain(await t.fetch(`${s.base}/v1/systemone`, { method: "POST", body: "{}" }));
    expect(s.sockets()).toBeLessThanOrEqual(SOCKETS);
    // Two at once: the API answers one connection's requests one at a time, so the second one gets its own socket.
    const [r3, r4] = await Promise.all([t.fetch(`${s.base}/x`, { method: "POST", body: "{}" }), t.fetch(`${s.base}/y`, { method: "POST", body: "{}" })]);
    await Promise.all([drain(r3), drain(r4)]);
    expect(s.sockets()).toBe(SOCKETS);
    const more = await Promise.all([1, 2, 3, 4].map((i) => t.fetch(`${s.base}/z${i}`, { method: "POST", body: "{}" })));
    await Promise.all(more.map(drain));
    expect(s.sockets()).toBe(SOCKETS);
    expect(t.stats.connections).toBe(SOCKETS);
    expect(s.seen[0]).toEqual({ method: "POST", url: "/v1/systemone", auth: "Bearer k", body: '{"a":1}' });
    expect(s.seen.map((x) => x.url).slice(0, 4)).toEqual(["/v1/systemone", "/v1/systemone", "/x", "/y"]);
    expect(log.lines).toEqual(["DEBUG jev transport: connection 1 opened", "DEBUG jev transport: connection 2 opened"]);
  });

  it("(b) an idle shorter than keepAliveMs reuses the socket; an idle longer than keepAliveMs opens a new one", async () => {
    const s = await serve(); servers.push(s);
    const t = createTransport({ keepAliveMs: 1000 }); transports.push(t);
    await drain(await t.fetch(`${s.base}/1`));
    await sleep(200);
    await drain(await t.fetch(`${s.base}/2`));
    expect(s.sockets()).toBe(1);
    expect(t.stats.connections).toBe(1);
    const short = createTransport({ keepAliveMs: 100 }); transports.push(short);
    await drain(await short.fetch(`${s.base}/3`));
    await sleep(400);
    await drain(await short.fetch(`${s.base}/4`));
    expect(short.stats.connections).toBe(2);
    expect(s.sockets()).toBe(3);
  });

  it("(c) warm sends GET / without a key on each socket, and the next requests reuse them; a refused connection resolves", async () => {
    const s = await serve(); servers.push(s);
    const t = createTransport(); transports.push(t);
    await t.warm(`${s.base}/`);
    expect(s.seen).toEqual(Array.from({ length: SOCKETS }, () => ({ method: "GET", url: "/", auth: undefined, body: "" })));
    await Promise.all([1, 2].map(async () => drain(await t.fetch(`${s.base}/v1/systemone`, { method: "POST", body: "{}" }))));
    expect(s.sockets()).toBe(SOCKETS);
    expect(t.stats.connections).toBe(SOCKETS);

    const dead = await serve();
    await dead.close();
    const log = fakeLogger();
    const t2 = createTransport({ log }); transports.push(t2);
    await expect(t2.warm(dead.base)).resolves.toBeUndefined();
    expect(t2.stats.connections).toBe(0);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatch(/^DEBUG jev transport: warm http:\/\/127\.0\.0\.1:\d+\/ failed: /);
  });

  it("(g) warm resolves for a base URL that new URL cannot parse; it opens nothing and logs one debug line", async () => {
    // The SDK passes TYPESAFE_BASE_URL through as it is. A value without a scheme reaches warm unchanged.
    for (const bad of ["api.typesafe.ai", "127.0.0.1:8080", "not a url"]) {
      const log = fakeLogger();
      const t = createTransport({ log }); transports.push(t);
      await expect(t.warm(bad)).resolves.toBeUndefined();
      expect(t.stats.connections).toBe(0);
      expect(log.lines).toEqual([`DEBUG jev transport: warm ${bad} failed: Invalid URL`]);
    }
  });

  it("(h) a request sent during a warm waits behind it only until the warm timeout; the cap is short", async () => {
    // GET / stalls for 2 s. Every other path answers at once.
    let gotWarm!: () => void;
    const warmArrived = new Promise<void>((r) => { gotWarm = r; });
    const stalled: http.ServerResponse[] = [];
    const server = http.createServer((req, res) => {
      if (req.url === "/") { stalled.push(res); gotWarm(); return; }
      res.end("{}");
    });
    server.keepAliveTimeout = 0;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const log = fakeLogger();
    const t = createTransport({ log, warmTimeoutMs: 200 }); transports.push(t);
    try {
      const warm = t.warm(base);
      await warmArrived;
      const t0 = Date.now();
      await drain(await t.fetch(`${base}/v1/systemone`, { method: "POST", body: "{}" }));
      // Answered after the warm abort at 200 ms, not after the 2 s stall.
      expect(Date.now() - t0).toBeLessThan(1000);
      await warm;
      expect(log.lines.some((l) => /^DEBUG jev transport: warm .* failed: /.test(l))).toBe(true);
      // The worst case head-of-line wait equals the cap. Keep it below the browser work before the first step.
      expect(WARM_TIMEOUT_MS).toBeLessThanOrEqual(1500);
    } finally {
      for (const res of stalled) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("(i) close() does not wait for a connect that only a warm needs", async () => {
    // 10.255.255.1 drops SYNs on most networks, so the connect hangs until undici's 10 s connect timeout.
    // On a network that refuses at once the test passes too; it never fails for a working transport.
    const log = fakeLogger();
    const t = createTransport({ log });
    const warm = t.warm("http://10.255.255.1:9/");
    await sleep(100);
    const t0 = Date.now();
    await Promise.all([t.close(), warm]);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(t.stats.connections).toBe(0);
    expect(log.lines.some((l) => /^DEBUG jev transport: warm http:\/\/10\.255\.255\.1:9\/ failed: /.test(l))).toBe(true);
  });

  it("(k) a warm when every socket is open sends nothing: it would only hold a socket that a Jev request needs", async () => {
    const s = await serve(); servers.push(s);
    const t = createTransport(); transports.push(t);
    await t.warm(`${s.base}/`);
    expect(s.seen).toHaveLength(SOCKETS);
    await t.warm(`${s.base}/`);
    expect(s.seen).toHaveLength(SOCKETS);
    expect(t.stats.connections).toBe(SOCKETS);
    // An idle ping sends anyway: it keeps the open sockets from their idle timeout.
    await t.warm(`${s.base}/`, { keep: true });
    expect(s.seen).toHaveLength(2 * SOCKETS);
    expect(t.stats.connections).toBe(SOCKETS);
  });

  it("(m) sockets that closed at their idle timeout count as closed: the next warm opens them again", async () => {
    const s = await serve(); servers.push(s);
    const t = createTransport({ keepAliveMs: 100 }); transports.push(t);
    await t.warm(`${s.base}/`);
    expect(t.stats.connections).toBe(SOCKETS);
    await sleep(400);
    await t.warm(`${s.base}/`);
    expect(s.seen).toHaveLength(2 * SOCKETS);
    expect(t.stats.connections).toBe(2 * SOCKETS);
  });

  // The test makes its own certificate with openssl, and it skips (visibly) where openssl is missing.
  it.skipIf(!hasOpenssl())("(l) close() does not wait for a warm-only connect after a fetch ran on the other socket", async () => {
    // A TLS server behind a front that passes the first connection through and stalls every later one in the TLS
    // handshake: the second socket of the warm never connects. NODE_TLS_REJECT_UNAUTHORIZED accepts the self-signed
    // certificate; it is set only in this worker, and only for this test.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-tls-"));
    await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-days", "1", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")]);
    const https = await import("node:https");
    const net = await import("node:net");
    const tls = https.createServer({ key: fs.readFileSync(path.join(dir, "key.pem")), cert: fs.readFileSync(path.join(dir, "cert.pem")) }, (req, res) => {
      req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end("{}"); });
    });
    await new Promise<void>((r) => tls.listen(0, "127.0.0.1", () => r()));
    let n = 0;
    const held: import("node:net").Socket[] = [];
    const front = net.createServer((c) => {
      n += 1;
      c.on("error", () => undefined);
      if (n === 1) { const up = net.connect((tls.address() as AddressInfo).port, "127.0.0.1"); up.on("error", () => undefined); c.pipe(up); up.pipe(c); } else held.push(c);
    });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", () => r()));
    const base = `https://127.0.0.1:${(front.address() as AddressInfo).port}`;
    const was = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
    const t = createTransport({ warmTimeoutMs: 200 });
    try {
      await (await t.fetch(`${base}/v1/systemone`, { method: "POST", body: "{}" })).text(); // the plan request: socket 1
      void t.warm(`${base}/`); // a GET on socket 1, and a connect for socket 2 that stalls
      await sleep(50);
      await (await t.fetch(`${base}/v1/systemone`, { method: "POST", body: "{}" })).text(); // the step request on socket 1
      const t0 = Date.now();
      await t.close();
      expect(Date.now() - t0).toBeLessThan(1500);
    } finally {
      if (was === undefined) delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"]; else process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = was;
      for (const c of held) c.destroy();
      front.close(); tls.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("(d) close() is idempotent and ends the socket; a fetch after close rejects", async () => {
    const s = await serve(); servers.push(s);
    const t = createTransport();
    await drain(await t.fetch(`${s.base}/1`));
    const p1 = t.close();
    const p2 = t.close();
    expect(p2).toBe(p1);
    await p1;
    await expect(t.close()).resolves.toBeUndefined();
    await expect(t.fetch(`${s.base}/2`)).rejects.toThrow();
  });

  it("(f) close() aborts a warm that is still in flight, so both settle at once", async () => {
    // A server that accepts the request and never answers.
    let held = 0;
    let gotRequest!: () => void;
    const arrived = new Promise<void>((r) => { gotRequest = r; });
    const server = http.createServer(() => { held += 1; gotRequest(); });
    server.keepAliveTimeout = 0;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const log = fakeLogger();
    const t = createTransport({ log });
    try {
      const warm = t.warm(base);
      await arrived;
      expect(held).toBe(1);
      const t0 = Date.now();
      await Promise.all([t.close(), warm]);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(log.lines.some((l) => /^DEBUG jev transport: warm .* failed: /.test(l))).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("(e) an idle keep-alive socket does not keep a process alive", async () => {
    // The server lives in this process, so the child's only handle is its client socket.
    const s = await serve(); servers.push(s);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-transport-"));
    const script = path.join(dir, "child.mts");
    const transportUrl = pathToFileURL(path.resolve("src/transport.ts")).href;
    fs.writeFileSync(script, [
      `import { createTransport } from ${JSON.stringify(transportUrl)};`,
      "const t = createTransport();",
      `const r = await t.fetch(${JSON.stringify(`${s.base}/child`)});`,
      "await r.text();",
      "process.on('exit', () => { process.stdout.write(String(Date.now() - t0)); });",
      "const t0 = Date.now();",
    ].join("\n"));
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", script], { cwd: path.resolve("."), timeout: 20_000 });
      const idleMs = Number(stdout.trim());
      expect(Number.isFinite(idleMs)).toBe(true);
      expect(idleMs).toBeLessThan(2000);
      expect(s.seen.map((x) => x.url)).toEqual(["/child"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("(j) a process that calls close() during a hanging warm connect exits at once", async () => {
    // The child fires one warm at a blackholed address, then closes the transport without an await, as the CLI
    // does. A pending connect keeps a process alive, so close() must end it. See (i) for the address.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-transport-"));
    const script = path.join(dir, "child.mts");
    const transportUrl = pathToFileURL(path.resolve("src/transport.ts")).href;
    fs.writeFileSync(script, [
      `import { createTransport } from ${JSON.stringify(transportUrl)};`,
      "const t0 = Date.now();",
      "process.on('exit', () => { process.stdout.write(String(Date.now() - t0)); });",
      "const t = createTransport();",
      "void t.warm('http://10.255.255.1:9/');",
      "setTimeout(() => { t.close().catch(() => undefined); }, 100);",
    ].join("\n"));
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", script], { cwd: path.resolve("."), timeout: 20_000 });
      const aliveMs = Number(stdout.trim());
      expect(Number.isFinite(aliveMs)).toBe(true);
      expect(aliveMs).toBeLessThan(2000);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
