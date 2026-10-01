// The scraper file: a declarative JSON spec, checked with zod. It holds no code and no regular expression: steps name
// their targets by role and name, and the extract maps columns or record slots to fields through a closed set of value
// parsers. A run replays it with no model calls; a heal writes a new version and keeps the old one in `history`.
//
// Contract of the scrape kit (see /tmp/jevscrape/build/SPEC.md, section C). The scrape-core unit owns this file and may
// add optional fields; it must not rename or remove an exported name or a field, because the MCP tools use them.
import * as z from "zod";

/** Exit codes of jev-scrape. */
export const SCRAPE_EXIT = { ok: 0, blocked: 2, failed: 3, usage: 4 } as const;

/** A scraper name: the file name without ".json". */
export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** A param name. A template refers to it as `{name}`. */
export const PARAM_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** A row field name. */
export const FIELD_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** One `{param}` placeholder of a template. `{{` and `}}` are not placeholders. */
export const PLACEHOLDER_RE = /(?<!\{)\{([a-z][a-z0-9_]{0,39})\}(?!\})/g;

/** A scraper file, a draft, or a template that is not valid. The message says what and where, for a person or a model. */
export class SpecError extends Error {
  override name = "SpecError";
}

const Name = z.string().regex(NAME_RE, "a name is 1-63 characters: a-z, 0-9, _ and -, starting with a letter or digit");
const ParamName = z.string().regex(PARAM_RE, "a param name is a-z, 0-9 and _, starting with a letter, at most 40 characters");
const FieldName = z.string().regex(FIELD_RE, "a field name is a-z, 0-9 and _, starting with a letter, at most 40 characters");
/** Text with `{param}` placeholders. */
const Template = (max: number) => z.string().max(max);

export const GeoSchema = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().positive().max(100_000).optional(),
});

// ---------------------------------------------------------------------------------------------------------------
// Value parsers: a closed set. A parser turns the text of a cell or a slot into a row value, or null.

/**
 * text: the squashed text, null when empty. number: the first number ("1,23,456.50" is 123456.5; "-", "—", "NA" are
 * null). integer: a number with no fraction, else null. price: the number after a currency mark (₹, Rs, Rs., INR, $,
 * €, £, MRP), or a text that is only a number ("525"); "8 MINS" and "450 g" are not prices. percent: the number before
 * "%". quantity: "<number> <unit>" normalized ("450 g", "1 kg", "2 x 450 g", "6 pcs"); a weight or volume wins over a
 * count. url: an absolute http(s) URL, else null. See parse.ts.
 */
export const SIMPLE_PARSERS = ["text", "number", "integer", "price", "percent", "quantity", "url"] as const;
export type SimpleParser = (typeof SIMPLE_PARSERS)[number];

/** Literal words or phrases, matched on the normalized text as whole words. Never a pattern. */
const Word = z.string().min(1).max(60);

/**
 * boolean: true when the text holds a true word, false when it holds a false word, else null. False words win. With no
 * words the defaults hold: true "yes", "true", "available", "in stock", "add"; false "no", "false", "unavailable",
 * "not available", "out of stock", "sold out", "notify me" (TRUE_WORDS and FALSE_WORDS in parse.ts).
 */
export const BooleanParser = z.strictObject({
  kind: z.literal("boolean"),
  true_words: z.array(Word).max(10).optional(),
  false_words: z.array(Word).max(10).optional(),
});
/** date: an ISO date YYYY-MM-DD. `order` settles a numeric date such as 03/04/2026. Default DMY. */
export const DateParser = z.strictObject({ kind: z.literal("date"), order: z.enum(["DMY", "MDY", "YMD"]).optional() });
export const ValueParser = z.union([z.enum(SIMPLE_PARSERS), BooleanParser, DateParser]);
export type ValueParser = z.infer<typeof ValueParser>;

/** One value of a row. */
export type RowValue = string | number | boolean | null;
export type Row = Record<string, RowValue>;

// ---------------------------------------------------------------------------------------------------------------
// Fields. A table field reads a column; a record field reads a slot. Both can read the page meta, a param, a constant,
// or the page URL.

/** A column, found by its header name (normKey). `index_hint`: its 0-based column when the scraper was saved. */
export const ColumnField = z.strictObject({ from: z.literal("column"), header: z.string().min(1).max(200), parser: ValueParser.optional(), index_hint: z.number().int().min(0).max(39).optional() });
/** The section label of the row (TableRow.section). */
export const SectionField = z.strictObject({ from: z.literal("section"), parser: ValueParser.optional() });
/** A form value of the page (PageMeta.selected), found by its name, else its label. `use`: its text (default) or value. */
export const MetaField = z.strictObject({ from: z.literal("meta"), key: z.string().min(1).max(100), use: z.enum(["text", "value"]).optional(), parser: ValueParser.optional() });
/** A param of the run. */
export const ParamField = z.strictObject({ from: z.literal("param"), name: ParamName, parser: ValueParser.optional() });
export const ConstField = z.strictObject({ from: z.literal("const"), value: z.union([z.string().max(200), z.number(), z.boolean(), z.null()]) });
/** The page URL at the extraction. */
export const UrlField = z.strictObject({ from: z.literal("url") });

/**
 * How a record field finds its slot. The picks of a field are tried in order; the first that gives a slot wins.
 * - key: the slot with this key (Slot.key).
 * - fact: the nth slot with the fact; its text, or its alt for "alt", or its href for "href".
 * - parse: the nth slot whose text the parser reads (not null), with the struck and button facts when given.
 * - longest: the slot with the longest text; slots in a button are left out unless `button` is true.
 */
export const SlotPick = z.discriminatedUnion("by", [
  z.strictObject({ by: z.literal("key"), key: z.string().min(1).max(300) }),
  z.strictObject({ by: z.literal("fact"), fact: z.enum(["struck", "button", "heading", "disabled", "alt", "href"]), nth: z.number().int().min(0).max(20).optional() }),
  z.strictObject({ by: z.literal("parse"), parser: ValueParser, nth: z.number().int().min(0).max(20).optional(), struck: z.boolean().optional(), button: z.boolean().optional() }),
  z.strictObject({ by: z.literal("longest"), button: z.boolean().optional() }),
]);
export type SlotPick = z.infer<typeof SlotPick>;
export const SlotField = z.strictObject({ from: z.literal("slot"), pick: z.array(SlotPick).min(1).max(4), parser: ValueParser.optional() });
/** The href of the record (RecordRead.href). */
export const HrefField = z.strictObject({ from: z.literal("href") });

export const TableField = z.discriminatedUnion("from", [ColumnField, SectionField, MetaField, ParamField, ConstField, UrlField]);
export type TableField = z.infer<typeof TableField>;
export const RecordField = z.discriminatedUnion("from", [SlotField, HrefField, MetaField, ParamField, ConstField, UrlField]);
export type RecordField = z.infer<typeof RecordField>;
/** A field of a draft: either kind. buildExtract refuses a field that does not fit the set's kind. */
export const AnyField = z.discriminatedUnion("from", [ColumnField, SectionField, SlotField, HrefField, MetaField, ParamField, ConstField, UrlField]);
export type AnyField = z.infer<typeof AnyField>;

/**
 * Unpivot a wide table: each data row gives one output row per melted column. The melted columns are every column that
 * no `column` field reads and whose header is not in `skip`. `name_field` gets the header, `value_field` the parsed cell.
 * NECC: the zone column is a field, "Average" is skipped, and days 1..31 are melted into day and rate.
 */
export const Melt = z.strictObject({
  name_field: FieldName,
  value_field: FieldName,
  value_parser: ValueParser.optional(),
  skip: z.array(z.string().max(200)).max(40).optional(),
  /** Drop an output row whose value is null. Default true. */
  drop_empty: z.boolean().optional(),
});
export type Melt = z.infer<typeof Melt>;

/** Keep only rows that pass every filter. Values are literals; `contains` compares normalized text. */
export const Filter = z.strictObject({
  field: FieldName,
  op: z.enum(["eq", "ne", "contains", "not_contains", "present", "absent", "gt", "gte", "lt", "lte"]),
  value: z.union([z.string().max(200), z.number()]).optional(),
});
export type Filter = z.infer<typeof Filter>;

const Fields = <T extends z.ZodType>(f: T) => z.record(FieldName, f).refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 40, "1-40 fields");

/** How a table is found again: normKey header names first, then width, caption, heading; `index` is the last resort. */
export const TableMatch = z.strictObject({
  headers: z.array(z.string().max(200)).min(1).max(40),
  width: z.number().int().min(1).max(400).optional(),
  caption: z.string().max(200).optional(),
  heading: z.string().max(200).optional(),
  index: z.number().int().min(0).max(100).optional(),
});
/** How a record group is found again (GroupSignature). */
export const GroupMatch = z.strictObject({
  shape: z.string().max(200).optional(),
  parent: z.string().max(200).optional(),
  testid: z.string().max(200).nullable().optional(),
  slot_keys: z.array(z.string().max(300)).max(40).optional(),
  heading: z.string().max(200).optional(),
});

export const TableExtract = z.strictObject({
  source: z.literal("table"),
  match: TableMatch,
  fields: Fields(TableField),
  melt: Melt.optional(),
  filter: z.array(Filter).max(10).optional(),
  /** Fields that name a row. Rows with the same key are one row (the first wins). */
  key: z.array(FieldName).max(5).optional(),
});
export const RecordsExtract = z.strictObject({
  source: z.literal("records"),
  match: GroupMatch,
  fields: Fields(RecordField),
  filter: z.array(Filter).max(10).optional(),
  key: z.array(FieldName).max(5).optional(),
});
export const Extract = z.discriminatedUnion("source", [TableExtract, RecordsExtract]);
export type Extract = z.infer<typeof Extract>;
export type TableExtract = z.infer<typeof TableExtract>;
export type RecordsExtract = z.infer<typeof RecordsExtract>;

/**
 * What Claude (MCP scraper save) and the scraper LLM (L3, authoring) write: a set id of one page read ("t2", "g1") and
 * its fields. Code turns it into an Extract with the set's signature as `match` (buildExtract in extract.ts).
 */
export const ExtractDraft = z.strictObject({
  set: z.string().regex(/^[tg][0-9]{1,3}$/, "set is a table id (t1, t2, ...) or a record group id (g1, g2, ...) of the page read"),
  fields: z.record(FieldName, AnyField).refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 40, "1-40 fields"),
  melt: Melt.optional(),
  filter: z.array(Filter).max(10).optional(),
  key: z.array(FieldName).max(5).optional(),
  /** "scroll": the page loads more records as it scrolls. */
  load: z.enum(["scroll", "none"]).optional(),
  validate: z.strictObject({ min_rows: z.number().int().min(0).max(100_000).optional(), required: z.array(FieldName).max(40).optional() }).optional(),
});
export type ExtractDraft = z.infer<typeof ExtractDraft>;

// ---------------------------------------------------------------------------------------------------------------
// Steps: the recorded navigation from start_url to the page with the rows.

/**
 * A control on the page, as the fast snapshot names it: its role and its name (Action.role and Action.label; a select
 * is named without its " → <option>" part). `match`: how the name compares after normalization. `under`: the name of
 * the dialog or section around it, "" for anywhere; replay prefers controls in a popup when it is set. `nth`: the
 * 0-based index among the controls that match, in snapshot order.
 */
export const Target = z.strictObject({
  role: z.string().min(1).max(40),
  name: Template(300).min(1),
  match: z.enum(["exact", "starts", "contains"]).optional(),
  under: z.string().max(200).optional(),
  nth: z.number().int().min(0).max(50).optional(),
});
export type Target = z.infer<typeof Target>;

export const PRESS_KEYS = ["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp", "PageDown", "PageUp"] as const;

export const Step = z.discriminatedUnion("op", [
  /** `optional`: skip the click when the target is not there (a cookie banner that shows only sometimes). */
  z.strictObject({ op: z.literal("click"), target: Target, optional: z.boolean().optional() }),
  /** Replace the field text with the value. */
  z.strictObject({ op: z.literal("fill"), target: Target, value: Template(2000) }),
  /** Pick the option with this label in the select named by the target. */
  z.strictObject({ op: z.literal("select"), target: Target, value: Template(300).min(1) }),
  z.strictObject({ op: z.literal("press"), key: z.enum(PRESS_KEYS) }),
  z.strictObject({ op: z.literal("scroll"), direction: z.enum(["down", "up"]).optional(), times: z.number().int().min(1).max(20).optional() }),
  /** Wait `ms`, or until the page text holds `for_text` (at most `ms`, default 8000 then). */
  z.strictObject({ op: z.literal("wait"), ms: z.number().int().min(0).max(30_000).optional(), for_text: Template(200).optional() }),
  z.strictObject({ op: z.literal("back") }),
]);
export type Step = z.infer<typeof Step>;

/** Scroll to load more records before the read (loadAll in src/fast/read.ts). */
export const LoadRule = z.strictObject({
  mode: z.enum(["none", "scroll"]),
  max_scrolls: z.number().int().min(0).max(60).optional(),      // default 12
  stable_rounds: z.number().int().min(1).max(5).optional(),     // default 2
  pause_ms: z.number().int().min(100).max(5000).optional(),     // default 600
  max_ms: z.number().int().min(1000).max(120_000).optional(),   // default 30000
});
export type LoadRule = z.infer<typeof LoadRule>;
export const LOAD_DEFAULTS = { max_scrolls: 12, stable_rounds: 2, pause_ms: 600, max_ms: 30_000 } as const;

export const Validate = z.strictObject({
  min_rows: z.number().int().min(0).max(100_000),
  max_rows: z.number().int().min(1).max(1_000_000).optional(),
  /** Fields that must be non-null in at least `required_ratio` of the rows (default 0.8). */
  required: z.array(FieldName).max(40),
  required_ratio: z.number().min(0).max(1).optional(),
  /** A few row key names that must be in the rows (for example "Hyderabad"). At most 5. */
  expect_keys: z.strictObject({ field: FieldName, values: z.array(z.string().min(1).max(60)).min(1).max(5) }).optional(),
});
export type Validate = z.infer<typeof Validate>;

/**
 * What the extraction looked like when it last worked. L1 re-anchor uses it to find the set and the fields again. It
 * holds header names, slot keys, field types, and at most 5 key names; never rows or other page text.
 */
export const Fingerprint = z.strictObject({
  source: z.enum(["table", "records"]),
  headers: z.array(z.string().max(200)).max(40),
  slot_keys: z.array(z.string().max(300)).max(40),
  fields: z.record(FieldName, z.strictObject({
    type: z.enum(["string", "number", "boolean"]),
    column: z.string().max(200).optional(),
    slot: z.strictObject({ key: z.string().max(300), struck: z.boolean(), button: z.boolean(), heading: z.boolean() }).optional(),
  })),
  keys: z.array(z.string().max(60)).max(5),
  row_count: z.number().int().min(0),
  /** The path of the page URL, no query or hash. */
  url_path: z.string().max(300),
});
export type Fingerprint = z.infer<typeof Fingerprint>;

export const HEAL_LEVELS = ["author", "L1", "L2", "L3", "manual"] as const;
export type HealLevel = (typeof HEAL_LEVELS)[number];

/** The parts of a spec that a heal can change. A heal entry keeps them as they were before it. */
export const SpecBody = z.strictObject({
  start_url: Template(2000).min(1),
  steps: z.array(Step).max(40),
  load: LoadRule,
  extract: Extract,
  validate: Validate,
  fingerprint: Fingerprint,
});
export type SpecBody = z.infer<typeof SpecBody>;

export const HealEntry = z.strictObject({
  at: z.string().max(40),                  // ISO time
  level: z.enum(HEAL_LEVELS),
  reason: z.string().max(300),
  from_version: z.number().int().min(0),   // 0 for "author"
  previous: SpecBody.nullable(),           // null for "author"
});
export type HealEntry = z.infer<typeof HealEntry>;

/** Heal entries kept in a file. The oldest go first. */
export const HISTORY_MAX = 10;

export const ScraperSpec = z.strictObject({
  kind: z.literal("jev-scraper"),
  format: z.literal(1),
  name: Name,
  version: z.number().int().min(1),
  created_at: z.string().max(40),
  updated_at: z.string().max(40),
  /** The task in the user's words, with `{param}` placeholders. L2 gives it to Jev. */
  task: Template(2000).min(1),
  /** What rows and fields the user wants, in words. L3 gives it to the LLM. */
  want: z.string().max(2000),
  /** Param defaults. A run can override each one. */
  params: z.record(ParamName, z.string().max(500)),
  /** The Chrome profile name or directory. Default "Parallelloop". */
  profile: z.string().min(1).max(100).optional(),
  browser: z.enum(["chrome", "edge", "brave", "chromium"]).optional(),
  geo: GeoSchema.optional(),
  ...SpecBody.shape,
  history: z.array(HealEntry).max(HISTORY_MAX),
}).superRefine((s, ctx) => {
  const known = new Set(Object.keys(s.params));
  const check = (text: string, path: (string | number)[]): void => {
    for (const name of placeholders(text)) if (!known.has(name)) ctx.addIssue({ code: "custom", path, message: `{${name}} is not a param. Add it to params or remove it` });
  };
  check(s.task, ["task"]);
  check(s.start_url, ["start_url"]);
  s.steps.forEach((st, i) => {
    if ("target" in st) check(st.target.name, ["steps", i, "target", "name"]);
    if ((st.op === "fill" || st.op === "select") && st.value) check(st.value, ["steps", i, "value"]);
    if (st.op === "wait" && st.for_text) check(st.for_text, ["steps", i, "for_text"]);
  });
  const fields = new Set(Object.keys(s.extract.fields));
  if (s.extract.source === "table" && s.extract.melt) { fields.add(s.extract.melt.name_field); fields.add(s.extract.melt.value_field); }
  const need = (name: string, path: (string | number)[]): void => { if (!fields.has(name)) ctx.addIssue({ code: "custom", path, message: `"${name}" is not a field of extract` }); };
  s.validate.required.forEach((f, i) => need(f, ["validate", "required", i]));
  if (s.validate.expect_keys) need(s.validate.expect_keys.field, ["validate", "expect_keys", "field"]);
  (s.extract.key ?? []).forEach((f, i) => need(f, ["extract", "key", i]));
  (s.extract.filter ?? []).forEach((f, i) => need(f.field, ["extract", "filter", i, "field"]));
  for (const [f, def] of Object.entries(s.extract.fields)) if (def.from === "param" && !known.has(def.name)) ctx.addIssue({ code: "custom", path: ["extract", "fields", f, "name"], message: `param "${def.name}" is not in params` });
});
export type ScraperSpec = z.infer<typeof ScraperSpec>;

/** How far a run may heal. full: L1, then L2 (Jev), then L3 (LLM). code: L1 only. none: no heal. */
export type HealMode = "full" | "code" | "none";

/**
 * What one run of a scraper gives: the JSON that jev-scrape prints (rows can move to `--out`), and what the MCP
 * scraper run returns under its view budget.
 */
export interface ScrapeResult {
  scraper: string;
  /** The version that gave the rows: the healed version after a heal. */
  version: number;
  params: Record<string, string>;
  /** The page URL of the extraction, or of the failure. */
  url: string | null;
  rows: Row[];
  row_count: number;
  status: "ok" | "blocked" | "failed";
  healed: { level: Exclude<HealLevel, "author" | "manual">; reason: string } | null;
  /** Why the run blocked or failed; null when ok. */
  reason: string | null;
  /** A person is needed: a sign-in wall or a captcha that no pause cleared. */
  blocked: { kind: "sign_in" | "captcha"; hint: string } | null;
  /** The file that a heal saved. */
  saved: string | null;
  stats: { duration_ms: number; jev_requests: number; llm_calls: number; steps: number; scrolls: number };
}

/** The `{param}` names of a template, in order, each once. */
export function placeholders(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) if (m[1] && !out.includes(m[1])) out.push(m[1]);
  return out;
}

function fillWith(text: string, params: Record<string, string>, put: (v: string) => string): string {
  const out = text.replace(PLACEHOLDER_RE, (_m, name: string) => {
    const v = params[name];
    if (v === undefined) throw new SpecError(`{${name}} has no value: pass --param ${name}=<value>`);
    return put(v);
  });
  return out.replace(/\{\{/g, "{").replace(/\}\}/g, "}");
}

/** Fill the placeholders of a template. Throws SpecError when a param has no value. `{{` and `}}` become `{` and `}`. */
export function fillTemplate(text: string, params: Record<string, string>): string {
  return fillWith(text, params, (v) => v);
}

/** The scheme and the host of a start URL template: the text before the first "/", "?", or "#" after "://". */
export function urlHost(template: string): string {
  const scheme = template.indexOf("://");
  const from = scheme >= 0 ? scheme + 3 : 0;
  const m = /[/?#]/.exec(template.slice(from));
  return template.slice(0, m ? from + m.index : template.length);
}

/**
 * Fill the placeholders of a start URL template. A value in the path, the query, or the hash is encoded with
 * encodeURIComponent, so "&", "#", "%", "/", and "?" in a value stay part of that value. A value in the scheme and the
 * host (urlHost) goes in as it is. Throws SpecError as fillTemplate.
 */
export function fillUrl(template: string, params: Record<string, string>): string {
  const head = urlHost(template);
  return fillWith(head, params, (v) => v) + fillWith(template.slice(head.length), params, encodeURIComponent);
}

/** Parse and check a scraper file. Throws SpecError with every problem as `path: message`, one per line. */
export function parseScraper(data: unknown): ScraperSpec {
  const r = ScraperSpec.safeParse(data);
  if (r.success) return r.data;
  throw new SpecError(issuesText(r.error));
}

/** Parse a draft (Claude or the LLM wrote it). Throws SpecError with the problems. */
export function parseDraft(data: unknown): ExtractDraft {
  const r = ExtractDraft.safeParse(data);
  if (r.success) return r.data;
  throw new SpecError(issuesText(r.error));
}

/** zod issues as `path: message` lines, at most 12. */
export function issuesText(e: z.ZodError): string {
  return e.issues.slice(0, 12).map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`).join("\n");
}
