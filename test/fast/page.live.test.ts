// Live test: one headless Chrome on a temporary profile, file:// fixtures, no network.
// Run with `npm run test:live` (JEV_LIVE=1).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findChrome, launchChrome } from "../../src/fast/chrome.js";
import type { Action, Chrome, Observation, Page, Popup } from "../../src/fast/model.js";
import { EditRefused, StalePage } from "../../src/fast/model.js";
import { openPage } from "../../src/fast/page.js";
import { canPressEnter, canWriteInto } from "../../src/fast/policy.js";
import { FastRunner } from "../../src/fast/loop.js";
import { calendarDay, datePlan, hasDateWidget, shownOf } from "../../src/fast/dates.js";
import type { RunConfig } from "../../src/types.js";
import { LIMITS } from "../../src/types.js";
import type { ChoiceQuestion, Questions } from "@typesafe-ai/sdk";
import { fakeHuman, fakeLogger, fakeOracle, type PartialAnswers } from "../fakes.js";

const FIXTURES = path.resolve(__dirname, "../fixtures/live");
const formUrl = pathToFileURL(path.join(FIXTURES, "form.html")).href;
const liveUrl = pathToFileURL(path.join(FIXTURES, "live.html")).href;
const replyUrl = pathToFileURL(path.join(FIXTURES, "reply.html")).href;
const chipsUrl = pathToFileURL(path.join(FIXTURES, "chips.html")).href;
const segmentsUrl = pathToFileURL(path.join(FIXTURES, "dates-segments.html")).href;
const nativeUrl = pathToFileURL(path.join(FIXTURES, "dates-native.html")).href;
const NAV_MS = 5000;

function find(obs: Observation, kind: Action["kind"], label: string): Action {
  const a = obs.actions.find((x) => x.kind === kind && x.label === label);
  if (!a) throw new Error(`no ${kind} action "${label}" among: ${obs.actions.map((x) => `${x.kind}:${x.label}`).join(", ")}`);
  return a;
}

/** Observe until `ok` holds, so a navigation that is still in flight does not fail the test. */
async function observeUntil(page: Page, ok: (obs: Observation) => boolean, tries = 25): Promise<Observation> {
  let obs = await page.observe();
  for (let i = 0; i < tries && !ok(obs); i++) {
    await new Promise((r) => setTimeout(r, 20));
    obs = await page.observe();
  }
  return obs;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.env["JEV_LIVE"] !== "1")("fast page (live Chrome)", () => {
  let chrome: Chrome;
  let page: Page;
  let udd: string;
  const log = fakeLogger();

  beforeAll(async () => {
    chrome = await launchChrome({ headed: false, env: process.env, log });
    udd = chrome.userDataDir ?? "";
    page = await openPage(chrome, { settleTimeoutMs: NAV_MS, log });
    await page.navigate(formUrl, NAV_MS);
  }, 30_000);

  afterAll(async () => {
    await page?.close().catch(() => undefined);
    await chrome?.close().catch(() => undefined);
    if (chrome?.pid && processAlive(chrome.pid)) process.kill(chrome.pid, "SIGKILL");
  });

  it("observes roles, labels, and scroll_down", async () => {
    const obs = await page.observe();
    expect(obs.url).toBe(formUrl);
    expect(obs.title).toBe("Form fixture");
    expect(obs.text).toContain("Form fixture");
    expect(obs.w).toBe(1280);
    expect(obs.h).toBe(860);
    const pairs = obs.actions.map((a) => `${a.role ?? a.kind}:${a.label}`);
    expect(pairs).toContain("textbox:Name");
    expect(pairs).toContain("searchbox:Search site");
    expect(pairs).toContain("combobox:Colour → green");
    expect(pairs).toContain("combobox:Colour → blue");
    expect(pairs).not.toContain("combobox:Colour → red");
    expect(pairs).toContain("checkbox:Subscribe");
    expect(pairs).toContain("button:Greet");
    expect(pairs).toContain("button:Covered");
    expect(pairs).toContain("link:Next");
    expect(pairs).toContain("button:Rename me");
    expect(find(obs, "click", "Subscribe").checked).toBe("false");
    expect(obs.actions.some((a) => a.id === "scroll_down" && a.kind === "scroll" && a.delta === 560)).toBe(true);
    expect(obs.actions.some((a) => a.id === "wait")).toBe(true);
    expect(obs.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(obs.omitted_actions).toBe(0);
    for (const a of obs.actions) {
      if (a.kind === "scroll" || a.kind === "wait") expect(a.node).toBeNull();
      else expect(obs.guards[String(a.node)]).toBeTruthy();
    }
  });

  it("fills Name and observes the value", async () => {
    const obs = await page.observe();
    await page.act(find(obs, "fill", "Name"), obs, "Ada");
    const after = await page.observe();
    expect(find(after, "fill", "Name").value).toBe("Ada");
  });

  it("clicks Greet and sees the text change and a new fingerprint", async () => {
    const obs = await page.observe();
    await page.act(find(obs, "click", "Greet"), obs);
    const after = await page.observe();
    expect(after.text).toContain("Hello Ada");
    expect(after.fingerprint).not.toBe(obs.fingerprint);
  });

  it("selects Colour -> green", async () => {
    const obs = await page.observe();
    const action = find(obs, "select", "Colour → green");
    expect(action.value).toBe("green");
    expect(action.current_value).toBe("red");
    await page.act(action, obs);
    const after = await page.observe();
    expect(find(after, "select", "Colour → red").current_value).toBe("green");
    expect(after.actions.some((a) => a.kind === "select" && a.label === "Colour → green")).toBe(false);
  });

  it("throws StalePage for a covered button", async () => {
    const obs = await page.observe();
    await expect(page.act(find(obs, "click", "Covered"), obs)).rejects.toBeInstanceOf(StalePage);
  });

  it("clicks a card whose centre is covered by a sibling: the act script finds a free point", async () => {
    const obs = await page.observe();
    await page.act(find(obs, "click", "Card row"), obs);
    const after = await page.observe();
    expect(after.text).toContain("Card clicked");
  });

  it("detects a renamed target as stale", async () => {
    const obs = await page.observe();
    const rename = find(obs, "click", "Rename me");
    expect(await page.fresh(obs, rename)).toBe(true);
    expect(await page.fresh(obs)).toBe(true);
    await chrome.client.send("Runtime.evaluate", { expression: "document.getElementById('rename').textContent = 'Renamed'" }, page.sessionId);
    expect(await page.fresh(obs, rename)).toBe(false);
    expect(await page.fresh(obs)).toBe(false);
    await expect(page.act(rename, obs)).rejects.toBeInstanceOf(StalePage);
    // Greet shares the form with the renamed button, so its scoped guard changed too. Next is outside the form.
    expect(await page.fresh(obs, find(obs, "click", "Greet"))).toBe(false);
    expect(await page.fresh(obs, find(obs, "click", "Next"))).toBe(true);
  });

  it("scrolls down and up", async () => {
    const obs = await page.observe();
    expect(obs.scroll.y).toBe(0);
    await page.act(find(obs, "scroll", "Scroll down"), obs);
    const down = await observeUntil(page, (o) => o.scroll.y > 0);
    expect(down.scroll.y).toBeGreaterThan(0);
    expect(down.actions.some((a) => a.id === "scroll_up")).toBe(true);
    await page.act(find(down, "scroll", "Scroll up"), down);
    const up = await observeUntil(page, (o) => o.scroll.y === 0);
    expect(up.scroll.y).toBe(0);
  });

  it("clicks Next and lands on page two", async () => {
    const obs = await page.observe();
    await page.act(find(obs, "click", "Next"), obs);
    const after = await observeUntil(page, (o) => o.url.endsWith("page2.html"));
    expect(after.url.endsWith("page2.html")).toBe(true);
    expect(after.title).toBe("Page two");
    expect(after.text).toContain("Page two");
    expect(await page.url()).toBe(after.url);
  });

  it("goes back to the form", async () => {
    await page.back(NAV_MS);
    const obs = await observeUntil(page, (o) => o.url.endsWith("form.html"));
    expect(obs.url.endsWith("form.html")).toBe(true);
    expect(obs.title).toBe("Form fixture");
  });

  it("fills Search and presses Enter to submit", async () => {
    const obs = await page.observe();
    await page.act(find(obs, "fill", "Search site"), obs, "cats");
    await page.press("Enter");
    const after = await observeUntil(page, (o) => o.url.includes("page2.html?"));
    expect(after.url).toContain("page2.html?");
    expect(after.url).toContain("s=cats");
    expect(after.text).toContain("Page two");
  });

  it("writes a screenshot and counts browser time", async () => {
    const file = path.join(udd, "shot.jpg");
    await page.screenshot(file);
    expect(fs.statSync(file).size).toBeGreaterThan(100);
    expect(page.stats.calls).toBeGreaterThan(0);
    expect(page.stats.browserMs).toBeGreaterThan(0);
    expect(chrome.launchMs).toBeGreaterThan(0);
    expect(chrome.profile.directory).toBeNull();
    expect(udd).toContain("jev-chrome-");
  });

  it("close exits Chrome and removes the temp profile", async () => {
    const pid = chrome.pid;
    expect(pid).toBeTypeOf("number");
    await page.close();
    await page.close();
    await chrome.close();
    await chrome.close();
    expect(chrome.client.closed).toBe(true);
    expect(fs.existsSync(udd)).toBe(false);
    expect(processAlive(pid as number)).toBe(false);
    const left = execFileSync("sh", ["-c", `pgrep -f "${udd}" || true`], { encoding: "utf8" }).trim();
    expect(left).toBe("");
  });
});

describe.skipIf(process.env["JEV_LIVE"] !== "1")("fast page (live Chrome): dialogs and live text", () => {
  let chrome: Chrome;
  let page: Page;
  const log = fakeLogger();

  beforeAll(async () => {
    chrome = await launchChrome({ headed: false, env: process.env, log });
    page = await openPage(chrome, { settleTimeoutMs: NAV_MS, log });
    await page.navigate(liveUrl, NAV_MS);
  }, 30_000);

  afterAll(async () => {
    await page?.close().catch(() => undefined);
    await chrome?.close().catch(() => undefined);
    if (chrome?.pid && processAlive(chrome.pid)) process.kill(chrome.pid, "SIGKILL");
  });

  it("fills a field although visible text elsewhere changes every 30 ms", async () => {
    const obs = await page.observe();
    await new Promise((r) => setTimeout(r, 200));
    expect(await page.fresh(obs)).toBe(false);
    const fill = find(obs, "fill", "Name");
    expect(await page.fresh(obs, fill)).toBe(true);
    await page.act(fill, obs, "Ada");
    const after = await page.observe();
    expect(find(after, "fill", "Name").value).toBe("Ada");
  });

  it("a click that opens alert() returns; the dialog is accepted and logged", async () => {
    const obs = await page.observe();
    const t0 = Date.now();
    await page.act(find(obs, "click", "Alert"), obs);
    expect(Date.now() - t0).toBeLessThan(3000);
    const after = await page.observe();
    expect(after.text).toContain("Live page");
    expect(log.lines.some((l) => /dialog alert accepted: hi/.test(l))).toBe(true);
  });

  it("a click that opens confirm() is dismissed: the page sees 'no'", async () => {
    const obs = await page.observe();
    await page.act(find(obs, "click", "Ask"), obs);
    const after = await observeUntil(page, (o) => /\bno\b/.test(o.text));
    expect(after.text).toMatch(/\bno\b/);
    expect(log.lines.some((l) => /dialog confirm dismissed: Are you sure\?/.test(l))).toBe(true);
  });

  it("press with an observation from another document throws StalePage", async () => {
    const obs = await page.observe();
    await page.navigate(formUrl, NAV_MS);
    await expect(page.press("Enter", obs)).rejects.toBeInstanceOf(StalePage);
    const fresh = await page.observe();
    await page.press("Enter", fresh);
  });
});

describe.skipIf(process.env["JEV_LIVE"] !== "1")("fast page (live Chrome): field facts for assistant-written text", () => {
  let chrome: Chrome;
  let page: Page;
  const log = fakeLogger();

  beforeAll(async () => {
    chrome = await launchChrome({ headed: false, env: process.env, log });
    page = await openPage(chrome, { settleTimeoutMs: NAV_MS, log });
    await page.navigate(replyUrl, NAV_MS);
  }, 30_000);

  afterAll(async () => {
    await page?.close().catch(() => undefined);
    await chrome?.close().catch(() => undefined);
    if (chrome?.pid && processAlive(chrome.pid)) process.kill(chrome.pid, "SIGKILL");
  });

  it("Subject, Reply, and Send share a form; the search box has form null", async () => {
    const obs = await page.observe();
    const subject = find(obs, "fill", "Subject");
    const reply = find(obs, "fill", "Reply");
    const send = find(obs, "click", "Send");
    const search = find(obs, "fill", "Search mail");
    expect(subject.form).toBeTypeOf("number");
    expect(reply.form).toBe(subject.form);
    expect(send.form).toBe(subject.form);
    expect(find(obs, "fill", "Cc").form).toBe(subject.form);
    expect(search.form).toBeNull();
    expect(search.role).toBe("searchbox");
    expect(obs.text).toContain("Can we meet on Tuesday at 10:00?");
  });

  it("Reply is multiline, Subject has maxLength 120 and inputType text, Cc has inputType email", async () => {
    const obs = await page.observe();
    const subject = find(obs, "fill", "Subject");
    const reply = find(obs, "fill", "Reply");
    expect(reply.multiline).toBe(true);
    expect(reply.inputType).toBeUndefined();
    expect(reply.maxLength).toBeUndefined();
    expect(subject).toMatchObject({ multiline: false, maxLength: 120, inputType: "text" });
    expect(find(obs, "fill", "Cc")).toMatchObject({ inputType: "email", role: "textbox" });
    expect(find(obs, "fill", "Search mail").inputType).toBe("search");
    expect(find(obs, "click", "Send").inputType).toBeUndefined();
  });

  it("obs.doc is a number that stays the same across observations and changes with a new document", async () => {
    const a = await page.observe();
    const b = await page.observe();
    expect(a.doc).toBeTypeOf("number");
    expect(b.doc).toBe(a.doc);
    expect(b.fingerprint).toBe(a.fingerprint);
    await page.navigate(replyUrl, NAV_MS);
    const c = await page.observe();
    expect(c.doc).toBeTypeOf("number");
    expect(c.doc).not.toBe(a.doc);
  });

  it("obs.filled lists a filled field that is out of view, and drops it when the field is empty or gone", async () => {
    const evaluate = (expression: string) => chrome.client.send("Runtime.evaluate", { expression, returnByValue: true }, page.sessionId);
    await page.navigate(replyUrl, NAV_MS);
    const before = await page.observe();
    const reply = find(before, "fill", "Reply");
    expect(before.filled).toEqual([]);
    await page.act(reply, before, "Tuesday works.");
    const typed = await page.observe();
    expect(typed.filled).toEqual([reply.node]);
    // Move the form below the viewport. Reply is then not an action, but it still holds the text.
    await evaluate("document.body.insertAdjacentHTML('afterbegin', '<div style=\"height:3000px\"></div>'); scrollTo(0, 0)");
    const away = await page.observe();
    expect(away.actions.some((a) => a.node === reply.node)).toBe(false);
    expect(away.filled).toEqual([reply.node]);
    await evaluate("document.querySelector('textarea').value = '   '");
    expect((await page.observe()).filled).toEqual([]);
    await evaluate("document.querySelector('textarea').value = 'x'");
    expect((await page.observe()).filled).toEqual([reply.node]);
    await evaluate("document.getElementById('reply-form').remove()");
    expect((await page.observe()).filled).toEqual([]);
    await page.navigate(replyUrl, NAV_MS);
  });

  it("element node ids stay as in the reference snapshot: forms have their own id counter", async () => {
    await page.navigate(replyUrl, NAV_MS);
    const evaluate = (expression: string) => chrome.client.send("Runtime.evaluate", { expression, returnByValue: true }, page.sessionId);
    await evaluate("document.querySelector('textarea').focus()");
    const obs = await page.observe();
    const nodes = Object.fromEntries(["Search mail", "Cc", "Subject", "Reply"].map((l) => [l, find(obs, "fill", l).node]));
    expect({ ...nodes, Send: find(obs, "click", "Send").node, focus: obs.focus?.node }).toEqual({ "Search mail": 1, Cc: 2, Subject: 3, Reply: 4, Send: 5, focus: 4 });
    expect(find(obs, "fill", "Reply").form).toBeTypeOf("number");
    await page.navigate(replyUrl, NAV_MS);
  });

  it("obs.texts lists the value of each rendered control, in view or not, and leaves out hidden controls", async () => {
    const evaluate = (expression: string) => chrome.client.send("Runtime.evaluate", { expression, returnByValue: true }, page.sessionId);
    await page.navigate(replyUrl, NAV_MS);
    const before = await page.observe();
    const reply = find(before, "fill", "Reply");
    expect(before.texts).toEqual([]);
    await page.act(reply, before, "Tuesday works.");
    expect((await page.observe()).texts).toEqual([[reply.node, "Tuesday works."]]);
    await evaluate("document.body.insertAdjacentHTML('afterbegin', '<div style=\"height:3000px\"></div>'); scrollTo(0, 0)");
    expect((await page.observe()).texts).toEqual([[reply.node, "Tuesday works."]]);
    // A hidden control still holds its value, so `filled` lists it. It is not rendered, so `texts` does not.
    await evaluate("document.getElementById('reply-form').style.display = 'none'");
    const hidden = await page.observe();
    expect(hidden.filled).toEqual([reply.node]);
    expect(hidden.texts).toEqual([]);
    await page.navigate(replyUrl, NAV_MS);
  });

  it("the field facts never reach the Jev request", async () => {
    const { buildStep } = await import("../../src/fast/policy.js");
    const obs = await page.observe();
    const request = JSON.stringify(buildStep({ task: "reply to Ann", goal: "act", obs, history: [], spans: [], keys: [], bannedActionIds: new Set(), doneBanned: false, canGenerate: true }));
    for (const key of ["maxLength", "inputType", "multiline", "autocomplete", "form", "doc", "filled", "texts", "busy", "enterOption", "token"]) expect(request).not.toContain(`"${key}":`);
    expect(request).toContain("\"generate\"");
  });
});

describe.skipIf(process.env["JEV_LIVE"] !== "1")("fast page (live Chrome): the settle after input and the option that Enter picks", () => {
  let chrome: Chrome;
  let page: Page;
  let web: http.Server;
  let base = "";
  const log = fakeLogger();
  const evaluate = async (expression: string) => {
    const result = await chrome.client.send("Runtime.evaluate", { expression, returnByValue: true }, page.sessionId);
    return (result["result"] as { value?: unknown })?.value;
  };
  /** Open a fixture, fill one field, and observe: the observation after the settle and the settle time. */
  const fillAndObserve = async (file: string, label: string, text: string): Promise<{ before: Observation; after: Observation; ms: number }> => {
    await page.navigate(`${base}/${file}`, NAV_MS);
    const before = await page.observe();
    const t0 = Date.now();
    await page.act(find(before, "fill", label), before, text);
    const after = await page.observe();
    return { before, after, ms: Date.now() - t0 };
  };

  beforeAll(async () => {
    // The fixtures over HTTP, so that the page can send real requests. /api/wait answers after `ms`; /landed.html
    // answers after 300 ms.
    web = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://fixture");
      if (u.pathname === "/api/wait") { setTimeout(() => res.end("ok"), Number(u.searchParams.get("ms") ?? 0)); return; }
      if (u.pathname === "/landed.html") { setTimeout(() => { res.setHeader("content-type", "text/html"); res.end("<title>Landed</title><p>Landed</p>"); }, 300); return; }
      const file = path.join(FIXTURES, path.basename(u.pathname));
      if (!fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
      res.setHeader("content-type", "text/html");
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
    chrome = await launchChrome({ headed: false, env: process.env, log });
    page = await openPage(chrome, { settleTimeoutMs: NAV_MS, log });
  }, 30_000);

  afterAll(async () => {
    await page?.close().catch(() => undefined);
    await chrome?.close().catch(() => undefined);
    if (chrome?.pid && processAlive(chrome.pid)) process.kill(chrome.pid, "SIGKILL");
    web?.closeAllConnections();
    await new Promise<void>((r) => (web ? web.close(() => r()) : r()));
  });

  it("the observation after a debounced search fill shows the new rows: debounce 300 ms, request 250 ms, old rows kept, no marker", async () => {
    const { after, ms } = await fillAndObserve("search-debounce.html", "Search workflows", "roadmap");
    expect(after.text).toContain("Open Q3 roadmap review");
    expect(after.text).not.toContain("Open Weekly metrics digest");
    expect(after.ms).toBeGreaterThanOrEqual(500);
    expect(ms).toBeLessThan(LIMITS.causalCapMs);
  });

  it("a slow search (debounce 500 ms, request 800 ms) shows its rows before the cap", async () => {
    const { after, ms } = await fillAndObserve("search-debounce.html?deb=500&lat=800", "Search workflows", "roadmap");
    expect(after.text).toContain("Open Q3 roadmap review");
    expect(after.text).not.toContain("Open Sales call notes");
    expect(ms).toBeLessThan(LIMITS.causalCapMs);
  });

  it.each([
    ["lodash", "a debounce that waits again for its rest", 650],
    ["interval", "an RxJS-like interval debounce", 550],
    ["direct", "a request that starts in the input event (counted over CDP only)", 600],
  ])("mode %s (%s) shows the new rows", async (mode, _what, min) => {
    const { after } = await fillAndObserve(`search-debounce.html?mode=${mode}&lat=${mode === "direct" ? 600 : 250}`, "Search workflows", "notes");
    expect(after.text).toContain("Open Release notes writer");
    expect(after.text).not.toContain("Open Q3 roadmap review");
    expect(after.ms).toBeGreaterThanOrEqual(min);
  });

  it("a fill that starts no work ends within a few frames, also next to a poll that runs from load", async () => {
    for (const file of ["search-debounce.html", "search-debounce.html?poll=1"]) {
      const { after, ms } = await fillAndObserve(file, "Note", "hello");
      expect(find(after, "fill", "Note").value).toBe("hello");
      expect(ms).toBeLessThan(file.includes("poll") ? 400 : 250);
    }
  });

  it("the waits between the steps of a fill are not work of the input: right after the fill, the armed tracker holds no timer", async () => {
    await page.navigate(`${base}/search-debounce.html`, NAV_MS);
    const before = await page.observe();
    await page.act(find(before, "fill", "Note"), before, "hello");
    expect(await evaluate("window.__jevCausal.armed && window.__jevCausal.timers.size")).toBe(0);
    await page.observe();
  });

  it("a new aria-busy marker holds the settle until it goes", async () => {
    const { after, ms } = await fillAndObserve("search-debounce.html?busy=1", "Note", "hello");
    expect(after.text).toContain("saved");
    expect(ms).toBeGreaterThanOrEqual(400);
    expect(after.busy).toBe(false);
  });

  it.each(["named", "arrow"])("a %s poll chain that the input starts stops long before the cap", async (chain) => {
    // named: a callback that schedules itself again every 800 ms stops at its second timer. arrow: a new function each
    // 300 ms stops at the generation limit.
    const { after, ms } = await fillAndObserve(`search-debounce.html?chain=${chain}`, "Note", "hello");
    expect(after.text).toMatch(/tick \d/);
    expect(ms).toBeLessThan(2000);
  });

  it("an Enter that navigates does not hang, and the observation shows the new page", async () => {
    await page.navigate(`${base}/search-debounce.html`, NAV_MS);
    const obs = await page.observe();
    await page.act(find(obs, "fill", "Go to"), obs, "home");
    const filled = await page.observe();
    const t0 = Date.now();
    await page.press("Enter", filled);
    const after = await page.observe();
    expect(Date.now() - t0).toBeLessThan(LIMITS.causalCapMs);
    expect(after.url).toContain("/landed.html?to=home");
    expect(after.text).toContain("Landed");
  });

  it("the composer of a detached cmdk list gives the option that Enter picks; Enter picks it", async () => {
    const { after } = await fillAndObserve("command-menu.html", "Ask anything", "Q3 Roadmap");
    expect(after.text).toContain("Q3 Roadmap");
    expect(after.focus?.enterOption?.label).toBe("Ask AI: Q3 Roadmap");
    expect(after.actions.find((a) => a.label === "Ask AI: Q3 Roadmap")?.node).toBe(after.focus?.enterOption?.node);
    await page.press("Enter", after);
    expect(await evaluate("window.picked")).toBe("ask");
  });

  it("an Enter decided before the popup changed is stale: the key guard holds the popup text", async () => {
    const { after } = await fillAndObserve("command-menu.html", "Ask anything", "Q3 Roadmap");
    expect(after.focus?.enterOption).toBeTruthy();
    // Another item of the list changes. Focus, the field value, and the highlighted item stay the same.
    await evaluate(`document.querySelectorAll('[cmdk-item]')[1].textContent='Q3 Roadmap Review Notes'`);
    await expect(page.press("Enter", after)).rejects.toBeInstanceOf(StalePage);
    expect(await evaluate("window.picked ?? null")).toBeNull();
    const fresh = await page.observe();
    expect(fresh.focus?.enterOption).toEqual(after.focus?.enterOption);
    await page.press("Enter", fresh);
    expect(await evaluate("window.picked")).toBe("ask");
  });

  it("a mention popup that the page portals to the body gives its highlighted option", async () => {
    const { after } = await fillAndObserve("command-menu.html", "Comment", "Thanks @an");
    expect(after.focus?.label).toBeTruthy();
    expect(after.focus?.enterOption?.label).toBe("Ann Lee");
  });

  it("an ARIA combobox gives its active descendant; a filter box above an unrelated listbox gives no option", async () => {
    const combo = await fillAndObserve("combobox.html", "City", "Be");
    expect(combo.after.focus?.enterOption?.label).toBe("Berlin");
    const filter = await fillAndObserve("combobox.html", "Filter folders", "dr");
    expect(filter.after.text).toContain("Drafts");
    expect(filter.after.focus?.enterOption).toBeUndefined();
  });
});

describe.skipIf(process.env["JEV_LIVE"] !== "1")("fast page (live Chrome): chip fields", () => {
  let chrome: Chrome;
  let page: Page;
  const log = fakeLogger();
  const events = async (): Promise<string[]> => {
    const r = await chrome.client.send("Runtime.evaluate", { expression: "window.__ev", returnByValue: true }, page.sessionId);
    return ((r["result"] as { value?: string[] })?.value) ?? [];
  };
  const byNode = (obs: Observation, node: number | null): Action | undefined => obs.actions.find((a) => a.kind === "fill" && a.node === node);
  const texts = (a: Action | undefined): string[] => (a?.token?.items ?? []).map(([, t]) => t);
  const fresh = async (): Promise<Observation> => { await page.navigate(chipsUrl, NAV_MS); return page.observe(); };
  /** Fill a field, then read the popup until `ok` holds. */
  async function fillAndRead(label: string, text: string, ok: (p: Popup | null) => boolean = () => true): Promise<{ field: Action; popup: Popup | null }> {
    const before = await page.observe();
    const field = find(before, "fill", label);
    await page.act(field, before, text);
    let popup = await page.popup(field);
    for (let i = 0; i < 20 && !ok(popup); i++) { await new Promise((r) => setTimeout(r, 50)); popup = await page.popup(field); }
    return { field, popup };
  }

  beforeAll(async () => {
    chrome = await launchChrome({ headed: false, env: process.env, log });
    page = await openPage(chrome, { settleTimeoutMs: NAV_MS, log });
  }, 30_000);

  afterAll(async () => {
    await page?.close().catch(() => undefined);
    await chrome?.close().catch(() => undefined);
    if (chrome?.pid && processAlive(chrome.pid)) process.kill(chrome.pid, "SIGKILL");
  });

  it("facts: S1 (a label row with a Remove button) and S4 (a table row) get no chips; S3 (a composer) gets no facts; S2, S5, and S6 get the chip shape", async () => {
    const obs = await fresh();
    const s1 = find(obs, "fill", "Default branch");
    expect(s1.token?.chips).toEqual([]);
    expect(s1.token?.items.every(([, , kind]) => kind === 0)).toBe(true);
    expect(find(obs, "fill", "Notes").token).toMatchObject({ items: [[expect.any(Number), "Notes", 0]], chips: [] });
    expect(find(obs, "fill", "Role").token).toEqual({ items: [], chips: [] });
    expect(find(obs, "fill", "Message").token).toBeUndefined();
    expect(find(obs, "fill", "Filter issues").token?.chips).toEqual(["is:open Remove filter is:open"]);
    // S5: the chip text holds the title, so an email address matches a chip that shows a display name.
    expect(find(obs, "fill", "Recipients").token?.chips).toEqual(["Ann Stone ann@example.com Remove"]);
    const s6 = find(obs, "fill", "Labels");
    expect(s6.token?.chips).toEqual(["frontend Remove frontend"]);
    expect(s6.token?.multi).toBeUndefined();
    // P before its first chip: only the label is before the field, and nothing is open.
    const p = find(obs, "fill", "Search org members or type a name...");
    expect(p.token).toEqual({ items: [[expect.any(Number), "Meeting Participants (Optional)", 0]], chips: [] });
    // Weak evidence does not change which fields can take assistant text.
    for (const a of [s1, p, find(obs, "fill", "Filter issues"), find(obs, "fill", "Recipients"), s6]) {
      const { token: _token, ...plain } = a;
      expect(canWriteInto(a)).toBe(canWriteInto(plain));
    }
    expect(canWriteInto(find(obs, "fill", "Filter issues"))).toBe(true);
    // Chip facts are not element node ids: the node ids stay as the other snapshot facts give them.
    expect(obs.actions.filter((a) => a.kind === "fill").map((a) => a.node)).toEqual([...new Set(obs.actions.filter((a) => a.kind === "fill").map((a) => a.node))]);
    expect(await events()).toEqual([]);
  });

  it("P: the popup is busy while the search runs, then lists the members; the fill action shows it open", async () => {
    await fresh();
    const { field, popup } = await fillAndRead("Search org members or type a name...", "Ann");
    expect(popup).toMatchObject({ open: true, busy: true, picks: [] });
    expect(popup?.text).toContain("Searching members...");
    let listed = await page.popup(field);
    for (let i = 0; i < 20 && (listed?.busy ?? true); i++) { await new Promise((r) => setTimeout(r, 50)); listed = await page.popup(field); }
    expect(listed).toMatchObject({ open: true, busy: false, picks: ["Ann Lee ann.lee@parallelloop.ai"] });
    expect(byNode(await page.observe(), field.node)?.token?.popup).toBe(true);
    // A field without a popup reads closed.
    expect(await page.popup(find(await page.observe(), "fill", "Title (Optional)"))).toEqual({ open: false, text: "", picks: [], busy: false });
    // A fill of Title closes the list with an exit animation. The closing list lies next to Title, which has focus now,
    // but it is not a popup of Title.
    const before = await page.observe();
    await page.act(find(before, "fill", "Title (Optional)"), before, "Weekly sync");
    const after = await page.observe();
    expect(await chrome.client.send("Runtime.evaluate", { expression: "[document.getElementById('pop').dataset.state, getComputedStyle(document.getElementById('pop')).display]", returnByValue: true }, page.sessionId))
      .toMatchObject({ result: { value: ["closed", "block"] } });
    expect(after.focus?.label).toBe("Title (Optional)");
    expect(find(after, "fill", "Title (Optional)").token?.popup).toBeUndefined();
  });

  it("P: a popup read with focus settles after that focus; a search that the focus starts is read after it ended", async () => {
    await fresh();
    // As some typeaheads do, P searches again for its draft when it takes focus.
    await chrome.client.send("Runtime.evaluate", { expression: "document.getElementById('p').addEventListener('focus',e=>{ if (e.target.value.trim()) e.target.dispatchEvent(new Event('input')); })" }, page.sessionId);
    const { field } = await fillAndRead("Search org members or type a name...", "Ann", (x) => x?.busy === false);
    const before = await page.observe();
    await page.act(find(before, "fill", "Title (Optional)"), before, "Weekly sync");
    await page.observe();
    // Title has focus, so the list that lies next to P is not P's popup.
    expect(await page.popup(field)).toMatchObject({ open: false, picks: [] });
    // The focus starts the 300 ms search. The read comes after the causal settle of that focus, not on "Searching members...".
    expect(await page.popup(field, true)).toMatchObject({ open: true, busy: false, picks: ["Ann Lee ann.lee@parallelloop.ai"] });
    expect(await events()).toEqual([]);
  });

  it("P: a script Enter adds the chip and never submits the form; the new item has a named remove control; without focus it is skipped", async () => {
    await fresh();
    const { field } = await fillAndRead("Search org members or type a name...", "bob@example.com", (x) => x?.text === "No members found");
    const obs = await page.observe();
    const title = find(obs, "fill", "Title (Optional)");
    expect(await page.commit(title, obs)).toEqual({ skipped: "focus" });
    expect(await page.commit(byNode(obs, field.node)!, obs)).toEqual({ prevented: true });
    const after = await page.observe();
    const p = byNode(after, field.node)!;
    expect(p.label).toBe("textbox");
    expect(p.value).toBe("");
    expect(p.token?.items.at(-1)).toEqual([expect.any(Number), "bob@example.com Remove participant", 2]);
    expect(p.token?.chips).toEqual(["bob@example.com Remove participant"]);
    expect(await events()).toEqual(["P added bob@example.com"]);
    // A script Enter on the empty field does nothing: it has no default action, so the form is not submitted.
    await chrome.client.send("Runtime.evaluate", { expression: "document.getElementById('p').focus()" }, page.sessionId);
    const empty = await page.observe();
    expect(await page.commit(byNode(empty, field.node)!, empty)).toEqual({ prevented: false });
    expect(await events()).toEqual(["P added bob@example.com"]);
    // A stale observation throws before any key goes out.
    await expect(page.commit(byNode(obs, field.node)!, obs)).rejects.toBeInstanceOf(StalePage);
  });

  it("S2: a script Enter does nothing where only the native form reads Enter; the trusted Enter then searches", async () => {
    await fresh();
    await fillAndRead("Filter issues", "login bug");
    const obs = await page.observe();
    const s2 = find(obs, "fill", "Filter issues");
    expect(await page.commit(s2, obs)).toEqual({ prevented: false });
    const after = await page.observe();
    expect(find(after, "fill", "Filter issues").value).toBe("login bug");
    expect(await events()).toEqual([]);
    await page.press("Enter", after);
    expect(await events()).toEqual(["S2 search login bug"]);
  });

  it("S5: the chip that a script Enter adds shows a display name and holds the email address in its title", async () => {
    await fresh();
    await fillAndRead("Recipients", "bob@example.com");
    const obs = await page.observe();
    expect(await page.commit(find(obs, "fill", "Recipients"), obs)).toEqual({ prevented: true });
    const s5 = find(await page.observe(), "fill", "Recipients");
    expect(texts(s5).at(-1)).toBe("Bob Stone bob@example.com Remove");
    expect(s5.value).toBe("");
  });

  it("S6: with the list open, the field shows the multiselect listbox and the popup lists the options that Enter would pick", async () => {
    await fresh();
    const { field, popup } = await fillAndRead("Labels", "bug");
    expect(popup).toMatchObject({ open: true, busy: false, picks: ["debug", "bugfix-later", 'Create "bug"'] });
    const s6 = byNode(await page.observe(), field.node)!;
    expect(s6.token?.multi).toBe(true);
    expect(canWriteInto(s6)).toBe(false);
    expect(await events()).toEqual([]);
  });

  describe("runs of the loop with scripted Jev answers", () => {
    type Decide = (q: Questions) => PartialAnswers;
    /** The target key whose element string carries `label`. */
    const key = (q: Questions, head: string, label: string): string => {
      const c = (q[head] as ChoiceQuestion | undefined)?.criteria ?? {};
      const hit = Object.entries(c).find(([, v]) => String((v as { element?: string }).element ?? "").includes(label));
      if (!hit) throw new Error(`no ${head} option for ${label}`);
      return hit[0];
    };
    // The page has more fields than a step request has value heads: a value request then answers with the same value.
    let value = "";
    const fillIn = (label: string, id: string): Decide => (q) => {
      value = id;
      return { page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: key(q, "type_text_target", label), confidence: 0.8 }, type_text_value: { choice: id, confidence: 0.9 } };
    };
    const clickOn = (label: string): Decide => (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: key(q, "click_target", label), confidence: 0.9 } });
    const enterKey: Decide = () => ({ page_kind: "task_page", operation: { choice: "PRESS_ENTER", confidence: 0.85 } });
    const done: Decide = () => ({ page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } });
    async function run(vars: Record<string, string>, steps: Decide[]) {
      let i = 0;
      const oracle = fakeOracle((name, _state, q) => (name === "step" ? (steps[Math.min(i++, steps.length - 1)] as Decide)(q) : name === "value" ? { type_text_value: { choice: value, confidence: 0.9 } } : {}));
      const cfg: RunConfig = {
        task: "fill the chips fixture", url: chipsUrl, headed: false, maxSteps: 8, stepTimeoutMs: 5000, runTimeoutMs: 60_000, pauseTimeoutMs: 1000, confirm: "auto", dryRun: false,
        session: "jev-live", model: "m", logLevel: "info", logJson: false, keepOpen: true, agentBrowserBin: "ab", vars, profile: "none", goal: "act", engine: "cdp", refreshProfile: false,
      };
      const runLog = fakeLogger();
      const runner = new FastRunner({ cfg, profiles: [], chrome: async () => chrome, page, openPage: async () => page, oracle, human: fakeHuman({ interactive: false }), log: runLog });
      return { result: await runner.run(), log: runLog };
    }

    it("P: Jev's first Enter teaches the field; before Title, a script Enter adds the second value; the form is not sent", async () => {
      const { result, log: runLog } = await run({ a: "ann@example.com", b: "bob@example.com", title: "Weekly sync" },
        [fillIn("Search org members or type a name...", "v_a"), enterKey, fillIn("textbox", "v_b"), fillIn("Title (Optional)", "v_title"), fillIn("Title (Optional)", "v_title"), done]);
      expect(result.outcome, runLog.lines.join("\n")).toBe("done");
      expect(await events()).toEqual(["P added ann@example.com", "P added bob@example.com"]);
      expect(runLog.lines.some((l) => /chip gate: a script Enter added "bob@example\.com" to "textbox"/.test(l))).toBe(true);
      expect(find(await page.observe(), "fill", "Title (Optional)").value).toBe("Weekly sync");
    }, 30_000);

    it("S6: with options open, a hint and no code Enter; DONE then blocks", async () => {
      const { result } = await run({ q: "bug", f: "login" }, [fillIn("Labels", "v_q"), fillIn("Filter issues", "v_f"), done]);
      expect(result.outcome).toBe("blocked");
      expect(result.blocked?.hint).toBe('typed value not added: "Labels" holds "bug", which is not added yet. The form is not sent without it');
      expect(await events()).toEqual([]);
    }, 30_000);

    it("S2: Jev's Enter reaches the page as a trusted Enter; S1, S3, and S4 get no key event", async () => {
      const s2 = await run({ q: "login bug" }, [fillIn("Filter issues", "v_q"), enterKey, done]);
      expect(s2.result.outcome).toBe("done");
      expect(await events()).toEqual(["S2 search login bug"]);
      const others = await run({ a: "develop", b: "hello team", c: "Owner" }, [fillIn("Default branch", "v_a"), fillIn("Message", "v_b"), fillIn("Role", "v_c"), clickOn("Save"), done]);
      expect(others.result.outcome).toBe("done");
      expect(await events()).toEqual(["S1 submit"]);
    }, 30_000);
  });

  it("a large element before a field is not a chip; an expanded field whose popup cannot be found reads busy", async () => {
    const list = Array.from({ length: 60 }, (_, i) => `<p>message ${i} <button aria-label="Delete message">x</button></p>`).join("");
    await page.navigate(`data:text/html,${encodeURIComponent(`<div><div id="log">${list}</div><input aria-label="Say something" aria-expanded="true"></div>`)}`, NAV_MS);
    await chrome.client.send("Runtime.evaluate", { expression: "document.querySelector('input').focus()" }, page.sessionId);
    const obs = await page.observe();
    const field = find(obs, "fill", "Say something");
    expect(field.token?.items).toEqual([[expect.any(Number), expect.stringMatching(/^message 0 xmessage 1 x/), 0]]);
    expect(field.token?.chips).toEqual([]);
    expect(field.token?.popup).toBe(true);
    expect(await page.popup(field)).toEqual({ open: true, text: "", picks: [], busy: true });
  });

  it("the chip facts never reach the Jev request", async () => {
    const { buildStep } = await import("../../src/fast/policy.js");
    await fresh();
    await fillAndRead("Labels", "bug");
    const obs = await page.observe();
    const request = JSON.stringify(buildStep({ task: "add the label bug", goal: "act", obs, history: [], spans: [], keys: [], bannedActionIds: new Set(), doneBanned: false, canGenerate: true }));
    for (const key of ["token", "items", "chips", "multi", "popup", "learned"]) expect(request).not.toContain(`"${key}":`);
  });
});

describe.skipIf(process.env["JEV_LIVE"] !== "1")("fast page (live Chrome): names, pickers, and mention chips", () => {
  let chrome: Chrome;
  let page: Page;
  const log = fakeLogger();
  const mentionUrl = pathToFileURL(path.join(FIXTURES, "mention.html")).href;
  const evaluate = async (expression: string): Promise<unknown> =>
    ((await chrome.client.send("Runtime.evaluate", { expression, returnByValue: true }, page.sessionId))["result"] as { value?: unknown } | undefined)?.value;

  beforeAll(async () => {
    chrome = await launchChrome({ headed: false, env: process.env, log });
    page = await openPage(chrome, { settleTimeoutMs: NAV_MS, log });
    await page.navigate(mentionUrl, NAV_MS);
  }, 30_000);

  afterAll(async () => {
    await page?.close().catch(() => undefined);
    await chrome?.close().catch(() => undefined);
    if (chrome?.pid && processAlive(chrome.pid)) process.kill(chrome.pid, "SIGKILL");
  });

  it("a textbox never takes its name from its content; only an input button is named by its value", async () => {
    const obs = await page.observe();
    expect(find(obs, "fill", "Type a message").value).toBe("Hi Ann @Ann Lee");
    expect(find(obs, "fill", "Notes").value).toBe("default text");
    expect(find(obs, "click", "Post").role).toBe("button");
    expect(obs.actions.some((a) => a.label === "on" || a.label.startsWith("on "))).toBe(false);
    expect(obs.actions.filter((a) => a.role === "checkbox").map((a) => a.label)).toEqual(["checkbox"]);
  });

  it("an option takes checked from its checkbox, which is not an action; aria-selected stays selected", async () => {
    const obs = await page.observe();
    expect(find(obs, "click", "Ann Lee")).toMatchObject({ role: "option", checked: "true", selected: "false" });
    expect(find(obs, "click", "Research Agent")).toMatchObject({ selected: "true" });
    expect(find(obs, "click", "Research Agent").checked).toBeUndefined();
    expect(find(obs, "click", "Chosen")).toMatchObject({ selected: "true" });
    expect(find(obs, "click", "Multi chosen")).toMatchObject({ selected: "true" });
  });

  it("each action in a popup has the popups around it, innermost first; the dialog id is the form id of its controls", async () => {
    const obs = await page.observe();
    const option = find(obs, "click", "Ann Lee");
    const done = find(obs, "click", "Done (1)");
    expect(option.popup).toHaveLength(2);
    expect(done.popup).toEqual([option.popup?.[1]]);
    expect(done.form).toBe(done.popup?.[0]);
    expect(find(obs, "fill", "Search people").popup).toEqual(done.popup);
    expect(find(obs, "fill", "Type a message").popup).toBeUndefined();
  });

  it("an editor lists its mention chips, the text outside its atoms, and its other atoms; focus lists the chips", async () => {
    const obs = await page.observe();
    expect(find(obs, "fill", "Type a message")).toMatchObject({ mentions: ["Ann Lee"], bareText: "Hi Ann" });
    expect(find(obs, "fill", "Type a message").otherAtoms).toBeUndefined();
    expect(find(obs, "fill", "Doc")).toMatchObject({ mentions: ["Bob Roy"], bareText: "Intro", otherAtoms: 1 });
    expect(find(obs, "fill", "Notes").mentions).toBeUndefined();
    await evaluate("document.getElementById('composer').focus()");
    expect((await page.observe()).focus).toMatchObject({ label: "Type a message", mentions: ["Ann Lee"], multiline: true });
  });

  it("a fill that keeps the chips types at the end with no select-all, keeps the chip, and does not click it", async () => {
    const obs = await page.observe();
    await page.act(find(obs, "fill", "Type a message"), obs, "could you share the report?", { mode: "append", keepChips: true });
    const after = await page.observe();
    expect(find(after, "fill", "Type a message")).toMatchObject({ mentions: ["Ann Lee"], bareText: "Hi Ann could you share the report?" });
    expect(await evaluate("document.querySelectorAll('#composer [data-mention-id]').length")).toBe(1);
    expect(await evaluate("window.chipDowns")).toBe(0);
  });

  it("a field that is all chip: a fill that keeps the chips never clicks the chip, and a plain fill replaces it, as before", async () => {
    const obs = await page.observe();
    await expect(page.act(find(obs, "fill", "Big chip"), obs, "hello", { mode: "append", keepChips: true })).rejects.toBeInstanceOf(StalePage);
    expect(await evaluate("window.chipDowns")).toBe(0);
    await page.act(find(obs, "fill", "Big chip"), obs, "hello");
    expect(find(await page.observe(), "fill", "Big chip").value).toBe("hello");
    await page.navigate(mentionUrl, NAV_MS);
  });
});

describe.skipIf(process.env["JEV_LIVE"] !== "1")("one-shot CLI (live Chrome)", () => {
  it("SIGINT during the Chrome launch closes Chrome and removes the temporary profile", async () => {
    // A stand-in for the API: it serves the fixture and holds every other request open. The run has the profile,
    // the URL, and the goal, so the CLI fires the warm and starts Chrome together. The warm's GET / is the first
    // request the server sees; at that moment the launch is in flight. A SIGINT then must still remove the
    // temporary profile, which lives under TMPDIR.
    let onHeld: () => void = () => undefined;
    const held = new Promise<void>((r) => { onHeld = r; });
    const open: http.ServerResponse[] = [];
    const server = http.createServer((req, res) => {
      if (req.url === "/form.html") { res.setHeader("content-type", "text/html"); res.end(fs.readFileSync(path.join(FIXTURES, "form.html"))); return; }
      open.push(res);
      onHeld();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-cli-sigint-"));
    try {
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "click Greet", "--url", `${base}/form.html`, "--goal", "act", "--profile", "none"], {
        cwd: path.resolve(__dirname, "../.."),
        env: { ...process.env, TYPESAFE_API_KEY: "live-test-dummy-key-0123456789", TYPESAFE_BASE_URL: base, TMPDIR: tmp },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => { stdout += String(c); });
      child.stderr.on("data", (c) => { stderr += String(c); });
      const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
      await Promise.race([held, exited.then(() => { throw new Error(`the CLI exited before any request arrived:\n${stderr}`); })]);
      child.kill("SIGINT");
      const code = await Promise.race([exited, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no exit after SIGINT:\n${stderr}`)), 20_000))]);
      expect(code).toBe(130);
      expect(stdout).toContain("human_aborted: SIGINT");
      expect(stderr).toContain("SIGINT: closing the browser");
      expect(fs.readdirSync(tmp).filter((n) => n.startsWith("jev-chrome-"))).toEqual([]);
      const left = execFileSync("sh", ["-c", `pgrep -f "${tmp}" || true`], { encoding: "utf8" }).trim();
      expect(left).toBe("");
    } finally {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      // A Chrome that dies from the closed pipe can still write for a moment. Retry the removal.
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 40_000);
});

describe.skipIf(process.env["JEV_LIVE"] !== "1")("fast chrome (live Chrome): close", () => {
  it("a process that closed Chrome exits at once", async () => {
    // Before this test the close path raced the exit event against a 3 s timer and never cleared the timer,
    // so every one-shot run stayed alive 3 s after it printed the result. A child process shows the real effect:
    // it launches Chrome, closes it, prints CLOSED, and must exit within a second after that.
    const script = [
      `const { launchChrome } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/fast/chrome.ts")).href)});`,
      "const log = { debug() {}, info() {}, warn() {}, error() {}, step() {}, redactor: (s) => s };",
      "const chrome = await launchChrome({ headed: false, env: process.env, log });",
      'await chrome.newTarget("about:blank");',
      "await chrome.close();",
      'process.stdout.write("CLOSED\\n");',
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: path.resolve("."), stdio: ["ignore", "pipe", "ignore"] });
    let closedAt = 0;
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); if (out.includes("CLOSED") && !closedAt) closedAt = Date.now(); });
    const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
    const exitedAt = Date.now();
    expect(out).toContain("CLOSED");
    expect(code).toBe(0);
    expect(exitedAt - closedAt).toBeLessThan(1000);
  }, 30_000);
});

describe.skipIf(process.env["JEV_LIVE"] !== "1")("review regressions (live Chrome)", () => {
  let chrome: Chrome;
  let page: Page;
  const log = fakeLogger();
  const html = async (body: string) => page.navigate(`data:text/html,${encodeURIComponent(body)}`, NAV_MS);
  const evaluate = async (expression: string) => {
    const result = await chrome.client.send("Runtime.evaluate", { expression, returnByValue: true }, page.sessionId);
    return (result["result"] as { value?: unknown })?.value;
  };
  beforeAll(async () => {
    chrome = await launchChrome({ headed: false, env: process.env, log });
    page = await openPage(chrome, { settleTimeoutMs: NAV_MS, log });
  });
  afterAll(async () => { await chrome?.close(); });

  it.each(["true", "", "plaintext-only"])("fills a contenteditable=%j chat editor before Enter", async (mode) => {
    await html(`<div id="editor" contenteditable="${mode}" data-placeholder="Message" style="min-height:80px;border:1px solid"> </div>`);
    await evaluate(`document.getElementById('editor').addEventListener('keydown', e => { if(e.key === 'Enter') { e.preventDefault(); window.sent = e.currentTarget.innerText; } }); document.getElementById('editor').focus()`);
    const empty = await page.observe();
    const field = find(empty, "fill", "Message");
    expect(field).toMatchObject({ multiline: true, form: null });
    expect(empty.focus?.editable).toBe(true);
    expect(canPressEnter(empty)).toBe(false);
    await page.act(field, empty, "List my latest meetings");
    const filled = await page.observe();
    expect(filled.focus?.value).toBe("List my latest meetings");
    expect(canPressEnter(filled)).toBe(true);
    await expect(page.press("Enter", empty)).rejects.toBeInstanceOf(StalePage);
    await page.press("Enter", filled);
    expect(await evaluate("window.sent")).toBe("List my latest meetings");
  });

  it("rejects Enter after focus moves to another form", async () => {
    await html('<form id="a" onsubmit="event.preventDefault();window.sent=this.id"><input id="one"><button>Search</button></form><form id="b" onsubmit="event.preventDefault();window.sent=this.id"><input id="two"><button>Delete account</button></form>');
    await evaluate("document.getElementById('one').focus()");
    const obs = await page.observe();
    expect(obs.focus?.submitLabel).toBe("Search");
    await evaluate("document.getElementById('two').focus()");
    await expect(page.press("Enter", obs)).rejects.toBeInstanceOf(StalePage);
    expect(await evaluate("window.sent ?? null")).toBeNull();
    const after = await page.observe();
    expect(after.focus?.submitLabel).toBe("Delete account");
    await page.press("Enter", after);
    expect(await evaluate("window.sent")).toBe("b");
  });

  it("gives the focus form and the form's default button, the same form id as the actions", async () => {
    await html('<form><input id="t" aria-label="Title"><button type="button">Help</button><button disabled>Save draft</button><button>Submit for review</button></form>'
      + '<form><input id="n" aria-label="Name"><button>Save draft</button><button>Publish</button></form><div role="dialog"><textarea id="m" aria-label="Message"></textarea><button>Send</button></div>');
    const focusOn = async (id: string) => { await evaluate(`document.getElementById('${id}').focus()`); return page.observe(); };
    const t = await focusOn("t");
    expect(t.focus).toMatchObject({ submitLabel: "Submit for review", submitDefault: "" });
    expect(t.focus?.form).toBe(t.actions.find((a) => a.label === "Title")?.form);
    const n = await focusOn("n");
    expect(n.focus).toMatchObject({ submitLabel: "Save draft | Publish", submitDefault: "Save draft" });
    expect(n.focus?.form).not.toBe(t.focus?.form);
    expect(n.focus?.multiline).toBe(false);
    const m = await focusOn("m");
    expect(m.focus).toMatchObject({ submitLabel: "", submitDefault: "", multiline: true });
    expect(m.focus?.form).toBe(m.actions.find((a) => a.label === "Send")?.form);
    expect(m.focus?.form).not.toBeNull();
  });

  it("names an image button that comes first as the default button", async () => {
    await html('<form><input id="q" aria-label="Query"><input type="image" alt="Submit" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><button>Save draft</button></form>');
    await evaluate("document.getElementById('q').focus()");
    const o = await page.observe();
    expect(o.focus).toMatchObject({ submitLabel: "Submit | Save draft", submitDefault: "Submit" });
  });

  it("rejects Enter when the submit control changes while focus stays in place", async () => {
    await html('<form onsubmit="event.preventDefault();window.sent=true"><input id="field"><button id="submit">Search</button></form>');
    await evaluate("document.getElementById('field').focus()");
    const obs = await page.observe();
    await evaluate("document.getElementById('submit').textContent='Delete account'");
    await expect(page.press("Enter", obs)).rejects.toBeInstanceOf(StalePage);
    expect(await evaluate("window.sent ?? null")).toBeNull();
  });

  it("scrolls a panel in both directions and detects a stale panel scroll", async () => {
    await html('<style>body{margin:0;overflow:hidden}#list{height:300px;overflow:auto}</style><div id="list" aria-label="Results"><div style="height:1600px"><button>Top</button></div><button>Bottom</button></div>');
    const obs = await page.observe();
    expect(obs.scroll.height).toBe(obs.h);
    const down = obs.actions.find((a) => a.id === "scroll_down")!;
    expect(down.node).toBeTypeOf("number");
    await page.act(down, obs);
    const next = await page.observe();
    expect(await evaluate("document.getElementById('list').scrollTop")).toBeGreaterThan(0);
    expect(next.fingerprint).not.toBe(obs.fingerprint);
    await expect(page.act(down, obs)).rejects.toBeInstanceOf(StalePage);
    const up = next.actions.find((a) => a.id === "scroll_up")!;
    await page.act(up, next);
    expect(await evaluate("document.getElementById('list').scrollTop")).toBe(0);
    // The lower controls become reachable after scrolling to the bottom.
    let current = await page.observe();
    for (let i = 0; i < 4; i++) {
      const action = current.actions.find((a) => a.id === "scroll_down");
      if (!action) break;
      await page.act(action, current);
      current = await page.observe();
    }
    expect(current.actions.some((a) => a.label === "Bottom")).toBe(true);
  });

  it("keeps an OTP out of requests after a real fill", async () => {
    const { buildStep } = await import("../../src/fast/policy.js");
    const { varSpans } = await import("../../src/task.js");
    await html('<label>Verification code<input autocomplete="One-Time-Code"></label>');
    const obs = await page.observe();
    expect(obs.actions.find((a) => a.kind === "fill")).toMatchObject({ autocomplete: "one-time-code", inputType: "text", multiline: false });
    await page.act(obs.actions.find((a) => a.kind === "fill")!, obs, "987654");
    const after = await page.observe();
    expect(after.actions.find((a) => a.kind === "fill")?.value).toBe("987654");
    const request = buildStep({ task: "Verify account", goal: "act", obs: after, history: [], spans: varSpans({ otp: "987654" }), keys: [], bannedActionIds: new Set(), doneBanned: false });
    expect(JSON.stringify(request.state)).not.toContain("987654");
    expect(JSON.stringify(request.questions)).not.toContain("987654");
  });
});

describe.skipIf(process.env["JEV_LIVE"] !== "1")("review regressions: process ownership", () => {
  it("holds the profile lock until Chrome exits and rejects a second launch or refresh", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-profile-owner-"));
    const source = path.join(root, "source");
    fs.mkdirSync(path.join(source, "Default"), { recursive: true });
    fs.writeFileSync(path.join(source, "Default", "Preferences"), "{}");
    const opts = { headed: false, env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "config") }, sourceUserDataDir: source, profileDirectory: "Default", log: fakeLogger() };
    let chrome: Chrome | undefined;
    try {
      chrome = await launchChrome(opts);
      const dir = chrome.userDataDir!;
      const marker = fs.readFileSync(path.join(dir, "jev-copy.json"), "utf8");
      const lock = fs.readlinkSync(path.join(dir, "SingletonLock"));
      for (const refreshProfile of [false, true]) await expect(launchChrome({ ...opts, refreshProfile })).rejects.toThrow(/profile is locked/);
      expect(fs.readlinkSync(path.join(dir, "SingletonLock"))).toBe(lock);
      expect(fs.readFileSync(path.join(dir, "jev-copy.json"), "utf8")).toBe(marker);
      expect(await chrome.client.send("Browser.getVersion")).toHaveProperty("product");
      await chrome.close();
      expect(fs.existsSync(`${dir}.jev-lock`)).toBe(false);
      chrome = await launchChrome(opts);
      expect(chrome.profile.copied).toBe(false);
    } finally {
      await chrome?.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30_000);

  it.each([
    ["cdp", "done"], ["cdp", "failed"], ["chromium", "done"], ["chromium", "failed"],
  ])("one-shot %s --cdp --keep-open exits after %s and keeps its tab", async (engine, outcome) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-keep-open-"));
    const server = http.createServer((req, res) => {
      req.resume();
      if (req.url === "/fixture") { res.setHeader("content-type", "text/html"); res.end("<title>Keep open</title><p>Ready</p>"); return; }
      res.setHeader("content-type", "application/json");
      if (req.method !== "POST") { res.end("{}"); return; }
      if (outcome === "failed") { res.statusCode = 400; res.end(JSON.stringify({ error: { message: "fixture failure" } })); return; }
      res.end(JSON.stringify({ model: "jev-fixture", usage: { input_tokens: 1, output_tokens: 1 }, answers: {
        operation: { type: "choice", choice: "DONE", confidence: 0.95, probabilities: { DONE: 0.95, WAIT: 0.05 } },
        page_kind: { type: "choice", choice: "task_page", confidence: 0.95, probabilities: { task_page: 0.95 } },
      } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = spawn(findChrome(process.env), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${root}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    const browserExit = new Promise<void>((r) => browser.once("exit", () => r()));
    let cli: ReturnType<typeof spawn> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const active = path.join(root, "DevToolsActivePort");
      for (let i = 0; i < 100 && !fs.existsSync(active); i++) await new Promise((r) => setTimeout(r, 50));
      const port = Number(fs.readFileSync(active, "utf8").split("\n")[0]);
      cli = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "--engine", engine!, "inspect the page", "--url", `${api}/fixture`, "--profile", "none", "--goal", "act", "--cdp", String(port), "--keep-open"], {
        cwd: path.resolve("."), env: { ...process.env, TYPESAFE_API_KEY: "local-fixture-key-0123456789", TYPESAFE_BASE_URL: api }, stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = ""; let stderr = "";
      cli.stdout?.on("data", (b) => { stdout += String(b); });
      cli.stderr?.on("data", (b) => { stderr += String(b); });
      const exit = new Promise<number | null>((r) => cli!.once("exit", (code) => r(code)));
      const code = await Promise.race([exit, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`CLI did not exit: ${stdout}\n${stderr}`)), 8000);
      })]);
      clearTimeout(timer);
      expect(code, stderr).toBe(outcome === "done" ? 0 : 3);
      expect(JSON.parse(stdout).outcome).toBe(outcome);
      expect(JSON.parse(stdout).stats.engine).toBe(engine);
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { url: string }[];
      expect(tabs.some((t) => t.url === `${api}/fixture`)).toBe(true);
      expect(tabs.some((t) => t.url === "about:blank")).toBe(true);
    } finally {
      clearTimeout(timer);
      if (cli && cli.exitCode === null && cli.signalCode === null) {
        const exited = new Promise<void>((r) => cli!.once("exit", () => r()));
        cli.kill("SIGKILL");
        await exited;
      }
      browser.kill("SIGKILL");
      await browserExit;
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);
});

describe.skipIf(process.env["JEV_LIVE"] !== "1")("fill edit plans (live Chrome)", () => {
  const editorsUrl = pathToFileURL(path.join(FIXTURES, "editors.html")).href;
  let chrome: Chrome;
  let page: Page;
  const log = fakeLogger();
  const evaluate = async (expression: string) => {
    const result = await chrome.client.send("Runtime.evaluate", { expression, returnByValue: true }, page.sessionId);
    return (result["result"] as { value?: unknown })?.value;
  };
  const text = async (id: string) => String(await evaluate(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return 'value' in e ? e.value : e.innerText; })()`));
  const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  /** Load the fixture again and fill `label` with `value` as `mode` says. */
  async function fillIn(label: string, value: string, mode?: "replace" | "append") {
    await page.navigate(editorsUrl, NAV_MS);
    const obs = await page.observe();
    return page.act(find(obs, "fill", label), obs, value, mode ? { mode } : undefined);
  }
  beforeAll(async () => {
    chrome = await launchChrome({ headed: false, env: process.env, log });
    page = await openPage(chrome, { settleTimeoutMs: NAV_MS, log });
  }, 30_000);
  afterAll(async () => { await page?.close().catch(() => undefined); await chrome?.close(); });

  it("an append into a document adds a new block after the last one; no Mod+A, no Enter, no hidden input", async () => {
    const r = await fillIn("Document", "Reviewed by QA", "append");
    expect(r).toMatchObject({ mode: "append", shape: "document" });
    expect(lines(await text("doc"))).toEqual(["Release 4.2 notes", "This release improves the editor.", "Faster saving", "New history panel", "The QA team tested it.", "Reviewed by QA"]);
    expect(await evaluate("document.querySelector('#doc').lastElementChild.tagName + ':' + document.querySelector('#doc').lastElementChild.textContent")).toBe("P:Reviewed by QA");
    expect(await evaluate("[window.sends.length, window.shadowFocus, document.getElementById('shadow').value]")).toEqual([0, 0, ""]);
  });

  it("text with line breaks goes into a document as one block per line", async () => {
    await fillIn("Document", "In short, it is faster.\nIt adds a history panel.", "append");
    expect(lines(await text("doc")).slice(-3)).toEqual(["The QA team tested it.", "In short, it is faster.", "It adds a history panel."]);
    expect(await evaluate("[...document.querySelector('#doc').children].slice(-2).map((e) => e.tagName + ':' + e.textContent)")).toEqual(["P:In short, it is faster.", "P:It adds a history panel."]);
  });

  it("a replace selects all of the document with a key-less command: the hidden input never gets focus", async () => {
    const r = await fillIn("Document", "Release 4.2 is cancelled");
    expect(r).toMatchObject({ mode: "replace" });
    expect(lines(await text("doc"))).toEqual(["Release 4.2 is cancelled"]);
    expect(await evaluate("[window.sends.length, window.shadowFocus]")).toEqual([0, 0]);
  });

  it("an append into a document that ends in an empty paragraph types there, with no second new block", async () => {
    await fillIn("Checklist", "Reviewed by QA", "append");
    expect(lines(await text("tail"))).toEqual(["Intro", "One", "Reviewed by QA"]);
    expect(await evaluate("[...document.querySelector('#tail').children].map((e) => e.tagName)")).toEqual(["P", "UL", "P"]);
  });

  it("an append into a composer joins with one space and sends nothing; text with line breaks is refused before any change", async () => {
    const r = await fillIn("Message", "see you at 3", "append");
    expect(r).toMatchObject({ mode: "append", shape: "composer", after: "Hello team see you at 3" });
    expect(await evaluate("window.sends")).toEqual([]);
    const e = await fillIn("Message", "one\ntwo", "append").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EditRefused);
    expect((e as EditRefused).changed).toBe(false);
    expect(await text("composer")).toBe("Hello team");
    expect(await evaluate("window.sends")).toEqual([]);
  });

  it("an append into a textarea adds a line; a replace of email and number inputs works without a selection API", async () => {
    expect(await fillIn("Notes", "Always answer in English", "append")).toMatchObject({ shape: "textarea" });
    expect(await text("notes")).toBe("Keep answers short.\nAlways answer in English");
    expect(await fillIn("Notes", "Only English")).toMatchObject({ mode: "replace" });
    expect(await text("notes")).toBe("Only English");
    await fillIn("Email", "ann@example.com");
    expect(await text("email")).toBe("ann@example.com");
    await fillIn("Guests", "25");
    expect(await text("guests")).toBe("25");
  });

  it("a role=textbox wrapper that is not editable types into the text control inside it that the click focused", async () => {
    expect(await fillIn("Wrapped", "ann@example.com")).toMatchObject({ mode: "replace", shape: "input", before: "old@example.com", after: "ann@example.com" });
    expect(await text("inner")).toBe("ann@example.com");
  });

  it("a field that gives its focus away refuses the fill: nothing is typed anywhere", async () => {
    const e = await fillIn("Thief", "Reviewed by QA", "append").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EditRefused);
    expect((e as Error).message).toBe('the fill did not start: focus is on input#other "Other", not on the field');
    expect(await text("thief")).toBe("Old text");
    expect(await text("other")).toBe("");
  });
});

describe.skipIf(process.env["JEV_LIVE"] !== "1")("date fields (live Chrome)", () => {
  let chrome: Chrome;
  let page: Page;
  const log = fakeLogger();
  const evaluate = async (expression: string) => {
    const result = await chrome.client.send("Runtime.evaluate", { expression, returnByValue: true }, page.sessionId);
    return (result["result"] as { value?: unknown })?.value;
  };
  const field = (obs: Observation, label: string): Action => {
    const a = obs.actions.find((x) => x.kind === "fill" && x.label === label && x.date !== undefined);
    if (!a) throw new Error(`no date field "${label}" among: ${obs.actions.filter((x) => x.kind === "fill").map((x) => x.label).join(", ")}`);
    return a;
  };
  /** Set a date field as the loop does: plan from the observation, set, observe. */
  const set = async (label: string, want: string): Promise<Observation> => {
    const obs = await page.observe();
    const a = field(obs, label);
    const planned = datePlan(a, obs, want);
    if (!planned) throw new Error(`no plan for ${label}`);
    await page.setDate(a, obs, planned.plan);
    return page.observe();
  };

  beforeAll(async () => {
    chrome = await launchChrome({ headed: false, env: process.env, log });
    page = await openPage(chrome, { settleTimeoutMs: NAV_MS, log });
  }, 30_000);

  afterAll(async () => {
    await page?.close().catch(() => undefined);
    await chrome?.close().catch(() => undefined);
    if (chrome?.pid && processAlive(chrome.pid)) process.kill(chrome.pid, "SIGKILL");
  });

  it("shows each whole part group as one date field with range roles, and no part rows or Open clicks", async () => {
    await page.navigate(segmentsUrl, NAV_MS);
    const obs = await page.observe();
    const start = field(obs, "Date range start (M/D/YYYY)");
    const end = field(obs, "Date range end (M/D/YYYY)");
    expect(start).toMatchObject({ kind: "fill", role: "textbox", value: "8/24/2026" });
    expect(start.date).toMatchObject({ kind: "group", sep: "/", order: "MDY", pad: false, short: false, role: "start" });
    expect(end.date).toMatchObject({ role: "end", range: start.date?.range });
    expect(start.date?.parts?.map((p) => [p.part, p.value, p.spin])).toEqual([["month", "8", false], ["day", "24", false], ["year", "2026", false]]);
    expect(start.node).toBe(start.date?.parts?.[0]?.node);
    expect(field(obs, "Due date (M/D/YYYY)").date?.role).toBeUndefined();
    expect(field(obs, "Event date (M/D/YYYY)").date?.parts?.every((p) => p.spin)).toBe(true);
    // Two groups without a range word between them are two plain "Date" fields.
    expect(obs.actions.filter((a) => a.label === "Date (M D YYYY)").map((a) => a.date?.role)).toEqual([undefined, undefined]);
    // No part is an action, and no part has an "Open" click. Card expiry parts are not date parts; a lone MM is.
    expect(obs.actions.some((a) => /^(Open )?(M|D|YYYY)$/.test(a.label))).toBe(false);
    expect(obs.actions.filter((a) => a.label === "MM").map((a) => [a.autocomplete ?? "", a.datePart ?? ""])).toEqual([["cc-exp-month", ""], ["", "month"]]);
    expect(obs.actions.filter((a) => a.date !== undefined).every((a) => !canWriteInto(a))).toBe(true);
    // The calendar: ISO days from the cells (never the button's locale data-day), the selection, and the range flags.
    const days = obs.actions.filter((a) => a.day !== undefined);
    expect(days).toHaveLength(61);
    expect(days.find((a) => a.day?.day === "2026-08-24")?.day).toMatchObject({ multi: true, sel: true, pos: "start" });
    expect(days.find((a) => a.day?.day === "2026-09-01")?.day).toMatchObject({ sel: true, pos: "middle" });
    expect(days.find((a) => a.day?.day === "2026-09-23")?.day).toMatchObject({ sel: true, pos: "end" });
    expect(days.find((a) => a.day?.day === "2026-09-24")?.day).toMatchObject({ sel: false });
    expect(calendarDay(days[0] as Action)).toEqual({ y: 2026, m: 8, d: 1 });
    expect(new Set(days.map((a) => a.form))).toEqual(new Set([start.form]));
    expect(hasDateWidget(obs)).toBe(true);
  });

  it("types a range start day first, so the end does not move; then the end; then Update reports the range", async () => {
    await page.navigate(segmentsUrl, NAV_MS);
    const first = await page.observe();
    expect(datePlan(field(first, "Date range start (M/D/YYYY)"), first, "2026-09-01")?.order).toBe("day,month");
    const afterStart = await set("Date range start (M/D/YYYY)", "2026-09-01");
    expect(field(afterStart, "Date range start (M/D/YYYY)").value).toBe("9/1/2026");
    expect(field(afterStart, "Date range end (M/D/YYYY)").value).toBe("9/23/2026");
    const afterEnd = await set("Date range end (M/D/YYYY)", "2026-09-15");
    expect(shownOf(field(afterEnd, "Date range end (M/D/YYYY)"))).toBe("2026-09-15");
    expect(afterEnd.actions.filter((a) => a.day?.sel).map((a) => a.day?.day)).toEqual(Array.from({ length: 15 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`));
    await page.act(find(afterEnd, "click", "Update"), afterEnd);
    expect(await evaluate("window.log")).toEqual(["date 2026-09-01 2026-09-15"]);
  });

  it("the order matters on the real part behavior: 10/31 to 9/30 month first ends at 10/30, day first at 9/30", async () => {
    await page.navigate(segmentsUrl, NAV_MS);
    const obs = await page.observe();
    const due = field(obs, "Due date (M/D/YYYY)");
    const [month, day] = due.date?.parts ?? [];
    await page.setDate(due, obs, { parts: [{ node: month?.node as number, text: "9", spin: false }, { node: day?.node as number, text: "30", spin: false }] });
    expect(field(await page.observe(), "Due date (M/D/YYYY)").value).toBe("10/30/2026");
    await page.navigate(segmentsUrl, NAV_MS);
    const again = await page.observe();
    expect(datePlan(field(again, "Due date (M/D/YYYY)"), again, "2026-09-30")?.order).toBe("day,month");
    expect(field(await set("Due date (M/D/YYYY)", "2026-09-30"), "Due date (M/D/YYYY)").value).toBe("9/30/2026");
  });

  it("types spinbutton segments key by key", async () => {
    await page.navigate(segmentsUrl, NAV_MS);
    const after = await set("Event date (M/D/YYYY)", "2027-12-05");
    expect(shownOf(field(after, "Event date (M/D/YYYY)"))).toBe("2027-12-05");
  });

  it("a stale observation types nothing", async () => {
    await page.navigate(segmentsUrl, NAV_MS);
    const obs = await page.observe();
    await evaluate("document.querySelector('#g-due input').value='1'");
    const due = field(obs, "Due date (M/D/YYYY)");
    await expect(page.setDate(due, obs, datePlan(due, obs, "2026-09-30")?.plan as never)).rejects.toBeInstanceOf(StalePage);
  });

  it("native date inputs are fill actions without Open clicks, and the value setter sets them with input and change events", async () => {
    await page.navigate(nativeUrl, NAV_MS);
    const obs = await page.observe();
    const shape = await evaluate("new Intl.DateTimeFormat(undefined,{year:'numeric',month:'numeric',day:'numeric'}).formatToParts(new Date(2026,10,23)).filter(p=>p.type!=='literal').map(p=>p.type[0].toUpperCase()).join('')");
    expect(field(obs, "Due date (date)")).toMatchObject({ value: "2026-08-24", inputType: "date", date: { kind: "date", min: "2026-01-01", max: "2026-12-31", order: shape } });
    expect(field(obs, "Meeting (date and time)").date?.kind).toBe("datetime-local");
    expect(field(obs, "Billing month (month)").date?.kind).toBe("month");
    expect(field(obs, "Start time (time)").date?.kind).toBe("time");
    expect(field(obs, "Week (week)").date?.kind).toBe("week");
    expect(obs.actions.some((a) => a.label.startsWith("Open ") && a.inputType !== undefined && ["date", "month", "time", "week", "datetime-local"].includes(a.inputType))).toBe(false);
    // The GOV.UK group: the legend labels it, and the day comes first.
    expect(field(obs, "Date of birth (D M YYYY)").date).toMatchObject({ kind: "group", order: "DMY", sep: " " });
    const due = await set("Due date (date)", "2026-09-15");
    expect(field(due, "Due date (date)").value).toBe("2026-09-15");
    expect(await evaluate("window.log")).toEqual(["due input 2026-09-15", "due change 2026-09-15"]);
    expect(field(await set("Meeting (date and time)", "2026-09-01T10:30"), "Meeting (date and time)").value).toBe("2026-09-01T10:30");
    expect(field(await set("Billing month (month)", "2026-09"), "Billing month (month)").value).toBe("2026-09");
    expect(field(await set("Start time (time)", "09:30"), "Start time (time)").value).toBe("09:30");
    expect(field(await set("Week (week)", "2026-W36"), "Week (week)").value).toBe("2026-W36");
    expect(shownOf(field(await set("Date of birth (D M YYYY)", "1990-03-07"), "Date of birth (D M YYYY)"))).toBe("1990-03-07");
  });

  it("the causal settle follows setDate: a page that loads 300 ms after a change shows the result at the next observe", async () => {
    await page.navigate(nativeUrl, NAV_MS);
    // A filter that loads after each change, as a report page does. The frame settle alone reads the page before it.
    await evaluate(`(() => {
      const out = document.createElement("p"); out.id = "out"; out.textContent = "Loading"; document.body.append(out);
      for (const e of document.querySelectorAll("input")) e.addEventListener("change", () => setTimeout(() => { out.textContent = "Loaded " + e.id + " " + e.value; }, 300));
      return true;
    })()`);
    expect((await set("Due date (date)", "2026-09-15")).text).toContain("Loaded due 2026-09-15");
    // A group: each part changes, and the settle waits for the timer of the last part.
    expect((await set("Date of birth (D M YYYY)", "1990-03-07")).text).toContain("Loaded yy 1990");
  });
});
