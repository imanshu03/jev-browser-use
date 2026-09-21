// Shared contract of the fast engine. Types only. No logic lives here.
//
// The fast engine talks to Chrome over one Chrome DevTools Protocol (CDP) connection,
// reads the page with one in-page script, checks freshness instead of waiting, and
// asks Jev one request per step. The shape follows browser-use/jev-ultrafast (MIT).

import type { Logger } from "../io.js";

/** One CDP connection: a pipe to a Chrome we launched, or a WebSocket to a Chrome we attached to. */
export interface CdpClient {
  /** Send a CDP command. `sessionId` routes it to one target. Rejects on a CDP error. */
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  /** Subscribe to a CDP event. The handler gets the params and the session id when present. */
  on(event: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): () => void;
  /** Close the transport. Pending sends reject. */
  close(): Promise<void>;
  readonly closed: boolean;
}

export interface ChromeLaunchOptions {
  /** Browser binary and profile family. Attachment uses the existing browser. */
  browser?: "chrome" | "chromium";
  /** Show the window. `false` adds `--headless=new`. */
  headed: boolean;
  /** Chrome profile directory name inside the source user data dir, for example "Profile 14". Absent = fresh temporary profile. */
  profileDirectory?: string;
  /** Source user data dir. Default: the Chrome default for the platform. */
  sourceUserDataDir?: string;
  /** Copy the profile again even when a copy exists. */
  refreshProfile?: boolean;
  /** Attach to a running Chrome on this port instead of launching one. */
  cdpPort?: number;
  /** Chrome binary. Default: `findChrome(env)`. */
  chromeBin?: string;
  /** Per CDP command timeout. Default 30000 ms. The CLI passes `--step-timeout`. */
  commandTimeoutMs?: number;
  env: NodeJS.ProcessEnv;
  log: Logger;
}

export interface Chrome {
  readonly client: CdpClient;
  /** The user data dir Chrome runs on. `null` when attached over `cdpPort`. */
  readonly userDataDir: string | null;
  /** Where the profile came from and how long the copy took. `copied` is false when a previous copy was reused. */
  readonly profile: { directory: string | null; copyDir: string | null; copied: boolean; copyMs: number };
  readonly launchMs: number;
  /** Process id of the Chrome we launched. Absent when attached over `cdpPort`. */
  readonly pid?: number;
  /** Open a new tab on `url` and attach to it. Returns the target and session ids. */
  newTarget(url: string): Promise<{ targetId: string; sessionId: string }>;
  closeTarget(targetId: string): Promise<void>;
  /** Close every tab we own, then the browser (or only the connection when attached). Idempotent. */
  close(): Promise<void>;
}

export type ActionKind = "click" | "fill" | "select" | "scroll" | "wait";

/** One executable action the in-page script observed. `node` is the code-owned node identity, never a selector. */
export interface Action {
  id: string;                         // "e1".."e250", "scroll_down", "scroll_up", "wait"
  kind: ActionKind;
  node: number | null;                // null for document scroll and wait; panel scroll has a node
  role?: string;
  label: string;                      // accessible name, or "<name> → <option>" for a select option
  value?: string;                     // current field value or the option value for a select action
  current_value?: string;             // selected option labels for a select action
  checked?: string;
  selected?: string;
  expanded?: string;
  delta?: number;                     // scroll pixels
  rect?: { x: number; y: number; w: number; h: number };
}

export interface Observation {
  url: string;
  title: string;
  /** Visible on-screen text, at most 6000 characters, one text node per line. */
  text: string;
  scroll: { y: number; height: number };
  w: number;
  h: number;
  actions: Action[];
  /** Focus and the form submit controls used to gate Enter. */
  focus?: { node: number; label: string; role: string | null; submitLabel: string } | null;
  /** Semantic marker of the whole page. Opaque. Used by `Page.fresh`. */
  marker: unknown;
  /** Page key: URL, scroll, viewport, form values. Opaque. Used by `Page.fresh` for clicks. */
  page_key: unknown;
  /** Page key, focus, and the focused control guard. Used before keyboard input. */
  key_guard?: unknown;
  /** Per-node guard keyed by node id. Opaque. Used by `Page.fresh` for clicks and selects. */
  guards: Record<string, unknown>;
  omitted_actions: number;
  /** sha256 of url, text, actions, scroll. Two observations with the same fingerprint show the same page. */
  fingerprint: string;
  /** Milliseconds the observation took, including any post-input wait. */
  ms: number;
}

/** A decision no longer refers to the observed page. The caller observes again; nothing was executed. */
export class StalePage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StalePage";
  }
}

export interface Page {
  readonly targetId: string;
  readonly sessionId: string;
  /** Read the page with one in-page evaluation. Waits first for any pending post-input settle (2 animation frames or 50 ms; 200 ms for a combobox). Retries while the document is navigating, up to `settleTimeoutMs`. */
  observe(): Promise<Observation>;
  /** True when the page still matches `obs`. With a click, fill, or select action, compares the page key and that node's guard only. With a scroll action, the page key only. Without an action, the whole marker. */
  fresh(obs: Observation, action?: Action): Promise<boolean>;
  /** Execute one observed action. Rechecks freshness, visibility, geometry, and occlusion right before input. Throws StalePage when anything changed; nothing is executed then. `text` is required for a fill. */
  act(action: Action, obs: Observation, text?: string): Promise<void>;
  /** Press one key on the focused element (for example "Enter", "Escape"). With `obs`, throws StalePage when the page key no longer matches the observation; nothing is pressed then. */
  press(key: string, obs?: Observation): Promise<void>;
  /** Navigate the tab and wait for document.readyState === "complete", polling every 20 ms, up to `timeoutMs`. */
  navigate(url: string, timeoutMs: number): Promise<void>;
  /** History back, then the same readiness wait. */
  back(timeoutMs: number): Promise<void>;
  url(): Promise<string>;
  /** Save a JPEG screenshot. */
  screenshot(path: string): Promise<void>;
  /** Close this tab. Idempotent. */
  close(): Promise<void>;
  /** Milliseconds spent inside browser calls and settle waits, and the number of CDP commands. */
  readonly stats: { browserMs: number; calls: number };
}

export interface PageOptions {
  /** Cap for the navigation readiness wait and for the observe retry loop. */
  settleTimeoutMs: number;
  log: Logger;
}

/** History entry sent to Jev as `recent_actions` (first four fields) and kept for loop control. */
export interface FastHistoryEntry {
  action: string;                     // the action label, or the operation name for scroll, wait, key, back
  kind: string;                       // click | fill | select | scroll | wait | key | back | open
  text: string | null;                // typed text, redacted when secret
  page_changed: boolean | null;
  step: number;
  url: string;
  operation: string;
}
