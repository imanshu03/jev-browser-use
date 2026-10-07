import path from "node:path";
import { describe, expect, it } from "vitest";
import { LoadError, loadProject, loadSuites } from "../src/load.js";
import { tempProject } from "./fake.js";

const CONFIG = `
environments:
  stage: { base_url: "https://stage.example/", vars: { org: Stage Org } }
  prod: { base_url: "\${PROD_URL:-https://prod.example}" }
default_environment: stage
vars: { org: Default Org, who: qa }
`;

const SUITE_A = `
suite: Artifacts
tags: [artifacts]
cases:
  - { id: ART-1, title: Create one, tags: [smoke], steps: ["Create an artifact"] }
  - { id: ART-2, title: Delete one, steps: ["Delete it"] }
`;
const SUITE_B = `
suite: Chat
cases:
  - { id: CHAT-1, title: Ask a question, tags: [smoke] }
`;

describe("loadProject", () => {
  it("picks the default environment and lays its vars over the config vars", () => {
    const p = loadProject(tempProject(CONFIG, {}), { processEnv: {} });
    expect(p.env).toEqual({ name: "stage", baseUrl: "https://stage.example" });
    expect(p.vars).toEqual({ org: "Stage Org", who: "qa" });
  });
  it("takes --env, with ${ENV} in its base URL", () => {
    expect(loadProject(tempProject(CONFIG, {}), { envName: "prod", processEnv: { PROD_URL: "https://p.example" } }).env.baseUrl).toBe("https://p.example");
  });
  it("names an unknown environment and a missing base URL", () => {
    expect(() => loadProject(tempProject(CONFIG, {}), { envName: "qa", processEnv: {} })).toThrow(/unknown environment "qa". Known: stage, prod/);
    expect(() => loadProject(tempProject("vars: {}\n", {}), { processEnv: {} })).toThrow(/set base_url/);
  });
  it("gives the field path of a schema error", () => {
    expect(() => loadProject(tempProject("base_url: https://x.example\nbrowser: { workers: 0 }\n", {}), { processEnv: {} })).toThrow(/browser\.workers/);
  });
});

describe("loadSuites", () => {
  const cfg = tempProject(CONFIG, { "artifacts.suite.yaml": SUITE_A, "nested/chat.suite.yaml": SUITE_B, "notes.yaml": "not a suite" });
  const p = loadProject(cfg, { processEnv: {} });
  it("finds suite files under the suites directory and keys them by path", () => {
    expect(loadSuites(p, [], { tags: [], ids: [], grep: null }).map((s) => s.key)).toEqual(["suites/artifacts.suite.yaml", "suites/nested/chat.suite.yaml"]);
  });
  it("filters by tag (suite tags count), id, and grep", () => {
    const ids = (f: { tags?: string[]; ids?: string[]; grep?: string }) => loadSuites(p, [], { tags: f.tags ?? [], ids: f.ids ?? [], grep: f.grep ?? null }).flatMap((s) => s.def.cases.map((c) => c.id));
    expect(ids({ tags: ["smoke"] })).toEqual(["ART-1", "CHAT-1"]);
    expect(ids({ tags: ["@artifacts", "smoke"] })).toEqual(["ART-1"]);
    expect(ids({ ids: ["ART-2"] })).toEqual(["ART-2"]);
    expect(ids({ grep: "question" })).toEqual(["CHAT-1"]);
  });
  it("runs only the files given", () => {
    expect(loadSuites(p, [path.join(path.dirname(cfg), "suites/nested")], { tags: [], ids: [], grep: null }).map((s) => s.def.suite)).toEqual(["Chat"]);
  });
  it("rejects duplicate case ids across suites", () => {
    const dup = loadProject(tempProject(CONFIG, { "a.suite.yaml": SUITE_A, "b.suite.yaml": SUITE_A.replace("Artifacts", "Copy") }), { processEnv: {} });
    expect(() => loadSuites(dup, [], { tags: [], ids: [], grep: null })).toThrow(/case id ART-1 is in suites\/a.suite.yaml and in suites\/b.suite.yaml/);
  });
  it("rejects a var name that the replay cannot read and an unknown step shape", () => {
    const bad = loadProject(tempProject(CONFIG, { "x.suite.yaml": "suite: X\ncases:\n  - { id: X-1, title: t, vars: { Title: a } }\n" }), { processEnv: {} });
    expect(() => loadSuites(bad, [], { tags: [], ids: [], grep: null })).toThrow(LoadError);
    const shape = loadProject(tempProject(CONFIG, { "x.suite.yaml": "suite: X\ncases:\n  - { id: X-1, title: t, steps: [{ tap: Save }] }\n" }), { processEnv: {} });
    expect(() => loadSuites(shape, [], { tags: [], ids: [], grep: null })).toThrow(/cases\.0\.steps\.0/);
  });
});
