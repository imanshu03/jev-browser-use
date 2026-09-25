// Unit tests for openPage over a fake CDP client. No Chrome and no network.
import { describe, expect, it } from "vitest";
import type { CdpClient, Chrome } from "../../src/fast/model.js";
import { StalePage } from "../../src/fast/model.js";
import { openPage } from "../../src/fast/page.js";
import { CAUSAL_END_SCRIPT, SNAPSHOT_SCRIPT, causalArmScript } from "../../src/fast/snapshot.js";
import { LIMITS } from "../../src/types.js";
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

describe("openPage causal settle", () => {
  const key = [123, "https://example.test/search", 0, 0, 1280, 860, []];
  const guard = [7, "searchbox", "Search", "", null, null, false, false, null, null, null, null, null, "Search"];
  const snap = { ...rawSnapshot("https://example.test/search", "complete", "rows"), page_key: key, guards: { "7": guard }, marker: null };
  const fill = { id: "e1", kind: "fill" as const, node: 7, role: "searchbox", label: "Search", value: "" };
  type State = { pending: number; follow: number; busy: boolean } | null;

  /**
   * A page whose tracker answers `states` in order (the last one repeats). `onState(n)` runs at the n-th check, before
   * the answer: a test emits request events there.
   */
  function tracked(states: State[], onState: (n: number, emit: (event: string, params: Record<string, unknown>, sid?: string) => void) => void = () => undefined) {
    let checks = 0;
    const exprs: string[] = [];
    const c = scriptedChrome((expr) => {
      exprs.push(expr);
      if (expr === SNAPSHOT_SCRIPT) return snap;
      if (/c\.guard\(c\.nodes\.get\(7\)\)/.test(expr)) return [key, guard];
      if (/c\.pageKey\(\)/.test(expr)) return key;
      if (/__jevFast\?\.nodes\.get\(action\.node\)/.test(expr)) return { x: 10, y: 10 };
      if (expr === causalArmScript(7) || expr === causalArmScript(null)) return true;
      if (expr.startsWith("((close,extend)")) {
        checks += 1;
        onState(checks, (event, params, sid = "s1") => c.client.emit(event, params, sid));
        return states.length > 1 ? states.shift() : states[0];
      }
      if (expr === CAUSAL_END_SCRIPT) return true;
      return null;
    });
    return { c, exprs, checks: () => checks };
  }
  const idle: State = { pending: 0, follow: 0, busy: false };
  const methods = (c: ReturnType<typeof scriptedChrome>) => c.sent.map((s) => s.method === "Runtime.evaluate" ? (String(s.params["expression"]).startsWith("((close,extend)") ? "state" : s.params["expression"] === CAUSAL_END_SCRIPT ? "end" : String(s.params["expression"]).includes("__jevCausal={") ? "arm" : "eval") : s.method);

  it("a fill turns Network on and arms the tracker before the mouse events; the settle ends when the tracker is idle, then Network goes off", async () => {
    const t = tracked([{ pending: 1, follow: 0, busy: false }, { pending: 0, follow: 30, busy: false }, idle]);
    const page = await openPage(t.c.chrome, { settleTimeoutMs: 500, log: fakeLogger() });
    const obs = await page.observe();
    await page.act(fill, obs, "roadmap");
    const order = methods(t.c);
    expect(order.indexOf("Network.enable")).toBeLessThan(order.indexOf("arm"));
    expect(order.indexOf("arm")).toBeLessThan(order.indexOf("Input.dispatchMouseEvent"));
    expect(t.c.sent.find((s) => s.method === "Network.enable")?.params).toEqual({ maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 });
    await page.observe();
    expect(t.checks()).toBe(3);
    // The first check closes the input window; no request ended, so no check extends it.
    expect(t.exprs.filter((e) => e.startsWith("((close,extend)")).map((e) => e.match(/\((true|false),(true|false)\)$/)?.[0])).toEqual(["(true,false)", "(false,false)", "(false,false)"]);
    const after = methods(t.c).slice(order.length);
    expect(after.filter((m) => m !== "eval")).toEqual(["state", "state", "state", "Network.disable", "end"]);
  });

  it("a Fetch or XHR request that starts after the arm holds the settle until it ends; its end opens a follow window", async () => {
    let finishedAt = 0;
    const t = tracked([idle], (n, emit) => {
      if (n === 1) {
        emit("Network.requestWillBeSent", { requestId: "r1", type: "Fetch", frameId: "t1" });
        emit("Network.requestWillBeSent", { requestId: "r2", type: "Image", frameId: "t1" });
        emit("Network.requestWillBeSent", { requestId: "r3", type: "XHR", frameId: "t1" }, "s2");
      }
      if (n === 3) { emit("Network.loadingFinished", { requestId: "r1" }); finishedAt = n; }
    });
    const page = await openPage(t.c.chrome, { settleTimeoutMs: 500, log: fakeLogger() });
    const obs = await page.observe();
    await page.act(fill, obs, "roadmap");
    await page.observe();
    expect(finishedAt).toBe(3);
    // Checks 1-3 see the request in flight; it ends during check 3. Check 4 opens the follow window for the response
    // handler (this fake tracker then answers idle).
    expect(t.checks()).toBe(4);
    expect(t.exprs.filter((e) => e.startsWith("((close,extend)")).map((e) => e.endsWith("(false,true)"))).toEqual([false, false, false, true]);
  });

  it("a document request of the main frame counts (a navigation); a request before the arm does not", async () => {
    const t = tracked([idle], (n, emit) => { if (n === 1) emit("Network.requestWillBeSent", { requestId: "d1", type: "Document", frameId: "t1" }); if (n === 2) emit("Network.loadingFailed", { requestId: "d1" }); });
    const page = await openPage(t.c.chrome, { settleTimeoutMs: 500, log: fakeLogger() });
    t.c.client.emit("Network.requestWillBeSent", { requestId: "early", type: "Fetch", frameId: "t1" }, "s1");
    const obs = await page.observe();
    await page.press("Enter", obs);
    await page.observe();
    expect(t.checks()).toBe(3);
  });

  it("a document without the armed tracker (a navigation) ends the settle at the first check", async () => {
    const t = tracked([null]);
    const page = await openPage(t.c.chrome, { settleTimeoutMs: 500, log: fakeLogger() });
    const obs = await page.observe();
    await page.press("Enter", obs);
    const t0 = Date.now();
    await page.observe();
    expect(Date.now() - t0).toBeLessThan(200);
    expect(t.checks()).toBe(1);
    expect(methods(t.c)).toContain("Network.disable");
  });

  it("work that never ends stops at the cap", async () => {
    const t = tracked([{ pending: 1, follow: 0, busy: true }]);
    const log = fakeLogger();
    const page = await openPage(t.c.chrome, { settleTimeoutMs: 500, log });
    const obs = await page.observe();
    await page.act(fill, obs, "roadmap");
    const t0 = Date.now();
    const after = await page.observe();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(LIMITS.causalCapMs);
    expect(Date.now() - t0).toBeLessThan(LIMITS.causalCapMs + 500);
    expect(after.ms).toBeGreaterThanOrEqual(LIMITS.causalCapMs);
    expect(log.lines.some((l) => l.includes(`settle stopped at the ${LIMITS.causalCapMs} ms cap: 1 timers, 0 requests, busy`))).toBe(true);
  });

  it("a busy marker alone holds the settle for causalBusyMs, not until the cap", async () => {
    const t = tracked([{ pending: 1, follow: 0, busy: true }, { pending: 0, follow: 0, busy: true }]);
    const page = await openPage(t.c.chrome, { settleTimeoutMs: 500, log: fakeLogger() });
    const obs = await page.observe();
    await page.act(fill, obs, "roadmap");
    const t0 = Date.now();
    await page.observe();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(LIMITS.causalBusyMs);
    expect(Date.now() - t0).toBeLessThan(LIMITS.causalBusyMs + 400);
  });

  it("a scroll and a select keep the frame settle; a key press arms before keyDown; a Network error leaves the timer tracking on", async () => {
    const t = tracked([idle]);
    const page = await openPage(t.c.chrome, { settleTimeoutMs: 500, log: fakeLogger() });
    const obs = await page.observe();
    await page.act({ id: "scroll_down", kind: "scroll", node: null, label: "Scroll down", delta: 560 }, obs);
    await page.observe();
    expect(methods(t.c)).not.toContain("arm");
    await page.press("Enter", obs);
    const order = methods(t.c);
    expect(order.indexOf("arm")).toBeLessThan(order.indexOf("Input.dispatchKeyEvent"));
    await page.observe();
    expect(t.checks()).toBe(1);
    const failing = tracked([idle]);
    const send = failing.c.client.send.bind(failing.c.client);
    failing.c.client.send = async (method, params, sid) => { if (method === "Network.enable") throw cdpError("Network.enable failed"); return send(method, params, sid); };
    const log = fakeLogger();
    const p2 = await openPage(failing.c.chrome, { settleTimeoutMs: 500, log });
    const o2 = await p2.observe();
    await p2.act(fill, o2, "roadmap");
    await p2.observe();
    expect(failing.checks()).toBe(1);
    expect(methods(failing.c)).not.toContain("Network.disable");
    expect(log.lines.some((l) => l.includes("settle without request tracking: Network.enable failed"))).toBe(true);
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
