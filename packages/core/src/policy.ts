// Risk classes, the gate, and the pure decide() over OBSERVE answers.
import type { Answers } from "./jev.js";
import { choiceOf, noulOf } from "./jev.js";
import type { ObserveHeads } from "./questions.js";
import { resolveKey } from "./questions.js";
import { isCredentialField, keywordHit } from "./snapshot.js";
import type { ActionKind, BlockedKind, Element, Goal, Operation, PageKind, ParsedPage, RiskClass, RunConfig, Span } from "./types.js";
import { DESTRUCTIVE_WORDS, FAST_PATH, GATES, LIMITS, SUBMIT_WORDS, THRESHOLDS } from "./types.js";

const RANK: Record<RiskClass, number> = { read_only: 0, navigational: 1, data_entry: 2, submit: 3, destructive: 4 };
const BY_RANK: RiskClass[] = ["read_only", "navigational", "data_entry", "submit", "destructive"];

export function keywordClass(name: string): RiskClass {
  if (keywordHit(name, DESTRUCTIVE_WORDS)) return "destructive";
  if (keywordHit(name, SUBMIT_WORDS)) return "submit";
  return "read_only";
}

export function actionClass(el: Element | null, action: ActionKind): RiskClass {
  if (action === "fill" || action === "select" || action === "check" || action === "uncheck") return "data_entry";
  if (action === "click" || action === "open_url") return "navigational";
  return "read_only";
}

export function riskClass(el: Element | null, action: ActionKind, jev: { irreversible: number; submits: number }): RiskClass {
  const jevClass: RiskClass = jev.irreversible >= GATES.irreversibleDestructive ? "destructive" : jev.submits >= GATES.submitsSubmit ? "submit" : "read_only";
  const kw = el && (action === "click" || action === "press_key") ? keywordClass(el.name) : "read_only";
  const r = Math.max(RANK[kw], RANK[actionClass(el, action)], RANK[jevClass]);
  return BY_RANK[r] ?? "read_only";
}

export type GateReason = "low_target" | "ambiguous_runner_up" | "target_rejected" | "low_value" | "out_of_scope" | "needs_human_confirm" | "affordance" | "low_action";
export type Gate = { ok: true; risk: RiskClass; band: "high" | "medium" } | { ok: false; risk: RiskClass; reason: GateReason };

export function gate(risk: RiskClass, a: {
  targetConf: number | null; runnerUp: number | null; top: number | null; targetOk: number | null;
  valueConf: number | null; inScope: number; actionConf: number | null;
}, confirmMode: RunConfig["confirm"]): Gate {
  const t = THRESHOLDS[risk];
  if (a.actionConf !== null && a.actionConf < GATES.action) return { ok: false, risk, reason: "low_action" };
  if (a.targetConf !== null && a.targetConf < t.target) return { ok: false, risk, reason: "low_target" };
  // The relative runner-up rule only guards submit and destructive actions. Over 100 elements a
  // navigational click often has a runner-up above half the top probability and still succeeds.
  if ((risk === "submit" || risk === "destructive") && a.runnerUp !== null && a.top !== null && a.runnerUp >= GATES.runnerUpRatio * a.top) return { ok: false, risk, reason: "ambiguous_runner_up" };
  if (t.targetOk > 0 && (a.targetOk ?? 0) < t.targetOk) return { ok: false, risk, reason: "target_rejected" };
  if (a.valueConf !== null && a.valueConf < t.value) return { ok: false, risk, reason: "low_value" };
  if (a.inScope < t.inScope) return { ok: false, risk, reason: "out_of_scope" };
  if (risk === "destructive" && confirmMode === "never") return { ok: false, risk, reason: "needs_human_confirm" };
  if (t.humanConfirm || (confirmMode === "always" && risk === "submit")) return { ok: false, risk, reason: "needs_human_confirm" };
  return { ok: true, risk, band: a.targetConf === null || a.targetConf >= t.target + 0.10 ? "high" : "medium" };
}

export type Top3 = { label: string; p: number }[];

export function top3(probabilities: Record<string, number>): Top3 {
  return Object.entries(probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label, p]) => ({ label, p: Number(p.toFixed(3)) }));
}

export interface DecideMemory { waits: number; scrolled: boolean; checkHolds: number }

export interface DecideContext {
  page: ParsedPage; heads: ObserveHeads; spans: Span[]; goal: Goal;
  memory: DecideMemory; run: { doneSuppressed: number; errorRetries: number };
  heuristics: { signInWall: boolean }; keys: { label: string; key: string }[]; urls: { label: string; url: string }[];
  excludeDone?: boolean;
}

export type Decision =
  | { kind: "handoff"; blocked: "needs_sign_in" | "captcha"; top: Top3 }
  | { kind: "overlay"; pageKind: PageKind }
  | { kind: "wait" }
  | { kind: "go_back"; reason: "error_page" }
  | { kind: "blocked"; blocked: BlockedKind; reason: string; top: Top3 }
  | { kind: "verify" }
  | { kind: "extract" }
  | { kind: "check_done"; answer: boolean; pYes: number; confidence: number; evidence: Element | null }
  | { kind: "check_hold"; confidence: number }
  | { kind: "check_unknown"; pYes: number; confidence: number; top: Top3; evidence: Element | null }
  | { kind: "scroll"; dir: "down" | "up" }
  | { kind: "code_action"; action: "press_key" | "open_url" | "go_back" | "wait"; key?: string; url?: string; conf: number }
  | { kind: "no_target"; reason: string; top: Top3 }
  | { kind: "tournament"; winners: (Element & { chunkProbability: number })[]; action: ActionKind }
  | { kind: "candidate"; chosen: Element; action: ActionKind; targetConf: number; top: number; runnerUp: number; specValue: { span: Span | null; conf: number | null }; optionLabel?: string; optionRef?: string };

function runnerUpOf(probabilities: Record<string, number>, choice: string): number {
  let best = 0;
  for (const [k, p] of Object.entries(probabilities)) if (k !== choice && k !== "none" && k !== "none_of_these" && p > best) best = p;
  return best;
}

export function chooseWinners(a: Answers, chunks: Element[][], prefix = "click_target_"): (Element & { chunkProbability: number; runnerUp: number })[] {
  const out: (Element & { chunkProbability: number; runnerUp: number })[] = [];
  chunks.forEach((chunk, k) => {
    const ans = choiceOf(a, `${prefix}${k}`);
    if (!ans || ans.choice === "none") return;
    const p = ans.probabilities[ans.choice] ?? 0;
    if (p < GATES.chunkWinner) return;
    const el = chunk.find((e) => e.ref === ans.choice);
    if (el) out.push({ ...el, chunkProbability: p, runnerUp: runnerUpOf(ans.probabilities, ans.choice) });
  });
  return out;
}

export function fastPathAllowed(input: {
  chosen: Element; action: ActionKind; targetConf: number; top: number; runnerUp: number;
  spec: { irreversible: number; submits: number; value: { conf: number | null; span: Span | null } };
  fillableCount: number; valueFromPage: number;
}): boolean {
  const { chosen, action, spec } = input;
  const base = input.targetConf >= FAST_PATH.target && input.runnerUp < FAST_PATH.runnerUpRatio * input.top
    && keywordClass(chosen.name) === "read_only" && spec.irreversible < FAST_PATH.irreversibleMax && spec.submits < FAST_PATH.submitsMax;
  if (action === "click" || action === "check" || action === "uncheck" || action === "hover") return base;
  if (action === "fill") {
    return base && input.fillableCount === 1 && (spec.value.conf ?? 0) >= FAST_PATH.value && spec.value.span !== null
      && !isCredentialField(chosen) && input.valueFromPage < GATES.valueFromPage;
  }
  return false;
}

/** The operation to act on: the head's choice, or the next best when DONE must be skipped. */
export function pickOperation(a: Answers, exclude: Set<Operation>): { op: Operation; conf: number; probabilities: Record<string, number> } | null {
  const ans = choiceOf(a, "operation");
  if (!ans) return null;
  const probabilities = ans.probabilities as Record<string, number>;
  if (!exclude.has(ans.choice as Operation)) return { op: ans.choice as Operation, conf: ans.confidence, probabilities };
  let best: Operation | null = null;
  let bestP = -1;
  for (const [k, p] of Object.entries(probabilities)) if (!exclude.has(k as Operation) && p > bestP) { best = k as Operation; bestP = p; }
  return best ? { op: best, conf: bestP, probabilities } : null;
}

export function decide(a: Answers, ctx: DecideContext): Decision {
  const pk = choiceOf(a, "page_kind");
  const pkProb = (k: PageKind) => (pk ? (pk.probabilities as Record<string, number>)[k] ?? 0 : 0);
  const pkTop = pk ? top3(pk.probabilities as Record<string, number>) : [];
  if (pk) {
    if ((pk.choice === "sign_in_wall" && pk.confidence >= GATES.pageKind) || (pkProb("sign_in_wall") >= GATES.signInProb && ctx.heuristics.signInWall)) {
      return { kind: "handoff", blocked: "needs_sign_in", top: pkTop };
    }
    if (pk.choice === "captcha_or_bot_check" && pk.confidence >= GATES.pageKind) return { kind: "handoff", blocked: "captcha", top: pkTop };
    if ((pk.choice === "consent_or_cookie_banner" || pk.choice === "blocking_dialog") && pk.confidence >= GATES.pageKind) return { kind: "overlay", pageKind: pk.choice };
    if (pk.choice === "empty_or_loading" && pk.confidence >= GATES.pageKind && ctx.memory.waits < LIMITS.waitsPerPage) return { kind: "wait" };
    if (pk.choice === "error_page" && pk.confidence >= GATES.pageKindError) {
      if (ctx.run.errorRetries < LIMITS.errorRetries) return { kind: "go_back", reason: "error_page" };
      return { kind: "blocked", blocked: "impossible", reason: "error page twice", top: pkTop };
    }
  }

  const exclude = new Set<Operation>();
  if (ctx.excludeDone) exclude.add("DONE");
  let picked = pickOperation(a, exclude);
  if (!picked) return { kind: "no_target", reason: "no operation answer", top: [] };

  if (picked.op === "BLOCKED") {
    if (picked.conf >= GATES.blocked) {
      if (pkProb("sign_in_wall") >= GATES.signInProb) return { kind: "handoff", blocked: "needs_sign_in", top: pkTop };
      if (pkProb("captcha_or_bot_check") >= GATES.signInProb) return { kind: "handoff", blocked: "captcha", top: pkTop };
      return { kind: "blocked", blocked: "impossible", reason: "no supported operation can make progress", top: top3(picked.probabilities) };
    }
    exclude.add("BLOCKED");
    picked = pickOperation(a, exclude);
    if (!picked) return { kind: "no_target", reason: "no operation answer", top: [] };
  }

  if (picked.op === "DONE") {
    if (ctx.goal === "extract") return { kind: "extract" };
    if (ctx.goal === "check") {
      const as = choiceOf(a, "answer_state");
      const ev = choiceOf(a, "evidence");
      const evidence = ev && ev.choice !== "none" ? ctx.heads.evidence.find((e) => e.ref === ev.choice) ?? null : null;
      const pYes = as ? (as.probabilities as Record<string, number>)["yes"] ?? 0 : 0;
      if (as && (as.choice === "yes" || as.choice === "no") && as.confidence >= GATES.check) {
        return { kind: "check_done", answer: as.choice === "yes", pYes, confidence: as.confidence, evidence };
      }
      if (ctx.memory.checkHolds >= GATES.checkHolds) {
        return { kind: "check_unknown", pYes, confidence: as?.confidence ?? 0, top: as ? top3(as.probabilities as Record<string, number>) : [], evidence };
      }
      return { kind: "check_hold", confidence: as?.confidence ?? 0 };
    }
    if (ctx.run.doneSuppressed <= 0) return { kind: "verify" };
    exclude.add("DONE");
    picked = pickOperation(a, exclude);
    if (!picked) return { kind: "no_target", reason: "done suppressed", top: [] };
  }

  const valueAns = choiceOf(a, "value");
  const specSpan = valueAns && valueAns.choice !== "none_of_these" ? ctx.spans.find((s) => s.id === valueAns.choice) ?? null : null;
  const specValue = { span: specSpan, conf: valueAns ? valueAns.confidence : null };

  switch (picked.op) {
    case "CLICK": {
      const winners = chooseWinners(a, ctx.heads.clickChunks);
      if (winners.length === 0) {
        const first = choiceOf(a, "click_target_0");
        return { kind: "no_target", reason: "no element matched", top: first ? top3(first.probabilities as Record<string, number>) : [] };
      }
      if (winners.length === 1) {
        const w = winners[0] as Element & { chunkProbability: number; runnerUp: number };
        const ans = choiceOf(a, `click_target_${ctx.heads.clickChunks.findIndex((c) => c.some((e) => e.ref === w.ref))}`);
        const { chunkProbability, runnerUp, ...el } = w;
        return { kind: "candidate", chosen: el, action: "click", targetConf: ans?.confidence ?? chunkProbability, top: chunkProbability, runnerUp, specValue };
      }
      return { kind: "tournament", winners: winners.map(({ runnerUp: _r, ...w }) => w), action: "click" };
    }
    case "TYPE_TEXT": {
      const t = choiceOf(a, "type_text_target");
      const el = t ? ctx.heads.typeTargets.find((e) => e.ref === t.choice) : undefined;
      if (!t || !el) return { kind: "no_target", reason: "no editable field matched", top: t ? top3(t.probabilities as Record<string, number>) : [] };
      const top = (t.probabilities as Record<string, number>)[t.choice] ?? 0;
      return { kind: "candidate", chosen: el, action: "fill", targetConf: t.confidence, top, runnerUp: runnerUpOf(t.probabilities as Record<string, number>, t.choice), specValue };
    }
    case "SELECT": {
      const s = choiceOf(a, "select_target");
      const tgt = s ? ctx.heads.selectTargets.find((x) => x.label === s.choice) : undefined;
      if (!s || !tgt) return { kind: "no_target", reason: "no select option matched", top: s ? top3(s.probabilities as Record<string, number>) : [] };
      const top = (s.probabilities as Record<string, number>)[s.choice] ?? 0;
      return { kind: "candidate", chosen: tgt.el, action: "select", targetConf: s.confidence, top, runnerUp: runnerUpOf(s.probabilities as Record<string, number>, s.choice), specValue: { span: null, conf: s.confidence }, optionLabel: tgt.option, optionRef: tgt.optionRef };
    }
    case "PRESS_KEY": {
      const k = choiceOf(a, "key");
      // The key question is always asked: no answer means the oracle dropped a bad one. A missing head runs no action.
      if (!k) return { kind: "no_target", reason: "no key answer", top: [] };
      const key = k && k.choice !== "none" ? resolveKey(k.choice, ctx.keys) ?? "Enter" : "Enter";
      return { kind: "code_action", action: "press_key", key, conf: picked.conf };
    }
    case "SCROLL_DOWN": return { kind: "scroll", dir: "down" };
    case "SCROLL_UP": return { kind: "scroll", dir: "up" };
    case "GO_BACK": return { kind: "code_action", action: "go_back", conf: picked.conf };
    case "WAIT": return ctx.memory.waits < LIMITS.waitsPerPage ? { kind: "wait" } : { kind: "scroll", dir: "down" };
    case "OPEN_URL": {
      const u = choiceOf(a, "open_url");
      const hit = u && u.choice !== "none" ? ctx.urls.find((x) => x.label === u.choice) : ctx.urls.length === 1 ? ctx.urls[0] : undefined;
      if (!hit) return { kind: "no_target", reason: "no url matched", top: u ? top3(u.probabilities as Record<string, number>) : [] };
      return { kind: "code_action", action: "open_url", url: hit.url, conf: u?.confidence ?? picked.conf };
    }
    default:
      return { kind: "no_target", reason: `unsupported operation ${picked.op}`, top: [] };
  }
}

export function noulSpec(a: Answers): { irreversible: number; submits: number; inScope: number; submitWithEnter: number; valueFromPage: number } {
  return {
    irreversible: noulOf(a, "irreversible"), submits: noulOf(a, "submits"), inScope: noulOf(a, "in_task_scope", 1),
    submitWithEnter: noulOf(a, "submit_with_enter"), valueFromPage: noulOf(a, "value_from_page"),
  };
}
