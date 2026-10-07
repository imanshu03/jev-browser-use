import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { candidateLines, chunkLines, extractAnswer, normalizeLine, verify } from "../src/extract.js";
import { parseSnapshot } from "../src/snapshot.js";
import type { Span } from "../src/types.js";
import { fakeOracle, snap } from "./fakes.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")).data;
const page = parseSnapshot({ url: "https://x", title: "Alan Turing - Wikipedia", interactive: snap('- heading "Alan Turing" [level=1, ref=e1]\n- link "Go" [ref=e2]') });
const line = (i: number, text: string): Span => ({ id: `L${i}`, text, source: "page_line", secret: false });

describe("candidateLines", () => {
  it("puts role-prefixed names first, then body lines, dedupes, cuts 160, caps 1800", () => {
    const full = snap('- heading "Alan Turing" [level=1, ref=e1]\n- paragraph\n  - StaticText "Alan Turing was a mathematician."\n- link "Go" [ref=e2]');
    const body = "Alan Turing\nAlan Turing was a mathematician.\nx\n" + "y".repeat(400) + "\n" + Array.from({ length: 2000 }, (_, i) => `row ${i}`).join("\n");
    const lines = candidateLines(page, full, body);
    expect(lines[0]?.text).toBe("title: Alan Turing - Wikipedia");
    expect(lines[1]?.text).toBe("heading: Alan Turing");
    expect(lines[2]?.text).toBe("text: Alan Turing was a mathematician.");
    expect(lines[3]?.text).toBe("link: Go");
    expect(lines[4]?.text).toBe("Alan Turing");
    expect(lines.some((l) => l.text === "x")).toBe(false);
    expect(lines.find((l) => l.text.startsWith("yyy"))?.text.length).toBe(160);
    expect(lines.length).toBe(1800);
    expect(lines.filter((l) => l.text === "Alan Turing was a mathematician.").length).toBe(1);
  });
  it("uses element names when no full tree is given", () => {
    expect(candidateLines(page, undefined, "").map((l) => l.text)).toEqual(["title: Alan Turing - Wikipedia", "heading: Alan Turing", "link: Go"]);
  });
  it("finds the title heading early on the Turing fixture", () => {
    const p = parseSnapshot({ url: "https://en.wikipedia.org/wiki/Alan_Turing", title: "Alan Turing - Wikipedia", interactive: fixture("wikipedia-turing.snapshot"), full: fixture("wikipedia-turing.full") });
    const lines = candidateLines(p, fixture("wikipedia-turing.full"), "");
    expect(lines.findIndex((l) => l.text === "heading: Alan Turing")).toBeLessThan(100);
  });
  it("chunkLines: 600 per request, 200 per chunk", () => {
    const lines = Array.from({ length: 1300 }, (_, i) => line(i, `l${i}`));
    const r = chunkLines(lines);
    expect(r.length).toBe(3);
    expect(r[0]?.map((c) => c.length)).toEqual([200, 200, 200]);
    expect(r[2]?.map((c) => c.length)).toEqual([100]);
  });
});

describe("extractAnswer", () => {
  const lines = Array.from({ length: 700 }, (_, i) => line(i, i === 5 ? "heading: Alan Turing" : i === 250 ? "text: Alan Turing" : `l${i}`));
  it("one chunk winner -> best without ANSWER_FINAL, and stops after the first request", async () => {
    const oracle = fakeOracle([{ name: "extract", answers: () => ({ answer_0: { choice: "L5", confidence: 0.45, probabilities: { L5: 0.45, none: 0.55 } }, answer_1: "none", answer_2: "none" }) }]);
    const r = await extractAnswer({ task: "t", goal: "extract", page, lines, history: [], oracle, bannedLineIds: new Set() });
    expect(r.best).toMatchObject({ id: "L5", text: "heading: Alan Turing", confidence: 0.45 });
    expect(oracle.requests.map((q) => q.name)).toEqual(["extract"]);
  });
  it("two winners -> ANSWER_FINAL; near-duplicates merge; banned lines are skipped", async () => {
    const oracle = fakeOracle([
      { name: "extract", answers: () => ({ answer_0: { choice: "L5", confidence: 0.5, probabilities: { L5: 0.5, none: 0.5 } }, answer_1: { choice: "L250", confidence: 0.4, probabilities: { L250: 0.4, none: 0.6 } }, answer_2: "none" }) },
      { name: "answer_final", answers: () => ({ answer_final: { choice: "L5", confidence: 0.45, probabilities: { L5: 0.45, L250: 0.4, none: 0.15 } } }) },
    ]);
    const r = await extractAnswer({ task: "t", goal: "extract", page, lines, history: [], oracle, bannedLineIds: new Set() });
    expect(oracle.requests.map((q) => q.name)).toEqual(["extract", "answer_final"]);
    expect(r.best).toMatchObject({ id: "L5", confidence: 0.85 });
    expect(normalizeLine("heading: Alan Turing")).toBe("alan turing");
    const banned = await extractAnswer({ task: "t", goal: "extract", page, lines, history: [], oracle: fakeOracle([{ name: "extract", answers: () => ({ answer_0: "L5" }) }]), bannedLineIds: new Set(["L5"]) });
    expect(banned.best).toBeNull();
  });
  it("takes the best non-none line at the threshold even when none was chosen", async () => {
    const oracle = fakeOracle([{ name: "extract", answers: () => ({ answer_0: { choice: "none", confidence: 0.6, probabilities: { none: 0.6, L5: 0.25, L6: 0.15 } }, answer_1: "none", answer_2: "none" }) }]);
    const r = await extractAnswer({ task: "t", goal: "extract", page, lines, history: [], oracle, bannedLineIds: new Set() });
    expect(r.best).toMatchObject({ id: "L5", confidence: 0.25 });
  });
  it("goes to the second request when the first has no winner", async () => {
    const oracle = fakeOracle((name, _s, q) => (Object.keys(q).includes("answer_2") ? {} : { answer_0: { choice: "L600", confidence: 0.7, probabilities: { L600: 0.7, none: 0.3 } } }));
    const r = await extractAnswer({ task: "t", goal: "extract", page, lines, history: [], oracle, bannedLineIds: new Set() });
    expect(r.requests).toBe(2);
    expect(r.best?.id).toBe("L600");
  });
});

describe("verify", () => {
  it("collects evidence lines with probability >= 0.30, max 3", async () => {
    const lines = Array.from({ length: 450 }, (_, i) => line(i, `l${i}`));
    const oracle = fakeOracle([{ name: "verify", answers: () => ({ done_final: 0.9, answer_ok: 0.8, evidence_0: { choice: "L1", confidence: 0.5, probabilities: { L1: 0.5 } }, evidence_1: { choice: "L201", confidence: 0.2, probabilities: { L201: 0.2 } }, evidence_2: { choice: "L401", confidence: 0.6, probabilities: { L401: 0.6 } } }) }]);
    const v = await verify({ task: "t", goal: "extract", page, textExcerpt: "x", lines, history: [], candidate: line(1, "l1"), oracle });
    expect(v).toEqual({ doneFinal: 0.9, answerOk: 0.8, evidence: ["l1", "l401"], requests: 1 });
    const noCand = await verify({ task: "t", goal: "act", page, textExcerpt: "x", lines, history: [], candidate: null, oracle: fakeOracle([]) });
    expect(noCand.answerOk).toBeNull();
  });
});
