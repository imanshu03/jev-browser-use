// Expected results. Code checks poll the page until they pass or time out; `check` asks Jev and `judge` asks the LLM.
import type { Observation, PageRead } from "@imanshu03/jev-browser-use";
import type { Llm } from "./llm.js";
import type { Assertion } from "./schema.js";
import type { Session } from "./session.js";
import { fillVars } from "./template.js";

export interface AssertResult {
  pass: boolean;
  label: string;
  detail: string;
  /** A model decided the result (check, judge). The report marks it. */
  model?: "jev" | "llm";
}

export interface AssertContext {
  session: Session;
  vars: Record<string, string>;
  llm: Llm | null;
  timeoutMs: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const DEFAULT_MIN_PROBABILITY = 0.7;

export function norm(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export function pageText(read: PageRead | null, obs: Observation): string {
  const blocks = read?.text.map((b) => b.text).filter(Boolean) ?? [];
  return blocks.length > 0 ? blocks.join("\n") : obs.text;
}

/** Rows of every table and record list: a table row is its cells, a record is its slot texts. */
export function pageRows(read: PageRead | null): string[][] {
  if (!read) return [];
  return [...read.tables.flatMap((t) => t.rows.map((r) => r.cells)), ...read.groups.flatMap((g) => g.records.map((r) => r.slots.map((s) => s.text)))];
}

export function describe(a: Assertion, vars: Record<string, string>): string {
  const f = (s: string) => JSON.stringify(fillVars(s, vars));
  if ("url_contains" in a) return `URL contains ${f(a.url_contains)}`;
  if ("url_matches" in a) return `URL matches /${fillVars(a.url_matches, vars)}/`;
  if ("title_contains" in a) return `title contains ${f(a.title_contains)}`;
  if ("visible_text" in a) return `page shows ${f(a.visible_text)}`;
  if ("not_visible_text" in a) return `page does not show ${f(a.not_visible_text)}`;
  if ("element" in a) return `${a.element.role ?? "control"} ${f(a.element.name)} is ${a.element.present ? "present" : "absent"}`;
  if ("field_value" in a) return `field ${f(a.field_value.field)} holds ${f(a.field_value.value)}`;
  if ("row_contains" in a) return `a row holds ${a.row_contains.map(f).join(", ")}`;
  if ("check" in a) return `Jev check: ${fillVars(a.check, vars)}`;
  return `LLM judge: ${fillVars(a.judge, vars)}`;
}

type Probe = () => Promise<{ pass: boolean; detail: string }>;

function probeOf(a: Assertion, ctx: AssertContext): Probe {
  const s = ctx.session;
  const v = (x: string) => fillVars(x, ctx.vars);
  if ("url_contains" in a) return async () => { const u = await s.url(); return { pass: u.includes(v(a.url_contains)), detail: `URL is ${u}` }; };
  if ("url_matches" in a) {
    const re = new RegExp(v(a.url_matches));
    return async () => { const u = await s.url(); return { pass: re.test(u), detail: `URL is ${u}` }; };
  }
  if ("title_contains" in a) return async () => { const o = await s.observe(); return { pass: norm(o.title).includes(norm(v(a.title_contains))), detail: `title is ${JSON.stringify(o.title)}` }; };
  if ("visible_text" in a || "not_visible_text" in a) {
    const want = norm(v("visible_text" in a ? a.visible_text : a.not_visible_text));
    const present = "visible_text" in a;
    return async () => {
      const [read, obs] = [await s.read().catch(() => null), await s.observe()];
      const has = norm(pageText(read, obs)).includes(want);
      return { pass: has === present, detail: has ? "the text is on the page" : "the text is not on the page" };
    };
  }
  if ("element" in a) {
    const name = norm(v(a.element.name));
    return async () => {
      const obs = await s.observe();
      const hits = obs.actions.filter((x) => norm(x.label.split(" → ")[0] ?? x.label) === name && (!a.element.role || x.role === a.element.role));
      return { pass: (hits.length > 0) === a.element.present, detail: `${hits.length} matching control(s) in view` };
    };
  }
  if ("field_value" in a) {
    const field = norm(v(a.field_value.field));
    const want = norm(v(a.field_value.value));
    return async () => {
      const obs = await s.observe();
      const f = obs.actions.find((x) => (x.kind === "fill" || x.kind === "select") && norm(x.label.split(" → ")[0] ?? x.label) === field);
      if (!f) return { pass: false, detail: "no such field in view" };
      const got = f.kind === "select" ? (f.current_value ?? "") : (f.value ?? "");
      return { pass: norm(got) === want, detail: `the field holds ${JSON.stringify(got)}` };
    };
  }
  if ("row_contains" in a) {
    const wants = a.row_contains.map((x) => norm(v(x)));
    return async () => {
      const rows = pageRows(await s.read());
      const hit = rows.some((cells) => { const n = cells.map(norm); return wants.every((w) => n.some((c) => c.includes(w))); });
      return { pass: hit, detail: `${rows.length} row(s) read` };
    };
  }
  throw new Error("not a polled assertion");
}

export async function runAssertion(a: Assertion, ctx: AssertContext): Promise<AssertResult> {
  const label = describe(a, ctx.vars);
  if ("check" in a) {
    const r = await ctx.session.jev(fillVars(a.check, ctx.vars), ctx.vars, "check");
    const min = a.min_probability ?? DEFAULT_MIN_PROBABILITY;
    if (!r.check) return { pass: false, label, detail: `Jev gave no answer: ${r.reason}`, model: "jev" };
    const pass = r.check.answer === true && r.check.probability >= min;
    return { pass, label, detail: `Jev answered ${String(r.check.answer)} (p=${r.check.probability.toFixed(2)}, need yes at ${min})`, model: "jev" };
  }
  if ("judge" in a) {
    if (!ctx.llm) return { pass: false, label, detail: "a judge check needs the LLM: set llm.base_url and llm.model", model: "llm" };
    const [read, obs] = [await ctx.session.read().catch(() => null), await ctx.session.observe()];
    const verdict = await ctx.llm.judge(fillVars(a.judge, ctx.vars), { url: obs.url, title: obs.title, text: pageText(read, obs) });
    return { pass: verdict.pass, label, detail: verdict.reason, model: "llm" };
  }
  const probe = probeOf(a, ctx);
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = ctx.now ?? (() => Date.now());
  const deadline = now() + (a.timeout_ms ?? ctx.timeoutMs);
  for (;;) {
    let last: { pass: boolean; detail: string };
    try { last = await probe(); } catch (e) { last = { pass: false, detail: `the page could not be read: ${(e as Error).message}` }; }
    if (last.pass || now() >= deadline) return { pass: last.pass, label, detail: last.detail };
    await sleep(ctx.pollMs ?? 300);
  }
}
