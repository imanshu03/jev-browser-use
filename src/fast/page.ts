// One tab of the fast engine: observe, check freshness, act, navigate. Pure I/O. No decisions.
//
// Ported from browser-use/jev-ultrafast (jev_ultrafast/browser.py). MIT License.
// Copyright (c) 2026 Browser Use.
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Action, Chrome, EditMode, EditPlan, EditResult, Observation, Page, PageOptions, Popup } from "./model.js";
import { LIMITS } from "../types.js";
import { EditRefused, StalePage } from "./model.js";
import type { EditStep } from "./snapshot.js";
import { CAUSAL_END_SCRIPT, DOC_ID_SCRIPT, EDIT_SETTLE_SCRIPT, KEY_GUARD_SCRIPT, LOCATION_SCRIPT, MARKER_SCRIPT, PAGE_KEY_SCRIPT, READY_STATE_SCRIPT, SNAPSHOT_SCRIPT, actScript, causalArmScript, causalStateScript, commitScript, editScript, pageKeyGuardScript, popupScript, settleScript } from "./snapshot.js";

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

/**
 * Inputs whose settle follows the work that they start: the timers in the page (`causalArmScript`) and the requests
 * over CDP. A key press is always one of them. A scroll and a select keep the frame settle.
 */
const CAUSAL_KINDS: ReadonlySet<string> = new Set(["fill", "click"]);

/** Request types that the causal settle waits for. A document counts only in the main frame: a navigation. */
const COUNTED_REQUESTS: ReadonlySet<string> = new Set(["Fetch", "XHR"]);

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

/** Whitespace runs become one space; zero-width characters go. For the compare of a field value after a fill. */
const flat = (s: string): string => s.replace(/[\u200B\uFEFF]/g, "").replace(/\s+/g, " ").trim();

/** The lines of a text that a document fill types: each line with text, in order. */
export function textLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "");
}

/** Alerts and beforeunload prompts are accepted; confirm and prompt dialogs are dismissed, as the legacy engine does. */
export function dialogAccepts(type: unknown): boolean {
  return type === "alert" || type === "beforeunload";
}

export async function openPage(chrome: Chrome, opts: PageOptions): Promise<Page> {
  const { targetId, sessionId } = await chrome.newTarget("about:blank");
  const client = chrome.client;
  const stats = { browserMs: 0, calls: 0 };
  let pendingSettle: Action | null | undefined; // undefined = nothing pending; null = generic settle
  /** The pending settle is causal: the input armed the tracker in the page. */
  let causalPending = false;
  /**
   * The requests of the causal settle. The Network domain is on only from the arm to the end of the settle, and only
   * the requests that start in that time count. `ended`: a counted request ended since the last check.
   */
  const net = { on: false, armed: false, requests: new Set<string>(), ended: false };
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
  const offRequest = client.on("Network.requestWillBeSent", (params, sid) => {
    if (sid !== sessionId || !net.armed) return;
    const type = String(params["type"] ?? "");
    if (COUNTED_REQUESTS.has(type) || (type === "Document" && params["frameId"] === targetId)) net.requests.add(String(params["requestId"]));
  });
  const ended = (params: Record<string, unknown>, sid?: string): void => {
    if (sid === sessionId && net.requests.delete(String(params["requestId"]))) net.ended = true;
  };
  const offFinished = client.on("Network.loadingFinished", ended);
  const offFailed = client.on("Network.loadingFailed", ended);

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

  /**
   * Arm the causal settle right before an input: the Network domain goes on, and the page tracks new timers. `node` is
   * the field of a fill. When the page does not arm (a document that is going away), the frame settle runs instead.
   */
  async function arm(node: number | null): Promise<void> {
    if (!net.on) {
      try {
        // The settle reads request events only. Chrome keeps no bodies for them.
        await call("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 });
        net.on = true;
      } catch (e) {
        if (client.closed) throw e;
        opts.log.debug(`settle without request tracking: ${(e as Error).message}`);
      }
    }
    net.requests.clear();
    net.ended = false;
    net.armed = true;
    const r = await evaluate(causalArmScript(node));
    causalPending = !r.exception && r.value === true;
    if (!causalPending) net.armed = false;
  }

  /**
   * The causal settle: two frames, then a check every `causalPollMs` until the timers that the input started ran, the
   * requests that started since the arm ended, their follow windows closed, and no new busy marker shows. A busy marker
   * alone holds the settle for at most `causalBusyMs`: a long job (a draft, a streamed reply) keeps its marker. Then two
   * frames for the last render. At most `causalCapMs`. A document without the armed tracker (a navigation) ends the
   * wait: the readiness poll of `observe` takes over.
   */
  async function causalSettle(): Promise<void> {
    const start = Date.now();
    let busySince: number | null = null;
    try {
      await evaluate(settleScript(null), true);
      for (let close = true; ; close = false) {
        const extend = net.ended;
        net.ended = false;
        const r = await evaluate(causalStateScript(close, extend));
        const s = r.value as { pending: number; follow: number; busy: boolean } | null;
        if (r.exception || s === null || typeof s !== "object") break;
        const working = s.pending > 0 || s.follow > 0 || net.requests.size > 0 || net.ended;
        if (!working && !s.busy) break;
        busySince = working ? null : busySince ?? Date.now();
        if (busySince !== null && Date.now() - busySince >= LIMITS.causalBusyMs) break;
        if (Date.now() - start >= LIMITS.causalCapMs) {
          opts.log.debug(`settle stopped at the ${LIMITS.causalCapMs} ms cap: ${s.pending} timers, ${net.requests.size} requests${s.busy ? ", busy" : ""}`);
          break;
        }
        await settleSleep(LIMITS.causalPollMs);
      }
    } finally {
      net.armed = false;
      net.requests.clear();
      net.ended = false;
      if (net.on) {
        net.on = false;
        await call("Network.disable").catch((e: Error) => { if (client.closed) throw e; });
      }
      await evaluate(CAUSAL_END_SCRIPT);
    }
    await evaluate(settleScript(null), true);
  }

  /** The settle of an input now, not at the next observe: the causal settle when the arm held, else the frame settle. */
  async function settleNow(): Promise<void> {
    if (causalPending) {
      causalPending = false;
      await causalSettle();
    } else await evaluate(settleScript(null), true);
  }

  /** Wait for the editor between two steps of a fill (EDIT_SETTLE_SCRIPT). */
  async function settleEdit(): Promise<void> {
    await evaluate(EDIT_SETTLE_SCRIPT, true);
  }

  /**
   * One browser editing command on the focused field, carried by a key event that no page handler knows
   * ("Unidentified"). The page never sees Mod+A, End, or Enter: an editor cannot turn them into a block selection
   * that moves focus to a hidden input (Plate), a send (a chat composer), or a dropped insert (Lexical). The browser
   * runs the command and fires beforeinput as it does for a person. Then the editor settles.
   */
  async function command(name: string): Promise<void> {
    await call("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Unidentified", code: "", windowsVirtualKeyCode: 0, commands: [name] });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Unidentified", code: "", windowsVirtualKeyCode: 0 });
    await settleEdit();
  }

  /** One step of a fill (`editScript`). A document that went away: StalePage before the first insert, else EditRefused. */
  async function editStep(node: number, step: "read" | "check" | "blank", mode: EditMode, keep: string[], typed: boolean): Promise<EditStep> {
    const r = await evaluate(editScript(node, step, mode, keep));
    if (r.exception || !r.value || typeof r.value !== "object") {
      if (typed) throw new EditRefused("the page changed during the fill", true);
      throw new StalePage("Document changed during the fill. Observe again.");
    }
    return r.value as EditStep;
  }

  /**
   * Type `text` into the field that the click focused, as `plan` says. Each step settles. Before any text goes in, focus
   * must be on the field and the selection where the mode needs it: the text never goes into another element, such as
   * a hidden input that took focus. An empty field is replaced. An append joins by the field shape (`FieldShape`).
   * Throws EditRefused with the reason; without `changed`, nothing was typed.
   */
  async function editField(node: number, text: string, plan: EditPlan): Promise<EditResult> {
    await settleEdit();
    const read = await editStep(node, "read", plan.mode, [], false);
    if (!read.ok) throw new EditRefused(`the fill did not start: ${read.why}`);
    const shape = read.shape ?? (read.kind === "editable" ? "composer" : read.kind);
    const mode: EditMode = read.blank ? "replace" : plan.mode;
    // A line break can send in a composer. Refuse before any change.
    if (mode === "append" && shape === "composer" && /\n/.test(text)) throw new EditRefused("the text has line breaks, and a new line can send the message in this field");
    await command(mode === "replace" ? "selectAll" : "moveToEndOfDocument");
    const ready = await editStep(node, "check", mode, [], false);
    if (!ready.ok) throw new EditRefused(`the fill did not start: ${ready.why}`);
    if (shape === "document" && (mode === "append" || /\n/.test(text))) {
      // A document takes one block per line. A line break inside insertText makes a soft break (Plate) or drops the
      // text after it (Lexical), so each line after the first goes into a new block.
      const lines = textLines(text);
      const keep = mode === "append" ? textLines(read.text) : [];
      for (let i = 0; i < lines.length; i++) {
        if (i > 0 || (mode === "append" && !ready.caretBlank)) {
          await command("insertParagraph");
          const blank = await editStep(node, "blank", mode, keep, true);
          if (!blank.ok) throw new EditRefused(`the fill stopped after a new line: ${blank.why}`, true);
        }
        await call("Input.insertText", { text: lines[i] as string });
        if (i < lines.length - 1) { keep.push(lines[i] as string); await settleEdit(); }
      }
    } else {
      let typed = text;
      if (mode === "append") {
        if (shape === "textarea") typed = (/\n\s*$/.test(read.text) ? "" : "\n") + text;
        else if (!ready.caretBlank && !ready.spaceBefore) typed = " " + text;
      }
      await call("Input.insertText", { text: typed });
    }
    await settleEdit();
    const after = await editStep(node, "read", mode, [], true);
    // An input without a selection API (email, number) had no selection check. Its value must be the text now.
    if (ready.selectable === false && mode === "replace" && !read.blank && flat(after.text) !== flat(text)) {
      throw new EditRefused(`the field shows "${flat(after.text).slice(0, 60)}" after the fill, not the typed text`, true);
    }
    return { mode, shape, before: read.text, after: after.text };
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
        const causal = causalPending;
        pendingSettle = undefined;
        causalPending = false;
        if (causal) await causalSettle();
        else await evaluate(settleScript(action), true);
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

    async act(action, obs, text, edit) {
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
        if (CAUSAL_KINDS.has(action.kind)) await arm(action.kind === "fill" ? action.node : null);
        await mouse("mouseMoved", x, y);
        await mouse("mousePressed", x, y, { button: "left", clickCount: 1 });
        await mouse("mouseReleased", x, y, { button: "left", clickCount: 1 });
        if (action.kind === "fill") {
          // The next observe settles after the fill, also when the fill stopped part way.
          pendingSettle = action;
          return await editField(action.node, text as string, edit ?? { mode: "replace" });
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
      await arm(null);
      await call("Input.dispatchKeyEvent", { ...base, type: "keyDown", ...(def.text !== undefined ? { text: def.text, unmodifiedText: def.text } : {}) });
      await call("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
      pendingSettle = null;
    },

    async popup(action, focus) {
      if (typeof action.node !== "number") return null;
      const read = async (move: boolean): Promise<Popup | null> => {
        const r = await evaluate(popupScript(action, move));
        return r.exception || r.value === null ? null : (r.value as Popup);
      };
      // The observation of the decision settled after the last input, so one read is enough. Focus is an input: a page
      // can open the popup or start a search on it. The causal settle follows it, as it follows a click; then read again.
      if (focus !== true) return read(false);
      await arm(null);
      const first = await read(true);
      await settleNow();
      return first === null ? null : read(false);
    },

    async commit(action, obs) {
      // The key goes to the field the decision saw: same document, URL, values, and the same field guard.
      if (!(await page.fresh(obs, action))) throw new StalePage("Field changed since this decision. Observe again.");
      // The widget adds the chip in its key handler and can then search or render late: the causal settle follows.
      await arm(null);
      const r = await evaluate(commitScript(action));
      const res = r.exception || r.value === null || typeof r.value !== "object" ? null : (r.value as { prevented: boolean } | { skipped: "gone" | "focus" });
      if (res !== null && "prevented" in res) {
        pendingSettle = null;
        return res;
      }
      // No key went out: the arm ends here, not at the next observe.
      await settleNow();
      if (res === null) throw new StalePage("Document changed during evaluation");
      return res;
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
      offRequest();
      offFinished();
      offFailed();
      await chrome.closeTarget(targetId);
    },
  };
  return page;
}
