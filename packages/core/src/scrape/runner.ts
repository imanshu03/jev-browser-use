// One run of a scraper: open start_url, replay the steps with the fast engine's Page (no Jev), load, read, extract,
// validate. When a check fails, heal: L1 code re-anchor, L2 Jev navigation, L3 LLM rebuild; then save the new version.
//
// The exported names ScrapeBrowser, NavigatorDeps, RunScraperOptions, and runScraper are a contract of the scrape kit
// (see /tmp/jevscrape/build/SPEC.md, section C7). The MCP tools call runScraper with their own ScrapeBrowser (the MCP
// BrowserSession) and heal "code" or "none".
import type { ProfileEntry } from "../browser.js";
import type { Chrome, Page } from "../fast/model.js";
import type { LoadOptions, LoadReport } from "../fast/read.js";
import { loadAll } from "../fast/read.js";
import type { PageRead } from "../fast/read-types.js";
import type { Human, Logger, TextSource } from "../io.js";
import type { Oracle } from "../jev.js";
import { redact, varSpans } from "../task.js";
import type { RunConfig } from "../types.js";
import { LIMITS, secretKey } from "../types.js";
import type { ExtractContext, ExtractOutcome } from "./extract.js";
import { extractRows, fieldNames, fieldTypes, fingerprintOf } from "./extract.js";
import { ROWS_READ, draftFromLlm, loadOptions, navigate, nextSpec, prefixOrder } from "./heal.js";
import type { LlmBackend } from "./llm.js";
import { LLM_TIMEOUT_MS } from "./llm.js";
import { bestCandidate, reanchor } from "./match.js";
import { CONTEXT_CHARS } from "./prompt.js";
import type { Wall } from "./replay.js";
import { STEP_MS, replaySteps, wallHint, wallOf } from "./replay.js";
import type { Extract, HealMode, LoadRule, Row, ScrapeResult, ScraperSpec, SpecBody, Step, Validate } from "./spec.js";
import { SpecError, fillTemplate, fillUrl, placeholders } from "./spec.js";
import { mergeValidate, validateRows } from "./validate.js";

/** The browser of a scraper run. The CLI launches Chrome on the default profile; the MCP server uses its session. */
export interface ScrapeBrowser {
  /** The tab of the run: opened on the first call, the same tab on later calls. */
  page(): Promise<Page>;
  /** The Chrome of that tab. L2 gives it to a FastRunner. */
  chrome(): Promise<Chrome>;
  /** The CLI closes Chrome here; the MCP server keeps it open. Idempotent. */
  close(): Promise<void>;
}

/** What L2 needs to run Jev: the fast runner's dependencies other than the browser. Absent: L2 is skipped. */
export interface NavigatorDeps {
  oracle: Oracle;
  human: Human;
  profiles: ProfileEntry[];
  /** The RunConfig to start from (model, timeouts, confirm); the runner sets task, url, goal "act", vars, keepOpen. */
  base: RunConfig;
  warm?: () => Promise<void>;
  text?: TextSource;
}

export interface RunScraperOptions {
  /** Overrides of the param defaults. */
  params?: Record<string, string>;
  heal: HealMode;
  browser: ScrapeBrowser;
  navigator?: NavigatorDeps;
  llm?: LlmBackend | null;
  /** Save a healed spec. Absent: the heal is not saved (result.saved stays null). Returns the path. */
  save?: (spec: ScraperSpec) => string | Promise<string>;
  /** Pauses at a sign-in wall or a captcha during replay when it is interactive and the run is headed. */
  human?: Human;
  headed: boolean;
  log: Logger;
  signal?: AbortSignal;
  now?: () => number;
  /** A step waits this long for its control. Default 8000 (the CLI reads JEV_SCRAPE_STEP_MS). */
  stepTimeoutMs?: number;
  /** One LLM call may take this long. Default 180000 (the CLI reads JEV_SCRAPE_LLM_TIMEOUT_MS). */
  llmTimeoutMs?: number;
  /** The size of the LLM page context. Default 48000 (the CLI reads JEV_SCRAPE_CONTEXT_CHARS). */
  contextChars?: number;
  /** Values that never go to a model, such as the API keys of the environment. */
  secrets?: string[];
  /** The loader. Default loadAll of src/fast/read.ts. */
  load?: (page: Page, opts: LoadOptions) => Promise<LoadReport>;
  /** Sleep between polls and scrolls. Tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * A start URL may be a file: URL. Absent: only http and https. The CLI sets it (the files are the user's own); the MCP
   * server sets it from JEV_MCP_ALLOW_FILE, as browse does.
   */
  allowFile?: boolean;
}

/** LLM calls of one L3 heal. */
export const L3_CALLS = 2;
/** The interval of the reads that wait for the rows after the steps. */
export const READ_POLL_MS = 500;
/** L2 replays at most this many prefixes of the steps of a Jev run that did not end done. */
export const PREFIX_TRIES = 6;
/** A prefix trial waits this long for the rows. */
export const PREFIX_WAIT_MS = 3_000;

const realSleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** The params of a result: a secret param as "***". */
export function shownParams(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, secretKey(k) ? "***" : v]));
}

/** The params of a run: the defaults with the overrides. An unknown name is a SpecError. */
export function runParams(spec: ScraperSpec, over: Record<string, string> = {}): Record<string, string> {
  const unknown = Object.keys(over).filter((k) => !(k in spec.params));
  if (unknown.length > 0) throw new SpecError(`${unknown.map((k) => `--param ${k}`).join(", ")}: not a param of ${spec.name}. Params: ${Object.keys(spec.params).join(", ") || "none"}`);
  const params = { ...spec.params, ...over };
  const used = new Set([spec.start_url, ...spec.steps.flatMap((s) => [
    ..."target" in s ? [s.target.name] : [], ...(s.op === "fill" || s.op === "select" ? [s.value] : []), ...(s.op === "wait" && s.for_text ? [s.for_text] : []),
  ])].flatMap(placeholders));
  for (const name of used) if (!params[name]?.trim()) throw new SpecError(`{${name}} has no value: pass --param ${name}=<value>`);
  return params;
}

interface Got { ok: boolean; reason: string; read: PageRead | null; outcome: ExtractOutcome | null; rows: Row[] }

const errText = (e: unknown): string => String((e as Error)?.message ?? e);

/**
 * Run a scraper. Never throws for a site problem: the result says ok, blocked, or failed. Throws SpecError for a param
 * that is not valid, and for a start URL that is not http or https with the params (file: only with allowFile).
 */
export async function runScraper(spec: ScraperSpec, opts: RunScraperOptions): Promise<ScrapeResult> {
  const now = opts.now ?? (() => Date.now());
  const t0 = now();
  const log = opts.log;
  const params = runParams(spec, opts.params);
  // The params of a run can come from a model (the MCP scraper run): the page that they open must be a web page.
  let scheme = "";
  try { scheme = new URL(fillUrl(spec.start_url, params)).protocol; } catch { throw new SpecError("the start URL is not an absolute URL with these params"); }
  if (scheme !== "http:" && scheme !== "https:" && !(scheme === "file:" && opts.allowFile === true)) {
    throw new SpecError(`the start URL uses ${scheme} with these params. Use an http or https URL`);
  }
  const stats: ScrapeResult["stats"] = { duration_ms: 0, jev_requests: 0, llm_calls: 0, steps: 0, scrolls: 0 };
  const result: ScrapeResult = { scraper: spec.name, version: spec.version, params: shownParams(params), url: null, rows: [], row_count: 0, status: "failed", healed: null, reason: null, blocked: null, saved: null, stats };
  // Secret params (a key such as pin_code aside) never go to the LLM or the log.
  const spans = varSpans(params);
  const redactor = (s: string): string => redact(s, spans);
  const sleep = opts.sleep ?? realSleep;
  const load = opts.load ?? ((page: Page, o: LoadOptions) => loadAll(page, o, opts.sleep));
  const ctx: ExtractContext = { params };

  let page: Page;
  const finish = async (patch: Partial<ScrapeResult>): Promise<ScrapeResult> => {
    Object.assign(result, patch);
    result.row_count = result.rows.length;
    if (result.url === null && page) result.url = await page.url().catch(() => null);
    stats.duration_ms = now() - t0;
    log.info(`scrape ${spec.name} v${result.version}: ${result.status}${result.healed ? ` (healed ${result.healed.level})` : ""} rows=${result.row_count} steps=${stats.steps} jev=${stats.jev_requests} llm=${stats.llm_calls} ${stats.duration_ms}ms${result.reason ? ` reason: ${redactor(result.reason)}` : ""}`);
    return result;
  };
  const blocked = (wall: Wall, reason: string): Promise<ScrapeResult> => finish({ status: "blocked", reason, blocked: { kind: wall, hint: wallHint(wall) } });
  try { page = await opts.browser.page(); } catch (e) { return finish({ reason: `browser: ${errText(e)}` }); }

  /** Read, extract, and validate the page as it is now. */
  const readOnce = async (body: { extract: SpecBody["extract"]; validate: Validate }): Promise<Got> => {
    try {
      if (!page.read) return { ok: false, reason: "read: this page cannot be read", read: null, outcome: null, rows: [] };
      const read = await page.read({ text: false, limits: ROWS_READ });
      const outcome = extractRows(read, body.extract, { ...ctx, url: read.url });
      if (outcome.set === null) return { ok: false, reason: `extract: ${outcome.problems[0] ?? "no set matches"}`, read, outcome, rows: [] };
      const v = validateRows(outcome.rows, body.validate);
      if (!v.ok) return { ok: false, reason: `validate: ${v.problems[0] ?? "the rows do not pass"}`, read, outcome, rows: outcome.rows };
      return { ok: true, reason: "", read, outcome, rows: outcome.rows };
    } catch (e) {
      return { ok: false, reason: `read: ${errText(e)}`, read: null, outcome: null, rows: [] };
    }
  };
  /**
   * Load when the rule says scroll, then read until the rows pass, at most the step timeout: a search can render its
   * results after the last step. Only then is a failure a failure.
   */
  const extractOn = async (body: { load: LoadRule; extract: SpecBody["extract"]; validate: Validate }, waitMs = opts.stepTimeoutMs ?? STEP_MS): Promise<Got> => {
    if (body.load.mode === "scroll") {
      const report = await load(page, loadOptions(body.load)).catch((e: unknown) => { log.warn(`load: ${errText(e)}`); return null; });
      stats.scrolls += report?.scrolls ?? 0;
    }
    const deadline = now() + waitMs;
    for (;;) {
      const got = await readOnce(body);
      if (got.ok) return settled(body, got, deadline);
      if (!page.read || now() >= deadline || opts.signal?.aborted) return got;
      await sleep(READ_POLL_MS);
    }
  };
  /**
   * Rows that pass can still be a part of the page: a shop renders its cards in parts. Read again until the row count
   * stops growing, at most until the deadline, and keep the read with the most rows.
   */
  const settled = async (body: { extract: SpecBody["extract"]; validate: Validate }, got: Got, deadline: number): Promise<Got> => {
    let best = got;
    while (now() < deadline && !opts.signal?.aborted) {
      await sleep(READ_POLL_MS);
      const again = await readOnce(body);
      if (!again.ok || again.rows.length <= best.rows.length) break;
      best = again;
    }
    return best;
  };
  /** Open the start URL and replay the steps. */
  const replay = async (steps: readonly Step[]): Promise<{ ok: boolean; reason: string; wall: Wall | null }> => {
    try {
      await page.navigate(fillUrl(spec.start_url, params), LIMITS.openTimeoutMs);
      const r = await replaySteps(page, steps, params, {
        log, stepTimeoutMs: opts.stepTimeoutMs ?? STEP_MS, headed: opts.headed, name: spec.name,
        ...(opts.human ? { human: opts.human } : {}), ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}), ...(opts.now ? { now: opts.now } : {}),
      });
      stats.steps = r.ok ? r.steps : r.step;
      return r.ok ? { ok: true, reason: "", wall: null } : { ok: false, reason: r.reason, wall: r.wall };
    } catch (e) {
      return { ok: false, reason: `open: ${errText(e)}`, wall: null };
    }
  };
  /** A wall on the page now, code only. */
  const wallNow = async (): Promise<Wall | null> => {
    try { return wallOf(await page.observe()); } catch { return null; }
  };
  const at = (): string => new Date(now()).toISOString();
  /** Save a healed spec and give the result of its rows. */
  const healed = async (level: "L1" | "L2" | "L3", reason: string, changes: Partial<SpecBody>, rows: Row[], url: string): Promise<ScrapeResult> => {
    const next = nextSpec(spec, level, reason, changes, at());
    let saved: string | null = null;
    let note: string | null = null;
    if (opts.save) {
      try { saved = await opts.save(next); } catch (e) { note = `the healed scraper was not saved: ${errText(e)}`; log.warn(note); }
    }
    log.info(`healed ${spec.name} at ${level}: version ${next.version}${saved ? ` saved to ${saved}` : ""}`);
    return finish({ status: "ok", rows, url, version: next.version, healed: { level, reason }, saved, reason: note });
  };

  // The plain path: no Jev and no LLM.
  const first = await replay(spec.steps);
  if (first.wall) return blocked(first.wall, first.reason);
  let got: Got | null = null;
  let reason = first.reason;
  if (first.ok) {
    got = await extractOn(spec);
    if (got.ok && got.read) return finish({ status: "ok", rows: got.rows, url: got.read.url });
    reason = got.reason;
  }
  const wall = await wallNow();
  if (wall) return blocked(wall, reason);
  if (opts.heal === "none") return finish({ reason });

  const problems: string[] = [];
  const failed = (): Promise<ScrapeResult> => finish({ reason: problems.length > 0 ? `${reason}; ${problems[problems.length - 1]}` : reason });
  const aborted = (): boolean => opts.signal?.aborted === true;

  // L1: code re-anchor on the page that the steps reached.
  if (first.ok && got?.read) {
    const l1 = reanchor(got.read, spec, { ...ctx, url: got.read.url });
    if (l1) return healed("L1", reason, { extract: l1.extract, fingerprint: fingerprintOf(l1.extract, got.read, l1.set, l1.outcome.rows) }, l1.outcome.rows, got.read.url);
    problems.push(`L1: no set of the page fits the fingerprint (best score ${bestCandidate(got.read, spec, params).toFixed(2)})`);
  }
  if (opts.heal === "code" || aborted()) return failed();

  /**
   * L2 after a Jev run that did not end done (it failed, or it stalled): replay prefixes of its steps in the order of
   * prefixOrder (each uses every param of the task) until the rows pass with the old extract or with L1. A trial waits
   * at most PREFIX_WAIT_MS for the rows. The prefix that passes is the new path. A trial whose rows are the rows of the
   * start page did not apply the params (a form that shows the default month until its submit): it is no proof.
   */
  const byPrefix = async (all: Step[]): Promise<ScrapeResult | null> => {
    const inUrl = new Set(placeholders(spec.start_url));
    const need = placeholders(spec.task).filter((p) => !inUrl.has(p));
    const order = prefixOrder(all, need, PREFIX_TRIES);
    if (order.length === 0) {
      problems.push(need.length === 0
        ? "L2: the task has no {param} that a step of Jev must set, so no part of its steps is a proof of the page"
        : `L2: no step of Jev uses ${need.map((p) => `{${p}}`).join(", ")}`);
      return null;
    }
    const start = await startRead();
    const same = (extract: Extract, rows: Row[]): boolean =>
      start !== null && rows.length > 0 && contentOf(extract, extractRows(start, extract, { ...ctx, url: start.url }).rows) === contentOf(extract, rows);
    for (const k of order) {
      if (aborted()) break;
      const cand = all.slice(0, k);
      const r = await replay(cand);
      if (r.wall) return blocked(r.wall, `${reason}; L2: ${r.reason}`);
      if (!r.ok) { log.info(`L2: the first ${k} steps of Jev do not replay (${r.reason})`); continue; }
      const g = await extractOn(spec, Math.min(PREFIX_WAIT_MS, opts.stepTimeoutMs ?? STEP_MS));
      if (g.ok && g.read) {
        if (same(spec.extract, g.rows)) { log.info(`L2: the first ${k} steps of Jev give the rows of the start page: the params took no effect`); continue; }
        log.info(`L2: the first ${k} of ${all.length} steps of Jev give the rows`);
        return healed("L2", reason, { steps: cand, fingerprint: fingerprintOf(spec.extract, g.read, g.outcome?.set ?? "", g.rows) }, g.rows, g.read.url);
      }
      if (g.read) {
        const l1 = reanchor(g.read, spec, { ...ctx, url: g.read.url });
        if (l1 && !same(l1.extract, l1.outcome.rows)) return healed("L2", reason, { steps: cand, extract: l1.extract, fingerprint: fingerprintOf(l1.extract, g.read, l1.set, l1.outcome.rows) }, l1.outcome.rows, g.read.url);
      }
    }
    problems.push(`L2: no prefix of the ${all.length} steps of Jev gives the rows`);
    return null;
  };
  /** The read of the start page with no step, or null. */
  const startRead = async (): Promise<PageRead | null> => {
    if (!page.read || !(await replay([])).ok) return null;
    try { return await page.read({ text: false, limits: ROWS_READ }); } catch { return null; }
  };

  // L2: Jev finds the page again from the start URL.
  let onPage = first.ok;
  let steps: Step[] | null = null;
  if (opts.navigator) {
    let nav;
    try {
      nav = await navigate({
        task: spec.task, url: fillUrl(spec.start_url, params), urlTemplate: spec.start_url, params, profile: spec.profile, page, browser: opts.browser, nav: opts.navigator,
        headed: opts.headed, log, ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      nav = { status: "failed" as const, reason: `jev: ${errText(e)}`, jev: 0 };
    }
    stats.jev_requests += nav.jev;
    if (nav.status === "blocked") return blocked(nav.wall, `${reason}; L2: ${nav.reason}`);
    if (nav.status === "done" && !nav.stalled) {
      steps = nav.steps;
      onPage = true;
      const g2 = await extractOn(spec);
      if (g2.ok && g2.read) {
        return healed("L2", reason, { steps, fingerprint: fingerprintOf(spec.extract, g2.read, g2.outcome?.set ?? "", g2.rows) }, g2.rows, g2.read.url);
      }
      if (g2.read) {
        const l1 = reanchor(g2.read, spec, { ...ctx, url: g2.read.url });
        if (l1) return healed("L2", reason, { steps, extract: l1.extract, fingerprint: fingerprintOf(l1.extract, g2.read, l1.set, l1.outcome.rows) }, l1.outcome.rows, g2.read.url);
      }
      problems.push(`L2: the page that Jev reached did not give the rows (${g2.reason})`);
    } else {
      problems.push(`L2: ${nav.status === "done" ? "jev stopped moving without done" : nav.reason}`);
      // Jev did not say done, but it can have passed the page of the rows: the rows judge its steps, replayed. The page
      // that a stalled run left can be after steps that the kept steps do not hold.
      if (nav.steps && nav.steps.length > 0 && !aborted()) {
        const hit = await byPrefix(nav.steps);
        if (hit) return hit;
      }
      // Jev can have left the page of the rows. L3 reads that page only after the old steps reach it again.
      if (first.ok && !aborted()) onPage = (await replay(spec.steps)).ok;
    }
  } else problems.push("L2: skipped (no Jev navigator: set TYPESAFE_API_KEY)");
  if (aborted()) return failed();

  // L3: the LLM rebuilds the extract from the page context.
  if (opts.llm && onPage && page.read) {
    let read: PageRead;
    try { read = await page.read({ text: true, limits: ROWS_READ }); } catch (e) {
      problems.push(`L3: read: ${errText(e)}`);
      return failed();
    }
    const l3 = await draftFromLlm({
      llm: opts.llm, read, page, want: spec.want || spec.task, task: fillTemplate(spec.task, params), params, ctx,
      maxCalls: L3_CALLS, timeoutMs: opts.llmTimeoutMs ?? LLM_TIMEOUT_MS, contextChars: opts.contextChars ?? CONTEXT_CHARS,
      // A heal keeps the fields of the rows and never loosens the checks: min_rows stays at least the scraper's, and its
      // required fields stay.
      keep: fieldTypes(spec.extract),
      validateFor: (_rows, draft, fields) => {
        const v = mergeValidate(spec.validate, draft.validate, fields);
        return { ...v, min_rows: Math.max(spec.validate.min_rows, v.min_rows), required: [...new Set([...spec.validate.required, ...v.required])].filter((f) => fields.includes(f)) };
      },
      load, redact: redactor, secrets: opts.secrets ?? [], log, ...(opts.signal ? { signal: opts.signal } : {}),
    });
    stats.llm_calls += l3.calls;
    if (l3.ok) {
      const r = l3.result;
      stats.scrolls += r.scrolls;
      const set = r.outcome.set ?? "";
      const changes: Partial<SpecBody> = {
        extract: r.extract, validate: r.validate, fingerprint: fingerprintOf(r.extract, r.read, set, r.outcome.rows),
        ...(steps ? { steps } : {}), ...(r.draft.load ? { load: r.load } : {}),
      };
      // After L2 the new steps go into this version too; the level names the last rung that ran.
      return healed("L3", reason, changes, r.outcome.rows, r.read.url);
    }
    problems.push(`L3: ${l3.problem}`);
  } else if (!opts.llm) problems.push("L3: skipped (no LLM: install Claude Code, or set JEV_SCRAPE_LLM=text with JEV_TEXT_*)");
  else problems.push("L3: skipped (the steps do not reach the page of the rows)");
  return failed();
}

/**
 * The content of rows as a text to compare: the fields that read a set of the page (a column, a section, a slot, an
 * href, and the melt fields). A form value, a param, a constant, and the URL change with a select even when the rows
 * do not, so they do not count.
 */
function contentOf(extract: Extract, rows: Row[]): string {
  const names = fieldNames(extract).filter((n) => {
    const f = extract.fields[n];
    return !f || f.from === "column" || f.from === "section" || f.from === "slot" || f.from === "href";
  });
  return JSON.stringify(rows.map((r) => names.map((n) => r[n] ?? null)));
}

/** The field names of a spec's rows, in row order (the CSV header). */
export function specFields(spec: ScraperSpec): string[] {
  return fieldNames(spec.extract);
}
