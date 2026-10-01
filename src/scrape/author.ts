// `jev-scrape new`: build a scraper from scratch. Jev reaches the page of the rows (unless --no-nav), its step records
// become the steps, the LLM writes the extract from the page context (up to 3 calls), code tests it on the page, and
// the first version is saved. The result is the first extraction.
import type { BrowserKind } from "../fast/chrome.js";
import type { Page } from "../fast/model.js";
import type { LoadOptions, LoadReport } from "../fast/read.js";
import type { PageRead } from "../fast/read-types.js";
import { loadAll } from "../fast/read.js";
import type { GeoPoint } from "../fast/model.js";
import type { Logger } from "../io.js";
import { extractSpans, redact, varSpans } from "../task.js";
import { LIMITS, secretKey } from "../types.js";
import { fingerprintOf } from "./extract.js";
import { ROWS_READ, draftFromLlm, navigate } from "./heal.js";
import type { LlmBackend } from "./llm.js";
import { LLM_TIMEOUT_MS } from "./llm.js";
import { CONTEXT_CHARS } from "./prompt.js";
import { boundParams, urlTemplate } from "./record.js";
import { STEP_MS, wallHint } from "./replay.js";
import type { NavigatorDeps, ScrapeBrowser } from "./runner.js";
import { READ_POLL_MS, shownParams } from "./runner.js";
import type { Row, ScrapeResult, ScraperSpec, Step } from "./spec.js";
import { SpecError, fillTemplate, fillUrl, parseScraper, placeholders } from "./spec.js";
import { defaultValidate, mergeValidate } from "./validate.js";

/** LLM calls of one authoring. */
export const AUTHOR_CALLS = 3;

export interface AuthorOptions {
  name: string;
  /** The task, with `{param}` placeholders. */
  task: string;
  want: string;
  /** The start URL (with `{param}` placeholders). Required with `noNav`. */
  url?: string;
  params: Record<string, string>;
  noNav: boolean;
  maxSteps?: number;
  headed: boolean;
  /** The profile name to store in the file (absent: the default). */
  profile?: string;
  browserKind?: BrowserKind;
  geo?: GeoPoint;
  browser: ScrapeBrowser;
  /** Needed unless `noNav`. */
  navigator?: NavigatorDeps | null;
  llm: LlmBackend;
  /** Write the new file. Returns its path. */
  save: (spec: ScraperSpec) => string | Promise<string>;
  log: Logger;
  signal?: AbortSignal;
  now?: () => number;
  /** The wait for a table or a card group to show after the page loads. Default 8000 (JEV_SCRAPE_STEP_MS). */
  stepTimeoutMs?: number;
  llmTimeoutMs?: number;
  contextChars?: number;
  secrets?: string[];
  load?: (page: Page, opts: LoadOptions) => Promise<LoadReport>;
  sleep?: (ms: number) => Promise<void>;
}

const errText = (e: unknown): string => String((e as Error)?.message ?? e);
/** The rows and records of a read. */
const setSize = (r: PageRead): number => r.tables.reduce((n, t) => n + t.row_count, 0) + r.groups.reduce((n, g) => n + g.count, 0);
const realSleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * Why a scraper of this task and these params cannot be saved, or null. A scraper file never holds a secret: a param
 * whose name is a secret (password, pin, otp) and a secret value in the task (the value after "password") are refused.
 * The text never holds the secret value.
 */
export function secretProblem(task: string, params: Record<string, string>): string | null {
  const secrets = Object.keys(params).filter((k) => secretKey(k));
  if (secrets.length > 0) return `params ${secrets.join(", ")} name secrets. A scraper file never holds a secret: leave them out`;
  if (extractSpans(task).some((x) => x.secret)) return "the task holds a secret value (after a word such as password, pin, or otp). A scraper file never holds a secret: leave it out, and sign in once in the Chrome profile";
  return null;
}

/**
 * Author a scraper. Never throws for a site problem: the result says ok, blocked, or failed. Throws SpecError for a
 * secret (secretProblem) before it opens a page.
 */
export async function authorScraper(o: AuthorOptions): Promise<{ result: ScrapeResult; spec: ScraperSpec | null }> {
  const secret = secretProblem(o.task, o.params);
  if (secret) throw new SpecError(secret);
  const now = o.now ?? (() => Date.now());
  const t0 = now();
  const stats: ScrapeResult["stats"] = { duration_ms: 0, jev_requests: 0, llm_calls: 0, steps: 0, scrolls: 0 };
  const result: ScrapeResult = { scraper: o.name, version: 1, params: shownParams(o.params), url: null, rows: [], row_count: 0, status: "failed", healed: null, reason: null, blocked: null, saved: null, stats };
  const done = (patch: Partial<ScrapeResult>, spec: ScraperSpec | null = null): { result: ScrapeResult; spec: ScraperSpec | null } => {
    Object.assign(result, patch);
    result.row_count = result.rows.length;
    stats.duration_ms = now() - t0;
    return { result, spec };
  };
  const spans = varSpans(o.params);
  const redactor = (s: string): string => redact(s, spans);

  let page: Page;
  try { page = await o.browser.page(); } catch (e) { return done({ reason: `browser: ${errText(e)}` }); }

  let steps: Step[] = [];
  let startUrl: string;
  if (!o.noNav) {
    if (!o.navigator) return done({ reason: "Jev navigation needs TYPESAFE_API_KEY; or pass --no-nav with --url" });
    const nav = await navigate({
      task: o.task, url: o.url ? fillUrl(o.url, o.params) : null, ...(o.url ? { urlTemplate: o.url } : {}), params: o.params, profile: o.profile, page, browser: o.browser, nav: o.navigator,
      headed: o.headed, log: o.log, ...(o.maxSteps !== undefined ? { maxSteps: o.maxSteps } : {}), ...(o.signal ? { signal: o.signal } : {}),
    }).catch((e: unknown) => ({ status: "failed" as const, reason: `jev: ${errText(e)}`, jev: 0 }));
    stats.jev_requests += nav.jev;
    if (nav.status === "blocked") return done({ status: "blocked", reason: nav.reason, blocked: { kind: nav.wall, hint: wallHint(nav.wall) } });
    if (nav.status === "failed") return done({ reason: `navigation: ${nav.reason}` });
    steps = nav.steps;
    stats.steps = steps.length;
    // Jev's start URL holds the filled values (a URL of the task, a search URL): a value in it becomes its {param}.
    const url = o.url ?? (nav.url ? urlTemplate(nav.url, o.params) : null);
    if (!url) return done({ reason: "navigation: no start URL; pass --url" });
    startUrl = url;
  } else {
    if (!o.url) return done({ reason: "--no-nav needs --url" });
    startUrl = o.url;
    try { await page.navigate(fillUrl(o.url, o.params), LIMITS.openTimeoutMs); } catch (e) { return done({ reason: `open: ${errText(e)}` }); }
  }
  // A param of the task that no step and no start URL uses: a run with another value reads the same page.
  const bound = boundParams(startUrl, steps);
  const unbound = placeholders(o.task).filter((p) => !bound.has(p));
  if (unbound.length > 0) {
    o.log.warn(`no step and no start URL sets ${unbound.map((p) => `{${p}}`).join(", ")}: a run with another value reads the same page. Run new again with a value that the start page does not show, or pass --url with the {param} in it`);
  }
  if (!page.read) return done({ reason: "read: this page cannot be read" });
  let read;
  try {
    // A page can render its table or cards after the load: read again until one shows, at most the step timeout.
    const deadline = now() + (o.stepTimeoutMs ?? STEP_MS);
    read = await page.read({ text: true, limits: ROWS_READ });
    while (read.tables.length === 0 && read.groups.length === 0 && now() < deadline && !o.signal?.aborted) {
      await (o.sleep ?? realSleep)(READ_POLL_MS);
      read = await page.read({ text: true, limits: ROWS_READ });
    }
    // A shop renders its cards in parts: read again until the sets stop growing.
    while (now() < deadline && !o.signal?.aborted && (read.tables.length > 0 || read.groups.length > 0)) {
      await (o.sleep ?? realSleep)(READ_POLL_MS);
      const again = await page.read({ text: true, limits: ROWS_READ });
      if (setSize(again) <= setSize(read)) break;
      read = again;
    }
  } catch (e) { return done({ reason: `read: ${errText(e)}` }); }

  const draft = await draftFromLlm({
    llm: o.llm, read, page, want: o.want, task: fillTemplate(o.task, o.params), params: o.params, ctx: { params: o.params },
    maxCalls: AUTHOR_CALLS, timeoutMs: o.llmTimeoutMs ?? LLM_TIMEOUT_MS, contextChars: o.contextChars ?? CONTEXT_CHARS,
    validateFor: (rows: Row[], d, fields) => mergeValidate(defaultValidate(rows, fields), d.validate, fields),
    extraCheck: (rows, fields) => rows.length === 0 ? [] : fields.filter((f) => rows.every((r) => (r[f] ?? null) === null)).map((f) => `field ${f} is null in every row`),
    load: o.load ?? ((p, lo) => loadAll(p, lo, o.sleep)), redact: redactor, secrets: o.secrets ?? [], log: o.log, ...(o.signal ? { signal: o.signal } : {}),
  });
  stats.llm_calls += draft.calls;
  if (!draft.ok) return done({ url: read.url, reason: `extract: ${draft.problem}` });
  const r = draft.result;
  stats.scrolls += r.scrolls;
  const at = new Date(now()).toISOString();
  let spec: ScraperSpec;
  try {
    spec = parseScraper({
      kind: "jev-scraper", format: 1, name: o.name, version: 1, created_at: at, updated_at: at,
      task: o.task, want: o.want, params: o.params, ...(o.browserKind ? { browser: o.browserKind } : {}), ...(o.profile ? { profile: o.profile } : {}), ...(o.geo ? { geo: o.geo } : {}),
      start_url: startUrl, steps, load: r.load, extract: r.extract, validate: r.validate,
      fingerprint: fingerprintOf(r.extract, r.read, r.outcome.set ?? "", r.outcome.rows),
      history: [{ at, level: "author", reason: "jev-scrape new", from_version: 0, previous: null }],
    });
  } catch (e) {
    return done({ url: r.read.url, reason: `the new scraper is not valid: ${errText(e)}` });
  }
  let saved: string;
  try { saved = await o.save(spec); } catch (e) { return done({ url: r.read.url, rows: r.outcome.rows, reason: `save: ${errText(e)}` }, spec); }
  o.log.info(`new scraper ${o.name}: ${r.outcome.rows.length} rows from ${r.outcome.set}, saved to ${saved}`);
  return done({ status: "ok", url: r.read.url, rows: r.outcome.rows, saved }, spec);
}
