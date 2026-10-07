// Live test of read_page and scraper: a real headless Chrome on a fake profile under a temporary home, mcp-read.html on
// a local HTTP server, a scripted Jev, the real page reader and scrape kit, and an in-memory MCP client. No network, no
// key, and no model: the scraper run replays the steps with code. Run with `npm run test:live` (JEV_LIVE=1).
import type { ChoiceQuestion, Questions } from "@typesafe-ai/sdk";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultUserDataDir } from "@imanshu03/jev-core/fast/chrome.js";
import { BrowserSession } from "@imanshu03/jev-core/fast/session.js";
import type { ReadViewData } from "../src/read-view.js";
import { ReadView } from "../src/read-view.js";
import { RunManager } from "../src/runs.js";
import type { ScraperViewData } from "../src/scraper-tool.js";
import { SCRAPE_KIT, ScraperView } from "../src/scraper-tool.js";
import { baseConfig, fastStarter } from "../src/setup.js";
import type { RunViewData } from "../src/view.js";
import { RunView, estTokens } from "../src/view.js";
import type { ScraperSpec } from "@imanshu03/jev-core/scrape/spec.js";
import { fakeLogger, fakeOracle } from "@imanshu03/jev-core/test/fakes.js";
import { KEY, connect, fakeJev, type StepState } from "./helpers.js";

const FIXTURES = path.resolve(__dirname, "../../core/test/fixtures/live");
const TASK = "search the egg shop for \"eggs\"";

/** The option key of `head` whose element is exactly `label` (and whose role is `role`, when given). */
function exact(q: Questions, head: string, label: string, role?: string): string {
  const c = (q[head] as ChoiceQuestion | undefined)?.criteria ?? {};
  for (const [k, v] of Object.entries(c)) {
    const row = v as { element?: string; role?: string };
    if (row.element === `[${k}] ${label}` && (role === undefined || row.role === role)) return k;
  }
  throw new Error(`no ${head} option "${label}": ${JSON.stringify(c)}`);
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe.skipIf(process.env["JEV_LIVE"] !== "1")("read_page and scraper (live Chrome)", () => {
  let web: http.Server;
  let url = "";
  let home = "";
  let env: NodeJS.ProcessEnv = {};
  const log = fakeLogger();
  let session: BrowserSession;
  let runs: RunManager;
  let c: Awaited<ReturnType<typeof connect>>;
  const pids: number[] = [];
  // Jev: type the query var into the search box, click Search, then done.
  const oracle = fakeOracle((name, state, q) => {
    if (name === "plan") return { goal: "act" };
    if (name !== "step") return {};
    const n = (state as StepState).recent_actions.length;
    if (n === 0) return { page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: exact(q, "type_text_target", "Search products"), confidence: 0.9 }, type_text_value: { choice: "v_query", confidence: 0.9 } };
    if (n === 1) return { page_kind: "task_page", operation: "CLICK", click_target: { choice: exact(q, "click_target", "Search", "button"), confidence: 0.9 } };
    return { page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } };
  });

  type Result = Awaited<ReturnType<typeof c.client.callTool>>;
  const text = (r: Result): string => ((r.content as { type: string; text: string }[])[0] as { text: string }).text;
  const ok = (r: Result): unknown => {
    expect(r.isError, text(r)).toBeFalsy();
    return r.structuredContent;
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<Result> => c.client.callTool({ name, arguments: args });
  const settle = async (v: RunViewData): Promise<RunViewData> => {
    let cur = v;
    for (let i = 0; i < 20 && !["done", "blocked", "failed"].includes(cur.status); i++) cur = RunView.parse(ok(await call("wait", { run: v.run, wait_s: 10 })));
    return cur;
  };
  const noteChrome = (): void => { const pid = session.chrome?.pid; if (pid !== undefined && !pids.includes(pid)) pids.push(pid); };

  beforeAll(async () => {
    web = http.createServer((req, res) => {
      const file = path.join(FIXTURES, path.basename(new URL(req.url ?? "/", "http://x").pathname));
      if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(file));
    });
    await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(web.address() as AddressInfo).port}/mcp-read.html`;
    // A fake Chrome profile named Parallelloop under a temporary home: the copy and the scrapers go to its XDG_CONFIG_HOME.
    home = fs.mkdtempSync(path.join(os.tmpdir(), "jev-mcp-read-live-"));
    env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, "config") };
    const source = defaultUserDataDir(env);
    fs.mkdirSync(path.join(source, "Profile 7"), { recursive: true });
    fs.writeFileSync(path.join(source, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 7": { name: "Parallelloop" } } } }));
    session = new BrowserSession({ env, log });
    const profiles = () => [{ directory: "Profile 7", name: "Parallelloop" }];
    const base = baseConfig({}, log);
    const start = fastStarter({ session, jev: fakeJev(), base, env, profiles, oracle: () => oracle });
    runs = new RunManager({ start, log, secret: () => KEY, forceStop: () => session.close() });
    c = await connect({
      runs, version: "0.1.0", env, profiles, secret: () => KEY, log,
      closeBrowser: async () => { const open = session.chrome !== null; await session.close(); return open; },
      scrape: { kit: SCRAPE_KIT, session, base },
    }, () => ({ action: "accept", content: { allow: true } }));
  }, 30_000);

  afterAll(async () => {
    await c?.close().catch(() => undefined);
    await runs?.shutdown().catch(() => undefined);
    await session?.close().catch(() => undefined);
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    await new Promise<void>((r) => web.close(() => r()));
    fs.rmSync(home, { recursive: true, force: true });
  });

  let runId = "";
  let read: ReadViewData;
  let savedRows: unknown[] = [];

  it("a browse run reaches the results; read_page during the run is refused", async () => {
    const v0 = RunView.parse(ok(await call("browse", { task: TASK, url, profile: "Parallelloop", headed: false, goal: "act", vars: { query: "eggs" }, wait_s: 0 })));
    runId = v0.run;
    const busy = await call("read_page", {});
    expect(busy.isError).toBe(true);
    expect(text(busy)).toBe(`run ${runId} is active. Call wait with run "${runId}", or cancel it first.`);
    const v = await settle(v0);
    noteChrome();
    expect(v.status, JSON.stringify(v)).toBe("done");
    expect(session.chrome?.profile.directory).toBe("Profile 7");
  }, 60_000);

  it("read_page returns the table and the card group within the budget", async () => {
    const r = await call("read_page", { max_tokens: 6000 });
    expect(estTokens(text(r))).toBeLessThanOrEqual(6000);
    read = ReadView.parse(ok(r));
    expect(read.read_id).toBe("p1");
    expect(read.cursor).toBeNull();
    expect(read.title).toBe("Egg shop");
    const t = read.untrusted_tables.find((x) => x.headers.join("|") === "Zone|Rate|Average");
    expect(t, JSON.stringify(read.untrusted_tables)).toBeDefined();
    expect(t?.rows.map((row) => row.cells)).toEqual([["Hyderabad", "525", "535.00"], ["Pune", "560", "561.20"], ["Chennai", "540", "538.10"], ["Mumbai", "575", "570.40"], ["Kolkata", "530", "529.90"]]);
    const g = read.untrusted_records.find((x) => x.count === 6);
    expect(g, JSON.stringify(read.untrusted_records.map((x) => [x.id, x.count, x.shape]))).toBeDefined();
    const texts = g?.records.map((rec) => rec.slots.map((s) => s.text)) ?? [];
    expect(texts[0]).toEqual(expect.arrayContaining(["Farm Eggs 6 pcs", "\u20b954", "\u20b960", "ADD"]));
    const mrp = g?.records[0]?.slots.find((s) => s.text === "\u20b960");
    expect(mrp?.facts).toContain("struck");
  }, 30_000);

  it("scraper save with from_run saves to the temporary XDG directory", async () => {
    const g = read.untrusted_records.find((x) => x.count === 6);
    const keyOf = (sample: string): string => g?.slots.find((s) => s.samples.includes(sample))?.key ?? "missing";
    const v = ScraperView.parse(ok(await call("scraper", {
      action: "save", name: "mcp-live-eggs", task: "search the egg shop for {query}", want: "name, price, and MRP of each product",
      from_run: runId, params: { query: "eggs" }, read_id: read.read_id,
      extract: {
        set: g?.id, key: ["name"],
        fields: {
          name: { from: "slot", pick: [{ by: "key", key: keyOf("Farm Eggs 6 pcs") }, { by: "longest" }], parser: "text" },
          price: { from: "slot", pick: [{ by: "key", key: keyOf("\u20b954") }, { by: "parse", parser: "price", struck: false }], parser: "price" },
          mrp: { from: "slot", pick: [{ by: "parse", parser: "price", struck: true }], parser: "price" },
          link: { from: "url" },
        },
      },
    })));
    expect(v.saved, JSON.stringify(v)).toBe(true);
    const file = path.join(home, "config", "jev-browser", "scrapers", "mcp-live-eggs.json");
    expect(v.path).toBe(file);
    expect(v.row_count).toBe(6);
    savedRows = v.rows ?? [];
    expect(savedRows[0]).toMatchObject({ name: "Farm Eggs 6 pcs", price: 54, mrp: 60 });
    expect(savedRows[1]).toMatchObject({ name: "Brown Eggs 12 pcs", price: 120, mrp: null });
    const spec = JSON.parse(fs.readFileSync(file, "utf8")) as ScraperSpec;
    expect(spec).toMatchObject({ name: "mcp-live-eggs", version: 1, profile: "Parallelloop", params: { query: "eggs" }, start_url: url });
    expect(spec.steps).toEqual(expect.arrayContaining([expect.objectContaining({ op: "fill", value: "{query}" }), expect.objectContaining({ op: "click", target: expect.objectContaining({ name: "Search" }) })]));
    // The file holds no row: the fingerprint keeps at most 5 key names, and the sixth product is not in the file.
    expect(Object.keys(spec)).not.toContain("rows");
    expect(spec.fingerprint.keys.length).toBeLessThanOrEqual(5);
    expect(fs.readFileSync(file, "utf8")).not.toContain("Quail Eggs");
  }, 30_000);

  it("scraper run replays the steps with no model call and gives the same rows; read_page then reads its page", async () => {
    const before = oracle.requests.length;
    const v: ScraperViewData = ScraperView.parse(ok(await call("scraper", { action: "run", name: "mcp-live-eggs", headed: false })));
    noteChrome();
    expect(v.status, JSON.stringify(v)).toBe("ok");
    expect(v.healed).toBeNull();
    expect(v.stats).toMatchObject({ jev_requests: 0, llm_calls: 0 });
    expect(v.rows).toEqual(savedRows);
    expect(oracle.requests.length).toBe(before);
    const after = ReadView.parse(ok(await call("read_page", { sets: [read.untrusted_tables[0]?.id ?? "t1"] })));
    expect(after.untrusted_tables[0]?.rows).toHaveLength(5);
    const listed = ScraperView.parse(ok(await call("scraper", { action: "list" })));
    expect(listed.scrapers?.map((s) => s.name)).toEqual(["mcp-live-eggs"]);
  }, 60_000);
});
