import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SCRAPE_EXIT, SpecError, fillTemplate, fillUrl, parseDraft, parseScraper, placeholders } from "../../src/scrape/spec.js";
import { FIXTURES, clone } from "./fakes.js";

const raw = (name: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>;

function problems(fn: () => unknown): string[] {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(SpecError);
    return (e as Error).message.split("\n");
  }
  throw new Error("no SpecError");
}

describe("parseScraper", () => {
  it("parses both example files", () => {
    const necc = parseScraper(raw("necc-egg-prices"));
    expect(necc).toMatchObject({ name: "necc-egg-prices", version: 1, extract: { source: "table" }, load: { mode: "none" } });
    expect(necc.steps).toHaveLength(3);
    const qc = parseScraper(raw("qc-search"));
    expect(qc).toMatchObject({ name: "qc-search", version: 2, extract: { source: "records" }, load: { mode: "scroll" } });
    expect(qc.steps[2]).toEqual({ op: "click", target: { role: "button", name: "{area}", match: "starts" } });
  });
  it("rejects an unknown {param} in the task, the start URL, a step name, and a step value", () => {
    const s = clone(raw("qc-search"));
    s["task"] = "search for {nope}";
    s["start_url"] = "https://blinkit.com/s/?q={missing}";
    (s["steps"] as { value?: string }[])[1] = { ...(s["steps"] as object[])[1], value: "{also}" } as { value: string };
    const lines = problems(() => parseScraper(s));
    expect(lines).toContain("task: {nope} is not a param. Add it to params or remove it");
    expect(lines).toContain("start_url: {missing} is not a param. Add it to params or remove it");
    expect(lines).toContain("steps.1.value: {also} is not a param. Add it to params or remove it");
  });
  it("rejects unknown required, key, filter, and expect_keys fields with path: message lines", () => {
    const s = clone(raw("necc-egg-prices"));
    (s["validate"] as { required: string[] }).required = ["zone", "zzz"];
    (s["validate"] as { expect_keys: { field: string } }).expect_keys.field = "town";
    (s["extract"] as { key: string[] }).key = ["section", "nokey"];
    (s["extract"] as { filter?: unknown[] }).filter = [{ field: "nofield", op: "present" }];
    const lines = problems(() => parseScraper(s));
    expect(lines).toEqual(expect.arrayContaining([
      "validate.required.1: \"zzz\" is not a field of extract",
      "validate.expect_keys.field: \"town\" is not a field of extract",
      "extract.key.1: \"nokey\" is not a field of extract",
      "extract.filter.0.field: \"nofield\" is not a field of extract",
    ]));
  });
  it("melt fields count as fields; a param field must name a param", () => {
    const s = clone(raw("necc-egg-prices"));
    (s["validate"] as { required: string[] }).required = ["day", "rate"];
    expect(() => parseScraper(s)).not.toThrow();
    (s["extract"] as { fields: Record<string, unknown> }).fields["q"] = { from: "param", name: "query" };
    expect(problems(() => parseScraper(s))).toContain("extract.fields.q.name: param \"query\" is not in params");
  });
  it("rejects unknown keys and a bad name", () => {
    const s = { ...clone(raw("qc-search")), extra: 1, name: "Bad Name" };
    const lines = problems(() => parseScraper(s));
    expect(lines.some((l) => l.startsWith("name: "))).toBe(true);
    expect(lines.some((l) => l.startsWith("(root): ") && /extra/.test(l))).toBe(true);
  });
});

describe("parseDraft", () => {
  it("parses a draft", () => {
    expect(parseDraft({ set: "g1", fields: { name: { from: "slot", pick: [{ by: "longest" }] } }, load: "scroll" })).toMatchObject({ set: "g1", load: "scroll" });
  });
  it("rejects bad drafts with readable path: message lines", () => {
    expect(problems(() => parseDraft({ set: "x1", fields: {} }))).toEqual(expect.arrayContaining([
      "set: set is a table id (t1, t2, ...) or a record group id (g1, g2, ...) of the page read",
      "fields: 1-40 fields",
    ]));
    expect(problems(() => parseDraft({ set: "t1", fields: { Zone: { from: "column", header: "Zone" } } })).some((l) => l.startsWith("fields.Zone: "))).toBe(true);
    expect(problems(() => parseDraft({ set: "g1", fields: { a: { from: "slot", pick: [{ by: "regex", pattern: ".*" }] } } }))[0]).toMatch(/^fields\.a\.pick\.0\.by: /);
    expect(problems(() => parseDraft({ set: "t1", fields: { a: { from: "column", header: "A", parser: "regex" } } }))[0]).toMatch(/^fields\.a\.parser: /);
    expect(problems(() => parseDraft({ set: "t1", fields: { a: { from: "code", js: "x" } } }))[0]).toMatch(/^fields\.a\.from: /);
  });
});

describe("templates", () => {
  it("placeholders: each name once, {{ and }} are not placeholders", () => {
    expect(placeholders("{a} {b} {a} {{c}}")).toEqual(["a", "b"]);
  });
  it("fillTemplate fills and unescapes; a missing value is a SpecError", () => {
    expect(fillTemplate("q={query} {{x}}", { query: "egg" })).toBe("q=egg {x}");
    expect(() => fillTemplate("{query}", {})).toThrow("{query} has no value: pass --param query=<value>");
  });
  it("fillUrl encodes a value in the path, the query, and the hash; the scheme and the host take it as it is", () => {
    const u = fillUrl("https://blinkit.com/s/?q={query}&page=1", { query: "M&M chocolate #1 50% off" });
    expect(u).toBe("https://blinkit.com/s/?q=M%26M%20chocolate%20%231%2050%25%20off&page=1");
    expect(new URL(u).searchParams.get("q")).toBe("M&M chocolate #1 50% off");
    expect(fillUrl("https://shop.example/c/{cat}/p?x={{y}}#{h}", { cat: "a/b?c", h: "top" })).toBe("https://shop.example/c/a%2Fb%3Fc/p?x={y}#top");
    expect(fillUrl("https://{host}/s?q={q}", { host: "shop.example", q: "a b" })).toBe("https://shop.example/s?q=a%20b");
    expect(fillUrl("{u}", { u: "https://shop.example/x?y=1" })).toBe("https://shop.example/x?y=1");
    expect(() => fillUrl("https://x/{q}", {})).toThrow(SpecError);
  });
  it("exit codes", () => {
    expect(SCRAPE_EXIT).toEqual({ ok: 0, blocked: 2, failed: 3, usage: 4 });
  });
});
