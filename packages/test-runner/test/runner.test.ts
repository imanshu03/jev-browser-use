import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProject, loadSuites } from "../src/load.js";
import type { RunMode, RunReport } from "../src/runner.js";
import { runAll } from "../src/runner.js";
import { FakeSession, factoryOf, tempProject } from "./fake.js";

const CONFIG = `
base_url: https://app.example
vars: { email: qa@example.com }
flows:
  login:
    - goto: /login
    - fill: { field: Email, value: "{email}" }
    - fill: { field: Password, value: "\${QA_PASSWORD}" }
    - click: Sign in
timeouts: { assert_ms: 0 }
`;

const SUITE = `
suite: Notes
before_all:
  - use: login
cases:
  - id: N-1
    title: Add a note
    start: /notes
    vars: { title: "Milk {now}" }
    steps:
      - Add a note titled "{title}"
    expect:
      - row_contains: ["{title}"]
    cleanup:
      - click: { name: "Delete {title}", match: contains }
`;

const LOCAL: RunMode = { ci: false, record: false, heal: "warn" };
const ADD_STEPS = [
  { op: "fill", target: { role: "textbox", name: "Note title" }, value: "{title}" },
  { op: "click", target: { role: "button", name: "Add note" } },
];

function setup(suite = SUITE, config = CONFIG, password = "s3cret-pass") {
  const cfg = tempProject(config, { "notes.suite.yaml": suite });
  const project = loadProject(cfg, { processEnv: { QA_PASSWORD: password } });
  const root = path.dirname(cfg);
  const session = new FakeSession();
  const run = (mode: RunMode = LOCAL, now = new Date("2026-10-07T10:00:00Z")): Promise<RunReport> => runAll({
    project, suites: loadSuites(project, [], { tags: [], ids: [], grep: null }), sessions: factoryOf(session), llm: null, mode, workers: 1,
    reportDir: path.join(root, "reports", "r1"), runId: "r1", now: () => now,
  });
  const recording = () => path.join(root, ".jev", "recordings", "suites", "notes.json");
  return { project, session, run, root, recording };
}

/** Jev adds the note on the fake page: the row shows, and Jev reports the steps that it took. */
function jevAddsNote(s: FakeSession) {
  s.onJev = (task, params) => {
    s.page.rows = [[params["title"] ?? "", "2026-10-07"]];
    return { ok: true, steps: structuredClone(ADD_STEPS) as never, reason: "done", jevRequests: 3 };
  };
}

describe("runAll", () => {
  it("records a plain-language step with Jev, then replays it with no Jev on the next run", async () => {
    const t = setup();
    jevAddsNote(t.session);
    const first = await t.run();
    expect(first.totals).toMatchObject({ passed: 1, failed: 0 });
    expect(first.suites[0]?.cases[0]?.jevRequests).toBe(3);
    const rec = JSON.parse(fs.readFileSync(t.recording(), "utf8"));
    expect(Object.values(rec.entries)).toEqual([{ text: 'Add a note titled "{title}"', steps: ADD_STEPS, recorded_at: "2026-10-07T10:00:00.000Z" }]);

    t.session.calls = [];
    t.session.onJev = () => { throw new Error("no Jev on a replay run"); };
    t.session.onReplay = (_steps, params) => { if (params["title"]) t.session.page.rows = [[params["title"]]]; return { ok: true }; };
    const second = await t.run(LOCAL, new Date("2026-10-07T11:00:00Z"));
    expect(second.totals).toMatchObject({ passed: 1 });
    expect(second.suites[0]?.cases[0]?.jevRequests).toBe(0);
    expect(t.session.calls.some((c) => c.startsWith("replay") && c.includes('"title":"Milk 1791370800000"'))).toBe(true);
  });

  it("runs the login flow: password with code only, other fields by replay, and redacts the secret", async () => {
    const t = setup();
    jevAddsNote(t.session);
    const r = await t.run();
    expect(t.session.calls.slice(0, 5)).toEqual([
      "goto https://app.example/login",
      'replay [{"op":"fill","target":{"role":"textbox","name":"Email"},"value":"qa@example.com"}] {}',
      "credential Password=11",
      'replay [{"op":"click","target":{"role":"button","name":"Sign in"}}] {}',
      "goto https://app.example/notes",
    ]);
    expect(JSON.stringify(r)).not.toContain("s3cret-pass");
  });

  it("repairs a replay that fails: the recording keeps the steps that ran, then Jev's steps; the case is marked repaired", async () => {
    const t = setup();
    jevAddsNote(t.session);
    await t.run();
    t.session.onReplay = (steps) => (steps.length === 2 ? { ok: false, step: 1, reason: 'step 2: no button "Add note"' } : { ok: true });
    t.session.onJev = (_task, params) => {
      t.session.page.rows = [[params["title"] ?? ""]];
      return { ok: true, steps: [{ op: "click", target: { role: "button", name: "Create note" } }], reason: "done", jevRequests: 2 };
    };
    const r = await t.run();
    expect(r.totals).toMatchObject({ healed: 1, failed: 0 });
    expect(r.suites[0]?.cases[0]?.healed[0]).toContain('no button "Add note"');
    const entry = Object.values(JSON.parse(fs.readFileSync(t.recording(), "utf8")).entries)[0] as { steps: unknown[]; healed: unknown[] };
    expect(entry.steps).toEqual([ADD_STEPS[0], { op: "click", target: { role: "button", name: "Create note" } }]);
    expect(entry.healed).toHaveLength(1);
  });

  it("in CI a repair fails the case and goes to the report directory, not over the committed recording", async () => {
    const t = setup();
    jevAddsNote(t.session);
    await t.run();
    const before = fs.readFileSync(t.recording(), "utf8");
    t.session.onReplay = (steps) => (steps.length === 2 ? { ok: false, step: 1, reason: "step 2: gone" } : { ok: true });
    const r = await t.run({ ci: true, record: false, heal: "fail" });
    expect(r.totals).toMatchObject({ failed: 1 });
    expect(r.suites[0]?.cases[0]?.error).toMatch(/CI does not accept repairs/);
    expect(fs.readFileSync(t.recording(), "utf8")).toBe(before);
    expect(r.suites[0]?.recordingsSaved).toBe(path.join(t.root, "reports", "r1", "recordings", "suites", "notes.json"));
  });

  it("with heal off a failed replay fails the case and Jev is not called", async () => {
    const t = setup();
    jevAddsNote(t.session);
    await t.run();
    t.session.calls = [];
    t.session.onReplay = (steps) => (steps.length === 2 ? { ok: false, step: 0, reason: "step 1: no field" } : { ok: true });
    const r = await t.run({ ci: false, record: false, heal: "off" });
    expect(r.totals).toMatchObject({ failed: 1 });
    expect(t.session.calls.some((c) => c.startsWith("jev"))).toBe(false);
  });

  it("in CI a step with no recording fails at once and Jev is not called", async () => {
    const t = setup();
    const r = await t.run({ ci: true, record: false, heal: "fail" });
    expect(r.suites[0]?.cases[0]?.error).toMatch(/has no recording/);
    expect(t.session.calls.some((c) => c.startsWith("jev"))).toBe(false);
  });

  it("a failed expectation fails the case, takes a screenshot, and still runs the cleanup", async () => {
    const t = setup();
    t.session.onJev = () => ({ ok: true, steps: [], reason: "done", jevRequests: 1 });
    const r = await t.run();
    const c = r.suites[0]?.cases[0];
    expect(c?.status).toBe("failed");
    expect(c?.error).toMatch(/expected a row holds "Milk 1791367200000"/);
    expect(t.session.calls).toContain("screenshot N-1-failed.jpg");
    expect(t.session.calls.at(-1)).toBe('replay [{"op":"click","target":{"role":"button","name":"Delete Milk 1791367200000","match":"contains"}}] {}');
  });

  it("a before_all failure fails every case of the suite with that reason", async () => {
    const t = setup();
    t.session.onCredential = () => ({ ok: false, step: 0, reason: 'no field "Password"' });
    const r = await t.run();
    expect(r.suites[0]?.cases.map((c) => c.status)).toEqual(["failed"]);
    expect(r.suites[0]?.cases[0]?.error).toMatch(/^before_all: fill .*no field "Password"/);
    expect(t.session.closed).toBe(true);
  });

  it("skips a case with skip, and names an unknown flow", async () => {
    const t = setup(`
suite: S
cases:
  - { id: S-1, title: skipped, skip: "waiting for a fix", steps: ["x"] }
  - { id: S-2, title: bad flow, steps: [{ use: nope }] }
`);
    const r = await t.run();
    expect(r.suites[0]?.cases.map((c) => [c.status, c.error])).toEqual([["skipped", "waiting for a fix"], ["failed", 'use nope: no flow named "nope" in the config']]);
  });

  it("escapes braces of a var value in an explicit step, so the replay types them as they are", async () => {
    const t = setup(`
suite: S
cases:
  - { id: S-1, title: braces, vars: { raw: "a {{b}} c" }, steps: [{ fill: { field: Notes, value: "{raw}" } }] }
`);
    await t.run();
    expect(t.session.calls).toContain('replay [{"op":"fill","target":{"role":"textbox","name":"Notes"},"value":"a {{b}} c"}] {}');
  });

  it("re-records with --record even when a recording exists", async () => {
    const t = setup();
    jevAddsNote(t.session);
    await t.run();
    t.session.calls = [];
    await t.run({ ci: false, record: true, heal: "warn" });
    expect(t.session.calls.filter((c) => c.startsWith("jev act"))).toHaveLength(1);
  });
  it("never sends a secret in a plain-language step to Jev, and never writes it to a recording", async () => {
    const t = setup(`
suite: S
cases:
  - { id: S-1, title: env secret, steps: ["Log in with the password \${QA_PASSWORD}"] }
  - { id: S-2, title: var secret, vars: { pw: "\${QA_PASSWORD}" }, steps: ["Type {pw} in the password field"] }
`);
    const r = await t.run();
    expect(r.suites[0]?.cases.map((c) => c.status)).toEqual(["failed", "failed"]);
    expect(r.suites[0]?.cases[0]?.error).toMatch(/holds a secret value.*explicit fill step/);
    expect(t.session.calls.some((c) => c.startsWith("jev"))).toBe(false);
    expect(fs.existsSync(t.recording())).toBe(false);
    expect(JSON.stringify(r)).not.toContain("s3cret-pass");
  });

  it("does not save recorded steps that hold a secret value", async () => {
    const t = setup(`
suite: S
cases:
  - { id: S-1, title: t, steps: ["Sign in"] }
`);
    t.session.onJev = () => ({ ok: true, steps: [{ op: "fill", target: { role: "textbox", name: "Password" }, value: "s3cret-pass" }], reason: "done", jevRequests: 1 });
    const r = await t.run();
    expect(r.suites[0]?.cases[0]?.error).toMatch(/hold a secret value, so they are not saved/);
    expect(fs.existsSync(t.recording())).toBe(false);
    expect(JSON.stringify(r)).not.toContain("s3cret-pass");
  });

  it("never sends a secret in a check or judge text to a model", async () => {
    const t = setup(`
suite: S
cases:
  - { id: S-1, title: t, expect: [{ check: "Does the page show \${QA_PASSWORD}?" }] }
`);
    const r = await t.run();
    expect(r.suites[0]?.cases[0]?.error).toMatch(/check or judge text holds a secret value/);
    expect(t.session.calls.some((c) => c.startsWith("jev"))).toBe(false);
    expect(JSON.stringify(r)).not.toContain("s3cret-pass");
  });
  it("finds a secret with a quote or a backslash in recorded steps: JSON escapes do not hide it", async () => {
    const secret = 'pa"ss\\word';
    const t = setup(`
suite: S
cases:
  - { id: S-1, title: t, steps: ["Sign in"] }
`, CONFIG, secret);
    t.session.onJev = () => ({ ok: true, steps: [{ op: "fill", target: { role: "textbox", name: "Key" }, value: secret }], reason: "done", jevRequests: 1 });
    const r = await t.run();
    expect(r.suites[0]?.cases[0]?.error).toMatch(/hold a secret value, so they are not saved/);
    expect(fs.existsSync(t.recording())).toBe(false);
  });

  it("a check sends Jev only the vars that its text uses, so a secret var stays out", async () => {
    const t = setup(`
suite: S
cases:
  - { id: S-1, title: t, vars: { pw: "\${QA_PASSWORD}", name: Milk }, expect: [{ check: "Is {name} listed?" }] }
`);
    const seen: Record<string, string>[] = [];
    t.session.onJev = (_task, params) => { seen.push(params); return { ok: true, steps: [], reason: "", jevRequests: 1, check: { answer: true, probability: 0.9 } }; };
    const r = await t.run();
    expect(r.totals).toMatchObject({ passed: 1 });
    expect(seen).toEqual([{ name: "Milk" }]);
  });
});

it("fails CI when before_all needs a repair", async () => {
  const t = setup(`suite: Hooks\nbefore_all: [Open settings]\ncases: [{ id: H-1, title: Hook case }]\n`, "base_url: https://app.example\n");
  t.session.onJev = () => ({ ok: true, steps: [{ op: "click", target: { role: "button", name: "Settings" } }], reason: "done", jevRequests: 1 });
  await t.run();
  t.session.onReplay = () => ({ ok: false, step: 0, reason: "renamed" });
  const r = await t.run({ ci: true, record: false, heal: "fail" });
  expect(r.totals.failed).toBe(1);
  expect(r.suites[0]?.cases[0]?.healed).toContain("Open settings: replay failed at renamed");
});

it("fails CI when after_all needs a repair", async () => {
  const t = setup(`suite: Hooks\nafter_all: [Close settings]\ncases: [{ id: H-1, title: Hook case }]\n`, "base_url: https://app.example\n");
  t.session.onJev = () => ({ ok: true, steps: [{ op: "click", target: { role: "button", name: "Close" } }], reason: "done", jevRequests: 1 });
  await t.run();
  t.session.onReplay = () => ({ ok: false, step: 0, reason: "renamed" });
  const r = await t.run({ ci: true, record: false, heal: "fail" });
  expect(r.totals.failed).toBe(1);
});

it("reports an after_all failure in the case and JUnit totals", async () => {
  const t = setup(`suite: Hooks\nafter_all: [{ expect: { visible_text: missing } }]\ncases: [{ id: H-1, title: Hook case }]\n`, "base_url: https://app.example\ntimeouts: { assert_ms: 0 }\n");
  const r = await t.run();
  expect(r.totals.failed).toBe(1);
  expect(r.suites[0]?.cases[0]?.error).toMatch(/after_all.*missing/);
});

it("stops a timed-out case before cleanup and the next case", async () => {
  const t = setup(`suite: Timeout\ncases:\n  - id: T-1\n    title: Slow case\n    timeout_ms: 10\n    steps: [{ wait: 80 }, { goto: /late }]\n    cleanup: [{ goto: /cleanup }]\n  - { id: T-2, title: Next case, steps: [{ goto: /next }] }\n`, "base_url: https://app.example\n");
  const r = await t.run();
  const before = JSON.stringify(r);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(t.session.calls).not.toContain("goto https://app.example/late");
  expect(JSON.stringify(r)).toBe(before);
  expect(r.totals).toMatchObject({ failed: 1, passed: 1 });
});

it("removes secret page text before a judge receives it", async () => {
  const t = setup(`suite: Private\ncases: [{ id: S-1, title: Private case, expect: [{ judge: User is signed in }] }]\n`, CONFIG);
  t.session.page.text = "Signed in s3cret-pass";
  let seen = "";
  const r = await runAll({
    project: t.project, suites: loadSuites(t.project, [], { tags: [], ids: [], grep: null }), sessions: factoryOf(t.session),
    llm: { model: "judge", judge: async (_criteria, page) => { seen = JSON.stringify(page); return { pass: true, reason: "shown" }; } },
    mode: LOCAL, workers: 1, reportDir: path.join(t.root, "reports"), runId: "r1",
  });
  expect(r.totals.passed).toBe(1);
  expect(seen).not.toContain("s3cret-pass");
  expect(seen).toContain("***");
});

it("uses code to fill a credential field whose label is a var", async () => {
  const t = setup(`suite: Login\nvars: { field: Password }\ncases: [{ id: L-1, title: Login, steps: [{ fill: { field: "{field}", value: literal } }] }]\n`, "base_url: https://app.example\n");
  const r = await t.run();
  expect(r.totals.passed).toBe(1);
  expect(t.session.calls).toContain("credential Password=7");
  expect(t.session.calls.some((call) => call.startsWith("replay"))).toBe(false);
});

it("removes secrets from case titles, suite names, skipped reasons, and events", async () => {
  const t = setup(`suite: Private \${QA_PASSWORD}\ncases: [{ id: S-1, title: "Private \${QA_PASSWORD}", skip: "Skipped \${QA_PASSWORD}" }]\n`, CONFIG);
  const events: unknown[] = [];
  const report = await runAll({
    project: t.project, suites: loadSuites(t.project, [], { tags: [], ids: [], grep: null }), sessions: factoryOf(t.session),
    llm: null, mode: LOCAL, workers: 1, reportDir: path.join(t.root, "reports"), runId: "r1", onEvent: (event) => events.push(event),
  });
  expect(JSON.stringify(report)).not.toContain("s3cret-pass");
  expect(JSON.stringify(events)).not.toContain("s3cret-pass");
});

it("removes a secret from the repair history in a recording", async () => {
  const t = setup(`suite: Private\ncases: [{ id: S-1, title: Private case, steps: [Open settings] }]\n`, CONFIG);
  await t.run();
  t.session.onReplay = () => ({ ok: false, step: 0, reason: "page error: s3cret-pass" });
  await t.run();
  expect(fs.readFileSync(t.recording(), "utf8")).not.toContain("s3cret-pass");
});
