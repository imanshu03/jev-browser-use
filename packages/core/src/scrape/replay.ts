// Replay of the recorded steps of a scraper with the fast engine's Page. No Jev: each step names its control by role
// and name, and code finds it in the snapshot. A step whose control does not show fails the replay, and the heal
// ladder takes over. A sign-in wall or a captcha pauses a headed run for the user, else the run is blocked.
import { hostOf } from "../fast/generate.js";
import type { Action, Observation, Page } from "../fast/model.js";
import { EditRefused, StalePage } from "../fast/model.js";
import type { Human, Logger } from "../io.js";
import { AUTH_HOST, LIMITS, SIGN_IN_HEADING } from "../types.js";
import { hasWord, normText } from "./parse.js";
import type { Step, Target } from "./spec.js";
import { fillTemplate } from "./spec.js";

/** A step waits this long for its control to show. JEV_SCRAPE_STEP_MS overrides it. */
export const STEP_MS = 8_000;
/** The observe interval while a step waits for its control. */
export const POLL_MS = 250;
/** An optional click (a banner) waits only this long: most runs have no banner. */
export const OPTIONAL_MS = 1_000;
/** A wait for a text waits this long when the step does not say. */
export const WAIT_TEXT_MS = 8_000;
/** Observes again after a StalePage, per step. */
export const STALE_RETRIES = 3;
/** A pause at a wall waits this long for the user. */
export const PAUSE_MS = 300_000;
/** Pauses per replay. */
const PAUSES = 2;

/** The roles that take typed text. */
const FILL_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "textarea"]);
/** Text of a bot check. */
const CAPTCHA = /captcha|are you a robot|verify you are human|unusual traffic|just a moment/i;

export type Wall = "sign_in" | "captcha";

/** The step timeout of the environment: JEV_SCRAPE_STEP_MS (1000-120000), else 8000. */
export function stepTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env["JEV_SCRAPE_STEP_MS"]);
  return Number.isFinite(n) && n >= 1000 && n <= 120_000 ? n : STEP_MS;
}

/**
 * A wall that a person must pass (code only): a captcha when the title or the text reads like a bot check; a sign-in
 * wall when the host is an auth host or the title a sign-in heading.
 */
export function wallOf(obs: Pick<Observation, "url" | "title" | "text">): Wall | null {
  if (CAPTCHA.test(obs.title) || CAPTCHA.test(obs.text)) return "captcha";
  if (AUTH_HOST.test(hostOf(obs.url)) || SIGN_IN_HEADING.test(obs.title)) return "sign_in";
  return null;
}

/** The hint of a blocked run. */
export function wallHint(wall: Wall): string {
  return wall === "captcha"
    ? "A captcha blocks the page. Run again with --headed and solve it when the run pauses"
    : "The site asks to sign in. Run again with --headed and sign in when the run pauses";
}

/** The control name of an action: a select without its " → <option>" part. */
function controlName(a: Action): string {
  return a.kind === "select" ? (a.label.split(" → ")[0] ?? a.label) : a.label;
}

function optionName(a: Action): string {
  return a.label.split(" → ").slice(1).join(" → ");
}

/**
 * The action of a step target on an observation, or null (pure). The name is filled with the params and compared in
 * normalized form by `match`. A click takes actions with the target's role; a fill any text role; a select the select
 * controls (one per element). With `under`, controls in a popup come first. `nth` counts in snapshot order. A click
 * whose role no longer matches takes the one clickable action with the exact name (role relax).
 */
export function findTarget(obs: Observation, target: Target, params: Record<string, string>, op: "click" | "fill" | "select" = "click"): Action | null {
  const want = normText(fillTemplate(target.name, params));
  const match = target.match ?? "exact";
  const hit = (label: string): boolean => {
    const n = normText(label);
    return match === "exact" ? n === want : match === "starts" ? n.startsWith(want) : n.includes(want);
  };
  let pool: Action[];
  if (op === "select") {
    const seen = new Set<number | null>();
    pool = obs.actions.filter((a) => a.kind === "select" && !seen.has(a.node) && (seen.add(a.node), true));
  } else if (op === "fill") pool = obs.actions.filter((a) => a.kind === "fill" && FILL_ROLES.has(a.role ?? ""));
  else pool = obs.actions.filter((a) => a.kind === "click" && a.role === target.role);
  let found = pool.filter((a) => hit(controlName(a)));
  if (found.length === 0 && op === "click") {
    const exact = obs.actions.filter((a) => a.kind === "click" && normText(a.label) === want);
    return exact.length === 1 ? exact[0] ?? null : null;
  }
  if (target.under) {
    const inPopup = found.filter((a) => (a.popup?.length ?? 0) > 0);
    if (inPopup.length > 0) found = inPopup;
  }
  return found[target.nth ?? 0] ?? null;
}

/** A value that is this short, or a number of 1-4 digits (a day, a month, a year), shows in a page by chance: no proof. */
const WEAK_VALUE = /^(?:.{0,2}|\d{1,4})$/su;

/**
 * The step to go on from when the control of step `i` is missing, or null. A step that sets a value that the profile
 * keeps (a delivery location, a pincode) shows its control only while the value is not set: the site shows the value
 * in its place. So the replay can go on at the first later step whose control is on the page now, when the steps in
 * between fill values (at least one fill) and each of those values shows now as a whole word of the page text or of a
 * field value. An action label is no proof: each option of a select is an action whose label holds the option list.
 * A short or small-number value is no proof. A control whose name holds one of those values shows the value that is
 * set (the header "Koramangala"), so it is not the step to go on from. A select step in between stops the skip: a
 * select shows on the page whatever its value, so a missing one means that the site changed, and the run heals. Steps
 * in between that only click are no proof either: a click whose control moved or was renamed still fails.
 */
export function skipAhead(obs: Observation, steps: readonly Step[], i: number, params: Record<string, string>): number | null {
  const shown = [normText(obs.text), ...obs.actions.filter((a) => a.kind === "fill").map((a) => normText(a.value ?? ""))];
  for (let j = i + 1; j < steps.length; j++) {
    const s = steps[j] as Step;
    if (s.op !== "click" && s.op !== "fill" && s.op !== "select") continue;
    const action = findTarget(obs, s.target, params, s.op);
    if (!action) continue;
    const values: string[] = [];
    for (const x of steps.slice(i, j)) {
      if (x.op === "select") return null;
      if (x.op !== "fill") continue;
      try { values.push(normText(fillTemplate(x.value, params))); } catch { return null; }
    }
    if (values.length === 0 || values.some((v) => WEAK_VALUE.test(v))) return null;
    const label = normText(action.label);
    if (values.some((v) => label.includes(v))) continue;
    return values.every((v) => shown.some((t) => hasWord(t, v))) ? j : null;
  }
  return null;
}

export interface ReplayOptions {
  log: Logger;
  /** Default STEP_MS. */
  stepTimeoutMs?: number;
  pollMs?: number;
  /** A person who can pass a wall: only an interactive human in a headed run pauses. */
  human?: Human;
  headed?: boolean;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** A back step waits this long for the page. Default LIMITS.openTimeoutMs. */
  navTimeoutMs?: number;
  /** The name of the scraper, for the pause message. */
  name?: string;
}

export type ReplayResult =
  | { ok: true; steps: number }
  /** `step`: the 0-based index of the step that failed. */
  | { ok: false; step: number; reason: string; wall: Wall | null };

type StepOutcome = { kind: "ok" } | { kind: "missing"; obs: Observation; reason: string } | { kind: "failed"; reason: string } | { kind: "skip"; to: number; reason: string };

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function describe(step: Step & { target: Target }, params: Record<string, string>): string {
  let name: string;
  try { name = fillTemplate(step.target.name, params); } catch { name = step.target.name; }
  return `${step.op === "fill" ? "field" : step.op === "select" ? "select" : step.target.role} ${JSON.stringify(name)}`;
}

/** Replay the steps on the page. Never throws: a step that fails gives its index and the reason. */
export async function replaySteps(page: Page, steps: readonly Step[], params: Record<string, string>, opts: ReplayOptions): Promise<ReplayResult> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? (() => Date.now());
  const stepMs = opts.stepTimeoutMs ?? STEP_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  let pauses = 0;

  const targeted = async (step: Step & { target: Target }, n: number): Promise<StepOutcome> => {
    const op = step.op === "fill" ? "fill" : step.op === "select" ? "select" : "click";
    const optional = step.op === "click" && step.optional === true;
    const t0 = now();
    const deadline = t0 + (optional ? Math.min(OPTIONAL_MS, stepMs) : stepMs);
    let stale = 0;
    for (;;) {
      const obs = await page.observe();
      const action = findTarget(obs, step.target, params, op);
      // A value that the profile keeps is set already: go on at the later step. Only after a short wait, so that a
      // control that renders late still gets its step.
      if (!action && !optional && now() - t0 >= OPTIONAL_MS) {
        const to = skipAhead(obs, steps, n - 1, params);
        if (to !== null) return { kind: "skip", to, reason: `step ${n}: no ${describe(step, params)}; steps ${n}-${to} skipped: the page shows their values already` };
      }
      if (action) {
        try {
          if (step.op === "fill") await page.act(action, obs, fillTemplate(step.value, params), { mode: "replace" });
          else if (step.op === "select") {
            const value = normText(fillTemplate(step.value, params));
            const same = obs.actions.filter((a) => a.kind === "select" && a.node === action.node);
            if (same.some((a) => normText(a.current_value ?? "") === value)) return { kind: "ok" };
            const option = same.find((a) => normText(optionName(a)) === value);
            if (!option) return { kind: "failed", reason: `step ${n}: ${describe(step, params)} has no option ${JSON.stringify(fillTemplate(step.value, params))}` };
            await page.act(option, obs);
          } else await page.act(action, obs);
          return { kind: "ok" };
        } catch (e) {
          if (e instanceof StalePage && stale < STALE_RETRIES) { stale += 1; continue; }
          if (e instanceof StalePage) return { kind: "failed", reason: `step ${n}: the page kept changing at ${describe(step, params)}` };
          if (e instanceof EditRefused) return { kind: "failed", reason: `step ${n}: ${describe(step, params)} refused the text: ${e.message}` };
          throw e;
        }
      }
      if (now() >= deadline) {
        if (optional) { opts.log.debug(`step ${n}: optional ${describe(step, params)} is not there; skipped`); return { kind: "ok" }; }
        return { kind: "missing", obs, reason: `step ${n}: no ${describe(step, params)}` };
      }
      await sleep(pollMs);
    }
  };

  const run = async (step: Step, n: number): Promise<StepOutcome> => {
    switch (step.op) {
      case "click": case "fill": case "select": return targeted(step, n);
      case "press": await page.press(step.key); return { kind: "ok" };
      case "back": await page.back(opts.navTimeoutMs ?? LIMITS.openTimeoutMs); return { kind: "ok" };
      case "scroll": {
        const id = step.direction === "up" ? "scroll_up" : "scroll_down";
        for (let t = 0, stale = 0; t < (step.times ?? 1);) {
          const obs = await page.observe();
          const action = obs.actions.find((a) => a.id === id);
          if (!action) break;
          try { await page.act(action, obs); t += 1; } catch (e) {
            if (e instanceof StalePage && stale < STALE_RETRIES) { stale += 1; continue; }
            throw e;
          }
        }
        return { kind: "ok" };
      }
      case "wait": {
        if (!step.for_text) { await sleep(step.ms ?? 1000); return { kind: "ok" }; }
        const want = normText(fillTemplate(step.for_text, params));
        const deadline = now() + (step.ms ?? WAIT_TEXT_MS);
        for (;;) {
          const obs = await page.observe();
          if (normText(obs.text).includes(want)) return { kind: "ok" };
          if (now() >= deadline) { opts.log.debug(`step ${n}: the text ${JSON.stringify(want)} did not show; the replay goes on`); return { kind: "ok" }; }
          await sleep(pollMs);
        }
      }
    }
  };

  for (let i = 0; i < steps.length; i++) {
    if (opts.signal?.aborted) return { ok: false, step: i, reason: `step ${i + 1}: aborted`, wall: null };
    const step = steps[i] as Step;
    let out: StepOutcome;
    try { out = await run(step, i + 1); } catch (e) {
      return { ok: false, step: i, reason: `step ${i + 1}: ${step.op} failed: ${(e as Error)?.message ?? String(e)}`, wall: null };
    }
    if (out.kind === "ok") continue;
    if (out.kind === "skip") { opts.log.info(out.reason); i = out.to - 1; continue; }
    if (out.kind === "failed") return { ok: false, step: i, reason: out.reason, wall: null };
    const wall = wallOf(out.obs);
    if (!wall) return { ok: false, step: i, reason: out.reason, wall: null };
    if (opts.human?.interactive && opts.headed && pauses < PAUSES) {
      pauses += 1;
      const what = wall === "captcha" ? "Solve the captcha" : "Sign in";
      const poll = async (): Promise<boolean> => { try { return wallOf(await page.observe()) === null; } catch { return false; } };
      const res = await opts.human.pause(`(${wall}): ${what} in the browser window${opts.name ? ` for the scraper ${opts.name}` : ""}, then press Enter here. Press q to stop. Timeout ${Math.round(PAUSE_MS / 1000)}s.`, PAUSE_MS, poll, wall);
      if (res === "resumed") { i -= 1; continue; }
    }
    return { ok: false, step: i, reason: `step ${i + 1}: ${wall === "captcha" ? "a captcha" : "a sign-in wall"} blocks the page`, wall };
  }
  return { ok: true, steps: steps.length };
}
