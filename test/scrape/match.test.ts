import { describe, expect, it } from "vitest";
import type { PageRead, TableRead } from "../../src/fast/read-types.js";
import { normKey } from "../../src/fast/read-types.js";
import { buildExtract, extractRows, fingerprintOf } from "../../src/scrape/extract.js";
import { bestCandidate, reanchor } from "../../src/scrape/match.js";
import type { Extract, RecordsExtract, TableExtract, Validate } from "../../src/scrape/spec.js";
import { parseDraft } from "../../src/scrape/spec.js";
import { validateRows } from "../../src/scrape/validate.js";
import { clone, loadRead } from "./fakes.js";

const NECC = loadRead("necc");
const BLINKIT = loadRead("blinkit");
const CTX = { params: {} };

const NECC_EX = buildExtract(parseDraft({
  set: "t2",
  fields: { zone: { from: "column", header: "Name Of Zone / Day" }, avg: { from: "column", header: "Average", parser: "number" }, section: { from: "section" } },
  melt: { name_field: "day", value_field: "rate", value_parser: "number" },
  key: ["section", "zone", "day"],
}), NECC);
const NECC_VALIDATE: Validate = { min_rows: 10, required: ["zone", "avg", "rate"], expect_keys: { field: "zone", values: ["Hyderabad"] } };
const NECC_ROWS = extractRows(NECC, NECC_EX, CTX).rows;
const NECC_FP = fingerprintOf(NECC_EX, NECC, "t2", NECC_ROWS);

/** Key picks only: when the class names change, every field loses its slot. */
const SHOP = { kind: "boolean" as const, true_words: ["add"], false_words: ["out of stock"] };
const BLINKIT_EX = buildExtract(parseDraft({
  set: "g2",
  fields: {
    name: { from: "slot", pick: [{ by: "key", key: "div.tw-text-300" }] },
    pack: { from: "slot", pick: [{ by: "key", key: "div.tw-text-200" }], parser: "quantity" },
    price: { from: "slot", pick: [{ by: "key", key: "div.tw-flex@2>div>div.tw-text-200" }], parser: "price" },
    mrp: { from: "slot", pick: [{ by: "key", key: "div.tw-flex@2>div>div.tw-text-200@2" }], parser: "price" },
    can_add: { from: "slot", pick: [{ by: "key", key: "div.tw-flex@2>div.tw-rounded>div" }], parser: SHOP },
  },
  key: ["name", "pack"],
}), BLINKIT);
const BLINKIT_VALIDATE: Validate = { min_rows: 3, required: ["name", "price", "can_add"] };
const BLINKIT_ROWS = extractRows(BLINKIT, BLINKIT_EX, CTX).rows;
const BLINKIT_FP = fingerprintOf(BLINKIT_EX, BLINKIT, "g2", BLINKIT_ROWS);

function withTable(read: PageRead, edit: (t: TableRead) => void): PageRead {
  const r = clone(read);
  const t = r.tables[1] as TableRead;
  edit(t);
  t.signature.headers = t.headers.map(normKey);
  return r;
}

describe("L1 re-anchor: tables", () => {
  it("the fixture rows pass the validate section", () => {
    expect(NECC_ROWS.length).toBeGreaterThan(10);
    expect(validateRows(NECC_ROWS, NECC_VALIDATE).ok).toBe(true);
  });
  it("remaps a renamed header by token overlap; the rows equal the original", () => {
    const read = withTable(NECC, (t) => { t.headers[0] = "Zone Name / Day"; t.headers[5] = "Average (Rs)"; });
    const plain = extractRows(read, NECC_EX, CTX);
    expect(validateRows(plain.rows, NECC_VALIDATE).ok).toBe(false);
    const l1 = reanchor(read, { extract: NECC_EX, validate: NECC_VALIDATE, fingerprint: NECC_FP }, CTX);
    expect(l1).not.toBeNull();
    const ex = l1?.extract as TableExtract;
    expect(ex.fields["zone"]).toEqual({ from: "column", header: "Zone Name / Day", index_hint: 0 });
    expect(ex.fields["avg"]).toMatchObject({ header: "Average (Rs)", index_hint: 5 });
    expect(ex.match.headers[0]).toBe("zone name / day");
    expect(l1?.outcome.rows).toEqual(NECC_ROWS);
    expect(l1?.set).toBe("t2");
  });
  it("remaps a moved column by its header; the index hint follows", () => {
    const read = withTable(NECC, (t) => {
      t.headers = [...t.headers.slice(1), t.headers[0] as string];
      for (const r of t.rows) r.cells = [...r.cells.slice(1), r.cells[0] as string];
    });
    const l1 = reanchor(read, { extract: NECC_EX, validate: NECC_VALIDATE, fingerprint: NECC_FP }, CTX);
    expect((l1?.extract as TableExtract).fields["zone"]).toMatchObject({ header: "Name Of Zone / Day", index_hint: 5 });
    expect(l1?.outcome.rows).toEqual(NECC_ROWS);
  });
  it("takes the column at index_hint when no header fits and the parser reads its cells", () => {
    const read = withTable(NECC, (t) => { t.headers[5] = "Mean"; });
    const l1 = reanchor(read, { extract: NECC_EX, validate: NECC_VALIDATE, fingerprint: NECC_FP }, CTX);
    expect((l1?.extract as TableExtract).fields["avg"]).toMatchObject({ header: "Mean", index_hint: 5 });
    expect(l1?.outcome.rows).toEqual(NECC_ROWS);
  });
  it("returns null when no table scores 0.4, or when the rows fail the old validate section", () => {
    expect(reanchor(BLINKIT, { extract: NECC_EX, validate: NECC_VALIDATE, fingerprint: NECC_FP }, CTX)).toBeNull();
    const other = withTable(NECC, (t) => { t.headers = ["City", "Jan", "Feb", "Mar", "Apr", "May"]; t.caption = "x"; t.signature.caption = "x"; t.signature.heading = "other"; for (const r of t.rows) r.cells[0] = "Somewhere"; });
    expect(bestCandidate(other, { extract: NECC_EX, validate: NECC_VALIDATE, fingerprint: NECC_FP })).toBeLessThan(0.4);
    expect(reanchor(other, { extract: NECC_EX, validate: NECC_VALIDATE, fingerprint: NECC_FP }, CTX)).toBeNull();
  });
});

/** The read with every slot key and the group shape renamed: the new class names of a site release. */
function renamedGroup(read: PageRead): PageRead {
  const r = clone(read);
  const g = r.groups[1];
  if (!g) throw new Error("no g2");
  const ren = (k: string): string => k.replace(/tw-/g, "qx-");
  for (const rec of g.records) for (const s of rec.slots) s.key = ren(s.key);
  for (const s of g.slots) s.key = ren(s.key);
  g.signature.slot_keys = g.signature.slot_keys.map(ren);
  return r;
}

describe("L1 re-anchor: record groups", () => {
  it("the original extract fails on the renamed group", () => {
    const read = renamedGroup(BLINKIT);
    const plain = extractRows(read, BLINKIT_EX, CTX);
    expect(validateRows(plain.rows, BLINKIT_VALIDATE).ok).toBe(false);
  });
  it("a group whose slot keys all changed gets fact and parse picks; the rows equal the original", () => {
    const read = renamedGroup(BLINKIT);
    const l1 = reanchor(read, { extract: BLINKIT_EX, validate: BLINKIT_VALIDATE, fingerprint: BLINKIT_FP }, CTX);
    expect(l1).not.toBeNull();
    const ex = l1?.extract as RecordsExtract;
    expect(ex.fields["price"]).toMatchObject({ pick: [{ by: "parse", parser: "price", struck: false }] });
    expect(ex.fields["mrp"]).toMatchObject({ pick: [{ by: "parse", parser: "price", struck: true }] });
    expect(ex.fields["pack"]).toMatchObject({ pick: [{ by: "parse", parser: "quantity", struck: false }] });
    expect(ex.fields["can_add"]).toMatchObject({ pick: [{ by: "fact", fact: "button" }] });
    expect(ex.fields["name"]).toMatchObject({ pick: [{ by: "longest" }] });
    expect(ex.match.slot_keys?.every((k) => k.includes("qx-"))).toBe(true);
    expect(l1?.outcome.rows).toEqual(BLINKIT_ROWS);
    expect(l1?.score).toBeGreaterThanOrEqual(0.4);
  });
  it("keeps a field whose key is still in the group", () => {
    const read = renamedGroup(BLINKIT);
    const g = read.groups[1];
    for (const rec of g?.records ?? []) for (const s of rec.slots) if (s.key === "div.qx-text-300") s.key = "div.tw-text-300";
    for (const s of g?.slots ?? []) if (s.key === "div.qx-text-300") s.key = "div.tw-text-300";
    const l1 = reanchor(read, { extract: BLINKIT_EX, validate: BLINKIT_VALIDATE, fingerprint: BLINKIT_FP }, CTX);
    expect((l1?.extract as RecordsExtract).fields["name"]).toEqual(BLINKIT_EX.fields["name"]);
  });
  it("a renamed group under another heading is no candidate: L1 does not re-anchor to a sibling list", () => {
    const read = renamedGroup(BLINKIT);
    const g = read.groups[1];
    if (g) g.heading = "More to Explore";
    expect(reanchor(read, { extract: BLINKIT_EX, validate: BLINKIT_VALIDATE, fingerprint: BLINKIT_FP }, { params: { query: "eggs" } })).toBeNull();
    if (g) g.heading = "Showing results for eggs";
    expect(reanchor(read, { extract: BLINKIT_EX, validate: BLINKIT_VALIDATE, fingerprint: BLINKIT_FP }, { params: { query: "eggs" } })).not.toBeNull();
  });
  it("returns null when no group scores 0.4", () => {
    const read = clone(BLINKIT);
    read.groups = read.groups.slice(0, 1);
    expect(reanchor(read, { extract: BLINKIT_EX as Extract, validate: BLINKIT_VALIDATE, fingerprint: BLINKIT_FP }, CTX)).toBeNull();
  });
});
