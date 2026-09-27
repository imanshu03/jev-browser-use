// The parts of the heal ladder that a run and `jev-scrape new` share: the new version of a spec with its history entry,
// L2 Jev navigation with the fast runner, and the LLM draft loop of L3 (and of authoring).
import { FastRunner } from "../fast/loop.js";
import type { Action, Page } from "../fast/model.js";
import type { LoadOptions, LoadReport } from "../fast/read.js";
import type { PageRead } from "../fast/read-types.js";
import type { Logger } from "../io.js";
import type { RunConfig } from "../types.js";
import { DEFAULT_PROFILE_NAME, LIMITS } from "../types.js";
import type { ExtractContext, ExtractOutcome } from "./extract.js";
import { buildExtract, extractRows, fieldNames, fieldTypes } from "./extract.js";
import type { LlmBackend } from "./llm.js";
import { SYSTEM_PROMPT, buildContext, feedbackText, parseAnswer, userMessage } from "./prompt.js";
import { beforeRepeat, boundParams, startSelectSteps, stepsFromRecords } from "./record.js";
import type { Wall } from "./replay.js";
import type { NavigatorDeps, ScrapeBrowser } from "./runner.js";
import type { Extract, ExtractDraft, HealLevel, LoadRule, Row, ScraperSpec, SpecBody, Step, Validate } from "./spec.js";
import { HISTORY_MAX, LOAD_DEFAULTS, SpecError, fillTemplate, parseScraper } from "./spec.js";
import type { Validation } from "./validate.js";
import { validateRows } from "./validate.js";

/** The limits of a read that gives rows: every row of a long table. */
export const ROWS_READ = { rows: 5000 } as const;

/** The loader options of a load rule. */
export function loadOptions(rule: LoadRule): LoadOptions {
  return {
    maxScrolls: rule.max_scrolls ?? LOAD_DEFAULTS.max_scrolls,
    stableRounds: rule.stable_rounds ?? LOAD_DEFAULTS.stable_rounds,
    pauseMs: rule.pause_ms ?? LOAD_DEFAULTS.pause_ms,
    maxMs: rule.max_ms ?? LOAD_DEFAULTS.max_ms,
  };
}

/** The parts of a spec that a heal can change. */
export function bodyOf(spec: ScraperSpec): SpecBody {
  return { start_url: spec.start_url, steps: spec.steps, load: spec.load, extract: spec.extract, validate: spec.validate, fingerprint: spec.fingerprint };
}

/**
 * The spec after a heal: version + 1, `updated_at` now, the changed body parts, and a history entry that keeps the old
 * body (the oldest entries go above HISTORY_MAX). Checked with parseScraper.
 */
export function nextSpec(spec: ScraperSpec, level: HealLevel, reason: string, changes: Partial<SpecBody>, at: string): ScraperSpec {
  const entry = { at, level, reason: reason.slice(0, 300), from_version: spec.version, previous: bodyOf(spec) };
  return parseScraper({
    ...spec, ...changes,
    version: spec.version + 1,
    updated_at: at,
    history: [...spec.history, entry].slice(-HISTORY_MAX),
  });
}

export type NavOutcome =
  /** `stalled`: Jev did not say done, but its run moved no further (see STALLED); the steps stop before the first repeat. */
  | { status: "done"; steps: Step[]; skipped: string[]; jev: number; url: string | null; stalled?: boolean }
  | { status: "blocked"; wall: Wall; reason: string; jev: number }
  /** `steps`: the steps of the actions that ran (select steps first). Jev can have passed the page of the rows. */
  | { status: "failed"; reason: string; jev: number; steps?: Step[] };

/**
 * The blocks of an act run that only say that Jev stopped moving: it saw no page change, or it used all its steps.
 * The steps before the first repeat can already reach the rows. The runner replays them as it does the steps of a run
 * that failed (prefix trials): the page that Jev left can be after later steps, and a form can show its default month
 * before its submit.
 */
const STALLED = new Set(["loop_detected", "max_steps"]);

/**
 * L2 (and `jev-scrape new`): Jev reaches the page of the rows from the start URL on the scraper's own tab, as one act
 * run with the params as vars. Its step records become the new steps. The tab and Chrome stay open (keepOpen).
 * `urlTemplate`: the start URL with its `{param}` placeholders; a param that it or a step uses needs no select step.
 */
export async function navigate(a: {
  task: string; url: string | null; urlTemplate?: string; params: Record<string, string>; profile: string | undefined; maxSteps?: number;
  page: Page; browser: ScrapeBrowser; nav: NavigatorDeps; headed: boolean; log: Logger; signal?: AbortSignal;
}): Promise<NavOutcome> {
  // The selects of the start page, before Jev acts: a param that one of them already shows gets a select step.
  let selects: Action[] = [];
  if (a.url && Object.keys(a.params).length > 0) {
    try {
      await a.page.navigate(a.url, LIMITS.openTimeoutMs);
      selects = (await a.page.observe()).actions.filter((x) => x.kind === "select");
    } catch (e) {
      a.log.debug(`start page selects: ${(e as Error)?.message ?? String(e)}`);
    }
  }
  const want = a.profile ?? DEFAULT_PROFILE_NAME;
  const known = a.nav.profiles.some((p) => p.name.toLowerCase() === want.toLowerCase() || p.directory.toLowerCase() === want.toLowerCase());
  // The browser is already open on the scraper's profile. A profile that the list does not name must not stop the plan.
  const cfg: RunConfig = {
    ...a.nav.base, task: fillTemplate(a.task, a.params), goal: "act", vars: { ...a.params }, keepOpen: true, headed: a.headed,
    profile: known ? want : "none", ...(a.url ? { url: a.url } : {}), ...(a.maxSteps !== undefined ? { maxSteps: a.maxSteps } : {}),
  };
  const runner = new FastRunner({
    cfg, profiles: a.nav.profiles, chrome: () => a.browser.chrome(), page: a.page, openPage: async () => a.page,
    oracle: a.nav.oracle, human: a.nav.human, log: a.log,
    ...(a.nav.warm ? { warm: a.nav.warm } : {}), ...(a.nav.text ? { text: a.nav.text } : {}), ...(a.signal ? { signal: a.signal } : {}),
  });
  const before = a.nav.oracle.stats.requests;
  const r = await runner.run();
  // The oracle can serve more than one run: count only this run's requests.
  const jev = a.nav.oracle.stats.requests - before;
  if (r.outcome === "blocked" && (r.blocked?.kind === "needs_sign_in" || r.blocked?.kind === "captcha")) {
    return { status: "blocked", wall: r.blocked.kind === "captcha" ? "captcha" : "sign_in", reason: r.reason || r.blocked.hint, jev };
  }
  const stalled = r.outcome === "blocked" && STALLED.has(r.blocked?.kind ?? "") && r.steps.some((x) => x.result === "ok");
  const rec = stepsFromRecords(r.steps, a.params);
  for (const s of rec.skipped) a.log.debug(`L2 record not replayed: ${s}`);
  const recorded = stalled ? beforeRepeat(rec.steps) : rec.steps;
  if (stalled) a.log.warn(`jev stopped (${r.blocked?.kind}) without done; the kept steps are replayed and judged by the extraction. Steps kept: ${recorded.length} of ${rec.steps.length}`);
  const first = startSelectSteps(selects, a.params, boundParams(a.urlTemplate ?? "", recorded));
  for (const x of first) a.log.info(`select step added for ${x.op === "select" ? x.value : ""}: the start page shows that value already`);
  const steps = [...first, ...recorded].slice(0, 40);
  if (r.outcome === "done" || stalled) return { status: "done", steps, skipped: rec.skipped, jev, url: r.start?.url ?? null, ...(stalled ? { stalled } : {}) };
  return { status: "failed", reason: `jev ${r.outcome}: ${r.reason || "no reason"}`, jev, ...(steps.length > 0 ? { steps } : {}) };
}

/**
 * The shortest prefix of `steps` that holds every step that uses a param of `need` (a param of the task that the start
 * URL does not use). A path that does not type the query cannot give the rows of the query. Returns the length of that
 * prefix (at least 1), or null when no step uses one of the params, when `need` is empty, or when there is no step.
 * With no param, no step is a proof of the page: a part of the path can end on a page with cards of the same template.
 */
export function minPrefix(steps: readonly Step[], need: readonly string[]): number | null {
  if (steps.length === 0 || need.length === 0) return null;
  let k = 1;
  for (const p of need) {
    const i = steps.findIndex((s) => boundParams("", [s]).has(p));
    if (i < 0) return null;
    k = Math.max(k, i + 1);
  }
  return k;
}

/** The JSON type of each row field of a scraper (fieldTypes). */
export type FieldTypes = Record<string, "string" | "number" | "boolean">;

/**
 * The problems of a heal draft whose rows have other fields than the scraper's rows: a field that is missing or new, or
 * a field of another type. A const null field fits any type. A heal must not change the columns that the users of the
 * rows read. Code text only: field names and types.
 */
export function shapeProblems(keep: FieldTypes, extract: Extract): string[] {
  const now = fieldTypes(extract);
  const out: string[] = [];
  for (const [name, type] of Object.entries(keep)) {
    const f = extract.fields[name];
    if (!(name in now)) out.push(`field ${name} is missing: keep every field of the scraper`);
    else if (now[name] !== type && !(f?.from === "const" && f.value === null)) out.push(`field ${name} is a ${now[name]}; the scraper gives a ${type}`);
  }
  for (const name of Object.keys(now)) if (!(name in keep)) out.push(`field ${name} is not a field of the scraper`);
  return out;
}

export interface DraftResult {
  draft: ExtractDraft;
  extract: Extract;
  outcome: ExtractOutcome;
  /** The read that gave the rows: after the load when the draft says scroll. */
  read: PageRead;
  validate: Validate;
  load: LoadRule;
  scrolls: number;
}

export interface DraftLoop {
  llm: LlmBackend;
  /** The read of the page (text blocks included): the context and the set ids come from it. */
  read: PageRead;
  page: Page;
  want: string;
  task: string;
  params: Record<string, string>;
  ctx: ExtractContext;
  maxCalls: number;
  timeoutMs: number;
  contextChars: number;
  /** The validate section that the draft's rows must pass. */
  validateFor: (rows: Row[], draft: ExtractDraft, fields: string[]) => Validate;
  /** A heal: the draft must give these fields with these types (shapeProblems). The prompt names them. */
  keep?: FieldTypes;
  /** More problems of the rows (authoring: a field that is null in every row). */
  extraCheck?: (rows: Row[], fields: string[]) => string[];
  /** Load more records when a draft says scroll. */
  load: (page: Page, opts: LoadOptions) => Promise<LoadReport>;
  redact?: (s: string) => string;
  secrets?: (string | null | undefined)[];
  log: Logger;
  signal?: AbortSignal;
}

/**
 * Ask the LLM for an extract draft, at most `maxCalls` times. Each answer is parsed (JSON only), built on the read,
 * tested on the page, and validated. A later call gets the problems of the answer before it, as code text only.
 */
export async function draftFromLlm(o: DraftLoop): Promise<{ ok: true; result: DraftResult; calls: number } | { ok: false; problem: string; calls: number }> {
  const context = buildContext(o.read, o.want || o.task, o.contextChars, { ...(o.redact ? { redact: o.redact } : {}), ...(o.secrets ? { secrets: o.secrets } : {}) });
  let feedback: string | undefined;
  let last = "the LLM gave no answer";
  let calls = 0;
  for (let i = 0; i < o.maxCalls; i++) {
    if (o.signal?.aborted) { last = "aborted"; break; }
    calls += 1;
    let text: string;
    try {
      const user = userMessage({ want: o.want, task: o.task, params: o.params, context, ...(o.keep ? { fields: o.keep } : {}), ...(feedback ? { problems: feedback } : {}) });
      const reply = await o.llm.complete({ system: SYSTEM_PROMPT, user, timeoutMs: o.timeoutMs, ...(o.signal ? { signal: o.signal } : {}) });
      text = reply.text;
      o.log.info(`llm ${o.llm.name}: answer ${calls} in ${reply.ms} ms`);
    } catch (e) {
      last = `the LLM call failed: ${(e as Error)?.message ?? String(e)}`;
      o.log.warn(last);
      continue;
    }
    let draft: ExtractDraft;
    let extract: Extract;
    try {
      draft = parseAnswer(text);
      extract = buildExtract(draft, o.read);
    } catch (e) {
      const lines = String((e as Error)?.message ?? e).split("\n");
      last = `the answer is not a usable draft: ${lines[0] ?? ""}`;
      if (!(e instanceof SpecError)) throw e;
      feedback = feedbackText(lines);
      o.log.warn(`llm answer ${calls}: ${feedback}`);
      continue;
    }
    const shape = o.keep ? shapeProblems(o.keep, extract) : [];
    if (shape.length > 0) {
      last = `the draft did not pass: ${shape[0] ?? ""}`;
      feedback = feedbackText(shape);
      o.log.warn(`llm answer ${calls}: ${feedback}`);
      continue;
    }
    let read = o.read;
    let scrolls = 0;
    const load: LoadRule = draft.load === "scroll" ? { mode: "scroll" } : { mode: "none" };
    if (draft.load === "scroll") {
      const report = await o.load(o.page, loadOptions(load)).catch((e: unknown) => { o.log.warn(`load: ${(e as Error)?.message ?? String(e)}`); return null; });
      scrolls = report?.scrolls ?? 0;
      if (o.page.read) read = await o.page.read({ text: false, limits: ROWS_READ });
    }
    const outcome = extractRows(read, extract, { ...o.ctx, url: read.url });
    const fields = fieldNames(extract);
    const validate = o.validateFor(outcome.rows, draft, fields);
    const v: Validation = outcome.set === null ? { ok: false, problems: outcome.problems } : validateRows(outcome.rows, validate);
    const extra = o.extraCheck?.(outcome.rows, fields) ?? [];
    if (v.ok && extra.length === 0) return { ok: true, result: { draft, extract, outcome, read, validate, load, scrolls }, calls };
    const all = [...v.problems, ...extra, ...outcome.problems.filter((p) => !v.problems.includes(p))];
    last = `the draft did not pass: ${all[0] ?? "no rows"}`;
    feedback = feedbackText([`set ${draft.set} gave ${outcome.rows.length} rows`, ...all]);
    o.log.warn(`llm answer ${calls}: ${feedback}`);
  }
  return { ok: false, problem: last, calls };
}

/**
 * The prefix lengths that L2 tries on the steps of a Jev run that did not end done, in order, at most `max`. First the
 * shortest prefix with every param step plus the next step when it is a click or a key (a form needs its submit: with
 * the selects alone, only the default values give rows); then that prefix without the submit (a search that shows
 * results as the user types); then the longer ones.
 */
export function prefixOrder(steps: readonly Step[], need: readonly string[], max: number): number[] {
  const k = minPrefix(steps, need);
  if (k === null) return [];
  const next = steps[k];
  const order = next && (next.op === "click" || next.op === "press") ? [k + 1, k] : [k];
  for (let n = k + 1; n <= steps.length; n++) if (!order.includes(n)) order.push(n);
  return order.slice(0, max);
}
