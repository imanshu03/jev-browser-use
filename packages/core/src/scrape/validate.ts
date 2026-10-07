// Checks of the rows of one run against the scraper's validate section. Pure.
//
// The exported names and signatures are a contract of the scrape kit (see /tmp/jevscrape/build/SPEC.md, section C4).
import { normText } from "./parse.js";
import type { Row, Validate } from "./spec.js";

export interface Validation {
  ok: boolean;
  /** One line per failed check, for a person or a model. Never holds row values other than the expected key names. */
  problems: string[];
}

/** The share of rows in which a `required` field must be non-null when the section does not say. */
export const REQUIRED_RATIO = 0.8;

export function validateRows(rows: Row[], v: Validate): Validation {
  const problems: string[] = [];
  const n = rows.length;
  if (n < v.min_rows) problems.push(`${n} rows < min_rows ${v.min_rows}`);
  if (v.max_rows !== undefined && n > v.max_rows) problems.push(`${n} rows > max_rows ${v.max_rows}`);
  if (n > 0) {
    const ratio = v.required_ratio ?? REQUIRED_RATIO;
    for (const f of v.required) {
      const set = rows.filter((r) => (r[f] ?? null) !== null).length;
      if (set < ratio * n) problems.push(`field ${f} is set in ${set} of ${n} rows (required in ${Math.round(ratio * 100)}%)`);
    }
  }
  if (v.expect_keys) {
    const { field, values } = v.expect_keys;
    const have = new Set(rows.map((r) => r[field]).filter((x) => x !== null && x !== undefined).map((x) => normText(String(x))));
    for (const want of values) if (!have.has(normText(want))) problems.push(`expect_keys: ${JSON.stringify(want)} is not a value of ${field}`);
  }
  return { ok: problems.length === 0, problems };
}

/** The validate section for new rows: min_rows is half the row count (at least 1), `required` the fields that are never null. */
export function defaultValidate(rows: Row[], fields: string[]): Validate {
  return {
    min_rows: Math.max(1, Math.floor(rows.length / 2)),
    required: rows.length === 0 ? [] : fields.filter((f) => rows.every((r) => (r[f] ?? null) !== null)),
    required_ratio: REQUIRED_RATIO,
  };
}

/**
 * The validate section of a draft over a base: the draft's `min_rows` and `required` win when set; the other checks of
 * the base stay. Fields that `fields` does not have are left out of `required`.
 */
export function mergeValidate(base: Validate, draft: { min_rows?: number | undefined; required?: string[] | undefined } | undefined, fields: string[]): Validate {
  const known = new Set(fields);
  const { expect_keys: expect, ...rest } = base;
  return {
    ...rest,
    ...(draft?.min_rows !== undefined ? { min_rows: draft.min_rows } : {}),
    required: [...new Set((draft?.required ?? base.required).filter((f) => known.has(f)))],
    ...(expect && known.has(expect.field) ? { expect_keys: expect } : {}),
  };
}
