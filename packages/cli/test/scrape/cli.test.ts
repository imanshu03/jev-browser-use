import { defaultUserDataDir } from "@imanshu03/jev-core/fast/chrome.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserOptions } from "@imanshu03/jev-core/scrape/launch.js";
import { parseGeo } from "@imanshu03/jev-core/scrape/launch.js";
import { USAGE, main, parseArgs, type ScrapeDeps } from "../../src/scrape/cli.js";
import type { RunScraperOptions } from "@imanshu03/jev-core/scrape/runner.js";
import type { ScrapeResult, ScraperSpec } from "@imanshu03/jev-core/scrape/spec.js";
import { loadScraper, saveScraper } from "@imanshu03/jev-core/scrape/store.js";
import { UsageError } from "@imanshu03/jev-core/plan.js";
import { obs } from "@imanshu03/jev-core/test/fast/fakes.js";
import { fakeBrowser, fakeLlm, loadRead, loadSpec, readPage } from "@imanshu03/jev-core/test/scrape/fakes.js";

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-scrape-cli-"));
  env = { XDG_CONFIG_HOME: path.join(dir, "config"), HOME: path.join(dir, "home") };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function io() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (d: Buffer) => { out += d.toString(); });
  stderr.on("data", (d: Buffer) => { err += d.toString(); });
  return { io: { stdout, stderr, stdin: new PassThrough() as unknown as NodeJS.ReadStream, env }, out: () => out, err: () => err };
}

const PROFILES = [{ directory: "Profile 14", name: "Parallelloop" }, { directory: "Profile 2", name: "BP" }];

function result(status: ScrapeResult["status"], over: Partial<ScrapeResult> = {}): ScrapeResult {
  const rows = status === "ok" ? [{ zone: "Hyderabad", day: "1", rate: 525 }, { zone: "Pune, MH", day: "2", rate: null }] : [];
  return {
    scraper: "necc-egg-prices", version: 1, params: { month: "08", year: "2026" }, url: "https://www.e2necc.com/home/eggprice", rows, row_count: rows.length, status,
    healed: null, reason: status === "ok" ? null : "extract: no table", blocked: status === "blocked" ? { kind: "captcha", hint: "solve it" } : null, saved: null,
    stats: { duration_ms: 10, jev_requests: 0, llm_calls: 0, steps: 3, scrolls: 0 }, ...over,
  };
}

/** Deps with a scripted run: it records the options and gives `res`. */
function runDeps(res: ScrapeResult, seen: { opts?: RunScraperOptions; spec?: ScraperSpec; browser?: BrowserOptions } = {}): ScrapeDeps {
  return {
    profiles: PROFILES, llm: null, navigator: null,
    browser: (o) => { seen.browser = o; return fakeBrowser(readPage({ pages: { a: obs("about:blank", []) }, start: "a" })); },
    run: async (spec, opts) => { seen.spec = spec; seen.opts = opts; return res; },
  };
}

describe("parseArgs", () => {
  it("parses run flags", () => {
    expect(parseArgs(["run", "necc", "--param", "month=09", "--out", "x.csv", "--format", "csv", "--heal", "code", "--headed", "--geo", "12.93,77.62,30", "--profile", "BP"])).toMatchObject({
      command: "run", target: "necc", params: { month: "09" }, out: "x.csv", format: "csv", heal: "code", headed: true, geo: { latitude: 12.93, longitude: 77.62, accuracy: 30 }, profile: "BP",
    });
    expect(parseArgs(["run", "necc", "--no-heal"]).heal).toBe("none");
    expect(parseArgs(["run", "necc"]).heal).toBe("full");
  });
  it("rejects bad flags and values", () => {
    for (const argv of [["fly"], ["run"], ["run", "a", "b"], ["run", "a", "--task", "x"], ["run", "a", "--param", "Bad=1"], ["run", "a", "--param", "novalue"],
      ["run", "a", "--format", "xml"], ["run", "a", "--heal", "max"], ["run", "a", "--geo", "91,0"], ["read"], ["read", "a", "--url", "https://x"],
      ["new", "x", "--want", "w"], ["new", "x", "--task", "t"], ["new", "Bad", "--task", "t", "--want", "w"], ["new", "x", "--task", "t", "--want", "w", "--no-nav"],
      ["new", "x", "--task", "search {q}", "--want", "w"], ["new", "x", "--task", "t", "--want", "w", "--max-steps", "0"]]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(UsageError);
    }
  });
  it("parseGeo", () => {
    expect(parseGeo("12.9,77.6")).toEqual({ latitude: 12.9, longitude: 77.6 });
    for (const bad of ["12.9", "a,b", "12,200", "1,2,3,4", "1,2,-5", ",1", "1e1,2", "0x10,2", "1,2,0"]) expect(() => parseGeo(bad)).toThrow(UsageError);
    expect(parseGeo(" -12.5 , 77.6 , 30 ")).toEqual({ latitude: -12.5, longitude: 77.6, accuracy: 30 });
  });
});

describe("main", () => {
  it("a scraper with no profile uses the saved browser's default profile list", async () => {
    const { profile: _profile, ...spec } = loadSpec("necc-egg-prices");
    saveScraper({ ...spec, browser: "edge" }, env);
    const chromeProfiles = defaultUserDataDir(env, undefined, "chrome");
    fs.mkdirSync(chromeProfiles, { recursive: true });
    fs.writeFileSync(path.join(chromeProfiles, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 14": { name: "Parallelloop" } } } }));
    const seen: { browser?: BrowserOptions } = {};
    const deps = runDeps(result("ok"), seen);
    delete deps.profiles;
    expect(await main(["run", "necc-egg-prices"], io().io, deps)).toBe(0);
    expect(seen.browser?.browser).toBe("edge");
    expect(seen.browser?.profileDirectory).toBeUndefined();
    const edgeProfiles = defaultUserDataDir(env, undefined, "edge");
    fs.mkdirSync(edgeProfiles, { recursive: true });
    fs.writeFileSync(path.join(edgeProfiles, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 2": { name: "Parallelloop" } } } }));
    expect(await main(["run", "necc-egg-prices"], io().io, deps)).toBe(0);
    expect(seen.browser?.profileDirectory).toBe("Profile 2");
  });

  it("run uses the browser stored in the scraper file", async () => {
    saveScraper({ ...loadSpec("necc-egg-prices"), browser: "edge" }, env);
    const seen: { browser?: BrowserOptions } = {};
    expect(await main(["run", "necc-egg-prices"], io().io, runDeps(result("ok"), seen))).toBe(0);
    expect(seen.browser).toMatchObject({ browser: "edge", profileDirectory: "Profile 14" });
    env["JEV_BROWSER"] = "brave";
    expect(await main(["run", "necc-egg-prices"], io().io, runDeps(result("ok"), seen))).toBe(0);
    expect(seen.browser?.browser).toBe("brave");
  });

  it("--help, no args, --version", async () => {
    const a = io();
    expect(await main(["--help"], a.io)).toBe(0);
    expect(a.err()).toBe(USAGE);
    expect(await main([], io().io)).toBe(4);
    const v = io();
    expect(await main(["--version"], v.io)).toBe(0);
    expect(v.out()).toBe("jev-scrape 0.1.0\n");
  });
  it("run: exit 0 with the result JSON on stdout; the default profile and the env timeouts go to the run", async () => {
    saveScraper(loadSpec("necc-egg-prices"), env);
    const seen: { opts?: RunScraperOptions; browser?: BrowserOptions } = {};
    const a = io();
    env["JEV_SCRAPE_STEP_MS"] = "3000";
    expect(await main(["run", "necc-egg-prices", "--param", "month=09"], a.io, runDeps(result("ok"), seen))).toBe(0);
    const out = JSON.parse(a.out()) as ScrapeResult;
    expect(out.status).toBe("ok");
    expect(out.rows).toHaveLength(2);
    expect(seen.opts).toMatchObject({ heal: "full", params: { month: "09", year: "2026" }, headed: false, stepTimeoutMs: 3000, llmTimeoutMs: 180_000, contextChars: 48_000 });
    expect(seen.opts?.navigator).toBeUndefined();
    expect(seen.browser).toMatchObject({ headed: false, profileDirectory: "Profile 14" });
  });
  it("run: exit 2 for blocked, 3 for failed", async () => {
    saveScraper(loadSpec("necc-egg-prices"), env);
    expect(await main(["run", "necc-egg-prices"], io().io, runDeps(result("blocked")))).toBe(2);
    expect(await main(["run", "necc-egg-prices"], io().io, runDeps(result("failed")))).toBe(3);
  });
  it("run: --format csv prints the rows on stdout and the summary on stderr", async () => {
    saveScraper(loadSpec("necc-egg-prices"), env);
    const a = io();
    expect(await main(["run", "necc-egg-prices", "--format", "csv"], a.io, runDeps(result("ok")))).toBe(0);
    expect(a.out()).toBe("zone,section,month,year,day,rate\r\nHyderabad,,,,1,525\r\n\"Pune, MH\",,,,2,\r\n");
    expect(a.err()).toMatch(/INFO result \{"scraper":"necc-egg-prices"/);
    expect(a.err()).not.toContain("Hyderabad");
  });
  it("run: --format csv after a heal takes the columns of the healed version", async () => {
    saveScraper(loadSpec("necc-egg-prices"), env);
    const deps = runDeps(result("ok", { rows: [{ zone: "Hyderabad", day: "1", price: 525 }], healed: { level: "L3", reason: "extract: no table" } }));
    deps.run = async (spec, opts) => {
      const extract = { ...spec.extract, key: ["zone", "day"], fields: { zone: spec.extract.fields["zone"] ?? { from: "section" } } } as ScraperSpec["extract"];
      if (extract.source === "table" && extract.melt) extract.melt = { ...extract.melt, value_field: "price" };
      await opts.save?.({ ...spec, version: 2, extract, validate: { min_rows: 1, required: [] } });
      return result("ok", { rows: [{ zone: "Hyderabad", day: "1", price: 525 }], healed: { level: "L3", reason: "extract: no table" }, version: 2 });
    };
    const a = io();
    expect(await main(["run", "necc-egg-prices", "--format", "csv"], a.io, deps)).toBe(0);
    expect(a.out()).toBe("zone,day,price\r\nHyderabad,1,525\r\n");
  });
  it("run: --out writes the rows file; stdout has no rows but out", async () => {
    saveScraper(loadSpec("necc-egg-prices"), env);
    const file = path.join(dir, "rows.json");
    const a = io();
    expect(await main(["run", "necc-egg-prices", "--out", file], a.io, runDeps(result("ok")))).toBe(0);
    const out = JSON.parse(a.out()) as Record<string, unknown>;
    expect(out["out"]).toBe(file);
    expect(out["rows"]).toBeUndefined();
    expect(out["row_count"]).toBe(2);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(result("ok").rows);
    const csv = path.join(dir, "rows.csv");
    expect(await main(["run", "necc-egg-prices", "--out", csv, "--format", "csv"], io().io, runDeps(result("ok")))).toBe(0);
    expect(fs.readFileSync(csv, "utf8").split("\r\n")[0]).toBe("zone,section,month,year,day,rate");
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
  it("run: a failed run leaves an earlier --out file as it was", async () => {
    saveScraper(loadSpec("necc-egg-prices"), env);
    const file = path.join(dir, "rows.json");
    fs.writeFileSync(file, "[1]");
    const a = io();
    expect(await main(["run", "necc-egg-prices", "--out", file], a.io, runDeps(result("failed")))).toBe(3);
    expect(fs.readFileSync(file, "utf8")).toBe("[1]");
    expect(JSON.parse(a.out())["out"]).toBeUndefined();
  });
  it("run: exit 4 for an unknown scraper, a bad file, a missing or unknown param, and an unknown profile", async () => {
    const a = io();
    expect(await main(["run", "nope"], a.io, runDeps(result("ok")))).toBe(4);
    expect(a.err()).toMatch(/no scraper nope at /);
    fs.mkdirSync(path.join(dir, "config", "jev-browser", "scrapers"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "jev-browser", "scrapers", "bad.json"), "{");
    expect(await main(["run", "bad"], io().io, runDeps(result("ok")))).toBe(4);
    saveScraper(loadSpec("necc-egg-prices"), env);
    expect(await main(["run", "necc-egg-prices", "--param", "day=1"], io().io, runDeps(result("ok")))).toBe(4);
    const missing = io();
    expect(await main(["run", "necc-egg-prices", "--param", "month="], missing.io, runDeps(result("ok")))).toBe(4);
    expect(missing.err()).toContain("{month} has no value");
    expect(await main(["run", "necc-egg-prices", "--profile", "Nobody"], io().io, runDeps(result("ok")))).toBe(4);
  });
  it("run: a file with no profile uses a temporary profile when this machine has no default profile", async () => {
    const { profile: _profile, ...noProfile } = loadSpec("necc-egg-prices");
    saveScraper(noProfile, env);
    const seen: { opts?: RunScraperOptions; browser?: BrowserOptions } = {};
    const a = io();
    expect(await main(["run", "necc-egg-prices"], a.io, { ...runDeps(result("ok"), seen), profiles: [{ directory: "Profile 2", name: "BP" }] })).toBe(0);
    expect(seen.browser?.profileDirectory).toBeUndefined();
    expect(a.err()).toContain("no Parallelloop profile here; using a temporary profile");
  });
  it("run: --profile none is a temporary profile; --no-heal and --geo reach the run", async () => {
    saveScraper(loadSpec("necc-egg-prices"), env);
    const seen: { opts?: RunScraperOptions; browser?: BrowserOptions } = {};
    await main(["run", "necc-egg-prices", "--profile", "none", "--no-heal", "--geo", "12.9,77.6"], io().io, runDeps(result("ok"), seen));
    expect(seen.browser?.profileDirectory).toBeUndefined();
    expect(seen.browser?.geo).toEqual({ latitude: 12.9, longitude: 77.6 });
    expect(seen.opts?.heal).toBe("none");
  });
  it("run and read: the geo of the file reaches the browser; --geo wins over it", async () => {
    saveScraper({ ...loadSpec("necc-egg-prices"), geo: { latitude: 12.93, longitude: 77.62 } }, env);
    const seen: { opts?: RunScraperOptions; browser?: BrowserOptions } = {};
    await main(["run", "necc-egg-prices"], io().io, runDeps(result("ok"), seen));
    expect(seen.browser?.geo).toEqual({ latitude: 12.93, longitude: 77.62 });
    await main(["run", "necc-egg-prices", "--geo", "19.07,72.87"], io().io, runDeps(result("ok"), seen));
    expect(seen.browser?.geo).toEqual({ latitude: 19.07, longitude: 72.87 });
    const read: { browser?: BrowserOptions } = {};
    const page = readPage({ pages: { a: obs("https://www.e2necc.com/home/eggprice", []) }, start: "a" });
    const deps: ScrapeDeps = { profiles: PROFILES, llm: null, navigator: null, browser: (o) => { read.browser = o; return fakeBrowser(page); } };
    env["JEV_SCRAPE_STEP_MS"] = "1000";
    expect(await main(["read", "necc-egg-prices"], io().io, deps)).toBe(0);
    expect(read.browser?.geo).toEqual({ latitude: 12.93, longitude: 77.62 });
    // A page URL with no file has no geo but --geo.
    expect(await main(["read", "--url", "https://www.e2necc.com/home/eggprice"], io().io, deps)).toBe(0);
    expect(read.browser?.geo).toBeUndefined();
  });
  it("run: the save of a heal writes the same file", async () => {
    const file = saveScraper(loadSpec("necc-egg-prices"), env);
    const seen: { opts?: RunScraperOptions } = {};
    await main(["run", "necc-egg-prices"], io().io, runDeps(result("ok"), seen));
    const spec = loadScraper("necc-egg-prices", env).spec;
    expect(await seen.opts?.save?.({ ...spec, version: 2 })).toBe(file);
    expect(loadScraper("necc-egg-prices", env).spec.version).toBe(2);
  });
  it("list, show, rm on the XDG dir", async () => {
    saveScraper(loadSpec("necc-egg-prices"), env);
    saveScraper(loadSpec("qc-search"), env);
    const l = io();
    expect(await main(["list"], l.io)).toBe(0);
    expect((JSON.parse(l.out()) as { name: string }[]).map((s) => s.name)).toEqual(["necc-egg-prices", "qc-search"]);
    const s = io();
    expect(await main(["show", "qc-search"], s.io)).toBe(0);
    expect(JSON.parse(s.out())).toEqual(loadSpec("qc-search"));
    const r = io();
    expect(await main(["rm", "qc-search"], r.io)).toBe(0);
    expect(JSON.parse(r.out())).toMatchObject({ deleted: true });
    const again = io();
    expect(await main(["rm", "qc-search"], again.io)).toBe(3);
    expect(again.err()).toMatch(/no scraper at /);
    expect(await main(["show", "qc-search"], io().io)).toBe(4);
  });
});

describe("main: new", () => {
  it("new stores the selected browser for later replay", async () => {
    env["JEV_BROWSER"] = "edge";
    expect(await main(ARGS, io().io, newDeps([draft]))).toBe(0);
    expect(loadScraper("shop", env).spec.browser).toBe("edge");
  });

  it("an explicit temporary profile is stored when the default profile exists", async () => {
    expect(await main([...ARGS, "--profile", "none"], io().io, newDeps([draft]))).toBe(0);
    expect(loadScraper("shop", env).spec.profile).toBe("none");
  });

  const RES = "https://shop.example/s?q=eggs";
  const draft = JSON.stringify({
    set: "g2",
    fields: {
      name: { from: "slot", pick: [{ by: "key", key: "div.tw-text-300" }, { by: "longest" }] },
      price: { from: "slot", pick: [{ by: "parse", parser: "price", struck: false }], parser: "price" },
    },
    key: ["name"],
  });
  function newDeps(llmAnswers: string[], seen: { browser?: BrowserOptions } = {}): ScrapeDeps & { llm: ReturnType<typeof fakeLlm> } {
    const page = readPage({ pages: { blank: obs("about:blank", []), res: obs(RES, [], "Results") }, start: "blank", transitions: (c) => (c.op === "navigate" ? "res" : undefined), reads: { res: () => ({ ...loadRead("blinkit"), url: RES }) } });
    return { profiles: PROFILES, navigator: null, llm: fakeLlm(llmAnswers), browser: (o) => { seen.browser = o; return fakeBrowser(page); } };
  }
  const ARGS = ["new", "shop", "--no-nav", "--url", "https://shop.example/s?q={query}", "--param", "query=eggs", "--task", "search for {query}", "--want", "name and price of each product"];

  it("--no-nav: the LLM writes the extract; the first version is saved and its rows printed", async () => {
    const deps = newDeps([draft]);
    const a = io();
    expect(await main(ARGS, a.io, deps)).toBe(0);
    const out = JSON.parse(a.out()) as ScrapeResult;
    expect(out).toMatchObject({ scraper: "shop", version: 1, status: "ok", healed: null, row_count: 4, stats: { llm_calls: 1, jev_requests: 0 } });
    expect(out.saved).toBe(path.join(dir, "config", "jev-browser", "scrapers", "shop.json"));
    const spec = loadScraper("shop", env).spec;
    expect(spec).toMatchObject({ version: 1, start_url: "https://shop.example/s?q={query}", steps: [], params: { query: "eggs" }, load: { mode: "none" }, task: "search for {query}" });
    expect(spec.validate).toEqual({ min_rows: 2, required: ["name", "price"], required_ratio: 0.8 });
    expect(spec.history).toEqual([{ at: expect.any(String), level: "author", reason: "jev-scrape new", from_version: 0, previous: null }]);
    expect(spec.fingerprint.keys).toEqual(["Licious Chicken Curry Cut (Skinless)", "Fresho Farm Eggs", "Amul Taaza Toned Milk", "Country Delight Paneer"]);
    expect(deps.llm.calls[0]?.user).toContain("WANT: name and price of each product\nTASK: search for eggs\nPARAMS: {\"query\":\"eggs\"}");
  });
  it("a page that renders its cards in parts: new reads until the sets stop growing", async () => {
    let n = 0;
    const part = () => {
      n += 1;
      const r = { ...loadRead("blinkit"), url: RES };
      const g = r.groups[1];
      if (g && n === 1) { g.records = g.records.slice(0, 2); g.count = 2; }
      return r;
    };
    const page = readPage({ pages: { blank: obs("about:blank", []), res: obs(RES, [], "Results") }, start: "blank", transitions: (c) => (c.op === "navigate" ? "res" : undefined), reads: { res: part } });
    const deps: ScrapeDeps = { profiles: PROFILES, navigator: null, llm: fakeLlm([draft]), browser: () => fakeBrowser(page) };
    const a = io();
    expect(await main(ARGS, a.io, deps)).toBe(0);
    expect(JSON.parse(a.out())).toMatchObject({ status: "ok", row_count: 4 });
    expect(page.reads.length).toBeGreaterThanOrEqual(3);
  });
  it("with no --profile, the file stores none when this machine has no default profile, and nothing when it has one", async () => {
    expect(await main(ARGS, io().io, { ...newDeps([draft]), profiles: [{ directory: "Profile 2", name: "BP" }] })).toBe(0);
    expect(loadScraper("shop", env).spec.profile).toBe("none");
    expect(await main([...ARGS, "--force"], io().io, newDeps([draft]))).toBe(0);
    expect(loadScraper("shop", env).spec.profile).toBeUndefined();
  });
  it("refuses an existing name without --force (exit 4); --force replaces it", async () => {
    expect(await main(ARGS, io().io, newDeps([draft]))).toBe(0);
    const a = io();
    expect(await main(ARGS, a.io, newDeps([draft]))).toBe(4);
    expect(a.err()).toMatch(/exists .*--force/);
    expect(await main([...ARGS, "--force"], io().io, newDeps([draft]))).toBe(0);
  });
  it("up to 3 LLM calls with the problems as feedback; 3 bad answers exit 3 and save nothing", async () => {
    const bad = JSON.stringify({ set: "g9", fields: { a: { from: "url" } } });
    const ok = newDeps(["nope", bad, draft]);
    expect(await main(ARGS, io().io, ok)).toBe(0);
    expect(ok.llm.calls).toHaveLength(3);
    expect(ok.llm.calls[2]?.user).toContain("Your last answer failed: set: g9 is not in the page read");
    fs.rmSync(path.join(dir, "config"), { recursive: true, force: true });
    const fail = newDeps(["nope", bad, bad]);
    const a = io();
    expect(await main(ARGS, a.io, fail)).toBe(3);
    expect(JSON.parse(a.out())).toMatchObject({ status: "failed", saved: null });
    expect(fs.existsSync(path.join(dir, "config", "jev-browser", "scrapers", "shop.json"))).toBe(false);
  });
  it("exit 4 for a secret param or a secret in the task: a scraper file never holds a secret", async () => {
    const a = io();
    expect(await main(["new", "x", "--no-nav", "--url", "https://example.com", "--task", "t {password}", "--want", "w", "--param", "password=hunter2"], a.io, newDeps([draft]))).toBe(4);
    expect(a.err()).toContain("params password name secrets. A scraper file never holds a secret: leave them out");
    const b = io();
    expect(await main(["new", "x", "--no-nav", "--url", "https://example.com", "--task", 'log in with password "hunter2" and list orders', "--want", "w"], b.io, newDeps([draft]))).toBe(4);
    expect(b.err()).toContain("the task holds a secret value");
    expect(b.err()).not.toContain("hunter2");
    expect(fs.existsSync(path.join(dir, "config", "jev-browser", "scrapers", "x.json"))).toBe(false);
  });
  it("exit 4 without an LLM, or without TYPESAFE_API_KEY for the navigation", async () => {
    const a = io();
    expect(await main(ARGS, a.io, { ...newDeps([]), llm: null })).toBe(4);
    expect(a.err()).toMatch(/new needs an LLM/);
    const b = io();
    const withNav = ARGS.filter((x) => x !== "--no-nav");
    const deps: ScrapeDeps = { ...newDeps([]) };
    delete deps.navigator;
    expect(await main(withNav, b.io, deps)).toBe(4);
    expect(b.err()).toMatch(/TYPESAFE_API_KEY/);
  });
});
