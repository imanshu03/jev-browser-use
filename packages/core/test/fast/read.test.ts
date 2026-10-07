// Unit tests for the page reader: limits, the shared key rule, the script string, and the loader. No Chrome.
import { describe, expect, it } from "vitest";
import type { Page } from "../../src/fast/model.js";
import { StalePage } from "../../src/fast/model.js";
import { NORM_KEY_SRC, loadAll, readLimits, readScript, type LoadOptions } from "../../src/fast/read.js";
import { READ_LIMITS, normKey, type ScrollState } from "../../src/fast/read-types.js";
import { CREDENTIAL_NAME } from "../../src/types.js";
import { fakePage, obs } from "./fakes.js";

describe("readLimits", () => {
  it("gives READ_LIMITS with no overrides", () => {
    expect(readLimits()).toEqual(READ_LIMITS);
    expect(readLimits({ text: false })).toEqual(READ_LIMITS);
  });
  it("merges overrides and keeps the other caps", () => {
    const l = readLimits({ limits: { rows: 10, tables: 3 } });
    expect(l.rows).toBe(10);
    expect(l.tables).toBe(3);
    expect(l.columns).toBe(READ_LIMITS.columns);
    expect(l.cellChars).toBe(READ_LIMITS.cellChars);
    expect(READ_LIMITS.rows).toBe(500);
  });
  it("floors a fraction, and ignores a negative value, NaN, and an unknown key", () => {
    const l = readLimits({ limits: { rows: 7.9, groups: -1, slots: Number.NaN, ...({ bogus: 3 } as object) } });
    expect(l.rows).toBe(7);
    expect(l.groups).toBe(READ_LIMITS.groups);
    expect(l.slots).toBe(READ_LIMITS.slots);
    expect("bogus" in l).toBe(false);
  });
});

describe("normKey", () => {
  it("normalizes a header name", () => {
    expect(normKey("Name Of Zone / Day:")).toBe("name of zone / day");
    expect(normKey("  Price  (₹) * ")).toBe("price (₹)");
    expect(normKey("ＡＢＣ\n\tTotal::")).toBe("abc total");
    expect(normKey("")).toBe("");
  });
  it("the page source of the rule gives the same keys", () => {
    const inPage = new Function(`return ${NORM_KEY_SRC}`)() as (s: unknown) => string;
    const corpus = ["Name Of Zone / Day:", "  Price  (₹) * ", "ＡＢＣ\n\tTotal::", "", "Average", "Q1 / Jan", "Rate*:", "ﬁle No."];
    for (const s of corpus) expect(inPage(s)).toBe(normKey(s));
    expect(inPage(null)).toBe("");
  });
});

describe("readScript", () => {
  it("is one expression that parses, with the caps, the text flag, and the credential rule inside", () => {
    const s = readScript({ text: false, limits: { rows: 10 } });
    expect(() => new Function(`return ${s}`)).not.toThrow();
    expect(s.startsWith("(function (cfg)")).toBe(true);
    const cfg = JSON.parse(s.slice(s.lastIndexOf(")(") + 2, -1)) as { limits: Record<string, number>; text: boolean; cred: string; flags: string };
    expect(cfg.limits).toEqual({ ...READ_LIMITS, rows: 10 });
    expect(cfg.text).toBe(false);
    expect(new RegExp(cfg.cred, cfg.flags).test("One-time code")).toBe(true);
    expect(cfg.cred).toBe(CREDENTIAL_NAME.source);
    expect(JSON.parse(readScript().slice(readScript().lastIndexOf(")(") + 2, -1)).text).toBe(true);
  });
  it("changes nothing on the page: no scroll, focus, click, attribute, or style write", () => {
    const s = readScript();
    expect(s).not.toMatch(/scrollTo|scrollBy|scrollIntoView|\.focus\(|\.blur\(|\.click\(|setAttribute|removeAttribute|\.style\.|innerHTML\s*=|appendChild|dispatchEvent/);
  });
});

// ---- The loader over a fake page with wheel.

interface FakeScroll {
  page: Page;
  wheels: number[];
}

/**
 * A page of `height` px in a 1000 px viewport. A wheel moves the scroll; after a wheel that reaches the bottom, the page
 * grows by `grow` px and `grow / 100` elements, `times` times (Infinity: always). `nodesOnly`: it adds elements but no
 * height (an inner panel). `stale`: wheel numbers (1-based, counting every call) that throw StalePage.
 */
function scrollPage(o: { height: number; grow?: number; times?: number; nodesOnly?: boolean; stale?: number[]; fail?: number }): FakeScroll {
  const page = fakePage({ pages: { a: obs("https://shop.test/list", []) }, start: "a" });
  const viewport = 1000;
  let y = 0;
  let height = o.height;
  let nodes = 100;
  let left = o.times ?? 0;
  let calls = 0;
  const wheels: number[] = [];
  page.wheel = async (dy: number): Promise<ScrollState> => {
    calls += 1;
    if (o.stale?.includes(calls)) throw new StalePage("fake: navigating");
    if (o.fail === calls) throw new Error("fake: connection closed");
    if (dy !== 0) {
      wheels.push(dy);
      y = Math.max(0, Math.min(height - viewport, y + dy));
      if (y + viewport >= height - 2 && left > 0) {
        left -= 1;
        nodes += Math.max(1, Math.round((o.grow ?? 0) / 100));
        if (!o.nodesOnly) height += o.grow ?? 0;
      }
    }
    return { y, height, viewport, nodes };
  };
  return { page, wheels };
}

const opts = (over: Partial<LoadOptions> = {}): LoadOptions => ({ maxScrolls: 12, stableRounds: 2, pauseMs: 600, maxMs: 30_000, ...over });
const noSleep = async (): Promise<void> => undefined;

describe("loadAll", () => {
  it("scrolls 0.9 viewport at a time until the page stops growing, then ends stable", async () => {
    const f = scrollPage({ height: 2500, grow: 1200, times: 3 });
    const sleeps: number[] = [];
    const r = await loadAll(f.page, opts(), async (ms) => { sleeps.push(ms); });
    expect(r.end).toBe("stable");
    expect(r.stable).toBe(true);
    expect(r.height).toBe(2500 + 3 * 1200);
    expect(r.nodes).toBe(100 + 3 * 12);
    expect(f.wheels.every((dy) => dy === 900)).toBe(true);
    expect(r.scrolls).toBe(f.wheels.length);
    expect(r.scrolls).toBeLessThanOrEqual(12);
    expect(sleeps.every((ms) => ms === 600)).toBe(true);
  });
  it("a page shorter than the viewport ends stable after stableRounds scrolls", async () => {
    const f = scrollPage({ height: 1000 });
    const r = await loadAll(f.page, opts({ stableRounds: 3 }), noSleep);
    expect(r).toMatchObject({ end: "stable", stable: true, scrolls: 3, height: 1000, nodes: 100 });
  });
  it("a long static page scrolls to the bottom first", async () => {
    const f = scrollPage({ height: 5000 });
    const r = await loadAll(f.page, opts(), noSleep);
    expect(r.end).toBe("stable");
    // 4 wheels go to y 3600; the 5th reaches the bottom at y 4000 (stable 1); the 6th stays there (stable 2).
    expect(r.scrolls).toBe(6);
  });
  it("new elements with no new height (an inner panel) are growth too", async () => {
    const f = scrollPage({ height: 1000, grow: 500, times: 3, nodesOnly: true });
    const r = await loadAll(f.page, opts(), noSleep);
    expect(r.end).toBe("stable");
    expect(r.nodes).toBe(115);
    expect(r.scrolls).toBe(5);
  });
  it("ends at maxScrolls on a page that always grows", async () => {
    const f = scrollPage({ height: 2000, grow: 1000, times: Infinity });
    const r = await loadAll(f.page, opts({ maxScrolls: 4 }), noSleep);
    expect(r).toMatchObject({ end: "scrolls", stable: false, scrolls: 4 });
  });
  it("maxScrolls 0 does not scroll", async () => {
    const f = scrollPage({ height: 2000 });
    const r = await loadAll(f.page, opts({ maxScrolls: 0 }), noSleep);
    expect(r).toMatchObject({ end: "scrolls", scrolls: 0 });
    expect(f.wheels).toEqual([]);
  });
  it("ends at maxMs, and the last pause is cut to the time left", async () => {
    const f = scrollPage({ height: 2000, grow: 1000, times: Infinity });
    const sleeps: number[] = [];
    const r = await loadAll(f.page, opts({ maxMs: 90, pauseMs: 40 }), async (ms) => { sleeps.push(ms); await new Promise((res) => setTimeout(res, ms)); });
    expect(r.end).toBe("time");
    expect(r.stable).toBe(false);
    expect(r.scrolls).toBeGreaterThanOrEqual(2);
    expect(r.ms).toBeGreaterThanOrEqual(85);
    expect(sleeps.every((ms) => ms <= 40)).toBe(true);
    expect(sleeps.at(-1)).toBeLessThan(40);
  });
  it("a page without wheel returns at once with end no_wheel", async () => {
    const page = fakePage({ pages: { a: obs("https://shop.test/list", []) }, start: "a" });
    const r = await loadAll(page, opts(), noSleep);
    expect(r).toEqual({ scrolls: 0, ms: 0, stable: false, height: 0, nodes: 0, end: "no_wheel" });
  });
  it("a StalePage (the document is navigating) is a round with growth, not an error", async () => {
    const f = scrollPage({ height: 1000, stale: [1, 3] });
    const r = await loadAll(f.page, opts(), noSleep);
    expect(r.end).toBe("stable");
    expect(r.height).toBe(1000);
  });
  it("never throws for a page that does not grow; another error propagates", async () => {
    await expect(loadAll(scrollPage({ height: 3000 }).page, opts({ maxScrolls: 30 }), noSleep)).resolves.toMatchObject({ end: "stable" });
    await expect(loadAll(scrollPage({ height: 3000, fail: 2 }).page, opts(), noSleep)).rejects.toThrow("connection closed");
  });
});
