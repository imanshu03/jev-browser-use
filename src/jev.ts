import { redactData } from "./task.js";
// Thin Oracle over TypeSafeClient. Counts requests and tokens. Checks size before sending.
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
      const t0 = Date.now();
      const est = estimateTokens({ state, questions });
      log.debug(`jev ${name}: ${Object.keys(questions).length} questions, ~${est} tokens`, state);
      const r = await client.systemOne({ state, questions, model });
      stats.ms += Date.now() - t0;
      stats.requests += 1;
      stats.inputTokens += r.usage.input_tokens;
      stats.outputTokens += r.usage.output_tokens;
      stats.model = r.model;
      log.debug(`jev ${name} done in ${Date.now() - t0}ms: ${r.usage.input_tokens} in / ${r.usage.output_tokens} out`, r.answers);
      return { answers: r.answers as Answers, model: r.model, usage: r.usage };
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
