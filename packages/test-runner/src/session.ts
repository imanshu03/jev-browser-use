// What the runner needs from a browser. The real one wraps jev-browser-use (engine.ts); tests use a fake.
import type { Observation, PageRead, Step } from "@imanshu03/jev-browser-use";

export interface JevOutcome {
  ok: boolean;
  /** Replay steps of the run, with values of `params` turned back into {param} placeholders. */
  steps: Step[];
  reason: string;
  /** For a check run: Jev's yes or no, and its probability. */
  check?: { answer: boolean | "unknown"; probability: number };
  jevRequests: number;
}

export type ReplayOutcome = { ok: true } | { ok: false; step: number; reason: string };

export interface Session {
  goto(url: string): Promise<void>;
  /** Let Jev do a plain-language step on the current page. */
  jev(task: string, params: Record<string, string>, goal: "act" | "check"): Promise<JevOutcome>;
  replay(steps: readonly Step[], params: Record<string, string>): Promise<ReplayOutcome>;
  /** Type into a field by its label with code only: for password and other credential fields, which Jev never sees. */
  fillCredential(field: string, value: string): Promise<ReplayOutcome>;
  observe(): Promise<Observation>;
  /** The whole page: tables, record lists, form values, and its text. Null when the page cannot be read. */
  read(): Promise<PageRead | null>;
  url(): Promise<string>;
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
}

export interface SessionFactory {
  open(name: string, log: (line: string) => void): Promise<Session>;
}
