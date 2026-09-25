// One tab of the fast engine: observe, check freshness, act, navigate. Pure I/O. No decisions.
//
// Ported from browser-use/jev-ultrafast (jev_ultrafast/browser.py). MIT License.
// Copyright (c) 2026 Browser Use.
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Action, Chrome, Observation, Page, PageOptions, Popup } from "./model.js";
import { StalePage } from "./model.js";
import { DOC_ID_SCRIPT, KEY_GUARD_SCRIPT, LOCATION_SCRIPT, MARKER_SCRIPT, PAGE_KEY_SCRIPT, READY_STATE_SCRIPT, SNAPSHOT_SCRIPT, actScript, commitScript, pageKeyGuardScript, popupScript, settleScript } from "./snapshot.js";

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Escape: { code: "Escape", vk: 27 },
  Tab: { code: "Tab", vk: 9 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  PageDown: { code: "PageDown", vk: 34 },
  PageUp: { code: "PageUp", vk: 33 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Space: { code: "Space", vk: 32, text: " " },
};

/** JSON with keys sorted at every level. The fingerprint must not depend on key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}

/** sha256 of url, text, actions without geometry, and scroll. */
export function fingerprintOf(state: { url: string; text: string; actions: Action[]; scroll: { y: number; height: number } }): string {
  const actions = state.actions.map((a) => {
    const { rect: _rect, ...rest } = a;
    return rest;
  });
  return createHash("sha256").update(stableStringify({ url: state.url, text: state.text, actions, scroll: state.scroll })).digest("hex");
}

type RawSnapshot = Omit<Observation, "fingerprint" | "ms"> & { readyState?: string };

/**
 * A Runtime.evaluate error that means "the document went away under the script". The page is
 * navigating; the caller polls again. Every other CDP error (timeout, closed connection, dead
 * session, crashed target) is a browser failure and propagates.
 */
const CONTEXT_GONE = /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed|Execution context is not available|uniqueContextId not found/i;

/** The identity of the document a snapshot came from: the first page key entry (performance.timeOrigin), else the URL. */
function docIdOf(raw: RawSnapshot): unknown {
  return Array.isArray(raw.page_key) && raw.page_key.length > 0 ? raw.page_key[0] : raw.url;
}

/** Alerts and beforeunload prompts are accepted; confirm and prompt dialogs are dismissed, as the legacy engine does. */
export function dialogAccepts(type: unknown): boolean {
  return type === "alert" || type === "beforeunload";
}

export async function openPage(chrome: Chrome, opts: PageOptions): Promise<Page> {
  const { targetId, sessionId } = await chrome.newTarget("about:blank");
  const client = chrome.client;
  const stats = { browserMs: 0, calls: 0 };
  const modifiers = process.platform === "darwin" ? 4 : 2;
  let pendingSettle: Action | null | undefined; // undefined = nothing pending; null = generic settle
  let closed = false;
  /** Identity of a document that stayed below readyState "complete" until the cap. The next observe on it does not wait again. */
  let acceptedDoc: { id: unknown } | null = null;
  const accepted = (id: unknown): boolean => acceptedDoc !== null && acceptedDoc.id === id;

  // A JavaScript dialog blocks the renderer: no input event and no evaluation answers while it is open.
  // Answer it at once so a click that opens alert() or confirm() cannot hang the run.
  const offDialog = client.on("Page.javascriptDialogOpening", (params, sid) => {
    if (sid !== sessionId) return;
    const type = params["type"];
    const accept = dialogAccepts(type);
    const message = String(params["message"] ?? "").replace(/\s+/g, " ").slice(0, 200);
    opts.log.warn(`dialog ${String(type)} ${accept ? "accepted" : "dismissed"}: ${message}`);
    call("Page.handleJavaScriptDialog", { accept }).catch((e: Error) => opts.log.debug(`dialog not handled: ${e.message}`));
  });

  async function call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const start = Date.now();
    stats.calls += 1;
    try {
      return await client.send(method, params, sessionId);
    } finally {
      stats.browserMs += Date.now() - start;
    }
  }

  async function settleSleep(ms: number): Promise<void> {
    const start = Date.now();
    await new Promise<void>((r) => setTimeout(r, ms));
    stats.browserMs += Date.now() - start;
  }

  /**
   * Evaluate in the page. `exception` is true when the page threw or the context went away
   * (the document is navigating). A transport error, a timeout, or a dead target propagates.
   */
  async function evaluate(expression: string, awaitPromise = false): Promise<{ value: unknown; exception: boolean }> {
    try {
      const res = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
      if (res["exceptionDetails"]) return { value: null, exception: true };
      const result = res["result"] as { value?: unknown } | undefined;
      return { value: result?.value ?? null, exception: false };
    } catch (e) {
      if (client.closed) throw e;
      if (CONTEXT_GONE.test(String((e as Error)?.message ?? e))) return { value: null, exception: true };
      throw e;
    }
  }

  async function waitReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await evaluate(READY_STATE_SCRIPT);
      if (!r.exception && r.value === "complete") return;
      await settleSleep(20);
    }
    opts.log.warn(`page not ready after ${timeoutMs} ms; continuing`);
    // The document is accepted as it is. The next observe on it does not pay the cap again.
    const id = await evaluate(DOC_ID_SCRIPT);
    if (!id.exception && id.value !== null) acceptedDoc = { id: id.value };
  }

  /** Compare the page key with the observation's. False on any evaluation exception. */
  async function freshKey(obs: Observation): Promise<boolean> {
    const r = await evaluate(PAGE_KEY_SCRIPT);
    if (r.exception) return false;
    return JSON.stringify(r.value) === JSON.stringify(obs.page_key);
  }

  async function mouse(type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<void> {
    await call("Input.dispatchMouseEvent", { type, x, y, ...extra });
  }

  const page: Page = {
    targetId,
    sessionId,
    stats,

    async navigate(url, timeoutMs) {
      const res = await call("Page.navigate", { url });
      if (typeof res["errorText"] === "string" && res["errorText"]) throw new Error(`navigation failed: ${res["errorText"]}`);
      await waitReady(timeoutMs);
    },

    async observe() {
      const start = Date.now();
      if (pendingSettle !== undefined) {
        const action = pendingSettle;
        pendingSettle = undefined;
        await evaluate(settleScript(action), true);
      }
      const deadline = start + opts.settleTimeoutMs;
      let polls = 0;
      for (;;) {
        const r = await evaluate(SNAPSHOT_SCRIPT);
        if (!r.exception && r.value !== null && typeof r.value === "object") {
          const raw = r.value as RawSnapshot;
          const { readyState, ...rest } = raw;
          // A click can start a navigation. The new document is readable before its scripts ran and its layout
          // is final. Poll every 20 ms until readyState is "complete", up to the cap, once per document.
          const loading = readyState !== undefined && readyState !== "complete";
          const doc = docIdOf(raw);
          if (loading && !accepted(doc) && Date.now() < deadline) {
            polls += 1;
            await settleSleep(20);
            continue;
          }
          if (loading) { if (!accepted(doc)) opts.log.warn(`page ${raw.url} not complete after ${opts.settleTimeoutMs} ms; observing it as is`); acceptedDoc = { id: doc }; }
          else acceptedDoc = null;
          if (polls > 0) opts.log.debug(`observe waited ${polls} polls for readyState complete on ${raw.url}`);
          return { ...rest, fingerprint: fingerprintOf(raw), ms: Date.now() - start };
        }
        if (Date.now() >= deadline) throw new StalePage("Page did not settle");
        await settleSleep(20);
      }
    },

    async fresh(obs, action) {
      // A click, fill, or select compares the page key and the target's guard. The guard carries the
      // node's value, state, and the text of its form, dialog, or row. Live text elsewhere (a clock,
      // a ticker, a changing title) does not make the decision stale.
      if (action && (action.kind === "click" || action.kind === "fill" || action.kind === "select")) {
        if (typeof action.node !== "number") return false;
        const r = await evaluate(pageKeyGuardScript(action.node));
        if (r.exception) return false;
        return JSON.stringify(r.value) === JSON.stringify([obs.page_key, obs.guards[String(action.node)] ?? null]);
      }
      // A scroll compares the page key: document, URL, scroll position, viewport, and form values.
      if (action && action.kind === "scroll") return freshKey(obs);
      const r = await evaluate(MARKER_SCRIPT);
      if (r.exception) return false;
      return JSON.stringify(r.value) === JSON.stringify(obs.marker);
    },

    async act(action, obs, text) {
      // A wait has no target and changes nothing. A page that keeps updating must not turn it into stale retries.
      if (action.kind === "wait") {
        await settleSleep(100);
        return;
      }
      if (!(await page.fresh(obs, action))) throw new StalePage("Page changed since this decision. Observe again.");
      if (action.kind === "scroll") {
        if (action.node !== null) {
          const r = await evaluate(actScript(action));
          if (r.exception || !r.value) throw new StalePage("Scroll panel changed or is covered. Observe again.");
        } else {
          await mouse("mouseWheel", Math.round(obs.w / 2), Math.round(obs.h * 0.8), { deltaX: 0, deltaY: action.delta ?? 560 });
        }
        pendingSettle = action;
        return;
      }
      if (typeof action.node !== "number") throw new StalePage("Invalid observed node");
      if (action.kind === "fill" && typeof text !== "string") throw new Error("a fill needs text");
      const r = await evaluate(actScript(action));
      if (r.exception) {
        if (action.kind === "select") throw new Error("Dropdown execution was interrupted; observe before retrying.");
        throw new StalePage("Document changed during evaluation");
      }
      const target = r.value as { x: number; y: number } | null;
      if (!target) throw new StalePage("Target changed or is covered. Observe again.");
      if (action.kind !== "select") {
        const { x, y } = target;
        await mouse("mouseMoved", x, y);
        await mouse("mousePressed", x, y, { button: "left", clickCount: 1 });
        await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
        if (action.kind === "fill") {
          await call("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers, commands: ["selectAll"] });
          await call("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers });
          await call("Input.insertText", { text: text as string });
        }
      }
      pendingSettle = action;
    },

    async press(key, obs) {
      const def = KEYS[key];
      if (!def) throw new Error(`unsupported key: ${key}`);
      // The key goes to whatever document and focused element exist now. Check that they are the
      // ones the decision saw: same document, URL, scroll, viewport, and form values.
      if (obs) {
        const guard = obs.key_guard === undefined ? null : await evaluate(KEY_GUARD_SCRIPT);
        const fresh = guard ? !guard.exception && JSON.stringify(guard.value) === JSON.stringify(obs.key_guard) : await freshKey(obs);
        if (!fresh) throw new StalePage("Page or focus changed since this decision. Observe again.");
      }
      const base: Record<string, unknown> = { key, code: def.code, windowsVirtualKeyCode: def.vk, nativeVirtualKeyCode: def.vk };
      await call("Input.dispatchKeyEvent", { ...base, type: "keyDown", ...(def.text !== undefined ? { text: def.text, unmodifiedText: def.text } : {}) });
      await call("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
      pendingSettle = null;
    },

    async popup(action, focus) {
      if (typeof action.node !== "number") return null;
      const r = await evaluate(popupScript(action, focus === true));
      return r.exception || r.value === null ? null : (r.value as Popup);
    },

    async commit(action, obs) {
      // The key goes to the field the decision saw: same document, URL, values, and the same field guard.
      if (!(await page.fresh(obs, action))) throw new StalePage("Field changed since this decision. Observe again.");
      const r = await evaluate(commitScript(action));
      if (r.exception || r.value === null || typeof r.value !== "object") throw new StalePage("Document changed during evaluation");
      pendingSettle = null;
      return r.value as { prevented: boolean } | { skipped: "gone" | "focus" };
    },

    async back(timeoutMs) {
      const history = await call("Page.getNavigationHistory");
      const index = typeof history["currentIndex"] === "number" ? history["currentIndex"] : 0;
      const entries = Array.isArray(history["entries"]) ? (history["entries"] as { id: number }[]) : [];
      if (index <= 0) return;
      const previous = entries[index - 1];
      if (!previous) return;
      await call("Page.navigateToHistoryEntry", { entryId: previous.id });
      await waitReady(timeoutMs);
    },

    async url() {
      const r = await evaluate(LOCATION_SCRIPT);
      return typeof r.value === "string" ? r.value : "";
    },

    async screenshot(path) {
      const res = await call("Page.captureScreenshot", { format: "jpeg", quality: 72 });
      fs.writeFileSync(path, Buffer.from(String(res["data"] ?? ""), "base64"));
    },

    async close() {
      if (closed) return;
      closed = true;
      offDialog();
      await chrome.closeTarget(targetId);
    },
  };
  return page;
}
