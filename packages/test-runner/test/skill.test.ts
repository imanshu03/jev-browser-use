// The jev-test skill of the plugin (packages/mcp/skills/jev-test) must name every step, check, config key, and option of the runner.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { main } from "../src/cli.js";
import { loadProject, loadSuites } from "../src/load.js";
import { runAll } from "../src/runner.js";
import { Assertion, CaseDef, ConfigDef, StepDef, SuiteDef } from "../src/schema.js";
import { FakeSession, factoryOf, tempProject } from "./fake.js";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "mcp", "skills", "jev-test");
const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
const reference = fs.readFileSync(path.join(skillDir, "references", "reference.md"), "utf8");
const yamlBlocks = (text: string): string[] => [...text.matchAll(/^```yaml\n([\s\S]*?)^```/gm)].map((m) => m[1] as string);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** The first key of each object option of a zod union. */
function unionKeys(u: { options: readonly unknown[] }): string[] {
  return u.options.flatMap((o) => (o && typeof o === "object" && "shape" in o ? [Object.keys((o as { shape: object }).shape)[0] as string] : []));
}

describe("jev-test skill", () => {
  it("all skill frontmatter parses as YAML with string names and descriptions", () => {
    for (const name of fs.readdirSync(path.dirname(skillDir))) {
      const text = fs.readFileSync(path.join(path.dirname(skillDir), name, "SKILL.md"), "utf8");
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
      expect(front, name).not.toBeNull();
      const fields = parseYaml(front?.[1] ?? "");
      expect(fields.name, name).toBe(name);
      expect(typeof fields.description, name).toBe("string");
      expect(fields.description.length, name).toBeGreaterThan(0);
      expect(fields.description.length, name).toBeLessThanOrEqual(1024);
    }
  });

  it("the documented config, suite, steps, and checks parse with the runner schema", () => {
    const blocks = yamlBlocks(reference);
    expect(blocks).toHaveLength(2);
    expect(() => ConfigDef.parse(parseYaml(blocks[0] as string))).not.toThrow();
    expect(() => SuiteDef.parse(parseYaml(blocks[1] as string))).not.toThrow();
    expect(yamlBlocks(skill)).toHaveLength(1);
    expect(() => SuiteDef.parse(parseYaml(yamlBlocks(skill)[0] as string))).not.toThrow();
    for (const [, text] of reference.matchAll(/^\| `(- [^`]+)` \|/gm)) {
      expect(() => StepDef.parse(parseYaml(text as string)[0]), text).not.toThrow();
    }
    for (const [, text] of reference.matchAll(/^\| `([a-z_]+: [^`]+)` \|/gm)) {
      expect(() => Assertion.parse(parseYaml(text as string)), text).not.toThrow();
    }
  });

  it("the documented case validates, records, and replays while model checks run each time", async () => {
    const config = yamlBlocks(reference)[0] as string;
    const sample = SuiteDef.parse(parseYaml(yamlBlocks(skill)[0] as string));
    sample.cases[0]!.expect.push({ check: "Is the user signed in?" }, { judge: "The note is deleted" });
    const configPath = tempProject(config, { "notes.suite.yaml": stringifyYaml(sample) });
    const root = path.dirname(configPath);
    dirs.push(root);
    const env = { TEST_EMAIL: "qa@example.com", TEST_PASSWORD: "fake-password" };
    expect(await main(["validate", "--config", configPath], { env, out: () => undefined, err: () => undefined })).toBe(0);
    const project = loadProject(configPath, { processEnv: env });
    const suites = loadSuites(project, [], { tags: [], ids: [], grep: null });
    const session = new FakeSession();
    session.onReplay = (steps, params) => {
      for (const step of steps) {
        if (step.op !== "click") continue;
        if (step.target.name === "Sign in") session.page.url = "https://app.staging.example.com/app.html";
        if (step.target.name.startsWith("Add ")) session.page.rows = [[params["title"] ?? ""]];
        if (step.target.name.startsWith("Delete ")) session.page.rows = [];
      }
      return { ok: true };
    };
    session.onJev = (task, params, goal) => {
      if (goal === "check") return { ok: true, steps: [], reason: "signed in", jevRequests: 1, check: { answer: true, probability: 0.9 } };
      const steps = [{ op: "click" as const, target: { role: "button", name: `${task.startsWith("Add ") ? "Add" : "Delete"} {title}` } }];
      session.onReplay(steps, params);
      return { ok: true, steps, reason: "done", jevRequests: 1 };
    };
    let judgeCalls = 0;
    const run = () => runAll({
      project, suites, sessions: factoryOf(session), mode: { ci: false, record: false, heal: "warn" }, workers: 1,
      reportDir: path.join(root, "reports", "test"), runId: "test",
      llm: { model: "fake", judge: async () => { judgeCalls++; return { pass: true, reason: "deleted" }; } },
    });
    const first = await run();
    expect(first.totals.passed).toBe(1);
    expect(first.suites[0]?.cases[0]?.steps.filter((s) => s.how === "recorded")).toHaveLength(2);
    session.calls = [];
    const second = await run();
    expect(second.totals.passed).toBe(1);
    expect(second.suites[0]?.cases[0]?.steps.filter((s) => s.how === "replay")).toHaveLength(2);
    expect(second.suites[0]?.cases[0]?.steps.some((s) => s.how === "recorded" || s.how === "healed")).toBe(false);
    expect(session.calls.filter((c) => c.startsWith("jev act"))).toHaveLength(0);
    expect(session.calls.filter((c) => c.startsWith("jev check"))).toHaveLength(1);
    expect(judgeCalls).toBe(2);
  });

  it("the reference names every step and every check", () => {
    const steps = unionKeys(StepDef);
    expect(steps.length).toBeGreaterThan(5);
    for (const k of steps) expect(reference, `step ${k}`).toContain(`- ${k}:`);
    const checks = unionKeys(Assertion);
    expect(checks.length).toBeGreaterThan(5);
    for (const k of checks) expect(reference, `check ${k}`).toContain(`\`${k}:`);
  });

  it("the reference names every case, suite, and top-level config key", () => {
    for (const k of [...Object.keys(CaseDef.shape), ...Object.keys(SuiteDef.shape), ...Object.keys(ConfigDef.shape)]) {
      expect(reference, k).toMatch(new RegExp(`(^|\\s|\\{ )${k}:`, "m"));
    }
  });

  it("the reference names every command and every option of the help text", async () => {
    const out: string[] = [];
    await main(["--help"], { out: (s) => out.push(s), err: () => undefined, env: {} });
    const help = out.join("\n");
    for (const c of ["init", "run", "list", "validate"]) expect(help).toContain(`jev-test ${c}`);
    for (const c of ["init", "run", "list", "validate"]) expect(reference, c).toContain(`\`jev-test ${c}`);
    const options = [...help.matchAll(/^\s+(--[a-z-]+)/gm)].map((m) => m[1] as string).filter((o) => !["--jev-key", "--llm-key", "--help"].includes(o));
    expect(options.length).toBeGreaterThan(10);
    for (const o of options) expect(reference, o).toContain(`\`${o}`);
  });

  it("the skill keeps the rules that the runner enforces", () => {
    for (const w of ["Expected results never repair", "`${ENV}`", "`{now}`", "`start`", "`cleanup`", "`optional: true`", "npx jev-test validate", "--ci", ".jev/recordings/", "`healed`"]) expect(skill, w).toContain(w);
  });
});
