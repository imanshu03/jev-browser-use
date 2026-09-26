import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BuildOptions } from "esbuild";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { RUN_STATUSES } from "../src/mcp/runs.js";
import { TOOL_NAMES } from "../src/mcp/view.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(root, "plugin");
const read = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(root, rel), "utf8")) as Record<string, unknown>;
const pkg = read("package.json") as { version: string };

const JSON_FILES = [
  "plugin/.claude-plugin/plugin.json", "plugin/.codex-plugin/plugin.json", "plugin/.mcp.json", "plugin/.codex-mcp.json",
  ".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json",
];
// The spec lists. The code lists are compared too.
const TOOLS = ["browse", "wait", "continue", "cancel", "close_browser"];
const STATUSES = ["running", "needs_text", "confirming", "paused", "stopping", "done", "blocked", "failed"];

interface McpEntry { command: string; args: string[]; cwd?: string; env_vars?: string[] }
const server = (rel: string): McpEntry => (read(rel) as { mcpServers: Record<string, McpEntry> }).mcpServers["jev"] as McpEntry;

function skill(): { name: string; description: string; body: string } {
  const text = readFileSync(path.join(plugin, "skills/jev-browser/SKILL.md"), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error("SKILL.md has no frontmatter");
  const fields = new Map<string, string>();
  for (const line of (m[1] as string).split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return { name: fields.get("name") ?? "", description: fields.get("description") ?? "", body: text };
}

describe("plugin files", () => {
  it("every JSON file parses", () => {
    for (const f of JSON_FILES) expect(() => read(f), f).not.toThrow();
  });

  it("the Claude plugin has the package version and runs the bundle from the plugin root", () => {
    const manifest = read("plugin/.claude-plugin/plugin.json");
    expect(manifest["name"]).toBe("jev-browser");
    expect(manifest["version"]).toBe(pkg.version);
    const s = server("plugin/.mcp.json");
    expect(s.command).toBe("node");
    expect(s.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/dist/jev-mcp.mjs"]);
  });

  it("the Codex plugin has the package version, and its paths exist", () => {
    const manifest = read("plugin/.codex-plugin/plugin.json");
    expect(manifest["name"]).toBe("jev-browser");
    expect(manifest["version"]).toBe(pkg.version);
    for (const key of ["skills", "mcpServers"]) {
      const rel = manifest[key];
      expect(typeof rel === "string" && rel.startsWith("./"), key).toBe(true);
      expect(existsSync(path.join(plugin, rel as string)), key).toBe(true);
    }
    const s = server("plugin/.codex-mcp.json");
    expect(s.command).toBe("node");
    expect(s.args).toEqual(["./dist/jev-mcp.mjs"]);
    expect(s.cwd).toBe(".");
    // Codex gives a stdio server only a small base environment, so the key must be in the list. A headed Chrome
    // on Linux needs the display variables. Codex skips a variable that is not set.
    expect(s.env_vars).toEqual(expect.arrayContaining(["TYPESAFE_API_KEY", "JEV_MCP_ALLOW_FILE", "JEV_MCP_TRUST_ELICITATION", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]));
    // The README fallback for config.toml passes the same list.
    const readme = readFileSync(path.join(root, "README.md"), "utf8");
    const block = /\[mcp_servers\.jev\][\s\S]*?env_vars = (\[[\s\S]*?\])/.exec(readme);
    expect(JSON.parse(block?.[1] ?? "[]")).toEqual(s.env_vars);
  });

  it("both marketplaces list the plugin at ./plugin", () => {
    const claude = read(".claude-plugin/marketplace.json") as { name: string; plugins: { name: string; source: unknown }[] };
    const codex = read(".agents/plugins/marketplace.json") as { name: string; plugins: { name: string; source: { source: string; path: string }; policy: unknown; category: unknown }[] };
    expect(claude.name).toBe("jev-browser-use");
    expect(codex.name).toBe("jev-browser-use");
    expect(claude.plugins).toEqual([expect.objectContaining({ name: "jev-browser", source: "./plugin" })]);
    expect(codex.plugins).toHaveLength(1);
    expect(codex.plugins[0]).toMatchObject({ name: "jev-browser", source: { source: "local", path: "./plugin" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" } });
    expect(typeof codex.plugins[0]?.category).toBe("string");
  });
});

describe("skill", () => {
  it("has the name jev-browser and a description of 1024 characters or fewer", () => {
    const s = skill();
    expect(s.name).toBe("jev-browser");
    expect(s.description.length).toBeGreaterThan(0);
    expect(s.description.length).toBeLessThanOrEqual(1024);
  });

  it("names every tool and every status", () => {
    const { body } = skill();
    for (const n of [...TOOLS, ...STATUSES]) expect(body, n).toContain(`\`${n}\``);
  });

  it("names every TOOL_NAMES and RUN_STATUSES value", () => {
    const { body } = skill();
    for (const n of [...TOOL_NAMES, ...RUN_STATUSES]) expect(body, n).toContain(`\`${n}\``);
  });
});

interface Exit { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }

/** Runs a file with stdin on /dev/null and no key, no saved config, and an API URL that nothing listens on. */
function runNode(file: string, args: string[], home: string, ms = 5_000): Promise<Exit> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "", HOME: home, XDG_CONFIG_HOME: home, JEV_BROWSER_CONFIG: path.join(home, "no-config.json"),
    TYPESAFE_API_KEY: "", TYPESAFE_BASE_URL: "http://127.0.0.1:9",
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false;
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, ms);
    child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut }); });
  });
}

describe("bundle", () => {
  // The real path: on macOS the temp directory is a symlink, and a symlinked argv[1] would hide the isMain problem.
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jev-bundle-")));
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });
  const buildOptions = async (): Promise<BuildOptions> =>
    ((await import(pathToFileURL(path.join(root, "scripts/build-mcp.mjs")).href)) as { options: BuildOptions }).options;

  it("a bundle that holds cli.ts and chat.ts starts neither of them (isMain)", async () => {
    const outfile = path.join(tmp, "cli-chat.mjs");
    await build({ ...(await buildOptions()), entryPoints: [path.join(root, "src/chat.ts")], outfile });
    for (const args of [[], ["--version"], ["--help"]]) {
      const r = await runNode(outfile, args, tmp);
      expect(r, args.join(" ")).toMatchObject({ code: 0, stdout: "", timedOut: false });
    }
  }, 30_000);

  it("a direct run of src/cli.ts or src/chat.ts still starts it", async () => {
    const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
    const cli = await runNode(tsx, [path.join(root, "src/cli.ts"), "--version"], tmp, 20_000);
    expect(cli).toMatchObject({ code: 0, stdout: `jev-browser ${pkg.version}\n` });
    const chat = await runNode(tsx, [path.join(root, "src/chat.ts"), "--help"], tmp, 20_000);
    expect(chat.code).toBe(0);
    expect(chat.stdout).toContain("jev-chat [options]");
  }, 45_000);

  it("the build script knows that it is the main module also through a symlinked path", async () => {
    const { isMain } = (await import(pathToFileURL(path.join(root, "scripts/build-mcp.mjs")).href)) as { isMain: (argv1: string | undefined, url: string) => boolean };
    const real = path.join(tmp, "real");
    mkdirSync(real, { recursive: true });
    const file = path.join(real, "build-mcp.mjs");
    writeFileSync(file, "");
    const link = path.join(tmp, "link");
    symlinkSync(real, link);
    const url = pathToFileURL(file).href;
    expect(isMain(path.join(link, "build-mcp.mjs"), url)).toBe(true);
    expect(isMain(file, url)).toBe(true);
    expect(isMain(path.join(tmp, "other.mjs"), url)).toBe(false);
    expect(isMain(undefined, url)).toBe(false);
  });

  const mainTs = path.join(root, "src/mcp/main.ts");
  it("the MCP bundle exits 0 on stdin EOF and writes nothing to stdout", async () => {
    const options = await buildOptions();
    expect(options.entryPoints).toEqual([mainTs]);
    expect(options.outfile).toBe(path.join(plugin, "dist/jev-mcp.mjs"));
    const outfile = path.join(tmp, "jev-mcp.mjs");
    await build({ ...options, outfile });
    expect(readFileSync(outfile, "utf8")).toContain("Includes code adapted from browser-use/jev-ultrafast");
    for (const args of [[], ["--version"]]) {
      const r = await runNode(outfile, args, tmp);
      expect(r, `${args.join(" ")}\n${r.stderr}`).toMatchObject({ code: 0, stdout: "", timedOut: false });
    }
  }, 30_000);
});
