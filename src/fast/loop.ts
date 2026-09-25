import { redactingOracle } from "../jev.js";
import { redactData } from "../task.js";
// The fast Runner. One observation per step, one Jev request per step, freshness guards instead of waits.
//
// Loop control (history, page_changed, the three-action stall rule, StalePage retry) follows
// browser-use/jev-ultrafast jev_ultrafast/agent.py. MIT License, Copyright (c) 2026 Browser Use.
//
// This file codes only against the interfaces in ./model.ts. It never imports the browser layer.
import { TypeSafeError, choice } from "@typesafe-ai/sdk";
import path from "node:path";
import type { ProfileEntry } from "../browser.js";
import type { Human, Logger, RunnerHints, TextSource } from "../io.js";
import { emptyResult } from "../io.js";
import type { Oracle } from "../jev.js";
import { BudgetError, choiceOf } from "../jev.js";
import type { Plan } from "../plan.js";
import { catalogWords, prePlan, resolvePlan } from "../plan.js";
import { extractKeys, extractSpans, redact, varSpans } from "../task.js";
import type { ActionKind, BlockedKind, Goal, Operation, PageKind, RiskClass, RunConfig, RunResult, Span, StepRecord, UnattendedAction } from "../types.js";
import { AUTH_HOST, COMPOSER_SEND_WORDS, CREDENTIAL_NAME, DESTRUCTIVE_WORDS, GATES, LIMITS, SEND_WORDS, SIGN_IN_HEADING, SUBMIT_WORDS, THRESHOLDS } from "../types.js";
import type { Action, Chrome, EditPlan, EditResult, FastHistoryEntry, Observation, Page, UnsentText } from "./model.js";
import { EditRefused, StalePage } from "./model.js";
import { buildTextRequest, checkTexts, flatText, hostOf, pickFields, sanitizeText } from "./generate.js";
import type { Decision, StepInput, StepMeta, Target, TargetOp, ValueAsk, ValueHead } from "./policy.js";
import { actionKey, buildStep, buildValueStep, canPressEnter, canWriteInto, cutLines, cutText, fieldLines, readEdit, readStep, readValue, tokenEvidence, top3 } from "./policy.js";

export { actionKey };

export interface FastRunnerDeps {
  cfg: RunConfig;
  profiles: ProfileEntry[];
  /** Lazy: a plan-level block never launches Chrome. Gets the profile directory the plan resolved (undefined = temporary profile). */
  chrome: (profileDirectory: string | undefined) => Promise<Chrome>;
  /** Chat mode: the page the browser already shows. Used when the plan says `current_page`. */
  page?: Page;
  openPage: (chrome: Chrome) => Promise<Page>;
  oracle: Oracle;
  human: Human;
  log: Logger;
  now?: () => number;
  /** Sleep used between WAIT polls. Tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Open the Jev connection ahead of the first step. Called before the Chrome launch when the plan sent no Jev request. */
  warm?: () => Promise<void>;
  /** The user's assistant writes new field text. Only the MCP server attaches it; without it `generate` is never offered. */
  text?: TextSource;
  /** Cancels the run. Checked at step start, around each step request, before page input, and after each wait. */
  signal?: AbortSignal;
  /** Front-end hint texts. An absent field keeps the CLI text. */
  hints?: RunnerHints;
  /** The task and the vars come from an assistant (MCP), not from the user directly. */
  fromAssistant?: boolean;
  /** Unsent assistant text that an earlier run left on `page`. The gate applies to it as to this run's own text. */
  unsent?: readonly UnsentText[];
  /**
   * A person can see the run and act in the browser. Only an autonomous run reads it: without a person, a sign-in wall
   * blocks at once. Default: `human.interactive`.
   */
  attended?: boolean;
}

type Top = { label: string; p: number }[];

interface StepCtx {
  t0: number; req0: number; url: string; title: string;
  pageKind: PageKind | null; pageKindConf: number | null; doneP: number | null; operation: Operation | null; operationConf: number | null;
  target: { ref: string; role: string; name: string; under: string } | null; targetConf: number | null; runnerUp: number | null;
  action: ActionKind; value: string | null; valueConf: number | null; risk: RiskClass | null; gate: string;
  /** The audit of an action that an autonomous run does with no dialog. The record gets it only when the input ran. */
  unattended: UnattendedAction | null;
}

/**
 * `ran`: the action ran, and only the observation after it did not settle. `appended`: the fill ran as an append.
 * `refused`: the page refused a fill (EditRefused); `changed` says that the fill changed the page before the refusal.
 */
type Applied = { kind: "record"; rec: StepRecord; ran?: true; appended?: true } | { kind: "reask" } | { kind: "stale"; message: string; action?: Action }
  | { kind: "refused"; message: string; changed: boolean; action: Action };

/** The value a fill types: its span, and the observation and action to type it on. A text wait observes again. */
type Typed = { kind: "span"; span: Span; obs: Observation; action: Action; gate: string | null } | { kind: "applied"; applied: Applied };

const REASK: Typed = { kind: "applied", applied: { kind: "reask" } };

type Unsent = UnsentText;

/** The assistant text that a fill typed into one field in this run. */
interface TypedText {
  doc: number | undefined;
  node: number | null;
  /** The field label as a text request gives it: redacted, flat, cut. */
  label: string;
  text: string;
  /** The text request that wrote it. A later request for the field is a second text. */
  request: string | null;
  /** The form or dialog of the field at the fill. */
  form: number | null;
  /**
   * The other controls that held the text before the fill. The record never moves onto them: a text that was in a
   * control before ("Q3 plan" inside the Notes) did not move there.
   */
  before: number[];
  /**
   * False only when the observation right after the fill showed the field in view and empty, and no control held the
   * text: the page dropped the insert. A page that changes the text (bullets, smart quotes, capitals) kept it.
   */
  stayed: boolean;
  /** The text was typed again one time because the fill did not stay. */
  retyped: boolean;
  /** A click, Enter, select, or back ran after the fill. The text can have gone out with it. */
  acted: boolean;
  /** The send that took the text out of the page. */
  sent?: SentText;
}

/** A text that a send of this run took out of the page. */
interface SentText {
  doc: number | undefined;
  node: number | null;
  label: string;
  text: string;
  /** The step of the send, and the send: `click "Send message"` or `Enter`. */
  step: number;
  action: string;
}

/** A value that a fill of this run typed into a chip (token) field. It is pending until a chip holds it. */
interface TypedToken {
  doc: number | undefined;
  node: number;
  /** The field label as a hint gives it: redacted, flat, cut. */
  label: string;
  text: string;
  /** The form or dialog of the field at the fill. */
  form: number | null;
  /** A popup was open next to the field after the fill or at a gate: the field can offer options for the value. */
  popup: boolean;
  /** The popup listed options for this value: Enter can pick one of them instead of the typed value. */
  picks: boolean;
  /** A gate gave the hint for this value. */
  hinted: boolean;
}

/** A pending chip value on one observation: its draft holds it, or the draft lost it and nothing before the field holds it. */
interface PendingToken { key: string; e: TypedToken; state: "draft" | "lost"; field: Action | undefined; strong: boolean }

/** The result of a script Enter in a chip field (`commitToken`). */
type TokenCommit = { result: "added" | "ignored" | "kept" | "wrong" | "cleared"; next: Observation | null; hint: string };

/** Whitespace runs become one space. A page can change the line breaks of a text that it shows in a field. */
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
/**
 * A text in lower case, with straight quotes, no list marks at line starts, and no symbols or emoji: a page can change
 * these in a text that it takes. Sentence marks stay: "Tuesday works." is not in "Tuesday works for me.".
 */
const loose = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"')
  .replace(/^[ \t]*(?:[-*+•◦▪‣·●]|\d+[.)])[ \t]+/gm, "").replace(/[^\p{L}\p{N}\s.,!?;:'"()-]+/gu, " ").replace(/\s+/g, " ").trim();
/** The shortest start of a text that counts as the text in a control with a length limit. */
const CUT_MIN = 24;

const ALNUM = /[\p{L}\p{N}]/u;

/** How many times `hay` holds `needle` with no letter or digit next to either end: "ok" is not in "book", "1" is not in "v1.2". */
function wordHits(hay: string, needle: string): number {
  let n = 0;
  if (needle === "") return n;
  for (let i = hay.indexOf(needle); i >= 0; ) {
    const a = hay[i - 1];
    const b = hay[i + needle.length];
    const startOk = !ALNUM.test(needle[0] ?? "") || a === undefined || !ALNUM.test(a);
    const endOk = !ALNUM.test(needle.at(-1) ?? "") || b === undefined || !ALNUM.test(b);
    const hit = startOk && endOk;
    if (hit) n += 1;
    i = hay.indexOf(needle, i + (hit ? needle.length : 1));
  }
  return n;
}

/** `hay` holds `needle` with no letter or digit next to either end. */
const inWords = (hay: string, needle: string): boolean => wordHits(hay, needle) > 0;

/**
 * A control value holds a typed text as whole words: the text itself, the text as the page changed it (bullets, smart
 * quotes, capitals, emoji; at least 2 letters or digits), or its start cut by a length limit (at least CUT_MIN letters
 * and a third of the text).
 */
function holdsText(value: string, text: string): boolean {
  const want = squash(text);
  if (want === "") return false;
  if (inWords(squash(value), want)) return true;
  const lw = loose(text);
  const lv = loose(value);
  if (lv === "" || (lw.match(/[\p{L}\p{N}]/gu) ?? []).length < 2) return false;
  return inWords(lv, lw) || (lv.length >= CUT_MIN && lv.length * 3 >= lw.length && lw.startsWith(lv));
}

/**
 * The nodes of the controls of `o` that hold `text` (see holdsText): the rendered controls in `texts`, and the fields in
 * view. The audit of an autonomous action (`left`), the send record, and the wait after a send read a text as gone from
 * the page with this one list.
 */
function holders(o: Observation, text: string): (number | null)[] {
  return [
    ...(o.texts ?? []).filter(([, v]) => holdsText(v, text)).map(([n]) => n),
    ...o.actions.filter((a) => a.kind === "fill" && holdsText(a.value ?? "", text)).map((a) => a.node),
  ];
}

/**
 * The check after an append: the field shows the typed text, and it still holds each line that it held before. Lines
 * compare loosely: a page can add list marks or change quotes. Null when the fill kept the text; else what it lost.
 */
function appendLost(typed: string, r: EditResult): string | null {
  if (!holdsText(r.after, typed)) return "the field does not show the typed text";
  const now = loose(r.after);
  const lost = fieldLines(r.before).filter((l) => loose(l) !== "" && !now.includes(loose(l)));
  return lost.length === 0 ? null : `the field lost ${lost.length} line${lost.length === 1 ? "" : "s"} of its text, such as "${cutText(lost[0] ?? "", 40)}"`;
}

/** The name of a button that sends a message from a composer. */
const SEND_BUTTON = new RegExp(String.raw`\b(?:${COMPOSER_SEND_WORDS.join("|")})\b`, "i");

/** The name of a control that leaves a confirmation step without its action: a step with one asks before it acts. */
const CANCEL_CONTROL = /^(?:cancel|no|not now|go back|keep editing|discard)\b/i;

/** Roles of a popup option. A click on one picks a value, as a suggestion of a chip field does. */
const OPTION_ROLES: ReadonlySet<string> = new Set(["option", "menuitem", "menuitemradio", "menuitemcheckbox", "treeitem", "gridcell"]);

/**
 * A step that a submit or destructive click of this run opened, and that the page still shows. The click did not finish
 * its action: a "Save" that opens a "Save Changes" popover with "Confirm", a "Delete" that opens "Delete? Cancel /
 * Delete". The step is a popup of the clicked control (it shows aria-expanded="true" now), or a new dialog or form with a
 * cancel control. `buttons`: its new submit or destructive controls. `holds`: the DONE answers refused while it is open.
 */
interface OpenStep { doc: number | undefined; click: string; buttons: { node: number; label: string }[]; holds: number }

const ACTION_OF: Record<string, ActionKind> = {
  CLICK: "click", TYPE_TEXT: "fill", SELECT: "select", SCROLL_DOWN: "scroll_down", SCROLL_UP: "scroll_up",
  WAIT: "wait", PRESS_ENTER: "press_key", GO_BACK: "go_back", DONE: "none", BLOCKED: "none",
};

const OPERATION_OF: Record<string, Operation> = {
  CLICK: "CLICK", TYPE_TEXT: "TYPE_TEXT", SELECT: "SELECT", SCROLL_DOWN: "SCROLL_DOWN", SCROLL_UP: "SCROLL_UP",
  WAIT: "WAIT", PRESS_ENTER: "PRESS_KEY", GO_BACK: "GO_BACK", DONE: "DONE", BLOCKED: "BLOCKED",
};

const BLOCKED_OF: Record<string, BlockedKind> = {
  needs_sign_in: "needs_sign_in", captcha: "captcha", overlay_or_dialog: "overlay",
  needs_credential_or_value: "needs_credential", impossible: "impossible", other: "ambiguous",
};

const HEADED_HINT = "Run with --headed (or /headed on in chat) and sign in when the run pauses";
const NO_CONFIRM_HINT = "run on a TTY with confirmation enabled";
const SECRET_SHOWN = "<secret>";
const VALUE_HINT = "pass --var key=value (or /var key=value in chat)";
const UNATTENDED_WALL_HINT = "an autonomous run with no person at a TTY does not wait for a sign-in; sign in first (run with --headed on a TTY), then run again";
const CANCELLED = "the run was cancelled";

function hit(label: string, words: string[]): boolean {
  const n = label.toLowerCase();
  return words.some((w) => new RegExp(`(?<![a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`, "i").test(n));
}

/** Autocomplete tokens of credential fields. A task or var value never goes into them, as with a credential label. */
const CREDENTIAL_AUTOCOMPLETE = /password|one-time-code/;

/** A credential field: its label, its input type, or its autocomplete token says so. */
function isCredential(a: Action, label: string): boolean {
  return CREDENTIAL_NAME.test(label) || a.inputType === "password" || CREDENTIAL_AUTOCOMPLETE.test(a.autocomplete ?? "");
}

/** Labels of fields whose values an audit entry never lists: secrets, and payment and identity numbers. */
const PRIVATE_LABEL = /\b(?:secret|token|api ?key|card|cvv|cvc|iban|account (?:number|no)|routing|ssn|social security|tax ?id|passport)\b/i;
/** Autocomplete tokens of fields whose values an audit entry never lists. */
const PRIVATE_AUTOCOMPLETE = /cc-|one-time-code|password/;
/** An audit entry lists at most this many other fields, each value cut to AUDIT_VALUE_CHARS. */
const AUDIT_FIELDS = 8;
const AUDIT_VALUE_CHARS = 200;

/** The action ran: an `ok` record, or a record whose next observation did not settle. */
const ran = (r: Applied): boolean => r.kind === "record" && (r.rec.result === "ok" || r.ran === true);

/** A value answer for the log: `v_brief@0.52`, `generate@0.45`, `none`, or `missing`. */
function valueText(v: Decision["value"]): string {
  if (v === undefined || v === "none") return v ?? "missing";
  return `${"spanId" in v ? v.spanId : "generate"}@${v.conf.toFixed(2)}`;
}

/** Risk classes from low to high. */
const RISK_ORDER: RiskClass[] = ["read_only", "navigational", "data_entry", "submit", "destructive"];

/** Risk of one target from its label. Keyword classes apply to clicks; a fill or select is data entry. */
export function riskOf(op: TargetOp, label: string): RiskClass {
  if (op === "CLICK") {
    if (hit(label, DESTRUCTIVE_WORDS)) return "destructive";
    if (hit(label, SUBMIT_WORDS)) return "submit";
    return "navigational";
  }
  return "data_entry";
}

/** True for a CDP transport error or a Chrome that went away. Named by convention; the browser layer is not imported here. */
function isBrowserError(e: unknown, chrome: Chrome | null): boolean {
  const name = (e as { name?: string } | null)?.name ?? "";
  if (name === "CdpError" || name === "ChromeError") return true;
  return chrome !== null && chrome.client.closed;
}

export class FastRunner {
  private readonly deps: FastRunnerDeps;
  private readonly cfg: RunConfig;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly result: RunResult;
  private chrome: Chrome | null = null;
  private _page: Page | null = null;
  private spans: Span[] = [];
  private keys: { label: string; key: string }[] = [];
  private goal: Goal;
  private readonly history: FastHistoryEntry[] = [];
  private stepNo = 0;
  private pauses = 0;
  private readonly startedAt: number;
  private lastObs: Observation | null = null;
  private held: Observation | null = null;
  /**
   * Banned action keys (see `actionKey`) per URL: targets that a repeat or a cover showed to be useless on that page.
   * They stay banned for the run.
   */
  private readonly bannedByUrl = new Map<string, Set<string>>();
  /**
   * Action keys that failed a confidence gate in this step (low target or value confidence, a near tie). The re-ask
   * does not offer them. The next step offers them again: a dialog does not change the URL, so a ban per URL would
   * take a field away for the rest of the run, and its value would go into another field.
   */
  private readonly stepBans = new Set<string>();
  /** Covered-target stales per `url|actionKey`. At LIMITS.coveredPerPage the target is banned on that page. */
  private readonly coveredCounts = new Map<string, number>();
  private doneBannedUntil = 0;
  /** The step whose DONE or BLOCKED decision had its freshness check. The check runs once per step. */
  private endChecked = 0;
  /** Executions per `url|actionKey`. */
  private readonly sigCounts = new Map<string, number>();
  /** WAIT operations executed per URL. Capped at LIMITS.waitsPerPage, then a scroll takes its place. */
  private readonly waitsByUrl = new Map<string, number>();
  /** Browser stats of the page when this run got it. In chat mode the page outlives the run. */
  private browser0 = { browserMs: 0, calls: 0 };
  private readonly checkHolds = new Map<string, number>();
  private errorBacks = 0;
  private answer: RunResult["answer"] = null;
  private blockedInfo: RunResult["blocked"] = null;
  private confidence: number | null = null;
  private reason = "";
  /** Text requests sent to the assistant in this run. At most LIMITS.textRequests. */
  private textRequests = 0;
  /** Generated span ids: g1, g2, ... */
  private genSeq = 0;
  /** Time spent waiting for assistant text. It is not counted in runTimeoutMs. */
  private waitedMs = 0;
  /** Filled fields with assistant-written text. While one holds text, every click and Enter needs a dialog. */
  private unsent: Unsent[] = [];
  /** `<doc>|<node>` -> the last text that a fill of this run typed into that control. */
  private readonly typedInto = new Map<string, string>();
  /** Field labels of the texts the assistant wrote in this run, and whether a fill typed each text. */
  private written: { label: string; typed: boolean }[] = [];
  /**
   * `<doc>|<node>` -> the assistant text that a fill typed into that field in this run. A run writes one text per
   * field: a second text request for the field would type the text again, and after a send it would send it twice.
   * A text that moved to another control has the same record under both keys.
   */
  private readonly typedText = new Map<string, TypedText>();
  /** Ids of the spans that type a text again after a fill that did not stay. */
  private readonly retypes = new Set<string>();
  /** The edit plan of the TYPE_TEXT decision in progress. A text request for its field says where the text goes. */
  private editPlan: EditPlan | undefined;
  /** `<doc>|<node>` -> the texts that an append of this run added to that field. An append of the same text again is not typed. */
  private readonly appended = new Map<string, string[]>();
  /** The step that the last submit or destructive click opened, while the page shows it. DONE waits for it. */
  private openStep: OpenStep | null = null;
  /** Ids of the var spans that a fill of this run typed. The var fallback does not offer them. */
  private readonly usedVars = new Set<string>();
  /** Texts that a send of this run took out of the page, in order. */
  private sent: SentText[] = [];
  /**
   * The unsent entries that a click on a send control, or an Enter, asked about. Each observation checks whether their
   * text left the page. Another action than WAIT in a later step ends the watch.
   */
  private sendWatch: { step: number; action: string; entries: Unsent[] } | null = null;
  /** `<doc>|<node>` of the fields that this run saw add a value as a chip, or that showed a multiselect listbox (strong evidence). */
  private readonly tokenFields = new Set<string>();
  /**
   * `<doc>|<node>` -> the value that a fill of this run typed into a chip field (see `tokenTyped`). observe() does not end
   * an entry, as it ends a `typedInto` entry: a draft that the page cleared on blur is lost, not added.
   */
  private readonly typedToken = new Map<string, TypedToken>();

  constructor(deps: FastRunnerDeps) {
    this.deps = { ...deps, oracle: redactingOracle(deps.oracle, (s) => redact(s, this.spans)) };
    this.cfg = deps.cfg;
    this.log = deps.log;
    this.now = deps.now ?? (() => Date.now());
    this.goal = deps.cfg.goal ?? "act";
    this.startedAt = this.now();
    this.result = emptyResult(deps.cfg.task, this.goal, deps.cfg.model, deps.cfg.engine ?? "cdp");
    // Text requests of an earlier run have other ids. A seeded entry never drops the spans of this run.
    this.unsent = (deps.unsent ?? []).map((u) => ({ ...u, request: null, earlier: true as const }));
  }

  /** The page the run used. Null when the run opened no page: a plan-level block, or a launch that failed. */
  get page(): Page | null { return this._page; }

  /** The unsent assistant text on the page when the run ended. The MCP session gives it to the next run on that page. */
  unsentText(): UnsentText[] { return this.unsent.map(({ earlier: _earlier, ...u }) => ({ ...u })); }

  /** The texts that a send of this run took out of the page, with their field labels. The MCP result shows them. */
  sentTexts(): { field: string; text: string }[] { return this.sent.map((x) => ({ field: x.label, text: x.text })); }

  /** Labels of the fields the assistant wrote text for in this run that no fill typed. Jev may submit without an optional field. */
  untypedText(): string[] {
    const typed = new Set(this.written.filter((w) => w.typed).map((w) => w.label));
    return [...new Set(this.written.filter((w) => !typed.has(w.label)).map((w) => w.label))];
  }

  async run(): Promise<RunResult> {
    const cfg = this.cfg;
    let outcome: RunResult["outcome"] = "failed";
    try {
      const profiles = this.deps.profiles.filter((p) => p.directory);
      const exclude = [...profiles.flatMap((p) => [p.name, p.directory]), ...catalogWords()];
      this.spans = [...extractSpans(cfg.task, exclude), ...varSpans(cfg.vars)];
      this.log.redactor = (s) => redact(s, this.spans);
      this.result.task = redact(cfg.task, this.spans);
      this.keys = extractKeys(cfg.task);

      // When code alone knows the profile and the start URL, Chrome starts and loads the page while the
      // plan request runs. Jev then only decides the goal. A plan that needs Jev for the profile or the
      // site keeps the serial order: the plan first, then Chrome.
      const pre = prePlan(cfg, profiles);
      let browser: Promise<void> | null = null;
      if (pre.profileDirectory !== null && pre.startUrl !== null && !pre.current && !this.cancelled) {
        // No Jev request at all: no socket is open yet. Open it while Chrome starts.
        if (!pre.needsJev) this.deps.warm?.().catch(() => undefined);
        else this.log.debug("overlap: chrome launch and plan request run together");
        browser = this.openStart(pre.profileDirectory, pre.startUrl);
        // A rejection while the plan is in flight is never unhandled. The await below rethrows it.
        browser.catch(() => undefined);
      }
      /** Wait for the browser work before a block or an error, so finalize can close the Chrome it launched. */
      const settle = async (): Promise<void> => { if (browser) await browser.catch(() => undefined); };

      let plan: Plan;
      try { plan = await resolvePlan(cfg, profiles, this.spans, this.deps.oracle, this.deps.human, this.log); } catch (e) { await settle(); throw e; }
      this.goal = plan.goal;
      this.result.goal = plan.goal;
      this.result.profile = plan.profile.profile ? { directory: plan.profile.profile.directory, name: plan.profile.profile.name, how: plan.profile.how } : null;
      this.result.start = plan.start.url ? { url: plan.start.url, how: plan.start.how, confidence: plan.start.confidence } : null;
      this.log.info(`plan profile=${plan.profile.profile ? `${plan.profile.profile.name} (${plan.profile.profile.directory})` : "none"} via ${plan.profile.how} start=${plan.start.url ?? "none"} via ${plan.start.how} goal=${plan.goal}${plan.goalConfidence !== null ? `(${plan.goalConfidence.toFixed(2)})` : ""} requests=${plan.jevRequests} engine=${this.cfg.engine ?? "cdp"}`);
      if (this.cancelled) { await settle(); this.setBlocked("human_aborted", CANCELLED, [], null); return this.finalize("blocked"); }
      if (plan.profile.blocked) { await settle(); this.setBlocked("ambiguous_profile", "Name the profile with --profile <name>", plan.top, null); return this.finalize("blocked"); }
      const current = plan.start.how === "current_page";
      if (plan.start.blocked || !plan.start.url || (current && !this.deps.page)) {
        await settle();
        this.setBlocked("no_start_url", "Add --url <start page> or name the site in the task", plan.top, null);
        return this.finalize("blocked");
      }

      if (browser) await browser;
      else {
        // The plan sent no Jev request, so no socket is open yet. Open it while Chrome starts.
        if (plan.jevRequests === 0) this.deps.warm?.().catch(() => undefined);
        if (current) {
          await this.attach(plan.profile.profile?.directory);
          this.log.info(`continue on ${plan.start.url} session=${cfg.session}${cfg.headed ? " headed" : ""}`);
        } else await this.openStart(plan.profile.profile?.directory, plan.start.url);
      }

      for (;;) {
        const rec = await this.step();
        this.result.steps.push(rec);
        this.log.step(rec);
        if (rec.result === "done") { outcome = "done"; break; }
        if (rec.result === "blocked") { outcome = "blocked"; break; }
      }
    } catch (e) {
      outcome = "failed";
      const kind = e instanceof TypeSafeError ? "jev" : isBrowserError(e, this.chrome) ? "browser" : "internal";
      this.result.error = { kind, message: this.log.redactor(String((e as Error)?.message ?? e)) };
      this.reason = `${kind}: ${this.result.error.message}`;
      this.log.warn(`FAILED ${this.reason}`);
    }
    return this.finalize(outcome);
  }

  /** Launch Chrome, or take the page chat passed, and record the page stats this run starts from. */
  private async attach(profileDirectory: string | undefined): Promise<Page> {
    this.chrome = await this.deps.chrome(profileDirectory);
    this._page = this.deps.page ?? await this.deps.openPage(this.chrome);
    this.browser0 = { ...this._page.stats };
    return this._page;
  }

  /** Attach, then load the start URL. */
  private async openStart(profileDirectory: string | undefined, url: string): Promise<void> {
    const page = await this.attach(profileDirectory);
    this.log.info(`open ${url} session=${this.cfg.session}${this.cfg.headed ? " headed" : ""}`);
    await page.navigate(url, LIMITS.openTimeoutMs);
  }

  private async finalize(outcome: RunResult["outcome"]): Promise<RunResult> {
    const r = this.result;
    try {
      const last = this.held ?? this.lastObs;
      if (last) { r.final_url = last.url; r.final_title = last.title; }
      else if (this._page) { r.final_url = await this._page.url().catch(() => null); }
    } finally {
      if (!this.cfg.keepOpen && this.chrome) await this.chrome.close().catch(() => undefined);
    }
    if (this.blockedInfo && !this.blockedInfo.resume.url) this.blockedInfo.resume.url = r.final_url;
    r.outcome = outcome;
    r.reason = this.reason;
    r.confidence = this.confidence;
    r.answer = this.answer;
    r.blocked = this.blockedInfo;
    r.goal = this.goal;
    const s = this.deps.oracle.stats;
    r.stats = {
      steps: r.steps.length, jev_requests: s.requests, input_tokens: s.inputTokens, output_tokens: s.outputTokens,
      duration_ms: this.now() - this.startedAt, model: s.model, pauses: this.pauses,
      jev_ms: s.ms, browser_ms: this._page ? this._page.stats.browserMs - this.browser0.browserMs : 0, engine: this.cfg.engine ?? "cdp",
    };
    return redactData(r, (s) => redact(s, this.spans));
  }

  private setBlocked(kind: BlockedKind, hint: string, top: Top, url: string | null): void {
    this.blockedInfo = { kind, hint, top, resume: { session: this.cfg.session, url } };
    this.reason = `${kind}: ${hint}`;
    this.log.warn(`BLOCKED ${kind}: ${hint}`);
  }

  /** True when the front end cancelled the run. */
  private get cancelled(): boolean {
    return this.deps.signal?.aborted === true;
  }

  private cancel(ctx: StepCtx, url: string | null): StepRecord {
    return this.blocked(ctx, "human_aborted", CANCELLED, [], url);
  }

  private bansFor(url: string): Set<string> {
    let s = this.bannedByUrl.get(url);
    if (!s) { s = new Set(); this.bannedByUrl.set(url, s); }
    return s;
  }

  private async observe(): Promise<Observation> {
    const obs = this.markTokens(await (this._page as Page).observe());
    this.lastObs = obs;
    // A text that its field showed late counts as typed when this observation shows it.
    this.seeTyped(obs);
    // A control that shows blank lost the text that this run typed there. A later value there did not come from that
    // fill, so it is no longer "own text" for pruneUnsent.
    const doc = `${obs.doc}|`;
    for (const key of [...this.typedInto.keys()]) {
      if (!key.startsWith(doc)) continue;
      const node = Number(key.slice(doc.length));
      const f = obs.actions.find((a) => a.kind === "fill" && a.node === node);
      const blank = f ? (f.value ?? "").trim() === "" : obs.filled !== undefined && !obs.filled.includes(node);
      if (blank) this.typedInto.delete(key);
    }
    // A before pair holds only while every observation shows its control with the same value.
    this.unsent = this.unsent.map((u) => this.ageBefore(obs, u));
    this.checkSent(obs);
    return obs;
  }

  /**
   * Watch the texts that a click on a send control or an Enter asked about. Only an entry whose text a control showed
   * counts: a pending entry (a fill that did not stay) gives no evidence that the page had the text to send. The
   * observation after the action is checked at once.
   */
  private watchSend(gated: Unsent[], action: string): void {
    const entries = gated.filter((u) => !u.pending).map((u) => ({ ...u }));
    if (entries.length === 0) return;
    this.sendWatch = { step: this.stepNo, action, entries };
    if (this.held) this.checkSent(this.held);
  }

  /**
   * A watched text is sent when an observation shows it in no control: a new document, or its field empty or gone and
   * no other control that holds it. A text that stays (a send error, a disabled button) gives no record.
   */
  private checkSent(obs: Observation): void {
    const w = this.sendWatch;
    if (!w) return;
    const left: Unsent[] = [];
    for (const u of w.entries) {
      if (!this.textLeft(obs, u)) { left.push(u); continue; }
      if (this.sent.some((x) => x.doc === u.doc && x.label === u.label && x.text === u.text)) continue;
      const sent: SentText = { doc: u.doc, node: u.node, label: u.label, text: u.text, step: w.step, action: w.action };
      this.sent.push(sent);
      for (const r of this.typedText.values()) if (r.doc === u.doc && r.text === u.text && !r.sent) r.sent = sent;
      this.log.info(`step ${this.stepNo} sent: the text for "${u.label}" left the page after step ${w.step} (${w.action})`);
    }
    this.sendWatch = left.length > 0 ? { ...w, entries: left } : null;
  }

  /**
   * No control of `obs` holds the text of `u`: a new document, or its field in view and empty, or its field not in
   * `filled`, and no control holds the text (`holders`). An observation without `filled` cannot tell a field out of view
   * from a field that is gone.
   */
  private textLeft(obs: Observation, u: Unsent): boolean {
    if (obs.doc !== u.doc) return true;
    const field = obs.actions.find((a) => a.kind === "fill" && a.node === u.node);
    if (field ? (field.value ?? "").trim() !== "" : obs.filled === undefined || (u.node !== null && obs.filled.includes(u.node))) return false;
    return holders(obs, u.text).length === 0;
  }

  /**
   * A send ran in the last step, and a rendered control still showed its text right after it (a "sending" state).
   * Observe every waitPollMs, at most fastWaitMs, until the text leaves. A DONE on the "sending" page fell below its
   * gate. A text that only a hidden control holds (a form that the page hid after the send) is not waited for.
   */
  private async sendSettled(obs: Observation): Promise<Observation> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const polls = Math.ceil(LIMITS.fastWaitMs / LIMITS.waitPollMs);
    const shown = (o: Observation): boolean => (this.sendWatch?.entries ?? []).some((u) => u.doc === o.doc && holders(o, u.text).length > 0);
    const t0 = Date.now();
    let next = obs;
    for (let i = 0; this.sendWatch !== null && shown(next) && i < polls && Date.now() - t0 < LIMITS.fastWaitMs; i++) {
      await sleep(LIMITS.waitPollMs);
      next = await this.observeSettled();
    }
    return next;
  }

  /**
   * Observe, and observe again when the page did not settle, up to LIMITS.fastStaleRetries times.
   * Throws StalePage after the retries; the callers block with "page keeps changing".
   */
  private async observeSettled(): Promise<Observation> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.observe();
      } catch (e) {
        if (!(e instanceof StalePage) || attempt >= LIMITS.fastStaleRetries) throw e;
        this.log.warn(`step ${this.stepNo} observe did not settle (${attempt + 1}/${LIMITS.fastStaleRetries}): ${e.message}`);
      }
    }
  }

  /** The ids of the actions of `obs` whose key is banned on its URL or in this step. The policy filters targets by id. */
  private bannedIds(obs: Observation): Set<string> {
    const bans = this.bansFor(obs.url);
    const ids = new Set<string>();
    if (bans.size === 0 && this.stepBans.size === 0) return ids;
    for (const a of obs.actions) { const k = actionKey(a); if (bans.has(k) || this.stepBans.has(k)) ids.add(a.id); }
    return ids;
  }

  /** The spans a step may offer. A generated span of another document can never pass the binding check, so Jev does not see it. */
  private offered(obs: Observation): Span[] {
    const doc = `${obs.doc}|`;
    return this.spans.filter((s) => s.source !== "generated" || (s.field?.key.startsWith(doc) ?? false));
  }

  /**
   * The multiline fields of `obs` that hold text that this run did not type. A field whose text is all this run's own (a
   * text that a fill typed there, the record of a written text, or an unsent entry on it) is not one: a new text
   * replaces it, as before, with no mode head.
   */
  private heldText(obs: Observation): Set<number> {
    const out = new Set<number>();
    for (const a of obs.actions) {
      if (a.kind !== "fill" || a.multiline !== true || a.node === null || loose(a.value ?? "") === "") continue;
      const key = `${obs.doc}|${a.node}`;
      const own = [this.typedInto.get(key), this.typedText.get(key)?.text, ...this.unsent.filter((u) => u.doc === obs.doc && u.node === a.node).map((u) => u.text)]
        .map((t) => loose(t ?? "")).filter((t) => t !== "");
      const rest = own.reduce((v, t) => v.split(t).join(" "), loose(a.value ?? ""));
      if (ALNUM.test(rest)) out.add(a.node);
    }
    return out;
  }

  private stalled(): boolean {
    const last = this.history.slice(-LIMITS.stallActions);
    return last.length === LIMITS.stallActions && last.every((h) => h.page_changed === false && h.kind !== "wait" && h.kind !== "open");
  }

  private async step(): Promise<StepRecord> {
    this.stepNo += 1;
    this.stepBans.clear();
    const ctx: StepCtx = {
      t0: this.now(), req0: this.deps.oracle.stats.requests, url: "", title: "", pageKind: null, pageKindConf: null, doneP: null, operation: null, operationConf: null,
      target: null, targetConf: null, runnerUp: null, action: "none", value: null, valueConf: null, risk: null, gate: "", unattended: null,
    };
    if (this.cancelled) return this.cancel(ctx, this.lastObs?.url ?? null);
    if (this.stepNo > this.cfg.maxSteps) return this.blocked(ctx, "max_steps", `stopped after ${this.cfg.maxSteps} steps`, [], this.lastObs?.url ?? null);
    // Time spent waiting for assistant text is not browser time.
    if (this.now() - this.startedAt - this.waitedMs > this.cfg.runTimeoutMs) return this.blocked(ctx, "run_timeout", `run exceeded ${this.cfg.runTimeoutMs} ms`, [], this.lastObs?.url ?? null);

    let obs: Observation;
    try {
      obs = this.held ?? await this.observeSettled();
      if (this.sendWatch?.step === this.stepNo - 1) obs = await this.sendSettled(obs);
    } catch (e) {
      if (e instanceof StalePage) return this.blocked(ctx, "ambiguous", "page keeps changing", [], this.lastObs?.url ?? null);
      throw e;
    }
    this.held = null;
    ctx.url = obs.url; ctx.title = obs.title;
    if (this.stalled()) return this.blocked(ctx, "loop_detected", `${LIMITS.stallActions} actions without a page change`, [], obs.url);
    if (this.cfg.screenshotDir) await (this._page as Page).screenshot(path.join(this.cfg.screenshotDir, `step-${this.stepNo}.jpg`)).catch(() => undefined);

    let reasks = 0;
    let retryReason: string | undefined;
    let stale = 0;
    let refusals = 0;
    for (;;) {
      const held = this.heldText(obs);
      const input: StepInput = {
        task: this.cfg.task, goal: this.goal, obs, history: this.history, spans: this.offered(obs), keys: this.keys,
        bannedActionIds: this.bannedIds(obs), doneBanned: this.stepNo <= this.doneBannedUntil,
        ...(retryReason ? { retryReason } : {}),
        ...(this.deps.text ? { canGenerate: true } : {}),
        ...(this.typedText.size > 0 ? { textTyped: true } : {}),
        ...(held.size > 0 ? { heldText: held } : {}),
        ...(this.sent.length > 0 ? { sentTexts: this.sentTexts() } : {}),
      };
      let built: ReturnType<typeof buildStep>;
      try { built = buildStep(input); } catch (e) {
        if (e instanceof BudgetError) {
          // Defensive: the caps in policy.ts keep every real page under budget. A sign-in page must still hand off.
          if (AUTH_HOST.test(obs.url) || SIGN_IN_HEADING.test(obs.title)) {
            this.log.warn(`step ${this.stepNo} request too large on a sign-in page (${e.message}); handing off`);
            return this.handoff(ctx, "needs_sign_in", [], obs);
          }
          return this.blocked(ctx, "page_too_large", `${obs.actions.length} actions, ${obs.text.length} chars; ${e.message}`, [], obs.url);
        }
        throw e;
      }
      for (const c of built.meta.cuts) this.log.warn(`step ${this.stepNo} ${c}`);
      if (this.cancelled) return this.cancel(ctx, obs.url);
      const A = (await this.deps.oracle.ask("step", built.state, built.questions)).answers;
      if (this.cancelled) return this.cancel(ctx, obs.url);
      let d = readStep(A, built.meta, input);
      // BLOCKED below its gate does not end the run: read the runner-up operation instead (legacy rule).
      // A sign-in or captcha reason keeps BLOCKED only when the page kind head agrees.
      if (d.operation === "BLOCKED" && d.operationConf < GATES.blocked && !this.wallReason(d)) {
        const next = Object.entries(d.operationProbs).filter(([k]) => k !== "BLOCKED" && k in ACTION_OF && !(k === "DONE" && input.doneBanned)).sort((a, b) => b[1] - a[1])[0];
        if (next) {
          this.log.info(`step ${this.stepNo} BLOCKED at ${d.operationConf.toFixed(2)} below ${GATES.blocked}; using ${next[0]}@${next[1].toFixed(2)}`);
          d = readStep(A, built.meta, input, next[0]);
        }
      }
      if (d.operation === "TYPE_TEXT" && d.target) {
        const t = d.target;
        try { d = await this.resolveValue(input, d, t, built.meta); } catch (e) {
          // A value request over budget is a page that is too large, as a step request over budget is.
          if (e instanceof BudgetError) return this.blocked(ctx, "page_too_large", `value request for "${t.label}": ${e.message}`, [], obs.url);
          throw e;
        }
        if (this.cancelled) return this.cancel(ctx, obs.url);
      }
      ctx.pageKind = d.pageKind; ctx.pageKindConf = d.pageKindConf;
      ctx.operation = d.operation ? OPERATION_OF[d.operation] ?? null : null;
      ctx.operationConf = d.operation ? d.operationConf : null;
      ctx.doneP = d.operation ? d.pDone : null;
      this.log.info(`step ${this.stepNo}/${this.cfg.maxSteps} ${obs.url} | page=${d.pageKind ?? "?"}(${(d.pageKindConf ?? 0).toFixed(2)}) op=${d.operation ?? "?"}@${d.operationConf.toFixed(2)}${d.target ? ` target=[${d.target.key}]@${d.target.conf.toFixed(2)}` : ""}${d.answerState ? ` answer=${d.answerState.choice}@${d.answerState.conf.toFixed(2)}` : ""}${d.answerVisible !== undefined ? ` visible=${d.answerVisible.toFixed(2)}` : ""} actions=${obs.actions.length} obs=${obs.ms}ms`);

      // A fresh decision must not retain the target or typed value from a stale attempt.
      ctx.target = null; ctx.targetConf = null; ctx.runnerUp = null;
      ctx.action = "none"; ctx.value = null; ctx.valueConf = null; ctx.risk = null;
      const r = await this.apply(d, obs, built.meta, ctx);
      if (r.kind === "record") return r.rec;
      if (r.kind === "reask") {
        reasks += 1;
        if (reasks > LIMITS.fastReasks) return this.blocked(ctx, "ambiguous", ctx.gate || "no target passed the gate after a re-ask", d.target ? top3(d.target.probs) : top3(d.operationProbs), obs.url);
        retryReason = `${ctx.operation ?? "action"}${d.target ? ` on "${d.target.label}"` : ""} was not executed: ${ctx.gate}. Check the current page and choose the next useful action. Fill required text before submitting.`;
        this.log.warn(`step ${this.stepNo} retry ${reasks}/${LIMITS.fastReasks}: ${ctx.gate}; observing again`);
        try {
          obs = await this.observeSettled();
        } catch (e) {
          if (e instanceof StalePage) return this.blocked(ctx, "ambiguous", "page keeps changing", [], this.lastObs?.url ?? obs.url);
          throw e;
        }
        ctx.url = obs.url; ctx.title = obs.title;
        ctx.target = null; ctx.targetConf = null; ctx.runnerUp = null;
        ctx.action = "none"; ctx.value = null; ctx.valueConf = null; ctx.risk = null;
        continue;
      }
      if (r.kind === "refused") {
        // Nothing was typed. A focus or selection that moved can be a page that was still busy: observe and decide one
        // time more. A second refusal blocks with its reason; it is not a changing page.
        refusals += 1;
        // As after a stale action: the refused fill did not run, so its gate and audit do not go to the next decision.
        ctx.gate = ""; ctx.unattended = null;
        const label = cutText(r.action.label, LIMITS.nameChars);
        this.log.warn(`step ${this.stepNo} fill of "${label}" refused (${refusals}/2): ${r.message}`);
        if (refusals > 1) return this.blocked(ctx, "ambiguous", `the fill of "${label}" was refused: ${r.message}`, [], obs.url);
        retryReason = `TYPE_TEXT on "${label}" was not executed: ${r.message}. Check the current page and choose the next useful action.`;
        try {
          obs = await this.observeSettled();
        } catch (e) {
          if (e instanceof StalePage) return this.blocked(ctx, "ambiguous", "page keeps changing", [], obs.url);
          throw e;
        }
        ctx.url = obs.url; ctx.title = obs.title;
        continue;
      }
      stale += 1;
      // The stale action did not run. Its gate ("confirmed", "autonomous") and its audit must not go to the next
      // decision: a WAIT after a stale Send showed "confirmed". A re-ask keeps its gate: it is the reason of a block.
      ctx.gate = ""; ctx.unattended = null;
      this.log.warn(`step ${this.stepNo} stale page (${stale}/${LIMITS.fastStaleRetries}): ${r.message}`);
      if (r.action && /covered/i.test(r.message)) {
        // A target that stays covered is not a changing page. Ban it on this page so the re-ask takes another route.
        const key = actionKey(r.action);
        const n = (this.coveredCounts.get(`${obs.url}|${key}`) ?? 0) + 1;
        this.coveredCounts.set(`${obs.url}|${key}`, n);
        if (n >= LIMITS.coveredPerPage) {
          this.bansFor(obs.url).add(key);
          const label = cutText(r.action.label, LIMITS.nameChars);
          this.log.warn(`step ${this.stepNo} [${r.action.id}] "${label}" stays covered; banned on this page`);
          this.history.push({ action: label, kind: "covered", text: null, page_changed: false, step: this.stepNo, url: obs.url, operation: "CLICK" });
        }
      }
      if (stale > LIMITS.fastStaleRetries) return this.blocked(ctx, "ambiguous", "page keeps changing", [], obs.url);
      try {
        obs = await this.observeSettled();
      } catch (e) {
        if (e instanceof StalePage) return this.blocked(ctx, "ambiguous", "page keeps changing", [], obs.url);
        throw e;
      }
      ctx.url = obs.url; ctx.title = obs.title;
    }
  }

  /**
   * The value request of one TYPE_TEXT key, or of a part of its head (`ask`), with the head it offered. A full request
   * also carries the mode head of a field that holds text that this run did not type. Undefined when the field has no
   * value to offer. Throws BudgetError when it is over budget.
   */
  private async askValue(input: StepInput, key: string, ask?: ValueAsk): Promise<{ value: Decision["value"]; edit: Decision["edit"]; head: ValueHead } | undefined> {
    const built = buildValueStep(input, key, ask);
    const head = built?.meta.values[key];
    if (!built || !head) return undefined;
    for (const c of built.meta.cuts) this.log.warn(`step ${this.stepNo} value request: ${c}`);
    const answers = (await this.deps.oracle.ask("value", built.state, built.questions)).answers;
    return { value: readValue(answers, built.meta, key), edit: readEdit(answers, built.meta, key), head };
  }

  /**
   * The value of a TYPE_TEXT decision. A fill of a field without a value head in the step request asks for its value in
   * a second request. Then the var fallback (plugin runs): a var and `generate` both mean "the caller's text goes here",
   * so a head that offers both splits between them ("Describe the workflow": v_brief 0.41-0.55 against generate
   * 0.43-0.57), and neither passes the value gate. When the answer is `generate` below the value gate, or an assistant's
   * var below it, and the head offers a non-secret var that no fill of this run typed:
   * 1. One value request offers only those vars and none. A var at GATES.varOnly (0.75) or above is the value. With
   *    only vars and none, a var that is not the field's text still gets a high confidence: a var "text" went to
   *    "Project Name" at 0.61-0.70. Right vars got 0.78-0.89 ("message", "description", "name"), a brief 0.69-0.79.
   * 2. Otherwise one value request offers the head without its vars. An answer other than none is the value: the
   *    assistant then writes the text, and the send dialog shows it.
   * Any other answer stays. The mode of a field that holds text that this run did not type comes from the first
   * answer. Throws BudgetError when a value request is over budget.
   */
  private async resolveValue(input: StepInput, d: Decision, t: Target, meta: StepMeta): Promise<Decision> {
    let head = meta.values[t.key];
    let value = d.value;
    if (!head) {
      const asked = await this.askValue(input, t.key);
      if (!asked) return d;
      head = asked.head;
      if (asked.value !== undefined) value = asked.value;
      if (asked.edit !== undefined) d = { ...d, edit: asked.edit };
    }
    const out = (v: Decision["value"]): Decision => (v === undefined ? d : { ...d, value: v });
    const vars = this.fallbackVars(value, head);
    if (vars.length === 0 || this.cancelled) return out(value);
    const was = valueText(value);
    const only = (await this.askValue(input, t.key, { vars }))?.value;
    if (only !== undefined && only !== "none" && "spanId" in only && only.conf >= GATES.varOnly) {
      this.log.info(`step ${this.stepNo} var fallback: [${t.key}] answered ${was}; the vars alone -> ${valueText(only)}`);
      return out(only);
    }
    if (this.cancelled) return out(value);
    const rest = (await this.askValue(input, t.key, { noVars: true }))?.value;
    this.log.info(`step ${this.stepNo} var fallback: [${t.key}] answered ${was}; the vars alone -> ${valueText(only)}; without the vars -> ${valueText(rest)}`);
    return out(rest !== undefined && rest !== "none" ? rest : value);
  }

  /**
   * The vars that the var fallback offers: the non-secret vars of the head that no fill of this run typed. None unless
   * the answer is `generate` below the value gate, or a var below it in a run whose vars an assistant wrote. The CLI
   * types a var at confidence 1 and never offers `generate`.
   */
  private fallbackVars(value: Decision["value"], head: ValueHead): string[] {
    if (value === undefined || value === "none" || value.conf >= THRESHOLDS.data_entry.value) return [];
    const low = "generate" in value || (this.deps.fromAssistant === true && this.spans.find((s) => s.id === value.spanId)?.source === "var");
    if (!low) return [];
    return Object.values(head.spans).filter((id) => {
      const s = this.spans.find((x) => x.id === id);
      return s !== undefined && s.source === "var" && !s.secret && !this.usedVars.has(id);
    });
  }

  /**
   * The submit button that Enter would press, when the click_target head chose it while the operation head chose
   * PRESS_ENTER, and the probability of Enter and that click together. Both submit the focused element's form, so they
   * share the operation probability, and Enter alone can stay below its gate. The button must be:
   * - a button, not the focused element itself, with a submit or destructive name;
   * - in the focused element's form or dialog, and that form must be known;
   * - in a single-line field, the form's default button (its first submit control, focus.submitDefault) when the form
   *   has submit controls: implicit submission presses only that one. In a textarea or an editor, Enter presses no
   *   button and a script sends: the default button or a submit control with a send name ("Send", "Post reply"). A
   *   form without submit controls (a script handles its Send button) needs only the shared form.
   * Null for any other element.
   */
  private submitButton(d: Decision, obs: Observation): { target: Target; p: number } | null {
    const c = d.click;
    const focus = obs.focus;
    if (!c || !focus) return null;
    const button = obs.actions.find((a) => a.id === c.actionId);
    if (!button || button.kind !== "click" || button.role !== "button" || button.node === focus.node) return null;
    if (riskOf("CLICK", c.label) === "navigational") return null;
    // The snapshot gives the focus form. An older adapter gives none: then the form of the focused element's action.
    const focusForm = focus.form !== undefined ? focus.form : obs.actions.find((a) => a.node === focus.node)?.form ?? null;
    if (focusForm === null || (button.form ?? null) !== focusForm) return null;
    const submits = focus.submitLabel.split(" | ").map((n) => n.trim()).filter(Boolean);
    const multiline = focus.multiline ?? obs.actions.find((a) => a.kind === "fill" && a.node === focus.node)?.multiline === true;
    const defaultButton = (focus.submitDefault ?? submits[0] ?? "").trim();
    const name = button.label.trim();
    if (submits.length > 0) {
      // In a textarea, Enter presses no button, and a script sends: the default button or a send button of the form.
      // "Submit as Solved" next to "Submit as Pending" is not the one that Enter stands for.
      const ok = multiline ? submits.includes(name) && ((defaultButton !== "" && name === defaultButton) || SEND_BUTTON.test(name)) : defaultButton !== "" && name === defaultButton;
      if (!ok) return null;
    }
    const p = (d.operationProbs["PRESS_ENTER"] ?? 0) + (d.operationProbs["CLICK"] ?? 0) * (c.probs[c.key] ?? c.conf);
    return { target: c, p };
  }

  /**
   * The option that Enter picks (focus.enterOption), when the click_target head chose it while the operation head chose
   * PRESS_ENTER, and the probability of the two together. Enter and a click on that option do the same thing, as with
   * the submit button. Null for any other element: Enter never turns into a click on another option.
   */
  private pickedOption(d: Decision, obs: Observation): { target: Target; p: number } | null {
    const c = d.click;
    const pick = obs.focus?.enterOption;
    if (!c || !pick) return null;
    const option = obs.actions.find((a) => a.id === c.actionId);
    if (!option || option.kind !== "click" || option.node !== pick.node) return null;
    const p = (d.operationProbs["PRESS_ENTER"] ?? 0) + (d.operationProbs["CLICK"] ?? 0) * (c.probs[c.key] ?? c.conf);
    return { target: c, p };
  }

  /**
   * After a submit or destructive click: note the step that it opened (OpenStep), when the observation after it shows
   * one on the same document. The step is a popup of the clicked control, or a new dialog or form with a cancel
   * control, and it holds a new submit or destructive control.
   */
  private noteOpened(action: Action, before: Observation, after: Observation | null, risk: RiskClass): void {
    if (!after || after.doc !== before.doc || action.node === null || (risk !== "submit" && risk !== "destructive")) return;
    const had = new Set(before.actions.map((a) => a.node));
    const forms = new Set(before.actions.map((a) => a.form ?? null));
    const fresh = after.actions.filter((a) => a.kind === "click" && a.node !== null && a.node !== action.node && !had.has(a.node));
    const was = before.actions.find((a) => a.node === action.node && a.kind === "click")?.expanded;
    const popup = was !== "true" && after.actions.some((a) => a.node === action.node && a.kind === "click" && a.expanded === "true");
    const dialogs = new Set(fresh.filter((a) => a.form != null && !forms.has(a.form) && CANCEL_CONTROL.test(a.label.trim())).map((a) => a.form));
    const buttons = fresh.filter((a) => (popup || dialogs.has(a.form ?? null)) && riskOf("CLICK", a.label) !== "navigational")
      .map((a) => ({ node: a.node as number, label: cutText(a.label, 40) }));
    if (buttons.length === 0) return;
    this.openStep = { doc: after.doc, click: cutText(action.label, 60), buttons, holds: 0 };
    this.log.info(`step ${this.stepNo} "${this.openStep.click}" opened a step with ${buttons.map((b) => `"${b.label}"`).join(", ")}`);
  }

  /** The step that the last submit or destructive click opened, when `obs` still shows one of its controls; else null. */
  private stillOpen(obs: Observation): OpenStep | null {
    const o = this.openStep;
    if (o && o.doc === obs.doc && o.buttons.some((b) => obs.actions.some((a) => a.kind === "click" && a.node === b.node))) return o;
    this.openStep = null;
    return null;
  }

  /** True when BLOCKED names a sign-in wall or a captcha and the page kind head gives that kind a real probability. */
  private wallReason(d: Decision): boolean {
    if (d.blockedReason === "needs_sign_in") return (d.pageKindProbs["sign_in_wall"] ?? 0) >= GATES.signInProb;
    if (d.blockedReason === "captcha") return (d.pageKindProbs["captcha_or_bot_check"] ?? 0) >= GATES.signInProb;
    return false;
  }

  private async apply(d0: Decision, obs: Observation, meta: StepMeta, ctx: StepCtx): Promise<Applied> {
    const rec = (r: StepRecord): Applied => ({ kind: "record", rec: r });
    let d = d0;
    const pkConf = d.pageKindConf ?? 0;
    // An empty or loading page cannot satisfy DONE and is not a wall. Wait for it to render.
    const loading = d.pageKind === "empty_or_loading" && pkConf >= GATES.pageKind;
    if (loading && (d.operation === "BLOCKED" || d.operation === "DONE")) {
      this.log.info(`step ${this.stepNo} ${d.operation}@${d.operationConf.toFixed(2)} on an empty or loading page (${pkConf.toFixed(2)}); waiting instead`);
      ctx.gate = `loading ${d.operation}`;
      d = { ...d, operation: "WAIT" };
    }
    const opTop = top3(d.operationProbs);
    const pkTop = top3(d.pageKindProbs);

    // Page kind gates run before any action. A BLOCKED reason hands off only when BLOCKED passed its gate
    // or the page kind head agrees; the blocked_reason head answers on every step, so alone it is no evidence.
    const blockedWall = d.operation === "BLOCKED" && (d.operationConf >= GATES.blocked || this.wallReason(d));
    if ((d.pageKind === "sign_in_wall" && pkConf >= GATES.pageKind) || (blockedWall && d.blockedReason === "needs_sign_in")) {
      return rec(await this.handoff(ctx, "needs_sign_in", pkTop, obs));
    }
    if ((d.pageKind === "captcha_or_bot_check" && pkConf >= GATES.pageKind) || (blockedWall && d.blockedReason === "captcha")) {
      return rec(await this.handoff(ctx, "captcha", pkTop, obs));
    }
    if (d.pageKind === "error_page" && pkConf >= GATES.pageKindError) {
      if (this.errorBacks >= 1) return rec(this.blocked(ctx, "impossible", "error page after going back", pkTop, obs.url));
      this.errorBacks += 1;
      ctx.gate = "error_page";
      return this.execute("GO_BACK", null, null, null, obs, ctx);
    }
    if (d.operation === null || !(d.operation in ACTION_OF)) return rec(this.blocked(ctx, "ambiguous", `no usable operation answer (${d.operation ?? "missing"})`, opTop, obs.url));

    // DONE and BLOCKED end the run on the observation of the request. When the page changed during the request (late
    // search results, a save that finished), observe again and ask again, once per step.
    if ((d.operation === "DONE" || d.operation === "BLOCKED") && this.endChecked !== this.stepNo) {
      this.endChecked = this.stepNo;
      if (!(await (this._page as Page).fresh(obs))) {
        this.log.info(`step ${this.stepNo} ${d.operation}@${d.operationConf.toFixed(2)} on a page that changed during the request; asking again`);
        return { kind: "stale", message: `the page changed during the ${d.operation} request` };
      }
    }
    // A submit click that opened a confirmation step did not finish its action. DONE waits until that step is gone.
    if (d.operation === "DONE" && this.goal === "act" && d.pDone >= GATES.done) {
      const open = this.stillOpen(obs);
      if (open) {
        open.holds += 1;
        const what = `the click on "${open.click}" opened a step that is still open, with ${open.buttons.slice(0, 3).map((b) => `"${b.label}"`).join(", ")}`;
        this.log.info(`step ${this.stepNo} DONE@${d.pDone.toFixed(2)} refused (${open.holds}/${LIMITS.openStepHolds}): ${what}`);
        if (open.holds > LIMITS.openStepHolds) return rec(this.blocked(ctx, "ambiguous", `${what}. The task is not done while that step is open; check the page`, opTop, obs.url));
        this.doneBannedUntil = Math.max(this.doneBannedUntil, this.stepNo);
        ctx.gate = `${what}. The click did not finish the action`;
        return { kind: "reask" };
      }
    }
    if (d.operation === "DONE") {
      // A value typed into a chip field that is not added yet: DONE asks first (tokenGate).
      if (this.goal === "act") {
        const gated = await this.tokenGate(true, this.pendingTokens(obs, null), obs, ctx, () => { this.doneBannedUntil = Math.max(this.doneBannedUntil, this.stepNo); });
        if (gated) return gated;
      }
      return rec(await this.finish(d, obs, ctx));
    }
    if (d.operation === "BLOCKED") {
      const kind = BLOCKED_OF[d.blockedReason ?? "other"] ?? "ambiguous";
      const hint = kind === "needs_credential" ? this.credentialHint("the field") : kind === "overlay" ? "a dialog or overlay covers the page; dismiss it with --headed" : kind === "impossible" ? "the goal cannot be done on this page" : `Jev reported BLOCKED (${d.blockedReason ?? "no reason"})`;
      return rec(this.blocked(ctx, kind, hint, opTop, obs.url));
    }
    if (d.operation === "CLICK" || d.operation === "TYPE_TEXT" || d.operation === "SELECT") return this.targeted(d, d.operation, obs, meta, ctx);
    if (d.operation === "PRESS_ENTER") {
      if (!canPressEnter(obs)) {
        ctx.gate = "Enter unavailable: focus an input and fill required text before submitting";
        return { kind: "reask" };
      }
      const focusNode = obs.focus?.node ?? null;
      const focused = focusNode === null ? undefined : obs.actions.find((a) => a.kind === "fill" && a.node === focusNode);
      const focusForm = obs.focus?.form !== undefined ? obs.focus.form : obs.actions.find((a) => a.node === focusNode)?.form ?? null;
      // Enter in a field with a highlighted option picks that option. The label, the risk, and the dialog name it.
      const pick = obs.focus?.enterOption;
      // Enter in a chip field with strong evidence: a script Enter first (enterToken). An Enter that picks an option
      // does not take this path: it keeps the label, the risk, and the dialog of that option.
      if (!pick && focused && tokenEvidence(focused) === "strong" && (focused.value ?? "").trim() !== "") {
        const added = await this.enterToken(d, focused, obs, ctx);
        if (added) return added;
      }
      // Enter in another field can send the form: a value typed into a chip field of that form and not added yet asks first.
      const tokenGated = await this.tokenGate(true, this.pendingTokens(obs, focusForm, focusNode), obs, ctx, () => undefined);
      if (tokenGated) return tokenGated;
      const label = [obs.focus?.label, obs.focus?.submitLabel, pick ? `picks ${pick.label}` : ""].filter(Boolean).join(" | ");
      // Enter can submit a form even when no submit button is visible. Treat unknown focus as submit.
      const risk: RiskClass = riskOf("CLICK", label) === "destructive" ? "destructive" : "submit";
      ctx.risk = risk;
      ctx.action = "press_key";
      ctx.value = "Enter";
      if (d.operationConf < THRESHOLDS[risk].target) {
        const submit = this.submitButton(d, obs) ?? this.pickedOption(d, obs);
        if (submit && submit.p >= THRESHOLDS[risk].target) {
          // The click then passes its own gates: the target confidence, the runner-up, and the confirmation.
          this.log.info(`step ${this.stepNo} Enter@${d.operationConf.toFixed(2)} below ${THRESHOLDS[risk].target}; Enter and a click on "${submit.target.label}" have ${submit.p.toFixed(2)} together; clicking it`);
          ctx.operation = "CLICK"; ctx.operationConf = submit.p; ctx.value = null;
          // Enter's risk is the least risk of the click: a destructive Enter stays a destructive click.
          return this.targeted({ ...d, operation: "CLICK", operationConf: submit.p, target: submit.target }, "CLICK", obs, meta, ctx, risk);
        }
        ctx.gate = `Enter confidence ${d.operationConf.toFixed(2)} below ${THRESHOLDS[risk].target}`;
        return { kind: "reask" };
      }
      ctx.gate = `ok ${d.operationConf.toFixed(2)} (${risk})`;
      const undo = this.unsentUndo();
      const gated = this.pruneUnsent(obs);
      const denied = await this.confirmAction(risk, `press Enter on "${label || "the focused element"}"`, ctx, opTop, obs.url, gated, { obs, form: focusForm });
      if (denied) return rec(denied);
      const r = await this.execute("PRESS_ENTER", null, null, null, obs, ctx);
      if (r.kind === "stale") undo();
      // An Enter with unsent text in a field can send it. An Enter that picks an option sends only with a send word in
      // the option: a pick that opens an item also takes the query out of the page.
      else if (ran(r) && gated.length > 0 && (!pick || hit(pick.label, SEND_WORDS))) this.watchSend(gated, "Enter");
      return r;
    }
    if (d.operation === "WAIT") {
      const waits = this.waitsByUrl.get(obs.url) ?? 0;
      if (waits >= LIMITS.waitsPerPage) {
        // The page did not update after the allowed waits. Scroll instead, as the legacy engine does.
        const scroll = obs.actions.some((a) => a.id === "scroll_down") ? "SCROLL_DOWN" : obs.actions.some((a) => a.id === "scroll_up") ? "SCROLL_UP" : null;
        if (!scroll) return rec(this.blocked(ctx, "loop_detected", `the page did not update after ${waits} waits`, opTop, obs.url));
        ctx.gate = `wait_cap ${waits}`;
        this.log.info(`step ${this.stepNo} WAIT capped at ${LIMITS.waitsPerPage} on ${obs.url}; using ${scroll}`);
        return this.execute(scroll, null, null, null, obs, ctx);
      }
      this.waitsByUrl.set(obs.url, waits + 1);
    }
    return this.execute(d.operation, null, null, null, obs, ctx);
  }

  /**
   * WAIT: run the page's wait action (100 ms), then observe every `waitPollMs` until the page changed and holds still:
   * two observations in a row are the same, and no busy marker shows. A first change can be a spinner, not the result.
   * At most `fastWaitMs`.
   */
  private async waitForChange(obs: Observation, control: Action | null): Promise<Observation> {
    const page = this._page as Page;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    if (control) await page.act(control, obs);
    else await sleep(LIMITS.waitPollMs);
    const polls = Math.max(1, Math.ceil(LIMITS.fastWaitMs / LIMITS.waitPollMs));
    const t0 = Date.now();
    let prev = obs;
    let next = await this.observeSettled();
    const still = (): boolean => next.fingerprint !== obs.fingerprint && next.fingerprint === prev.fingerprint && next.busy !== true;
    for (let i = 1; i < polls && !still() && Date.now() - t0 < LIMITS.fastWaitMs; i++) {
      await sleep(LIMITS.waitPollMs);
      prev = next;
      next = await this.observeSettled();
    }
    return next;
  }

  /** How the user supplies a value. A credential label uses `hints.credential`, then `hints.value`, then the CLI text. */
  private valueHint(credential: boolean): string {
    const h = this.deps.hints;
    return (credential ? h?.credential ?? h?.value : h?.value) ?? VALUE_HINT;
  }

  private credentialHint(field: string, credential = false): string {
    return `${field} needs a value: ${this.valueHint(credential)}`;
  }

  /** `floor`: the least risk class of the action (the risk of the Enter that a submit click replaces). */
  private async targeted(d: Decision, op: TargetOp, obs: Observation, _meta: StepMeta, ctx: StepCtx, floor?: RiskClass): Promise<Applied> {
    const t = d.target;
    if (!t) return { kind: "record", rec: this.blocked(ctx, "ambiguous", `no target answer for ${op}`, top3(d.operationProbs), obs.url) };
    const action = obs.actions.find((a) => a.id === t.actionId);
    if (!action) return { kind: "record", rec: this.blocked(ctx, "ambiguous", `target ${t.actionId} is not on the page`, top3(t.probs), obs.url) };
    ctx.target = { ref: action.id, role: action.role ?? "", name: t.label, under: "" };
    ctx.targetConf = t.conf; ctx.runnerUp = t.runnerUp;
    ctx.action = ACTION_OF[op] ?? "none";
    const own = riskOf(op, t.label);
    const risk = floor !== undefined && RISK_ORDER.indexOf(floor) > RISK_ORDER.indexOf(own) ? floor : own;
    ctx.risk = risk;
    const bans = this.bansFor(obs.url);
    const key = actionKey(action);

    // A send button in the form of a field that shows unsent assistant text: the unsent-text dialog shows the text and
    // asks the user before this click, so the target needs only the submit gate. The destructive gate repeated that
    // check, and on a workflow builder it sent Jev to other tabs while the brief stayed unsent ("Send message" at
    // 0.55-0.69, 7 of 21 runs).
    const sendGate = op === "CLICK" && risk === "destructive" && this.sendInForm(action, t.label, obs);
    const minTarget = sendGate ? THRESHOLDS.submit.target : THRESHOLDS[risk].target;
    if (t.conf < minTarget) {
      ctx.gate = `low_target ${t.conf.toFixed(2)} < ${minTarget} (${risk})`;
      this.stepBans.add(key);
      return { kind: "reask" };
    }
    if (sendGate && t.conf < THRESHOLDS[risk].target) this.log.info(`step ${this.stepNo} send in the form of unsent text: target ${t.conf.toFixed(2)} passes the submit gate ${THRESHOLDS.submit.target}; the click needs the user's OK`);
    // A submit or destructive click needs a clear winner. A near tie between "Save" and "Save and publish" re-asks.
    if ((risk === "submit" || risk === "destructive") && t.runnerUp >= GATES.runnerUpRatio * t.conf) {
      ctx.gate = `ambiguous_runner_up ${t.runnerUp.toFixed(2)} >= ${GATES.runnerUpRatio} * ${t.conf.toFixed(2)} (${risk})`;
      this.stepBans.add(key);
      return { kind: "reask" };
    }
    const sig = `${obs.url}|${key}`;
    if ((this.sigCounts.get(sig) ?? 0) >= LIMITS.sigRepeatBan) {
      ctx.gate = `repeat ${action.id}`;
      bans.add(key);
      return { kind: "reask" };
    }
    // A value typed into a chip field that is not added yet: a fill of another field or a submit asks first (tokenGate).
    // A click that picks that value does not wait for it: an option or a control outside the form of the field whose
    // label holds the value ('Create "bug"', or the option that Enter picks). A control of that form still waits.
    const leaving = op === "TYPE_TEXT";
    if (leaving || (op === "CLICK" && (risk === "submit" || risk === "destructive"))) {
      const picks = (p: PendingToken): boolean => holdsText(action.label, p.e.text) && (OPTION_ROLES.has(action.role ?? "") || (action.form ?? null) !== p.e.form);
      const pend = this.pendingTokens(obs, leaving ? null : action.form ?? null, leaving ? action.node : null).filter((p) => leaving || !picks(p));
      const gated = await this.tokenGate(!leaving, pend, obs, ctx, () => this.stepBans.add(key));
      if (gated) return gated;
    }

    let text: string | null = null;
    let shown: string | null = null;
    let kept: string | null = null;
    let used: Span | null = null;
    let target = action;
    let at = obs;
    let gate = `ok ${t.conf.toFixed(2)} (${risk})`;
    let plan: EditPlan | undefined;
    if (op === "TYPE_TEXT") {
      // A multiline field that holds text that this run did not type: Jev chose if the new text replaces that text or
      // goes at its end. A low answer asks again; a replace of that text needs a higher one. There is no fallback to
      // replace: a document that loses its text must not be saved or sent. A value of none blocks in typedValue.
      if (action.node !== null && this.heldText(obs).has(action.node) && d.value !== undefined && d.value !== "none") {
        const e = d.edit;
        const name = e ? `${e.mode === "replace" ? "replace_all" : e.mode} ${e.conf.toFixed(2)}` : "missing";
        const need = `the task must say if the new text replaces the text of "${cutText(t.label, 60)}" or goes at its end`;
        if (!e || e.conf < GATES.editMode) { ctx.gate = `low_mode ${name} < ${GATES.editMode}; ${need}`; return { kind: "reask" }; }
        if (e.mode === "replace" && e.conf < GATES.editReplace) { ctx.gate = `low_mode ${name} < ${GATES.editReplace}; ${need}`; return { kind: "reask" }; }
        plan = { mode: e.mode };
        this.log.info(`step ${this.stepNo} edit ${name} for [${action.id}]`);
      }
      this.editPlan = plan;
      let typed: Typed;
      try { typed = await this.typedValue(d, t, action, obs, ctx, risk); } finally { this.editPlan = undefined; }
      if (typed.kind === "applied") return typed.applied;
      ({ span: used, obs: at, action: target } = typed);
      if (typed.gate !== null) gate = typed.gate;
      // A fill that replaces a value not added yet with another value asks first.
      const mine = this.typedToken.get(`${at.doc}|${target.node}`);
      if (mine && !holdsText(used.text, mine.text)) {
        const gated = await this.tokenGate(false, this.pendingTokens(at, null).filter((p) => p.e === mine && p.state === "draft"), at, ctx, () => this.stepBans.add(key));
        if (gated) return gated;
      }
      // An assistant wrote the task and the vars of an MCP run. Its text loses hidden characters, as generated text
      // does, so the page gets the text that the dialog shows. A secret value is typed exactly.
      text = this.deps.fromAssistant && !used.secret ? sanitizeText(used.text) : used.text;
      // Assistant-written text can be long. History and the StepRecord keep a short form; the page gets all of it.
      // Redact before the cut: a cut secret no longer matches the redactor.
      shown = used.secret ? SECRET_SHOWN : used.source === "generated" || this.deps.fromAssistant ? cutText(this.log.redactor(text), LIMITS.spanChars) : text;
      // History keeps the line breaks: a two-line message that reads as one line made Jev type it again.
      kept = used.secret || !(used.source === "generated" || this.deps.fromAssistant) ? shown : cutLines(this.log.redactor(text), LIMITS.spanChars);
      ctx.value = shown;
      // An append is not idempotent: Jev sees only the start of a field, not the text that this run added at its end. A
      // text that this run added, and that the field still ends with, is not typed again.
      const added = this.appended.get(`${at.doc}|${target.node}`) ?? [];
      if (plan?.mode === "append" && added.some((x) => loose(x) === loose(text as string)) && loose(target.value ?? "").endsWith(loose(text))) {
        ctx.gate = `"${cutText(t.label, 60)}" already ends with this text, which this run added; it is not typed again`;
        this.log.info(`step ${this.stepNo} ${ctx.gate}`);
        this.history.push({ action: cutText(target.label, LIMITS.nameChars), kind: "fill (already added)", text: kept, page_changed: false, step: this.stepNo, url: at.url, operation: "TYPE_TEXT" });
        return { kind: "record", rec: this.record(ctx, "skipped", "already added") };
      }
    }
    if (op === "SELECT") { ctx.value = action.label.split(" → ").slice(1).join(" → ") || action.label; ctx.valueConf = t.conf; }

    const desc = `${ctx.action} ${action.role ?? ""} "${t.label}"`.replace(/\s+/g, " ");
    ctx.gate = gate;
    // While a field holds unsent assistant text, every click needs a dialog: icon buttons and "Comment" are not risk words.
    const undo = this.unsentUndo();
    const gated = op === "CLICK" ? this.pruneUnsent(obs) : [];
    const denied = await this.confirmAction(risk, desc, ctx, top3(t.probs), at.url, gated, { obs: at, form: action.form });
    if (denied) return { kind: "record", rec: denied };
    // An autonomous fill that replaces text that the run did not type is in the audit: nobody saw the old text go.
    if (op === "TYPE_TEXT" && text !== null && this.cfg.confirm === "autonomous" && !this.cfg.dryRun) {
      // An append keeps the old text: it replaces nothing.
      const replaced = plan?.mode === "append" ? 0 : this.replacedChars(target, at);
      if (replaced > 0) {
        const label = cutText(flatText(this.log.redactor(target.label)), LIMITS.nameChars);
        ctx.unattended = { action: desc, host: hostOf(at.url), why: ["replaced"], texts: [{ label, text, chars: [...text].length, left: null }], fields: [], replaced_chars: replaced };
      }
    }

    const r = await this.execute(op, target, text, shown, at, ctx, kept, plan);
    // A stale action or a refused fill did not run: the entries that the check dropped on the old observation come back.
    if (r.kind === "stale" || (r.kind === "refused" && !r.changed)) undo();
    // A click on a send control (Send, Post, Reply, Comment, Publish, Share) with unsent text in a field can send it. A
    // destructive word alone is no send: "Delete draft" also takes the text out of the page.
    else if (op === "CLICK" && ran(r) && gated.length > 0 && hit(t.label, SEND_WORDS)) this.watchSend(gated, `click "${cutText(t.label, LIMITS.nameChars)}"`);
    // A fill whose next observation did not settle ran too: its text is in the page, and a later run must not send it
    // unseen.
    if (used && text !== null && r.kind === "record" && (r.rec.result === "ok" || r.ran === true)) this.filled(used, text, target, at, r.ran === true, r.appended === true);
    if (used && text !== null && r.kind === "record" && r.rec.result === "ok") this.tokenTyped(used, text, target, at);
    if (r.kind === "refused" && r.changed) {
      // The fill stopped after it changed the page: part of the text can be in the field. Block before any save or send.
      if (used && text !== null) this.filled(used, text, target, at, true, plan?.mode === "append");
      return { kind: "record", rec: this.blocked(ctx, "ambiguous", `the fill of "${cutText(t.label, 60)}" did not go as planned: ${r.message}. Check the field before any save or send`, [], at.url), ran: true };
    }
    if (op === "CLICK" && r.kind === "record" && r.rec.result === "ok") this.noteOpened(target, at, this.held, risk);
    return r;
  }

  /**
   * The span a TYPE_TEXT decision types. A task or --var span is used as chosen. `generate` asks the
   * user's assistant for new text, or takes the text it already wrote for this field.
   */
  private async typedValue(d: Decision, t: NonNullable<Decision["target"]>, action: Action, obs: Observation, ctx: StepCtx, risk: RiskClass): Promise<Typed> {
    const top = top3(d.operationProbs);
    const block = (kind: BlockedKind, hint: string): Typed => ({ kind: "applied", applied: { kind: "record", rec: this.blocked(ctx, kind, hint, top, obs.url) } });
    const chosen = d.value && d.value !== "none" ? d.value : null;
    if (chosen && "generate" in chosen) return this.generate(chosen.conf, t, action, obs, ctx, risk, top);

    const span = chosen ? this.spans.find((s) => s.id === chosen.spanId) : undefined;
    if (!chosen || !span) return block("needs_credential", this.credentialHint(`field "${t.label}"`, isCredential(action, t.label)));
    // A --var value is the user's own word for this run. A span cut from the task needs Jev's confidence, and so does a
    // var that an assistant wrote: in a plugin run it is the assistant's text, not the user's own word.
    const valueConf = span.source === "var" && !this.deps.fromAssistant ? 1 : chosen.conf;
    ctx.valueConf = valueConf;
    if (valueConf < THRESHOLDS[risk].value) {
      ctx.gate = `low_value ${valueConf.toFixed(2)} < ${THRESHOLDS[risk].value} (${risk})`;
      this.stepBans.add(actionKey(action));
      return REASK;
    }
    // A password, PIN, or code field takes only a secret --var value, never text cut from the task. The label, the input
    // type, or the autocomplete token (one-time-code, a password token) marks such a field.
    // A task and vars that an assistant wrote never fill a credential field.
    if (isCredential(action, t.label) && (!span.secret || this.deps.fromAssistant)) {
      return block("needs_credential", this.credentialHint(`field "${t.label}" is a credential and`, true));
    }
    // Assistant-written text goes only into the field it was written for.
    if (span.source === "generated" && span.field?.key !== `${obs.doc}|${action.node}`) {
      ctx.gate = `generated value ${span.id} belongs to "${span.field?.label ?? ""}"`;
      return REASK;
    }
    // One text per field: a text from a later request for a field that already got its text is never typed.
    const rec = span.source === "generated" ? this.typedText.get(`${obs.doc}|${action.node}`) : undefined;
    if (rec && span.field?.request !== rec.request) {
      ctx.gate = `"${t.label}" already got its text in this run; a run writes one text per field`;
      this.stepBans.add(actionKey(action));
      return REASK;
    }
    return { kind: "span", span, obs, action, gate: null };
  }

  /** The `generate` choice: the gates, the cache, one text request, and a new observation after the wait. */
  private async generate(conf: number, t: NonNullable<Decision["target"]>, action: Action, obs: Observation, ctx: StepCtx, risk: RiskClass, top: Top): Promise<Typed> {
    const block = (kind: BlockedKind, hint: string): Typed => ({ kind: "applied", applied: { kind: "record", rec: this.blocked(ctx, kind, hint, top, obs.url) } });
    const fieldKey = `${obs.doc}|${action.node}`;
    if (isCredential(action, t.label)) return block("needs_credential", this.credentialHint(`field "${t.label}" is a credential and`, true));
    if (!canWriteInto(action)) return block("needs_credential", `field "${t.label}" takes an exact value: ${this.valueHint(false)}`);
    ctx.valueConf = conf;
    if (conf < THRESHOLDS[risk].value) {
      ctx.gate = `low_value ${conf.toFixed(2)} < ${THRESHOLDS[risk].value} (${risk})`;
      this.stepBans.add(actionKey(action));
      return REASK;
    }
    const rec = this.typedText.get(fieldKey);
    // A field whose text a send of this run took out of the page gets no second text in this run. A re-ask asked again
    // at each step until the run stopped; the next text is a new step for the assistant.
    const sent = rec?.sent ?? this.sent.find((x) => `${x.doc}|${x.node}` === fieldKey);
    if (sent) return block("needs_text", `the text for "${sent.label}" was sent in step ${sent.step}; a run writes and sends one text per field. For the next text, call browse again`);
    // After a send, a text for another field needs a clear TYPE_TEXT decision. The fills of a second text after a send
    // had 0.33-0.48 (a workflow brief typed into the workflow title); the first fills had 0.57-0.94.
    if (this.sent.length > 0 && (ctx.operationConf ?? 0) < GATES.textAfterSend) {
      ctx.gate = `text after a send: TYPE_TEXT ${(ctx.operationConf ?? 0).toFixed(2)} < ${GATES.textAfterSend}`;
      this.stepBans.add(actionKey(action));
      return REASK;
    }
    // A field that already got its text in this run gets no new request: a second text would be typed again, and after
    // a send it would be sent again. Only the text of the request that wrote it can go in again.
    const cached = this.spans.find((s) => s.source === "generated" && s.field?.key === fieldKey && (!rec || s.field.request === rec.request));
    if (cached) return { kind: "span", span: cached, obs, action, gate: `generated ${cached.id} cached` };
    if (rec) {
      const now = squash(action.value ?? "");
      const reask = (gate: string): Typed => { ctx.gate = gate; this.stepBans.add(actionKey(action)); return REASK; };
      if (holdsText(now, rec.text)) return reask(`"${t.label}" already holds the text written for it`);
      // The fill did not stay: the page showed the field without the text right after it (an editor that dropped the
      // insert). The same text goes in one time more, with no new request. Any other loss can be a send.
      // Only into the same field (the same label and form: a page can reuse an element for another field), and only
      // when no click, Enter, select, or back ran after the fill. The span is not kept: a fill that does not run
      // leaves nothing that a later step could type.
      const same = rec.label === cutText(flatText(this.log.redactor(action.label)), LIMITS.nameChars) && rec.form === (action.form ?? null);
      if (!rec.stayed && !rec.retyped && !rec.acted && same && now === "") {
        const again: Span = { id: `g${++this.genSeq}`, text: rec.text, source: "generated", secret: false, field: { key: fieldKey, label: rec.label, request: rec.request ?? "" } };
        this.retypes.add(again.id);
        return { kind: "span", span: again, obs, action, gate: `generated ${again.id} again: the fill of the text written for "${t.label}" did not stay` };
      }
      if (!rec.stayed && !rec.acted && same) return reask(`the page did not keep the text written for "${t.label}"; a run writes one text per field`);
      return reask(`the text written for "${t.label}" was typed in this run and is not in the field now; a run writes one text per field`);
    }
    const writer = this.deps.text;
    if (!writer) return block("needs_text", "no assistant is attached to write text");
    if (this.textRequests >= LIMITS.textRequests) return block("needs_text", `text request limit reached (${LIMITS.textRequests})`);
    if (this.cfg.dryRun) {
      ctx.gate = "generate dry_run";
      this.log.info(`step ${this.stepNo} dry-run: text request for [${action.id}] "${t.label}"`);
      return { kind: "applied", applied: { kind: "record", rec: this.record(ctx, "skipped", "dry_run") } };
    }

    // A request never lists a field that has a text: a live generated value, or a text that a fill typed in this run.
    const doc = `${obs.doc}|`;
    const bound = new Set<number>();
    for (const s of this.spans) if (s.field?.key.startsWith(doc)) bound.add(Number(s.field.key.slice(doc.length)));
    for (const k of this.typedText.keys()) if (k.startsWith(doc)) bound.add(Number(k.slice(doc.length)));
    // Nor a field whose text a send of this run took out of the page.
    for (const x of this.sent) if (x.doc === obs.doc && x.node !== null) bound.add(x.node);
    const picked = pickFields(obs, action, { banned: new Set([...this.bansFor(obs.url), ...this.stepBans]), bound }, this.log.redactor, this.editPlan);
    const fields = picked.map((p) => p.field);
    const req = buildTextRequest({ id: `t${++this.textRequests}`, task: this.cfg.task, obs, history: this.history, fields, redactor: this.log.redactor, sent: this.sentTexts() });
    this.log.info(`step ${this.stepNo} text request ${req.id}: ${fields.map((f) => `${f.id} "${f.label}"`).join(", ")}`);
    const t0 = this.now();
    const reply = await writer.write(req, { timeoutMs: LIMITS.textWaitMs, check: (v) => checkTexts(v, fields, this.spans).errors });
    const waited = this.now() - t0;
    this.waitedMs += waited;
    if (this.cancelled) return block("human_aborted", CANCELLED);
    if (reply.kind === "declined") return block("needs_text", `the assistant declined: ${cutText(flatText(reply.reason), 200)}`);
    if (reply.kind === "timeout") return block("needs_text", `no text after ${Math.round(LIMITS.textWaitMs / 1000)} s`);
    if (reply.kind === "aborted") return block("human_aborted", "the run was cancelled during a text request");
    const checked = checkTexts(reply.values, fields, this.spans);
    const errors = Object.entries(checked.errors);
    // The hint names the field and the rule. It never holds the text.
    if (errors.length > 0) return block("needs_text", `text rejected: ${errors.map(([id, rule]) => `${fields.find((f) => f.id === id)?.label ?? id}: ${rule}`).join("; ")}`);

    // Every text is bound to its own field before any page work. A re-ask or a later step finds it there.
    let own: Span | null = null;
    for (const p of picked) {
      const value = checked.values[p.field.id];
      if (value === undefined) continue;
      const span: Span = { id: `g${++this.genSeq}`, text: value, source: "generated", secret: false, field: { key: `${obs.doc}|${p.action.node}`, label: p.field.label, request: req.id } };
      this.spans.push(span);
      this.written.push({ label: p.field.label, typed: false });
      if (p.action === action) own = span;
    }
    if (!own) return block("needs_text", `text rejected: ${fields[0]?.label ?? "f1"}: text is required`);

    // The page often changes during a long wait. Observe again and type only on the same document and field state.
    let next: Observation;
    try {
      next = await this.observeSettled();
    } catch (e) {
      if (e instanceof StalePage) return block("ambiguous", "page keeps changing");
      throw e;
    }
    ctx.url = next.url; ctx.title = next.title;
    if (next.doc !== obs.doc) {
      // The texts are bound to fields of the old document. No field of the new one can take them.
      this.spans = this.spans.filter((s) => !(s.source === "generated" && s.field?.request === req.id));
      ctx.gate = `a new page loaded during the wait, so the text for "${t.label}" was dropped`;
      return REASK;
    }
    const again = next.actions.find((a) => a.kind === "fill" && a.node === action.node);
    if (!again || again.value !== action.value) {
      ctx.gate = `text for "${t.label}" is ready as typed value ${own.id}; the page changed during the wait`;
      return REASK;
    }
    return { kind: "span", span: own, obs: next, action: again, gate: `generated ${own.id} ${req.id} ok ${t.conf.toFixed(2)} (${risk}) wait ${(waited / 1000).toFixed(1)}s` };
  }

  /**
   * After a fill: record unsent assistant text, and consume a generated span. It is used one time.
   * A fill replaces the entry of its field. A value that does not count as assistant text keeps a field that
   * held such text gated, and the entry then shows what the field holds now. A fill that did not stay keeps the
   * pending entries of its field: the page can hold their texts too.
   * `unknown`: the fill ran, but the observation after it did not settle. The entry is pending.
   * `appended`: the fill added the text at the end of the field's text. It stayed only when the field shows the typed
   * text: the field held text before, so a value that is not empty shows nothing.
   */
  private filled(span: Span, typed: string, action: Action, obs: Observation, unknown = false, appended = false): void {
    const generated = span.source === "generated";
    if (span.source === "var") this.usedVars.add(span.id);
    this.typedInto.set(`${obs.doc}|${action.node}`, typed);
    const mine = (u: Unsent): boolean => u.doc === obs.doc && u.node === action.node;
    const old = this.unsent.find(mine);
    // The observation right after the fill tells if the page kept the text. A field out of view counts as kept. A
    // control that held the text before the fill, with the same value now, does not count: the text did not go there.
    const after = this.held;
    const shown = after?.actions.find((a) => a.kind === "fill" && a.node === action.node);
    const same = after !== null && after.doc === obs.doc;
    const had = (obs.texts ?? []).filter(([n, v]) => n !== action.node && holdsText(v, typed));
    const before = had.map(([n]) => n);
    const was = new Map(obs.texts ?? []);
    const held = same && (after.texts ?? []).some(([n, v]) => (!before.includes(n) || was.get(n) !== v) && holdsText(v, typed));
    // `unknown`: the fill ran, but no observation after it settled. Nothing shows where the text is now.
    const shows = appended ? holdsText(shown?.value ?? "", typed) : squash(shown?.value ?? "") !== "";
    const stayed = !unknown && (!same || !shown || shows || held);
    // A pending entry: the page can hold its text where the control does not show it. A fill that did not stay either
    // does not take that text out of the page, so the pending entry stays next to the new one.
    const kept = stayed ? [] : this.unsent.filter((u) => mine(u) && u.pending);
    this.unsent = [...this.unsent.filter((u) => !mine(u)), ...kept];
    // The controls that held the text before the fill, with their values then. Never for a secret value.
    const prior = had.length > 0 && !span.secret ? { before: had } : {};
    if (typed.trim() !== "") {
      if (generated || (this.deps.fromAssistant && action.multiline === true && !span.secret)) {
        const label = span.field?.label ?? cutText(flatText(this.log.redactor(action.label)), LIMITS.nameChars);
        this.unsent.push({ doc: obs.doc, node: action.node, label, text: typed, request: span.field?.request ?? null, ...prior, ...(stayed ? {} : { pending: true as const }) });
      } else if (old) {
        const { pending: _pending, overwritten: _overwritten, before: _before, ...rest } = old;
        this.unsent.push({ ...rest, text: span.secret ? SECRET_SHOWN : typed, ...prior, ...(stayed || kept.length === 0 ? {} : { pending: true as const }) });
      }
    }
    if (generated) {
      const key = `${obs.doc}|${action.node}`;
      const prev = this.typedText.get(key);
      const label = span.field?.label ?? cutText(flatText(this.log.redactor(action.label)), LIMITS.nameChars);
      const request = span.field?.request ?? null;
      const retyped = this.retypes.has(span.id) || (prev?.request === request && (prev?.retyped ?? false));
      const rec: TypedText = { doc: obs.doc, node: action.node, label, text: typed, request, form: action.form ?? null, before, stayed, retyped, acted: false };
      this.typedText.set(key, rec);
      // A page can move the text into another control at the insert (a pop-out composer): the record applies there
      // too. Only when the text left the typed field: a control that copies it (a mirror, an excerpt) is another field.
      const left = same && !(after.texts ?? []).some(([n, v]) => n === action.node && holdsText(v, typed));
      if (same && left) for (const [n, v] of after.texts ?? []) if (n !== action.node) this.moveTyped({ doc: obs.doc }, n, v, rec);
      this.spans = this.spans.filter((s) => s !== span);
      // A fill that did not stay does not count as typed: the result then names the field in text_not_typed. A later
      // observation that shows the text at the record's control counts it (`seeTyped`). A fill with no settled
      // observation after it counts: the text ran into the page.
      const w = this.written.find((x) => x.label === span.field?.label && !x.typed);
      if (w && (stayed || unknown)) w.typed = true;
    }
  }

  /**
   * Update the unsent entries before a click or Enter and return the ones that gate it: each entry whose text
   * is still in a field of its document.
   * - An entry drops when the document changed, or when its field is in view and empty and no other field holds
   *   the text. The unused generated values of its request drop too: the send ended the binding. An own entry that a
   *   moved text overwrote does not drop: it stays with no field.
   * - A field out of view still holds its text while `filled` lists its node.
   * - A page can remove a field and show the same text in a new one (tabs, virtual lists, pop-out editors). A
   *   rendered control that holds the text then takes the entry: first one that holds exactly the text, then one
   *   without an entry of its own, then one with an entry. A text that the page changed goes to a control without an
   *   entry of its own first. A control is another entry's only while it holds that entry's text. A control that held
   *   the text before the fill, with the same value now, does not take it, and neither does a control whose value
   *   comes from a text that this run typed there. The record of the typed text applies there too.
   * - One control shows each text once. When several entries are on one control and it holds the text of some of
   *   them, the others move to a control that holds their text, or go: the page wrote a moved text over theirs. The
   *   control's own entry gives way only when a moved text is all that the control holds.
   * - A pending entry (a fill that did not stay, with no click or Enter since) gates, in view or not, also next to an
   *   entry with the same text.
   * - An entry whose field is gone and whose text is in no rendered control does not gate. It stays, and it
   *   gates again when a control of the document holds the text again.
   */
  private pruneUnsent(obs: Observation): Unsent[] {
    const valueOf = (node: number | null): string => {
      const f = obs.actions.find((a) => a.kind === "fill" && a.node === node);
      return f ? f.value ?? "" : obs.texts?.find(([n]) => n === node)?.[1] ?? "";
    };
    // A control is another entry's only while it holds that entry's text: a sent or overwritten entry whose control
    // now shows a new text does not keep that text out.
    const owned = new Set(this.unsent.filter((u) => u.doc === obs.doc && u.node !== null && holdsText(valueOf(u.node), u.text)).map((u) => u.node));
    // Each entry's record, read before any move: a move of one entry must not change what another entry moves.
    const recOf = new Map(this.unsent.map((u) => [u, this.typedText.get(`${u.doc}|${u.node}`)] as const));
    // A control that held the text before the fill, with the same value now, did not take it. A new value there can be
    // the text that the page moved. A control whose value comes from a text that this run typed there did not take it
    // either: a later search query or reply that contains a sent short reply.
    const takes = (u: Unsent, node: number, value: string): boolean =>
      node !== u.node && !(u.before ?? []).some(([n, v]) => n === node && v === value) && holdsText(value, u.text) && !this.ownText(obs.doc, node, value, u.text);
    const placed: { u: Unsent; active: boolean; from?: Unsent }[] = [];
    for (const u of this.unsent) {
      const drop = (): void => {
        if (u.request !== null) this.spans = this.spans.filter((s) => !(s.source === "generated" && s.field?.request === u.request));
      };
      if (obs.doc !== u.doc) { drop(); continue; }
      // `actions` lists only controls in view.
      const field = obs.actions.find((a) => a.kind === "fill" && a.node === u.node);
      const holds = field ? (field.value ?? "").trim() !== "" : u.node !== null && (obs.filled?.includes(u.node) ?? false);
      if (holds) { placed.push({ u, active: true, from: u }); continue; }
      const want = squash(u.text);
      const found = (obs.texts ?? []).filter(([node, value]) => takes(u, node, value));
      // A control that holds exactly this text first, then one without an entry of its own: a longer text of
      // another entry can hold this text too ("Meeting on Tuesday" inside the reply). A text that the page changed
      // (bullets, smart quotes, a length limit) comes last: first onto a control without an entry of its own, then onto
      // another entry's control (a pop-out that keeps its own text and adds the changed reply). Pass 2 then keeps the
      // own entry of that control, so the dialog shows both texts.
      const exact = found.filter(([, v]) => inWords(squash(v), want));
      const moved = found.find(([, v]) => squash(v) === want) ?? exact.find(([n]) => !owned.has(n)) ?? exact[0] ?? found.find(([n]) => !owned.has(n)) ?? found[0];
      if (moved) {
        this.moveTyped(u, moved[0], moved[1], recOf.get(u));
        const { pending: _pending, ...rest } = u;
        placed.push({ u: { ...rest, node: moved[0] }, active: true, from: u });
        continue;
      }
      // A fill that did not stay, with no click or Enter after it: the page can hold the text where the control does
      // not show it (an editor with its model outside the control), in view or not. It gates this action.
      if (u.pending) { placed.push({ u, active: true, from: u }); continue; }
      if (field) {
        drop();
        // A moved text went over this text in its control. The empty control shows that the moved text went, not this
        // one: the entry stays with no field, and it gates again when a control shows its text.
        if (u.overwritten) placed.push({ u: { ...u, node: null }, active: false });
        continue;
      }
      placed.push({ u, active: false });
    }
    // One entry per text in a control, and only the entries whose text the control holds when one of them does (the
    // page moved a text over another one). The dialog shows each text once, and it shows the text that will go.
    const out: { u: Unsent; active: boolean; from?: Unsent }[] = [];
    for (const p of placed) {
      if (!p.active) { out.push(p); continue; }
      // A pending entry that did not move is a copy that the page can hold: it always gates, also next to an entry
      // with the same text (a retype that did not stay either, or a later text for the field).
      if (p.u.pending && p.from === p.u) { out.push(p); continue; }
      const peers = placed.filter((o) => o.active && o.u.node === p.u.node);
      if (peers.length === 1) { out.push(p); continue; }
      if (peers.findIndex((o) => squash(o.u.text) === squash(p.u.text)) !== peers.indexOf(p)) continue;
      const value = valueOf(p.u.node);
      const shows = (o: Unsent): boolean => holdsText(value, o.text);
      // The control's own entry stays unless a moved text is all that the control holds: a page that changes the new
      // text (a mention chip) must not let a short sent text that it contains take the dialog.
      const whole = (o: Unsent): boolean => squash(value) === squash(o.text) || loose(value) === loose(o.text);
      const own = p.from === p.u && !peers.some((o) => o !== p && whole(o.u));
      const shown = shows(p.u);
      // The own entry stays, but the control shows only another entry's text: the page wrote that text over this one.
      if (own && !shown && peers.some((o) => o !== p && shows(o.u))) { out.push({ ...p, u: { ...p.u, overwritten: true } }); continue; }
      if (own || shown || !peers.some((o) => shows(o.u))) { out.push(p); continue; }
      // The control shows another entry's text. This entry's text can be in a third control: it gates there.
      const elsewhere = (obs.texts ?? []).find(([n, v]) => takes(p.u, n, v));
      const { pending: _pending, ...moved } = p.u;
      if (elsewhere) { this.moveTyped(p.u, elsewhere[0], elsewhere[1], p.from ? recOf.get(p.from) : undefined); out.push({ u: { ...moved, node: elsewhere[0] }, active: true }); }
      // No control holds its text now. The entry stays, with no field: it gates again when a control holds the text.
      else out.push({ u: { ...p.u, node: null }, active: false });
    }
    // An overwritten entry whose control shows its text again is an entry like any other. A moved entry is on a control
    // that shows its text, so this also ends the flag after a move.
    const back = (u: Unsent): Unsent => {
      if (!u.overwritten || u.node === null || !holdsText(valueOf(u.node), u.text)) return u;
      const { overwritten: _overwritten, ...rest } = u;
      return rest;
    };
    const next = out.map((p) => ({ u: this.ageBefore(obs, back(p.u)), active: p.active }));
    this.unsent = next.map((p) => p.u);
    // A moved record can show a text that the field showed late.
    this.seeTyped(obs);
    return next.filter((p) => p.active).map((p) => p.u);
  }

  /**
   * A before pair holds only while every observation shows its control with the same value. A control that the page
   * emptied or changed can later hold the moved text, also when its value is the old value again. A control that the
   * observation does not show (out of view and not in `texts`) keeps its pair.
   */
  private ageBefore(obs: Observation, u: Unsent): Unsent {
    if (u.doc !== obs.doc || !u.before || u.before.length === 0) return u;
    const now = (n: number): string | undefined => {
      const f = obs.actions.find((a) => a.kind === "fill" && a.node === n);
      if (f) return f.value ?? "";
      return obs.texts?.find(([m]) => m === n)?.[1];
    };
    const pairs = u.before.filter(([n, v]) => { const x = now(n); return x === undefined || x === v; });
    if (pairs.length === u.before.length) return u;
    const { before: _before, ...rest } = u;
    return pairs.length > 0 ? { ...rest, before: pairs } : rest;
  }

  /**
   * The value of a control comes from a text that this run typed there, and that typed text holds `text`. The control
   * still shows the typed text, or every word of it and more than `text` (a mention chip changed the typed text). And
   * the control holds `text` no more times than the typed text does: a second copy came from somewhere else. A sent
   * short reply ("Sure") then does not move into a later search query or reply that contains it as a word.
   */
  private ownText(doc: number | undefined, node: number, value: string, text: string): boolean {
    const typed = this.typedInto.get(`${doc}|${node}`);
    if (typed === undefined || !holdsText(typed, text)) return false;
    const copies = (s: string): number => Math.max(wordHits(squash(s), squash(text)), wordHits(loose(s), loose(text)));
    if (copies(value) > copies(typed)) return false;
    if (holdsText(value, typed)) return true;
    const words = (s: string): string[] => loose(s).match(/[\p{L}\p{N}]+/gu) ?? [];
    const have = new Set(words(value));
    return words(typed).every((w) => have.has(w)) && squash(value) !== squash(text) && loose(value) !== loose(text);
  }

  /**
   * A fill that did not stay counts as typed when a later observation shows its text at its record's control: its
   * field, or a control that took its record (the field showed the text late). A dialog or an allowed click is no
   * proof: an editor that dropped the insert shows the text only in the dialog. Another value in the field is no proof
   * either.
   */
  private seeTyped(obs: Observation): void {
    const doc = `${obs.doc}|`;
    for (const [key, rec] of this.typedText) {
      if (rec.stayed || !key.startsWith(doc)) continue;
      const node = Number(key.slice(doc.length));
      const f = obs.actions.find((a) => a.kind === "fill" && a.node === node);
      const value = f ? f.value ?? "" : obs.texts?.find(([n]) => n === node)?.[1] ?? "";
      if (!holdsText(value, rec.text)) continue;
      const w = this.written.find((x) => x.label === rec.label && !x.typed);
      if (w) w.typed = true;
    }
  }

  /**
   * A text that moved to another control keeps its record there too: a generate for either control finds it, also
   * when the control adds words to the text (a signature, an "@name"). The record goes only onto a control that holds
   * its text and did not hold it before the fill (a longer text that already contained it is another field), and never
   * over a record whose text the control still holds.
   */
  private moveTyped(u: Pick<Unsent, "doc">, node: number, value: string, r: TypedText | undefined): void {
    const to = `${u.doc}|${node}`;
    const there = this.typedText.get(to);
    if (!r || there === r || r.before.includes(node) || !holdsText(value, r.text) || (there && holdsText(value, there.text))) return;
    this.typedText.set(to, r);
  }

  /**
   * Marks the chip fields of this run (`TokenFacts.learned`) on a copy of `obs`. A multiselect listbox counts for the
   * rest of the run: react-select links its listbox only while the menu is open.
   */
  private markTokens(obs: Observation): Observation {
    let marked = false;
    const actions = obs.actions.map((a) => {
      if (!a.token || a.node === null) return a;
      const key = `${obs.doc}|${a.node}`;
      if (a.token.multi) this.tokenFields.add(key);
      if (!this.tokenFields.has(key) || a.token.learned) return a;
      marked = true;
      return { ...a, token: { ...a.token, learned: true as const } };
    });
    return marked ? { ...obs, actions } : obs;
  }

  /**
   * After a click or Enter on the same document and URL:
   * - A field whose draft the action cleared, with a new chip before it in its box (an element with text and a named
   *   remove control), is a chip field for the rest of the run: strong evidence. Enter counts only in the focused field.
   *   A chat that sends its message to a list outside the box, an inline editor whose input goes away, and a search box
   *   that keeps its query do not qualify.
   * - A click on an element that holds a pending value, after which the draft no longer holds it, picked that value:
   *   the entry ends.
   * - Enter in a field with weak evidence used its value: the entry ends.
   */
  private learnTokens(obs: Observation, next: Observation, clicked: Action | null): void {
    if (next.doc !== obs.doc || next.url !== obs.url) return;
    for (const a of obs.actions) {
      if (a.kind !== "fill" || !a.token || a.node === null || (a.value ?? "").trim() === "" || (!clicked && a.node !== obs.focus?.node)) continue;
      const b = next.actions.find((x) => x.kind === "fill" && x.node === a.node);
      if (!b?.token || (b.value ?? "").trim() !== "") continue;
      const had = new Set(a.token.items.map(([id]) => id));
      if (!b.token.items.some(([id, text, kind]) => !had.has(id) && kind === 2 && text !== "")) continue;
      const key = `${obs.doc}|${a.node}`;
      if (!this.tokenFields.has(key)) this.log.info(`step ${this.stepNo} chip field: "${cutText(this.log.redactor(a.label), LIMITS.nameChars)}" added a value as a chip`);
      this.tokenFields.add(key);
    }
    for (const [key, e] of this.typedToken) {
      if (e.doc !== obs.doc) continue;
      const b = next.actions.find((x) => x.kind === "fill" && x.node === e.node);
      if (clicked) {
        if (holdsText(clicked.label, e.text) && !holdsText(b?.value ?? "", e.text)) this.typedToken.delete(key);
      } else if (obs.focus?.node === e.node && !this.tokenFields.has(key) && !(b && tokenEvidence(b) === "strong")) this.typedToken.delete(key);
    }
  }

  /**
   * After a fill: record a typed value in a chip field. The field has evidence on the observation after the fill, or a
   * popup opened next to it with the fill (weak evidence). A popup that another field showed before the fill can still
   * lie next to this field: it did not open with the fill. A secret or assistant-written value is never recorded. A fill
   * ends the earlier entry of its field.
   */
  private tokenTyped(span: Span, typed: string, action: Action, obs: Observation): void {
    if (action.node === null) return;
    const key = `${obs.doc}|${action.node}`;
    this.typedToken.delete(key);
    const after = this.held;
    if (span.secret || span.source === "generated" || typed.trim() === "" || !after || after.doc !== obs.doc) return;
    const now = after.actions.find((a) => a.kind === "fill" && a.node === action.node);
    if (!now?.token) return;
    const opened = now.token.popup === true && !obs.actions.some((a) => a.token?.popup === true);
    if (tokenEvidence(now) === null && !opened) return;
    this.typedToken.set(key, {
      doc: obs.doc, node: action.node, label: cutText(flatText(this.log.redactor(action.label)), LIMITS.nameChars), text: typed,
      form: action.form ?? null, popup: now.token.popup === true, picks: false, hinted: false,
    });
  }

  /**
   * Where the value of a chip-field entry is on `obs`:
   * - added: a chip before the field holds it; or the draft is blank and any element before the field holds it.
   * - draft: the draft holds it, and no chip does.
   * - lost: the draft is blank, and nothing before the field holds it (react-select clears the draft on blur).
   * - gone: another document, the field is gone, or the field holds another value.
   * A field out of view shows only its value: its draft holds the value, or the entry is gone.
   */
  private tokenState(e: TypedToken, obs: Observation): { state: "draft" | "lost" | "added" | "gone"; field?: Action } {
    if (obs.doc !== e.doc) return { state: "gone" };
    const field = obs.actions.find((a) => a.kind === "fill" && a.node === e.node);
    if (!field) {
      const value = obs.texts?.find(([n]) => n === e.node)?.[1];
      return { state: value !== undefined && holdsText(value, e.text) ? "draft" : "gone" };
    }
    const items = field.token?.items ?? [];
    const draft = field.value ?? "";
    if (holdsText(draft, e.text)) return { state: items.some(([, t, k]) => k > 0 && holdsText(t, e.text)) ? "added" : "draft", field };
    if (draft.trim() !== "") return { state: "gone", field };
    return { state: items.some(([, t]) => holdsText(t, e.text)) ? "added" : "lost", field };
  }

  /**
   * The pending chip-field entries of `obs` in `form` (every form when null), other than the field `except`. An entry
   * that is added or gone ends here.
   */
  private pendingTokens(obs: Observation, form: number | null, except: number | null = null): PendingToken[] {
    const out: PendingToken[] = [];
    for (const [key, e] of this.typedToken) {
      const s = this.tokenState(e, obs);
      if (s.state === "added" || s.state === "gone") { this.typedToken.delete(key); continue; }
      if (e.node === except || (form !== null && e.form !== form)) continue;
      const strong = this.tokenFields.has(key) || (s.field !== undefined && tokenEvidence(s.field) === "strong");
      out.push({ key, e, state: s.state, field: s.field, strong });
    }
    return out;
  }

  /**
   * The chip-field gate before a fill of another field (`submit` false), or before a submit click, Enter in another
   * field, or DONE (`submit` true). `pend`: the pending values in scope. Null when none of them gates the action.
   * 1. Read the popup of the field (`Page.popup`). The observation settled after the last input (the causal settle);
   *    when a script Enter can follow, the read focuses the field first and settles again after that focus.
   * 2. A strong value in its draft, with no option in the popup and no popup that opened and closed again: a script
   *    Enter adds it, and the step asks again on the new page. With options, Enter can pick an option instead of the
   *    typed value ("bug" became "debug"), so code never presses it then.
   * 3. Else ask again with a hint that names the field and the value. The hint bans the gated action for the re-ask on
   *    strong evidence only. A weak value gets its hint one time; then the action goes on, so a search box with
   *    suggestions keeps working.
   * 4. A strong value still pending after its hint: a fill of another field goes on, and a submit, Enter, or DONE
   *    blocks. The form is never sent without the value.
   */
  private async tokenGate(submit: boolean, pend: PendingToken[], obs: Observation, ctx: StepCtx, ban: () => void): Promise<Applied | null> {
    const p = pend.find((x) => !x.e.hinted || (x.strong && submit));
    if (!p) return null;
    const label = p.field ? cutText(flatText(this.log.redactor(p.field.label)), LIMITS.nameChars) : p.e.label;
    const value = cutText(this.log.redactor(p.e.text), LIMITS.spanChars);
    const holds = p.state === "draft" ? `"${label}" holds "${value}", which is not added yet` : `"${label}" lost "${value}": the field is empty, and no chip holds it`;
    if (p.e.hinted) return { kind: "record", rec: this.blocked(ctx, "ambiguous", `typed value not added: ${holds}. The form is not sent without it`, [], obs.url) };
    if (p.field) {
      const may = p.strong && p.state === "draft" && !p.e.picks && !this.cfg.dryRun;
      const pop = await (this._page as Page).popup(p.field, may);
      if (this.cancelled) return { kind: "record", rec: this.cancel(ctx, obs.url) };
      if (pop?.open) p.e.popup = true;
      if (pop && pop.picks.length > 0) p.e.picks = true;
      if (may && pop !== null && pop.picks.length === 0 && !pop.busy && (pop.open || !p.e.popup)) {
        const added = await this.gateCommit(p, label, value, obs, ctx);
        if (added) return added;
      }
    }
    p.e.hinted = true;
    if (p.strong) ban();
    ctx.gate = `${holds}. If it belongs there, ${p.state === "lost" ? "type it again, then " : ""}click its matching suggestion or press Enter in that field`;
    this.log.info(`step ${this.stepNo} chip gate (${p.strong ? "strong" : "weak"}): ${ctx.gate}`);
    return { kind: "reask" };
  }

  /**
   * The gate's script Enter, on a new observation. Added: the step asks again on the new page. Wrong or cleared: blocked.
   * Null when the page ignored the key or kept the value: the hint follows.
   */
  private async gateCommit(p: PendingToken, label: string, value: string, obs: Observation, ctx: StepCtx): Promise<Applied | null> {
    let now: Observation;
    try {
      now = await this.observeSettled();
    } catch (e) {
      if (e instanceof StalePage) return { kind: "record", rec: this.blocked(ctx, "ambiguous", "page keeps changing", [], obs.url) };
      throw e;
    }
    const s = this.tokenState(p.e, now);
    if (s.state !== "draft" || !s.field) return { kind: "stale", message: `the page changed while the popup of "${label}" settled` };
    const c = await this.commitToken(s.field, p.e.text, now, false, label, `Enter in "${label}"`, value);
    if (c.result === "added") {
      this.typedToken.delete(p.key);
      this.log.info(`step ${this.stepNo} chip gate: a script Enter added "${value}" to "${label}"`);
      return { kind: "stale", message: `"${label}" held "${value}"; a script Enter added it as a chip` };
    }
    if (c.result === "wrong" || c.result === "cleared") return { kind: "record", rec: this.blocked(ctx, "ambiguous", c.hint, [], now.url) };
    return null;
  }

  /**
   * A script Enter on a chip field (`Page.commit`), then the check on the next observation. `list`: the popup listed
   * options, so Enter can have picked one, and a new chip must hold the value. With no list, any new chip counts: a
   * free-text commit cannot pick another value. The new chip is read with its title, aria-label, and data-* values, so a
   * chip that shows a display name for an email address still matches.
   * - added: the draft no longer holds the value, and a new element with text appeared before the field in its box; or
   *   a chip already held the value and the page cleared the repeat.
   * - ignored: the key did not reach the field (the page changed first, or the field lost focus), or the page did not
   *   handle it: not prevented, and the draft and the box stayed the same.
   * - kept: the page handled the key and kept the value in the draft (it refused the value).
   * - wrong: an option list was open, and the new chip does not hold the value.
   * - cleared: the value left the draft and no chip holds it, or the field or the document went away.
   * A handled key adds the history entry `action` with the text `text`.
   */
  private async commitToken(field: Action, value: string, obs: Observation, list: boolean, label: string, action: string, text: string | null): Promise<TokenCommit> {
    const page = this._page as Page;
    let res: Awaited<ReturnType<Page["commit"]>>;
    try {
      res = await page.commit(field, obs);
    } catch (e) {
      if (e instanceof StalePage) return { result: "ignored", next: null, hint: "" };
      throw e;
    }
    if ("skipped" in res) return { result: "ignored", next: null, hint: "" };
    const shown = cutText(this.log.redactor(value), LIMITS.spanChars);
    let next: Observation;
    try {
      next = await this.observeSettled();
    } catch (e) {
      if (e instanceof StalePage) return { result: "cleared", next: null, hint: `page keeps changing after Enter in "${label}"` };
      throw e;
    }
    const now = next.doc === obs.doc && next.url === obs.url ? next.actions.find((a) => a.kind === "fill" && a.node === field.node) : undefined;
    const had = new Set((field.token?.items ?? []).map(([id]) => id));
    const fresh = (now?.token?.items ?? []).filter(([id, t]) => !had.has(id) && t !== "");
    if (!res.prevented && now && squash(now.value ?? "") === squash(field.value ?? "") && fresh.length === 0) return { result: "ignored", next, hint: "" };
    this.history.push({ action, kind: "key", text, page_changed: next.fingerprint !== obs.fingerprint, step: this.stepNo, url: next.url, operation: "PRESS_ENTER" });
    if (!now) return { result: "cleared", next, hint: `Enter in "${label}" changed the page, and no chip holds "${shown}"` };
    const hit = fresh.some(([, t]) => holdsText(t, value));
    const wrong = { result: "wrong" as const, next, hint: `Enter in "${label}" added "${cutText(this.log.redactor(fresh[0]?.[1] ?? ""), LIMITS.nameChars)}", not "${shown}"` };
    if (holdsText(now.value ?? "", value)) return fresh.length > 0 && list && !hit ? wrong : { result: "kept", next, hint: "" };
    if (fresh.length > 0) return list && !hit ? wrong : { result: "added", next, hint: "" };
    if ((now.token?.items ?? []).some(([, t]) => holdsText(t, value))) return { result: "added", next, hint: "" };
    return { result: "cleared", next, hint: `Enter in "${label}" took "${shown}" out of the field, and no chip holds it` };
  }

  /**
   * Jev's Enter in a chip field with strong evidence and a draft: a script Enter first. It cannot submit the form, so it
   * has the data_entry risk. When the page handled it, the step ends there, and a wrong or lost value blocks. Null when
   * the page did not handle it: the trusted Enter follows with its own risk and gates, so Enter-to-search still works.
   * Unsent assistant text keeps the trusted path, whose dialog shows the text.
   */
  private async enterToken(d: Decision, field: Action, obs: Observation, ctx: StepCtx): Promise<Applied | null> {
    if (d.operationConf < THRESHOLDS.data_entry.target || this.unsent.length > 0 || this.cfg.dryRun || field.node === null) return null;
    const key = `${obs.doc}|${field.node}`;
    const value = this.typedToken.get(key)?.text ?? field.value ?? "";
    const label = cutText(flatText(this.log.redactor(field.label)), LIMITS.nameChars);
    const pop = await (this._page as Page).popup(field);
    const c = await this.commitToken(field, value, obs, pop !== null && pop.picks.length > 0, label, "PRESS_ENTER", null);
    if (c.result === "ignored") return null;
    ctx.action = "press_key"; ctx.value = "Enter"; ctx.risk = "data_entry";
    ctx.gate = `ok ${d.operationConf.toFixed(2)} (data_entry) script Enter ${c.result}`;
    for (const r of this.typedText.values()) r.acted = true;
    if (c.next) this.held = c.next;
    if (c.result === "wrong" || c.result === "cleared") return { kind: "record", rec: this.blocked(ctx, "ambiguous", c.hint, top3(d.operationProbs), obs.url) };
    if (c.result === "added") this.typedToken.delete(key);
    return { kind: "record", rec: this.record(ctx, "ok", null) };
  }

  /** Restores the unsent entries, the generated spans, and the record keys that `pruneUnsent` changes. */
  private unsentUndo(): () => void {
    const unsent = this.unsent;
    const spans = this.spans;
    const typed = new Map(this.typedText);
    return () => {
      this.unsent = unsent;
      this.spans = spans;
      this.typedText.clear();
      for (const [k, r] of typed) this.typedText.set(k, r);
    };
  }

  /**
   * A button with a send word in the form of a field that shows unsent assistant text, in a run where the click needs a
   * person's OK: confirm auto or always. A run without a dialog then blocks needs_confirmation at the click, with the
   * hint to do the action in Chrome, not "ambiguous". Any other confirm setting keeps the destructive gate.
   */
  private sendInForm(action: Action, label: string, obs: Observation): boolean {
    const form = action.form ?? null;
    if (action.role !== "button" || form === null || !hit(label, SEND_WORDS)) return false;
    if (this.cfg.confirm !== "auto" && this.cfg.confirm !== "always") return false;
    return this.unsent.some((u) => u.doc === obs.doc && obs.actions.some((f) => f.kind === "fill" && f.node === u.node && (f.form ?? null) === form && holdsText(f.value ?? "", u.text)));
  }

  /**
   * `gated`: the unsent entries that hold text now. A non-empty list makes the action need a dialog, and the dialog shows
   * them. `at`: the observation of the action and the form of its target, for the fields of an audit entry.
   */
  private async confirmAction(risk: RiskClass, desc: string, ctx: StepCtx, top: Top, url: string, gated: Unsent[] = [], at?: { obs: Observation; form: number | null | undefined }): Promise<StepRecord | null> {
    const autonomous = this.cfg.confirm === "autonomous";
    // An autonomous run audits every submit too: nobody saw it go.
    const needsConfirm = risk === "destructive" || (risk === "submit" && (this.cfg.confirm === "always" || autonomous)) || gated.length > 0;
    if (!needsConfirm || this.cfg.dryRun) return null;
    if (autonomous) {
      // The user's own words turned off every dialog of this run, also for long text. The action goes on, and its
      // record keeps what went out with nobody to see it. execute() keeps the audit only when the input ran.
      const why: UnattendedAction["why"] = [...(risk === "destructive" || risk === "submit" ? [risk] : []), ...(gated.length > 0 ? ["unsent_text" as const] : [])];
      ctx.gate = "autonomous";
      ctx.unattended = {
        action: desc, host: hostOf(url), why,
        texts: gated.map((u) => ({ label: u.label, text: u.text, chars: [...u.text].length, left: null, ...(u.earlier ? { earlier_run: true as const } : {}) })),
        fields: at ? this.auditFields(at.obs, at.form, gated.map((u) => u.node)) : [],
      };
      return null;
    }
    // The confirm argument, not the session, stops the dialog. Its hint names that argument.
    if (this.cfg.confirm === "never") {
      return this.blocked(ctx, "needs_confirmation", `${risk} action ${desc}: ${this.deps.hints?.confirmNever ?? this.deps.hints?.noConfirm ?? NO_CONFIRM_HINT}`, top, url);
    }
    if (!this.deps.human.interactive) {
      // A headless window is not visible, so the user cannot do the action there. That hint says so.
      const hint = (!this.cfg.headed ? this.deps.hints?.noConfirmHeadless : undefined) ?? this.deps.hints?.noConfirm ?? NO_CONFIRM_HINT;
      return this.blocked(ctx, "needs_confirmation", `${risk} action ${desc}: ${hint}`, top, url);
    }
    const chars = gated.reduce((n, u) => n + u.text.length, 0);
    if (chars > LIMITS.confirmTextChars) return this.blocked(ctx, "needs_confirmation", `the unsent text is too long to show in one dialog (${chars} characters)`, top, url);
    // The dialog shows every unsent text in full. The CLI and chat have no unsent text, so `typed` is empty there.
    const detail = redactData({ kind: "action" as const, action: desc, host: hostOf(url), typed: gated.map((u) => ({ label: u.label, text: u.text })) }, this.log.redactor);
    const ok = await this.deps.human.confirm(this.log.redactor(`About to ${desc} on ${url}. Type y to allow: `), LIMITS.confirmPromptMs, detail);
    if (this.cancelled) return this.cancel(ctx, url);
    if (!ok) return this.blocked(ctx, "needs_confirmation", `the user did not allow ${desc}`, top, url);
    ctx.gate = "confirmed";
    return null;
  }

  /**
   * The non-empty fields that an audit entry lists: the fields of `form` (the fields in view when the form is not known),
   * without the controls of `skip` (their text is in the entry) and without credential, secret, and payment fields.
   */
  private auditFields(obs: Observation, form: number | null | undefined, skip: (number | null)[]): UnattendedAction["fields"] {
    const out: UnattendedAction["fields"] = [];
    for (const a of obs.actions) {
      if (out.length >= AUDIT_FIELDS) break;
      if (a.kind !== "fill" || skip.includes(a.node) || (form !== null && form !== undefined && (a.form ?? null) !== form)) continue;
      const value = a.value ?? "";
      if (value.trim() === "" || isCredential(a, a.label) || PRIVATE_LABEL.test(a.label) || PRIVATE_AUTOCOMPLETE.test(a.autocomplete ?? "")) continue;
      out.push({ label: cutText(flatText(this.log.redactor(a.label)), LIMITS.nameChars), value: cutText(this.log.redactor(value), AUDIT_VALUE_CHARS) });
    }
    return out;
  }

  /** The characters of the value that a fill of `a` replaces: 0 for an empty field, and for a value that this run typed there. */
  private replacedChars(a: Action, obs: Observation): number {
    const old = a.value ?? obs.texts?.find(([n]) => n === a.node)?.[1] ?? "";
    if (old.trim() === "") return 0;
    const own = this.typedInto.get(`${obs.doc}|${a.node}`);
    return own !== undefined && squash(own) === squash(old) ? 0 : [...old].length;
  }

  /**
   * After an audited action: true when no control of `after` holds `text`, or a new document loaded; false when a control
   * holds it; null when `before` did not show it either (a pending entry), so nothing shows where it went. A control that
   * held the text and is hidden now (a modal popover sets aria-hidden on the form) keeps it while `filled` lists its node.
   */
  private leftAfter(text: string, before: Observation, after: Observation): boolean | null {
    if (after.doc !== before.doc) return true;
    if (holders(after, text).length > 0) return false;
    const had = holders(before, text);
    if (had.length === 0) return null;
    return had.some((n) => n !== null && (after.filled?.includes(n) ?? false)) ? false : true;
  }

  /** An audited action whose input or next observation threw can have run: its record, with the audit, goes into the result. */
  private keepAudit(ctx: StepCtx, audit: UnattendedAction | null, e: unknown): void {
    if (!audit) return;
    ctx.unattended = audit;
    const rec = this.record(ctx, "failed", `may have run: ${String((e as Error | null)?.message ?? e)}`);
    this.result.steps.push(rec);
    this.log.step(rec);
  }

  /**
   * Execute one operation, observe again, push history. `shown` is the redacted text for logs; `kept`, when set, for
   * history. `plan`: the edit plan of a fill (default replace).
   */
  private async execute(op: string, action: Action | null, text: string | null, shown: string | null, obs: Observation, ctx: StepCtx, kept: string | null = shown, plan?: EditPlan): Promise<Applied> {
    const page = this._page as Page;
    ctx.action = ACTION_OF[op] ?? "none";
    // The audit of an action with no dialog holds only when the input ran: a stale or cancelled action writes none.
    const audit = ctx.unattended;
    ctx.unattended = null;
    if (this.cancelled) return { kind: "record", rec: this.cancel(ctx, obs.url) };
    if (!ctx.gate || /^(low_|Enter confidence|ambiguous_runner_up|repeat )/.test(ctx.gate)) ctx.gate = "ok";
    if (op === "PRESS_ENTER") ctx.value = "Enter";
    // A later action ends the watch of a send: a fill, a click, or a scroll can take a text out of the page that the
    // send did not take. WAIT keeps it.
    if (this.sendWatch && this.sendWatch.step < this.stepNo && op !== "WAIT") this.sendWatch = null;
    if (this.cfg.dryRun) {
      ctx.gate += " dry_run";
      this.log.info(`step ${this.stepNo} dry-run: ${op}${action ? ` [${action.id}] "${action.label}"` : ""}${shown !== null ? ` value="${shown}"` : ""}`);
      return { kind: "record", rec: this.record(ctx, "skipped", "dry_run") };
    }
    let control: Action | null = action;
    if (op === "SCROLL_DOWN" || op === "SCROLL_UP" || op === "WAIT") {
      control = obs.actions.find((a) => a.id === op.toLowerCase()) ?? null;
      if (!control && op !== "WAIT") return { kind: "record", rec: this.record(ctx, "failed", `${op} is not available on this page`) };
    }
    let next: Observation | null = null;
    let edited: EditResult | void = undefined;
    try {
      if (op === "PRESS_ENTER") await page.press("Enter", obs);
      else if (op === "GO_BACK") await page.back(LIMITS.settleDomMs);
      else if (op === "WAIT") next = await this.waitForChange(obs, control);
      else if (control) edited = await page.act(control, obs, text ?? undefined, plan);
    } catch (e) {
      if (e instanceof StalePage) {
        const a = control ?? action;
        return a ? { kind: "stale", message: e.message, action: a } : { kind: "stale", message: e.message };
      }
      if (e instanceof EditRefused && control) {
        // A fill that changed the page before the refusal ran in part: it keeps its audit, as an input that threw does.
        if (e.changed) ctx.unattended = audit;
        return { kind: "refused", message: e.message, changed: e.changed, action: control };
      }
      this.keepAudit(ctx, audit, e);
      throw e;
    }
    ctx.unattended = audit;
    // The mode that ran: an empty field is replaced. A page adapter without a result ran the plan.
    const appended = op === "TYPE_TEXT" && text !== null && (edited ? edited.mode === "append" : plan?.mode === "append");
    if (appended && control) {
      const key = `${obs.doc}|${control.node}`;
      this.appended.set(key, [...(this.appended.get(key) ?? []), text]);
    }
    if (action) {
      const sig = `${obs.url}|${actionKey(action)}`;
      this.sigCounts.set(sig, (this.sigCounts.get(sig) ?? 0) + 1);
    }
    // A text typed earlier can go out with this action: it is never typed again.
    if (op === "CLICK" || op === "PRESS_ENTER" || op === "SELECT" || op === "GO_BACK") for (const r of this.typedText.values()) r.acted = true;
    // Only a click or Enter ends a pending entry: it asked with the text in the dialog. A select or back asked nothing,
    // so the next click still asks.
    if (op === "CLICK" || op === "PRESS_ENTER") this.unsent = this.unsent.map(({ pending: _pending, ...u }) => u);

    // An append shows in history as "fill (append)": Jev sees only the start of the field, not the end that got the text.
    const kind = op === "PRESS_ENTER" ? "key" : op === "GO_BACK" ? "back" : appended ? "fill (append)" : control ? control.kind : "wait";
    const entry: FastHistoryEntry = {
      action: cutText(action ? action.label : control && op !== "WAIT" ? control.label : op, LIMITS.nameChars),
      kind, text: kept, page_changed: null, step: this.stepNo, url: obs.url, operation: op,
    };
    this.history.push(entry);
    // The action ran. A post-action observation that does not settle must not erase it: the history
    // entry stays, and the run blocks only after the observe retries.
    if (next === null) {
      try {
        next = await this.observeSettled();
      } catch (e) {
        if (e instanceof StalePage) return { kind: "record", rec: this.blocked(ctx, "ambiguous", "page keeps changing", [], obs.url), ran: true };
        this.keepAudit(ctx, audit, e);
        throw e;
      }
    }
    if (op === "CLICK" || op === "PRESS_ENTER") {
      this.learnTokens(obs, next, op === "CLICK" ? action : null);
      next = this.markTokens(next);
    }
    if (audit) {
      const after = next;
      ctx.unattended = { ...audit, texts: audit.texts.map((t) => ({ ...t, left: this.leftAfter(t.text, obs, after) })) };
    }
    entry.page_changed = next.fingerprint !== obs.fingerprint;
    entry.url = next.url;
    this.held = next;
    // An append that lost text of the field, or whose text the field does not show, must not be saved or sent.
    const lost = appended && edited ? appendLost(text as string, edited) : null;
    if (lost !== null) {
      this.log.warn(`step ${this.stepNo} append check failed: ${lost}`);
      return { kind: "record", rec: this.blocked(ctx, "ambiguous", `the fill of "${cutText(control?.label ?? "", 60)}" did not go as planned: ${lost}. Check the field before any save or send`, [], next.url), ran: true, appended: true };
    }
    return { kind: "record", rec: this.record(ctx, "ok", null), ...(appended ? { appended: true as const } : {}) };
  }

  private async finish(d: Decision, obs: Observation, ctx: StepCtx): Promise<StepRecord> {
    if (this.goal === "act") {
      if (d.pDone >= GATES.done) {
        this.confidence = d.pDone;
        this.reason = `done ${d.pDone.toFixed(2)}`;
        ctx.gate = "done";
        return this.record(ctx, "done", null);
      }
      this.doneBannedUntil = this.stepNo + LIMITS.doneSuppressSteps;
      ctx.gate = "done_low";
      this.log.info(`step ${this.stepNo} DONE at ${d.pDone.toFixed(2)} below ${GATES.done}; DONE banned for ${LIMITS.doneSuppressSteps} steps`);
      return this.record(ctx, "skipped", `done_p ${d.pDone.toFixed(2)}`);
    }
    if (this.goal === "check") {
      const as = d.answerState;
      if (as && as.conf >= GATES.check && (as.choice === "yes" || as.choice === "no")) {
        this.answer = { kind: "check", answer: as.choice === "yes", probability: Number(as.pYes.toFixed(3)), evidence: d.evidence ? [d.evidence] : [] };
        this.confidence = as.conf;
        this.reason = `answer_state ${as.choice} ${as.conf.toFixed(2)}`;
        ctx.gate = "check_done";
        return this.record(ctx, "done", null);
      }
      const holds = (this.checkHolds.get(obs.fingerprint) ?? 0) + 1;
      this.checkHolds.set(obs.fingerprint, holds);
      if (holds >= GATES.checkHolds) {
        const top = as ? top3(as.probs) : [];
        this.answer = { kind: "check", answer: "unknown", probability: Number((as?.pYes ?? 0).toFixed(3)), evidence: d.evidence ? [d.evidence] : [], top };
        this.confidence = as?.conf ?? null;
        this.reason = `answer_state ${as?.choice ?? "missing"} stayed below ${GATES.check} after ${holds} holds`;
        ctx.gate = "check_unknown";
        return this.record(ctx, "done", null);
      }
      this.doneBannedUntil = this.stepNo + 1;
      ctx.gate = "check_hold";
      this.log.info(`step ${this.stepNo} hold: answer_state ${as?.choice ?? "missing"}@${(as?.conf ?? 0).toFixed(2)} below ${GATES.check} (${holds}/${GATES.checkHolds})`);
      return this.record(ctx, "skipped", "check_hold");
    }
    const line = d.answerLine;
    const visible = d.answerVisible ?? 0;
    if (visible >= GATES.extractFinal && line && line !== "none" && line.conf >= GATES.answerLine) {
      this.answer = { kind: "extract", text: line.text, line_id: line.key, evidence: [line.text] };
      this.confidence = line.conf;
      this.reason = `answer_line ${line.conf.toFixed(2)} visible ${visible.toFixed(2)}`;
      ctx.gate = "extract_done";
      return this.record(ctx, "done", null);
    }
    this.doneBannedUntil = this.stepNo + 2;
    ctx.gate = "extract_not_visible";
    this.log.info(`step ${this.stepNo} extract: visible=${visible.toFixed(2)} line=${line && line !== "none" ? `${line.key}@${line.conf.toFixed(2)}` : "none"}; DONE banned for 2 steps`);
    return this.record(ctx, "skipped", "extract_not_visible");
  }

  private async handoff(ctx: StepCtx, kind: "needs_sign_in" | "captcha", top: Top, obs: Observation): Promise<StepRecord> {
    const cfg = this.cfg;
    // An autonomous run that no person attends does not wait for one: it blocks at once.
    if (cfg.confirm === "autonomous" && !(this.deps.attended ?? this.deps.human.interactive)) {
      return this.blocked(ctx, kind, this.deps.hints?.unattendedWall ?? UNATTENDED_WALL_HINT, top, obs.url);
    }
    // A headed run pauses with or without a TTY: Human.pause polls the page when no key can arrive.
    if (cfg.headed && this.pauses < LIMITS.pauses) {
      this.pauses += 1;
      const poll = async (): Promise<boolean> => {
        const o = await (this._page as Page).observe();
        const state = { goal: cfg.task, page: { url: o.url, title: o.title, text: o.text.slice(0, LIMITS.textCharsMin) } };
        const questions = { wall: choice("What is this page?", { signin_wall: "A sign-in, password, 2FA, or account-chooser page", app_page: "A normal page of the site, signed in" }) };
        const w = choiceOf((await this.deps.oracle.ask("wall", state, questions)).answers, "wall");
        return Boolean(w && w.choice === "app_page" && w.confidence >= GATES.wall);
      };
      const what = kind === "captcha" ? "Solve the check in the Chrome window" : "Sign in in the Chrome window";
      const r = await this.deps.human.pause(`(${kind}): ${what}, then press Enter here. Press q to stop. Timeout ${Math.round(cfg.pauseTimeoutMs / 1000)}s.`, cfg.pauseTimeoutMs, poll, kind === "captcha" ? "captcha" : "sign_in");
      if (this.cancelled) return this.cancel(ctx, obs.url);
      if (r === "resumed") {
        this.history.push({ action: "user signed in", kind: "open", text: null, page_changed: true, step: this.stepNo, url: obs.url, operation: "HUMAN_SIGNIN" });
        ctx.gate = kind;
        return this.record(ctx, "paused", null);
      }
      if (r === "aborted") return this.blocked(ctx, "human_aborted", "the user pressed q during the pause", top, obs.url);
    }
    const hint = cfg.headed ? "pause used up or timed out; sign in first, then run again" : this.deps.hints?.headed ?? HEADED_HINT;
    return this.blocked(ctx, kind, hint, top, obs.url);
  }

  private blocked(ctx: StepCtx, kind: BlockedKind, hint: string, top: Top, url: string | null): StepRecord {
    this.setBlocked(kind, hint, top, url);
    ctx.gate = ctx.gate || kind;
    return this.record(ctx, "blocked", hint);
  }

  private record(ctx: StepCtx, result: StepRecord["result"], error: string | null): StepRecord {
    const u = ctx.unattended ? redactData(ctx.unattended, this.log.redactor) : null;
    if (u) {
      const texts = u.texts.map((t) => `${t.label} (${t.chars} chars, ${t.left === true ? "left the page" : t.left === false ? "still in a field" : "not known"})`);
      this.log.warn(`step ${this.stepNo} unattended: ${u.action} (${u.why.join(", ")})${texts.length > 0 ? `; texts: ${texts.join(", ")}` : ""}${u.replaced_chars ? `; replaced ${u.replaced_chars} chars` : ""}`);
    }
    return {
      step: this.stepNo, url: ctx.url, title: ctx.title, page_kind: ctx.pageKind, page_kind_conf: ctx.pageKindConf, done_p: ctx.doneP,
      operation: ctx.operation, operation_conf: ctx.operationConf, target: ctx.target, target_conf: ctx.targetConf, runner_up: ctx.runnerUp,
      action: ctx.action, value: ctx.value, value_conf: ctx.valueConf, risk: ctx.risk, path: "fast", gate: ctx.gate, result,
      error: error ? this.log.redactor(error) : null, jev_requests: this.deps.oracle.stats.requests - ctx.req0, duration_ms: this.now() - ctx.t0,
      ...(u ? { unattended: u } : {}),
    };
  }
}
