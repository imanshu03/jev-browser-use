import { redactingOracle } from "../jev.js";
import { redactData } from "../task.js";
// The fast Runner. One observation per step, one Jev request per step, freshness guards instead of waits.
//
// Loop control (history, page_changed, the three-action stall rule, StalePage retry) follows
// browser-use/jev-ultrafast jev_ultrafast/agent.py. MIT License, Copyright (c) 2026 Browser Use.
//
// This file codes only against the interfaces in ./model.ts. It never imports the browser layer.
import { TypeSafeError, choice } from "@typesafe-ai/sdk";
import path from "node:path";
import type { ProfileEntry } from "../browser.js";
import type { Human, Logger } from "../io.js";
import { emptyResult } from "../io.js";
import type { Oracle } from "../jev.js";
import { BudgetError, choiceOf } from "../jev.js";
import type { Plan } from "../plan.js";
import { catalogWords, prePlan, resolvePlan } from "../plan.js";
import { extractKeys, extractSpans, redact, varSpans } from "../task.js";
import type { ActionKind, BlockedKind, Goal, Operation, PageKind, RiskClass, RunConfig, RunResult, Span, StepRecord } from "../types.js";
import { AUTH_HOST, CREDENTIAL_NAME, DESTRUCTIVE_WORDS, GATES, LIMITS, SIGN_IN_HEADING, SUBMIT_WORDS, THRESHOLDS } from "../types.js";
import type { Action, Chrome, FastHistoryEntry, Observation, Page } from "./model.js";
import { StalePage } from "./model.js";
import type { Decision, StepInput, StepMeta, TargetOp } from "./policy.js";
import { buildStep, cutText, readStep, top3 } from "./policy.js";

export interface FastRunnerDeps {
  cfg: RunConfig;
  profiles: ProfileEntry[];
  /** Lazy: a plan-level block never launches Chrome. Gets the profile directory the plan resolved (undefined = temporary profile). */
  chrome: (profileDirectory: string | undefined) => Promise<Chrome>;
  /** Chat mode: the page the browser already shows. Used when the plan says `current_page`. */
  page?: Page;
  openPage: (chrome: Chrome) => Promise<Page>;
  oracle: Oracle;
  human: Human;
  log: Logger;
  now?: () => number;
  /** Sleep used between WAIT polls. Tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Open the Jev connection ahead of the first step. Called before the Chrome launch when the plan sent no Jev request. */
  warm?: () => Promise<void>;
}

type Top = { label: string; p: number }[];

interface StepCtx {
  t0: number; req0: number; url: string; title: string;
  pageKind: PageKind | null; pageKindConf: number | null; doneP: number | null; operation: Operation | null; operationConf: number | null;
  target: { ref: string; role: string; name: string; under: string } | null; targetConf: number | null; runnerUp: number | null;
  action: ActionKind; value: string | null; valueConf: number | null; risk: RiskClass | null; gate: string;
}

type Applied = { kind: "record"; rec: StepRecord } | { kind: "reask" } | { kind: "stale"; message: string; action?: Action };

const ACTION_OF: Record<string, ActionKind> = {
  CLICK: "click", TYPE_TEXT: "fill", SELECT: "select", SCROLL_DOWN: "scroll_down", SCROLL_UP: "scroll_up",
  WAIT: "wait", PRESS_ENTER: "press_key", GO_BACK: "go_back", DONE: "none", BLOCKED: "none",
};

const OPERATION_OF: Record<string, Operation> = {
  CLICK: "CLICK", TYPE_TEXT: "TYPE_TEXT", SELECT: "SELECT", SCROLL_DOWN: "SCROLL_DOWN", SCROLL_UP: "SCROLL_UP",
  WAIT: "WAIT", PRESS_ENTER: "PRESS_KEY", GO_BACK: "GO_BACK", DONE: "DONE", BLOCKED: "BLOCKED",
};

const BLOCKED_OF: Record<string, BlockedKind> = {
  needs_sign_in: "needs_sign_in", captcha: "captcha", overlay_or_dialog: "overlay",
  needs_credential_or_value: "needs_credential", impossible: "impossible", other: "ambiguous",
};

const HEADED_HINT = "Run with --headed (or /headed on in chat) and sign in when the run pauses";

function hit(label: string, words: string[]): boolean {
  const n = label.toLowerCase();
  return words.some((w) => new RegExp(`(?<![a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`, "i").test(n));
}

/** Risk of one target from its label. Keyword classes apply to clicks; a fill or select is data entry. */
export function riskOf(op: TargetOp, label: string): RiskClass {
  if (op === "CLICK") {
    if (hit(label, DESTRUCTIVE_WORDS)) return "destructive";
    if (hit(label, SUBMIT_WORDS)) return "submit";
    return "navigational";
  }
  return "data_entry";
}

/**
 * The stable identity of an action for bans and repeat counts. Action ids are per-snapshot ordinals
 * ("e1".."e250"), so the same id can name another element after the page changed. The node id and the
 * label stay with the element; the label separates the options of one select.
 */
export function actionKey(action: Action): string {
  return action.node === null ? action.id : `n:${action.node}|${action.label}`;
}

/** True for a CDP transport error or a Chrome that went away. Named by convention; the browser layer is not imported here. */
function isBrowserError(e: unknown, chrome: Chrome | null): boolean {
  const name = (e as { name?: string } | null)?.name ?? "";
  if (name === "CdpError" || name === "ChromeError") return true;
  return chrome !== null && chrome.client.closed;
}

export class FastRunner {
  private readonly deps: FastRunnerDeps;
  private readonly cfg: RunConfig;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly result: RunResult;
  private chrome: Chrome | null = null;
  private _page: Page | null = null;
  private spans: Span[] = [];
  private keys: { label: string; key: string }[] = [];
  private goal: Goal;
  private readonly history: FastHistoryEntry[] = [];
  private stepNo = 0;
  private pauses = 0;
  private readonly startedAt: number;
  private lastObs: Observation | null = null;
  private held: Observation | null = null;
  /** Banned action keys (see `actionKey`) per URL. */
  private readonly bannedByUrl = new Map<string, Set<string>>();
  /** Covered-target stales per `url|actionKey`. At LIMITS.coveredPerPage the target is banned on that page. */
  private readonly coveredCounts = new Map<string, number>();
  private doneBannedUntil = 0;
  /** Executions per `url|actionKey`. */
  private readonly sigCounts = new Map<string, number>();
  /** WAIT operations executed per URL. Capped at LIMITS.waitsPerPage, then a scroll takes its place. */
  private readonly waitsByUrl = new Map<string, number>();
  /** Browser stats of the page when this run got it. In chat mode the page outlives the run. */
  private browser0 = { browserMs: 0, calls: 0 };
  private readonly checkHolds = new Map<string, number>();
  private errorBacks = 0;
  private answer: RunResult["answer"] = null;
  private blockedInfo: RunResult["blocked"] = null;
  private confidence: number | null = null;
  private reason = "";

  constructor(deps: FastRunnerDeps) {
    this.deps = { ...deps, oracle: redactingOracle(deps.oracle, (s) => redact(s, this.spans)) };
    this.cfg = deps.cfg;
    this.log = deps.log;
    this.now = deps.now ?? (() => Date.now());
    this.goal = deps.cfg.goal ?? "act";
    this.startedAt = this.now();
    this.result = emptyResult(deps.cfg.task, this.goal, deps.cfg.model, deps.cfg.engine ?? "cdp");
  }

  /** The page the run used. Null when the run opened no page: a plan-level block, or a launch that failed. */
  get page(): Page | null { return this._page; }

  async run(): Promise<RunResult> {
    const cfg = this.cfg;
    let outcome: RunResult["outcome"] = "failed";
    try {
      const profiles = this.deps.profiles.filter((p) => p.directory);
      const exclude = [...profiles.flatMap((p) => [p.name, p.directory]), ...catalogWords()];
      this.spans = [...extractSpans(cfg.task, exclude), ...varSpans(cfg.vars)];
      this.log.redactor = (s) => redact(s, this.spans);
      this.result.task = redact(cfg.task, this.spans);
      this.keys = extractKeys(cfg.task);

      // When code alone knows the profile and the start URL, Chrome starts and loads the page while the
      // plan request runs. Jev then only decides the goal. A plan that needs Jev for the profile or the
      // site keeps the serial order: the plan first, then Chrome.
      const pre = prePlan(cfg, profiles);
      let browser: Promise<void> | null = null;
      if (pre.profileDirectory !== null && pre.startUrl !== null && !pre.current) {
        // No Jev request at all: no socket is open yet. Open it while Chrome starts.
        if (!pre.needsJev) this.deps.warm?.().catch(() => undefined);
        else this.log.debug("overlap: chrome launch and plan request run together");
        browser = this.openStart(pre.profileDirectory, pre.startUrl);
        // A rejection while the plan is in flight is never unhandled. The await below rethrows it.
        browser.catch(() => undefined);
      }
      /** Wait for the browser work before a block or an error, so finalize can close the Chrome it launched. */
      const settle = async (): Promise<void> => { if (browser) await browser.catch(() => undefined); };

      let plan: Plan;
      try { plan = await resolvePlan(cfg, profiles, this.spans, this.deps.oracle, this.deps.human, this.log); } catch (e) { await settle(); throw e; }
      this.goal = plan.goal;
      this.result.goal = plan.goal;
      this.result.profile = plan.profile.profile ? { directory: plan.profile.profile.directory, name: plan.profile.profile.name, how: plan.profile.how } : null;
      this.result.start = plan.start.url ? { url: plan.start.url, how: plan.start.how, confidence: plan.start.confidence } : null;
      this.log.info(`plan profile=${plan.profile.profile ? `${plan.profile.profile.name} (${plan.profile.profile.directory})` : "none"} via ${plan.profile.how} start=${plan.start.url ?? "none"} via ${plan.start.how} goal=${plan.goal}${plan.goalConfidence !== null ? `(${plan.goalConfidence.toFixed(2)})` : ""} requests=${plan.jevRequests} engine=fast`);
      if (plan.profile.blocked) { await settle(); this.setBlocked("ambiguous_profile", "Name the profile with --profile <name>", plan.top, null); return this.finalize("blocked"); }
      const current = plan.start.how === "current_page";
      if (plan.start.blocked || !plan.start.url || (current && !this.deps.page)) {
        await settle();
        this.setBlocked("no_start_url", "Add --url <start page> or name the site in the task", plan.top, null);
        return this.finalize("blocked");
      }

      if (browser) await browser;
      else {
        // The plan sent no Jev request, so no socket is open yet. Open it while Chrome starts.
        if (plan.jevRequests === 0) this.deps.warm?.().catch(() => undefined);
        if (current) {
          await this.attach(plan.profile.profile?.directory);
          this.log.info(`continue on ${plan.start.url} session=${cfg.session}${cfg.headed ? " headed" : ""}`);
        } else await this.openStart(plan.profile.profile?.directory, plan.start.url);
      }

      for (;;) {
        const rec = await this.step();
        this.result.steps.push(rec);
        this.log.step(rec);
        if (rec.result === "done") { outcome = "done"; break; }
        if (rec.result === "blocked") { outcome = "blocked"; break; }
      }
    } catch (e) {
      outcome = "failed";
      const kind = e instanceof TypeSafeError ? "jev" : isBrowserError(e, this.chrome) ? "browser" : "internal";
      this.result.error = { kind, message: this.log.redactor(String((e as Error)?.message ?? e)) };
      this.reason = `${kind}: ${this.result.error.message}`;
      this.log.warn(`FAILED ${this.reason}`);
    }
    return this.finalize(outcome);
  }

  /** Launch Chrome, or take the page chat passed, and record the page stats this run starts from. */
  private async attach(profileDirectory: string | undefined): Promise<Page> {
    this.chrome = await this.deps.chrome(profileDirectory);
    this._page = this.deps.page ?? await this.deps.openPage(this.chrome);
    this.browser0 = { ...this._page.stats };
    return this._page;
  }

  /** Attach, then load the start URL. */
  private async openStart(profileDirectory: string | undefined, url: string): Promise<void> {
    const page = await this.attach(profileDirectory);
    this.log.info(`open ${url} session=${this.cfg.session}${this.cfg.headed ? " headed" : ""}`);
    await page.navigate(url, LIMITS.openTimeoutMs);
  }

  private async finalize(outcome: RunResult["outcome"]): Promise<RunResult> {
    const r = this.result;
    try {
      const last = this.held ?? this.lastObs;
      if (last) { r.final_url = last.url; r.final_title = last.title; }
      else if (this._page) { r.final_url = await this._page.url().catch(() => null); }
    } finally {
      if (!this.cfg.keepOpen && this.chrome) await this.chrome.close().catch(() => undefined);
    }
    if (this.blockedInfo && !this.blockedInfo.resume.url) this.blockedInfo.resume.url = r.final_url;
    r.outcome = outcome;
    r.reason = this.reason;
    r.confidence = this.confidence;
    r.answer = this.answer;
    r.blocked = this.blockedInfo;
    r.goal = this.goal;
    const s = this.deps.oracle.stats;
    r.stats = {
      steps: r.steps.length, jev_requests: s.requests, input_tokens: s.inputTokens, output_tokens: s.outputTokens,
      duration_ms: this.now() - this.startedAt, model: s.model, pauses: this.pauses,
      jev_ms: s.ms, browser_ms: this._page ? this._page.stats.browserMs - this.browser0.browserMs : 0, engine: this.cfg.engine ?? "cdp",
    };
    return redactData(r, (s) => redact(s, this.spans));
  }

  private setBlocked(kind: BlockedKind, hint: string, top: Top, url: string | null): void {
    this.blockedInfo = { kind, hint, top, resume: { session: this.cfg.session, url } };
    this.reason = `${kind}: ${hint}`;
    this.log.warn(`BLOCKED ${kind}: ${hint}`);
  }

  private bansFor(url: string): Set<string> {
    let s = this.bannedByUrl.get(url);
    if (!s) { s = new Set(); this.bannedByUrl.set(url, s); }
    return s;
  }

  private async observe(): Promise<Observation> {
    const obs = await (this._page as Page).observe();
    this.lastObs = obs;
    return obs;
  }

  /**
   * Observe, and observe again when the page did not settle, up to LIMITS.fastStaleRetries times.
   * Throws StalePage after the retries; the callers block with "page keeps changing".
   */
  private async observeSettled(): Promise<Observation> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.observe();
      } catch (e) {
        if (!(e instanceof StalePage) || attempt >= LIMITS.fastStaleRetries) throw e;
        this.log.warn(`step ${this.stepNo} observe did not settle (${attempt + 1}/${LIMITS.fastStaleRetries}): ${e.message}`);
      }
    }
  }

  /** The ids of the actions of `obs` whose key is banned on its URL. The policy filters targets by id. */
  private bannedIds(obs: Observation): Set<string> {
    const bans = this.bansFor(obs.url);
    const ids = new Set<string>();
    if (bans.size === 0) return ids;
    for (const a of obs.actions) if (bans.has(actionKey(a))) ids.add(a.id);
    return ids;
  }

  private stalled(): boolean {
    const last = this.history.slice(-LIMITS.stallActions);
    return last.length === LIMITS.stallActions && last.every((h) => h.page_changed === false && h.kind !== "wait" && h.kind !== "open");
  }

  private async step(): Promise<StepRecord> {
    this.stepNo += 1;
    const ctx: StepCtx = {
      t0: this.now(), req0: this.deps.oracle.stats.requests, url: "", title: "", pageKind: null, pageKindConf: null, doneP: null, operation: null, operationConf: null,
      target: null, targetConf: null, runnerUp: null, action: "none", value: null, valueConf: null, risk: null, gate: "",
    };
    if (this.stepNo > this.cfg.maxSteps) return this.blocked(ctx, "max_steps", `stopped after ${this.cfg.maxSteps} steps`, [], this.lastObs?.url ?? null);
    if (this.now() - this.startedAt > this.cfg.runTimeoutMs) return this.blocked(ctx, "run_timeout", `run exceeded ${this.cfg.runTimeoutMs} ms`, [], this.lastObs?.url ?? null);

    let obs: Observation;
    try {
      obs = this.held ?? await this.observeSettled();
    } catch (e) {
      if (e instanceof StalePage) return this.blocked(ctx, "ambiguous", "page keeps changing", [], this.lastObs?.url ?? null);
      throw e;
    }
    this.held = null;
    ctx.url = obs.url; ctx.title = obs.title;
    if (this.stalled()) return this.blocked(ctx, "loop_detected", `${LIMITS.stallActions} actions without a page change`, [], obs.url);
    if (this.cfg.screenshotDir) await (this._page as Page).screenshot(path.join(this.cfg.screenshotDir, `step-${this.stepNo}.jpg`)).catch(() => undefined);

    let reasks = 0;
    let stale = 0;
    for (;;) {
      const input: StepInput = {
        task: this.cfg.task, goal: this.goal, obs, history: this.history, spans: this.spans, keys: this.keys,
        bannedActionIds: this.bannedIds(obs), doneBanned: this.stepNo <= this.doneBannedUntil,
      };
      let built: ReturnType<typeof buildStep>;
      try { built = buildStep(input); } catch (e) {
        if (e instanceof BudgetError) {
          // Defensive: the caps in policy.ts keep every real page under budget. A sign-in page must still hand off.
          if (AUTH_HOST.test(obs.url) || SIGN_IN_HEADING.test(obs.title)) {
            this.log.warn(`step ${this.stepNo} request too large on a sign-in page (${e.message}); handing off`);
            return this.handoff(ctx, "needs_sign_in", [], obs);
          }
          return this.blocked(ctx, "page_too_large", `${obs.actions.length} actions, ${obs.text.length} chars; ${e.message}`, [], obs.url);
        }
        throw e;
      }
      for (const c of built.meta.cuts) this.log.warn(`step ${this.stepNo} ${c}`);
      const A = (await this.deps.oracle.ask("step", built.state, built.questions)).answers;
      let d = readStep(A, built.meta, input);
      // BLOCKED below its gate does not end the run: read the runner-up operation instead (legacy rule).
      // A sign-in or captcha reason keeps BLOCKED only when the page kind head agrees.
      if (d.operation === "BLOCKED" && d.operationConf < GATES.blocked && !this.wallReason(d)) {
        const next = Object.entries(d.operationProbs).filter(([k]) => k !== "BLOCKED" && k in ACTION_OF && !(k === "DONE" && input.doneBanned)).sort((a, b) => b[1] - a[1])[0];
        if (next) {
          this.log.info(`step ${this.stepNo} BLOCKED at ${d.operationConf.toFixed(2)} below ${GATES.blocked}; using ${next[0]}@${next[1].toFixed(2)}`);
          d = readStep(A, built.meta, input, next[0]);
        }
      }
      ctx.pageKind = d.pageKind; ctx.pageKindConf = d.pageKindConf;
      ctx.operation = d.operation ? OPERATION_OF[d.operation] ?? null : null;
      ctx.operationConf = d.operation ? d.operationConf : null;
      ctx.doneP = d.operation ? d.pDone : null;
      this.log.info(`step ${this.stepNo}/${this.cfg.maxSteps} ${obs.url} | page=${d.pageKind ?? "?"}(${(d.pageKindConf ?? 0).toFixed(2)}) op=${d.operation ?? "?"}@${d.operationConf.toFixed(2)}${d.target ? ` target=[${d.target.key}]@${d.target.conf.toFixed(2)}` : ""}${d.answerState ? ` answer=${d.answerState.choice}@${d.answerState.conf.toFixed(2)}` : ""}${d.answerVisible !== undefined ? ` visible=${d.answerVisible.toFixed(2)}` : ""} actions=${obs.actions.length} obs=${obs.ms}ms`);

      const r = await this.apply(d, obs, built.meta, ctx);
      if (r.kind === "record") return r.rec;
      if (r.kind === "reask") {
        reasks += 1;
        if (reasks > LIMITS.fastReasks) return this.blocked(ctx, "ambiguous", ctx.gate || "no target passed the gate after a re-ask", d.target ? top3(d.target.probs) : top3(d.operationProbs), obs.url);
        this.log.info(`step ${this.stepNo} re-ask ${reasks}/${LIMITS.fastReasks}: ${ctx.gate}`);
        continue;
      }
      stale += 1;
      this.log.warn(`step ${this.stepNo} stale page (${stale}/${LIMITS.fastStaleRetries}): ${r.message}`);
      if (r.action && /covered/i.test(r.message)) {
        // A target that stays covered is not a changing page. Ban it on this page so the re-ask takes another route.
        const key = actionKey(r.action);
        const n = (this.coveredCounts.get(`${obs.url}|${key}`) ?? 0) + 1;
        this.coveredCounts.set(`${obs.url}|${key}`, n);
        if (n >= LIMITS.coveredPerPage) {
          this.bansFor(obs.url).add(key);
          const label = cutText(r.action.label, LIMITS.nameChars);
          this.log.warn(`step ${this.stepNo} [${r.action.id}] "${label}" stays covered; banned on this page`);
          this.history.push({ action: label, kind: "covered", text: null, page_changed: false, step: this.stepNo, url: obs.url, operation: "CLICK" });
        }
      }
      if (stale > LIMITS.fastStaleRetries) return this.blocked(ctx, "ambiguous", "page keeps changing", [], obs.url);
      try {
        obs = await this.observeSettled();
      } catch (e) {
        if (e instanceof StalePage) return this.blocked(ctx, "ambiguous", "page keeps changing", [], obs.url);
        throw e;
      }
      ctx.url = obs.url; ctx.title = obs.title;
    }
  }

  /** True when BLOCKED names a sign-in wall or a captcha and the page kind head gives that kind a real probability. */
  private wallReason(d: Decision): boolean {
    if (d.blockedReason === "needs_sign_in") return (d.pageKindProbs["sign_in_wall"] ?? 0) >= GATES.signInProb;
    if (d.blockedReason === "captcha") return (d.pageKindProbs["captcha_or_bot_check"] ?? 0) >= GATES.signInProb;
    return false;
  }

  private async apply(d0: Decision, obs: Observation, meta: StepMeta, ctx: StepCtx): Promise<Applied> {
    const rec = (r: StepRecord): Applied => ({ kind: "record", rec: r });
    let d = d0;
    const pkConf = d.pageKindConf ?? 0;
    // An empty or loading page cannot satisfy DONE and is not a wall. Wait for it to render.
    const loading = d.pageKind === "empty_or_loading" && pkConf >= GATES.pageKind;
    if (loading && (d.operation === "BLOCKED" || d.operation === "DONE")) {
      this.log.info(`step ${this.stepNo} ${d.operation}@${d.operationConf.toFixed(2)} on an empty or loading page (${pkConf.toFixed(2)}); waiting instead`);
      ctx.gate = `loading ${d.operation}`;
      d = { ...d, operation: "WAIT" };
    }
    const opTop = top3(d.operationProbs);
    const pkTop = top3(d.pageKindProbs);

    // Page kind gates run before any action. A BLOCKED reason hands off only when BLOCKED passed its gate
    // or the page kind head agrees; the blocked_reason head answers on every step, so alone it is no evidence.
    const blockedWall = d.operation === "BLOCKED" && (d.operationConf >= GATES.blocked || this.wallReason(d));
    if ((d.pageKind === "sign_in_wall" && pkConf >= GATES.pageKind) || (blockedWall && d.blockedReason === "needs_sign_in")) {
      return rec(await this.handoff(ctx, "needs_sign_in", pkTop, obs));
    }
    if ((d.pageKind === "captcha_or_bot_check" && pkConf >= GATES.pageKind) || (blockedWall && d.blockedReason === "captcha")) {
      return rec(await this.handoff(ctx, "captcha", pkTop, obs));
    }
    if (d.pageKind === "error_page" && pkConf >= GATES.pageKindError) {
      if (this.errorBacks >= 1) return rec(this.blocked(ctx, "impossible", "error page after going back", pkTop, obs.url));
      this.errorBacks += 1;
      ctx.gate = "error_page";
      return this.execute("GO_BACK", null, null, null, obs, ctx);
    }
    if (d.operation === null || !(d.operation in ACTION_OF)) return rec(this.blocked(ctx, "ambiguous", `no usable operation answer (${d.operation ?? "missing"})`, opTop, obs.url));

    if (d.operation === "DONE") return rec(await this.finish(d, obs, ctx));
    if (d.operation === "BLOCKED") {
      const kind = BLOCKED_OF[d.blockedReason ?? "other"] ?? "ambiguous";
      const hint = kind === "needs_credential" ? this.credentialHint("the field") : kind === "overlay" ? "a dialog or overlay covers the page; dismiss it with --headed" : kind === "impossible" ? "the goal cannot be done on this page" : `Jev reported BLOCKED (${d.blockedReason ?? "no reason"})`;
      return rec(this.blocked(ctx, kind, hint, opTop, obs.url));
    }
    if (d.operation === "CLICK" || d.operation === "TYPE_TEXT" || d.operation === "SELECT") return this.targeted(d, d.operation, obs, meta, ctx);
    if (d.operation === "PRESS_ENTER") {
      const label = [obs.focus?.label, obs.focus?.submitLabel].filter(Boolean).join(" | ");
      // Enter can submit a form even when no submit button is visible. Treat unknown focus as submit.
      const risk: RiskClass = riskOf("CLICK", label) === "destructive" ? "destructive" : "submit";
      ctx.risk = risk;
      ctx.action = "press_key";
      ctx.value = "Enter";
      if (d.operationConf < THRESHOLDS[risk].target) {
        return rec(this.blocked(ctx, "ambiguous", `Enter confidence below ${THRESHOLDS[risk].target}`, opTop, obs.url));
      }
      const denied = await this.confirmAction(risk, `press Enter on "${label || "the focused element"}"`, ctx, opTop, obs.url);
      if (denied) return rec(denied);
    }
    if (d.operation === "WAIT") {
      const waits = this.waitsByUrl.get(obs.url) ?? 0;
      if (waits >= LIMITS.waitsPerPage) {
        // The page did not update after the allowed waits. Scroll instead, as the legacy engine does.
        const scroll = obs.actions.some((a) => a.id === "scroll_down") ? "SCROLL_DOWN" : obs.actions.some((a) => a.id === "scroll_up") ? "SCROLL_UP" : null;
        if (!scroll) return rec(this.blocked(ctx, "loop_detected", `the page did not update after ${waits} waits`, opTop, obs.url));
        ctx.gate = `wait_cap ${waits}`;
        this.log.info(`step ${this.stepNo} WAIT capped at ${LIMITS.waitsPerPage} on ${obs.url}; using ${scroll}`);
        return this.execute(scroll, null, null, null, obs, ctx);
      }
      this.waitsByUrl.set(obs.url, waits + 1);
    }
    return this.execute(d.operation, null, null, null, obs, ctx);
  }

  /** WAIT: run the page's wait action (100 ms), then observe every `waitPollMs` until the page changes, at most `fastWaitMs`. */
  private async waitForChange(obs: Observation, control: Action | null): Promise<Observation> {
    const page = this._page as Page;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    if (control) await page.act(control, obs);
    else await sleep(LIMITS.waitPollMs);
    const polls = Math.max(1, Math.ceil(LIMITS.fastWaitMs / LIMITS.waitPollMs));
    const t0 = Date.now();
    let next = await this.observeSettled();
    for (let i = 1; i < polls && next.fingerprint === obs.fingerprint && Date.now() - t0 < LIMITS.fastWaitMs; i++) {
      await sleep(LIMITS.waitPollMs);
      next = await this.observeSettled();
    }
    return next;
  }

  private credentialHint(field: string): string {
    return `${field} needs a value: pass --var key=value (or /var key=value in chat)`;
  }

  private async targeted(d: Decision, op: TargetOp, obs: Observation, _meta: StepMeta, ctx: StepCtx): Promise<Applied> {
    const t = d.target;
    if (!t) return { kind: "record", rec: this.blocked(ctx, "ambiguous", `no target answer for ${op}`, top3(d.operationProbs), obs.url) };
    const action = obs.actions.find((a) => a.id === t.actionId);
    if (!action) return { kind: "record", rec: this.blocked(ctx, "ambiguous", `target ${t.actionId} is not on the page`, top3(t.probs), obs.url) };
    ctx.target = { ref: action.id, role: action.role ?? "", name: t.label, under: "" };
    ctx.targetConf = t.conf; ctx.runnerUp = t.runnerUp;
    ctx.action = ACTION_OF[op] ?? "none";
    const risk = riskOf(op, t.label);
    ctx.risk = risk;
    const bans = this.bansFor(obs.url);
    const key = actionKey(action);

    if (t.conf < THRESHOLDS[risk].target) {
      ctx.gate = `low_target ${t.conf.toFixed(2)} < ${THRESHOLDS[risk].target} (${risk})`;
      bans.add(key);
      return { kind: "reask" };
    }
    // A submit or destructive click needs a clear winner. A near tie between "Save" and "Save and publish" re-asks.
    if ((risk === "submit" || risk === "destructive") && t.runnerUp >= GATES.runnerUpRatio * t.conf) {
      ctx.gate = `ambiguous_runner_up ${t.runnerUp.toFixed(2)} >= ${GATES.runnerUpRatio} * ${t.conf.toFixed(2)} (${risk})`;
      bans.add(key);
      return { kind: "reask" };
    }
    const sig = `${obs.url}|${key}`;
    if ((this.sigCounts.get(sig) ?? 0) >= LIMITS.sigRepeatBan) {
      ctx.gate = `repeat ${action.id}`;
      bans.add(key);
      return { kind: "reask" };
    }

    let text: string | null = null;
    let shown: string | null = null;
    if (op === "TYPE_TEXT") {
      const chosen = d.value && d.value !== "none" ? d.value : null;
      const span = chosen ? this.spans.find((s) => s.id === chosen.spanId) : undefined;
      if (!chosen || !span) return { kind: "record", rec: this.blocked(ctx, "needs_credential", this.credentialHint(`field "${t.label}"`), top3(d.operationProbs), obs.url) };
      // A --var value is the user's own word for this run. A span cut from the task needs Jev's confidence.
      const valueConf = span.source === "var" ? 1 : chosen.conf;
      ctx.valueConf = valueConf;
      if (valueConf < THRESHOLDS[risk].value) {
        ctx.gate = `low_value ${valueConf.toFixed(2)} < ${THRESHOLDS[risk].value} (${risk})`;
        bans.add(key);
        return { kind: "reask" };
      }
      // A password, PIN, or code field takes only a secret --var value, never text cut from the task.
      if (CREDENTIAL_NAME.test(t.label) && !span.secret) {
        return { kind: "record", rec: this.blocked(ctx, "needs_credential", this.credentialHint(`field "${t.label}" is a credential and`), top3(d.operationProbs), obs.url) };
      }
      text = span.text;
      shown = span.secret ? "<secret>" : span.text;
      ctx.value = shown;
    }
    if (op === "SELECT") { ctx.value = action.label.split(" → ").slice(1).join(" → ") || action.label; ctx.valueConf = t.conf; }

    const desc = `${ctx.action} ${action.role ?? ""} "${t.label}"`.replace(/\s+/g, " ");
    const denied = await this.confirmAction(risk, desc, ctx, top3(t.probs), obs.url);
    if (denied) return { kind: "record", rec: denied };
    if (!ctx.gate) ctx.gate = `ok ${t.conf.toFixed(2)} (${risk})`;

    return this.execute(op, action, text, shown, obs, ctx);
  }

  private async confirmAction(risk: RiskClass, desc: string, ctx: StepCtx, top: Top, url: string): Promise<StepRecord | null> {
    const needsConfirm = risk === "destructive" || (risk === "submit" && this.cfg.confirm === "always");
    if (!needsConfirm || this.cfg.dryRun) return null;
    if (this.cfg.confirm === "never" || !this.deps.human.interactive) {
      return this.blocked(ctx, "needs_confirmation", `${risk} action ${desc}: run on a TTY with confirmation enabled`, top, url);
    }
    const ok = await this.deps.human.confirm(this.log.redactor(`About to ${desc} on ${url}. Type y to allow: `), LIMITS.confirmPromptMs);
    if (!ok) return this.blocked(ctx, "needs_confirmation", `the user did not allow ${desc}`, top, url);
    ctx.gate = "confirmed";
    return null;
  }

  /** Execute one operation, observe again, push history. `shown` is the redacted text for history and logs. */
  private async execute(op: string, action: Action | null, text: string | null, shown: string | null, obs: Observation, ctx: StepCtx): Promise<Applied> {
    const page = this._page as Page;
    ctx.action = ACTION_OF[op] ?? "none";
    if (!ctx.gate) ctx.gate = "ok";
    if (op === "PRESS_ENTER") ctx.value = "Enter";
    if (this.cfg.dryRun) {
      ctx.gate += " dry_run";
      this.log.info(`step ${this.stepNo} dry-run: ${op}${action ? ` [${action.id}] "${action.label}"` : ""}${shown !== null ? ` value="${shown}"` : ""}`);
      return { kind: "record", rec: this.record(ctx, "skipped", "dry_run") };
    }
    let control: Action | null = action;
    if (op === "SCROLL_DOWN" || op === "SCROLL_UP" || op === "WAIT") {
      control = obs.actions.find((a) => a.id === op.toLowerCase()) ?? null;
      if (!control && op !== "WAIT") return { kind: "record", rec: this.record(ctx, "failed", `${op} is not available on this page`) };
    }
    let next: Observation | null = null;
    try {
      if (op === "PRESS_ENTER") await page.press("Enter", obs);
      else if (op === "GO_BACK") await page.back(LIMITS.settleDomMs);
      else if (op === "WAIT") next = await this.waitForChange(obs, control);
      else if (control) await page.act(control, obs, text ?? undefined);
    } catch (e) {
      if (e instanceof StalePage) {
        const a = control ?? action;
        return a ? { kind: "stale", message: e.message, action: a } : { kind: "stale", message: e.message };
      }
      throw e;
    }
    if (action) {
      const sig = `${obs.url}|${actionKey(action)}`;
      this.sigCounts.set(sig, (this.sigCounts.get(sig) ?? 0) + 1);
    }

    const kind = op === "PRESS_ENTER" ? "key" : op === "GO_BACK" ? "back" : control ? control.kind : "wait";
    const entry: FastHistoryEntry = {
      action: cutText(action ? action.label : control && op !== "WAIT" ? control.label : op, LIMITS.nameChars),
      kind, text: shown, page_changed: null, step: this.stepNo, url: obs.url, operation: op,
    };
    this.history.push(entry);
    // The action ran. A post-action observation that does not settle must not erase it: the history
    // entry stays, and the run blocks only after the observe retries.
    if (next === null) {
      try {
        next = await this.observeSettled();
      } catch (e) {
        if (e instanceof StalePage) return { kind: "record", rec: this.blocked(ctx, "ambiguous", "page keeps changing", [], obs.url) };
        throw e;
      }
    }
    entry.page_changed = next.fingerprint !== obs.fingerprint;
    entry.url = next.url;
    this.held = next;
    return { kind: "record", rec: this.record(ctx, "ok", null) };
  }

  private async finish(d: Decision, obs: Observation, ctx: StepCtx): Promise<StepRecord> {
    if (this.goal === "act") {
      if (d.pDone >= GATES.done) {
        this.confidence = d.pDone;
        this.reason = `done ${d.pDone.toFixed(2)}`;
        ctx.gate = "done";
        return this.record(ctx, "done", null);
      }
      this.doneBannedUntil = this.stepNo + LIMITS.doneSuppressSteps;
      ctx.gate = "done_low";
      this.log.info(`step ${this.stepNo} DONE at ${d.pDone.toFixed(2)} below ${GATES.done}; DONE banned for ${LIMITS.doneSuppressSteps} steps`);
      return this.record(ctx, "skipped", `done_p ${d.pDone.toFixed(2)}`);
    }
    if (this.goal === "check") {
      const as = d.answerState;
      if (as && as.conf >= GATES.check && (as.choice === "yes" || as.choice === "no")) {
        this.answer = { kind: "check", answer: as.choice === "yes", probability: Number(as.pYes.toFixed(3)), evidence: d.evidence ? [d.evidence] : [] };
        this.confidence = as.conf;
        this.reason = `answer_state ${as.choice} ${as.conf.toFixed(2)}`;
        ctx.gate = "check_done";
        return this.record(ctx, "done", null);
      }
      const holds = (this.checkHolds.get(obs.fingerprint) ?? 0) + 1;
      this.checkHolds.set(obs.fingerprint, holds);
      if (holds >= GATES.checkHolds) {
        const top = as ? top3(as.probs) : [];
        this.answer = { kind: "check", answer: "unknown", probability: Number((as?.pYes ?? 0).toFixed(3)), evidence: d.evidence ? [d.evidence] : [], top };
        this.confidence = as?.conf ?? null;
        this.reason = `answer_state ${as?.choice ?? "missing"} stayed below ${GATES.check} after ${holds} holds`;
        ctx.gate = "check_unknown";
        return this.record(ctx, "done", null);
      }
      this.doneBannedUntil = this.stepNo + 1;
      ctx.gate = "check_hold";
      this.log.info(`step ${this.stepNo} hold: answer_state ${as?.choice ?? "missing"}@${(as?.conf ?? 0).toFixed(2)} below ${GATES.check} (${holds}/${GATES.checkHolds})`);
      return this.record(ctx, "skipped", "check_hold");
    }
    const line = d.answerLine;
    const visible = d.answerVisible ?? 0;
    if (visible >= GATES.extractFinal && line && line !== "none" && line.conf >= GATES.answerLine) {
      this.answer = { kind: "extract", text: line.text, line_id: line.key, evidence: [line.text] };
      this.confidence = line.conf;
      this.reason = `answer_line ${line.conf.toFixed(2)} visible ${visible.toFixed(2)}`;
      ctx.gate = "extract_done";
      return this.record(ctx, "done", null);
    }
    this.doneBannedUntil = this.stepNo + 2;
    ctx.gate = "extract_not_visible";
    this.log.info(`step ${this.stepNo} extract: visible=${visible.toFixed(2)} line=${line && line !== "none" ? `${line.key}@${line.conf.toFixed(2)}` : "none"}; DONE banned for 2 steps`);
    return this.record(ctx, "skipped", "extract_not_visible");
  }

  private async handoff(ctx: StepCtx, kind: "needs_sign_in" | "captcha", top: Top, obs: Observation): Promise<StepRecord> {
    const cfg = this.cfg;
    // A headed run pauses with or without a TTY: Human.pause polls the page when no key can arrive.
    if (cfg.headed && this.pauses < LIMITS.pauses) {
      this.pauses += 1;
      const poll = async (): Promise<boolean> => {
        const o = await (this._page as Page).observe();
        const state = { goal: cfg.task, page: { url: o.url, title: o.title, text: o.text.slice(0, LIMITS.textCharsMin) } };
        const questions = { wall: choice("What is this page?", { signin_wall: "A sign-in, password, 2FA, or account-chooser page", app_page: "A normal page of the site, signed in" }) };
        const w = choiceOf((await this.deps.oracle.ask("wall", state, questions)).answers, "wall");
        return Boolean(w && w.choice === "app_page" && w.confidence >= GATES.wall);
      };
      const what = kind === "captcha" ? "Solve the check in the Chrome window" : "Sign in in the Chrome window";
      const r = await this.deps.human.pause(`(${kind}): ${what}, then press Enter here. Press q to stop. Timeout ${Math.round(cfg.pauseTimeoutMs / 1000)}s.`, cfg.pauseTimeoutMs, poll);
      if (r === "resumed") {
        this.history.push({ action: "user signed in", kind: "open", text: null, page_changed: true, step: this.stepNo, url: obs.url, operation: "HUMAN_SIGNIN" });
        ctx.gate = kind;
        return this.record(ctx, "paused", null);
      }
      if (r === "aborted") return this.blocked(ctx, "human_aborted", "the user pressed q during the pause", top, obs.url);
    }
    const hint = cfg.headed ? "pause used up or timed out; sign in first, then run again" : HEADED_HINT;
    return this.blocked(ctx, kind, hint, top, obs.url);
  }

  private blocked(ctx: StepCtx, kind: BlockedKind, hint: string, top: Top, url: string | null): StepRecord {
    this.setBlocked(kind, hint, top, url);
    ctx.gate = ctx.gate || kind;
    return this.record(ctx, "blocked", hint);
  }

  private record(ctx: StepCtx, result: StepRecord["result"], error: string | null): StepRecord {
    return {
      step: this.stepNo, url: ctx.url, title: ctx.title, page_kind: ctx.pageKind, page_kind_conf: ctx.pageKindConf, done_p: ctx.doneP,
      operation: ctx.operation, operation_conf: ctx.operationConf, target: ctx.target, target_conf: ctx.targetConf, runner_up: ctx.runnerUp,
      action: ctx.action, value: ctx.value, value_conf: ctx.valueConf, risk: ctx.risk, path: "fast", gate: ctx.gate, result,
      error: error ? this.log.redactor(error) : null, jev_requests: this.deps.oracle.stats.requests - ctx.req0, duration_ms: this.now() - ctx.t0,
    };
  }
}
