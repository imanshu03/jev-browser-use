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
import type { Action, Chrome, Observation, Page } from "../../src/fast/model.js";
import { StalePage } from "../../src/fast/model.js";
import { openPage } from "../../src/fast/page.js";
import { canPressEnter } from "../../src/fast/policy.js";
import { fakeLogger } from "../fakes.js";

const FIXTURES = path.resolve(__dirname, "../fixtures/live");
const formUrl = pathToFileURL(path.join(FIXTURES, "form.html")).href;
const liveUrl = pathToFileURL(path.join(FIXTURES, "live.html")).href;
const replyUrl = pathToFileURL(path.join(FIXTURES, "reply.html")).href;
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
    for (const key of ["maxLength", "inputType", "multiline", "autocomplete", "form", "doc", "filled", "texts"]) expect(request).not.toContain(`"${key}":`);
    expect(request).toContain("\"generate\"");
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

  it("an option takes checked from its checkbox, which is not an action; aria-selected in a combobox list is highlighted", async () => {
    const obs = await page.observe();
    expect(find(obs, "click", "Ann Lee")).toMatchObject({ role: "option", checked: "true", highlighted: "false" });
    expect(find(obs, "click", "Ann Lee").selected).toBeUndefined();
    expect(find(obs, "click", "Research Agent")).toMatchObject({ highlighted: "true" });
    expect(find(obs, "click", "Chosen")).toMatchObject({ selected: "true" });
    expect(find(obs, "click", "Chosen").highlighted).toBeUndefined();
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

  it("an append fill types at the end with no select-all, keeps the chip, and does not click it", async () => {
    const obs = await page.observe();
    await page.act(find(obs, "fill", "Type a message"), obs, "could you share the report?", { append: true });
    const after = await page.observe();
    expect(find(after, "fill", "Type a message")).toMatchObject({ mentions: ["Ann Lee"], bareText: "Hi Ann could you share the report?" });
    expect(await evaluate("document.querySelectorAll('#composer [data-mention-id]').length")).toBe(1);
    expect(await evaluate("window.chipDowns")).toBe(0);
  });

  it("a field that is all chip: an append fill never clicks the chip, and a plain fill replaces it, as before", async () => {
    const obs = await page.observe();
    await expect(page.act(find(obs, "fill", "Big chip"), obs, "hello", { append: true })).rejects.toBeInstanceOf(StalePage);
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
