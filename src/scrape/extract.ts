// Rows from a page read: find the set that an extract names (its match), read each field through its value parser,
// melt, filter, and drop duplicate keys. Pure: no page, no model.
//
// The exported names and signatures of buildExtract, extractRows, and fingerprintOf are a contract of the scrape kit
// (see /tmp/jevscrape/build/SPEC.md, section C3); the MCP tools call them.
import type { PageRead, RecordGroup, RecordRead, Slot, TableRead, TableRow } from "../fast/read-types.js";
import { normKey } from "../fast/read-types.js";
import { normText, parseValue, parserType } from "./parse.js";
import type { AnyField, Extract, ExtractDraft, Filter, Fingerprint, RecordsExtract, Row, RowValue, SlotPick, TableExtract } from "./spec.js";
import { Extract as ExtractSchema, SpecError, issuesText } from "./spec.js";

export interface ExtractContext {
  /** The run's params (defaults merged with overrides). */
  params: Record<string, string>;
  /** The page URL of the read (read.url when absent). */
  url?: string;
}

export interface ExtractOutcome {
  rows: Row[];
  /** The id of the set that matched ("t2", "g1"), or null when none matched. */
  set: string | null;
  /** The match score of that set, 0..1. */
  score: number;
  /** Why rows are missing or fields are empty, for a person or a model. Empty when all went well. */
  problems: string[];
}

/** A set wins its match at this score. */
export const MATCH_MIN = 0.5;
/** The score of a table that only its index and width found. */
const INDEX_SCORE = 0.3;
/** A group heading fits the saved heading when they share this share of the words of the shorter one. */
const HEADING_MIN = 0.5;
/** A page string in a problem is quoted and cut to this length. The L3 feedback removes quoted text. */
const QUOTE_CHARS = 60;

const q = (s: string): string => JSON.stringify(s.length > QUOTE_CHARS ? `${s.slice(0, QUOTE_CHARS - 1)}…` : s);
const idNum = (id: string): number => Number(id.slice(1)) || 0;

/** |A ∩ B| / |A ∪ B|; 0 when both are empty. */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a);
  const B = new Set(b);
  let both = 0;
  for (const x of A) if (B.has(x)) both += 1;
  const union = A.size + B.size - both;
  return union === 0 ? 0 : both / union;
}

/** The row fields of an extract in row order: its fields, then the melt name and value fields. */
export function fieldNames(extract: Extract | ExtractDraft): string[] {
  const names = Object.keys(extract.fields);
  const melt = "melt" in extract ? extract.melt : undefined;
  if (melt) names.push(melt.name_field, melt.value_field);
  return names;
}

/** The JSON type of a field's values. */
export function fieldType(f: AnyField): "string" | "number" | "boolean" {
  switch (f.from) {
    case "const": return typeof f.value === "number" ? "number" : typeof f.value === "boolean" ? "boolean" : "string";
    case "url": case "href": return "string";
    default: return parserType(f.parser);
  }
}

/** The JSON type of each row field of an extract: its fields, then the melt name field (a string) and value field. */
export function fieldTypes(extract: Extract): Record<string, "string" | "number" | "boolean"> {
  const out: Record<string, "string" | "number" | "boolean"> = {};
  for (const [name, f] of Object.entries(extract.fields)) out[name] = fieldType(f);
  if (extract.source === "table" && extract.melt) {
    out[extract.melt.name_field] = "string";
    out[extract.melt.value_field] = parserType(extract.melt.value_parser);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Set scores.

/** Table score: 0.7 x share of the match headers in the table, + 0.1 each for an equal width, caption, and heading. */
export function tableScore(t: TableRead, match: TableExtract["match"]): number {
  return 0.7 * headerShare(t, match.headers) + 0.1 * (match.width === t.width ? 1 : 0)
    + 0.1 * ((match.caption ?? "") === t.signature.caption ? 1 : 0) + 0.1 * ((match.heading ?? "") === t.signature.heading ? 1 : 0);
}

function headerShare(t: TableRead, headers: string[]): number {
  if (headers.length === 0) return 0;
  const have = new Set([...t.signature.headers, ...t.headers.map(normKey)]);
  return headers.filter((h) => have.has(normKey(h))).length / headers.length;
}

/** Group score: 0.3 shape, 0.1 parent, 0.2 testid (both null is equal), 0.4 x Jaccard of the slot keys. */
export function groupScore(g: RecordGroup, match: RecordsExtract["match"]): number {
  const s = g.signature;
  return 0.3 * (match.shape !== undefined && match.shape === s.shape ? 1 : 0) + 0.1 * (match.parent !== undefined && match.parent === s.parent ? 1 : 0)
    + 0.2 * ((match.testid ?? null) === (s.testid ?? null) ? 1 : 0) + 0.4 * jaccard(match.slot_keys ?? [], s.slot_keys);
}

/** The best table for a match, with its score; `byIndex` when only the index and the width found it. */
export function bestTable(read: PageRead, match: TableExtract["match"]): { table: TableRead; score: number; byIndex: boolean } | null {
  const scored = read.tables.map((t) => ({ table: t, score: tableScore(t, match), share: headerShare(t, match.headers) }))
    .sort((a, b) => b.score - a.score || idNum(a.table.id) - idNum(b.table.id));
  const top = scored[0];
  if (top && top.score >= MATCH_MIN) return { table: top.table, score: top.score, byIndex: false };
  if (match.index !== undefined && scored.every((s) => s.share === 0)) {
    const t = read.tables[match.index];
    if (t && t.width === match.width) return { table: t, score: INDEX_SCORE, byIndex: true };
  }
  return null;
}

/** The words of a group heading that name its list: no number, no word of a param value, at least 2 characters. */
function headingWords(heading: string, params: Record<string, string>): Set<string> {
  const split = (s: string): string[] => normKey(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  const skip = new Set(Object.values(params).flatMap(split));
  return new Set(split(heading).filter((w) => !/^\p{N}+$/u.test(w) && !skip.has(w)));
}

/**
 * A group's heading fits the saved heading of a match: the words that they share are at least HEADING_MIN of the words
 * of the shorter one. Numbers and the words of the run's param values do not count, so "Showing 24 results for butter"
 * fits "showing results for milk". An empty heading on either side fits: there is nothing to compare. A sibling list
 * with the same card template ("More to Explore") does not fit, so a page without the rows fails and heals.
 */
export function headingFits(saved: string | undefined, heading: string, params: Record<string, string>): boolean {
  const a = headingWords(saved ?? "", params);
  const b = headingWords(heading, params);
  if (a.size === 0 || b.size === 0) return true;
  let both = 0;
  for (const w of a) if (b.has(w)) both += 1;
  return both / Math.min(a.size, b.size) >= HEADING_MIN;
}

/** The best record group for a match, with its score. A group whose heading does not fit the saved one is left out. */
export function bestGroup(read: PageRead, match: RecordsExtract["match"], params: Record<string, string> = {}): { group: RecordGroup; score: number } | null {
  const scored = read.groups.filter((g) => headingFits(match.heading, g.heading, params)).map((g) => ({ group: g, score: groupScore(g, match) }))
    .sort((a, b) => b.score - a.score || idNum(a.group.id) - idNum(b.group.id));
  const top = scored[0];
  return top && top.score >= MATCH_MIN ? top : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Field values.

function hasFact(s: Slot, fact: "struck" | "button" | "heading" | "disabled" | "alt" | "href"): boolean {
  if (fact === "alt") return Boolean(s.alt);
  if (fact === "href") return Boolean(s.href);
  return s[fact] === true;
}

/** The slot that a field's picks find in a record, and the text to parse: the first pick that finds one wins. */
export function pickSlot(rec: RecordRead, picks: readonly SlotPick[]): { slot: Slot; text: string } | null {
  for (const p of picks) {
    switch (p.by) {
      case "key": {
        const s = rec.slots.find((x) => x.key === p.key);
        if (s) return { slot: s, text: s.text };
        break;
      }
      case "fact": {
        const s = rec.slots.filter((x) => hasFact(x, p.fact))[p.nth ?? 0];
        if (s) return { slot: s, text: p.fact === "alt" ? s.alt ?? "" : p.fact === "href" ? s.href ?? "" : s.text };
        break;
      }
      case "parse": {
        const s = rec.slots.filter((x) => (p.struck === undefined || (x.struck === true) === p.struck)
          && (p.button === undefined || (x.button === true) === p.button) && parseValue(x.text, p.parser) !== null)[p.nth ?? 0];
        if (s) return { slot: s, text: s.text };
        break;
      }
      case "longest": {
        let best: Slot | null = null;
        for (const x of rec.slots) {
          if (x.button === true && p.button !== true) continue;
          if (x.text.trim() && (!best || x.text.trim().length > best.text.trim().length)) best = x;
        }
        if (best) return { slot: best, text: best.text };
        break;
      }
    }
  }
  return null;
}

/** A form value of the page by its name (case-insensitive), else by its label (normKey). */
function metaText(read: PageRead, key: string, use: "text" | "value" | undefined): string | null {
  const low = key.toLowerCase();
  const hit = read.meta.selected.find((s) => s.name.toLowerCase() === low) ?? read.meta.selected.find((s) => normKey(s.label) === normKey(key));
  if (!hit) return null;
  return use === "value" ? hit.value : hit.text;
}

/** The value of a field that does not read a column or a slot: meta, param, const, url. */
function sharedValue(f: AnyField, read: PageRead, ctx: ExtractContext): RowValue {
  switch (f.from) {
    case "meta": {
      const t = metaText(read, f.key, f.use);
      return t === null ? null : parseValue(t, f.parser ?? "text");
    }
    case "param": {
      const v = ctx.params[f.name];
      return v === undefined ? null : parseValue(v, f.parser ?? "text");
    }
    case "const": return f.value;
    case "url": return ctx.url ?? read.url;
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Rows.

/** The column of a header: the first column whose normKey header equals it, else -1. */
function columnOf(t: TableRead, header: string): number {
  const want = normKey(header);
  return t.headers.findIndex((h, i) => normKey(h) === want || t.signature.headers[i] === want);
}

function tableRows(read: PageRead, t: TableRead, ex: TableExtract, ctx: ExtractContext, byIndex: boolean, problems: string[]): Row[] {
  const cols: Record<string, number> = {};
  const used = new Set<number>();
  for (const [name, f] of Object.entries(ex.fields)) {
    if (f.from !== "column") continue;
    let i = columnOf(t, f.header);
    // A table that only its index found has other header names: the column of the saved index is the column.
    if (i < 0 && byIndex && f.index_hint !== undefined && f.index_hint < t.width) i = f.index_hint;
    if (i < 0) problems.push(`field ${name}: ${t.id} has no column ${q(f.header)}`);
    else { cols[name] = i; used.add(i); }
  }
  const skip = new Set((ex.melt?.skip ?? []).map(normKey));
  const melted = ex.melt ? t.headers.map((_h, i) => i).filter((i) => !used.has(i) && !skip.has(normKey(t.headers[i] ?? ""))) : [];
  const out: Row[] = [];
  const cell = (r: TableRow, i: number | undefined): string => (i === undefined ? "" : r.cells[i] ?? "");
  for (const r of t.rows) {
    const base: Row = {};
    for (const [name, f] of Object.entries(ex.fields)) {
      if (f.from === "column") base[name] = cols[name] === undefined ? null : parseValue(cell(r, cols[name]), f.parser ?? "text");
      else if (f.from === "section") base[name] = parseValue(r.section ?? "", f.parser ?? "text");
      else base[name] = sharedValue(f, read, ctx);
    }
    if (!ex.melt) { out.push(base); continue; }
    for (const i of melted) {
      const v = parseValue(cell(r, i), ex.melt.value_parser ?? "text");
      if (v === null && ex.melt.drop_empty !== false) continue;
      out.push({ ...base, [ex.melt.name_field]: t.headers[i] ?? `col${i + 1}`, [ex.melt.value_field]: v });
    }
  }
  return out;
}

function groupRows(read: PageRead, g: RecordGroup, ex: RecordsExtract, ctx: ExtractContext): Row[] {
  return g.records.map((rec) => {
    const row: Row = {};
    for (const [name, f] of Object.entries(ex.fields)) {
      if (f.from === "slot") {
        const hit = pickSlot(rec, f.pick);
        row[name] = hit === null ? null : parseValue(hit.text, f.parser ?? "text");
      } else if (f.from === "href") row[name] = rec.href ?? null;
      else row[name] = sharedValue(f, read, ctx);
    }
    return row;
  });
}

function numberOf(v: string | number | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function equalValue(v: RowValue, x: string | number | undefined): boolean {
  if (v === null || x === undefined) return false;
  if (typeof v === "number") return numberOf(x) === v;
  if (typeof x === "number" && typeof v === "string") return parseValue(v, "number") === x;
  return normText(String(v)) === normText(String(x));
}

/** A row passes a filter. Numbers compare as numbers; texts in their normalized form; a non-number fails gt/gte/lt/lte. */
export function passes(row: Row, f: Filter): boolean {
  const v = row[f.field] ?? null;
  switch (f.op) {
    case "present": return v !== null && v !== "";
    case "absent": return v === null || v === "";
    case "eq": return equalValue(v, f.value);
    case "ne": return !equalValue(v, f.value);
    case "contains": case "not_contains": {
      const has = v !== null && f.value !== undefined && normText(String(v)).includes(normText(String(f.value)));
      return f.op === "contains" ? has : !has;
    }
    default: {
      const a = typeof v === "number" ? v : null;
      const b = numberOf(f.value);
      if (a === null || b === null) return false;
      return f.op === "gt" ? a > b : f.op === "gte" ? a >= b : f.op === "lt" ? a < b : a <= b;
    }
  }
}

/** Filter, then drop rows whose key values are the same as an earlier row's (the first wins). */
function finish(rows: Row[], ex: Extract, problems: string[]): Row[] {
  let out = rows;
  if (ex.filter?.length) {
    out = out.filter((r) => (ex.filter ?? []).every((f) => passes(r, f)));
    if (out.length === 0 && rows.length > 0) problems.push(`the filter left 0 of ${rows.length} rows`);
  }
  if (ex.key?.length) {
    const seen = new Set<string>();
    out = out.filter((r) => {
      const k = JSON.stringify((ex.key ?? []).map((f) => { const v = r[f] ?? null; return typeof v === "string" ? normText(v) : v; }));
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  return out;
}

/** "field price is null in 20 of 24 rows" for each field that is null in more than half of the rows. */
function nullProblems(rows: Row[], ex: Extract): string[] {
  if (rows.length === 0) return [];
  const out: string[] = [];
  for (const name of fieldNames(ex)) {
    if (ex.fields[name]?.from === "const") continue;
    const nulls = rows.filter((r) => (r[name] ?? null) === null).length;
    if (nulls * 2 > rows.length) out.push(`field ${name} is null in ${nulls} of ${rows.length} rows`);
  }
  return out;
}

function tableOutcome(read: PageRead, t: TableRead, extract: TableExtract, ctx: ExtractContext, score: number, byIndex: boolean): ExtractOutcome {
  const problems: string[] = [];
  if (t.rows.length === 0) problems.push(`${t.id} has no data rows`);
  const rows = finish(tableRows(read, t, extract, ctx, byIndex, problems), extract, problems);
  return { rows, set: t.id, score, problems: [...problems, ...nullProblems(rows, extract)] };
}

function groupOutcome(read: PageRead, g: RecordGroup, extract: RecordsExtract, ctx: ExtractContext, score: number): ExtractOutcome {
  const problems: string[] = [];
  const rows = finish(groupRows(read, g, extract, ctx), extract, problems);
  return { rows, set: g.id, score, problems: [...problems, ...nullProblems(rows, extract)] };
}

/** The rows of `extract` on `read`. Never throws for a page that does not match: `set` is null and `problems` says why. */
export function extractRows(read: PageRead, extract: Extract, ctx: ExtractContext): ExtractOutcome {
  if (extract.source === "table") {
    const hit = bestTable(read, extract.match);
    if (!hit) {
      const shown = extract.match.headers.slice(0, 5).map(q).join(", ");
      return { rows: [], set: null, score: 0, problems: [`no table has the headers ${shown}${extract.match.headers.length > 5 ? ", ..." : ""} (${read.tables.length} tables on the page)`] };
    }
    return tableOutcome(read, hit.table, extract, ctx, hit.score, hit.byIndex);
  }
  const hit = bestGroup(read, extract.match, ctx.params);
  if (!hit) {
    const fits = read.groups.filter((g) => headingFits(extract.match.heading, g.heading, ctx.params));
    const top = Math.max(0, ...fits.map((g) => groupScore(g, extract.match)));
    const other = read.groups.filter((g) => !fits.includes(g) && groupScore(g, extract.match) >= MATCH_MIN).map((g) => g.id);
    const note = other.length > 0 ? `; ${other.join(", ")} ${other.length > 1 ? "have" : "has"} the shape of the rows under another heading than ${q(extract.match.heading ?? "")}` : "";
    return { rows: [], set: null, score: 0, problems: [`no record group matches the extract (best score ${top.toFixed(2)} of ${read.groups.length} groups on the page)${note}`] };
  }
  return groupOutcome(read, hit.group, extract, ctx, hit.score);
}

/** The rows of `extract` from one set of the read, with no match step: the caller chose the set (L1 re-anchor). */
export function extractFromSet(read: PageRead, extract: Extract, set: string, ctx: ExtractContext, score = 1): ExtractOutcome {
  if (extract.source === "table") {
    const t = read.tables.find((x) => x.id === set);
    return t ? tableOutcome(read, t, extract, ctx, score, false) : { rows: [], set: null, score: 0, problems: [`${set} is not a table of the page`] };
  }
  const g = read.groups.find((x) => x.id === set);
  return g ? groupOutcome(read, g, extract, ctx, score) : { rows: [], set: null, score: 0, problems: [`${set} is not a record group of the page`] };
}

/** The match of a table: its signature and its index in the read. */
export function tableMatch(read: PageRead, t: TableRead): TableExtract["match"] {
  return {
    headers: t.signature.headers.slice(0, 40),
    width: t.width,
    ...(t.signature.caption ? { caption: t.signature.caption } : {}),
    ...(t.signature.heading ? { heading: t.signature.heading } : {}),
    index: Math.max(0, read.tables.indexOf(t)),
  };
}

/** The match of a record group: its signature. */
export function groupMatch(g: RecordGroup): RecordsExtract["match"] {
  return {
    shape: g.signature.shape,
    parent: g.signature.parent,
    testid: g.signature.testid,
    slot_keys: g.signature.slot_keys.filter((k) => k.length <= 300).slice(0, 40),
    ...(g.heading ? { heading: normKey(g.heading).slice(0, 200) } : {}),
  };
}

/** A column of a table by its header name (normKey), else -1. */
export function columnIndex(t: TableRead, header: string): number {
  return columnOf(t, header);
}

// ---------------------------------------------------------------------------------------------------------------
// Drafts.

/**
 * Turn a draft into an Extract: the set's kind becomes `source`, its signature becomes `match`, and each column field
 * gets its `index_hint`. Throws SpecError when the set is not in the read, or a field does not fit the set (a slot field
 * on a table, a column that the table does not have).
 */
export function buildExtract(draft: ExtractDraft, read: PageRead): Extract {
  const problems: string[] = [];
  const names = new Set(fieldNames(draft));
  const table = draft.set.startsWith("t") ? read.tables.find((t) => t.id === draft.set) : undefined;
  const group = draft.set.startsWith("g") ? read.groups.find((g) => g.id === draft.set) : undefined;
  if (!table && !group) {
    const sets = [...read.tables.map((t) => t.id), ...read.groups.map((g) => g.id)];
    throw new SpecError(`set: ${draft.set} is not in the page read (sets: ${sets.join(", ") || "none"})`);
  }
  if (draft.melt) {
    if (!table) problems.push(`melt: melt is for a table; ${draft.set} is a record group`);
    for (const f of [draft.melt.name_field, draft.melt.value_field]) if (f in draft.fields) problems.push(`melt: ${f} is also a field; give the melt fields new names`);
    if (draft.melt.name_field === draft.melt.value_field) problems.push("melt: name_field and value_field are the same");
  }
  for (const k of draft.key ?? []) if (!names.has(k)) problems.push(`key: ${k} is not a field`);
  for (const [i, f] of (draft.filter ?? []).entries()) if (!names.has(f.field)) problems.push(`filter.${i}.field: ${f.field} is not a field`);
  for (const [name, f] of Object.entries(draft.fields)) {
    const at = `fields.${name}`;
    if (table && (f.from === "slot" || f.from === "href")) problems.push(`${at}: a ${f.from} field reads a record group; ${table.id} is a table`);
    if (group && (f.from === "column" || f.from === "section")) problems.push(`${at}: a ${f.from} field reads a table; ${group.id} is a record group`);
    if (table && f.from === "column" && columnOf(table, f.header) < 0) problems.push(`${at}.header: ${q(f.header)} is not a header of ${table.id}`);
    if (group && f.from === "slot") {
      for (const [i, p] of f.pick.entries()) if (p.by === "key" && !group.slots.some((s) => s.key === p.key)) problems.push(`${at}.pick.${i}.key: ${q(p.key)} is not a slot key of ${group.id}`);
    }
    if (f.from === "meta" && metaText(read, f.key, f.use) === null) problems.push(`${at}.key: the page has no form value ${q(f.key)}`);
  }
  if (problems.length > 0) throw new SpecError(problems.join("\n"));

  const data: unknown = table ? {
    source: "table",
    match: tableMatch(read, table),
    fields: Object.fromEntries(Object.entries(draft.fields).map(([n, f]) => [n, f.from === "column" ? { ...f, index_hint: columnOf(table, f.header) } : f])),
    ...(draft.melt ? { melt: draft.melt } : {}),
    ...(draft.filter ? { filter: draft.filter } : {}),
    ...(draft.key ? { key: draft.key } : {}),
  } : {
    source: "records",
    match: groupMatch(group as RecordGroup),
    fields: draft.fields,
    ...(draft.filter ? { filter: draft.filter } : {}),
    ...(draft.key ? { key: draft.key } : {}),
  };
  const r = ExtractSchema.safeParse(data);
  if (!r.success) throw new SpecError(issuesText(r.error));
  return r.data;
}

// ---------------------------------------------------------------------------------------------------------------
// Fingerprint.

/** The field whose values name a row: the first key field that reads a column or a slot, else the first such text field. */
function keyField(extract: Extract): string | null {
  const content = (name: string): boolean => { const f = extract.fields[name]; return f?.from === "column" || f?.from === "slot"; };
  const key = (extract.key ?? []).find(content) ?? extract.key?.[0];
  if (key) return key;
  return Object.entries(extract.fields).find(([, f]) => (f.from === "column" || f.from === "slot") && fieldType(f) === "string")?.[0] ?? null;
}

/** The slot that a field's picks find in the first record that has one. */
function firstSlot(g: RecordGroup, picks: readonly SlotPick[]): Slot | null {
  for (const rec of g.records) {
    const hit = pickSlot(rec, picks);
    if (hit) return hit.slot;
  }
  return null;
}

/** The fingerprint of an extraction that worked: header names or slot keys, field types, up to 5 key names, the URL path. */
export function fingerprintOf(extract: Extract, read: PageRead, set: string, rows: Row[]): Fingerprint {
  const table = read.tables.find((t) => t.id === set);
  const group = read.groups.find((g) => g.id === set);
  const fields: Fingerprint["fields"] = {};
  for (const [name, f] of Object.entries(extract.fields)) {
    const entry: Fingerprint["fields"][string] = { type: fieldType(f) };
    if (f.from === "column") entry.column = normKey(f.header).slice(0, 200);
    if (f.from === "slot" && group) {
      const s = firstSlot(group, f.pick);
      if (s && s.key.length <= 300) entry.slot = { key: s.key, struck: s.struck === true, button: s.button === true, heading: s.heading === true };
    }
    fields[name] = entry;
  }
  if (extract.source === "table" && extract.melt) {
    fields[extract.melt.name_field] = { type: "string" };
    fields[extract.melt.value_field] = { type: parserType(extract.melt.value_parser) };
  }
  const kf = keyField(extract);
  const keys: string[] = [];
  if (kf) {
    for (const r of rows) {
      const v = r[kf];
      if (v === null || v === undefined) continue;
      const s = String(v).slice(0, 60);
      if (s && !keys.includes(s)) keys.push(s);
      if (keys.length >= 5) break;
    }
  }
  let urlPath = "";
  try { urlPath = new URL(read.url).pathname.slice(0, 300); } catch { urlPath = ""; }
  return {
    source: extract.source,
    headers: table ? table.signature.headers.slice(0, 40) : [],
    slot_keys: group ? group.signature.slot_keys.filter((k) => k.length <= 300).slice(0, 40) : [],
    fields,
    keys,
    row_count: rows.length,
    url_path: urlPath,
  };
}
