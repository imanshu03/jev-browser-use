// authorScraper (`jev-scrape new`) with a scripted FastRunner result: the start URL of the Jev run, and the params that
// no step and no start URL sets. No Chrome, no Jev.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunResult } from "../../src/types.js";

const runs: RunResult[] = [];
vi.mock("../../src/fast/loop.js", () => ({
  FastRunner: class {
    async run(): Promise<RunResult> {
      const next = runs.shift();
      if (!next) throw new Error("no scripted run");
      return next;
    }
  },
}));

const { authorScraper } = await import("../../src/scrape/author.js");
const { boundParams, urlTemplate } = await import("../../src/scrape/record.js");
const { fillUrl } = await import("../../src/scrape/spec.js");
const { fakeHuman, fakeLogger, fakeOracle } = await import("../fakes.js");
const { obs } = await import("../fast/fakes.js");
const { fakeBrowser, fakeLlm, loadRead, readPage } = await import("./fakes.js");
type ScraperSpec = import("../../src/scrape/spec.js").ScraperSpec;

const DDG = "https://duckduckgo.com/html/?q=milk";
const DRAFT = JSON.stringify({
  set: "g2",
  fields: { name: { from: "slot", pick: [{ by: "key", key: "div.tw-text-300" }, { by: "longest" }] }, price: { from: "slot", pick: [{ by: "parse", parser: "price", struck: false }], parser: "price" } },
});

function done(url: string): RunResult {
  return {
    version: 1, task: "t", outcome: "done", reason: "", confidence: null, goal: "act", answer: null, final_url: url, final_title: "",
    profile: null, start: { url, how: "task_url", confidence: null }, steps: [], blocked: null, error: null,
    stats: { steps: 0, jev_requests: 0, input_tokens: 0, output_tokens: 0, duration_ms: 1, model: "m", pauses: 0, jev_ms: 0, browser_ms: 0, engine: "cdp" },
  };
}

function setup() {
  const page = readPage({ pages: { res: obs(DDG, [], "Results") }, start: "res", reads: { res: () => ({ ...loadRead("blinkit"), url: DDG }) } });
  const saved: ScraperSpec[] = [];
  const log = fakeLogger();
  const nav = { oracle: fakeOracle(() => ({})), human: fakeHuman({ interactive: false }), profiles: [{ directory: "Profile 14", name: "Parallelloop" }], base: {} as never };
  let t = 0;
  return {
    saved, log,
    opts: (over: Record<string, unknown> = {}) => ({
      name: "ddg", task: "Open https://duckduckgo.com/html/?q={query} and list the results", want: "title and price", params: { query: "milk" }, noNav: false,
      headed: false, browser: fakeBrowser(page), navigator: nav, llm: fakeLlm([DRAFT]), log, now: () => t, sleep: async (ms: number) => { t += ms; },
      save: (s: ScraperSpec) => { saved.push(s); return "/tmp/scrapers/ddg.json"; }, stepTimeoutMs: 1000, ...over,
    }),
  };
}

describe("authorScraper: the start URL of the Jev run", () => {
  beforeEach(() => { runs.length = 0; });

  it("a param value in the start URL becomes its placeholder, so a run with another value opens another page", async () => {
    runs.push(done(DDG));
    const t = setup();
    const r = await authorScraper(t.opts());
    expect(r.result.status).toBe("ok");
    const spec = t.saved[0] as ScraperSpec;
    expect(spec.start_url).toBe("https://duckduckgo.com/html/?q={query}");
    expect(boundParams(spec.start_url, spec.steps).has("query")).toBe(true);
    expect(fillUrl(spec.start_url, { query: "butter & jam" })).toBe("https://duckduckgo.com/html/?q=butter%20%26%20jam");
    expect(t.log.lines.some((l) => l.startsWith("WARN") && l.includes("{query}"))).toBe(false);
  });
  it("a task param that no step and no start URL sets gives a warning", async () => {
    runs.push(done("https://duckduckgo.com/html/?q=cheese"));
    const t = setup();
    const r = await authorScraper(t.opts());
    expect(r.result.status).toBe("ok");
    expect((t.saved[0] as ScraperSpec).start_url).toBe("https://duckduckgo.com/html/?q=cheese");
    expect(t.log.lines).toContainEqual(expect.stringMatching(/^WARN no step and no start URL sets \{query\}: a run with another value reads the same page/));
  });
});

describe("urlTemplate", () => {
  it("maps a decoded path segment or query value that equals a param value; the rest is literal with braces escaped", () => {
    expect(urlTemplate("https://shop.example/c/fruits%20veg/s?q=milk+bread&page=1#top", { cat: "fruits veg", query: "milk bread" }))
      .toBe("https://shop.example/c/{cat}/s?q={query}&page=1#top");
    expect(urlTemplate("https://shop.example/s?q=M%26M&x={a}", { query: "M&M" })).toBe("https://shop.example/s?q={query}&x={{a}}");
    // The host, a part of a value, and a one-character value are not mapped.
    expect(urlTemplate("https://milk.example/s/?q=milkshake", { query: "milk", c: "s" })).toBe("https://milk.example/s/?q=milkshake");
    expect(urlTemplate("https://shop.example/%E0%A4", { query: "x" })).toBe("https://shop.example/%E0%A4");
  });
});
