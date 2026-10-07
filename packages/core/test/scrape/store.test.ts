import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpecError } from "../../src/scrape/spec.js";
import { deleteScraper, listScrapers, loadScraper, saveScraper, scraperPath, scrapersDir } from "../../src/scrape/store.js";
import { clone, loadSpec } from "./fakes.js";

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-scrape-store-"));
  env = { XDG_CONFIG_HOME: path.join(dir, "config"), HOME: path.join(dir, "home") };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const mode = (p: string): number => fs.statSync(p).mode & 0o777;

describe("paths", () => {
  it("scrapersDir follows XDG_CONFIG_HOME, else ~/.config", () => {
    expect(scrapersDir(env)).toBe(path.join(dir, "config", "jev-browser", "scrapers"));
    expect(scrapersDir({ HOME: "/h" })).toBe("/h/.config/jev-browser/scrapers");
  });
  it("a name is a file in the dir; a value with / or .json is a path; ~/ is the home", () => {
    expect(scraperPath("necc-egg", env)).toBe(path.join(scrapersDir(env), "necc-egg.json"));
    expect(scraperPath("./x/a.json", env)).toBe(path.resolve("./x/a.json"));
    expect(scraperPath("a.json", env)).toBe(path.resolve("a.json"));
    expect(scraperPath("~/s/a.json", env)).toBe(path.join(dir, "home", "s", "a.json"));
    expect(() => scraperPath("Bad Name", env)).toThrow(SpecError);
  });
});

describe("save, load, list, delete", () => {
  it("saves atomically with mode 600 in a dir with mode 700, 2-space JSON with a final newline", () => {
    const spec = loadSpec("necc-egg-prices");
    const file = saveScraper(spec, env);
    expect(file).toBe(path.join(scrapersDir(env), "necc-egg-prices.json"));
    expect(mode(file)).toBe(0o600);
    expect(mode(scrapersDir(env))).toBe(0o700);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toBe(JSON.stringify(spec, null, 2) + "\n");
    expect(fs.readdirSync(scrapersDir(env))).toEqual(["necc-egg-prices.json"]);
    expect(loadScraper("necc-egg-prices", env)).toEqual({ spec, path: file });
  });
  it("refuses to replace a file without overwrite; replaces it with overwrite", () => {
    const spec = loadSpec("necc-egg-prices");
    saveScraper(spec, env);
    expect(() => saveScraper(spec, env)).toThrow(/exists: pass --force/);
    const next = { ...clone(spec), version: 2 };
    saveScraper(next, env, { overwrite: true });
    expect(loadScraper("necc-egg-prices", env).spec.version).toBe(2);
    expect(fs.readdirSync(scrapersDir(env)).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
  it("checks the spec before it writes", () => {
    const bad = { ...clone(loadSpec("necc-egg-prices")), task: "x {nope}" };
    expect(() => saveScraper(bad, env)).toThrow(SpecError);
    expect(fs.existsSync(scrapersDir(env))).toBe(false);
  });
  it("saves to a path the user gives", () => {
    const file = saveScraper(loadSpec("qc-search"), env, { path: path.join(dir, "mine", "qc.json") });
    expect(file).toBe(path.join(dir, "mine", "qc.json"));
    expect(loadScraper(file, env).spec.name).toBe("qc-search");
  });
  it("load: a missing file is ENOENT; a bad file is a SpecError with the path", () => {
    expect(() => loadScraper("nope", env)).toThrow(/no scraper nope at /);
    try { loadScraper("nope", env); } catch (e) { expect((e as NodeJS.ErrnoException).code).toBe("ENOENT"); }
    fs.mkdirSync(scrapersDir(env), { recursive: true });
    fs.writeFileSync(path.join(scrapersDir(env), "broken.json"), "{ nope");
    expect(() => loadScraper("broken", env)).toThrow(/broken\.json: not JSON/);
  });
  it("list: by name, with heals; a broken file is flagged", () => {
    saveScraper(loadSpec("qc-search"), env);
    saveScraper(loadSpec("necc-egg-prices"), env);
    fs.writeFileSync(path.join(scrapersDir(env), "broken.json"), JSON.stringify({ kind: "jev-scraper" }));
    fs.writeFileSync(path.join(scrapersDir(env), "notes.txt"), "x");
    const list = listScrapers(env);
    expect(list.map((s) => s.name)).toEqual(["broken", "necc-egg-prices", "qc-search"]);
    expect(list[0]?.problem).toMatch(/broken\.json/);
    expect(list[1]).toMatchObject({ version: 1, heals: 0, task: "Open the NECC daily egg price sheet for month {month} of {year}" });
    expect(list[2]?.problem).toBeUndefined();
    expect(listScrapers({ XDG_CONFIG_HOME: path.join(dir, "none") })).toEqual([]);
  });
  it("delete: true once, then false", () => {
    saveScraper(loadSpec("qc-search"), env);
    expect(deleteScraper("qc-search", env)).toBe(true);
    expect(deleteScraper("qc-search", env)).toBe(false);
  });
});
