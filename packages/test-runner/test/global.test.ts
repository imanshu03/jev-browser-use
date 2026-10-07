// global.yaml: environments, the confirm mode, the action words, and the instructions for Jev and the LLM.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { engineEnv, refusal } from "../src/engine.js";
import { createLlm, JUDGE_INSTRUCTIONS_HEAD } from "../src/llm.js";
import type { FetchLike } from "../src/llm.js";
import { DEFAULT_POLICY, LoadError, loadProject, loadSuites } from "../src/load.js";
import type { Policy } from "../src/load.js";
import { runAll } from "../src/runner.js";
import { FakeSession, factoryOf, tempProject } from "./fake.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** A project with this config and global.yaml. Returns the config path. */
function project(config: string, global: string | null, suites: Record<string, string> = {}): string {
  const file = tempProject(config, suites);
  dirs.push(path.dirname(file));
  if (global !== null) fs.writeFileSync(path.join(path.dirname(file), "global.yaml"), global);
  return file;
}

const GLOBAL = `
environments:
  stage: { base_url: https://stage.example.com, confirm: autonomous, instructions: { jev: Stage has test data. } }
  prod:
    base_url: https://app.example.com
    confirm: never
    actions: { dangerous: [Save], safe: [approve], hosts: { app.example.com: { safe: [delete] } } }
    instructions: { llm: Keep replies short. }
default_environment: stage
confirm: always
actions:
  dangerous: [Approve, merge]
  safe: [archive]
  hosts:
    app.example.com: { dangerous: [publish] }
instructions:
  jev: The Save button is the disk icon.
  llm: Write in British English.
`;

describe("loadProject with global.yaml", () => {
  it("takes the environments of global.yaml, and puts the environment over the global settings", () => {
    const file = project("vars: { org: Org }\n", GLOBAL);
    const stage = loadProject(file, { processEnv: {} });
    expect(stage.env).toEqual({ name: "stage", baseUrl: "https://stage.example.com" });
    expect(stage.policy).toEqual({
      globalPath: path.join(path.dirname(file), "global.yaml"), confirm: "autonomous",
      actions: { dangerous: ["approve", "merge"], safe: ["archive"], hosts: { "app.example.com": { dangerous: ["publish"], safe: [] } } },
      jevNotes: "The Save button is the disk icon.\nStage has test data.", llmInstructions: "Write in British English.",
    });
    const prod = loadProject(file, { envName: "prod", processEnv: {} });
    expect(prod.policy.confirm).toBe("never");
    expect(prod.policy.actions).toEqual({
      dangerous: ["merge", "save"], safe: ["archive", "approve"],
      hosts: { "app.example.com": { dangerous: ["publish"], safe: ["delete"] } },
    });
    expect(prod.policy.llmInstructions).toBe("Write in British English.\nKeep replies short.");
    expect(prod.policy.jevNotes).toBe("The Save button is the disk icon.");
  });

  it("uses the global confirm mode when the environment has none, and autonomous with no global file", () => {
    const file = project("", "environments: { qa: { base_url: https://qa.example.com } }\ndefault_environment: qa\nconfirm: always\n");
    expect(loadProject(file, { processEnv: {} }).policy.confirm).toBe("always");
    const none = project("base_url: https://a.example.com\n", null);
    expect(loadProject(none, { processEnv: {} }).policy).toEqual(DEFAULT_POLICY);
  });

  it("keeps the environments of the config, and refuses one environment in both files or two defaults", () => {
    const old = project("environments: { local: { base_url: http://localhost:3000 } }\n", GLOBAL);
    expect(loadProject(old, { envName: "local", processEnv: {} }).env.baseUrl).toBe("http://localhost:3000");
    const twice = project("environments: { prod: { base_url: https://x.example.com } }\n", GLOBAL);
    expect(() => loadProject(twice, { processEnv: {} })).toThrow(/the environment "prod" is in .* and in .*global\.yaml/);
    const defaults = project("environments: { local: { base_url: http://localhost:3000 } }\ndefault_environment: local\n", GLOBAL);
    expect(() => loadProject(defaults, { processEnv: {} })).toThrow(/default_environment is "local" in .* and "stage" in/);
  });

  it("refuses a word that one scope lists as dangerous and as safe, unknown keys, a missing named file, and secrets in instructions", () => {
    const both = project("", "base_url: https://a.example.com\n");
    expect(() => loadProject(both, { processEnv: {} })).toThrow(LoadError);
    const clash = project("base_url: https://a.example.com\n", "actions: { dangerous: [Delete], safe: [delete] }\n");
    expect(() => loadProject(clash, { processEnv: {} })).toThrow(/actions lists "delete" as dangerous and as safe/);
    const hostClash = project("base_url: https://a.example.com\n", "actions: { hosts: { a.example.com: { dangerous: [x], safe: [x] } } }\n");
    expect(() => loadProject(hostClash, { processEnv: {} })).toThrow(/actions host a\.example\.com lists "x"/);
    for (const key of ["app.example.com:443", "https://app.example.com", "*.example.com", "app.example.com/notes", "user@app.example.com"]) {
      const host = project("base_url: https://a.example.com\n", `actions: { hosts: { "${key}": { dangerous: [save] } } }\n`);
      expect(() => loadProject(host, { processEnv: {} }), key).toThrow(/is not a host name: write only the host/);
    }
    const dotted = project("base_url: https://a.example.com\n", "actions: { hosts: { App.Example.com.: { dangerous: [save] } } }\n");
    expect(loadProject(dotted, { processEnv: {} }).policy.actions.hosts).toEqual({ "app.example.com": { dangerous: ["save"], safe: [] } });
    const bad = project("base_url: https://a.example.com\n", "confirm: sometimes\n");
    expect(() => loadProject(bad, { processEnv: {} })).toThrow(/confirm/);
    const missing = project("base_url: https://a.example.com\nglobal: shared/global.yaml\n", null);
    expect(() => loadProject(missing, { processEnv: {} })).toThrow(/the global file .*shared\/global\.yaml does not exist/);
    const secret = project("base_url: https://a.example.com\n", "instructions: { jev: \"Sign in with ${TEST_PASSWORD}\" }\n");
    expect(() => loadProject(secret, { processEnv: { TEST_PASSWORD: "hunter22" } })).toThrow(/instructions\.jev holds a secret value/);
  });
});

describe("refusal", () => {
  const policy = (confirm: Policy["confirm"], actions: Partial<Policy["actions"]> = {}): Policy => ({ ...DEFAULT_POLICY, confirm, actions: { dangerous: [], safe: [], hosts: {}, ...actions } });
  const click = (label: string, url = "https://app.example.com/") => ({ kind: "click" as const, label, url });

  it("autonomous allows every action; never refuses dangerous actions; always also refuses submit clicks", () => {
    expect(refusal(policy("autonomous"), "prod", click("Delete note"))).toBeNull();
    expect(refusal(policy("never"), "prod", click("Delete note"))).toBe('confirm is never for this suite in the prod environment, so the run does not do the dangerous click on "Delete note"');
    expect(refusal(policy("never"), "prod", click("Save"))).toBeNull();
    expect(refusal(policy("always"), null, click("Save"))).toBe('confirm is always for this suite, so the run does not do the submit click on "Save"');
    expect(refusal(policy("always"), "prod", click("Open menu"))).toBeNull();
    expect(refusal(policy("always"), "prod", { kind: "enter", label: "Title | Save", url: "https://app.example.com/" })).toMatch(/submit Enter on "Title \| Save"/);
    expect(refusal(policy("always"), "prod", { kind: "enter", label: "Title", url: "https://app.example.com/", search: false })).toMatch(/submit Enter on "Title"/);
    expect(refusal(policy("always"), "prod", { kind: "enter", label: "Search notes", url: "https://app.example.com/", search: true })).toBeNull();
    expect(refusal(policy("never"), "prod", { kind: "enter", label: "Title | Save", url: "https://app.example.com/" })).toBeNull();
    expect(refusal(policy("never"), "prod", { kind: "enter", label: "Note | Delete note", url: "https://app.example.com/" })).toMatch(/dangerous Enter on "Note \| Delete note"/);
  });

  it("uses the dangerous and safe words, also of the host of the page", () => {
    const p = policy("never", { dangerous: ["approve"], safe: [], hosts: { "app.example.com": { dangerous: [], safe: ["delete"] } } });
    expect(refusal(p, "prod", click("Approve request"))).toMatch(/dangerous click on "Approve request"/);
    expect(refusal(p, "prod", click("Delete note"))).toBeNull();
    expect(refusal(p, "prod", click("Delete note", "https://other.example.org/"))).toMatch(/dangerous click/);
    const hosted = policy("never", { dangerous: [], safe: [], hosts: { "app.example.com": { dangerous: ["save"], safe: [] } } });
    expect(refusal(hosted, "prod", click("Save", "https://app.example.com./notes"))).toMatch(/dangerous click on "Save"/);
  });
});

describe("the runner and global.yaml", () => {
  const SUITE = "suite: S\ncases:\n  - id: C-1\n    title: t\n    start: /\n    steps:\n      - Delete the note\n      - click: Delete all\n";

  it("a recorded replay asks for the guard and an explicit step does not; a refused replay fails with no repair", async () => {
    const file = project("base_url: https://a.example.com\n", "confirm: never\n", { "s.suite.yaml": SUITE });
    const p = loadProject(file, { processEnv: {} });
    fs.mkdirSync(path.join(path.dirname(file), ".jev/recordings/suites"), { recursive: true });
    const { entryKey } = await import("../src/recordings.js");
    fs.writeFileSync(path.join(path.dirname(file), ".jev/recordings/suites/s.json"), JSON.stringify({ format: 1, suite: "suites/s.suite.yaml", entries: { [entryKey("C-1", "Delete the note", 1)]: { text: "Delete the note", steps: [{ op: "click", target: { role: "button", name: "Delete note" } }], recorded_at: "2026-10-08T00:00:00Z" } } }));
    const session = new FakeSession();
    const guards: (boolean | undefined)[] = [];
    session.onReplay = (_steps, _params, opts) => {
      guards.push(opts.guard);
      return opts.guard ? { ok: false, step: 0, reason: "step 1: the run does not do the dangerous click", refused: true } : { ok: true };
    };
    const report = await runAll({ project: p, suites: loadSuites(p, [], { tags: [], ids: [], grep: null }), sessions: factoryOf(session), llm: null, mode: { ci: false, record: false, heal: "warn" }, workers: 1, reportDir: path.join(path.dirname(file), "reports"), runId: "r" });
    const c = report.suites[0]?.cases[0];
    expect(c?.status).toBe("failed");
    expect(c?.error).toContain("the run does not do the dangerous click");
    expect(session.calls.some((x) => x.startsWith("jev "))).toBe(false);
    expect(guards).toEqual([true]);
    session.onReplay = (_s, _p, opts) => { guards.push(opts.guard); return { ok: true }; };
    guards.length = 0;
    await runAll({ project: p, suites: loadSuites(p, [], { tags: [], ids: [], grep: null }), sessions: factoryOf(session), llm: null, mode: { ci: false, record: false, heal: "warn" }, workers: 1, reportDir: path.join(path.dirname(file), "reports"), runId: "r2" });
    expect(guards).toEqual([true, undefined]);
  });
});

describe("the LLM instructions of global.yaml", () => {
  it("go to the text writer env only with an LLM, and to the judge as a second system message", async () => {
    const llm = { base_url: "https://llm.example/v1", api_key: "k", model: "m", timeout_ms: 5000 };
    const config = { llm } as Parameters<typeof engineEnv>[0];
    expect(engineEnv({ ...config, jev: { api_key: "", model: "jev-latest", max_steps: 25 } } as Parameters<typeof engineEnv>[0], {}, "Write in British English.")["JEV_TEXT_INSTRUCTIONS"]).toBe("Write in British English.");
    expect(engineEnv({ ...config, jev: { api_key: "", model: "jev-latest", max_steps: 25 } } as Parameters<typeof engineEnv>[0], { JEV_TEXT_INSTRUCTIONS: "old" }, "")["JEV_TEXT_INSTRUCTIONS"]).toBeUndefined();
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body ?? "{}") as { messages: { role: string; content: string }[] });
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"pass": true, "reason": "ok"}' } }] }) };
    };
    await createLlm(llm, fetchImpl, "Prices are in rupees.")?.judge("Shows a price", { url: "u", title: "t", text: "₹10" });
    await createLlm(llm, fetchImpl)?.judge("Shows a price", { url: "u", title: "t", text: "₹10" });
    expect(bodies[0]?.messages.map((m) => m.role)).toEqual(["system", "system", "user"]);
    expect(bodies[0]?.messages[1]?.content).toBe(`${JUDGE_INSTRUCTIONS_HEAD}\nPrices are in rupees.`);
    expect(bodies[1]?.messages.map((m) => m.role)).toEqual(["system", "user"]);
  });
});

describe("suite overrides", () => {
  const SUITE = `suite: Notes
confirm: autonomous
actions: { dangerous: [Archive], safe: [save] }
instructions: { jev: The notes page has a sidebar., llm: Notes are in Hindi. }
cases:
  - id: N-1
    title: t
    expect: [{ judge: The note shows }]
`;

  it("a suite file goes over global.yaml and the environment: confirm, actions words, and instructions", () => {
    const file = project("", GLOBAL, { "notes.suite.yaml": SUITE, "plain.suite.yaml": "suite: Plain\ncases: [{ id: P-1, title: t }]\n" });
    const p = loadProject(file, { envName: "prod", processEnv: {} });
    const [notes, plain] = loadSuites(p, [], { tags: [], ids: [], grep: null });
    expect(notes?.policy.confirm).toBe("autonomous");
    expect(notes?.policy.actions).toEqual({ dangerous: ["merge", "archive"], safe: ["approve", "save"], hosts: { "app.example.com": { dangerous: ["publish"], safe: ["delete"] } } });
    expect(notes?.policy.jevNotes).toBe("The Save button is the disk icon.\nThe notes page has a sidebar.");
    expect(notes?.policy.llmInstructions).toBe("Write in British English.\nKeep replies short.\nNotes are in Hindi.");
    expect(plain?.policy).toEqual(p.policy);
  });

  it("refuses a word that the suite lists as dangerous and as safe, and a secret in the suite instructions", () => {
    const clash = project("base_url: https://a.example.com\n", null, { "s.suite.yaml": "suite: S\nactions: { dangerous: [x], safe: [X] }\ncases: [{ id: S-1, title: t }]\n" });
    expect(() => loadSuites(loadProject(clash, { processEnv: {} }), [], { tags: [], ids: [], grep: null })).toThrow(/s\.suite\.yaml: actions lists "x" as dangerous and as safe/);
    const secret = project("base_url: https://a.example.com\n", null, { "s.suite.yaml": "suite: S\ninstructions: { llm: \"key ${API_TOKEN}\" }\ncases: [{ id: S-1, title: t }]\n" });
    expect(() => loadSuites(loadProject(secret, { processEnv: { API_TOKEN: "tok-98765" } }), [], { tags: [], ids: [], grep: null })).toThrow(/instructions\.llm holds a secret value/);
  });

  it("the runner opens each suite's session with its policy, and its judge checks get its LLM instructions", async () => {
    const file = project("", GLOBAL, { "notes.suite.yaml": SUITE });
    const p = loadProject(file, { envName: "prod", processEnv: {} });
    const suites = loadSuites(p, [], { tags: [], ids: [], grep: null });
    const session = new FakeSession();
    const opened: (Policy | undefined)[] = [];
    const judged: (string | undefined)[] = [];
    await runAll({
      project: p, suites, sessions: { open: async (_n, _l, policy) => { opened.push(policy); return session; } },
      llm: { model: "m", judge: async (_c, _p, _s, instructions) => { judged.push(instructions); return { pass: true, reason: "ok" }; } },
      mode: { ci: false, record: false, heal: "warn" }, workers: 1, reportDir: path.join(path.dirname(file), "reports"), runId: "r",
    });
    expect(opened).toEqual([suites[0]?.policy]);
    expect(opened[0]?.confirm).toBe("autonomous");
    expect(judged).toEqual(["Write in British English.\nKeep replies short.\nNotes are in Hindi."]);
  });
});
