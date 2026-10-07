// L1 heal: code re-anchor. When the page still has the rows but the extract no longer finds them (a header or a class
// name changed), find the set that best fits the scraper's fingerprint and map each field to it again. No model call.
import type { PageRead, RecordGroup, TableRead } from "../fast/read-types.js";
import { normKey } from "../fast/read-types.js";
import type { ExtractContext, ExtractOutcome } from "./extract.js";
import { extractFromSet, fieldType, groupMatch, headingFits, jaccard, pickSlot, tableMatch } from "./extract.js";
import { normText, parseValue } from "./parse.js";
import type { Extract, Fingerprint, RecordField, RecordsExtract, SlotPick, TableExtract, TableField, Validate, ValueParser } from "./spec.js";
import type { Validation } from "./validate.js";
import { validateRows } from "./validate.js";

/** A set is a candidate at this score. */
export const L1_MIN = 0.4;
/** A column at its old index, or an unused slot key, takes a field when its parser reads this share of the cells. */
const READS_MIN = 0.8;
/** A renamed header takes a field at this token Jaccard. */
const TOKENS_MIN = 0.5;

export interface Reanchor {
  extract: Extract;
  outcome: ExtractOutcome;
  validation: Validation;
  /** The set of the new extract, and its candidate score. */
  set: string;
  score: number;
}

/** What L1 needs of a scraper. */
export interface Anchor { extract: Extract; validate: Validate; fingerprint: Fingerprint }

const tokens = (s: string): string[] => normKey(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** A fingerprint key name in a text: equal after normalization; a key cut at 60 characters matches its start. */
function keyHit(text: string, key: string): boolean {
  const t = normText(text);
  const k = normText(key);
  return k !== "" && (t === k || (key.length >= 60 && t.startsWith(k)));
}

// ---------------------------------------------------------------------------------------------------------------
// Tables.

function tableCandidate(t: TableRead, a: Anchor, match: TableExtract["match"]): number {
  const want = (a.fingerprint.headers.length > 0 ? a.fingerprint.headers : match.headers).map(normKey);
  const keys = a.fingerprint.keys;
  const keyShare = keys.length === 0 ? 0 : keys.filter((k) => t.rows.some((r) => r.cells.slice(0, 3).some((c) => keyHit(c, k)))).length / keys.length;
  return 0.6 * jaccard(want, t.signature.headers) + 0.2 * keyShare
    + 0.1 * ((match.caption ?? "") === t.signature.caption ? 1 : 0) + 0.1 * ((match.heading ?? "") === t.signature.heading ? 1 : 0);
}

function readsShare(texts: string[], parser: ValueParser, total: number): number {
  return total === 0 ? 0 : texts.filter((x) => parseValue(x, parser) !== null).length / total;
}

/**
 * The column fields of a table extract mapped to a new table: the same header; else the unused header with the best
 * token Jaccard (at least 0.5); else the column at `index_hint` when the field's parser reads 80% of its cells. Null
 * when a column field finds no column.
 */
function remapTable(read: PageRead, t: TableRead, ex: TableExtract): TableExtract | null {
  const norm = t.headers.map(normKey);
  const used = new Set<number>();
  const at: Record<string, number> = {};
  const columns: [string, ColumnField][] = [];
  for (const [name, f] of Object.entries(ex.fields)) if (f.from === "column") columns.push([name, f]);
  for (const [name, f] of columns) {
    const i = norm.indexOf(normKey(f.header));
    if (i >= 0 && !used.has(i)) { at[name] = i; used.add(i); }
  }
  for (const [name, f] of columns) {
    if (at[name] !== undefined) continue;
    const want = tokens(f.header);
    let best = -1;
    let bestScore = 0;
    norm.forEach((_h, i) => {
      if (used.has(i)) return;
      const s = jaccard(want, tokens(t.headers[i] ?? ""));
      if (s > bestScore) { best = i; bestScore = s; }
    });
    if (best >= 0 && bestScore >= TOKENS_MIN) { at[name] = best; used.add(best); continue; }
    const hint = f.index_hint;
    if (hint !== undefined && hint < t.width && !used.has(hint) && readsShare(t.rows.map((r) => r.cells[hint] ?? ""), f.parser ?? "text", t.rows.length) >= READS_MIN) {
      at[name] = hint; used.add(hint); continue;
    }
    return null;
  }
  const fields: Record<string, TableField> = {};
  for (const [name, f] of Object.entries(ex.fields)) {
    const i = at[name];
    fields[name] = f.from === "column" && i !== undefined ? { ...f, header: t.headers[i] ?? f.header, index_hint: i } : f;
  }
  return { ...ex, match: tableMatch(read, t), fields };
}

// ---------------------------------------------------------------------------------------------------------------
// Record groups.

type Only<T, U> = T extends U ? T : never;
type ColumnField = Only<TableField, { from: "column" }>;
type SlotField = Only<RecordField, { from: "slot" }>;

/** The slot keys that a field's picks find in the records, most found first. */
function foundKeys(g: RecordGroup, picks: readonly SlotPick[]): string[] {
  const counts = new Map<string, number>();
  for (const rec of g.records) {
    const hit = pickSlot(rec, picks);
    if (hit) counts.set(hit.slot.key, (counts.get(hit.slot.key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/** The first unused slot key of the group whose texts the parser reads in 80% of the records. */
function unusedKey(g: RecordGroup, parser: ValueParser, used: Set<string>): string | null {
  for (const info of g.slots) {
    if (used.has(info.key)) continue;
    const texts = g.records.map((r) => r.slots.find((s) => s.key === info.key)?.text ?? "");
    if (readsShare(texts, parser, g.records.length) >= READS_MIN) return info.key;
  }
  return null;
}

/**
 * The slot fields of a records extract mapped to a new group. A field whose key pick names a key of the group, or that
 * has no key pick, stays. Another field gets picks from its fingerprint facts and type: a number (or another typed
 * value such as a quantity) a parse pick with its struck fact; a boolean with the button fact the button; a heading
 * text the heading; one other text field the longest slot; else the unused slot key that its parser reads in 80% of
 * the records. Null when a field finds no slot in any record.
 */
function remapGroup(g: RecordGroup, ex: RecordsExtract, fp: Fingerprint): RecordsExtract | null {
  const keys = new Set(g.slots.map((s) => s.key));
  const used = new Set<string>();
  const out: Record<string, RecordField> = {};
  const redo: [string, SlotField][] = [];
  for (const [name, f] of Object.entries(ex.fields)) {
    if (f.from !== "slot") continue;
    const keyPicks = f.pick.filter((p) => p.by === "key");
    if (keyPicks.length === 0 || keyPicks.some((p) => keys.has(p.key))) {
      out[name] = f;
      for (const k of foundKeys(g, f.pick).slice(0, 1)) used.add(k);
    } else redo.push([name, f]);
  }
  // Typed fields first, then the one longest text, then the fallbacks: each takes a slot that no other field took.
  let longest = false;
  const rest: [string, SlotField][] = [];
  const order = [...redo].sort((a, b) => rank(a, fp) - rank(b, fp));
  for (const [name, f] of order) {
    const info = fp.fields[name];
    const type = info?.type ?? fieldType(f);
    const slot = info?.slot;
    const parser = f.parser ?? "text";
    let picks: SlotPick[] | null = null;
    if (type === "number" || (type === "string" && parser !== "text")) picks = [{ by: "parse", parser, struck: slot?.struck === true }];
    else if (type === "boolean" && slot?.button) picks = [{ by: "fact", fact: "button" }];
    else if (type === "string" && slot?.heading) picks = [{ by: "fact", fact: "heading" }];
    else if (type === "string" && !longest) { picks = [{ by: "longest" }]; longest = true; }
    if (picks === null) { rest.push([name, f]); continue; }
    out[name] = withFallbacks(f, picks);
  }
  for (const f of Object.values(out)) if (f.from === "slot") for (const k of foundKeys(g, f.pick).slice(0, 1)) used.add(k);
  for (const [name, f] of rest) {
    const key = unusedKey(g, f.parser ?? "text", used);
    if (key === null) return null;
    used.add(key);
    out[name] = withFallbacks(f, [{ by: "key", key }]);
  }
  // A new plan must find a slot in at least one record.
  for (const [name] of redo) {
    const f = out[name];
    if (f?.from !== "slot" || foundKeys(g, f.pick).length === 0) return null;
  }
  const fields: Record<string, RecordField> = {};
  for (const [name, f] of Object.entries(ex.fields)) fields[name] = out[name] ?? f;
  return { ...ex, match: groupMatch(g), fields };
}

/** Typed fields first (0), heading texts (1), the other texts (2). */
function rank([name, f]: [string, SlotField], fp: Fingerprint): number {
  const type = fp.fields[name]?.type ?? fieldType(f);
  if (type !== "string" || (f.parser ?? "text") !== "text") return 0;
  return fp.fields[name]?.slot?.heading ? 1 : 2;
}

/** New picks, then the field's own picks that do not name a key, at most 4. */
function withFallbacks(f: SlotField, picks: SlotPick[]): SlotField {
  const all = [...picks];
  for (const p of f.pick) if (p.by !== "key" && !all.some((x) => JSON.stringify(x) === JSON.stringify(p))) all.push(p);
  return { ...f, pick: all.slice(0, 4) };
}

/** A group whose heading does not fit the saved one (headingFits) is no candidate: score 0. */
function groupCandidate(g: RecordGroup, a: Anchor & { extract: RecordsExtract }, params: Record<string, string>): { score: number; extract: RecordsExtract | null } {
  const m = a.extract.match;
  if (!headingFits(m.heading, g.heading, params)) return { score: 0, extract: null };
  const want = a.fingerprint.slot_keys.length > 0 ? a.fingerprint.slot_keys : m.slot_keys ?? [];
  const same = (m.shape !== undefined && m.shape === g.signature.shape) || (m.testid !== undefined && m.testid !== null && m.testid === g.signature.testid);
  const keys = a.fingerprint.keys;
  const keyShare = keys.length === 0 ? 0 : keys.filter((k) => g.records.some((r) => r.slots.some((s) => keyHit(s.text, k)))).length / keys.length;
  const extract = remapGroup(g, a.extract, a.fingerprint);
  return { score: 0.3 * jaccard(want, g.signature.slot_keys) + 0.2 * (same ? 1 : 0) + 0.3 * keyShare + 0.2 * (extract ? 1 : 0), extract };
}

/**
 * L1: the sets of the read that score at least 0.4 against the scraper's fingerprint, best first; the first whose
 * remapped extract gives rows that pass the scraper's own validate section. Null when none does.
 */
export function reanchor(read: PageRead, a: Anchor, ctx: ExtractContext): Reanchor | null {
  const tries: { set: string; score: number; extract: Extract | null }[] = [];
  const ex = a.extract;
  if (ex.source === "table") {
    for (const t of read.tables) {
      const score = tableCandidate(t, a, ex.match);
      if (score >= L1_MIN - 1e-9) tries.push({ set: t.id, score, extract: remapTable(read, t, ex) });
    }
  } else {
    for (const g of read.groups) {
      const c = groupCandidate(g, { ...a, extract: ex }, ctx.params);
      if (c.score >= L1_MIN - 1e-9) tries.push({ set: g.id, score: c.score, extract: c.extract });
    }
  }
  tries.sort((x, y) => y.score - x.score || Number(x.set.slice(1)) - Number(y.set.slice(1)));
  for (const t of tries) {
    if (!t.extract) continue;
    const outcome = extractFromSet(read, t.extract, t.set, ctx, t.score);
    const validation = validateRows(outcome.rows, a.validate);
    if (outcome.set !== null && outcome.rows.length > 0 && validation.ok) return { extract: t.extract, outcome, validation, set: t.set, score: t.score };
  }
  return null;
}

/** The best L1 candidate score of a read, for a heal problem line. */
export function bestCandidate(read: PageRead, a: Anchor, params: Record<string, string> = {}): number {
  const ex = a.extract;
  if (ex.source === "table") return Math.max(0, ...read.tables.map((t) => tableCandidate(t, a, ex.match)));
  return Math.max(0, ...read.groups.map((g) => groupCandidate(g, { ...a, extract: ex }, params).score));
}
