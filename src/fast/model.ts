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
  // Field facts for assistant-written text. Set by the snapshot; never sent to Jev.
  form?: number | null;               // identity(e.form || e.closest('form,[role="form"],dialog,[role="dialog"]'))
  multiline?: boolean;                // TEXTAREA, isContentEditable, or aria-multiline="true"
  maxLength?: number;                 // INPUT/TEXTAREA maxLength when > 0
  inputType?: string;                 // INPUT type, lowercased; absent for other tags
  autocomplete?: string;              // autocomplete attribute, lowercased, when set
  token?: TokenFacts;                 // chip facts of a single-line text input; fill actions only
}

/**
 * The chip (token) facts of a single-line text input: a recipients, participants, or tags field that adds each typed
 * value as a chip. Set by the snapshot; never sent to Jev. The field's own box is the highest ancestor, up to 3 levels
 * up, that holds no other field and no send or submit control, and that does not go past a table cell. A textarea, a
 * contenteditable, an aria-multiline field, and a field without such a box have no facts.
 */
export interface TokenFacts {
  /**
   * The elements before the field in its box, nearest last, at most 20: the item id (items have their own counter), the
   * text (text nodes without the remove control, then title, aria-label, and value-like data-* attributes; at most 200
   * characters), and the remove control: 2 for a remove name or a library tag marker, 1 for an icon-only button, 0 for
   * none, a label, or the field's own name.
   */
  items: [number, string, number][];
  /** The chip shape (weak evidence): the texts of the items with a named remove control, or an icon-only one on a combobox. */
  chips: string[];
  /** A combobox whose controlled listbox is aria-multiselectable (strong evidence). */
  multi?: true;
  /** A popup next to the field is open (the element that it controls, a listbox, menu, or dialog at its box, or a positioned list after it in its box), or the field is aria-expanded. */
  popup?: true;
  /** Set by the loop, never by the page: this run saw the field add a value as a chip (strong evidence). */
  learned?: true;
}

/** The popup next to a chip field, as `Page.popup` reads it. */
export interface Popup {
  open: boolean;
  /** The popup text, at most 2000 characters. The settle compares it. */
  text: string;
  /** The texts of the clickable options in the popup, at most 20 of 200 characters. */
  picks: string[];
  /**
   * The field or the popup shows that it loads: aria-busy, a progress bar or spinner, or "loading" or "searching". An
   * aria-expanded field whose popup the script cannot find is busy too: its options are unknown.
   */
  busy: boolean;
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
  focus?: {
    node: number; label: string; role: string | null; submitLabel: string; editable?: boolean; value?: string;
    /** The form or dialog of the focused element, with the same identity as `Action.form`. Never sent to Jev. */
    form?: number | null;
    /** The name of the form's default button: its first submit control in tree order. "" when that control is disabled. Never sent to Jev. */
    submitDefault?: string;
    /** The focused element is a textarea, a contenteditable, or aria-multiline. Never sent to Jev. */
    multiline?: boolean;
  } | null;
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
  /** performance.timeOrigin of the document. Node ids are unique only inside one document. */
  doc?: number;
  /** Node ids of the form controls in the document, in view or not, whose value is not blank. `actions` lists only controls in view. Never sent to Jev. */
  filled?: number[];
  /** Node id and value of each rendered form control, in view or not, whose value is not blank. A control that is hidden, aria-hidden, or inert is not in the list. Never sent to Jev. */
  texts?: [number, string][];
}

/**
 * A field that holds assistant-written text that no click or Enter has sent yet. The MCP session keeps the
 * list with its tab between runs, so a later run on the same page is gated too.
 */
export interface UnsentText {
  doc: number | undefined;
  node: number | null;
  label: string;
  /** The exact text that was typed, or "<secret>" for a secret value. */
  text: string;
  /** The text request of a generated value. null for other values and for entries from an earlier run. */
  request: string | null;
  /**
   * Set only when the fill did not stay (the field showed empty right after it, or no observation after the fill
   * settled) and no click or Enter ran since. The page can hold the text where the control does not show it, so the
   * entry gates the next click or Enter, in this run or the next one. A select or back does not clear it: it asked
   * nothing, so it did not show the text.
   */
  pending?: true;
  /**
   * Set when the control's own entry stayed on it but the control showed only a moved text: the page wrote a moved
   * text over this one. An empty control then does not show that this text went, so the entry stays with no field.
   */
  overwritten?: true;
  /**
   * The other controls of the document that held the text before the fill, with their values then. The entry does not
   * move onto one of them while it holds that value. A new value there can be the text that the page moved. Never set
   * for a secret value.
   */
  before?: [number, string][];
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
  /** Chip fields: read the popup next to a fill field. With `focus`, focus the field first. Null when the node is gone. */
  popup(action: Action, focus?: boolean): Promise<Popup | null>;
  /**
   * Chip fields: a script Enter on the focused field (keydown, then keypress when keydown was not handled, then keyup).
   * A script key event has no default action, so it never submits a form: only the page's own key handler can act on
   * it. Throws StalePage when the page no longer matches `obs`; nothing is sent then. `skipped` when the field is gone
   * or does not have focus.
   */
  commit(action: Action, obs: Observation): Promise<{ prevented: boolean } | { skipped: "gone" | "focus" }>;
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
