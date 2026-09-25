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

/**
 * Where a fill puts its text. `replace`: the field holds only the new text afterwards. `append`: the field keeps its
 * text, and the new text goes at its end. An empty field is always replaced. Jev chooses the mode; the page places the
 * caret with key-less editing commands and checks the result.
 */
export type EditMode = "replace" | "append";
export interface EditPlan { mode: EditMode }

/**
 * The shape of a field, read at the fill. It chooses the separator of an append:
 * - `input`: a single-line field (one space);
 * - `textarea`: a line break in the text;
 * - `composer`: a contenteditable with a send-like control near it, or with one block of text. A new line can send
 *   there, so an append joins with one space, and a text with line breaks is refused;
 * - `document`: a contenteditable with two or more blocks, a heading, or a list, and no send-like control. Each line
 *   of the text goes into a new block, made with the key-less `insertParagraph` command.
 */
export type FieldShape = "input" | "textarea" | "composer" | "document";

/** What a fill did. `mode` is the mode that ran (an empty field is replaced). `before` and `after` are the field text. */
export interface EditResult { mode: EditMode; shape: FieldShape; before: string; after: string }

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

/**
 * A fill that the page refused: focus is not on the field, the selection is not where the edit needs it, or the field
 * shape does not take the text. The message gives the reason. `changed`: the refusal came after the fill changed the
 * page (a new line went in, or the field shows another value after the insert), so the fill must not run again.
 * Without `changed`, nothing was typed.
 */
export class EditRefused extends Error {
  readonly changed: boolean;
  constructor(message: string, changed = false) {
    super(message);
    this.name = "EditRefused";
    this.changed = changed;
  }
}

export interface Page {
  readonly targetId: string;
  readonly sessionId: string;
  /** Read the page with one in-page evaluation. Waits first for any pending post-input settle (2 animation frames or 50 ms; 200 ms for a combobox). Retries while the document is navigating, up to `settleTimeoutMs`. */
  observe(): Promise<Observation>;
  /** True when the page still matches `obs`. With a click, fill, or select action, compares the page key and that node's guard only. With a scroll action, the page key only. Without an action, the whole marker. */
  fresh(obs: Observation, action?: Action): Promise<boolean>;
  /**
   * Execute one observed action. Rechecks freshness, visibility, geometry, and occlusion right before input. Throws
   * StalePage when anything changed; nothing is executed then. `text` is required for a fill. A fill uses `edit`
   * (default: replace), sends no key that a page can read, types only while the field has focus, and returns what it
   * did. It throws EditRefused when the field refuses the edit.
   */
  act(action: Action, obs: Observation, text?: string, edit?: EditPlan): Promise<EditResult | void>;
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
