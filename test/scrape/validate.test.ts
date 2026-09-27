import { describe, expect, it } from "vitest";
import type { Row } from "../../src/scrape/spec.js";
import { defaultValidate, mergeValidate, validateRows } from "../../src/scrape/validate.js";

const ROWS: Row[] = [
  { zone: "Hyderabad", day: "1", rate: 525 },
  { zone: "Namakkal", day: "1", rate: 480 },
  { zone: "Bhopal", day: "1", rate: null },
  { zone: "Ahmedabad", day: "1", rate: 590 },
  { zone: " hyderabad ", day: "2", rate: 530 },
];

describe("validateRows", () => {
  it("passes when every check holds", () => {
    expect(validateRows(ROWS, { min_rows: 5, max_rows: 5, required: ["zone", "rate"], expect_keys: { field: "zone", values: ["Hyderabad", "NAMAKKAL"] } })).toEqual({ ok: true, problems: [] });
  });
  it("min_rows and max_rows", () => {
    expect(validateRows([], { min_rows: 5, required: [] }).problems).toEqual(["0 rows < min_rows 5"]);
    expect(validateRows(ROWS, { min_rows: 1, max_rows: 3, required: [] }).problems).toEqual(["5 rows > max_rows 3"]);
  });
  it("required uses required_ratio (default 0.8) and names only the field and the counts", () => {
    expect(validateRows(ROWS, { min_rows: 1, required: ["rate"] }).ok).toBe(true);
    const v = validateRows(ROWS, { min_rows: 1, required: ["rate"], required_ratio: 0.9 });
    expect(v).toEqual({ ok: false, problems: ["field rate is set in 4 of 5 rows (required in 90%)"] });
    expect(validateRows(ROWS, { min_rows: 1, required: ["price"] }).problems).toEqual(["field price is set in 0 of 5 rows (required in 80%)"]);
  });
  it("expect_keys compares normalized text and names only the missing key", () => {
    const v = validateRows(ROWS, { min_rows: 1, required: [], expect_keys: { field: "zone", values: ["Hyderabad", "Pune"] } });
    expect(v.problems).toEqual(["expect_keys: \"Pune\" is not a value of zone"]);
  });
  it("problems never hold row values", () => {
    const v = validateRows(ROWS, { min_rows: 10, max_rows: 1, required: ["rate", "zone", "nope"], required_ratio: 1 });
    for (const p of v.problems) for (const z of ["Namakkal", "Bhopal", "Ahmedabad", "525"]) expect(p).not.toContain(z);
  });
});

describe("defaultValidate and mergeValidate", () => {
  it("defaultValidate: half the rows, the fields that are never null", () => {
    expect(defaultValidate(ROWS, ["zone", "day", "rate"])).toEqual({ min_rows: 2, required: ["zone", "day"], required_ratio: 0.8 });
    expect(defaultValidate([{ a: 1 }], ["a"])).toEqual({ min_rows: 1, required: ["a"], required_ratio: 0.8 });
    expect(defaultValidate([], ["a"])).toEqual({ min_rows: 1, required: [], required_ratio: 0.8 });
  });
  it("mergeValidate: the draft's min_rows and required win; unknown fields go; the base checks stay", () => {
    const base = { min_rows: 500, max_rows: 5000, required: ["zone", "rate"], required_ratio: 0.9, expect_keys: { field: "zone", values: ["Hyderabad"] } };
    expect(mergeValidate(base, undefined, ["zone", "rate"])).toEqual(base);
    expect(mergeValidate(base, { min_rows: 10, required: ["zone", "ghost"] }, ["zone", "rate"])).toEqual({ ...base, min_rows: 10, required: ["zone"] });
    const renamed = mergeValidate(base, {}, ["town", "rate"]);
    expect(renamed).toEqual({ min_rows: 500, max_rows: 5000, required: ["rate"], required_ratio: 0.9 });
  });
});
