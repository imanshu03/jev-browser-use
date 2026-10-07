// The real Session: Chrome and Jev through the jev-browser-use library.
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import {
  FastRunner, LIMITS, baseRunConfig, browserOf, createBrowser, createHuman, createLogger, createNavigator, defaultUserDataDir,
  listProfiles, replaySteps, riskOf, stepsFromRecords, wordsFor,
} from "@imanshu03/jev-browser-use";
import type { Browser, BrowserKind, Logger, NavigatorDeps, Page, ReplayGuardInput, RunConfig } from "@imanshu03/jev-browser-use";
import { DEFAULT_POLICY } from "./load.js";
import type { Policy } from "./load.js";
import type { ConfigDef } from "./schema.js";
import type { JevOutcome, ReplayOptions, ReplayOutcome, Session, SessionFactory } from "./session.js";
import type { Secrets } from "./template.js";

export interface EngineOptions {
  config: ConfigDef;
  secrets: Secrets;
  processEnv: NodeJS.ProcessEnv;
  headed: boolean;
  /** Directory for the jev log of each session. */
  logDir: string;
  /** global.yaml for the environment of the run. Default: every action allowed, built-in words only. */
  policy?: Policy;
  /** The environment name, for the reasons of refused actions. */
  envName?: string | null;
}

/** The env that jev-browser-use reads: the Jev key, and the OpenAI-compatible endpoint of the config as the text model. */
export function engineEnv(config: ConfigDef, processEnv: NodeJS.ProcessEnv, llmInstructions = ""): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...processEnv };
  if (config.jev.api_key) env["TYPESAFE_API_KEY"] = config.jev.api_key;
  env["TYPESAFE_DEFAULT_MODEL"] = config.jev.model;
  const textModel = config.llm.text_model ?? config.llm.model;
  if (config.llm.base_url && textModel) {
    env["JEV_TEXT_BASE_URL"] = config.llm.base_url.replace(/\/+$/, "");
    env["JEV_TEXT_MODEL"] = textModel;
    env["JEV_TEXT_API_KEY"] = config.llm.api_key || "none";
    if (llmInstructions) env["JEV_TEXT_INSTRUCTIONS"] = llmInstructions;
    else delete env["JEV_TEXT_INSTRUCTIONS"];
  }
  return env;
}

/** Why the environment does not allow a click or Enter with this label, or null when it does. Autonomous allows all. */
export function refusal(policy: Policy, envName: string | null, input: ReplayGuardInput): string | null {
  if (policy.confirm === "autonomous") return null;
  const own = riskOf("CLICK", input.label, wordsFor(policy.actions, input.url));
  // Enter submits its form as the Jev loop counts it: a submit unless it runs a search, destructive with a dangerous label.
  const risk = input.kind === "enter" && own !== "destructive" ? (input.search ? "navigational" : "submit") : own;
  const refused = risk === "destructive" || (risk === "submit" && policy.confirm === "always");
  if (!refused) return null;
  const what = `${risk === "destructive" ? "dangerous" : "submit"} ${input.kind === "enter" ? "Enter on" : "click on"} ${JSON.stringify(input.label)}`;
  return `confirm is ${policy.confirm} for this suite${envName ? ` in the ${envName} environment` : ""}, so the run does not do the ${what}`;
}

/** The hint of a Jev run that blocked on an action that the confirm mode does not allow. */
function confirmHint(policy: Policy, envName: string | null): string {
  return `confirm is ${policy.confirm} for this suite${envName ? ` in the ${envName} environment` : ""}. To allow it, change confirm or the actions words in global.yaml, the environment, or the suite file`;
}

function lineStream(write: (line: string) => void): Writable {
  let buf = "";
  return new Writable({
    write(chunk, _enc, cb) {
      buf += String(chunk);
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { write(buf.slice(0, i)); buf = buf.slice(i + 1); }
      cb();
    },
  });
}

/** In-page script: focus the visible input or textarea whose label, aria-label, placeholder, or name is `field`, and select its text. */
export function focusFieldScript(field: string): string {
  return `(() => {
    const norm = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/\\s+/g, " ").trim().replace(/\\s*[:*]+$/, "");
    const want = norm(${JSON.stringify(field)});
    const names = (e) => {
      const out = [e.getAttribute("aria-label"), e.getAttribute("placeholder"), e.getAttribute("name"), e.id];
      for (const l of e.labels || []) out.push([...l.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "), l.textContent);
      for (const id of (e.getAttribute("aria-labelledby") || "").split(/\\s+/)) { const t = id && document.getElementById(id); if (t) out.push(t.textContent); }
      return out.map(norm).filter(Boolean);
    };
    const fields = [...document.querySelectorAll("input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea")]
      .filter((e) => !e.disabled && !e.readOnly && e.checkVisibility && e.checkVisibility());
    const hit = fields.find((e) => names(e).includes(want)) || fields.find((e) => names(e).some((n) => n.startsWith(want)));
    if (!hit) return false;
    hit.scrollIntoView({ block: "center" });
    hit.focus();
    hit.select && hit.select();
    return document.activeElement === hit;
  })()`;
}

class JevSession implements Session {
  private pageP: Promise<Page> | null = null;

  constructor(
    private readonly browser: Browser,
    private readonly nav: { navigator: NavigatorDeps | null; close(): Promise<void> },
    private readonly base: RunConfig,
    private readonly log: Logger,
    private readonly stepMs: number,
    private readonly headed: boolean,
    private readonly secrets: Secrets,
    private readonly policy: Policy,
    private readonly envName: string | null,
  ) {}

  private page(): Promise<Page> {
    this.pageP ??= this.browser.page();
    return this.pageP;
  }

  async goto(url: string): Promise<void> {
    await (await this.page()).navigate(url, LIMITS.openTimeoutMs);
  }

  async jev(task: string, params: Record<string, string>, goal: "act" | "check", signal?: AbortSignal): Promise<JevOutcome> {
    signal?.throwIfAborted();
    const nav = this.nav.navigator;
    if (!nav) return { ok: false, steps: [], reason: "a plain-language step needs Jev: set jev.api_key (TYPESAFE_API_KEY)", jevRequests: 0 };
    const page = await this.page();
    const current = await page.url().catch(() => "");
    signal?.throwIfAborted();
    const cfg: RunConfig = {
      ...this.base, task, goal, vars: { ...params }, keepOpen: true, headed: this.headed, profile: "none", confirm: this.policy.confirm,
      actions: this.policy.actions, ...(this.policy.jevNotes ? { notes: this.policy.jevNotes } : {}),
      ...(current && current !== "about:blank" ? { fallbackUrl: current } : {}),
    };
    const hint = confirmHint(this.policy, this.envName);
    const runner = new FastRunner({
      cfg, profiles: nav.profiles, chrome: () => this.browser.chrome(), page, openPage: async () => page,
      ...(signal ? { signal } : {}), redactor: (text) => this.secrets.redact(text),
      oracle: nav.oracle, human: nav.human, log: this.log, attended: false, hints: { confirmNever: hint, noConfirm: hint, noConfirmHeadless: hint },
      ...(nav.warm ? { warm: nav.warm } : {}), ...(nav.text ? { text: nav.text } : {}),
    });
    const before = nav.oracle.stats.requests;
    const r = await runner.run();
    const jevRequests = nav.oracle.stats.requests - before;
    const rec = stepsFromRecords(r.steps.filter((s) => s.result === "ok"), params, { keepGated: true });
    for (const s of rec.skipped) this.log.info(`not recorded: ${s}`);
    const reason = r.outcome === "done" ? r.reason : `jev ${r.outcome}: ${r.blocked?.hint || r.error?.message || r.reason || "no reason"}`;
    const out: JevOutcome = { ok: r.outcome === "done" && (goal === "check" || rec.skipped.length === 0), steps: rec.steps, reason: goal === "act" && rec.skipped.length ? `the run cannot be replayed: ${rec.skipped.join("; ")}. Use explicit steps for these actions` : reason, jevRequests };
    if (r.answer?.kind === "check") out.check = { answer: r.answer.answer, probability: r.answer.probability };
    return out;
  }

  async replay(steps: Parameters<Session["replay"]>[0], params: Record<string, string>, signal?: AbortSignal, opts: ReplayOptions = {}): Promise<ReplayOutcome> {
    const guard = opts.guard && this.policy.confirm !== "autonomous"
      ? (input: ReplayGuardInput) => refusal(this.policy, this.envName, input)
      : undefined;
    const r = await replaySteps(await this.page(), steps, params, { log: this.log, stepTimeoutMs: this.stepMs, headed: this.headed, ...(signal ? { signal } : {}), ...(guard ? { guard } : {}) });
    return r.ok ? { ok: true } : { ok: false, step: r.step, reason: r.reason, ...(r.refused ? { refused: true as const } : {}) };
  }

  async fillCredential(field: string, value: string): Promise<ReplayOutcome> {
    const page = await this.page();
    const chrome = await this.browser.chrome();
    const deadline = Date.now() + this.stepMs;
    for (;;) {
      const r = await chrome.client.send("Runtime.evaluate", { expression: focusFieldScript(field), returnByValue: true }, page.sessionId);
      const found = (r["result"] as { value?: unknown } | undefined)?.value === true;
      if (found) {
        if (value) await chrome.client.send("Input.insertText", { text: value }, page.sessionId);
        else {
          for (const type of ["keyDown", "keyUp"]) await chrome.client.send("Input.dispatchKeyEvent", { type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }, page.sessionId);
        }
        const check = await chrome.client.send("Runtime.evaluate", { expression: `document.activeElement?.value === ${JSON.stringify(value)}`, returnByValue: true }, page.sessionId);
        return (check["result"] as { value?: unknown } | undefined)?.value === true
          ? { ok: true }
          : { ok: false, step: 0, reason: `the field ${JSON.stringify(field)} did not keep the requested value` };
      }
      if (Date.now() >= deadline) return { ok: false, step: 0, reason: `no field ${JSON.stringify(field)}` };
      await new Promise((res) => setTimeout(res, 250));
    }
  }

  async observe() { return (await this.page()).observe(); }

  async read() {
    const page = await this.page();
    return page.read ? page.read({ text: true, limits: { minRows: 1 } }) : null;
  }

  async url() { return (await this.page()).url(); }

  async screenshot(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await (await this.page()).screenshot(file);
  }

  async close() {
    try { await this.browser.close(); } finally { await this.nav.close(); }
  }
}

export function jevSessions(o: EngineOptions): SessionFactory {
  const projectPolicy = o.policy ?? DEFAULT_POLICY;
  const env = engineEnv(o.config, o.processEnv, projectPolicy.llmInstructions);
  const browserKind = o.config.browser.browser as BrowserKind | undefined;
  const kind = browserOf({ ...(browserKind ? { browser: browserKind } : {}) }, env);
  const profiles = listProfiles(defaultUserDataDir(env, undefined, kind ?? "chrome"));
  const wanted = o.config.browser.profile;
  const profile = wanted.toLowerCase() === "none" ? undefined : profiles.find((p) => p.name.toLowerCase() === wanted.toLowerCase() || p.directory.toLowerCase() === wanted.toLowerCase());
  if (wanted.toLowerCase() !== "none" && !profile) throw new Error(`unknown browser profile "${wanted}". Known: ${profiles.map((p) => `${p.name} (${p.directory})`).join(", ") || "none"}`);
  return {
    async open(name, write, suitePolicy) {
      const policy = suitePolicy ?? projectPolicy;
      const env = engineEnv(o.config, o.processEnv, policy.llmInstructions);
      fs.mkdirSync(o.logDir, { recursive: true });
      const file = fs.createWriteStream(path.join(o.logDir, `${name.replace(/[^A-Za-z0-9_.-]+/g, "_")}.log`));
      const log = createLogger(lineStream((l) => { file.write(o.secrets.redact(l) + "\n"); if (/ WARN /.test(l) && !/ unattended: /.test(l)) write(o.secrets.redact(l)); }), "info", false);
      log.redactor = (s) => o.secrets.redact(s);
      const human = createHuman({ stdin: process.stdin, stderr: lineStream((l) => file.write(o.secrets.redact(l) + "\n")) as unknown as NodeJS.WriteStream, forceNonInteractive: true });
      const base = { ...baseRunConfig(env, { headed: o.headed, maxSteps: o.config.jev.max_steps }), model: o.config.jev.model };
      const nav = createNavigator(env, log, human, profiles, base);
      const browser = createBrowser({
        headed: o.headed, env, log, ...(kind ? { browser: kind } : {}), ...(profile ? { profileDirectory: profile.directory } : {}),
      });
      const session = new JevSession(browser, nav, base, log, o.config.timeouts.step_ms, o.headed, o.secrets, policy, o.envName ?? null);
      const close = session.close.bind(session);
      session.close = async () => { try { await close(); } finally { await new Promise<void>((r) => file.end(r)); } };
      return session;
    },
  };
}
