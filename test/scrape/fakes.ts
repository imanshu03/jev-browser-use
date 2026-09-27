// Fakes of the scrape kit: PageRead fixtures, a fake Page that reads, a ScrapeBrowser, and a scripted LLM backend.
// No Chrome, no network, no model.
import type { ChoiceQuestion, Questions } from "@typesafe-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import type { Observation, Page } from "../../src/fast/model.js";
import type { PageRead, ReadOptions, ScrollState } from "../../src/fast/read-types.js";
import type { LlmBackend } from "../../src/scrape/llm.js";
import type { ScrapeBrowser } from "../../src/scrape/runner.js";
import type { ScraperSpec } from "../../src/scrape/spec.js";
import { parseScraper } from "../../src/scrape/spec.js";
import { fakeChrome, fakePage, type FakePage, type PageScript } from "../fast/fakes.js";

export const FIXTURES = path.resolve(__dirname, "../fixtures/scrape");

/** A PageRead fixture, as a fresh copy. */
export function loadRead(name: string): PageRead {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.read.json`), "utf8")) as PageRead;
}

/** An example scraper file of test/fixtures/scrape. */
export function loadSpec(name: string): ScraperSpec {
  return parseScraper(JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")));
}

/** A deep copy of a JSON value. */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export interface ReadPage extends FakePage {
  reads: ReadOptions[];
  wheels: number[];
}

/**
 * A fake Page (test/fast/fakes.ts) that also reads: `reads[page name]` is the PageRead of each page of the script. A
 * page without a read gives an empty read at its URL.
 */
export function readPage(script: PageScript & { reads?: Record<string, PageRead | (() => PageRead)> }): ReadPage {
  const p = fakePage(script) as ReadPage;
  p.reads = [];
  p.wheels = [];
  const page = p as unknown as Page & ReadPage;
  page.read = async (opts?: ReadOptions): Promise<PageRead> => {
    p.reads.push(opts ?? {});
    const r = script.reads?.[p.current];
    const obs = script.pages[p.current] as Observation;
    if (r === undefined) return { ...emptyRead(obs.url) };
    return clone(typeof r === "function" ? r() : r);
  };
  page.wheel = async (dy: number): Promise<ScrollState> => {
    p.wheels.push(dy);
    return { y: 0, height: 1000, viewport: 800 };
  };
  return p;
}

export function emptyRead(url: string): PageRead {
  return {
    version: 1, url, title: "", meta: { headings: [], selected: [], lang: "" }, tables: [], groups: [], text: [],
    stats: { ms: 1, tables_seen: 0, groups_seen: 0, nodes: 10, scroll_height: 800, viewport_height: 800, truncated: false },
  };
}

/** A ScrapeBrowser over one page. `closes` counts close calls. */
export function fakeBrowser(page: Page): ScrapeBrowser & { closes: number; pages: number } {
  const chrome = fakeChrome();
  const b = {
    closes: 0,
    pages: 0,
    async page() { b.pages += 1; return page; },
    async chrome() { return chrome; },
    async close() { b.closes += 1; },
  };
  return b;
}

/** A scripted LLM backend: each call takes the next answer (a text, an Error to throw, or a function of the request). */
export function fakeLlm(answers: (string | Error | ((req: { system: string; user: string }) => string))[]): LlmBackend & { calls: { system: string; user: string; timeoutMs: number }[] } {
  const calls: { system: string; user: string; timeoutMs: number }[] = [];
  const queue = [...answers];
  return {
    name: "fake:llm",
    calls,
    async complete(req) {
      calls.push({ system: req.system, user: req.user, timeoutMs: req.timeoutMs });
      const next = queue.shift();
      if (next === undefined) throw new Error("fake llm: no scripted answer");
      if (next instanceof Error) throw next;
      return { text: typeof next === "function" ? next(req) : next, ms: 5 };
    },
  };
}

/** The page data (JSON) of an LLM user message: the text between the delimiters. */
export function contextOf(user: string): { tables: { id: string; headers: string[] }[]; groups: { id: string; slots: { key: string }[] }[] } {
  const a = user.indexOf("\n", user.indexOf("<<<UNTRUSTED_PAGE_DATA")) + 1;
  const b = user.lastIndexOf("\nUNTRUSTED_PAGE_DATA>>>");
  return JSON.parse(user.slice(a, b)) as ReturnType<typeof contextOf>;
}

/** The choice key of the element whose label holds `label`, as test/fast/loop.test.ts does. */
export function idx(questions: Questions, head: string, label: string): string {
  const q = questions[head] as ChoiceQuestion | undefined;
  for (const [key, v] of Object.entries(q?.criteria ?? {})) {
    if (typeof v === "object" && v !== null && String((v as { element?: string }).element ?? "").includes(label)) return key;
  }
  throw new Error(`no ${head} option for ${label}: ${Object.keys(q?.criteria ?? {}).join(",")}`);
}

/** The key of the value option whose text is exactly `text`, in any value head of a step request. */
export function valueKey(questions: Questions, text: string): string {
  for (const [name, q] of Object.entries(questions)) {
    if (!name.startsWith("value_")) continue;
    for (const [key, v] of Object.entries((q as ChoiceQuestion).criteria)) if (JSON.stringify(v).includes(JSON.stringify(text))) return key;
  }
  throw new Error(`no value option ${text}`);
}
