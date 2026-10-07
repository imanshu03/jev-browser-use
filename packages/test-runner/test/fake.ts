import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Action, Observation, PageRead, Step } from "@imanshu03/jev-browser-use";
import type { JevOutcome, ReplayOptions, ReplayOutcome, Session, SessionFactory } from "../src/session.js";

export interface FakePage {
  url: string;
  title: string;
  text: string;
  rows: string[][];
  actions: Partial<Action>[];
}

export class FakeSession implements Session {
  page: FakePage = { url: "about:blank", title: "", text: "", rows: [], actions: [] };
  calls: string[] = [];
  /** Decide a jev call. Default: done with no steps. */
  onJev: (task: string, params: Record<string, string>, goal: "act" | "check") => JevOutcome = () => ({ ok: true, steps: [], reason: "done", jevRequests: 1 });
  /** Decide a replay. Default: ok. */
  onReplay: (steps: readonly Step[], params: Record<string, string>, opts: ReplayOptions) => ReplayOutcome = () => ({ ok: true });
  onCredential: (field: string, value: string) => ReplayOutcome = () => ({ ok: true });
  closed = false;

  async goto(url: string) { this.calls.push(`goto ${url}`); this.page.url = url; }
  async jev(task: string, params: Record<string, string>, goal: "act" | "check") { this.calls.push(`jev ${goal} ${task}`); return this.onJev(task, params, goal); }
  async replay(steps: readonly Step[], params: Record<string, string>, _signal?: AbortSignal, opts: ReplayOptions = {}) { this.calls.push(`replay ${JSON.stringify(steps)} ${JSON.stringify(params)}`); return this.onReplay(steps, params, opts); }
  async fillCredential(field: string, value: string) { this.calls.push(`credential ${field}=${value.length}`); return this.onCredential(field, value); }
  async observe(): Promise<Observation> {
    return { url: this.page.url, title: this.page.title, text: this.page.text, actions: this.page.actions as Action[] } as unknown as Observation;
  }
  async read(): Promise<PageRead | null> {
    return { tables: [{ rows: this.page.rows.map((cells) => ({ cells, section: null })) }], groups: [], text: this.page.text.split("\n").map((t) => ({ text: t, tag: "p" })) } as unknown as PageRead;
  }
  async url() { return this.page.url; }
  async screenshot(file: string) { this.calls.push(`screenshot ${path.basename(file)}`); }
  async close() { this.closed = true; }
}

export function factoryOf(session: FakeSession): SessionFactory {
  return { open: async () => session };
}

/** A temp project directory with a config and suite files. Returns its config path. */
export function tempProject(config: string, suites: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-"));
  fs.writeFileSync(path.join(dir, "jev-test.config.yaml"), config);
  for (const [name, text] of Object.entries(suites)) {
    const file = path.join(dir, "suites", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return path.join(dir, "jev-test.config.yaml");
}
