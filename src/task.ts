// Deterministic text work on the task string. No network.
import type { ProfileEntry } from "./browser.js";
import type { Span } from "./types.js";
import { LIMITS, SECRET_KEY } from "./types.js";

export const VALUE_VERBS = ["search for", "search", "look up", "type", "enter", "fill in", "fill", "write", "put",
  "find", "named", "called", "titled", "with", "as", "to", "for", "into", "query"] as const;

export const CLAUSE_BREAK = /,|;|\.|\bthen\b|\band then\b|\bin the\b|\bon the\b|\binto\b|\busing\b/i;

const URL_RE = /https?:\/\/[^\s"'<>)]+/g;
const DOMAIN_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|co|dev|app|gov|edu|uk|in|de|fr|sh)(?:\/[^\s"'<>)]*)?\b/gi;
const SECRET_LEAD = /password|passcode|pin|otp|secret/i;

function stripTrailing(s: string): string {
  return s.replace(/[.,;:!?)'"]+$/, "");
}

export function extractUrls(task: string): string[] {
  const found: { at: number; url: string }[] = [];
  for (const m of task.matchAll(URL_RE)) found.push({ at: m.index ?? 0, url: stripTrailing(m[0]) });
  for (const m of task.matchAll(DOMAIN_RE)) {
    const at = m.index ?? 0;
    const inside = found.some((f) => at >= f.at && at < f.at + f.url.length);
    if (inside) continue;
    const bare = stripTrailing(m[0]);
    if (/^[\d.]+$/.test(bare) || /\.(?:\d+)$/.test(bare)) continue;   // numbers such as 3.14 are not domains
    found.push({ at, url: `https://${bare}` });
  }
  found.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  for (const f of found) if (!out.some((u) => u.toLowerCase() === f.url.toLowerCase())) out.push(f.url);
  return out;
}

function isSecretAt(task: string, index: number): boolean {
  const before = task.slice(Math.max(0, index - 60), index);
  const words = before.split(/\s+/).filter(Boolean).slice(-4);
  return words.some((w) => SECRET_LEAD.test(w));
}

export function extractSpans(task: string, exclude: string[] = []): Span[] {
  const ex = new Set(exclude.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const out: Span[] = [];
  const seen = new Set<string>();
  const add = (text: string, source: Span["source"], at: number, verb?: string) => {
    const t = text.trim().replace(/\s+/g, " ");
    if (t.length < 1 || t.length > LIMITS.spanChars) return;
    const k = t.toLowerCase();
    if (seen.has(k) || ex.has(k) || out.length >= LIMITS.spans) return;
    seen.add(k);
    const span: Span = { id: `s${out.length + 1}`, text: t, source, secret: isSecretAt(task, at) };
    if (verb) span.verb = verb;
    out.push(span);
  };
  // R1 quoted
  for (const m of task.matchAll(/"([^"]{1,120})"|'([^']{1,120})'|“([^”]{1,120})”|‘([^’]{1,120})’/g)) {
    add(m[1] ?? m[2] ?? m[3] ?? m[4] ?? "", "quoted", m.index ?? 0);
  }
  // R2 tokens
  for (const m of task.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) add(m[0], "email", m.index ?? 0);
  for (const m of task.matchAll(URL_RE)) add(stripTrailing(m[0]), "url", m.index ?? 0);
  for (const m of task.matchAll(/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?\b|\b\d{1,2}(?:st|nd|rd|th)? (?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*(?:,? \d{4})?\b/gi)) {
    add(m[0], "date", m.index ?? 0);
  }
  for (const m of task.matchAll(/(?:[$€£]\s?)?\b\d+(?:[.,]\d+)*(?:\s?(?:%|usd|eur|gbp|kg|km|mb|gb))?\b/gi)) {
    if (/\d/.test(m[0])) add(m[0], "number", m.index ?? 0);
  }
  // R3 after_verb
  const verbRe = new RegExp(`\\b(${VALUE_VERBS.map((v) => v.replace(/ /g, "\\s+")).join("|")})\\s+`, "gi");
  for (const m of task.matchAll(verbRe)) {
    const start = (m.index ?? 0) + m[0].length;
    const rest = task.slice(start);
    const brk = rest.search(CLAUSE_BREAK);
    const clause = stripTrailing((brk >= 0 ? rest.slice(0, brk) : rest).trim());
    const verb = (m[1] ?? "").toLowerCase();
    if (clause.split(/\s+/).length <= 10 && clause.length > 0) add(clause, "after_verb", start, verb);
    const noPrep = clause.replace(/\s+(?:in|on|at|from|of|by|with|for|to)\s+.*$/i, "");
    if (noPrep !== clause && noPrep.length > 0) add(noPrep, "after_verb", start, verb);
  }
  // R4 proper nouns
  for (const m of task.matchAll(/(?:^|[^.!?]\s+)((?:[A-Z][\w'-]*)(?:\s+[A-Z][\w'-]*){0,5})/g)) {
    const at = (m.index ?? 0) + m[0].length - (m[1] ?? "").length;
    if (at > 0) add(m[1] ?? "", "proper_noun", at);
  }
  // R5 clauses
  let pos = 0;
  for (const part of task.split(/,|;|\.|\bthen\b|\band\b/i)) {
    const at = task.indexOf(part, pos);
    pos = at + part.length;
    const stripped = part.trim().replace(/^(?:open|go to|visit|search(?: for)?|click|type|read|check|tell me|get|find)\s+/i, "");
    const words = stripped.split(/\s+/).filter(Boolean);
    if (words.length >= 1 && words.length <= 8) add(stripped, "clause", Math.max(0, at));
  }
  // R6 whole task
  add(task, "whole_task", 0);
  return out;
}

export function varSpans(vars: Record<string, string>): Span[] {
  return Object.entries(vars).map(([k, v]) => ({ id: `v_${k}`, text: v, source: "var" as const, secret: SECRET_KEY.test(k) }));
}

const KEY_WORD = /\b(Enter|Return|Escape|Esc|Tab|Space|Backspace|Delete|Arrow(?:Up|Down|Left|Right)|Page(?:Up|Down)|Home|End|F\d{1,2})\b/g;
const KEY_CHORD = /\b(Ctrl|Control|Cmd|Meta|Alt|Shift)\+([A-Za-z0-9]+)\b/g;
const KEY_NORMAL: Record<string, string> = { esc: "Escape", return: "Enter", cmd: "Meta", ctrl: "Control" };

function normKey(k: string): string {
  const low = k.toLowerCase();
  if (KEY_NORMAL[low]) return KEY_NORMAL[low] as string;
  return k.length === 1 ? k.toLowerCase() : k.charAt(0).toUpperCase() + k.slice(1);
}

export function extractKeys(task: string): { label: string; key: string }[] {
  const out: { label: string; key: string }[] = [];
  const seen = new Set<string>();
  const push = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label: `k${out.length + 1}`, key });
  };
  for (const m of task.matchAll(KEY_CHORD)) push(`${normKey(m[1] ?? "")}+${(m[2] ?? "").length === 1 ? (m[2] ?? "").toLowerCase() : normKey(m[2] ?? "")}`);
  for (const m of task.replace(KEY_CHORD, " ").matchAll(KEY_WORD)) push(normKey(m[1] ?? ""));
  return out;
}

export function extractProfileMentions(task: string, profiles: ProfileEntry[]): ProfileEntry[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return profiles.filter((p) => {
    const names = [p.name, p.directory].filter((n) => n.length >= 2);
    return names.some((n) => new RegExp(`(?<![\\w-])${esc(n)}(?![\\w-])`, "i").test(task));
  });
}

export function mentionsProfileWord(task: string): boolean {
  return /\bprofile\b|\bchrome\b|\baccount\b/i.test(task);
}

export function redact(text: string, spans: Span[]): string {
  let out = text;
  for (const s of spans.filter((s) => s.secret && s.text.length > 0).sort((a, b) => b.text.length - a.text.length)) {
    out = out.split(s.text).join("***");
  }
  return out;
}

/** Copy JSON data and redact string values before JSON escaping. Preserve option ids and object keys. */
export function redactData<T>(value: T, redactor: (text: string) => string): T {
  if (typeof value === "string") return redactor(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactData(v, redactor)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactData(v, redactor)])) as T;
  }
  return value;
}
