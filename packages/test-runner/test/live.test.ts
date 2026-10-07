// Live: real Chrome on the demo app. Run with `npm run test:live`. The committed recording replays, so no Jev key is needed.
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

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
