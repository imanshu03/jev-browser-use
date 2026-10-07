import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { tempProject } from "./fake.js";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(pkg, "../..");

it("runs the source in a checkout that has no dist directory", () => {
  const copy = fs.mkdtempSync(path.join(root, "node_modules", "jev-test-source-"));
  try {
    for (const name of ["src", "bin", "package.json"]) fs.cpSync(path.join(pkg, name), path.join(copy, name), { recursive: true });
    const config = tempProject("base_url: https://app.example\n", { "a.suite.yaml": "suite: A\ncases: [{ id: A-1, title: one }]\n" });
    const out = execFileSync(process.execPath, [path.join(copy, "bin/jev-test.js"), "validate", "--config", config], { encoding: "utf8", timeout: 15_000 });
    expect(out).toContain("ok: 1 suite(s), 1 case(s)");
  } finally { fs.rmSync(copy, { recursive: true, force: true }); }
});

it("runs built code when the installed package has no source or tsx", () => {
  const config = tempProject("base_url: https://app.example\n", {});
  const copy = path.join(path.dirname(config), "installed");
  fs.mkdirSync(copy);
  try {
    fs.cpSync(path.join(pkg, "bin"), path.join(copy, "bin"), { recursive: true });
    fs.writeFileSync(path.join(copy, "package.json"), '{"type":"module"}');
    fs.mkdirSync(path.join(copy, "dist"));
    fs.writeFileSync(path.join(copy, "dist/cli.js"), 'process.stdout.write("built " + process.argv.slice(2).join(" "));');
    const out = execFileSync(process.execPath, [path.join(copy, "bin/jev-test.js"), "--help"], { encoding: "utf8", timeout: 15_000 });
    expect(out).toBe("built --help");
  } finally { fs.rmSync(copy, { recursive: true, force: true }); }
});
