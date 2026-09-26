// Scripted fakes: Browser, Oracle, Human, TextSource, Logger. Jev and agent-browser are never called in unit tests.
import type { Fetch, Questions } from "@typesafe-ai/sdk";
import type { Browser, ProfileEntry, SnapshotData } from "../src/browser.js";
import { BrowserError } from "../src/browser.js";
import type { ConfirmDetail, Human, Logger, PauseKind, PauseResult, TextReply, TextRequest, TextSource, TextWriteOptions } from "../src/io.js";
import type { Answer, Answers, Oracle } from "../src/jev.js";
import type { Transport } from "../src/transport.js";
import type { StepRecord } from "../src/types.js";

export interface FakePage { url: string; title: string; interactive: SnapshotData; full?: SnapshotData; text: string }

export interface BrowserScript {
  pages: Record<string, FakePage>;
  start: string;
  transitions?: (call: string[], current: string) => string | { error: BrowserError } | undefined;
  profiles?: ProfileEntry[];
}

/** Build SnapshotData from a tree string; refs are read from `[ref=eN]`. */
export function snap(tree: string): SnapshotData {
  const refs: Record<string, { role: string; name: string }> = {};
  for (const line of tree.split("\n")) {
    const m = line.match(/^\s*- (\S+?)(?: "((?:[^"\\]|\\.)*)")?((?:\s\[[^\]]*\])*)/);
    const ref = m?.[3]?.match(/ref=(e\d+)/)?.[1];
    if (m && ref) refs[ref] = { role: m[1] ?? "", name: (m[2] ?? "").replace(/\\"/g, '"') };
  }
  return { origin: "", refs, removedRefs: [], snapshot: tree };
}

export function fakeBrowser(script: BrowserScript): Browser & { calls: string[][]; current: string } {
  const b = {
    calls: [] as string[][],
    current: script.start,
    lastWarning: null as string | null,
    page(): FakePage { const p = script.pages[b.current]; if (!p) throw new Error(`fake page ${b.current} missing`); return p; },
    async run(call: string[]): Promise<void> {
      b.calls.push(call);
      const t = script.transitions?.(call, b.current);
      if (t && typeof t === "object") throw t.error;
      if (typeof t === "string") b.current = t;
    },
    async profiles() { b.calls.push(["profiles"]); return script.profiles ?? []; },
    async open(url: string) { await b.run(["open", url]); return { url: b.page().url, title: b.page().title }; },
    async snapshot(o: { interactive: boolean; compact?: boolean; depth?: number; selector?: string; urls?: boolean }) {
      await b.run(["snapshot", o.interactive ? "-i" : "full"]);
      const p = b.page();
      return o.interactive ? p.interactive : (p.full ?? p.interactive);
    },
    async click(ref: string) { await b.run(["click", `@${ref}`]); },
    async fill(ref: string, text: string) { await b.run(["fill", `@${ref}`, text]); },
    async press(key: string) { await b.run(["press", key]); },
    async select(ref: string, label: string) { await b.run(["select", `@${ref}`, label]); },
    async check(ref: string) { await b.run(["check", `@${ref}`]); },
    async uncheck(ref: string) { await b.run(["uncheck", `@${ref}`]); },
    async hover(ref: string) { await b.run(["hover", `@${ref}`]); },
    async scroll(dir: "up" | "down", px: number) { await b.run(["scroll", dir, String(px)]); },
    async scrollIntoView(ref: string) { await b.run(["scrollintoview", `@${ref}`]); },
    async back() { await b.run(["back"]); },
    async waitLoad(state: string) { b.calls.push(["wait", "--load", state]); return true; },
    async waitMs(ms: number) { b.calls.push(["wait", String(ms)]); },
    async getUrl() { b.calls.push(["get", "url"]); return b.page().url; },
    async getTitle() { b.calls.push(["get", "title"]); return b.page().title; },
    async getText() { b.calls.push(["get", "text", "body"]); return b.page().text; },
    async getValue() { return ""; },
    async dialogDismiss() { b.calls.push(["dialog", "dismiss"]); },
    async screenshot(path: string) { b.calls.push(["screenshot", path]); },
    async close() { b.calls.push(["close"]); },
  };
  return b as unknown as Browser & { calls: string[][]; current: string };
}

/** Partial answers: a string means a choice (confidence 0.9); a number means a noul; objects are merged. */
export type PartialAnswers = Record<string, string | number | { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number; score?: number }>;
export type OracleScript =
  | Array<{ name: string | RegExp; answers: (state: unknown, questions: Questions) => PartialAnswers }>
  | ((name: string, state: unknown, questions: Questions) => PartialAnswers);

function completeChoice(labels: string[], given: { choice?: string; confidence?: number; probabilities?: Record<string, number> } | undefined): Answer {
  const fallback = labels.find((l) => l === "none" || l === "none_of_these" || l === "no_profile_mentioned") ?? labels[0] ?? "none";
  const choice = given?.choice && labels.includes(given.choice) ? given.choice : given?.choice ?? fallback;
  const confidence = given?.confidence ?? (given?.choice ? 0.9 : 0.5);
  let probabilities = given?.probabilities;
  if (!probabilities) {
    probabilities = {};
    const rest = labels.filter((l) => l !== choice);
    for (const l of rest) probabilities[l] = rest.length > 0 ? Number(((1 - confidence) / rest.length).toFixed(4)) : 0;
    probabilities[choice] = confidence;
  }
  return { type: "choice", choice, confidence, probabilities };
}

export function fakeOracle(script: OracleScript): Oracle & { requests: { name: string; state: unknown; questions: Questions }[] } {
  const requests: { name: string; state: unknown; questions: Questions }[] = [];
  const stats = { requests: 0, inputTokens: 0, outputTokens: 0, model: "jev-fake", ms: 0 };
  return {
    stats,
    requests,
    async ask(name, state, questions) {
      requests.push({ name, state, questions });
      stats.requests += 1;
      stats.ms += 7;
      stats.inputTokens += 100;
      stats.outputTokens += 10;
      let partial: PartialAnswers = {};
      if (typeof script === "function") partial = script(name, state, questions);
      else {
        const hit = script.find((s) => (typeof s.name === "string" ? s.name === name : s.name.test(name)));
        if (hit) partial = hit.answers(state, questions);
      }
      const answers: Answers = {};
      for (const [qn, q] of Object.entries(questions)) {
        // A script answers `type_text_value` for the field that its TYPE_TEXT target chooses. The step request asks one
        // value head per field (`value_<key>`), so that answer serves every value head that the script does not answer.
        // `type_text_mode` serves the mode heads (`mode_<key>`) in the same way.
        const g = partial[qn] ?? (/^value_/.test(qn) ? partial["type_text_value"] : /^mode_/.test(qn) ? partial["type_text_mode"] : undefined);
        // Defaults: noul 0.05, except the scope and target_ok guards, which default to 0.9 so scripted actions pass the gate.
        const defaultNoul = /^(in_task_scope|target_ok)$/.test(qn) ? 0.9 : 0.05;
        if (q.type === "noul") answers[qn] = { type: "noul", noul: typeof g === "number" ? g : typeof g === "object" && g.noul !== undefined ? g.noul : defaultNoul };
        else if (q.type === "choice") {
          const labels = Object.keys(q.criteria);
          const given = typeof g === "string" ? { choice: g } : typeof g === "object" ? g : undefined;
          answers[qn] = completeChoice(labels, given);
        } else {
          const s = typeof g === "number" ? g : typeof g === "object" && g.score !== undefined ? g.score : 0;
          answers[qn] = { type: "score", score: s, confidence: 0.5, legend: q.criteria as never, probabilities: {} as never };
        }
      }
      return { answers, model: "jev-fake", usage: { input_tokens: 100, output_tokens: 10 } };
    },
  };
}

/** `details` and `kinds` record the structured confirm detail and the pause kind of each call, in order. */
export function fakeHuman(script: { interactive: boolean; pause?: PauseResult[]; confirm?: boolean[] }): Human & { prompts: string[]; details: (ConfirmDetail | undefined)[]; kinds: (PauseKind | undefined)[] } {
  const prompts: string[] = [];
  const details: (ConfirmDetail | undefined)[] = [];
  const kinds: (PauseKind | undefined)[] = [];
  const pauses = [...(script.pause ?? [])];
  const confirms = [...(script.confirm ?? [])];
  return {
    interactive: script.interactive,
    prompts, details, kinds,
    async pause(message, _timeout, poll, kind) {
      prompts.push(`pause:${message}`);
      kinds.push(kind);
      const scripted = pauses.shift();
      if (scripted) return scripted;
      if (poll && (await poll())) return "resumed";
      return "timeout";
    },
    async confirm(message, _timeout, detail) { prompts.push(`confirm:${message}`); details.push(detail); return confirms.shift() ?? false; },
  };
}

export type TextStep = TextReply | ((req: TextRequest, opts: TextWriteOptions) => TextReply | Promise<TextReply>);

/**
 * A scripted assistant that writes field text. Each step answers one request, in order; a function step
 * can call `opts.check`. With no step left it declines. `requests` and `options` record every call.
 */
export function fakeText(steps: TextStep[] = []): TextSource & { requests: TextRequest[]; options: TextWriteOptions[] } {
  const requests: TextRequest[] = [];
  const options: TextWriteOptions[] = [];
  const queue = [...steps];
  return {
    requests, options,
    async write(req, opts) {
      requests.push(req);
      options.push(opts);
      const next = queue.shift();
      if (next === undefined) return { kind: "declined", reason: "fake: no scripted text" };
      return typeof next === "function" ? next(req, opts) : next;
    },
  };
}

/** A Transport that never opens a socket. `fetch` throws unless the test passes one. */
export function fakeTransport(fetch?: Fetch): Transport & { warms: string[]; keeps: boolean[]; closes: number } {
  const t = {
    warms: [] as string[], keeps: [] as boolean[], closes: 0, stats: { connections: 0 },
    fetch: fetch ?? (async (input: string): Promise<Response> => { throw new Error(`fake transport: no network for ${input}`); }),
    async warm(baseURL: string, opts?: { keep?: boolean }) { t.warms.push(baseURL); t.keeps.push(opts?.keep === true); },
    async close() { t.closes += 1; },
  };
  return t;
}

export function fakeLogger(): Logger & { lines: string[]; steps: StepRecord[] } {
  const lines: string[] = [];
  const steps: StepRecord[] = [];
  const log = {
    lines, steps,
    redactor: (s: string) => s,
    info(msg: string) { lines.push(`INFO ${log.redactor(msg)}`); },
    warn(msg: string) { lines.push(`WARN ${log.redactor(msg)}`); },
    debug(msg: string) { lines.push(`DEBUG ${log.redactor(msg)}`); },
    step(rec: StepRecord) { steps.push(rec); lines.push(`STEP ${rec.step} ${rec.action} ${rec.result}`); },
  };
  return log;
}
