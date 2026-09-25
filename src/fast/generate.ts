// Assistant-written text for the fast engine: the fields of one text request, the request itself,
// and the checks on the reply. Pure functions. No I/O.
//
// The user's assistant (the harness model behind the MCP server) writes new text, such as a reply.
// Jev still chooses the field and every action. Code binds each text to the field it was written for,
// removes secrets and invisible characters from what the assistant reads, and rejects replies that hold
// a secret value, a key, or a token.
import type { TextField, TextRequest } from "../io.js";
import type { Span } from "../types.js";
import { KEY_PATTERN, LIMITS } from "../types.js";
import type { Action, EditPlan, FastHistoryEntry, Observation } from "./model.js";
import { actionKey, canWriteInto, cutLines, cutText } from "./policy.js";

/** One field of a text request and the observed action it came from. */
export interface PickedField { field: TextField; action: Action }

const FORMAT = /\p{Cf}/u;
const JOINERS = new Set(["\u200C", "\u200D"]);
/** A joiner stays only between two visible characters. */
const joins = (c: string | undefined): boolean => c !== undefined && !/\s/u.test(c) && !FORMAT.test(c);

/**
 * Remove characters that can hide or reorder text: C0 and C1 controls (tab and newline stay), every
 * format character (bidi controls, zero-width characters, soft hyphen, tag characters), and variation
 * selectors that do not follow a visible character. A single ZWJ or ZWNJ between two visible characters
 * stays, so emoji sequences and Persian words keep their form. Line and paragraph separators become "\n".
 */
export function sanitizeText(s: string): string {
  const plain = s.replace(/\r\n?|[\u0085\u2028\u2029]/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
  const chars = Array.from(plain);
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    if (FORMAT.test(c) && !(JOINERS.has(c) && joins(chars[i - 1]) && joins(chars[i + 1]))) continue;
    out += c;
  }
  return out
    .replace(/[\u{E0100}-\u{E01EF}]/gu, "")
    .replace(/([\uFE00-\uFE0F])[\uFE00-\uFE0F]+/g, "$1")
    .replace(/(^|\s)[\uFE00-\uFE0F]+/g, "$1");
}

/** sanitizeText, then every whitespace run becomes one space, then trim. For labels, titles, hosts, and dialog lines. */
export function flatText(s: string): string {
  return sanitizeText(s).replace(/\s+/g, " ").trim();
}

/** `new URL(url).host`; "local file" for file: URLs; "" when the URL does not parse. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "file:" ? "local file" : u.host;
  } catch {
    return "";
  }
}

/**
 * The fields of one text request. `f1` is the target Jev chose; the caller has checked it with
 * `canWriteInto`. Up to `LIMITS.textFields - 1` more fields follow in document order: empty, writable,
 * in the same form as the target, not banned, and not bound to a generated value already.
 * Every string is redacted first, then sanitized, then cut, so a cut never keeps part of a secret.
 * `held`: the target holds text that the run did not type, and Jev chose this mode for it. Its `current_value` is then
 * longer, so the assistant can read the text that it adds to or replaces, and an append sets `mode`: the assistant
 * writes only the new text.
 */
export function pickFields(obs: Observation, target: Action, skip: { banned: Set<string>; bound: Set<number> }, redactor: (s: string) => string, held?: EditPlan): PickedField[] {
  const picked: Action[] = [target];
  const nodes = new Set<number | null>([target.node]);
  if (target.form !== undefined && target.form !== null) {
    for (const a of obs.actions) {
      if (picked.length >= LIMITS.textFields) break;
      if (a.node === null || nodes.has(a.node) || skip.bound.has(a.node)) continue;
      if (a.form !== target.form || !canWriteInto(a) || (a.value ?? "").trim() !== "" || skip.banned.has(actionKey(a))) continue;
      nodes.add(a.node);
      picked.push(a);
    }
  }
  return picked.map((a, i) => ({
    action: a,
    field: {
      id: `f${i + 1}`,
      label: cutText(flatText(redactor(a.label)), LIMITS.nameChars),
      role: a.role ?? "textbox",
      required: i === 0,
      multiline: a.multiline === true,
      max_chars: Math.min(a.maxLength ?? LIMITS.generatedChars, LIMITS.generatedChars),
      current_value: i === 0 && held ? cutLines(sanitizeText(redactor(a.value ?? "")), LIMITS.heldValueChars) : cutText(sanitizeText(redactor(a.value ?? "")), LIMITS.valueChars),
      ...(i === 0 && held?.mode === "append" ? { mode: "append" as const } : {}),
    },
  }));
}

/** The request the assistant answers. The key order is fixed, and the page text is the last key. */
export function buildTextRequest(a: { id: string; task: string; obs: Observation; history: FastHistoryEntry[]; fields: TextField[]; redactor: (s: string) => string }): TextRequest {
  const r = a.redactor;
  return {
    id: a.id,
    goal: sanitizeText(r(a.task)),
    page: { url: cutText(r(a.obs.url), LIMITS.urlChars), title: cutText(flatText(r(a.obs.title)), LIMITS.titleChars) },
    fields: a.fields,
    recent_actions: a.history.slice(-LIMITS.textHistory).map((h) => ({ action: flatText(r(h.action)), kind: flatText(r(h.kind)), text: h.text === null ? null : flatText(r(h.text)) })),
    untrusted_page_text: sanitizeText(r(a.obs.text)).slice(0, LIMITS.textChars),
  };
}

/** The name of a secret span in an error: the var key, or the span id for a secret cut from the task. */
const secretName = (s: Span): string => (s.source === "var" && s.id.startsWith("v_") ? s.id.slice(2) : s.id);

/**
 * Normalize and check the assistant's texts. Returns the texts to type (empty optional fields dropped)
 * and one error per bad field id. An error message never holds a value.
 */
export function checkTexts(values: Record<string, string>, fields: TextField[], spans: Span[]): { values: Record<string, string>; errors: Record<string, string> } {
  const out: Record<string, string> = {};
  const errors: Record<string, string> = {};
  const byId = new Map(fields.map((f) => [f.id, f]));
  const secrets = spans.filter((s) => s.secret && s.text.length >= LIMITS.secretMinChars);
  let total = 0;
  for (const [id, raw] of Object.entries(values)) {
    const field = byId.get(id);
    if (!field) { errors[id] = "unknown field id"; continue; }
    let v = sanitizeText(String(raw).replace(/\r\n?/g, "\n")).trim();
    if (!field.multiline) v = v.replace(/\s*\n\s*/g, " ");
    if (v === "") continue;
    total += v.length;
    const secret = secrets.find((s) => v.includes(s.text));
    if (v.length > field.max_chars) errors[id] = `longer than ${field.max_chars} characters`;
    else if (secret) errors[id] = `holds the secret value "${secretName(secret)}"; write it without that value`;
    else if (KEY_PATTERN.test(v)) errors[id] = "looks like a key or token; remove it";
    else out[id] = v;
  }
  for (const f of fields) if (f.required && out[f.id] === undefined && errors[f.id] === undefined) errors[f.id] = "text is required";
  const first = fields.find((f) => f.required) ?? fields[0];
  if (first && total > LIMITS.generatedChars && errors[first.id] === undefined) errors[first.id] = `the texts together are longer than ${LIMITS.generatedChars} characters`;
  return { values: out, errors };
}
