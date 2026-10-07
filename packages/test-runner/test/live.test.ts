// Live: real Chrome on the demo app. Run with `npm run test:live`. The committed recording replays, so no Jev key is needed.
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { jevSessions } from "../src/engine.js";
import { ConfigDef } from "../src/schema.js";
import { Secrets } from "../src/template.js";

const live = process.env["JEV_LIVE"] === "1";
const demo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "demo");

describe.skipIf(!live)("demo suite in Chrome", () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    const { serve } = (await import(path.join(demo, "serve.mjs"))) as { serve: (p: number) => Promise<Server> };
    server = await serve(0);
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => { server.close(); });

  it("logs in, replays the recorded steps with no Jev request, and passes every case", async () => {
    const reports = fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-live-"));
    const out: string[] = [];
    const code = await main(["run", "--config", path.join(demo, "jev-test.config.yaml"), "--ci", "--report-dir", reports], {
      out: (s) => out.push(s), err: (s) => out.push(s), env: { ...process.env, DEMO_PORT: String(port), TYPESAFE_API_KEY: "" },
    });
    expect(out.join("\n")).toMatch(/3 case\(s\): 3 passed, 0 repaired, 0 failed/);
    expect(code).toBe(0);
    const results = JSON.parse(fs.readFileSync(path.join(reports, "results.json"), "utf8")) as { suites: { cases: { jevRequests: number }[] }[] };
    expect(results.suites[0]?.cases.map((c) => c.jevRequests)).toEqual([0, 0, 0]);
  }, 120_000);
});


describe.skipIf(!live)("credential fill in Chrome", () => {
  it("rejects read-only and refused input, and checks typed and cleared values", async () => {
    const fixture = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><label>Locked password<input type="password" readonly value="old"></label><label>Blocked password<input type="password" onbeforeinput="event.preventDefault()"></label><label>Password<input type="password" value="old"></label>`));
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const logs = fs.mkdtempSync(path.join(os.tmpdir(), "jev-credential-live-"));
    const session = await jevSessions({ config: ConfigDef.parse({ browser: { browser: "chrome" }, timeouts: { step_ms: 0 } }), secrets: new Secrets(), processEnv: process.env, headed: false, logDir: logs }).open("Credential", () => undefined);
    try {
      await session.goto(`http://127.0.0.1:${(fixture.address() as AddressInfo).port}`);
      expect(await session.fillCredential("Locked password", "new-value")).toMatchObject({ ok: false });
      expect(await session.fillCredential("Blocked password", "new-value")).toMatchObject({ ok: false });
      expect(await session.fillCredential("Password", "new-value")).toEqual({ ok: true });
      expect(await session.fillCredential("Password", "")).toEqual({ ok: true });
    } finally {
      await session.close();
      fixture.close();
      fs.rmSync(logs, { recursive: true, force: true });
    }
  }, 30_000);
});
