// The jev-test skill of the plugin (packages/mcp/skills/jev-test) must name every step, check, config key, and option of the runner.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { Assertion, CaseDef, ConfigDef, StepDef, SuiteDef } from "../src/schema.js";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "mcp", "skills", "jev-test");
const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
const reference = fs.readFileSync(path.join(skillDir, "references", "reference.md"), "utf8");

/** The first key of each object option of a zod union. */
function unionKeys(u: { options: readonly unknown[] }): string[] {
  return u.options.flatMap((o) => (o && typeof o === "object" && "shape" in o ? [Object.keys((o as { shape: object }).shape)[0] as string] : []));
}

describe("jev-test skill", () => {
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
