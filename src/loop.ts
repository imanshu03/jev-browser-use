import { redactingOracle } from "./jev.js";
import { redactData } from "./task.js";
// The Runner. Owns the observe-decide-act loop, recovery, loop detection, pause hand-off, outcomes.
import { TypeSafeError } from "@typesafe-ai/sdk";
import path from "node:path";
import type { Browser, BrowserErrorKind, SnapshotData } from "./browser.js";
import { BrowserError } from "./browser.js";
import { candidateLines, extractAnswer, verify } from "./extract.js";
import type { Human, Logger } from "./io.js";
import { emptyResult } from "./io.js";
import type { Answers, Oracle } from "./jev.js";
import { BudgetError, choiceOf, noulOf } from "./jev.js";
import { catalogHits, catalogWords, resolvePlan } from "./plan.js";
import type { Decision, Top3 } from "./policy.js";
import { decide, fastPathAllowed, gate, keywordClass, noulSpec, riskClass, top3 } from "./policy.js";
import type { ObserveHeads } from "./questions.js";
import { buildConfirm, buildObserve, buildRecover, buildTournament, buildWall } from "./questions.js";
import { allowedActions, describeTarget, fingerprint, isCredentialField, isFillable, keywordHit, pageHeuristics, parseSnapshot } from "./snapshot.js";
import { extractKeys, extractSpans, extractUrls, redact, varSpans } from "./task.js";
import type { ActionKind, BlockedKind, Element, Goal, HistoryEntry, Operation, PageKind, ParsedPage, RiskClass, RunConfig, RunResult, Span, StepRecord } from "./types.js";
import { DISMISS_WORDS, GATES, LIMITS } from "./types.js";

export interface PageMemory {
  fp: string;
  banned: Set<string>;
  waits: number;
  recovers: number;
  covered: number;
  scrolled: boolean;
  escapeTried: boolean;
  lowConfStreak: number;
  visits: number;
  typedValues: string[];
  checkHolds: number;
}

export interface RunState {
  step: number;
  history: HistoryEntry[];
  fingerprints: string[];
  actionSigs: Map<string, number>;
  pages: Map<string, PageMemory>;
  typedByUrl: Map<string, string[]>;
  pageSpans: Span[];
  bannedLineIds: Set<string>;
  doneRejections: number;
  doneSuppressed: number;
  errorRetries: number;
  pauses: number;
  startedAt: number;
  lastNewSigStep: number;
  goal: Goal;
  lastFp: string | null;
}

export interface RunnerDeps {
  cfg: RunConfig;
  browserFor: (profileDirectory: string | undefined) => Browser;
  oracle: Oracle;
  human: Human;
  log: Logger;
  now?: () => number;
}

export type ActResult = { ok: true } | { ok: false; message: string; kind: BrowserErrorKind; coveringSelector?: string };

/** Run one browser action. Never throws. */
export async function act(browser: Browser, action: ActionKind, target: Element | null, arg: { value?: string; key?: string; url?: string; optionLabel?: string; optionRef?: string; submitEnter?: boolean }): Promise<ActResult> {
  const fail = (e: unknown): ActResult => {
    if (e instanceof BrowserError) return { ok: false, message: e.message, kind: e.kind, ...(e.coveringSelector ? { coveringSelector: e.coveringSelector } : {}) };
    return { ok: false, message: String((e as Error)?.message ?? e), kind: "other" };
  };
  try {
    switch (action) {
      case "click": {
        if (!target) return { ok: false, message: "no target", kind: "other" };
        try { await browser.click(target.ref); } catch (e) {
          if (!(e instanceof BrowserError) || e.kind !== "covered") throw e;
          await browser.scrollIntoView(target.ref).catch(() => undefined);
          await browser.waitMs(LIMITS.coveredRetryMs);
          try { await browser.click(target.ref); } catch (e2) {
            if (!(e2 instanceof BrowserError) || e2.kind !== "covered") throw e2;
            await browser.waitMs(LIMITS.coveredSecondRetryMs);
            await browser.click(target.ref);
          }
        }
        return { ok: true };
      }
      case "fill":
        if (!target || arg.value === undefined) return { ok: false, message: "no target or value", kind: "other" };
        await browser.fill(target.ref, arg.value);
        if (arg.submitEnter) await browser.press("Enter");
        return { ok: true };
      case "select":
        if (!target || arg.optionLabel === undefined) return { ok: false, message: "no target or option", kind: "other" };
        try { await browser.select(target.ref, arg.optionLabel); } catch (e) {
          if (!arg.optionRef) throw e;
          await browser.click(arg.optionRef);
        }
        return { ok: true };
      case "check": if (!target) return { ok: false, message: "no target", kind: "other" }; await browser.check(target.ref); return { ok: true };
      case "uncheck": if (!target) return { ok: false, message: "no target", kind: "other" }; await browser.uncheck(target.ref); return { ok: true };
      case "hover": if (!target) return { ok: false, message: "no target", kind: "other" }; await browser.hover(target.ref); return { ok: true };
      case "press_key": await browser.press(arg.key ?? "Enter"); return { ok: true };
      case "scroll_down": await browser.scroll("down", LIMITS.scrollPx); return { ok: true };
      case "scroll_up": await browser.scroll("up", LIMITS.scrollPx); return { ok: true };
      case "go_back": await browser.back(); return { ok: true };
      case "open_url": if (!arg.url) return { ok: false, message: "no url", kind: "other" }; await browser.open(arg.url); return { ok: true };
      case "wait": await browser.waitLoad("networkidle", LIMITS.waitIdleMs); await browser.waitMs(LIMITS.waitPauseMs); return { ok: true };
      default: return { ok: false, message: `unsupported action ${action}`, kind: "other" };
    }
  } catch (e) {
    return fail(e);
  }
}

export function opName(action: ActionKind): string {
  const map: Partial<Record<ActionKind, string>> = {
    click: "CLICK", fill: "TYPE_TEXT", select: "SELECT", check: "CLICK", uncheck: "CLICK", hover: "HOVER", press_key: "PRESS_KEY",
    scroll_down: "SCROLL_DOWN", scroll_up: "SCROLL_UP", go_back: "GO_BACK", open_url: "OPEN_URL", wait: "WAIT",
  };
  return map[action] ?? action.toUpperCase();
}

interface Observation { url: string; title: string; page: ParsedPage; full: SnapshotData | undefined; body: string; fp: string; mem: PageMemory }

interface StepCtx {
  t0: number; req0: number; url: string; title: string;
  pageKind: PageKind | null; pageKindConf: number | null; doneP: number | null; operation: Operation | null; operationConf: number | null;
  target: Element | null; targetConf: number | null; runnerUp: number | null; action: ActionKind; value: string | null; valueConf: number | null;
  risk: RiskClass | null; path: "fast" | "confirm" | "code" | null; gate: string;
}

export function varForField(el: Element, vars: Record<string, string>): { key: string; text: string } | null {
  const words = new Set(el.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  for (const [k, v] of Object.entries(vars)) {
    if (words.has(k.toLowerCase())) return { key: k, text: v };
  }
  if (isCredentialField(el)) {
    const pw = Object.entries(vars).find(([k]) => /^(password|passcode|pin|otp|code)$/i.test(k));
    if (pw) return { key: pw[0], text: pw[1] };
  }
  return null;
}

export class Runner {
  private readonly deps: RunnerDeps;
  private readonly cfg: RunConfig;
  private readonly log: Logger;
  private browser: Browser | null = null;
  private readonly result: RunResult;
  private spans: Span[] = [];
  private keys: { label: string; key: string }[] = [];
  private urls: { label: string; url: string }[] = [];
  readonly st: RunState;
  private readonly now: () => number;
  private answer: RunResult["answer"] = null;
  private blockedInfo: RunResult["blocked"] = null;
  private confidence: number | null = null;
  private reason = "";

  constructor(deps: RunnerDeps) {
    this.deps = { ...deps, oracle: redactingOracle(deps.oracle, (s) => redact(s, this.spans)) };
    this.cfg = deps.cfg;
    this.log = deps.log;
    this.now = deps.now ?? (() => Date.now());
    this.result = emptyResult(deps.cfg.task, deps.cfg.goal ?? "act", deps.cfg.model, "vercel");
    this.st = {
      step: 0, history: [], fingerprints: [], actionSigs: new Map(), pages: new Map(), typedByUrl: new Map(), pageSpans: [],
      bannedLineIds: new Set(), doneRejections: 0, doneSuppressed: 0, errorRetries: 0, pauses: 0, startedAt: this.now(),
      lastNewSigStep: 0, goal: deps.cfg.goal ?? "act", lastFp: null,
    };
  }

  async run(): Promise<RunResult> {
    const cfg = this.cfg;
    let outcome: RunResult["outcome"] = "failed";
    try {
      let profiles = await this.deps.browserFor(undefined).profiles().catch((e: unknown) => { this.log.warn(`profiles: ${(e as Error).message}`); return []; });
      profiles = profiles.filter((p) => p.directory);
      const exclude = [...profiles.flatMap((p) => [p.name, p.directory]), ...catalogWords()];
      this.spans = [...extractSpans(cfg.task, exclude), ...varSpans(cfg.vars)];
      this.log.redactor = (s) => redact(s, this.spans);
      this.result.task = redact(cfg.task, this.spans);
      this.keys = extractKeys(cfg.task);

      const plan = await resolvePlan(cfg, profiles, this.spans, this.deps.oracle, this.deps.human, this.log);
      this.st.goal = plan.goal;
      this.result.goal = plan.goal;
      this.result.profile = plan.profile.profile ? { directory: plan.profile.profile.directory, name: plan.profile.profile.name, how: plan.profile.how } : null;
      this.result.start = plan.start.url ? { url: plan.start.url, how: plan.start.how, confidence: plan.start.confidence } : null;
      this.log.info(`plan profile=${plan.profile.profile ? `${plan.profile.profile.name} (${plan.profile.profile.directory})` : "none"} via ${plan.profile.how} start=${plan.start.url ?? "none"} via ${plan.start.how} goal=${plan.goal}${plan.goalConfidence !== null ? `(${plan.goalConfidence.toFixed(2)})` : ""} requests=${plan.jevRequests}`);
      if (plan.profile.blocked) { this.setBlocked("ambiguous_profile", "Name the profile with --profile <name>", plan.top, null); outcome = "blocked"; return this.finalize(outcome); }
      if (plan.start.blocked || !plan.start.url) { this.setBlocked("no_start_url", "Add --url <start page> or name the site in the task", plan.top, null); outcome = "blocked"; return this.finalize(outcome); }

      const urlList = [...new Set([...extractUrls(cfg.task), ...catalogHits(cfg.task).map((h) => h.url)])];
      this.urls = urlList.map((u, i) => ({ label: `u${i + 1}`, url: u }));

      this.browser = this.deps.browserFor(plan.profile.profile?.directory);
      if (plan.start.how === "current_page") {
        this.log.info(`continue on ${plan.start.url} session=${cfg.session}${cfg.headed ? " headed" : ""}`);
      } else {
        this.log.info(`open ${plan.start.url} session=${cfg.session}${cfg.headed ? " headed" : ""}`);
        await this.browser.open(plan.start.url);
        await this.browser.waitLoad("networkidle", LIMITS.settleIdleMs);
        await this.browser.waitMs(LIMITS.waitPauseMs);
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
      const kind = e instanceof BrowserError ? "browser" : e instanceof TypeSafeError ? "jev" : "internal";
      this.result.error = { kind, message: this.log.redactor(String((e as Error)?.message ?? e)) };
      this.reason = `${kind}: ${this.result.error.message}`;
      this.log.warn(`FAILED ${this.reason}`);
    }
    return this.finalize(outcome);
  }

  private async finalize(outcome: RunResult["outcome"]): Promise<RunResult> {
    const r = this.result;
    if (this.browser) {
      try { r.final_url = await this.browser.getUrl(); r.final_title = await this.browser.getTitle(); } catch { /* browser gone */ }
      if (!this.cfg.keepOpen) await this.browser.close().catch(() => undefined);
    }
    if (this.blockedInfo && !this.blockedInfo.resume.url) this.blockedInfo.resume.url = r.final_url;
    r.outcome = outcome;
    r.reason = this.reason;
    r.confidence = this.confidence;
    r.answer = this.answer;
    r.blocked = this.blockedInfo;
    r.goal = this.st.goal;
    const s = this.deps.oracle.stats;
    r.stats = { steps: r.steps.length, jev_requests: s.requests, input_tokens: s.inputTokens, output_tokens: s.outputTokens, duration_ms: this.now() - this.st.startedAt, model: s.model, pauses: this.st.pauses, jev_ms: s.ms, browser_ms: 0, engine: "vercel" };
    return redactData(r, (s) => redact(s, this.spans));
  }

  private setBlocked(kind: BlockedKind, hint: string, top: Top3, url: string | null): void {
    this.blockedInfo = { kind, hint, top, resume: { session: this.cfg.session, url } };
    this.reason = `${kind}: ${hint}`;
    this.log.warn(`BLOCKED ${kind}: ${hint}`);
  }

  private memoryFor(fp: string): PageMemory {
    let m = this.st.pages.get(fp);
    if (!m) {
      m = { fp, banned: new Set(), waits: 0, recovers: 0, covered: 0, scrolled: false, escapeTried: false, lowConfStreak: 0, visits: 0, typedValues: [], checkHolds: 0 };
      this.st.pages.set(fp, m);
    }
    return m;
  }

  private typedFor(url: string): string[] {
    const key = url.split("#")[0] ?? url;
    let list = this.st.typedByUrl.get(key);
    if (!list) { list = []; this.st.typedByUrl.set(key, list); }
    return list;
  }

  private async observePage(): Promise<Observation> {
    const b = this.browser as Browser;
    const url = await b.getUrl();
    const title = await b.getTitle();
    let inter = await b.snapshot({ interactive: true, urls: true });
    if (inter.snapshot.length > LIMITS.snapshotCharsResnapshot) {
      inter = await b.snapshot({ interactive: true, urls: true, depth: 8 });
      if (inter.snapshot.length > LIMITS.snapshotCharsResnapshot && /^\s*- main\b/m.test(inter.snapshot)) inter = await b.snapshot({ interactive: true, urls: true, selector: "main" });
    }
    const refCount = Object.keys(inter.refs).length;
    const full = refCount > LIMITS.fullSnapshotAboveRefs || this.st.goal !== "act" ? await b.snapshot({ interactive: false, compact: true }).catch(() => undefined) : undefined;
    const body = (await b.getText("body").catch(() => "")).replace(/\n{2,}/g, "\n");
    const page = parseSnapshot(full ? { url, title, interactive: inter, full } : { url, title, interactive: inter });
    const fp = fingerprint(url, page.elements, this.typedFor(url));
    page.fingerprint = fp;
    const mem = this.memoryFor(fp);
    mem.visits += 1;
    return { url, title, page, full, body, fp, mem };
  }

  static loopCheck(st: RunState, fp: string, sig: string | null): "none" | "ban_target" | "blocked" {
    if (!sig) return "none";
    const count = st.actionSigs.get(sig) ?? 0;
    if (count >= LIMITS.sigRepeatBan + 1) return "blocked";
    if (count >= LIMITS.sigRepeatBan) return "ban_target";
    const recent = st.fingerprints.slice(-LIMITS.fpRepeatWindow);
    const same = recent.filter((f) => f === fp).length;
    if (same >= LIMITS.fpRepeatCount && st.step - st.lastNewSigStep > LIMITS.fpRepeatWindow) return "blocked";
    return "none";
  }

  async step(): Promise<StepRecord> {
    const st = this.st;
    st.step += 1;
    if (st.doneSuppressed > 0) st.doneSuppressed -= 1;
    const ctx: StepCtx = {
      t0: this.now(), req0: this.deps.oracle.stats.requests, url: "", title: "", pageKind: null, pageKindConf: null, doneP: null, operation: null, operationConf: null,
      target: null, targetConf: null, runnerUp: null, action: "none", value: null, valueConf: null, risk: null, path: null, gate: "",
    };
    if (st.step > this.cfg.maxSteps) return this.blocked(ctx, "max_steps", `stopped after ${this.cfg.maxSteps} steps`, [], null);
    if (this.now() - st.startedAt > this.cfg.runTimeoutMs) return this.blocked(ctx, "run_timeout", `run exceeded ${this.cfg.runTimeoutMs} ms`, [], null);

    let retries = 0;
    for (;;) {
      const obs = await this.observePage();
      ctx.url = obs.url; ctx.title = obs.title;
      const last = st.history[st.history.length - 1];
      if (last && last.page_changed === null && st.lastFp !== null) last.page_changed = obs.fp !== st.lastFp;
      st.lastFp = obs.fp;
      st.fingerprints.push(obs.fp);
      const last3 = st.history.slice(-LIMITS.stallActions);
      if (last3.length === LIMITS.stallActions && last3.every((h) => h.page_changed === false && h.operation !== "WAIT" && h.operation !== "HUMAN_SIGNIN")) {
        return this.blocked(ctx, "loop_detected", `${LIMITS.stallActions} actions without a page change`, [], obs.url);
      }
      if (this.cfg.screenshotDir && this.browser) await this.browser.screenshot(path.join(this.cfg.screenshotDir, `step-${st.step}.png`)).catch(() => undefined);

      const { page, mem, body } = obs;
      const candidates = page.elements.filter((e) => !mem.banned.has(e.key));
      let built: ReturnType<typeof buildObserve>;
      try {
        built = buildObserve({
          task: this.cfg.task, goal: st.goal, step: st.step, maxSteps: this.cfg.maxSteps, page, textExcerpt: body,
          history: st.history, candidates, banned: [...mem.banned].map((k) => k.split("|").slice(0, 2).join(" ")),
          typedValues: mem.typedValues, spans: [...this.spans, ...st.pageSpans], keys: this.keys, urls: this.urls, stalled: false,
        });
      } catch (e) {
        if (e instanceof BudgetError) return this.blocked(ctx, "page_too_large", `${page.refCount} refs; ${e.message}`, [], obs.url);
        throw e;
      }
      if (built.dropped.length > 0) this.log.debug(`trimmed: ${built.dropped.join(", ")}`);
      const A = (await this.deps.oracle.ask("observe", built.state, built.questions)).answers;
      const pk = choiceOf(A, "page_kind");
      const opA = choiceOf(A, "operation");
      ctx.pageKind = pk ? (pk.choice as PageKind) : null;
      ctx.pageKindConf = pk?.confidence ?? null;
      ctx.operation = opA ? (opA.choice as Operation) : null;
      ctx.operationConf = opA?.confidence ?? null;
      ctx.doneP = opA ? (opA.probabilities as Record<string, number>)["DONE"] ?? null : null;
      const as = choiceOf(A, "answer_state");
      const ev = choiceOf(A, "evidence");
      this.log.info(`step ${st.step}/${this.cfg.maxSteps} ${page.url} | page=${ctx.pageKind ?? "?"}(${(ctx.pageKindConf ?? 0).toFixed(2)}) op=${ctx.operation ?? "?"}@${(ctx.operationConf ?? 0).toFixed(2)}${as ? ` answer=${as.choice}@${as.confidence.toFixed(2)}` : ""}${ev ? ` evidence=${ev.choice}@${ev.confidence.toFixed(2)}` : ""} refs=${page.refCount} el=${page.elements.length} chunks=${built.heads.clickChunks.length}`);

      const dctx = {
        page, heads: built.heads, spans: [...this.spans, ...st.pageSpans], goal: st.goal, memory: mem, run: st,
        heuristics: pageHeuristics(page), keys: this.keys, urls: this.urls,
      };
      let d = decide(A, dctx);
      if (d.kind === "check_hold") {
        mem.checkHolds += 1;
        this.log.info(`hold: answer_state ${as?.choice ?? "?"}@${d.confidence.toFixed(2)} below ${GATES.check}; continuing (${mem.checkHolds}/${GATES.checkHolds})`);
        d = decide(A, { ...dctx, excludeDone: true });
      }
      const r = await this.applyDecision(d, A, obs, built.heads, ctx, retries);
      if (r === "retry") { retries += 1; continue; }
      return r;
    }
  }

  private async applyDecision(d: Decision, A: Answers, obs: Observation, heads: ObserveHeads, ctx: StepCtx, retries: number): Promise<StepRecord | "retry"> {
    const st = this.st;
    const { page, mem, full, body } = obs;
    const b = this.browser as Browser;
    switch (d.kind) {
      case "handoff": return this.handoff(ctx, d.blocked, d.top, obs);
      case "overlay": return this.overlay(ctx, obs, null, null);
      case "wait": {
        await b.waitLoad("networkidle", LIMITS.waitIdleMs); await b.waitMs(LIMITS.waitPauseMs); mem.waits += 1;
        this.pushHistory({ step: st.step, operation: "WAIT", result: "ok", page_changed: null });
        ctx.action = "wait"; ctx.path = "code";
        return this.record(ctx, "wait", null);
      }
      case "go_back": {
        await b.back().catch(() => undefined); st.errorRetries += 1; await this.settle(obs.url);
        this.pushHistory({ step: st.step, operation: "GO_BACK", result: "ok", page_changed: null });
        ctx.action = "go_back"; ctx.path = "code";
        return this.record(ctx, "ok", null);
      }
      case "blocked": return this.blocked(ctx, d.blocked, d.reason, d.top, obs.url);
      case "verify": return this.finishAct(ctx, obs);
      case "extract": return this.finishExtract(ctx, obs);
      case "check_done": {
        const evidence = d.evidence ? [describeTarget(d.evidence) + (d.evidence.value ? ` = ${d.evidence.value}` : "")] : [];
        this.answer = { kind: "check", answer: d.answer, probability: Number(d.pYes.toFixed(3)), evidence };
        this.confidence = d.confidence;
        this.reason = `answer_state ${d.answer ? "yes" : "no"} ${d.confidence.toFixed(2)}`;
        ctx.gate = "check_done";
        return this.record(ctx, "done", null);
      }
      case "check_unknown": {
        const evidence = d.evidence ? [describeTarget(d.evidence)] : [];
        this.answer = { kind: "check", answer: "unknown", probability: Number(d.pYes.toFixed(3)), evidence, top: d.top };
        this.confidence = d.confidence;
        return this.blocked(ctx, "ambiguous", `answer_state stayed below ${GATES.check} after ${GATES.checkHolds} holds`, d.top, obs.url);
      }
      case "scroll": {
        await b.scroll(d.dir, LIMITS.scrollPx); mem.scrolled = true; await this.settle(obs.url);
        this.pushHistory({ step: st.step, operation: d.dir === "down" ? "SCROLL_DOWN" : "SCROLL_UP", result: "ok", page_changed: null });
        ctx.action = d.dir === "down" ? "scroll_down" : "scroll_up"; ctx.path = "code";
        return this.record(ctx, "ok", null);
      }
      case "no_target": {
        mem.lowConfStreak += 1;
        if (mem.lowConfStreak >= 2 && !mem.scrolled) {
          await b.scroll("down", LIMITS.scrollPx); mem.scrolled = true; await this.settle(obs.url);
          this.pushHistory({ step: st.step, operation: "SCROLL_DOWN", result: "ok", page_changed: null });
          ctx.action = "scroll_down"; ctx.path = "code"; ctx.gate = d.reason;
          return this.record(ctx, "ok", null);
        }
        if (mem.lowConfStreak >= LIMITS.lowConfStreak) return this.blocked(ctx, "ambiguous", d.reason, d.top, obs.url);
        ctx.gate = d.reason;
        return this.record(ctx, "skipped", d.reason);
      }
      case "tournament": {
        const { state, questions } = buildTournament({ task: this.cfg.task, goal: st.goal, page, history: st.history, winners: d.winners });
        const T = choiceOf((await this.deps.oracle.ask("tournament", state, questions)).answers, "target_final");
        const chosen = T && T.choice !== "none" ? d.winners.find((w) => w.ref === T.choice) : undefined;
        if (!T || !chosen) return this.applyDecision({ kind: "no_target", reason: "tournament picked none", top: T ? top3(T.probabilities as Record<string, number>) : [] }, A, obs, heads, ctx, retries);
        const probs = T.probabilities as Record<string, number>;
        const top = probs[T.choice] ?? 0;
        let runnerUp = 0;
        for (const [k, p] of Object.entries(probs)) if (k !== T.choice && k !== "none" && p > runnerUp) runnerUp = p;
        const valueAns = choiceOf(A, "value");
        const span = valueAns && valueAns.choice !== "none_of_these" ? [...this.spans, ...st.pageSpans].find((s) => s.id === valueAns.choice) ?? null : null;
        const { chunkProbability: _p, ...el } = chosen;
        return this.applyDecision({ kind: "candidate", chosen: el, action: d.action, targetConf: T.confidence, top, runnerUp, specValue: { span, conf: valueAns?.confidence ?? null } }, A, obs, heads, ctx, retries);
      }
      case "code_action": {
        ctx.action = d.action; ctx.path = "code";
        const spec = noulSpec(A);
        return this.gateAndAct(ctx, obs, { chosen: null, action: d.action, arg: { ...(d.key ? { key: d.key } : {}), ...(d.url ? { url: d.url } : {}) }, targetConf: null, top: null, runnerUp: null, targetOk: null, valueConf: null, inScope: spec.inScope, irreversible: spec.irreversible, submits: spec.submits, actionConf: null, fromVar: false }, retries);
      }
      case "candidate": return this.resolveCandidate(ctx, A, obs, heads, d, retries);
      case "check_hold": return this.record(ctx, "skipped", "check_hold");
    }
  }

  private async resolveCandidate(ctx: StepCtx, A: Answers, obs: Observation, heads: ObserveHeads, d: Extract<Decision, { kind: "candidate" }>, retries: number): Promise<StepRecord | "retry"> {
    const st = this.st;
    const { page, mem, full, body } = obs;
    const chosen = d.chosen;
    ctx.target = chosen; ctx.targetConf = d.targetConf; ctx.runnerUp = d.runnerUp;
    let action: ActionKind = d.action;
    if (!allowedActions(chosen).includes(action)) {
      const first = allowedActions(chosen)[0];
      if (!first) { mem.banned.add(chosen.key); ctx.gate = "affordance"; return this.record(ctx, "skipped", "affordance"); }
      action = first;
    }
    ctx.action = action;
    const spec = noulSpec(A);
    const base = { chosen, action, targetConf: d.targetConf, top: d.top, runnerUp: d.runnerUp, irreversible: spec.irreversible, submits: spec.submits, inScope: spec.inScope, actionConf: null as number | null, targetOk: null as number | null };

    if (action === "fill") {
      const v = varForField(chosen, this.cfg.vars);
      if (isCredentialField(chosen) && !v) return this.blocked(ctx, "needs_credential", `field "${chosen.name}" needs --var <key>=<value>`, [], obs.url);
      if (v) {
        ctx.path = "code"; ctx.valueConf = 1;
        return this.gateAndAct(ctx, obs, { ...base, arg: { value: v.text, submitEnter: spec.submitWithEnter >= GATES.submitWithEnter }, valueConf: 1, fromVar: true }, retries);
      }
    }
    const fillableCount = page.elements.filter((e) => isFillable(e) && !mem.banned.has(e.key) && !(e.role === "combobox" && (e.options?.length ?? 0) > 0)).length;
    const fast = fastPathAllowed({ chosen, action, targetConf: d.targetConf, top: d.top, runnerUp: d.runnerUp, spec: { irreversible: spec.irreversible, submits: spec.submits, value: d.specValue }, fillableCount, valueFromPage: spec.valueFromPage })
      || (action === "select" && d.targetConf >= FAST_SELECT);
    if (fast) {
      ctx.path = "fast";
      if (action === "fill") {
        const span = d.specValue.span as Span;
        ctx.valueConf = d.specValue.conf;
        if (mem.typedValues.includes(span.text)) { mem.banned.add(chosen.key); ctx.gate = "already_typed"; return this.record(ctx, "skipped", "already_typed"); }
        return this.gateAndAct(ctx, obs, { ...base, arg: { value: span.text, submitEnter: spec.submitWithEnter >= GATES.submitWithEnter }, valueConf: d.specValue.conf, fromVar: false }, retries);
      }
      if (action === "select") {
        ctx.valueConf = d.targetConf;
        return this.gateAndAct(ctx, obs, { ...base, arg: { ...(d.optionLabel !== undefined ? { optionLabel: d.optionLabel } : {}), ...(d.optionRef ? { optionRef: d.optionRef } : {}) }, valueConf: d.targetConf, fromVar: false }, retries);
      }
      return this.gateAndAct(ctx, obs, { ...base, arg: {}, valueConf: null, fromVar: false }, retries);
    }

    // CONFIRM: the chosen element sits in the state.
    ctx.path = "confirm";
    const pageLines = spec.valueFromPage >= GATES.valueFromPage ? candidateLines(page, full, body).slice(0, 200) : [];
    const kw = keywordClass(chosen.name);
    const askTargetOk = kw === "submit" || kw === "destructive" || spec.irreversible >= FAST_PATH_IRREVERSIBLE || spec.submits >= FAST_PATH_SUBMITS;
    const built = buildConfirm({ task: this.cfg.task, goal: st.goal, step: st.step, page, chosen, proposed: action, spans: [...this.spans, ...st.pageSpans], pageLines, history: st.history, typedValues: mem.typedValues, askTargetOk });
    const C = (await this.deps.oracle.ask("confirm", built.state, built.questions)).answers;
    const cAction = choiceOf(C, "action");
    if (!cAction || cAction.choice === "none" || cAction.confidence < GATES.action) { mem.banned.add(chosen.key); ctx.gate = "low_action"; return this.record(ctx, "skipped", "low_action"); }
    action = cAction.choice as ActionKind;
    ctx.action = action;
    const arg: { value?: string; optionLabel?: string; optionRef?: string; submitEnter?: boolean } = {};
    let valueConf: number | null = null;
    if (action === "fill") {
      const v = choiceOf(C, "value");
      const span = v && v.choice !== "none_of_these" ? [...this.spans, ...st.pageSpans, ...pageLines].find((s) => s.id === v.choice) : undefined;
      if (!v || !span) { mem.banned.add(chosen.key); ctx.gate = "low_value"; return this.record(ctx, "skipped", "low_value"); }
      if (mem.typedValues.includes(span.text)) { mem.banned.add(chosen.key); ctx.gate = "already_typed"; return this.record(ctx, "skipped", "already_typed"); }
      arg.value = span.text; valueConf = v.confidence; ctx.valueConf = valueConf;
      arg.submitEnter = noulOf(C, "submit_with_enter") >= GATES.submitWithEnter;
      if (noulOf(C, "fills_credential") >= GATES.fillsCredential) return this.blocked(ctx, "needs_credential", `field "${chosen.name}" needs --var <key>=<value>`, [], obs.url);
    }
    if (action === "select") {
      const so = choiceOf(C, "select_option");
      const idx = so && so.choice !== "none_of_these" ? Number(so.choice.slice(1)) : -1;
      const label = idx >= 0 ? chosen.options?.[idx] : undefined;
      if (!so || label === undefined) { mem.banned.add(chosen.key); ctx.gate = "low_value"; return this.record(ctx, "skipped", "low_value"); }
      arg.optionLabel = label; valueConf = so.confidence; ctx.valueConf = valueConf;
      const ref = chosen.optionRefs?.[idx];
      if (ref) arg.optionRef = ref;
    }
    return this.gateAndAct(ctx, obs, {
      ...base, action, arg, valueConf, fromVar: false, actionConf: cAction.confidence,
      irreversible: noulOf(C, "irreversible"), submits: noulOf(C, "submits"), inScope: noulOf(C, "in_task_scope", 1),
      targetOk: askTargetOk ? noulOf(C, "target_ok") : null,
    }, retries);
  }

  private async gateAndAct(ctx: StepCtx, obs: Observation, p: {
    chosen: Element | null; action: ActionKind; arg: { value?: string; key?: string; url?: string; optionLabel?: string; optionRef?: string; submitEnter?: boolean };
    targetConf: number | null; top: number | null; runnerUp: number | null; targetOk: number | null; valueConf: number | null;
    inScope: number; irreversible: number; submits: number; actionConf: number | null; fromVar: boolean;
  }, retries: number): Promise<StepRecord | "retry"> {
    const st = this.st;
    const { mem, fp } = obs;
    const b = this.browser as Browser;
    const { chosen, action, arg } = p;
    const risk = riskClass(chosen, action, { irreversible: p.irreversible, submits: p.submits });
    ctx.risk = risk;
    if (arg.value !== undefined) ctx.value = this.log.redactor(arg.value);
    const g = gate(risk, { targetConf: p.targetConf, runnerUp: p.runnerUp, top: p.top, targetOk: p.targetOk, valueConf: p.valueConf, inScope: p.inScope, actionConf: p.actionConf }, this.cfg.confirm);
    if (!g.ok) {
      ctx.gate = g.reason;
      if (g.reason === "needs_human_confirm") {
        const desc = chosen ? `${chosen.role} "${chosen.name}"` : action;
        if (this.cfg.confirm !== "never" && this.deps.human.interactive) {
          const ok = await this.deps.human.confirm(`About to ${action} ${desc} on ${obs.url}. Type y to allow: `, LIMITS.confirmPromptMs);
          if (!ok) return this.blocked(ctx, "needs_confirmation", `the user did not allow ${action} on ${desc}`, [], obs.url);
        } else {
          return this.blocked(ctx, "needs_confirmation", `${risk} action ${action} on ${desc}: re-run on a TTY, or use --confirm auto`, [], obs.url);
        }
      } else {
        if (chosen) mem.banned.add(chosen.key);
        mem.lowConfStreak += 1;
        if (mem.lowConfStreak >= LIMITS.lowConfStreak) return this.blocked(ctx, "ambiguous", g.reason, [], obs.url);
        return this.record(ctx, "skipped", g.reason);
      }
    } else ctx.gate = `ok:${g.band}`;
    mem.lowConfStreak = 0;

    const sig = `${fp}|${action}|${chosen?.key ?? ""}|${arg.value ?? arg.optionLabel ?? arg.key ?? arg.url ?? ""}`;
    const lc = Runner.loopCheck(st, fp, sig);
    if (lc === "ban_target") { if (chosen) mem.banned.add(chosen.key); ctx.gate = "repeat"; return this.record(ctx, "skipped", "repeat"); }
    if (lc === "blocked") return this.blocked(ctx, "loop_detected", "the same action repeated on the same page", [], obs.url);
    const prev = st.actionSigs.get(sig) ?? 0;
    st.actionSigs.set(sig, prev + 1);
    if (prev === 0) st.lastNewSigStep = st.step;
    if (this.cfg.dryRun) { ctx.gate += " dry_run"; return this.record(ctx, "skipped", "dry_run"); }

    const r = await act(b, action, chosen, arg);
    const entry: HistoryEntry = { step: st.step, operation: opName(action), result: r.ok ? "ok" : `error: ${this.log.redactor(r.message).slice(0, 200)}`, page_changed: null };
    if (chosen) { entry.target = describeTarget(chosen); entry.element_key = chosen.key; }
    if (arg.value !== undefined) entry.value = this.log.redactor(arg.value);
    if (arg.optionLabel !== undefined) entry.value = arg.optionLabel;
    if (arg.key !== undefined) entry.value = arg.key;
    if (arg.url !== undefined) entry.value = arg.url;
    if (!r.ok) {
      if (r.kind === "covered") {
        mem.covered += 1;
        this.log.warn(`step ${st.step} click covered by ${r.coveringSelector ?? "?"} (${mem.covered}/${LIMITS.coveredPerPage} on this page)`);
        if (mem.covered >= LIMITS.coveredPerPage) return this.overlay(ctx, obs, r.coveringSelector ?? null, chosen);
        this.pushHistory(entry);
        return this.record(ctx, "failed", r.message);
      }
      if (r.kind === "unknown_ref" && retries < LIMITS.staleRetries) { this.log.warn(`step ${st.step} stale ref ${chosen?.ref ?? ""}; observing again`); return "retry"; }
      if (r.kind === "timeout" && retries < LIMITS.staleRetries) { await b.waitLoad("domcontentloaded", LIMITS.settleDomMs); return "retry"; }
      if (r.kind === "tab_gone" || r.kind === "launch") throw new BrowserError(r.kind, r.message, "");
      if (chosen) mem.banned.add(chosen.key);
      this.pushHistory(entry);
      return this.record(ctx, "failed", r.message);
    }
    await this.settle(obs.url);
    if (action === "fill" && arg.value !== undefined) { mem.typedValues.push(arg.value); this.typedFor(obs.url).push(arg.value); }
    entry.url_after = await b.getUrl().catch(() => obs.url);
    this.pushHistory(entry);
    return this.record(ctx, "ok", null);
  }

  private pushHistory(e: HistoryEntry): void {
    this.st.history.push(e);
  }

  private async settle(urlBefore: string): Promise<void> {
    const b = this.browser as Browser;
    await b.waitLoad("domcontentloaded", LIMITS.settleDomMs);
    await b.waitMs(LIMITS.settlePauseMs);
    const url = await b.getUrl().catch(() => urlBefore);
    if (url !== urlBefore) await b.waitLoad("networkidle", LIMITS.settleIdleMs);
  }

  private async handoff(ctx: StepCtx, kind: "needs_sign_in" | "captcha" | "overlay", top: Top3, obs: Observation): Promise<StepRecord> {
    const st = this.st;
    const cfg = this.cfg;
    if (cfg.headed && st.pauses < LIMITS.pauses) {
      st.pauses += 1;
      const poll = async (): Promise<boolean> => {
        const b = this.browser as Browser;
        const url = await b.getUrl();
        const title = await b.getTitle();
        const text = (await b.getText("body").catch(() => "")).replace(/\n{2,}/g, "\n");
        const { state, questions } = buildWall({ task: cfg.task, url, title, textExcerpt: text });
        const w = choiceOf((await this.deps.oracle.ask("wall", state, questions)).answers, "wall");
        return Boolean(w && w.choice === "app_page" && w.confidence >= GATES.wall);
      };
      const r = await this.deps.human.pause(`(${kind}): sign in or solve the check in the browser window, then press Enter here. Press q to stop. Timeout ${Math.round(cfg.pauseTimeoutMs / 1000)}s.`, cfg.pauseTimeoutMs, poll);
      if (r === "resumed") {
        this.pushHistory({ step: st.step, operation: "HUMAN_SIGNIN", result: "user signed in", page_changed: true });
        ctx.gate = kind;
        return this.record(ctx, "paused", null);
      }
      if (r === "aborted") return this.blocked(ctx, "human_aborted", "the user pressed q during the pause", top, obs.url);
    }
    const hint = cfg.headed
      ? "pause used up or timed out. The copied profile is read-only; use --cdp for a durable session."
      : "Re-run with --headed to sign in during a pause. The copied profile is read-only; use --cdp for a durable session.";
    return this.blocked(ctx, kind, hint, top, obs.url);
  }

  private async overlay(ctx: StepCtx, obs: Observation, coveringSelector: string | null, failedTarget: Element | null): Promise<StepRecord> {
    const { mem, page, body } = obs;
    const b = this.browser as Browser;
    if (!mem.escapeTried) {
      mem.escapeTried = true;
      await b.press("Escape").catch(() => undefined);
      await b.waitMs(LIMITS.expandWaitMs);
      const inter2 = await b.snapshot({ interactive: true });
      const page2 = parseSnapshot({ url: obs.url, title: obs.title, interactive: inter2 });
      if (fingerprint(obs.url, page2.elements, this.typedFor(obs.url)) !== mem.fp) {
        this.log.info(`step ${this.st.step} escape cleared the overlay`);
        ctx.gate = "escape"; ctx.action = "press_key"; ctx.path = "code";
        this.pushHistory({ step: this.st.step, operation: "PRESS_KEY", value: "Escape", result: "ok", page_changed: true });
        return this.record(ctx, "recovered", null);
      }
    }
    if (mem.recovers >= LIMITS.recoversPerPage) return this.blocked(ctx, "overlay", "recoveries used up on this page", [], obs.url);
    const inter = await b.snapshot({ interactive: true });
    const fresh = parseSnapshot({ url: obs.url, title: obs.title, interactive: inter });
    const rank = (e: Element) => (keywordHit(e.name, DISMISS_WORDS.slice(0, 7)) ? 0 : keywordHit(e.name, DISMISS_WORDS) ? 1 : 2);
    const cands = fresh.elements.filter((e) => e.role === "button" || e.role === "link" || e.role === "checkbox")
      .sort((x, y) => rank(x) - rank(y) || x.index - y.index).slice(0, LIMITS.chunkSize);
    const { state, questions } = buildRecover({ task: this.cfg.task, page, textExcerpt: body, coveringSelector, failedTarget, candidates: cands });
    const R = (await this.deps.oracle.ask("recover", state, questions)).answers;
    const dt = choiceOf(R, "dismiss_target");
    const target = dt && dt.choice !== "none" ? cands.find((c) => c.ref === dt.choice) : undefined;
    if (noulOf(R, "is_dismissible") < GATES.isDismissible || !dt || !target || dt.confidence < GATES.dismissTarget) {
      if (this.cfg.headed) return this.handoff(ctx, "overlay", dt ? top3(dt.probabilities as Record<string, number>) : [], obs);
      return this.blocked(ctx, "overlay", `overlay${coveringSelector ? ` ${coveringSelector}` : ""} could not be dismissed`, dt ? top3(dt.probabilities as Record<string, number>) : [], obs.url);
    }
    await b.click(target.ref).catch(() => undefined);
    await b.waitMs(500);
    mem.recovers += 1;
    ctx.gate = "recover"; ctx.action = "click"; ctx.path = "code"; ctx.target = target; ctx.targetConf = dt.confidence;
    this.pushHistory({ step: this.st.step, operation: "CLICK", target: describeTarget(target), result: "ok (dismissed overlay)", page_changed: null, element_key: target.key });
    return this.record(ctx, "recovered", null);
  }

  private async finishAct(ctx: StepCtx, obs: Observation): Promise<StepRecord> {
    const st = this.st;
    const lines = candidateLines(obs.page, obs.full, obs.body);
    const V = await verify({ task: this.cfg.task, goal: st.goal, page: obs.page, textExcerpt: obs.body, lines, history: st.history, candidate: null, oracle: this.deps.oracle });
    if (V.doneFinal >= GATES.doneFinal) {
      this.confidence = V.doneFinal;
      this.reason = `done_final ${V.doneFinal.toFixed(2)}`;
      this.answer = null;
      ctx.gate = "verify";
      return this.record(ctx, "done", null);
    }
    st.doneRejections += 1;
    if (st.doneRejections >= LIMITS.doneRejections) st.doneSuppressed = LIMITS.doneSuppressSteps + 1;
    this.log.info(`step ${st.step} verify rejected done_final=${V.doneFinal.toFixed(2)} (${st.doneRejections} rejections)`);
    ctx.gate = "verify_failed";
    return this.record(ctx, "skipped", `done_final ${V.doneFinal.toFixed(2)}`);
  }

  private async finishExtract(ctx: StepCtx, obs: Observation): Promise<StepRecord> {
    const st = this.st;
    const { mem } = obs;
    const b = this.browser as Browser;
    const lines = candidateLines(obs.page, obs.full, obs.body);
    const X = await extractAnswer({ task: this.cfg.task, goal: st.goal, page: obs.page, lines, history: st.history, oracle: this.deps.oracle, bannedLineIds: st.bannedLineIds });
    for (const w of X.winners) {
      if (w.chunkProbability >= GATES.pageSpanCapture && !st.pageSpans.some((p) => p.text === w.text)) {
        st.pageSpans.push({ id: `p${st.pageSpans.length + 1}`, text: w.text, source: "page_line", secret: false });
        if (st.pageSpans.length > LIMITS.pageSpans) st.pageSpans.shift();
        st.pageSpans.forEach((p, i) => { p.id = `p${i + 1}`; });
      }
    }
    if (!X.best) {
      if (!mem.scrolled) {
        await b.scroll("down", LIMITS.scrollPx); mem.scrolled = true; await this.settle(obs.url);
        this.pushHistory({ step: st.step, operation: "SCROLL_DOWN", result: "ok", page_changed: null });
        ctx.action = "scroll_down"; ctx.path = "code"; ctx.gate = "extract_uncertain";
        return this.record(ctx, "ok", null);
      }
      mem.lowConfStreak += 1;
      if (mem.lowConfStreak >= LIMITS.lowConfStreak) return this.blocked(ctx, "ambiguous", "no line matched the requested value", [], obs.url);
      ctx.gate = "extract_uncertain";
      return this.record(ctx, "skipped", "extract_uncertain");
    }
    const V = await verify({ task: this.cfg.task, goal: st.goal, page: obs.page, textExcerpt: obs.body, lines, history: st.history, candidate: X.best, oracle: this.deps.oracle });
    if ((V.answerOk ?? 0) >= GATES.answerOk) {
      this.answer = { kind: "extract", text: X.best.text, line_id: X.best.id, evidence: V.evidence };
      this.confidence = V.answerOk;
      this.reason = `answer_ok ${(V.answerOk ?? 0).toFixed(2)}`;
      ctx.gate = "verify";
      return this.record(ctx, "done", null);
    }
    st.bannedLineIds.add(X.best.id);
    this.log.info(`step ${st.step} answer "${X.best.text}" rejected answer_ok=${(V.answerOk ?? 0).toFixed(2)}`);
    ctx.gate = "answer_rejected";
    return this.record(ctx, "skipped", "answer_rejected");
  }

  private blocked(ctx: StepCtx, kind: BlockedKind, hint: string, top: Top3, url: string | null): StepRecord {
    this.setBlocked(kind, hint, top, url);
    ctx.gate = ctx.gate || kind;
    return this.record(ctx, "blocked", hint);
  }

  private record(ctx: StepCtx, result: StepRecord["result"], error: string | null): StepRecord {
    return {
      step: this.st.step, url: ctx.url, title: ctx.title, page_kind: ctx.pageKind, page_kind_conf: ctx.pageKindConf, done_p: ctx.doneP,
      operation: ctx.operation, operation_conf: ctx.operationConf,
      target: ctx.target ? { ref: ctx.target.ref, role: ctx.target.role, name: ctx.target.name, under: ctx.target.under } : null,
      target_conf: ctx.targetConf, runner_up: ctx.runnerUp, action: ctx.action, value: ctx.value, value_conf: ctx.valueConf,
      risk: ctx.risk, path: ctx.path, gate: ctx.gate, result, error: error ? this.log.redactor(error) : null,
      jev_requests: this.deps.oracle.stats.requests - ctx.req0, duration_ms: this.now() - ctx.t0,
    };
  }
}

const FAST_SELECT = 0.60;
const FAST_PATH_IRREVERSIBLE = 0.30;
const FAST_PATH_SUBMITS = 0.40;
