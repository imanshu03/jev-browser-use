// Shared helpers of the MCP tests: a scripted Jev for the reply flow, a fake mail page on a BrowserSession,
// and an in-memory MCP client. No network, no real key, and no Chrome.
import type { ChoiceQuestion, Questions } from "@typesafe-ai/sdk";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ProfileEntry } from "../../src/browser.js";
import type { Chrome, ChromeLaunchOptions, Observation } from "../../src/fast/model.js";
import { BrowserSession } from "../../src/fast/session.js";
import type { Logger } from "../../src/io.js";
import type { RunManager } from "../../src/mcp/runs.js";
import { buildServer } from "../../src/mcp/server.js";
import type { ServerDeps } from "../../src/mcp/server.js";
import type { JevLink } from "../../src/mcp/setup.js";
import type { PartialAnswers } from "../fakes.js";
import { fakeOracle } from "../fakes.js";
import { el, fakeChrome, fakePage, obs, type FakePage } from "../fast/fakes.js";

export const KEY = "tsk-test-key-0123456789abcdef";
export const PROFILES: ProfileEntry[] = [{ directory: "Profile 14", name: "Parallelloop" }, { directory: "Profile 2", name: "BP" }];

/** The target key of `head` whose element string holds `label`. */
export function idx(questions: Questions, head: string, label: string): string {
  const q = questions[head] as ChoiceQuestion | undefined;
  for (const [key, v] of Object.entries(q?.criteria ?? {})) {
    if (typeof v === "object" && v !== null && String((v as { element?: string }).element ?? "").includes(label)) return key;
  }
  throw new Error(`no ${head} option for ${label}: ${Object.keys(q?.criteria ?? {}).join(",")}`);
}

export interface StepState { recent_actions: { action: string; kind: string; text: string | null }[] }
export type Decide = (q: Questions, state: StepState) => PartialAnswers;

export const gen = (label: string, conf = 0.8): Decide => (q) => ({ page_kind: "task_page", operation: "TYPE_TEXT", type_text_target: { choice: idx(q, "type_text_target", label), confidence: 0.8 }, type_text_value: { choice: "generate", confidence: conf } });
export const clickOn = (label: string): Decide => (q) => ({ page_kind: "task_page", operation: "CLICK", click_target: { choice: idx(q, "click_target", label), confidence: 0.9 } });
export const finish: Decide = () => ({ page_kind: "task_page", operation: { choice: "DONE", confidence: 0.9, probabilities: { DONE: 0.9, WAIT: 0.1 } } });

/**
 * Jev for the reply flow. The step decision comes from the number of executed actions:
 * 0 -> generate for Reply, 1 -> generate for Subject, 2 -> click Send, then DONE.
 */
export function replyOracle(plan: PartialAnswers = { goal: "act" }, steps: Decide[] = [gen("Reply"), gen("Subject"), clickOn("Send"), finish]) {
  return fakeOracle((name, state, q) => {
    if (name === "plan") return plan;
    if (name !== "step") return {};
    const n = (state as StepState).recent_actions.length;
    return (steps[Math.min(n, steps.length - 1)] as Decide)(q, state as StepState);
  });
}

export const MAIL = "https://mail.example/t/1";

/** A fake reply page on a real BrowserSession: Subject and Reply in form 7, and Send. Send posts the texts and clears them. */
export function mailSession(log: Logger) {
  const state = { values: {} as Record<number, string>, sent: null as string | null, doc: 1_727_000_000_000.5 };
  const view = (): Observation => obs(MAIL, [
    el("e1", "fill", "Cc", "textbox", { value: state.values[1] ?? "", inputType: "email", form: 7 }),
    el("e2", "fill", "Subject", "textbox", { value: state.values[2] ?? "", inputType: "text", form: 7, maxLength: 120 }),
    el("e3", "fill", "Reply", "textbox", { value: state.values[3] ?? "", form: 7, multiline: true }),
    el("e4", "click", "Send", "button", { form: 7 }),
  ], `Meeting on Tuesday\nFrom: Ann Lee\nCan we meet on Tuesday at 10:00?${state.sent !== null ? `\nSent: ${state.sent}` : ""}`, { doc: state.doc, title: "Meeting" });
  const page: FakePage = fakePage({ pages: { m: view() }, start: "m" });
  page.observe = async () => { page.observes += 1; return view(); };
  page.url = async () => MAIL;
  const act = page.act.bind(page);
  page.act = async (a, o, text) => {
    await act(a, o, text);
    if (a.kind === "fill" && a.node !== null) state.values[a.node] = text ?? "";
    if (a.label === "Send") { state.sent = `${state.values[2] ?? ""} | ${state.values[3] ?? ""}`; state.values = {}; }
  };
  const launches: ChromeLaunchOptions[] = [];
  const chromes: Chrome[] = [];
  const session = new BrowserSession({
    env: {}, log,
    launch: async (o) => { launches.push(o); const c = fakeChrome(); chromes.push(c); return c; },
    open: async () => page,
  });
  return { state, page, session, launches, chromes };
}

/** A JevLink that never connects. The tests inject the oracle. */
export function fakeJev(key: string | null = KEY): JevLink & { warms: number } {
  const j = {
    warms: 0,
    client: () => { throw new Error("no Jev client in tests"); },
    warm: async () => { j.warms += 1; },
    key: () => key,
    close: async () => undefined,
  };
  return j as unknown as JevLink & { warms: number };
}

export interface ElicitParams { message: string; requestedSchema: unknown; mode?: string }
export type ElicitAnswer = { action: "accept"; content: Record<string, string | number | boolean | string[]> } | { action: "decline" } | { action: "cancel" };

/** Connect an in-memory client to a server built from `deps`. With `elicit`, the client declares form elicitation and answers with it. */
export async function connect(deps: Omit<ServerDeps, "runs"> & { runs: RunManager }, elicit?: (p: ElicitParams) => ElicitAnswer | Promise<ElicitAnswer>) {
  const server = buildServer(deps);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: elicit ? { elicitation: { form: {} } } : {} });
  const dialogs: ElicitParams[] = [];
  if (elicit) {
    client.setRequestHandler("elicitation/create", async (req) => {
      const p = req.params as ElicitParams;
      dialogs.push(p);
      return elicit(p);
    });
  }
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server, dialogs, close: async () => { await client.close(); await server.close(); } };
}
