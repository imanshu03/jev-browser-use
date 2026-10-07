import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { FastRunnerDeps, RunResult, StepRecord } from "@imanshu03/jev-browser-use";
import { ConfigDef } from "../src/schema.js";
import { Secrets } from "../src/template.js";

const fake = vi.hoisted(() => ({ result: {} as RunResult, deps: null as FastRunnerDeps | null }));
vi.mock("@imanshu03/jev-browser-use", async (load) => {
  const sdk = await load<typeof import("@imanshu03/jev-browser-use")>();
  return {
    ...sdk,
    listProfiles: () => [],
    createBrowser: () => ({ page: async () => ({ url: async () => "https://app.example" }), close: async () => undefined }),
    createNavigator: () => ({ navigator: { oracle: { stats: { requests: 0 } }, profiles: [], human: {} }, close: async () => undefined }),
    FastRunner: class {
      constructor(deps: FastRunnerDeps) { fake.deps = deps; }
      async run() { return fake.result; }
    },
  };
});
const { jevSessions } = await import("../src/engine.js");

it("rejects a successful Jev run when a completed action cannot be recorded", async () => {
  fake.result = { outcome: "done", reason: "done", steps: [{ step: 1, action: "fill", result: "ok", target: { role: "textbox", name: "Message" }, value: "***" } as StepRecord] } as RunResult;
  const session = await jevSessions({ config: ConfigDef.parse({}), secrets: new Secrets(), processEnv: {}, headed: false, logDir: tempDir() }).open("Record", () => undefined);
  try {
    expect(await session.jev("Write a reply", {}, "act")).toMatchObject({ ok: false, steps: [], reason: expect.stringContaining("cannot be replayed") });
  } finally { await session.close(); }
});

it("gives the engine a redactor for secrets that can appear on the page", async () => {
  fake.result = { outcome: "done", reason: "done", steps: [] } as unknown as RunResult;
  const secrets = new Secrets();
  secrets.add("private-value");
  const session = await jevSessions({ config: ConfigDef.parse({}), secrets, processEnv: {}, headed: false, logDir: tempDir() }).open("Private", () => undefined);
  try {
    await session.jev("Check the page", {}, "check");
    expect(fake.deps?.redactor?.("Page shows private-value")).toBe("Page shows ***");
  } finally { await session.close(); }
});

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "jev-engine-test-")); }
