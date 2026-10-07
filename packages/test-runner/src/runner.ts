// Run the selected suites: one browser session per suite, cases in file order, suites in parallel up to `workers`.
import path from "node:path";
import type { Step } from "@imanshu03/jev-browser-use";
import type { AssertResult } from "./asserts.js";
import { runAssertion } from "./asserts.js";
import type { Llm } from "./llm.js";
import type { LoadedSuite, Project } from "./load.js";
import { RecordingStore, entryKey } from "./recordings.js";
import type { Assertion, CaseDef, HealMode, StepDef } from "./schema.js";
import type { Session, SessionFactory } from "./session.js";
import { builtinVars, fillVars, resolveVars, varNames } from "./template.js";

export type CaseStatus = "passed" | "healed" | "failed" | "skipped";

export interface StepLog {
  label: string;
  how: "replay" | "recorded" | "healed" | "code" | "expect" | "jev";
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface CaseResult {
  id: string;
  title: string;
  tags: string[];
  status: CaseStatus;
  ms: number;
  error: string | null;
  steps: StepLog[];
  assertions: AssertResult[];
  /** Why each repaired step needed a repair. */
  healed: string[];
  screenshot: string | null;
  jevRequests: number;
}

export interface SuiteResult {
  suite: string;
  key: string;
  cases: CaseResult[];
  ms: number;
  /** Where changed recordings went: the recordings directory, or the report directory in CI. */
  recordingsSaved: string | null;
}

export interface RunReport {
  runId: string;
  environment: string | null;
  baseUrl: string;
  startedAt: string;
  ms: number;
  suites: SuiteResult[];
  totals: Record<CaseStatus, number> & { total: number };
}

export interface RunMode {
  ci: boolean;
  /** Record every plain-language step again, also when a recording exists. */
  record: boolean;
  heal: HealMode;
}

export type RunEvent =
  | { type: "suite_start"; suite: string; cases: number }
  | { type: "case_end"; suite: string; result: CaseResult }
  | { type: "suite_end"; result: SuiteResult };

export interface RunOptions {
  project: Project;
  suites: LoadedSuite[];
  sessions: SessionFactory;
  llm: Llm | null;
  mode: RunMode;
  workers: number;
  reportDir: string;
  runId: string;
  onEvent?: (e: RunEvent) => void;
  onLog?: (line: string) => void;
  now?: () => Date;
}

class StepFailure extends Error {
  override name = "StepFailure";
}

const MAX_FLOW_DEPTH = 5;
/** Fields that Jev and the page snapshot never see. An explicit fill types into them with code only. */
const CREDENTIAL_FIELD = /password|passcode|passphrase|\bpin\b|\botp\b|one-time|verification code|security code|2fa|mfa|totp/i;

/** The state of one case while it runs. */
interface CaseRun {
  vars: Record<string, string>;
  steps: StepLog[];
  assertions: AssertResult[];
  healed: string[];
  jevRequests: number;
  shots: string[];
}

function clickStep(def: Extract<StepDef, { click: unknown }>["click"]): Step {
  if (typeof def === "string") return { op: "click", target: { role: "button", name: def } };
  return {
    op: "click",
    target: { role: def.role ?? "button", name: def.name, ...(def.match ? { match: def.match } : {}), ...(def.nth !== undefined ? { nth: def.nth } : {}) },
    ...(def.optional ? { optional: true } : {}),
  };
}

/** A literal text for a jev step: braces doubled, so the replay does not read them as placeholders. */
function literal(s: string): string {
  return s.replace(/\{/g, "{{").replace(/\}/g, "}}");
}

export function stepLabel(def: StepDef): string {
  if (typeof def === "string") return def;
  const [k, v] = Object.entries(def)[0] as [string, unknown];
  return `${k} ${typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v)}`;
}

export function resolveUrl(baseUrl: string, target: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : `${baseUrl}/${target.replace(/^\/+/, "")}`;
}

class SuiteRunner {
  private readonly store: RecordingStore;

  constructor(private readonly o: RunOptions, private readonly suite: LoadedSuite, private readonly session: Session) {
    this.store = RecordingStore.open(path.resolve(o.project.root, o.project.config.recordings), suite.key);
  }

  get recordings(): RecordingStore {
    return this.store;
  }

  private log(line: string): void {
    this.o.onLog?.(this.o.project.secrets.redact(line));
  }

  /** Run steps in a scope. Throws StepFailure at the first step that fails. */
  async runSteps(defs: readonly StepDef[], scope: string, run: CaseRun, depth = 0): Promise<void> {
    const seen = new Map<string, number>();
    for (const def of defs) {
      const t0 = Date.now();
      const label = this.o.project.secrets.redact(typeof def === "string" ? fillVars(def, run.vars) : stepLabel(def));
      const push = (how: StepLog["how"], ok: boolean, detail?: string) => {
        run.steps.push({ label, how, ok, ms: Date.now() - t0, ...(detail ? { detail: this.o.project.secrets.redact(detail) } : {}) });
        if (!ok) throw new StepFailure(`${label}: ${this.o.project.secrets.redact(detail ?? "failed")}`);
      };
      if (typeof def === "string") {
        const n = (seen.get(def) ?? 0) + 1;
        seen.set(def, n);
        await this.plainStep(def, entryKey(scope, def, n), run, push);
        continue;
      }
      if ("goto" in def) { await this.session.goto(resolveUrl(this.o.project.env.baseUrl, fillVars(def.goto, run.vars))); push("code", true); continue; }
      if ("use" in def) {
        const flow = this.o.project.config.flows[def.use];
        if (!flow) push("code", false, `no flow named "${def.use}" in the config`);
        if (depth >= MAX_FLOW_DEPTH) push("code", false, `flows nest deeper than ${MAX_FLOW_DEPTH}`);
        await this.runSteps(flow ?? [], `flow:${def.use}`, run, depth + 1);
        continue;
      }
      if ("expect" in def) { await this.expect(Array.isArray(def.expect) ? def.expect : [def.expect], run); continue; }
      if ("screenshot" in def) {
        const file = path.join(this.o.reportDir, "screenshots", `${scope.replace(/[^A-Za-z0-9_.-]+/g, "_")}-${def.screenshot}.jpg`);
        await this.session.screenshot(file);
        run.shots.push(file);
        push("code", true);
        continue;
      }
      if ("wait" in def) { await new Promise((r) => setTimeout(r, def.wait)); push("code", true); continue; }
      if ("wait_for_text" in def) {
        const a: Assertion = { visible_text: def.wait_for_text, ...(def.timeout_ms !== undefined ? { timeout_ms: def.timeout_ms } : {}) };
        const r = await runAssertion(a, { session: this.session, vars: run.vars, llm: null, timeoutMs: this.o.project.config.timeouts.assert_ms });
        push("code", r.pass, r.pass ? undefined : `the text did not show: ${r.detail}`);
        continue;
      }
      if ("fill" in def) {
        const value = fillVars(def.fill.value, run.vars);
        if (CREDENTIAL_FIELD.test(def.fill.field) || this.o.project.secrets.redact(value) !== value) {
          const r = await this.session.fillCredential(fillVars(def.fill.field, run.vars), value);
          push("code", r.ok, r.ok ? undefined : r.reason);
          continue;
        }
      }
      let step: Step;
      if ("click" in def) step = clickStep(def.click);
      else if ("fill" in def) step = { op: "fill", target: { role: "textbox", name: def.fill.field }, value: def.fill.value };
      else if ("select" in def) step = { op: "select", target: { role: "combobox", name: def.select.field }, value: def.select.option };
      else step = { op: "press", key: def.press };
      const filled = JSON.parse(JSON.stringify(step), (_k, v: unknown) => (typeof v === "string" ? literal(fillVars(v, run.vars)) : v)) as Step;
      const r = await this.session.replay([filled], {});
      push("code", r.ok, r.ok ? undefined : r.reason);
    }
  }

  /** A plain-language step: replay its recording, or let Jev do it and record it, or repair a replay that failed. */
  private async plainStep(text: string, key: string, run: CaseRun, push: (how: StepLog["how"], ok: boolean, detail?: string) => void): Promise<void> {
    const task = fillVars(text, run.vars);
    const params = Object.fromEntries(varNames(text).map((n) => [n, run.vars[n] as string]));
    const entry = this.o.mode.record ? null : this.store.get(key, text);
    const at = (this.o.now ?? (() => new Date()))().toISOString();
    if (entry) {
      const r = await this.session.replay(entry.steps, params);
      if (r.ok) { push("replay", true); return; }
      const why = `replay failed at ${r.reason}`;
      if (this.o.mode.heal === "off") { push("replay", false, why); return; }
      this.log(`repairing "${task}": ${why}`);
      const j = await this.session.jev(task, params, "act");
      run.jevRequests += j.jevRequests;
      if (!j.ok) { push("healed", false, `${why}; Jev could not repair it: ${j.reason}`); return; }
      // The steps before the failed one already ran, so Jev went on from there: the repaired recording keeps them.
      const steps = [...entry.steps.slice(0, r.step), ...j.steps];
      this.store.put(key, { text, steps, recorded_at: at, healed: [...(entry.healed ?? []), { at, reason: why }].slice(-10) });
      run.healed.push(`${task}: ${why}`);
      push("healed", true, why);
      return;
    }
    if (this.o.mode.ci && !this.o.mode.record) {
      push("recorded", false, "this step has no recording. Run jev-test on your machine to record it, then commit the recordings directory");
      return;
    }
    const j = await this.session.jev(task, params, "act");
    run.jevRequests += j.jevRequests;
    if (!j.ok) { push("jev", false, j.reason); return; }
    this.store.put(key, { text, steps: j.steps, recorded_at: at });
    push("recorded", true, `${j.steps.length} replay step(s)`);
  }

  async expect(list: readonly Assertion[], run: CaseRun): Promise<void> {
    for (const a of list) {
      const t0 = Date.now();
      const r = await runAssertion(a, { session: this.session, vars: run.vars, llm: this.o.llm, timeoutMs: this.o.project.config.timeouts.assert_ms });
      const red = { ...r, label: this.o.project.secrets.redact(r.label), detail: this.o.project.secrets.redact(r.detail) };
      run.assertions.push(red);
      run.steps.push({ label: red.label, how: "expect", ok: r.pass, ms: Date.now() - t0, detail: red.detail });
      if (!r.pass) throw new StepFailure(`expected ${red.label}: ${red.detail}`);
    }
  }

  async runCase(c: CaseDef, base: Record<string, string>): Promise<CaseResult> {
    const t0 = Date.now();
    const def = this.suite.def;
    const result = (status: CaseStatus, error: string | null, run: CaseRun | null, screenshot: string | null = null): CaseResult => ({
      id: c.id, title: c.title, tags: [...def.tags, ...c.tags], status, ms: Date.now() - t0, error: error ? this.o.project.secrets.redact(error) : null,
      steps: run?.steps ?? [], assertions: run?.assertions ?? [], healed: run?.healed ?? [], screenshot, jevRequests: run?.jevRequests ?? 0,
    });
    if (c.skip) return result("skipped", c.skip, null);
    let run: CaseRun;
    try {
      const vars = resolveVars({ ...base, ...builtinVars((this.o.now ?? (() => new Date()))(), this.o.runId) }, c.vars);
      run = { vars, steps: [], assertions: [], healed: [], jevRequests: 0, shots: [] };
    } catch (e) {
      return result("failed", (e as Error).message, null);
    }
    let error: string | null = null;
    const body = async () => {
      if (c.start) await this.session.goto(resolveUrl(this.o.project.env.baseUrl, fillVars(c.start, run.vars)));
      await this.runSteps(def.before_each, "before_each", run);
      await this.runSteps(c.steps, c.id, run);
      await this.expect(c.expect, run);
    };
    const limit = c.timeout_ms ?? this.o.project.config.timeouts.case_ms;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([body(), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new StepFailure(`the case took longer than ${limit} ms`)), limit); })]);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      clearTimeout(timer);
    }
    let screenshot: string | null = null;
    if (error) {
      screenshot = path.join(this.o.reportDir, "screenshots", `${c.id}-failed.jpg`);
      await this.session.screenshot(screenshot).catch(() => { screenshot = null; });
    }
    for (const [defs, scope] of [[c.cleanup, `cleanup:${c.id}`], [def.after_each, "after_each"]] as const) {
      try { await this.runSteps(defs, scope, run); } catch (e) { error ??= `cleanup: ${(e as Error).message}`; }
    }
    if (error) return result("failed", error, run, screenshot);
    if (run.healed.length > 0) {
      if (this.o.mode.heal === "fail") return result("failed", `a step needed repair, and CI does not accept repairs: ${run.healed.join("; ")}. Review the repaired recording in the report and commit it`, run);
      return result("healed", null, run);
    }
    return result("passed", null, run);
  }
}

async function runSuite(o: RunOptions, suite: LoadedSuite): Promise<SuiteResult> {
  const t0 = Date.now();
  const def = suite.def;
  o.onEvent?.({ type: "suite_start", suite: def.suite, cases: def.cases.length });
  const cases: CaseResult[] = [];
  let session: Session | null = null;
  let runner: SuiteRunner | null = null;
  let setupError: string | null = null;
  const base = (() => { try { return resolveVars(o.project.vars, def.vars); } catch (e) { setupError = (e as Error).message; return {}; } })();
  try {
    session = await o.sessions.open(def.suite, (l) => o.onLog?.(l));
    runner = new SuiteRunner(o, suite, session);
  } catch (e) {
    setupError ??= `the browser did not start: ${(e as Error).message}`;
  }
  const hookRun = (): CaseRun => ({ vars: { ...base, ...builtinVars((o.now ?? (() => new Date()))(), o.runId) }, steps: [], assertions: [], healed: [], jevRequests: 0, shots: [] });
  if (!setupError && runner) {
    try { await runner.runSteps(def.before_all, "before_all", hookRun()); } catch (e) { setupError = `before_all: ${(e as Error).message}`; }
  }
  for (const c of def.cases) {
    const r: CaseResult = setupError || !runner
      ? { id: c.id, title: c.title, tags: [...def.tags, ...c.tags], status: c.skip ? "skipped" : "failed", ms: 0, error: c.skip ?? setupError, steps: [], assertions: [], healed: [], screenshot: null, jevRequests: 0 }
      : await runner.runCase(c, base);
    cases.push(r);
    o.onEvent?.({ type: "case_end", suite: def.suite, result: r });
  }
  if (runner && !setupError) {
    try { await runner.runSteps(def.after_all, "after_all", hookRun()); } catch (e) { o.onLog?.(`${def.suite}: after_all: ${(e as Error).message}`); }
  }
  let recordingsSaved: string | null = null;
  if (runner?.recordings.dirty) {
    recordingsSaved = o.mode.ci
      ? runner.recordings.save(path.join(o.reportDir, "recordings", path.relative(path.resolve(o.project.root, o.project.config.recordings), runner.recordings.path)))
      : runner.recordings.save();
  }
  await session?.close().catch(() => undefined);
  const result: SuiteResult = { suite: def.suite, key: suite.key, cases, ms: Date.now() - t0, recordingsSaved };
  o.onEvent?.({ type: "suite_end", result });
  return result;
}

export async function runAll(o: RunOptions): Promise<RunReport> {
  const started = (o.now ?? (() => new Date()))();
  const t0 = Date.now();
  const results: SuiteResult[] = new Array(o.suites.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= o.suites.length) return;
      results[i] = await runSuite(o, o.suites[i] as LoadedSuite);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.workers, o.suites.length)) }, worker));
  const totals = { passed: 0, healed: 0, failed: 0, skipped: 0, total: 0 };
  for (const s of results) for (const c of s.cases) { totals[c.status] += 1; totals.total += 1; }
  return { runId: o.runId, environment: o.project.env.name, baseUrl: o.project.env.baseUrl, startedAt: started.toISOString(), ms: Date.now() - t0, suites: results, totals };
}
