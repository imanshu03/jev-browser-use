import { describe, expect, it } from "vitest";
import { assignDates, calendarDay, calendarMismatch, confirmsDates, dateFor, dateGate, datePlan, hasDateWidget, inBounds, shownOf, wantOf } from "../../src/fast/dates.js";
import type { Action, DateInfo, Observation } from "../../src/fast/model.js";
import { extractSpans, parseDate } from "../../src/task.js";
import type { Span } from "../../src/types.js";
import { el, obs } from "./fakes.js";

/** A month-day-year group with parts at nodes node, node+1, node+2, as the snapshot shows it. */
function group(id: string, node: number, label: string, [m, d, y]: [string, string, string], extra: Partial<DateInfo> = {}, over: Partial<Action> = {}): Action {
  const info: DateInfo = {
    kind: "group", sep: "/", order: "MDY", pad: false, short: false,
    parts: [{ part: "month", node, value: m, spin: false }, { part: "day", node: node + 1, value: d, spin: false }, { part: "year", node: node + 2, value: y, spin: false }],
    ...extra,
  };
  return el(id, "fill", label, "textbox", { node, value: [m, d, y].join(info.sep ?? "/"), form: 5, date: info, ...over });
}
const dateSpan = (id: string, text: string, role?: "start" | "end"): Span => {
  const f = parseDate(text);
  return { id, text, source: "date", secret: false, ...(f ? { date: f } : {}), ...(role ? { dateRole: role } : {}) };
};
const plain = (p: ReturnType<typeof datePlan>): string[] => (p && "parts" in p.plan ? p.plan.parts.map((x) => `${x.node}:${x.text}`) : []);
const usage = (start: [string, string, string], end: [string, string, string], extra: Action[] = []): Observation => obs("https://app.test/usage", [
  group("e1", 10, "Date range start (M/D/YYYY)", start, { role: "start", range: 1 }),
  group("e2", 13, "Date range end (M/D/YYYY)", end, { role: "end", range: 1 }),
  el("e3", "click", "Cancel", "button", { node: 30, form: 5 }),
  el("e4", "click", "Update", "button", { node: 31, form: 5 }),
  el("e5", "click", "Go to the Next Month", "button", { node: 32, form: 5 }),
  ...extra,
]);

describe("dateFor and wantOf", () => {
  it("a clear date fits every date field; an ambiguous numeric date fits only a field of its shape", () => {
    const md = group("e1", 1, "Start (M/D/YYYY)", ["8", "24", "2026"]).date as DateInfo;
    const dm = group("e1", 1, "Start (D.M.YYYY)", ["24", "8", "2026"], { sep: ".", order: "DMY" }).date as DateInfo;
    const dmSlash = { ...dm, sep: "/" };
    expect(dateFor(parseDate("1 September 2026")!, md)).toEqual({ y: 2026, m: 9, d: 1 });
    expect(dateFor(parseDate("1 September 2026")!, dm)).toEqual({ y: 2026, m: 9, d: 1 });
    expect(dateFor(parseDate("13/9/2026")!, md)).toEqual({ y: 2026, m: 9, d: 13 });
    // "9/1/2026" is 1 September in M/D/YYYY and 9 January in D/M/YYYY. A D.M.YYYY field has another shape: no fact.
    expect(dateFor(parseDate("9/1/2026")!, md)).toEqual({ y: 2026, m: 9, d: 1 });
    expect(dateFor(parseDate("9/1/2026")!, dmSlash)).toEqual({ y: 2026, m: 1, d: 9 });
    expect(dateFor(parseDate("9/1/2026")!, dm)).toBeNull();
    expect(dateFor(parseDate("3/4/2026")!, { kind: "date", order: "YMD", sep: "-" })).toBeNull();
  });

  it("gives each field kind its own value form, and only spans that fit", () => {
    const start = group("e1", 1, "Start (M/D/YYYY)", ["8", "24", "2026"]);
    const due = el("e2", "fill", "Due (date)", "textbox", { node: 4, value: "", date: { kind: "date", order: "MDY", sep: "/", min: "2026-01-01", max: "2026-12-31" } });
    const month = el("e3", "fill", "Billing month (month)", "textbox", { node: 5, value: "", date: { kind: "month" } });
    const time = el("e4", "fill", "Start time (time)", "textbox", { node: 6, value: "", date: { kind: "time" } });
    const local = el("e5", "fill", "Meeting (date and time)", "textbox", { node: 7, value: "", date: { kind: "datetime-local" } });
    const week = el("e6", "fill", "Week (week)", "textbox", { node: 8, value: "", date: { kind: "week" } });
    const s = (text: string): Span => ({ id: "s1", text, source: "after_verb", secret: false, ...(parseDate(text) ? { date: parseDate(text)! } : {}) });
    expect(wantOf(start, s("1 September 2026"))).toBe("2026-09-01");
    expect(wantOf(due, s("September 15, 2026"))).toBe("2026-09-15");
    expect(wantOf(month, s("15 September 2026"))).toBe("2026-09");
    expect(wantOf(month, s("2026-09"))).toBe("2026-09");
    expect(wantOf(time, s("9:30"))).toBe("09:30");
    expect(wantOf(time, s("25:00"))).toBeNull();
    expect(wantOf(local, s("2026-09-01T10:30"))).toBe("2026-09-01T10:30");
    expect(wantOf(week, s("2026-W36"))).toBe("2026-W36");
    expect(wantOf(start, s("hello"))).toBeNull();
    expect(wantOf(start, s("2026-09"))).toBeNull();
    expect(wantOf(el("e9", "fill", "Name", "textbox"), s("1 September 2026"))).toBeNull();
    expect(inBounds(due, "2026-09-15")).toBe(true);
    expect(inBounds(due, "2027-01-02")).toBe(false);
    expect(inBounds(start, "1999-01-01")).toBe(true);
  });

  it("reads what a field shows: a whole group date, else null; a two-digit year is 20YY", () => {
    expect(shownOf(group("e1", 1, "D", ["8", "24", "2026"]))).toBe("2026-08-24");
    expect(shownOf(group("e1", 1, "D", ["2", "30", "2026"]))).toBeNull();
    expect(shownOf(group("e1", 1, "D", ["", "", ""]))).toBeNull();
    expect(shownOf(group("e1", 1, "D", ["09", "01", "26"], { pad: true, short: true }))).toBe("2026-09-01");
    expect(shownOf(el("e2", "fill", "Due (date)", "textbox", { value: "2026-09-15", date: { kind: "date" } }))).toBe("2026-09-15");
    expect(shownOf(el("e2", "fill", "Due (date)", "textbox", { value: "", date: { kind: "date" } }))).toBeNull();
    expect(shownOf(el("e3", "fill", "At (time)", "textbox", { value: "09:30:00", date: { kind: "time" } }))).toBe("09:30");
  });
});

describe("datePlan: the part order", () => {
  it("types only the parts that change, day first when month first passes a date that does not exist (10/31 to 9/30)", () => {
    const o = obs("https://a.test/", [group("e1", 1, "Date (M/D/YYYY)", ["10", "31", "2026"])]);
    const p = datePlan(o.actions[0] as Action, o, "2026-09-30");
    expect(p?.order).toBe("day,month");
    expect(plain(p)).toEqual(["2:30", "1:9"]);
  });

  it("does not cross the other field of a range: a start from 8/24 to 9/1 with the end at 9/23 goes day first", () => {
    const o = usage(["8", "24", "2026"], ["9", "23", "2026"]);
    // Month first passes 9/24, after the end: the page would move the end to 9/24.
    expect(datePlan(o.actions[0] as Action, o, "2026-09-01")?.order).toBe("day,month");
    // An end from 9/23 to 10/5 with the start at 9/1: day first passes 9/5 (after the start); month first passes 10/23.
    const e = usage(["9", "1", "2026"], ["9", "23", "2026"]);
    expect(datePlan(e.actions[1] as Action, e, "2026-10-05")?.order).toBe("month,day");
    // An end from 9/23 to 8/30 with the start at 8/24: month first passes 8/23, before the start; day first passes 9/30.
    const b = usage(["8", "24", "2026"], ["9", "23", "2026"]);
    expect(datePlan(b.actions[1] as Action, b, "2026-08-30")?.order).toBe("day,month");
  });

  it("uses the page order when every order is as good, `avoid` for a second pass, and pads and cuts as the field shows", () => {
    const o = obs("https://a.test/", [group("e1", 1, "Date (M/D/YYYY)", ["", "", ""])]);
    expect(datePlan(o.actions[0] as Action, o, "2026-09-01")?.order).toBe("month,day,year");
    expect(datePlan(o.actions[0] as Action, o, "2026-09-01", "month,day,year")?.order).not.toBe("month,day,year");
    const padded = obs("https://a.test/", [group("e1", 1, "Date (DD/MM/YY)", ["24", "08", "26"], { order: "DMY", pad: true, short: true,
      parts: [{ part: "day", node: 1, value: "24", spin: false }, { part: "month", node: 2, value: "08", spin: false }, { part: "year", node: 3, value: "26", spin: false }] })]);
    expect(plain(datePlan(padded.actions[0] as Action, padded, "2027-09-01"))).toEqual(["1:01", "2:09", "3:27"]);
    const same = obs("https://a.test/", [group("e1", 1, "Date (M/D/YYYY)", ["9", "1", "2026"])]);
    expect(plain(datePlan(same.actions[0] as Action, same, "2026-09-01"))).toEqual([]);
    const native = el("e1", "fill", "Due (date)", "textbox", { value: "", date: { kind: "date" } });
    expect(datePlan(native, obs("https://a.test/", [native]), "2026-09-15")?.plan).toEqual({ native: "2026-09-15" });
  });

  it("types a spinbutton part key by key", () => {
    const spin = group("e1", 1, "Event date (M/D/YYYY)", ["8", "24", "2026"], {
      parts: [{ part: "month", node: 1, value: "8", spin: true }, { part: "day", node: 2, value: "24", spin: true }, { part: "year", node: 3, value: "2026", spin: true }],
    });
    const p = datePlan(spin, obs("https://a.test/", [spin]), "2026-09-01");
    // No range partner and each date in between exists: the page order.
    expect(p?.plan).toEqual({ parts: [{ node: 1, text: "9", spin: true }, { node: 2, text: "1", spin: true }] });
  });
});

describe("calendar days", () => {
  const day = (id: string, label: string, iso: string | null, extra: Partial<NonNullable<Action["day"]>> = {}, form: number | null = 5): Action =>
    el(id, "click", label, "button", { form, day: { grid: 3, day: iso, multi: true, sel: false, ...extra } });

  it("reads the machine date, else the label without the screen reader words; a label without a year is no day", () => {
    expect(calendarDay(day("e1", "01/09/2026", "2026-09-01"))).toEqual({ y: 2026, m: 9, d: 1 });
    expect(calendarDay(day("e1", "Tuesday, September 1st, 2026, selected", null))).toEqual({ y: 2026, m: 9, d: 1 });
    expect(calendarDay(day("e1", "Today, Tuesday, September 1, 2026 selected", null))).toEqual({ y: 2026, m: 9, d: 1 });
    expect(calendarDay(day("e1", "Choose Tuesday", null))).toBeNull();
    expect(calendarDay(el("e1", "click", "Tuesday, September 1st, 2026", "button"))).toBeNull();
    expect(hasDateWidget(obs("https://a.test/", [day("e1", "1", "2026-09-01")]))).toBe(true);
    expect(hasDateWidget(obs("https://a.test/", [el("e1", "click", "September 1, 2026", "button")]))).toBe(false);
    expect(hasDateWidget(usage(["8", "24", "2026"], ["9", "23", "2026"]))).toBe(true);
  });

  it("a calendar range check needs the task range: a wrong selection gates, the task range passes", () => {
    const spans = [dateSpan("s1", "1 September 2026", "start"), dateSpan("s2", "15 September 2026", "end")];
    const grid = (sel: Record<string, string>): Observation => obs("https://a.test/", [
      ...["2026-08-24", "2026-08-31", "2026-09-01", "2026-09-10", "2026-09-15", "2026-09-16"].map((iso, i) =>
        day(`e${i + 1}`, iso, iso, sel[iso] ? { sel: true, ...(sel[iso] !== "sel" ? { pos: sel[iso] as "start" } : {}) } : {})),
      el("e9", "click", "Update", "button", { form: 5 }),
    ]);
    // react-day-picker adds a click to the range: Sep 1 then Sep 15 from Aug 24 - Sep 23 gives Aug 24 - Sep 15.
    const extended = grid({ "2026-08-24": "start", "2026-08-31": "middle", "2026-09-01": "middle", "2026-09-10": "middle", "2026-09-15": "end" });
    expect(calendarMismatch(extended, spans, 5)).toBe("the calendar shows 2026-08-24 to 2026-09-15 selected, not 1 September 2026 to 15 September 2026");
    expect(calendarMismatch(extended, spans, "page")).not.toBeNull();
    const right = grid({ "2026-09-01": "start", "2026-09-10": "middle", "2026-09-15": "end" });
    expect(calendarMismatch(right, spans, 5)).toBeNull();
    // Without range attributes, the selected days alone decide.
    expect(calendarMismatch(grid({ "2026-09-01": "sel", "2026-09-10": "sel", "2026-09-15": "sel" }), spans, 5)).toBeNull();
    expect(calendarMismatch(grid({ "2026-09-01": "sel", "2026-09-15": "sel" }), spans, 5)).not.toBeNull();
    // Another form, a task without a range, and a grid next to a date field: no check.
    expect(calendarMismatch(extended, spans, 6)).toBeNull();
    expect(calendarMismatch(extended, [dateSpan("s1", "1 September 2026")], 5)).toBeNull();
    const withField = obs("https://a.test/", [...extended.actions.filter((a) => a.id !== "wait"), group("e20", 40, "Date range start (M/D/YYYY)", ["8", "24", "2026"])]);
    expect(calendarMismatch(withField, spans, 5)).toBeNull();
  });
});

describe("the date gate", () => {
  const spans = [dateSpan("s1", "1 September 2026", "start"), dateSpan("s2", "15 September 2026", "end")];

  it("assigns a task date to the field whose head gives it at least 0.8, by a margin; one date per field", () => {
    const o = usage(["8", "24", "2026"], ["9", "23", "2026"]);
    const a = assignDates({ e1: { s1: 0.99, s2: 0.01 }, e2: { s1: 0.02, s2: 0.97 } }, o, spans);
    expect(a.map((x) => [x.field.id, x.span.id, x.want])).toEqual([["e1", "s1", "2026-09-01"], ["e2", "s2", "2026-09-15"]]);
    // Below 0.8, or a close second field: no assignment.
    expect(assignDates({ e1: { s1: 0.7 }, e2: { s2: 0.97 } }, o, spans).map((x) => x.span.id)).toEqual(["s2"]);
    expect(assignDates({ e1: { s1: 0.9 }, e2: { s1: 0.8, s2: 0.95 } }, o, spans).map((x) => x.span.id)).toEqual(["s2"]);
    // A field that is the best place of two dates keeps the one with the higher probability.
    expect(assignDates({ e1: { s1: 0.9, s2: 0.95 }, e2: {} }, o, spans).map((x) => [x.field.id, x.span.id])).toEqual([["e1", "s2"]]);
  });

  it("an invoice date and a due date with one task date: only a field that the heads clearly choose is gated and named", () => {
    const due = [dateSpan("s1", "15 September 2026")];
    const form = obs("https://a.test/invoice", [
      el("e1", "fill", "Invoice date (date)", "textbox", { node: 1, value: "2026-09-01", form: 2, date: { kind: "date" } }),
      el("e2", "fill", "Due date (date)", "textbox", { node: 2, value: "2026-09-30", form: 2, date: { kind: "date" } }),
      el("e3", "click", "Save", "button", { node: 3, form: 2 }),
    ]);
    const clear = assignDates({ e1: { s1: 0.3 }, e2: { s1: 0.96 } }, form, due);
    expect(dateGate(form, clear, due, 2)).toBe("date field \"Due date (date)\" shows 2026-09-30, not 15 September 2026. TYPE_TEXT each requested date into its date field before you confirm or finish");
    // Both heads give it: neither is named, so the gate never asks for text in the invoice date.
    expect(dateGate(form, assignDates({ e1: { s1: 0.9 }, e2: { s1: 0.9 } }, form, due), due, 2)).toBeNull();
  });

  it("names each field that does not show its date, in the scope of the action; DONE looks at the whole page", () => {
    const open = usage(["8", "24", "2026"], ["9", "23", "2026"]);
    const heads = { e1: { s1: 1 }, e2: { s2: 1 } };
    const text = dateGate(open, assignDates(heads, open, spans), spans, 5);
    expect(text).toContain("date field \"Date range start (M/D/YYYY)\" shows 8/24/2026, not 1 September 2026");
    expect(text).toContain("date field \"Date range end (M/D/YYYY)\" shows 9/23/2026, not 15 September 2026");
    expect(dateGate(open, assignDates(heads, open, spans), spans, "page")).toBe(text);
    expect(dateGate(open, assignDates(heads, open, spans), spans, 6)).toBeNull();
    expect(dateGate(open, assignDates(heads, open, spans), spans, null)).toBeNull();
    const half = usage(["9", "1", "2026"], ["9", "23", "2026"]);
    expect(dateGate(half, assignDates(heads, half, spans), spans, 5)).toBe("date field \"Date range end (M/D/YYYY)\" shows 9/23/2026, not 15 September 2026. TYPE_TEXT each requested date into its date field before you confirm or finish");
    const set = usage(["9", "1", "2026"], ["9", "15", "2026"]);
    expect(dateGate(set, assignDates(heads, set, spans), spans, 5)).toBeNull();
    expect(dateGate(set, [], spans, "page")).toBeNull();
  });

  it("a numeric task date that fits no date field in scope makes the picker wait, with the fix", () => {
    const dotted = [dateSpan("s1", "3.4.2026")];
    const open = usage(["8", "24", "2026"], ["9", "23", "2026"]);
    expect(dateGate(open, [], dotted, 5)).toBe("the task date 3.4.2026 fits no date field here, because its day and month can change places: write the month as a word or use YYYY-MM-DD");
    expect(dateGate(open, [], dotted, "page")).not.toBeNull();
    expect(dateGate(open, [], dotted, 6)).toBeNull();
    // The same shape as the fields ("/" and M/D/YYYY): the date fits, and only the heads decide.
    expect(dateGate(open, [], [dateSpan("s1", "3/4/2026")], 5)).toBeNull();
    expect(dateGate(obs("https://a.test/", [el("e1", "click", "OK", "button", { form: 5 })]), [], dotted, "page")).toBeNull();
  });

  it("a confirm click is a button of the form: not a day, a date field, or a month navigation", () => {
    const o = usage(["8", "24", "2026"], ["9", "23", "2026"], [el("e6", "click", "Tuesday, September 1st, 2026", "button", { node: 33, form: 5, day: { grid: 1, day: "2026-09-01", multi: true, sel: false } }),
      el("e7", "click", "Done", "button", { node: 34, form: 7 }), el("e8", "click", "Next", "button", { node: 35, form: 5 }), el("e9", "click", "Previous month", "button", { node: 36, form: 5 })]);
    expect(o.actions.filter((a) => confirmsDates(a, 5, o)).map((a) => a.label)).toEqual(["Cancel", "Update"]);
    // In a wizard without a calendar, "Next" goes on to the next page: it waits for the dates too.
    const wizard = obs("https://a.test/", [group("e1", 1, "Date of birth (D M YYYY)", ["", "", ""]), el("e2", "click", "Next", "button", { node: 9, form: 5 })]);
    expect(wizard.actions.filter((a) => confirmsDates(a, 5, wizard)).map((a) => a.label)).toEqual(["Next"]);
  });

  it("task ranges come from the task words", () => {
    const roles = (task: string) => extractSpans(task).filter((s) => s.dateRole).map((s) => `${s.dateRole}:${s.text}`);
    expect(roles("Set the usage date range from 1 September 2026 to 15 September 2026 and click Update")).toEqual(["start:1 September 2026", "end:15 September 2026"]);
    expect(roles('Set the range from "1 September 2026" to "15 September 2026"')).toEqual(["start:1 September 2026", "end:15 September 2026"]);
  });
});
