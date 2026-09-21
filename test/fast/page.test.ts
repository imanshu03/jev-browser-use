// Unit tests for openPage over a fake CDP client. No Chrome and no network.
import { describe, expect, it } from "vitest";
import type { CdpClient, Chrome } from "../../src/fast/model.js";
import { StalePage } from "../../src/fast/model.js";
import { openPage } from "../../src/fast/page.js";
import { SNAPSHOT_SCRIPT } from "../../src/fast/snapshot.js";
import { fakeLogger } from "../fakes.js";

function rawSnapshot(url: string, readyState: string, text: string) {
  return { url, title: "T", text, scroll: { y: 0, height: 100 }, w: 1280, h: 860, actions: [], marker: null, page_key: null, guards: {}, omitted_actions: 0, readyState };
}

/** A Chrome whose client answers Runtime.evaluate of the snapshot script from a queue. */
function chromeWith(snapshots: ReturnType<typeof rawSnapshot>[]): { chrome: Chrome; evaluations: () => number } {
  let evaluations = 0;
  const client: CdpClient = {
    closed: false,
    async send(method, params) {
      if (method === "Runtime.evaluate" && params?.["expression"] === SNAPSHOT_SCRIPT) {
        evaluations += 1;
        const next = snapshots.length > 1 ? snapshots.shift() : snapshots[0];
        return { result: { value: next } };
      }
      return { result: { value: null } };
    },
    on() { return () => undefined; },
    async close() { /* nothing */ },
  };
  const chrome: Chrome = {
    client, userDataDir: null, profile: { directory: null, copyDir: null, copied: false, copyMs: 0 }, launchMs: 0,
    async newTarget() { return { targetId: "t1", sessionId: "s1" }; },
    async closeTarget() { /* nothing */ },
    async close() { /* nothing */ },
  };
  return { chrome, evaluations: () => evaluations };
}

describe("openPage.observe readiness", () => {
  it("polls while readyState is not complete, then returns the complete document", async () => {
    const url = "https://example.test/article";
    const c = chromeWith([rawSnapshot(url, "loading", "menu"), rawSnapshot(url, "interactive", "menu"), rawSnapshot(url, "complete", "menu\nTitle")]);
    const log = fakeLogger();
    const page = await openPage(c.chrome, { settleTimeoutMs: 2000, log });
    const obs = await page.observe();
    expect(obs.text).toBe("menu\nTitle");
    expect(c.evaluations()).toBe(3);
    expect(obs.ms).toBeGreaterThanOrEqual(40);
    expect(page.stats.browserMs).toBeGreaterThanOrEqual(40);
    expect(log.lines.some((l) => /observe waited 2 polls/.test(l))).toBe(true);
  });
  it("gives up at the cap once per document and does not wait again on the same url", async () => {
    const url = "https://example.test/slow";
    const c = chromeWith([rawSnapshot(url, "loading", "partial")]);
    const log = fakeLogger();
    const page = await openPage(c.chrome, { settleTimeoutMs: 100, log });
    const first = await page.observe();
    expect(first.text).toBe("partial");
    expect(first.ms).toBeGreaterThanOrEqual(100);
    expect(log.lines.some((l) => /not complete after 100 ms/.test(l))).toBe(true);
    const before = c.evaluations();
    const second = await page.observe();
    expect(second.ms).toBeLessThan(50);
    expect(c.evaluations()).toBe(before + 1);
  });
});

// ---- A scripted CDP client: answers Runtime.evaluate by expression, records every send, and can emit events.

type Sent = { method: string; params: Record<string, unknown>; sessionId?: string };
type Handler = (params: Record<string, unknown>, sessionId?: string) => void;

function scriptedChrome(answer: (expression: string) => unknown | (() => unknown)) {
  const sent: Sent[] = [];
  const handlers = new Map<string, Set<Handler>>();
  const client: CdpClient & { closed: boolean; emit(event: string, params: Record<string, unknown>, sessionId?: string): void } = {
    closed: false,
    async send(method, params, sessionId) {
      sent.push({ method, params: params ?? {}, ...(sessionId !== undefined ? { sessionId } : {}) });
      if (client.closed) throw Object.assign(new Error("connection closed"), { name: "CdpError" });
      if (method === "Runtime.evaluate") {
        const v = answer(String(params?.["expression"] ?? ""));
        const value = typeof v === "function" ? (v as () => unknown)() : v;
        return { result: { value } };
      }
      return {};
    },
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) { set = new Set(); handlers.set(event, set); }
      set.add(handler);
      return () => { set?.delete(handler); };
    },
    async close() { client.closed = true; },
    emit(event, params, sessionId) { for (const h of handlers.get(event) ?? []) h(params, sessionId); },
  };
  const chrome: Chrome = {
    client, userDataDir: null, profile: { directory: null, copyDir: null, copied: false, copyMs: 0 }, launchMs: 0,
    async newTarget() { return { targetId: "t1", sessionId: "s1" }; },
    async closeTarget() { /* nothing */ },
    async close() { /* nothing */ },
  };
  return { chrome, client, sent, handlers };
}

const cdpError = (message: string) => Object.assign(new Error(message), { name: "CdpError", method: "Runtime.evaluate" });

describe("openPage dialogs", () => {
  it("accepts alert and beforeunload, dismisses confirm and prompt, logs the message, ignores other sessions, unsubscribes on close", async () => {
    const c = scriptedChrome(() => null);
    const log = fakeLogger();
    const page = await openPage(c.chrome, { settleTimeoutMs: 100, log });
    expect(c.handlers.get("Page.javascriptDialogOpening")?.size).toBe(1);
    const dialogs = () => c.sent.filter((s) => s.method === "Page.handleJavaScriptDialog").map((s) => s.params["accept"]);
    c.client.emit("Page.javascriptDialogOpening", { type: "alert", message: "hi  there" }, "s1");
    c.client.emit("Page.javascriptDialogOpening", { type: "confirm", message: "Are you sure?" }, "s1");
    c.client.emit("Page.javascriptDialogOpening", { type: "prompt", message: "Name?" }, "s1");
    c.client.emit("Page.javascriptDialogOpening", { type: "beforeunload", message: "" }, "s1");
    c.client.emit("Page.javascriptDialogOpening", { type: "alert", message: "other tab" }, "s2");
    await new Promise((r) => setTimeout(r, 0));
    expect(dialogs()).toEqual([true, false, false, true]);
    expect(c.sent.filter((s) => s.method === "Page.handleJavaScriptDialog").every((s) => s.sessionId === "s1")).toBe(true);
    expect(log.lines).toContain("WARN dialog alert accepted: hi there");
    expect(log.lines).toContain("WARN dialog confirm dismissed: Are you sure?");
    await page.close();
    expect(c.handlers.get("Page.javascriptDialogOpening")?.size).toBe(0);
  });
});

describe("openPage evaluate errors", () => {
  it("a CDP timeout propagates at once instead of a blind poll until the settle cap", async () => {
    const c = scriptedChrome(() => { throw cdpError("timeout: Runtime.evaluate gave no reply in 30000 ms"); });
    const page = await openPage(c.chrome, { settleTimeoutMs: 5000, log: fakeLogger() });
    const t0 = Date.now();
    await expect(page.observe()).rejects.toMatchObject({ name: "CdpError" });
    expect(Date.now() - t0).toBeLessThan(1000);
    await expect(page.url()).rejects.toMatchObject({ name: "CdpError" });
  });
  it("a closed connection propagates", async () => {
    const c = scriptedChrome(() => null);
    const page = await openPage(c.chrome, { settleTimeoutMs: 5000, log: fakeLogger() });
    c.client.closed = true;
    await expect(page.observe()).rejects.toMatchObject({ message: "connection closed" });
  });
  it("a destroyed execution context is a navigating page: observe polls again and returns the next snapshot", async () => {
    let n = 0;
    const snap = rawSnapshot("https://example.test/next", "complete", "loaded");
    const c = scriptedChrome((expr) => {
      if (expr !== SNAPSHOT_SCRIPT) return null;
      n += 1;
      if (n === 1) throw cdpError("Execution context was destroyed.");
      if (n === 2) throw cdpError("Inspected target navigated or closed");
      return snap;
    });
    const page = await openPage(c.chrome, { settleTimeoutMs: 2000, log: fakeLogger() });
    const obs = await page.observe();
    expect(obs.text).toBe("loaded");
    expect(n).toBe(3);
  });
});

describe("openPage freshness", () => {
  const key = [123, "https://example.test/form", 0, 0, 1280, 860, []];
  const guard = [7, "textbox", "Name", "", null, null, false, false, null, null, null, null, null, "Name"];
  const base = { ...rawSnapshot("https://example.test/form", "complete", "Name\n12:00:01"), page_key: key, guards: { "7": guard }, marker: [123, "u", 0, 0, 1280, 860, "T", "Name\n12:00:01", [], []] };

  function withClock() {
    let clock = 0;
    const c = scriptedChrome((expr) => {
      clock += 1;
      if (expr === SNAPSHOT_SCRIPT) return { ...base, text: `Name\n12:00:${clock}`, marker: [123, "u", 0, 0, 1280, 860, "T", `Name\n12:00:${clock}`, [], []] };
      if (/c\.guard\(c\.nodes\.get\(7\)\)/.test(expr)) return [key, guard];
      if (/c\.pageKey\(\)/.test(expr)) return key;
      if (/state\?\.marker/.test(expr)) return [123, "u", 0, 0, 1280, 860, "T", `Name\n12:00:${clock}`, [], []];
      if (/__jevFast\?\.nodes\.get\(action\.node\)/.test(expr)) return { x: 10, y: 10 };
      return null;
    });
    return c;
  }
  const fill = { id: "e1", kind: "fill" as const, node: 7, role: "textbox", label: "Name", value: "" };

  it("a fill on a page with live text elsewhere is fresh (page key and guard), and act types the text", async () => {
    const c = withClock();
    const page = await openPage(c.chrome, { settleTimeoutMs: 500, log: fakeLogger() });
    const obs = await page.observe();
    expect(await page.fresh(obs, fill)).toBe(true);
    expect(await page.fresh(obs)).toBe(false); // the whole marker carries the clock text
    await page.act(fill, obs, "Ada");
    expect(c.sent.some((s) => s.method === "Input.insertText" && s.params["text"] === "Ada")).toBe(true);
  });
  it("a scroll compares the page key only; a wait skips the check", async () => {
    const c = withClock();
    const page = await openPage(c.chrome, { settleTimeoutMs: 500, log: fakeLogger() });
    const obs = await page.observe();
    await page.act({ id: "scroll_down", kind: "scroll", node: null, label: "Scroll down", delta: 560 }, obs);
    expect(c.sent.some((s) => s.method === "Input.dispatchMouseEvent" && s.params["type"] === "mouseWheel")).toBe(true);
    const before = c.sent.length;
    await page.act({ id: "wait", kind: "wait", node: null, label: "Wait" }, obs);
    expect(c.sent.length).toBe(before);
  });
  it("press with an observation checks the page key: a changed document throws StalePage and nothing is dispatched", async () => {
    let pageKey: unknown = key;
    const c = scriptedChrome((expr) => {
      if (expr === SNAPSHOT_SCRIPT) return base;
      if (/c\.pageKey\(\)/.test(expr)) return pageKey;
      return null;
    });
    const page = await openPage(c.chrome, { settleTimeoutMs: 500, log: fakeLogger() });
    const obs = await page.observe();
    await page.press("Enter", obs);
    expect(c.sent.filter((s) => s.method === "Input.dispatchKeyEvent")).toHaveLength(2);
    pageKey = [456, "https://example.test/confirm", 0, 0, 1280, 860, []];
    await expect(page.press("Enter", obs)).rejects.toBeInstanceOf(StalePage);
    expect(c.sent.filter((s) => s.method === "Input.dispatchKeyEvent")).toHaveLength(2);
    await page.press("Enter");
    expect(c.sent.filter((s) => s.method === "Input.dispatchKeyEvent")).toHaveLength(4);
  });
});

describe("openPage readiness by document", () => {
  it("a document that never completes pays the cap once: not again in navigate then observe, nor after a pushState url change", async () => {
    let url = "https://example.test/app";
    const c = scriptedChrome((expr) => {
      if (expr === SNAPSHOT_SCRIPT) return { ...rawSnapshot(url, "interactive", "shell"), page_key: [999, url, 0, 0, 1280, 860, []] };
      if (expr === "document.readyState") return "interactive";
      if (expr === "performance.timeOrigin") return 999;
      return null;
    });
    const log = fakeLogger();
    const page = await openPage(c.chrome, { settleTimeoutMs: 150, log });
    const t0 = Date.now();
    await page.navigate(url, 150);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(log.lines.some((l) => /page not ready after 150 ms/.test(l))).toBe(true);
    const t1 = Date.now();
    const first = await page.observe();
    expect(first.url).toBe(url);
    expect(Date.now() - t1).toBeLessThan(100);
    url = "https://example.test/app#/route-2";
    const t2 = Date.now();
    const second = await page.observe();
    expect(second.url).toBe(url);
    expect(Date.now() - t2).toBeLessThan(100);
    expect(log.lines.filter((l) => /not complete after/.test(l))).toHaveLength(0);
  });
});
