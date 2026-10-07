// Live test: pointer rows (rule B in snapshot.ts), the page height of a quirks-mode page, and the geolocation override.
// One headless Chrome on a temporary profile, file:// fixtures, no network. Run with `npm run test:live` (JEV_LIVE=1).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChrome } from "../../src/fast/chrome.js";
import type { Action, Chrome, GeoPoint, Observation, Page } from "../../src/fast/model.js";
import { StalePage } from "../../src/fast/model.js";
import { openPage } from "../../src/fast/page.js";
import { buildStep } from "../../src/fast/policy.js";
import { fakeLogger } from "../fakes.js";

const FIXTURES = path.resolve(__dirname, "../fixtures/live");
const rowsUrl = pathToFileURL(path.join(FIXTURES, "pointer-rows.html")).href;
const quirksUrl = pathToFileURL(path.join(FIXTURES, "quirks.html")).href;
const NAV_MS = 5000;
const GEO: GeoPoint = { latitude: 12.9352, longitude: 77.6245, accuracy: 30 };

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe.skipIf(process.env["JEV_LIVE"] !== "1")("pointer rows and quirks height (live Chrome)", () => {
  let chrome: Chrome;
  let page: Page;
  const log = fakeLogger();
  const evaluate = async (expression: string): Promise<unknown> => {
    const r = await chrome.client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, page.sessionId);
    return (r["result"] as { value?: unknown } | undefined)?.value;
  };
  const open = async (url: string): Promise<Observation> => { await page.navigate(url, NAV_MS); return page.observe(); };
  const inferred = (obs: Observation): Action[] => obs.actions.filter((a) => a.inferred === true);
  const labels = (obs: Observation): string[] => inferred(obs).map((a) => a.label);
  const row = (obs: Observation, label: string): Action => {
    const a = inferred(obs).find((x) => x.label === label);
    if (!a) throw new Error(`no row "${label}" among: ${labels(obs).join(", ")}`);
    return a;
  };
  /** Observe until the page text holds `text`: a click settles, but the next frame can still paint. */
  const textAfter = async (text: string): Promise<string> => {
    let obs = await page.observe();
    for (let i = 0; i < 25 && !obs.text.includes(text); i++) { await new Promise((r) => setTimeout(r, 20)); obs = await page.observe(); }
    return obs.text;
  };

  beforeAll(async () => {
    // The geolocation override is on for the whole file: it changes nothing else on these pages.
    chrome = await launchChrome({ headed: false, env: process.env, log, geolocation: GEO });
    page = await openPage(chrome, { settleTimeoutMs: NAV_MS, log });
  }, 30_000);

  afterAll(async () => {
    await page?.close().catch(() => undefined);
    await chrome?.close().catch(() => undefined);
    if (chrome?.pid && processAlive(chrome.pid)) process.kill(chrome.pid, "SIGKILL");
  });

  it("a React-props row and an onclick row each give one click action with role button, their text as the label, and inferred", async () => {
    const obs = await open(rowsUrl);
    for (const label of ["Koramangala 1st Block", "Koramangala Police Station"]) {
      const found = obs.actions.filter((a) => a.label === label);
      expect(found, label).toHaveLength(1);
      expect(found[0]).toMatchObject({ kind: "click", role: "button", label, value: "", inferred: true, multiline: false, form: null });
      expect(found[0]?.node).toEqual(expect.any(Number));
      // The guard of the node works as for any control.
      expect(obs.guards[String(found[0]?.node)]).toBeTruthy();
    }
    // Rule B adds rows only after the controls; the ids stay e1..eN in that order.
    const first = obs.actions.findIndex((a) => a.inferred === true);
    expect(obs.actions.slice(first).filter((a) => a.kind !== "scroll" && a.kind !== "wait").every((a) => a.inferred === true)).toBe(true);
    // The flag never reaches Jev.
    const step = buildStep({ task: "pick Koramangala 1st Block", goal: "act", obs, history: [], spans: [], keys: [], bannedActionIds: new Set(), doneBanned: false });
    const request = JSON.stringify({ state: step.state, questions: step.questions });
    expect(request).toContain("Koramangala 1st Block");
    expect(request).not.toContain("inferred");
  });

  it("an onclick attribute makes a row; a bad one fires no page error during the snapshot", async () => {
    const obs = await open(rowsUrl);
    expect(row(obs, "Attribute row")).toMatchObject({ kind: "click", role: "button", inferred: true });
    expect(await evaluate("window.__errors")).toEqual([]);
    // Why the snapshot reads the attribute first: a read of the property compiles it, and the page sees the error.
    await evaluate("void document.getElementById('attr').onclick");
    expect(await evaluate("window.__errors.length")).toBe(1);
  });

  it("a nested pointer child with its own handler gives no action: only the root row does", async () => {
    const obs = await open(rowsUrl);
    expect(obs.actions.filter((a) => a.label.includes("Indiranagar"))).toEqual([expect.objectContaining({ label: "Indiranagar (Bengaluru)", inferred: true })]);
    expect(obs.actions.some((a) => a.label === "(Bengaluru)")).toBe(false);
  });

  it("no row for a pointer div without a handler, one that holds a button, one inside a link, a 201-char text, a hidden row, or a disabled row", async () => {
    const obs = await open(rowsUrl);
    for (const text of ["No handler here", "Holds a control", "Inside a link", "Long a a", "Hidden row", "Disabled row"]) {
      expect(labels(obs).some((l) => l.includes(text)), text).toBe(false);
    }
    // The controls themselves stay actions: the button in the row and the link around the other row.
    expect(obs.actions.some((a) => a.role === "button" && a.label === "Inner button" && a.inferred === undefined)).toBe(true);
    expect(obs.actions.some((a) => a.role === "link" && a.label === "Inside a link")).toBe(true);
    // The 200-char limit: the row text is 201 characters.
    expect(await evaluate("document.getElementById('long').innerText.length")).toBe(201);
    // A role=option element is a control of the selector, never a rule-B row.
    expect(obs.actions.filter((a) => a.label === "Plain option").map((a) => a.role)).toEqual(["option"]);
  });

  it("the rows of an open dialog come first, then the other rows in document order", async () => {
    const obs = await open(rowsUrl);
    expect(labels(obs)).toEqual(["Dialog row one", "Dialog row two", "Koramangala 1st Block", "Koramangala Police Station",
      "Indiranagar (Bengaluru)", "Attribute row", "Koramangala Suggestion A", "Koramangala Suggestion B"]);
    // Each dialog row has the dialog as its form and its popup.
    const d1 = row(obs, "Dialog row one");
    expect(d1.form).toEqual(expect.any(Number));
    expect(d1.popup).toEqual([d1.form]);
  });

  it("70 rows give exactly 60 rule-B actions: the first 60 in document order", async () => {
    const obs = await open(`${rowsUrl}?many`);
    expect(labels(obs)).toEqual(Array.from({ length: 60 }, (_, i) => `Row ${i + 1}`));
    expect(obs.text).toContain("Row 70");
  });

  it("the rows of an open dialog stay inside the cap of 60: they come first, then the first 58 other rows", async () => {
    const obs = await open(`${rowsUrl}?many&dialog`);
    expect(labels(obs)).toEqual(["Dialog A", "Dialog B", ...Array.from({ length: 58 }, (_, i) => `Row ${i + 1}`)]);
  });

  it("a row below the fold is no action until a scroll brings it in view; a row above the view is none either", async () => {
    let obs = await open(`${rowsUrl}?far`);
    expect(labels(obs)).toEqual(["Near row"]);
    expect(obs.text).not.toContain("Far row");
    for (let i = 0; i < 8 && !labels(obs).includes("Far row"); i++) {
      const down = obs.actions.find((a) => a.id === "scroll_down");
      if (!down) break;
      await page.act(down, obs);
      obs = await page.observe();
    }
    expect(labels(obs)).toEqual(["Far row"]);
  });

  it("a click on a row runs its handler: the page text changes", async () => {
    let obs = await open(rowsUrl);
    expect(obs.text).toContain("Nothing picked");
    await page.act(row(obs, "Koramangala 1st Block"), obs);
    expect(await textAfter("Picked Koramangala 1st Block")).toContain("Picked Koramangala 1st Block");
    obs = await page.observe();
    await page.act(row(obs, "Koramangala Police Station"), obs);
    expect(await textAfter("Picked Koramangala Police Station")).toContain("Picked Koramangala Police Station");
    // The click goes to the centre of the root row, right of its text: the handler of the root runs, not the child's.
    obs = await page.observe();
    await page.act(row(obs, "Indiranagar (Bengaluru)"), obs);
    expect(await textAfter("Picked Indiranagar")).toContain("Picked Indiranagar");
    // A React onMouseDown row in the dialog.
    obs = await page.observe();
    await page.act(row(obs, "Dialog row one"), obs);
    expect(await textAfter("Picked Dialog row one")).toContain("Picked Dialog row one");
  });

  it("a row whose text changed after the observation is stale: the guard and fresh work on rows", async () => {
    const obs = await open(rowsUrl);
    const target = row(obs, "Koramangala Police Station");
    expect(await page.fresh(obs, target)).toBe(true);
    await evaluate("document.getElementById('prop').textContent = 'Koramangala Police Station (moved)'");
    expect(await page.fresh(obs, target)).toBe(false);
    await expect(page.act(target, obs)).rejects.toBeInstanceOf(StalePage);
    expect(await evaluate("document.getElementById('out').textContent")).toBe("Nothing picked");
  });

  it("the popup of a chip field lists its rule-B rows with its options, in document order", async () => {
    const obs = await open(rowsUrl);
    const field = obs.actions.find((a) => a.kind === "fill" && a.label === "Area");
    expect(field).toBeDefined();
    const popup = await page.popup(field as Action);
    expect(popup).toMatchObject({ open: true, busy: false, picks: ["Koramangala Suggestion A", "Koramangala Suggestion B", "Plain option"] });
  });

  it("a quirks-mode page (no DOCTYPE) taller than the viewport has its height and a scroll_down at the top; the scroll moves", async () => {
    const obs = await open(quirksUrl);
    expect(await evaluate("document.compatMode")).toBe("BackCompat");
    // Why the snapshot reads the scrolling element: documentElement has the viewport height in quirks mode.
    expect(await evaluate("document.documentElement.scrollHeight")).toBeLessThanOrEqual(obs.h);
    expect(obs.scroll.y).toBe(0);
    expect(obs.scroll.height).toBeGreaterThan(obs.h);
    const down = obs.actions.find((a) => a.id === "scroll_down");
    expect(down).toMatchObject({ kind: "scroll", node: null, delta: 560 });
    expect(obs.actions.some((a) => a.id === "scroll_up")).toBe(false);
    await page.act(down as Action, obs);
    const after = await page.observe();
    expect(after.scroll.y).toBeGreaterThan(0);
    expect(await evaluate("scrollY")).toBeGreaterThan(0);
    expect(after.actions.some((a) => a.id === "scroll_up")).toBe(true);
  });

  it("the geolocation override: the page gets the launch point with no prompt", async () => {
    await open(rowsUrl);
    const pos = await evaluate(`new Promise((resolve) => navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => resolve({ error: e.code }), { timeout: 3000 }))`);
    expect(pos).toEqual({ latitude: GEO.latitude, longitude: GEO.longitude, accuracy: GEO.accuracy });
  });
});
