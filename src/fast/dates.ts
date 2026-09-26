// Date fields of the fast engine: which task date a date field can take, the text of each part, the order to type the
// parts, and the checks before a date picker is confirmed. Pure functions. No I/O.
//
// Jev chooses which task date goes into which date field (a value head that offers only dates). Code turns the date
// into the field's own input, types it (Page.setDate), and reads the field back.
import { isDate, parseDate } from "../task.js";
import type { DateFact, DateValue, Span } from "../types.js";
import { GATES } from "../types.js";
import type { Action, DateInfo, DatePartName, DatePlan, Observation } from "./model.js";

/** YYYY-MM-DD. */
export function isoOf(v: DateValue): string {
  return `${v.y}-${String(v.m).padStart(2, "0")}-${String(v.d).padStart(2, "0")}`;
}

function fromIso(s: string): DateValue | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const v = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return isDate(v.y, v.m, v.d) ? v : null;
}

/**
 * The date of span fact `f` in a field, or null when the fact does not hold there. An ambiguous numeric date ("9/1/2026")
 * holds only in a field of the same shape: its parts in month-day-year or day-month-year order with the same separator.
 * The numbers then go into the parts in the order that the user wrote them.
 */
export function dateFor(f: DateFact, info: DateInfo): DateValue | null {
  if (f.ambiguous === undefined) return { y: f.y, m: f.m, d: f.d };
  if (info.sep !== f.ambiguous) return null;
  if (info.order === "MDY") return { y: f.y, m: f.m, d: f.d };
  if (info.order === "DMY" && isDate(f.y, f.d, f.m)) return { y: f.y, m: f.d, d: f.m };
  return null;
}

/** A time as HH:MM, or HH:MM:SS when the seconds are not 0. Null when the text is not a time. */
function timeOf(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) return null;
  const hm = `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
  return m[3] !== undefined && m[3] !== "00" ? `${hm}:${m[3]}` : hm;
}

/**
 * The value that date field `a` must show to hold span `s`, in the field's own value form: YYYY-MM-DD for a date group and
 * a date input, YYYY-MM for a month input. A datetime-local, time, or week input takes only a span that is already a
 * value of that input ("2026-09-01T10:30", "10:30", "2026-W36"). Null when the span does not fit the field.
 */
export function wantOf(a: Action, s: Span): string | null {
  const info = a.date;
  if (!info) return null;
  if (info.kind === "group" || info.kind === "date") {
    const v = s.date ? dateFor(s.date, info) : null;
    return v ? isoOf(v) : null;
  }
  if (info.kind === "month") {
    const v = s.date ? dateFor(s.date, info) : null;
    if (v) return isoOf(v).slice(0, 7);
    return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(s.text.trim()) ? s.text.trim() : null;
  }
  if (info.kind === "time") return timeOf(s.text);
  if (info.kind === "week") return /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(s.text.trim()) ? s.text.trim() : null;
  const m = s.text.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2})?)$/);
  const t = m ? timeOf(m[2] ?? "") : null;
  return m && t && fromIso(m[1] ?? "") ? `${m[1]}T${t}` : null;
}

/** The numbers of a group's parts now. NaN for an empty part or a part that is not a number. */
function partsNow(info: DateInfo): Record<DatePartName, number> {
  const out: Record<DatePartName, number> = { month: NaN, day: NaN, year: NaN };
  for (const p of info.parts ?? []) {
    const n = /^\d{1,4}$/.test(p.value.trim()) ? Number(p.value.trim()) : NaN;
    out[p.part] = p.part === "year" && info.short === true && !Number.isNaN(n) ? 2000 + n : n;
  }
  return out;
}

/** The value that date field `a` shows now, in the same form as `wantOf`. Null when it shows no whole value. */
export function shownOf(a: Action): string | null {
  const info = a.date;
  if (!info) return null;
  if (info.kind === "group") {
    const n = partsNow(info);
    return isDate(n.year, n.month, n.day) ? isoOf({ y: n.year, m: n.month, d: n.day }) : null;
  }
  const v = (a.value ?? "").trim();
  if (v === "") return null;
  if (info.kind === "time") return timeOf(v);
  if (info.kind === "datetime-local") { const [d, t] = v.split("T"); const tt = timeOf(t ?? ""); return d && tt ? `${d}T${tt}` : v; }
  return v;
}

/** The date that a date value of `shownOf` or `wantOf` names, or null for a month, time, or week value. */
export function dayOfValue(v: string): DateValue | null {
  return fromIso(v.slice(0, 10));
}

/** A native input with min or max: the want value is inside them. Values of one input type compare as strings. */
export function inBounds(a: Action, want: string): boolean {
  const info = a.date;
  if (!info || info.kind === "group") return true;
  return !(info.min && want < info.min) && !(info.max && want > info.max);
}

const PART_ORDERS: DatePartName[][] = [
  ["month", "day", "year"], ["month", "year", "day"], ["day", "month", "year"],
  ["day", "year", "month"], ["year", "month", "day"], ["year", "day", "month"],
];

/** The text of one part: the month and the day padded when the field pads them, the year in two digits for a short year. */
function partText(part: DatePartName, v: DateValue, info: DateInfo): string {
  if (part === "year") return info.short === true ? String(v.y % 100).padStart(2, "0") : String(v.y);
  const n = part === "month" ? v.m : v.d;
  return info.pad === true ? String(n).padStart(2, "0") : String(n);
}

/** The date that the other field of a range shows now: the end for a start field, the start for an end field. */
function partnerOf(a: Action, obs: Observation): DateValue | null {
  const info = a.date;
  if (!info || info.range === undefined || info.role === undefined) return null;
  const other = obs.actions.find((b) => b !== a && b.date?.range === info.range && b.date?.role !== info.role);
  const shown = other ? shownOf(other) : null;
  return shown ? dayOfValue(shown) : null;
}

const cmp = (a: DateValue, b: DateValue): number => (a.y - b.y) * 10_000 + (a.m - b.m) * 100 + (a.d - b.d);

/** Score `a` comes before score `b`: the first number that differs is lower. */
function before(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * How `Page.setDate` sets date field `a` to `want` (from `wantOf`), and the part order as text. A native input gets the
 * value. A group gets only the parts that change, in an order that code simulates:
 * - Each date in between must be a real date: a page such as the Usage DateInput puts the old part back when a part
 *   makes a date that does not exist (10/31 to 9/30 month first passes 9/31, and the page ends at 10/30).
 * - Each date in between must not cross the other field of a range: a start after the end moves the end (8/24 to 9/1
 *   month first passes 9/24, and the page moves the end to 9/24).
 * - `avoid` names an order to leave out when another one is as good: the second pass after a wrong read-back.
 * - Then the order of the parts on the page.
 * Null when the want value does not name a date for a group.
 */
export function datePlan(a: Action, obs: Observation, want: string, avoid?: string): { plan: DatePlan; order: string } | null {
  const info = a.date;
  if (!info) return null;
  if (info.kind !== "group") return { plan: { native: want }, order: "native" };
  const target = dayOfValue(want);
  const parts = info.parts ?? [];
  if (!target || parts.length !== 3) return null;
  const now = partsNow(info);
  const goal: Record<DatePartName, number> = { month: target.m, day: target.d, year: target.y };
  const changed = (["month", "day", "year"] as DatePartName[]).filter((p) => now[p] !== goal[p]);
  if (changed.length === 0) return { plan: { parts: [] }, order: "" };
  const partner = partnerOf(a, obs);
  const pageOrder = parts.map((p) => p.part);
  let best: { order: DatePartName[]; score: number[] } | null = null;
  for (const full of PART_ORDERS) {
    const order = full.filter((p) => changed.includes(p));
    if (best !== null && best.order.join() === order.join()) continue;
    let invalid = 0;
    let crossings = 0;
    const cur = { ...now };
    order.forEach((p, i) => {
      cur[p] = goal[p];
      if (i === order.length - 1) return;
      // An empty part makes no date yet: the page takes nothing in between.
      if ([cur.month, cur.day, cur.year].some((n) => Number.isNaN(n))) return;
      if (!isDate(cur.year, cur.month, cur.day)) { invalid += 1; return; }
      const mid = { y: cur.year, m: cur.month, d: cur.day };
      if (partner && info.role === "start" && cmp(mid, partner) > 0) crossings += 1;
      if (partner && info.role === "end" && cmp(mid, partner) < 0) crossings += 1;
    });
    const score = [invalid, crossings, order.join() === avoid ? 1 : 0, ...order.map((p) => pageOrder.indexOf(p))];
    if (best === null || before(score, best.score)) best = { order, score };
  }
  const order = best?.order ?? changed;
  const byPart = new Map(parts.map((p) => [p.part, p]));
  return {
    plan: { parts: order.map((p) => ({ node: byPart.get(p)?.node as number, text: partText(p, target, info), spin: byPart.get(p)?.spin === true })) },
    order: order.join(),
  };
}

/** A calendar day label without the words that screen readers add: "Tuesday, September 1st, 2026, selected". */
const DAY_EXTRA = /(?:,\s*|\s+)(?:selected|today|unavailable|disabled|available|not available|booked)\s*$/i;

/** The date of a calendar day action: its machine date, or its label. Null for an action that is not a day. */
export function calendarDay(a: Action): DateValue | null {
  if (!a.day) return null;
  if (a.day.day !== null) return fromIso(a.day.day);
  let label = a.label.replace(/^today,?\s+/i, "");
  for (let i = 0; i < 3 && DAY_EXTRA.test(label); i++) label = label.replace(DAY_EXTRA, "");
  const f = parseDate(label);
  return f && f.ambiguous === undefined ? { y: f.y, m: f.m, d: f.d } : null;
}

/** The page has a date field or a calendar day: the step request then carries the date rule. */
export function hasDateWidget(obs: Observation): boolean {
  return obs.actions.some((a) => a.date !== undefined || calendarDay(a) !== null);
}

/** Month and year navigation of a calendar: "Go to the Previous Month" (react-day-picker), "Next month" (MUI), "‹". */
const NAVIGATION = /\b(?:previous|prev|next)\s+(?:month|year)s?\b|\bgo to the (?:previous|next)\b|^\s*[‹›«»<>←→]\s*$/i;
/** "Previous" and "Next" alone (react-aria) are a month navigation only next to a calendar: in a wizard, "Next" goes on. */
const NAVIGATION_WORD = /^\s*(?:previous|prev|next)\s*$/i;

/**
 * A click that can confirm, apply, or leave a date picker: a button in form or dialog `form` that is not a calendar day,
 * not a date field, and not a month or year navigation. Picker confirmations have many names ("Update", "Done", "OK",
 * "Apply", "Select", "Set"), so the name does not decide.
 */
export function confirmsDates(a: Action, form: number, obs: Observation): boolean {
  if (a.kind !== "click" || a.role !== "button" || (a.form ?? null) !== form || a.day !== undefined || a.date !== undefined) return false;
  if (NAVIGATION.test(a.label)) return false;
  return !(NAVIGATION_WORD.test(a.label) && obs.actions.some((b) => b.day !== undefined && (b.form ?? null) === form));
}

/** A task date that Jev's value heads give to one date field, and the value that the field must show for it. */
export interface DateAssignment { field: Action; span: Span; want: string; p: number }

/**
 * The task dates that belong to one date field each. `values`: action id -> span id -> the probability of that span in
 * the field's value head. A span belongs to the field whose head gives it at least GATES.dateField, by at least
 * GATES.dateMargin more than any other field. A field takes at most one span: the one with the higher probability. A
 * value head that gives the only task date to two fields (an invoice date and a due date) assigns it to neither, so a
 * gate never names a field that must keep its value.
 */
export function assignDates(values: Record<string, Record<string, number>>, obs: Observation, spans: Span[]): DateAssignment[] {
  const bySpan = new Map<string, { id: string; p: number }[]>();
  for (const [id, probs] of Object.entries(values)) {
    for (const [sid, p] of Object.entries(probs)) {
      const list = bySpan.get(sid) ?? [];
      list.push({ id, p });
      bySpan.set(sid, list);
    }
  }
  const picks: DateAssignment[] = [];
  for (const [sid, list] of bySpan) {
    list.sort((x, y) => y.p - x.p);
    const top = list[0];
    const next = list[1]?.p ?? 0;
    if (!top || top.p < GATES.dateField || top.p - next < GATES.dateMargin) continue;
    const field = obs.actions.find((a) => a.id === top.id && a.date !== undefined);
    const span = spans.find((s) => s.id === sid);
    const want = field && span ? wantOf(field, span) : null;
    if (field && span && want !== null) picks.push({ field, span, want, p: top.p });
  }
  picks.sort((x, y) => y.p - x.p);
  return picks.filter((x, i) => picks.findIndex((y) => y.field.id === x.field.id) === i);
}

/**
 * The retry reason of the date gate, or null when the action can go. `scope`: the form or dialog of the action ("page"
 * for DONE). It names each assigned date field in scope that does not show its task date, and a calendar range in scope
 * whose selection is not the task range. A form or dialog of null gates nothing but DONE: a page without a form around
 * its date field has no known confirm button.
 */
export function dateGate(obs: Observation, assigned: DateAssignment[], spans: Span[], scope: number | null | "page"): string | null {
  if (scope === null) return null;
  const out: string[] = [];
  for (const x of assigned) {
    if (scope !== "page" && (x.field.form ?? null) !== scope) continue;
    const field = obs.actions.find((a) => a.node === x.field.node && a.date !== undefined) ?? x.field;
    if (shownOf(field) === x.want) continue;
    out.push(`date field "${field.label}" shows ${(field.value ?? "").trim() || "nothing"}, not ${x.span.text}`);
  }
  const range = calendarMismatch(obs, spans, scope);
  if (range) out.push(range);
  const typeFirst = out.length > 0 ? `${out.join("; ")}. TYPE_TEXT each requested date into its date field before you confirm or finish` : null;
  // A numeric task date whose day and month can change places, and that fits no date field in scope: code cannot check
  // the fields for it, so the picker waits. The run then blocks with the fix.
  const fields = obs.actions.filter((a) => a.date !== undefined && (scope === "page" || (a.form ?? null) === scope));
  const lost = fields.length > 0 ? spans.find((s) => s.date?.ambiguous !== undefined && !fields.some((f) => wantOf(f, s) !== null)) : undefined;
  const unread = lost ? `the task date ${lost.text} fits no date field here, because its day and month can change places: write the month as a word or use YYYY-MM-DD` : null;
  return [typeFirst, unread].filter((x) => x !== null).join("; ") || null;
}

/**
 * The calendar range check, as text for the retry reason, or null. It applies to the days of a grid that takes a range,
 * in `scope`, when no date field is in the same form or dialog, and when the task has one start date and one end date.
 * The check reads only the days in view: a selected day outside the task range, a day inside it that is not selected,
 * and a start or an end day that is not the start or the end of the selection (data-range-* or data-selection-*).
 */
export function calendarMismatch(obs: Observation, spans: Span[], scope: number | "page"): string | null {
  const start = spans.find((s) => s.dateRole === "start" && s.date !== undefined && s.date.ambiguous === undefined);
  const end = spans.find((s) => s.dateRole === "end" && s.date !== undefined && s.date.ambiguous === undefined);
  if (!start?.date || !end?.date) return null;
  const days = obs.actions.flatMap((a) => {
    const v = a.day?.multi ? calendarDay(a) : null;
    return v && (scope === "page" || (a.form ?? null) === scope) ? [{ a, iso: isoOf(v) }] : [];
  });
  if (days.length === 0) return null;
  const forms = new Set(days.map((x) => x.a.form ?? null));
  if (obs.actions.some((a) => a.date !== undefined && forms.has(a.form ?? null))) return null;
  const s = isoOf(start.date);
  const e = isoOf(end.date);
  const sel = new Map<string, { sel: boolean; pos: string | undefined }>();
  for (const { a, iso } of days) {
    const old = sel.get(iso);
    sel.set(iso, { sel: (old?.sel ?? false) || a.day?.sel === true, pos: old?.pos ?? a.day?.pos });
  }
  const withPos = days.some((x) => x.a.day?.pos !== undefined);
  let wrong = false;
  for (const [iso, v] of sel) {
    if (v.sel && (iso < s || iso > e)) wrong = true;
    if (!v.sel && iso >= s && iso <= e) wrong = true;
    if (withPos && iso === s && !["start", "single"].includes(v.pos ?? "")) wrong = true;
    if (withPos && iso === e && !["end", "single"].includes(v.pos ?? "")) wrong = true;
  }
  if (!wrong) return null;
  const chosen = [...sel].filter(([, v]) => v.sel).map(([iso]) => iso).sort();
  const shown = chosen.length === 0 ? "no days" : chosen.length === 1 ? chosen[0] : `${chosen[0]} to ${chosen.at(-1)}`;
  return `the calendar shows ${shown} selected, not ${start.text} to ${end.text}`;
}
