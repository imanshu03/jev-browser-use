// Shared types and constants. No logic lives here.

export type Engine = "cdp" | "chromium" | "vercel";

export type Goal = "act" | "extract" | "check";

export type PageKind =
  | "task_page" | "sign_in_wall" | "captcha_or_bot_check" | "consent_or_cookie_banner"
  | "blocking_dialog" | "error_page" | "empty_or_loading";

/** The one operation head. DONE and BLOCKED live inside it. */
export type Operation =
  | "CLICK" | "TYPE_TEXT" | "SELECT" | "PRESS_KEY" | "SCROLL_DOWN" | "SCROLL_UP"
  | "GO_BACK" | "WAIT" | "OPEN_URL" | "DONE" | "BLOCKED";

export type ActionKind =
  | "click" | "fill" | "select" | "check" | "uncheck" | "hover" | "press_key"
  | "scroll_down" | "scroll_up" | "go_back" | "open_url" | "wait" | "none";

export type RiskClass = "read_only" | "navigational" | "data_entry" | "submit" | "destructive";

export type Outcome = "done" | "blocked" | "failed";

export type BlockedKind =
  | "needs_sign_in" | "captcha" | "overlay" | "needs_confirmation" | "needs_credential"
  | "ambiguous" | "loop_detected" | "max_steps" | "impossible" | "no_start_url"
  | "ambiguous_profile" | "page_too_large" | "run_timeout" | "human_aborted"
  | "needs_text";                 // new text: no writer, declined, timed out, rejected, or cap reached

export type FailedKind = "browser" | "jev" | "internal";

export interface Element {
  ref: string;
  role: string;
  name: string;               // cut to LIMITS.nameChars
  depth: number;
  under: string;              // section chain, max 3 parts, "" when unknown
  key: string;                // `${role}|${name}|${under}`; stable across ref renumbering
  attrs: Record<string, string | true>;
  state: string;              // bracket attributes without ref and level, joined by ", "
  value: string;              // text after the trailing colon, cut to 80 chars
  options?: string[];         // option children names, max LIMITS.optionsPerElement
  optionRefs?: string[];      // refs of option children, parallel to options ("" when none)
  href?: string;
  seen: number;               // collapsed duplicate count (>= 1)
  index: number;              // document order
}

export interface ParsedPage {
  url: string;
  title: string;
  elements: Element[];
  refCount: number;
  headings: string[];
  fingerprint: string;
  truncated: boolean;
}

/** Binds assistant-written text to the one field it was written for. */
export interface SpanField {
  key: string;                    // `${obs.doc}|${action.node}` at request time
  label: string;                  // redacted, sanitized, cut to LIMITS.nameChars
  request: string;                // "t1".."t3"
}

export interface Span {
  id: string;                     // "s<n>" task, "v_<key>" var, "g<n>" generated
  text: string;
  source: "quoted" | "email" | "url" | "number" | "date" | "after_verb" | "proper_noun"
        | "clause" | "whole_task" | "var" | "page_line" | "generated";
  verb?: string;
  /** The id of the after_verb span this span was cut from: its first words, before a preposition or as a proper noun. */
  parent?: string;
  /**
   * The id of the other value of a maybe cut: the cut names its longer value, and the longer value names the cut. A head
   * shows both when one of them passes its hide rules, and hides both only when both fail.
   */
  pair?: string;
  /** A cut of an after_verb value of more than 10 words, which is not a span. A field that can take new text leaves it out. */
  longCut?: true;
  secret: boolean;                // always false for "generated"
  field?: SpanField;              // only for "generated"
}

/** One executed action. The first six fields go to Jev as `recent_actions`. */
export interface HistoryEntry {
  step: number;
  operation: string;
  target?: string;
  value?: string;             // redacted when secret
  result: string;
  page_changed: boolean | null;
  url_after?: string;
  element_key?: string;
}

/**
 * An action that an autonomous run (`confirm: "autonomous"`) did with no dialog: a destructive or submit action, a
 * click or Enter while assistant text was in a field, or a fill that replaced text that the run did not type. Only the
 * record of an action that ran carries it.
 */
export interface UnattendedAction {
  action: string;                 // as a dialog names it: `click button "Send"`
  host: string;
  why: ("destructive" | "submit" | "unsent_text" | "replaced")[];
  /**
   * The assistant texts in fields at the action (for a fill: the text it typed). `left`: after the action no control
   * holds the text, or a new document loaded (true); a control holds it (false); not known (null).
   */
  texts: { label: string; text: string; chars: number; left: boolean | null; earlier_run?: true }[];
  /** The other non-empty fields of the target's form, or of the page when the form is not known. No credential, secret, or payment field. */
  fields: { label: string; value: string }[];
  /** A fill only: the number of characters of the old value that it replaced. */
  replaced_chars?: number;
}

export interface StepRecord {
  step: number;
  url: string;
  title: string;
  page_kind: PageKind | null;
  page_kind_conf: number | null;
  done_p: number | null;      // probability of DONE in the operation head
  operation: Operation | null;
  operation_conf: number | null;
  target: { ref: string; role: string; name: string; under: string } | null;
  target_conf: number | null;
  runner_up: number | null;
  action: ActionKind;
  value: string | null;
  value_conf: number | null;
  risk: RiskClass | null;
  path: "fast" | "confirm" | "code" | null;
  gate: string;
  result: "ok" | "failed" | "recovered" | "skipped" | "paused" | "blocked" | "done" | "wait";
  error: string | null;
  jev_requests: number;
  duration_ms: number;
  /** Autonomous runs only: the audit of an action that ran with no dialog. */
  unattended?: UnattendedAction;
}

export interface RunConfig {
  task: string;
  profile?: string;
  url?: string;
  /** Chat mode: the page the browser already shows. Used when nothing else resolves a start URL. */
  fallbackUrl?: string;
  headed: boolean;
  cdp?: number;
  maxSteps: number;
  stepTimeoutMs: number;
  runTimeoutMs: number;
  pauseTimeoutMs: number;
  /** "autonomous": no action asks, and no action blocks for want of a person. The direct engines only. */
  confirm: "auto" | "always" | "never" | "autonomous";
  dryRun: boolean;
  session: string;
  model: string;
  logLevel: "info" | "debug";
  logJson: boolean;
  keepOpen: boolean;
  screenshotDir?: string;
  agentBrowserBin: string;
  vars: Record<string, string>;
  goal?: Goal;
  /** Which engine runs the task. The CLI fills it; absent means the CLI default. */
  engine?: Engine;
  /** Fast engine: copy the Chrome profile again even when a copy exists. */
  refreshProfile?: boolean;
  /** Fast engine: Chrome binary to launch. */
  chromeBin?: string;
}

export type CheckAnswer = boolean | "unknown";

export interface RunResult {
  version: 1;
  task: string;
  outcome: Outcome;
  reason: string;
  confidence: number | null;
  goal: Goal;
  answer:
    | { kind: "extract"; text: string; line_id: string; evidence: string[] }
    | { kind: "check"; answer: CheckAnswer; probability: number; evidence: string[]; top?: { label: string; p: number }[] }
    | null;
  final_url: string | null;
  final_title: string | null;
  profile: { directory: string; name: string; how: string } | null;
  start: { url: string; how: string; confidence: number | null } | null;
  steps: StepRecord[];
  blocked: { kind: BlockedKind; hint: string; top: { label: string; p: number }[]; resume: { session: string; url: string | null } } | null;
  error: { kind: FailedKind; message: string } | null;
  stats: {
    steps: number; jev_requests: number; input_tokens: number; output_tokens: number; duration_ms: number; model: string; pauses: number;
    /** Sum of Jev request round trips. */
    jev_ms: number;
    /** Sum of browser command round trips plus settle waits. The legacy engine reports 0. */
    browser_ms: number;
    engine: Engine;
  };
}

// Target thresholds start low: the operation head already committed to the operation, and
// measured target confidences over 26..100 elements were 0.31..0.49 in the prototype runs.
export const THRESHOLDS: Record<RiskClass, { target: number; value: number; inScope: number; targetOk: number; humanConfirm: boolean }> = {
  read_only:    { target: 0.20, value: 0.50, inScope: 0.00, targetOk: 0.00, humanConfirm: false },
  navigational: { target: 0.25, value: 0.50, inScope: 0.30, targetOk: 0.00, humanConfirm: false },
  data_entry:   { target: 0.30, value: 0.55, inScope: 0.40, targetOk: 0.00, humanConfirm: false },
  submit:       { target: 0.50, value: 0.70, inScope: 0.60, targetOk: 0.60, humanConfirm: false },
  destructive:  { target: 0.70, value: 0.85, inScope: 0.80, targetOk: 0.85, humanConfirm: true },
};

export const FAST_PATH = {
  target: 0.60,               // target confidence to act at once on a plain click
  runnerUpRatio: 0.50,
  irreversibleMax: 0.30,
  submitsMax: 0.40,
  value: 0.80,
} as const;

export const GATES = {
  pageKind: 0.60, pageKindError: 0.70, signInProb: 0.30,
  operation: 0.20, blocked: 0.40, doneFinal: 0.70, answerOk: 0.70, check: 0.60, checkHolds: 2,
  chunkWinner: 0.20, runnerUpRatio: 0.50, action: 0.50,
  submitWithEnter: 0.70, irreversibleDestructive: 0.50, submitsSubmit: 0.60,
  valueFromPage: 0.60, fillsCredential: 0.50,
  dismissTarget: 0.60, isDismissible: 0.50,
  key: 0.60, openUrl: 0.70, wall: 0.50,
  profileJev: 0.80, profileHuman: 0.50, profileMentioned: 0.50,
  site: 0.70, wantsSearch: 0.60, searchQuery: 0.50, goal: 0.50,
  extractWinner: 0.20, extractFinal: 0.60, pageSpanCapture: 0.70, evidenceLine: 0.30,
  done: 0.50, answerLine: 0.20,       // fast engine: P(DONE) for act goals; answer_line confidence for extract goals
  editMode: 0.60, editReplace: 0.80,  // fast engine: the mode head of a field that holds text the run did not type; a replace of that text
  varOnly: 0.75,                      // fast engine, plugin runs: a var chosen by the var fallback's vars-only value request
  textAfterSend: 0.50,                // fast engine, plugin runs: TYPE_TEXT confidence of a generate after a send of this run
} as const;

export const LIMITS = {
  chunkSize: 200, maxElements: 1000, headElements: 400, stateElements: 250, nameChars: 80, nameCharsTrimmed: 60,
  underChars: 60, optionsPerElement: 100, valueChars: 80, textExcerptChars: 6000, textExcerptTrimmed: 2000,
  history: 10, historyTrimmed: 3, spans: 40, spanChars: 120, pageSpans: 3,
  lineChars: 160, linesPerRequest: 600, maxLines: 1800, evidenceLines: 3, checkLines: 300,
  snapshotCharsResnapshot: 400_000, fullSnapshotAboveRefs: 200,
  waitsPerPage: 2, recoversPerPage: 2, coveredPerPage: 2, lowConfStreak: 3, doneRejections: 2, doneSuppressSteps: 2,
  pauses: 2, errorRetries: 1, staleRetries: 1, stallActions: 3,
  sigRepeatBan: 2, fpRepeatWindow: 6, fpRepeatCount: 4,
  tokenRequest: 60_000, tokenStatePlusLongest: 28_000, charsPerToken: 2.2,
  openTimeoutMs: 60_000, settleDomMs: 10_000, settleIdleMs: 5_000, settlePauseMs: 400, expandWaitMs: 300,
  coveredRetryMs: 300, coveredSecondRetryMs: 1000, pausePollMs: 5_000, confirmPromptMs: 120_000,
  scrollPx: 600, waitIdleMs: 5_000, waitPauseMs: 1_000,
  fastWaitMs: 1_500, waitPollMs: 100,   // fast engine WAIT: poll until the page changes and holds still, at most fastWaitMs
  // Fast engine causal settle after input: wait for the timers and requests that the input started.
  causalCapMs: 3_000,             // the whole settle, from the input to the last check
  causalTimerMaxMs: 1_000,        // a timer of this delay or longer is not work that the input started (a toast, an idle poll)
  causalBusyMs: 500,              // a busy marker alone holds the settle this long: a long job keeps its marker
  causalFollowMs: 60,             // after a tracked callback or a counted request, new timers still count this long
  causalGenerations: 4,           // timers that a tracked callback starts count up to this depth; a poll chain stops
  causalPollMs: 10,               // the page layer checks the tracker and the requests this often
  titleChars: 200, urlChars: 2000,       // fast engine state caps for page.title and page.url
  // Fast engine.
  fastStaleRetries: 3, fastReasks: 1, textChars: 6000, textCharsTrimmed: 3000, textCharsMin: 1500,
  fastElementsTrimmed: 150, answerLines: 254, answerLineChars: 160,
  valueHeads: 8,                  // fields with a value head in the step request; a fill of another field asks in a second request
  // Assistant-written text (MCP runs only).
  textRequests: 3,                // text requests per run
  textFields: 4,                  // target + up to 3 same-form fields
  generatedChars: 4000,           // all fields of one request together; also the per-field cap
  textWaitMs: 300_000,            // per text request; not counted in runTimeoutMs
  textHistory: 5,                 // recent actions in a text request
  confirmTextChars: 6000,         // all unsent text in one dialog; more blocks needs_confirmation
  secretMinChars: 4,              // checkTexts ignores shorter secret values
  genSpanWords: 4,                // with generate offered, after_verb spans above this word count are left out
  heldValueChars: 2000,           // current_value of a text request field that holds text the run did not type
  openStepHolds: 2,               // DONE refusals while a step that a submit click opened is still open; then the run blocks
} as const;

export const ROLE_PRIORITY: Record<string, number> = {
  searchbox: 0, textbox: 0, combobox: 0, textarea: 0, button: 1, checkbox: 1, radio: 1, menuitem: 1, tab: 1,
  option: 1, switch: 1, spinbutton: 1, link: 2, slider: 2, row: 2, treeitem: 2, listitem: 3, cell: 3, gridcell: 3,
};

export const ACTIONABLE_ROLES = new Set([
  "searchbox", "textbox", "textarea", "combobox", "button", "link", "checkbox", "radio", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "option", "switch", "slider", "spinbutton",
  "row", "listitem", "cell", "treeitem", "gridcell",
]);

/** Roles the CLICK head may target. */
export const CLICK_ROLES = new Set([
  "button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "checkbox", "radio",
  "treeitem", "switch", "row", "cell", "gridcell", "listitem", "combobox",
]);

/** Roles the TYPE_TEXT head may target. */
export const FILL_ROLES = new Set(["textbox", "searchbox", "combobox", "textarea", "spinbutton"]);

export const KEY_CATALOG: Record<string, string> = {
  enter: "Enter", escape: "Escape", tab: "Tab", arrow_down: "ArrowDown", arrow_up: "ArrowUp",
  page_down: "PageDown", page_up: "PageUp",
};

export const DESTRUCTIVE_WORDS = ["delete", "remove", "pay", "buy", "purchase", "checkout", "place order",
  "send", "post", "publish", "transfer", "unsubscribe", "cancel subscription", "confirm order",
  "submit order", "archive", "reply", "tweet", "share", "deactivate", "close account"];

/**
 * Labels of controls that send a message from a composer. A new line in an editor near one can send (the composer shape
 * of a fill), and in a multiline field Enter stands for one. "Share" and "Publish" buttons are also on document editors.
 */
export const COMPOSER_SEND_WORDS = ["send", "post", "reply", "comment"];

/** Labels of controls that send a text. A click on one, or an Enter, with unsent assistant text in a field can be a send. */
export const SEND_WORDS = [...COMPOSER_SEND_WORDS, "publish", "share", "tweet", "queue"];

export const SUBMIT_WORDS = ["submit", "save", "apply", "sign in", "log in", "login", "register", "sign up",
  "continue", "next", "create", "update", "add to cart", "confirm"];

export const DISMISS_WORDS = ["close", "dismiss", "reject", "decline", "no thanks", "not now", "got it",
  "accept", "agree", "ok", "×", "later", "skip", "maybe later", "i understand"];

export const CREDENTIAL_NAME = /password|passcode|passphrase|\bpin\b|\botp\b|one-time|verification code|security code|2fa|mfa|totp/i;
export const SECRET_KEY = /pass|pin|otp|secret|token|code/i;
/** Labels of fields that take an exact value. Assistant-written text never goes into them. */
export const EXACT_VALUE_NAME = /^(to|cc|bcc|from)\b|recipient|e-?mail address|^e-?mail$|phone|mobile number|amount|price|quantity|card number|\biban\b|account number|routing number|street|postal code|zip code|api key|\btoken\b|\bsecret\b|user ?name|\burl\b|website|\bsearch\b/i;
/** Autocomplete tokens of fields that take an exact value. */
export const EXACT_AUTOCOMPLETE = /email|tel|url|username|password|one-time-code|cc-|address|postal|country|bday|transaction/;
/** Text that looks like a key or token. Assistant-written text with a match is rejected. */
export const KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;
export const SIGN_IN_HEADING = /sign in|log in|login|choose an account|enter your password|verify it's you/i;
export const AUTH_HOST = /accounts\.google\.com|login\.|signin\.|auth\.|sso\.|okta\.com|auth0\.com/i;

/** The workspace rule: all browser work runs in Chrome Profile 14 unless the user says otherwise. */
export const DEFAULT_PROFILE_NAME = "Parallelloop";
