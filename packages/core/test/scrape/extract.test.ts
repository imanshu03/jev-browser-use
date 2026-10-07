import { describe, expect, it } from "vitest";
import { buildExtract, extractFromSet, extractRows, fieldNames, fingerprintOf, passes } from "../../src/scrape/extract.js";
import type { Extract, ExtractDraft, RecordsExtract, TableExtract } from "../../src/scrape/spec.js";
import { Fingerprint, SpecError, parseDraft } from "../../src/scrape/spec.js";
import { clone, loadRead, loadSpec } from "./fakes.js";

const NECC = loadRead("necc");
const BLINKIT = loadRead("blinkit");
const ZEPTO = loadRead("zepto");
const CTX = { params: { month: "08", year: "2026" } };
const SHOP = { kind: "boolean" as const, true_words: ["add"], false_words: ["out of stock", "notify me"] };

const NECC_DRAFT: ExtractDraft = parseDraft({
  set: "t2",
  fields: { zone: { from: "column", header: "Name Of Zone / Day" }, section: { from: "section" }, month: { from: "meta", key: "ddlMonth" } },
  melt: { name_field: "day", value_field: "rate", value_parser: "number", skip: ["Average"] },
  key: ["section", "zone", "day"],
});

const BLINKIT_DRAFT: ExtractDraft = parseDraft({
  set: "g2",
  fields: {
    name: { from: "slot", pick: [{ by: "key", key: "div.tw-text-300" }, { by: "longest" }], parser: "text" },
    pack: { from: "slot", pick: [{ by: "parse", parser: "quantity" }], parser: "quantity" },
    price: { from: "slot", pick: [{ by: "parse", parser: "price", struck: false }], parser: "price" },
    mrp: { from: "slot", pick: [{ by: "parse", parser: "price", struck: true }], parser: "price" },
    can_add: { from: "slot", pick: [{ by: "fact", fact: "button" }], parser: SHOP },
  },
  key: ["name", "pack"],
});

const ZEPTO_DRAFT: ExtractDraft = parseDraft({
  set: "g1",
  fields: {
    name: { from: "slot", pick: [{ by: "key", key: "div.c#jbl>div>h5.c#gpd" }, { by: "fact", fact: "heading" }] },
    pack: { from: "slot", pick: [{ by: "key", key: "div.c#jbl>div.c#pqr>p" }], parser: "quantity" },
    price: { from: "slot", pick: [{ by: "key", key: "div.c#r4q>div.c#zqx>p.cptqcj" }, { by: "parse", parser: "price", struck: false }], parser: "price" },
    mrp: { from: "slot", pick: [{ by: "parse", parser: "price", struck: true }], parser: "price" },
    can_add: { from: "slot", pick: [{ by: "fact", fact: "button" }], parser: SHOP },
    link: { from: "href" },
    query: { from: "param", name: "query" },
    shop: { from: "const", value: "zepto" },
    page: { from: "url" },
  },
});

describe("buildExtract", () => {
  it("a table draft gets source table, the signature as match, and index hints", () => {
    const ex = buildExtract(NECC_DRAFT, NECC) as TableExtract;
    expect(ex.source).toBe("table");
    expect(ex.match).toEqual({ headers: ["name of zone / day", "1", "2", "3", "4", "average"], width: 6, heading: "daily egg prices", index: 1 });
    expect(ex.fields["zone"]).toEqual({ from: "column", header: "Name Of Zone / Day", index_hint: 0 });
    expect(ex.melt).toMatchObject({ name_field: "day", value_field: "rate" });
    expect(fieldNames(ex)).toEqual(["zone", "section", "month", "day", "rate"]);
  });
  it("a group draft gets source records and the group signature", () => {
    const ex = buildExtract(BLINKIT_DRAFT, BLINKIT) as RecordsExtract;
    expect(ex.source).toBe("records");
    expect(ex.match).toMatchObject({ shape: "div", parent: "div.categories-table", testid: null });
    expect(ex.match.slot_keys).toContain("div.tw-text-300");
  });
  it("header names compare in normKey form", () => {
    const d = clone(NECC_DRAFT);
    d.fields["zone"] = { from: "column", header: "  name of ZONE / day:" };
    expect((buildExtract(d, NECC) as TableExtract).fields["zone"]).toMatchObject({ index_hint: 0 });
  });
  it("rejects a slot field on a table, a column field on a group, and melt on a group", () => {
    const d1 = clone(NECC_DRAFT);
    d1.fields["x"] = { from: "slot", pick: [{ by: "longest" }] };
    expect(() => buildExtract(d1, NECC)).toThrow(/fields\.x: a slot field reads a record group; t2 is a table/);
    const d2 = clone(BLINKIT_DRAFT);
    d2.fields["zone"] = { from: "column", header: "Zone" };
    expect(() => buildExtract(d2, BLINKIT)).toThrow(/fields\.zone: a column field reads a table; g2 is a record group/);
    const d3 = { ...clone(BLINKIT_DRAFT), melt: { name_field: "day", value_field: "rate" } };
    expect(() => buildExtract(d3, BLINKIT)).toThrow(/melt: melt is for a table/);
  });
  it("rejects an unknown header, an unknown slot key, an unknown set, an unknown key field, and a missing form value", () => {
    const d1 = clone(NECC_DRAFT);
    d1.fields["zone"] = { from: "column", header: "Zone" };
    expect(() => buildExtract(d1, NECC)).toThrow(SpecError);
    expect(() => buildExtract(d1, NECC)).toThrow(/fields\.zone\.header: "Zone" is not a header of t2/);
    const d2 = clone(BLINKIT_DRAFT);
    d2.fields["name"] = { from: "slot", pick: [{ by: "key", key: "div.nope" }] };
    expect(() => buildExtract(d2, BLINKIT)).toThrow(/fields\.name\.pick\.0\.key: "div\.nope" is not a slot key of g2/);
    expect(() => buildExtract({ ...NECC_DRAFT, set: "t9" }, NECC)).toThrow(/set: t9 is not in the page read \(sets: t1, t2\)/);
    expect(() => buildExtract({ ...NECC_DRAFT, key: ["nope"] }, NECC)).toThrow(/key: nope is not a field/);
    const d3 = clone(NECC_DRAFT);
    d3.fields["month"] = { from: "meta", key: "ddlDay" };
    expect(() => buildExtract(d3, NECC)).toThrow(/fields\.month\.key: the page has no form value "ddlDay"/);
  });
});

describe("extractRows: tables", () => {
  it("NECC-like: section, meta, melt with skip and drop_empty", () => {
    const ex = buildExtract(NECC_DRAFT, NECC);
    const out = extractRows(NECC, ex, CTX);
    expect(out.set).toBe("t2");
    expect(out.score).toBeCloseTo(1, 5);
    expect(out.problems).toEqual([]);
    expect(out.rows).toHaveLength(14);
    expect(out.rows[0]).toEqual({ zone: "Ahmedabad", section: "NECC SUGGESTED EGG PRICES", month: "08", day: "1", rate: 590 });
    expect(Object.keys(out.rows[0] ?? {})).toEqual(["zone", "section", "month", "day", "rate"]);
    expect(out.rows.filter((r) => r["zone"] === "Hyderabad").map((r) => [r["day"], r["rate"]])).toEqual([["1", 525], ["2", 530]]);
    expect(out.rows.filter((r) => r["section"] === "Prevailing Prices")).toHaveLength(5);
    expect(out.rows.some((r) => r["day"] === "Average")).toBe(false);
  });
  it("drop_empty false keeps the empty cells as null", () => {
    const d = clone(NECC_DRAFT);
    (d.melt as NonNullable<ExtractDraft["melt"]>).drop_empty = false;
    const out = extractRows(NECC, buildExtract(d, NECC), CTX);
    expect(out.rows).toHaveLength(20);
    expect(out.rows.find((r) => r["zone"] === "Bhopal" && r["day"] === "3")?.["rate"]).toBeNull();
  });
  it("the example scraper file's extract reads the fixture: meta by name, the match finds t2 by its headers", () => {
    const spec = loadSpec("necc-egg-prices");
    const out = extractRows(NECC, spec.extract, CTX);
    expect(out.set).toBe("t2");
    expect(out.rows[0]).toMatchObject({ zone: "Ahmedabad", month: "08", year: "2026", day: "1", rate: 590 });
  });
  it("a meta field finds a form value by its label too, and use value", () => {
    const d = clone(NECC_DRAFT);
    d.fields["month"] = { from: "meta", key: "Month", use: "value" };
    expect(extractRows(NECC, buildExtract(d, NECC), CTX).rows[0]?.["month"]).toBe("08");
  });
  it("a table whose headers all changed is found by its index when the width is equal (score 0.3), columns by index_hint", () => {
    const ex = buildExtract(NECC_DRAFT, NECC);
    const read = clone(NECC);
    const t = read.tables[1] as (typeof read.tables)[number];
    t.headers = ["Zone", "D1", "D2", "D3", "D4", "Avg"];
    t.signature.headers = t.headers.map((h) => h.toLowerCase());
    t.signature.heading = "";
    const out = extractRows(read, ex, CTX);
    expect(out.set).toBe("t2");
    expect(out.score).toBeCloseTo(0.3, 5);
    expect(out.rows[0]?.["zone"]).toBe("Ahmedabad");
  });
  it("key dedupe: the first row wins", () => {
    const read = clone(NECC);
    const t = read.tables[1] as (typeof read.tables)[number];
    t.rows.push(clone(t.rows[0] as (typeof t.rows)[number]));
    const out = extractRows(read, buildExtract(NECC_DRAFT, read), CTX);
    expect(out.rows).toHaveLength(14);
  });
});

describe("extractRows: record groups", () => {
  it("Blinkit-like: key, parse (struck true/false), fact, and longest picks; key dedupe", () => {
    const out = extractRows(BLINKIT, buildExtract(BLINKIT_DRAFT, BLINKIT), { params: {} });
    expect(out.set).toBe("g2");
    expect(out.rows).toHaveLength(4);
    expect(out.rows[0]).toEqual({ name: "Licious Chicken Curry Cut (Skinless)", pack: "450 g", price: 187, mrp: 209, can_add: true });
    expect(out.rows[1]).toEqual({ name: "Fresho Farm Eggs", pack: "6 pcs", price: 66, mrp: null, can_add: true });
    expect(out.rows[3]).toEqual({ name: "Country Delight Paneer", pack: "200 g", price: 95, mrp: null, can_add: false });
    expect(out.problems).toEqual([]);
  });
  it("Zepto-like: price before name, heading fact, href, param, const, and url fields", () => {
    const out = extractRows(ZEPTO, buildExtract(ZEPTO_DRAFT, ZEPTO), { params: { query: "chicken" }, url: "https://www.zepto.com/search?query=chicken" });
    expect(out.set).toBe("g1");
    expect(out.rows).toHaveLength(3);
    expect(out.rows[0]).toEqual({
      name: "Licious Chicken Curry Cut", pack: "450 g", price: 187, mrp: 209, can_add: true,
      link: "https://www.zepto.com/pn/licious-chicken-curry-cut/pvid/1", query: "chicken", shop: "zepto", page: "https://www.zepto.com/search?query=chicken",
    });
    expect(out.rows[1]).toMatchObject({ pack: "1 pack", mrp: null });
    expect(out.rows[2]).toMatchObject({ name: "Mutton Curry Cut", can_add: false });
  });
  it("the longest pick leaves out button slots; the fact pick reads alt and href", () => {
    const read = clone(ZEPTO);
    const rec = read.groups[0]?.records[0];
    rec?.slots.push({ key: "img", text: "", alt: "Chicken photo" });
    const ex: Extract = {
      source: "records", match: buildExtract(ZEPTO_DRAFT, ZEPTO).match as RecordsExtract["match"],
      fields: {
        longest: { from: "slot", pick: [{ by: "longest" }] },
        photo: { from: "slot", pick: [{ by: "fact", fact: "alt" }] },
        link: { from: "slot", pick: [{ by: "fact", fact: "href" }] },
        second_price: { from: "slot", pick: [{ by: "parse", parser: "price", nth: 1 }], parser: "price" },
      },
    };
    const row = extractRows(read, ex, { params: {} }).rows[0];
    expect(row).toEqual({ longest: "Licious Chicken Curry Cut", photo: "Chicken photo", link: "https://www.zepto.com/pn/licious-chicken-curry-cut/pvid/1", second_price: 209 });
  });
  it("filters: gt, contains, present, eq, ne, absent, not_contains; a non-number fails gt", () => {
    const base = buildExtract(BLINKIT_DRAFT, BLINKIT);
    const run = (filter: Extract["filter"]) => extractRows(BLINKIT, { ...base, filter } as Extract, { params: {} }).rows.map((r) => r["name"]);
    expect(run([{ field: "price", op: "gt", value: 90 }])).toEqual(["Licious Chicken Curry Cut (Skinless)", "Country Delight Paneer"]);
    expect(run([{ field: "price", op: "lte", value: "72" }])).toEqual(["Fresho Farm Eggs", "Amul Taaza Toned Milk"]);
    expect(run([{ field: "name", op: "contains", value: "EGGS" }])).toEqual(["Fresho Farm Eggs"]);
    expect(run([{ field: "name", op: "not_contains", value: "eggs" }])).toHaveLength(3);
    expect(run([{ field: "mrp", op: "present" }])).toHaveLength(2);
    expect(run([{ field: "mrp", op: "absent" }])).toHaveLength(2);
    expect(run([{ field: "price", op: "eq", value: "66" }])).toEqual(["Fresho Farm Eggs"]);
    expect(run([{ field: "can_add", op: "ne", value: "true" }])).toEqual(["Country Delight Paneer"]);
    expect(run([{ field: "name", op: "gt", value: 1 }])).toEqual([]);
    expect(run([{ field: "price", op: "gt", value: 90 }, { field: "can_add", op: "eq", value: "true" }])).toEqual(["Licious Chicken Curry Cut (Skinless)"]);
    const out = extractRows(BLINKIT, { ...base, filter: [{ field: "price", op: "gt", value: 1000 }] } as Extract, { params: {} });
    expect(out.problems).toContain("the filter left 0 of 5 rows");
  });
  it("passes: eq compares numbers as numbers and texts in normal form", () => {
    expect(passes({ a: 187 }, { field: "a", op: "eq", value: "187.0" })).toBe(true);
    expect(passes({ a: "₹187" }, { field: "a", op: "eq", value: 187 })).toBe(true);
    expect(passes({ a: " Foo  Bar" }, { field: "a", op: "eq", value: "foo bar" })).toBe(true);
    expect(passes({ a: null }, { field: "a", op: "eq", value: "x" })).toBe(false);
  });
  it("a field that is null in most rows is a problem", () => {
    const d = clone(BLINKIT_DRAFT);
    d.fields["photo"] = { from: "slot", pick: [{ by: "fact", fact: "alt" }] };
    const out = extractRows(BLINKIT, buildExtract(d, BLINKIT), { params: {} });
    expect(out.problems).toEqual(["field photo is null in 4 of 4 rows"]);
  });
});

describe("extractRows: no match", () => {
  it("a table extract on a page with no such table gives set null and a problem, no throw", () => {
    const out = extractRows(BLINKIT, buildExtract(NECC_DRAFT, NECC), CTX);
    expect(out).toMatchObject({ rows: [], set: null, score: 0 });
    expect(out.problems[0]).toMatch(/^no table has the headers "name of zone \/ day", "1", "2", "3", "4", \.\.\. \(0 tables on the page\)$/);
  });
  it("a records extract on a page with no such group gives set null and a problem", () => {
    const out = extractRows(NECC, buildExtract(BLINKIT_DRAFT, BLINKIT), { params: {} });
    expect(out.set).toBeNull();
    expect(out.problems[0]).toMatch(/^no record group matches the extract/);
  });
  // The results group is absent (no results, or not rendered yet); a sibling group of the same card template shows
  // other products under its own heading.
  const sibling = (heading: string): typeof BLINKIT => {
    const r = clone(BLINKIT);
    const g = r.groups[1];
    if (!g) throw new Error("no g2");
    g.heading = heading;
    r.groups = [g];
    return r;
  };
  it("a group with the same template but another heading is not the set: the run fails and heals", () => {
    const ex = buildExtract(BLINKIT_DRAFT, BLINKIT) as RecordsExtract;
    expect(ex.match.heading).toBe("showing results for chicken curry cut");
    const out = extractRows(sibling("More to Explore"), ex, { params: { query: "chicken curry cut" } });
    expect(out).toMatchObject({ set: null, rows: [] });
    expect(out.problems[0]).toMatch(/^no record group matches the extract .*g2 has the shape of the rows under another heading/);
  });
  it("the heading of the rows fits with another query, another count, or no heading", () => {
    const ex = buildExtract(BLINKIT_DRAFT, BLINKIT);
    for (const heading of ["Showing results for butter", "Showing 24 results for \"butter\"", "Results for butter", ""]) {
      expect(extractRows(sibling(heading), ex, { params: { query: "butter" } }).set, heading).toBe("g2");
    }
  });
  it("extractFromSet reads a named set with no match step", () => {
    expect(extractFromSet(NECC, buildExtract(NECC_DRAFT, NECC), "t2", CTX).rows).toHaveLength(14);
    expect(extractFromSet(NECC, buildExtract(NECC_DRAFT, NECC), "t9", CTX)).toMatchObject({ set: null, rows: [] });
  });
});

describe("fingerprintOf", () => {
  it("a table: headers, types, the column of each field, key names of the first content key field, and the URL path", () => {
    const ex = buildExtract(NECC_DRAFT, NECC);
    const out = extractRows(NECC, ex, CTX);
    const fp = fingerprintOf(ex, NECC, "t2", out.rows);
    expect(Fingerprint.parse(fp)).toEqual(fp);
    expect(fp).toMatchObject({
      source: "table", headers: ["name of zone / day", "1", "2", "3", "4", "average"], slot_keys: [],
      keys: ["Ahmedabad", "Hyderabad", "Namakkal", "Allahabad (CC)", "Bhopal"], row_count: 14, url_path: "/home/eggprice",
    });
    expect(fp.fields).toEqual({
      zone: { type: "string", column: "name of zone / day" }, section: { type: "string" }, month: { type: "string" },
      day: { type: "string" }, rate: { type: "number" },
    });
  });
  it("a group: slot keys and the slot facts that each field's picks found", () => {
    const ex = buildExtract(BLINKIT_DRAFT, BLINKIT);
    const out = extractRows(BLINKIT, ex, { params: {} });
    const fp = fingerprintOf(ex, BLINKIT, "g2", out.rows);
    expect(fp.slot_keys).toEqual(BLINKIT.groups[1]?.signature.slot_keys);
    expect(fp.fields["mrp"]).toEqual({ type: "number", slot: { key: "div.tw-flex@2>div>div.tw-text-200@2", struck: true, button: false, heading: false } });
    expect(fp.fields["can_add"]).toMatchObject({ type: "boolean", slot: { button: true } });
    expect(fp.keys).toEqual(["Licious Chicken Curry Cut (Skinless)", "Fresho Farm Eggs", "Amul Taaza Toned Milk", "Country Delight Paneer"]);
  });
});
