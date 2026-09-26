// Thin Oracle over TypeSafeClient. Counts requests and tokens. Checks size before sending.
// The answer check is ported from browser-use/jev-ultrafast (jev_ultrafast/model.py). MIT License, Copyright (c) 2026 Browser Use.
import { redactData } from "./task.js";
import type { ChoiceResponse, EntryType, NoulResponse, Questions, ScoreResponse, TypeSafeClient, Usage } from "@typesafe-ai/sdk";
import { LIMITS } from "./types.js";
import type { Logger } from "./io.js";

export type Answer = ChoiceResponse | NoulResponse | ScoreResponse;
export type Answers = Record<string, Answer>;
export interface AskResult { answers: Answers; model: string; usage: Usage }

export interface Oracle {
  ask(name: string, state: EntryType, questions: Questions): Promise<AskResult>;
  /** `ms` is the sum of request round trips. */
  readonly stats: { requests: number; inputTokens: number; outputTokens: number; model: string; ms: number };
}

export class BudgetError extends Error {
  estimatedTokens: number;
  limit: number;
  part: "request" | "state_plus_longest";
  constructor(estimatedTokens: number, limit: number, part: "request" | "state_plus_longest") {
    super(`request too large: ~${estimatedTokens} tokens over the ${part} limit ${limit}`);
    this.name = "BudgetError";
    this.estimatedTokens = estimatedTokens;
    this.limit = limit;
    this.part = part;
  }
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? null).length / LIMITS.charsPerToken);
}

export function checkBudget(state: EntryType, questions: Questions): void {
  const total = estimateTokens({ state, questions });
  if (total > LIMITS.tokenRequest) throw new BudgetError(total, LIMITS.tokenRequest, "request");
  const s = estimateTokens(state);
  let longest = 0;
  for (const q of Object.values(questions)) longest = Math.max(longest, estimateTokens(q));
  if (s + longest > LIMITS.tokenStatePlusLongest) throw new BudgetError(s + longest, LIMITS.tokenStatePlusLongest, "state_plus_longest");
}

export function assertOptionCount(questions: Questions): void {
  for (const [name, q] of Object.entries(questions)) {
    if (q.type !== "choice") continue;
    const n = Object.keys(q.criteria).length;
    if (n > 255) throw new Error(`question ${name} has ${n} options; the limit is 255`);
    if (n < 1) throw new Error(`question ${name} has no options`);
  }
}

/**
 * Why a choice answer has a bad shape, or null when it is good. The chosen label must be an option of its question, and
 * the probabilities must be options too, each a finite number from 0 to 1, with a sum of 1 (0.02 tolerance). The chosen
 * label must have the highest probability. As browser-use/jev-ultrafast `validate_choice` (jev_ultrafast/model.py;
 * MIT License, Copyright (c) 2026 Browser Use).
 */
export function choiceProblem(answer: ChoiceResponse, question: Questions[string] | undefined): string | null {
  const options = question?.type === "choice" ? new Set(Object.keys(question.criteria)) : null;
  const probs = answer.probabilities as Record<string, unknown> | undefined;
  if (typeof answer.choice !== "string" || (options !== null && !options.has(answer.choice))) return `choice "${String(answer.choice)}" is not an option`;
  if (!probs || typeof probs !== "object") return "no probabilities";
  const unit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  if (!unit(answer.confidence)) return `confidence ${String(answer.confidence)} is not a number from 0 to 1`;
  let sum = 0;
  let top = 0;
  for (const [label, p] of Object.entries(probs)) {
    if (options !== null && !options.has(label)) return `probability for "${label}", which is not an option`;
    if (!unit(p)) return `probability ${String(p)} for "${label}" is not a number from 0 to 1`;
    sum += p;
    top = Math.max(top, p);
  }
  if (Math.abs(sum - 1) >= 0.02) return `probabilities add up to ${sum.toFixed(3)}, not 1`;
  const chosen = probs[answer.choice];
  if (!unit(chosen) || chosen < top - 1e-6) return `choice "${answer.choice}" does not have the highest probability`;
  return null;
}

/** Read a choice answer by name; null when absent or of another type. */
export function choiceOf(a: Answers, name: string): ChoiceResponse | null {
  const v = a[name];
  return v && v.type === "choice" ? v : null;
}

/** Read a noul answer by name; `fallback` when absent. */
export function noulOf(a: Answers, name: string, fallback = 0): number {
  const v = a[name];
  return v && v.type === "noul" ? v.noul : fallback;
}

export function createOracle(client: TypeSafeClient, model: string, log: Logger): Oracle {
  const stats = { requests: 0, inputTokens: 0, outputTokens: 0, model, ms: 0 };
  return {
    stats,
    async ask(name, state, questions) {
      assertOptionCount(questions);
      checkBudget(state, questions);
      const est = estimateTokens({ state, questions });
      log.debug(`jev ${name}: ${Object.keys(questions).length} questions, ~${est} tokens`, state);
      const send = async () => {
        const t0 = Date.now();
        const r = await client.systemOne({ state, questions, model });
        stats.ms += Date.now() - t0;
        stats.requests += 1;
        stats.inputTokens += r.usage.input_tokens;
        stats.outputTokens += r.usage.output_tokens;
        stats.model = r.model;
        log.debug(`jev ${name} done in ${Date.now() - t0}ms: ${r.usage.input_tokens} in / ${r.usage.output_tokens} out`, r.answers);
        return r;
      };
      /** The choice answers with a bad shape, and why. */
      const problems = (answers: Answers): [string, string][] => Object.entries(answers).flatMap(([key, a]) => {
        const problem = a?.type === "choice" ? choiceProblem(a, questions[key]) : null;
        return problem === null ? [] : [[key, problem] as [string, string]];
      });
      let r = await send();
      // A choice answer with a bad shape: the request goes out one time more (it is rare: none in 434 logged answers,
      // then a choice that did not have the highest probability). A head that is bad again is dropped before any code
      // reads it: a missing head never runs an action.
      if (problems(r.answers as Answers).length > 0) {
        for (const [key, problem] of problems(r.answers as Answers)) log.warn(`jev ${name}: answer "${key}" has a bad shape (${problem}); asking again`);
        r = await send();
      }
      const answers: Answers = { ...(r.answers as Answers) };
      for (const [key, problem] of problems(answers)) {
        delete answers[key];
        log.warn(`jev ${name}: answer "${key}" dropped: ${problem}`);
      }
      return { answers, model: r.model, usage: r.usage };
    },
  };
}

/** Redact every request, including plan and hand-off requests, before it reaches the client or logger. */
export function redactingOracle(oracle: Oracle, redactor: (text: string) => string): Oracle {
  return {
    get stats() { return oracle.stats; },
    ask(name, state, questions) {
      return oracle.ask(name, redactData(state, redactor), redactData(questions, redactor));
    },
  };
}
