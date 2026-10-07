// Rows as CSV (RFC 4180): a header of the field names, CRLF line ends, a quoted cell when it holds a comma, a quote, or
// a line break. A null value is an empty cell. Page text that a spreadsheet reads as a formula is made plain text.
import type { Row, RowValue } from "./spec.js";

/** The first character of a text that makes a spreadsheet read the cell as a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** A text cell that starts like a formula gets a "'" first, so that a spreadsheet shows it as text. A number does not. */
export function csvCell(v: RowValue | undefined): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" && FORMULA_START.test(v) ? `'${v}` : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The CSV text of the rows. The header is `columns` in order, then any other field of the rows. */
export function toCsv(rows: readonly Row[], columns: readonly string[] = []): string {
  const header = [...columns];
  for (const r of rows) for (const k of Object.keys(r)) if (!header.includes(k)) header.push(k);
  const lines = [header.map((h) => csvCell(h)).join(","), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(","))];
  return lines.join("\r\n") + "\r\n";
}
