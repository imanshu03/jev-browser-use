// Scraper files on disk: $XDG_CONFIG_HOME/jev-browser/scrapers/<name>.json (default ~/.config), or a path the user
// gives. Atomic writes. Nothing else is stored: no rows, no pages.
//
// The exported names and signatures are a contract of the scrape kit (see /tmp/jevscrape/build/SPEC.md, section C10).
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ScraperSpec } from "./spec.js";
import { NAME_RE, SpecError, parseScraper } from "./spec.js";

/** The scrapers directory. */
export function scrapersDir(env: NodeJS.ProcessEnv): string {
  const base = env["XDG_CONFIG_HOME"] ?? path.join(env["HOME"] ?? os.homedir(), ".config");
  return path.join(base, "jev-browser", "scrapers");
}

/** A value with "/" or ending in ".json" is a path. */
function isPath(nameOrPath: string): boolean {
  return nameOrPath.includes("/") || nameOrPath.includes(path.sep) || nameOrPath.endsWith(".json");
}

/** The file of a name or a path: a value with "/" or ending in ".json" is a path; else <scrapersDir>/<name>.json. */
export function scraperPath(nameOrPath: string, env: NodeJS.ProcessEnv): string {
  if (isPath(nameOrPath)) {
    const home = env["HOME"] ?? os.homedir();
    return path.resolve(nameOrPath.startsWith("~/") ? path.join(home, nameOrPath.slice(2)) : nameOrPath);
  }
  if (!NAME_RE.test(nameOrPath)) throw new SpecError(`"${nameOrPath}" is not a scraper name: use 1-63 characters a-z, 0-9, _ and -, or give a path to a .json file`);
  return path.join(scrapersDir(env), `${nameOrPath}.json`);
}

/** Read and check a scraper file. Throws SpecError for a bad file, and an Error with code ENOENT for a missing one. */
export function loadScraper(nameOrPath: string, env: NodeJS.ProcessEnv): { spec: ScraperSpec; path: string } {
  const file = scraperPath(nameOrPath, env);
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      const missing = new Error(`no scraper ${isPath(nameOrPath) ? "file" : nameOrPath} at ${file}`) as NodeJS.ErrnoException;
      missing.code = "ENOENT";
      throw missing;
    }
    throw e;
  }
  let data: unknown;
  try { data = JSON.parse(raw); } catch (e) { throw new SpecError(`${file}: not JSON: ${(e as Error).message}`); }
  try { return { spec: parseScraper(data), path: file }; } catch (e) {
    if (e instanceof SpecError) throw new SpecError(`${file}:\n${e.message}`);
    throw e;
  }
}

/**
 * Write a scraper file atomically (a temporary file, then a rename), mode 600, directory mode 700. Checks the spec
 * first. Throws SpecError when the file exists and `overwrite` is not set. Returns the path.
 */
export function saveScraper(spec: ScraperSpec, env: NodeJS.ProcessEnv, opts: { path?: string; overwrite?: boolean } = {}): string {
  const checked = parseScraper(spec);
  const file = opts.path ? scraperPath(opts.path, env) : scraperPath(checked.name, env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!opts.overwrite && fs.existsSync(file)) throw new SpecError(`${file} exists: pass --force (or overwrite) to replace it`);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(checked, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (opts.overwrite) fs.renameSync(tmp, file);
    else {
      // A link fails when the file came into being after the check: a new scraper never replaces another one.
      try { fs.linkSync(tmp, file); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new SpecError(`${file} exists: pass --force (or overwrite) to replace it`);
        throw e;
      }
      fs.unlinkSync(tmp);
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

export interface ScraperSummary { name: string; path: string; version: number; task: string; updated_at: string; heals: number; problem?: string }

/** The scrapers in scrapersDir, by name. A file that does not parse is listed with `problem`. */
export function listScrapers(env: NodeJS.ProcessEnv): ScraperSummary[] {
  const dir = scrapersDir(env);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: ScraperSummary[] = [];
  for (const f of names.filter((n) => n.endsWith(".json")).sort()) {
    const file = path.join(dir, f);
    try {
      const { spec } = loadScraper(file, env);
      out.push({ name: spec.name, path: file, version: spec.version, task: spec.task, updated_at: spec.updated_at, heals: spec.history.filter((h) => h.level !== "author").length });
    } catch (e) {
      out.push({ name: f.slice(0, -5), path: file, version: 0, task: "", updated_at: "", heals: 0, problem: String((e as Error)?.message ?? e).split("\n").slice(0, 3).join(" ") });
    }
  }
  return out;
}

/** Delete a scraper file. False when it did not exist. */
export function deleteScraper(nameOrPath: string, env: NodeJS.ProcessEnv): boolean {
  try {
    fs.unlinkSync(scraperPath(nameOrPath, env));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
