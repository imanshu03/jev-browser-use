// Scripted fakes for the fast engine: Page, Chrome, and Observation builders. No Chrome and no network.
import type { Action, ActionKind, Chrome, DatePlan, EditPlan, EditResult, Observation, Page, Popup } from "../../src/fast/model.js";
import { EditRefused, StalePage } from "../../src/fast/model.js";

/** One executable action. `id` defaults to `e<n>` by position when `obs()` assigns it. */
export function el(id: string, kind: ActionKind, label: string, role: string, extra: Partial<Action> = {}): Action {
  const node = extra.node !== undefined ? extra.node : (Number(id.replace(/\D/g, "")) || null);
  return { id, kind, node, role, label, ...extra };
}

export const scrollDown = (): Action => ({ id: "scroll_down", kind: "scroll", node: null, label: "Scroll down", delta: 560 });
export const scrollUp = (): Action => ({ id: "scroll_up", kind: "scroll", node: null, label: "Scroll up", delta: -560 });
export const waitAction = (): Action => ({ id: "wait", kind: "wait", node: null, label: "Wait for the page to update" });

/** Build an Observation. The fingerprint hashes url, text, and the action ids and labels. */
export function obs(url: string, actions: Action[], text = "page", over: Partial<Observation> = {}): Observation {
  const all = [...actions, waitAction()];
  const fingerprint = `${url}|${text}|${all.map((a) => `${a.id}:${a.label}:${a.value ?? ""}`).join(",")}`;
  return {
    url, title: over.title ?? "T", text, scroll: { y: 0, height: 1000 }, w: 1120, h: 780, actions: all,
    marker: null, page_key: null, guards: {}, omitted_actions: 0, fingerprint, ms: 3, ...over,
  };
}

export interface ActCall { op: "act" | "press" | "back" | "navigate" | "commit" | "setDate"; id?: string; kind?: string; text?: string; key?: string; url?: string; edit?: EditPlan; plan?: DatePlan }

export interface PageScript {
  pages: Record<string, Observation>;
  start: string;
  /** Return a page name to move to after a call; undefined keeps the page. */
  transitions?: (call: ActCall, current: string) => string | undefined;
  /** Throw StalePage on the first `act` calls this many times. */
  staleTimes?: number;
  /** The result of a fill, or an EditRefused to throw. Undefined: the fill returns nothing (an adapter without results). */
  edits?: (call: ActCall, action: Action) => EditResult | EditRefused | undefined;
  /** The popup next to a chip field on the current page; `focus` as `Page.popup` got it. Default: closed. */
  popup?: (action: Action, current: string, focus: boolean) => Popup | null;
  /** The result of a script Enter (`commit`, recorded as op "commit"). Default: not handled. */
  commit?: (action: Action, current: string) => { prevented: boolean } | { skipped: "gone" | "focus" };
}

export interface FakePage extends Page {
  calls: ActCall[];
  /** The focus argument of each popup read. */
  popups: boolean[];
  observes: number;
  current: string;
  closed: boolean;
}

export function fakePage(script: PageScript): FakePage {
  let stale = script.staleTimes ?? 0;
  const p = {
    targetId: "t1", sessionId: "s1", calls: [] as ActCall[], popups: [] as boolean[], observes: 0, current: script.start, closed: false,
    stats: { browserMs: 0, calls: 0 },
    page(): Observation { const o = script.pages[p.current]; if (!o) throw new Error(`fake page ${p.current} missing`); return o; },
    move(call: ActCall): void {
      p.calls.push(call);
      p.stats.calls += 1;
      p.stats.browserMs += 5;
      const next = script.transitions?.(call, p.current);
      if (next !== undefined) p.current = next;
    },
    async observe() { p.observes += 1; p.stats.calls += 1; p.stats.browserMs += 2; return p.page(); },
    async fresh() { return true; },
    async act(action: Action, _obs: Observation, text?: string, edit?: EditPlan) {
      if (stale > 0) { stale -= 1; throw new StalePage("fake: page changed before input"); }
      const call: ActCall = { op: "act", id: action.id, kind: action.kind, ...(text !== undefined ? { text } : {}), ...(edit ? { edit } : {}) };
      const result = action.kind === "fill" ? script.edits?.(call, action) : undefined;
      if (result instanceof EditRefused) { if (!result.changed) throw result; p.move(call); throw result; }
      p.move(call);
      return result;
    },
    async setDate(action: Action, _obs: Observation, plan: DatePlan) {
      if (stale > 0) { stale -= 1; throw new StalePage("fake: page changed before input"); }
      p.move({ op: "setDate", id: action.id, plan });
    },
    async press(key: string) { p.move({ op: "press", key }); },
    async popup(action: Action, focus?: boolean): Promise<Popup | null> {
      p.popups.push(focus === true);
      return script.popup ? script.popup(action, p.current, focus === true) : { open: false, text: "", picks: [], busy: false };
    },
    async commit(action: Action) {
      const r = script.commit ? script.commit(action, p.current) : { prevented: false };
      p.move({ op: "commit", id: action.id });
      return r;
    },
    async navigate(url: string) { p.move({ op: "navigate", url }); },
    async back() { p.move({ op: "back" }); },
    async url() { return p.page().url; },
    async screenshot() { p.stats.calls += 1; },
    async close() { p.closed = true; },
  };
  return p as unknown as FakePage;
}

export interface FakeChrome extends Chrome { closes: number }

export function fakeChrome(): FakeChrome {
  const c = {
    closes: 0,
    client: {
      closed: false,
      async send() { return {}; },
      on() { return () => undefined; },
      async close() { c.client.closed = true; },
    },
    userDataDir: "/tmp/jev-chrome-fake", profile: { directory: null, copyDir: null, copied: false, copyMs: 0 }, launchMs: 1,
    async newTarget() { return { targetId: "t1", sessionId: "s1" }; },
    async closeTarget() { /* nothing */ },
    async close() { c.closes += 1; c.client.closed = true; },
  };
  return c as unknown as FakeChrome;
}
