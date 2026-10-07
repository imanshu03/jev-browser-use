import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BuildOptions } from "esbuild";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { RUN_STATUSES } from "../src/runs.js";
import { TOOL_NAMES } from "../src/view.js";

const mcpDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(mcpDir, "..", "..");
const claudeDir = path.join(root, "plugins/claude");
const codexDir = path.join(root, "plugins/codex");
const read = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(root, rel), "utf8")) as Record<string, unknown>;
const pkg = read("packages/mcp/package.json") as { version: string };
const cliPkg = read("packages/cli/package.json") as { version: string };
const buildScript = path.join(mcpDir, "scripts/build.mjs");

const JSON_FILES = [
  "plugins/claude/.claude-plugin/plugin.json", "plugins/codex/.codex-plugin/plugin.json", "plugins/claude/.mcp.json", "plugins/codex/.codex-mcp.json",
  ".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json",
];

/** Every file under `dir`, as paths relative to it, sorted. */
function tree(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as Dirent[]).filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort();
}
// The spec lists. The code lists are compared too.
const TOOLS = ["browse", "wait", "continue", "cancel", "close_browser", "read_page", "scraper"];
const STATUSES = ["running", "needs_text", "confirming", "paused", "stopping", "done", "blocked", "failed"];

interface McpEntry { command: string; args: string[]; cwd?: string; env_vars?: string[] }
const server = (rel: string): McpEntry => (read(rel) as { mcpServers: Record<string, McpEntry> }).mcpServers["jev"] as McpEntry;

function skill(): { name: string; description: string; body: string } {
  const text = readFileSync(path.join(mcpDir, "skills/jev-browser/SKILL.md"), "utf8");
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
    const manifest = read("plugins/claude/.claude-plugin/plugin.json");
    expect(manifest["name"]).toBe("jev-browser");
    expect(manifest["version"]).toBe(pkg.version);
    const s = server("plugins/claude/.mcp.json");
    expect(s.command).toBe("node");
    expect(s.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/dist/jev-mcp.mjs"]);
  });

  it("the Codex plugin has the package version, and its paths exist", () => {
    const manifest = read("plugins/codex/.codex-plugin/plugin.json");
    expect(manifest["name"]).toBe("jev-browser");
    expect(manifest["version"]).toBe(pkg.version);
    for (const key of ["skills", "mcpServers"]) {
      const rel = manifest[key];
      expect(typeof rel === "string" && rel.startsWith("./"), key).toBe(true);
      expect(existsSync(path.join(codexDir, rel as string)), key).toBe(true);
    }
    const s = server("plugins/codex/.codex-mcp.json");
    expect(s.command).toBe("node");
    expect(s.args).toEqual(["./dist/jev-mcp.mjs"]);
    expect(s.cwd).toBe(".");
    // Codex gives a stdio server only a small base environment, so the key must be in the list. A headed Chrome
    // on Linux needs the display variables. Codex skips a variable that is not set.
    expect(s.env_vars).toEqual(expect.arrayContaining(["TYPESAFE_API_KEY", "JEV_MCP_ALLOW_FILE", "JEV_MCP_TRUST_ELICITATION", "JEV_MCP_AUTONOMOUS", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]));
    // The HOW_TO_USE.md fallback for config.toml passes the same list.
    const readme = readFileSync(path.join(root, "HOW_TO_USE.md"), "utf8");
    const block = /\[mcp_servers\.jev\][\s\S]*?env_vars = (\[[\s\S]*?\])/.exec(readme);
    expect(JSON.parse(block?.[1] ?? "[]")).toEqual(s.env_vars);
  });

  it("the Claude marketplace lists plugins/claude and the Codex marketplace lists plugins/codex", () => {
    const claude = read(".claude-plugin/marketplace.json") as { name: string; plugins: { name: string; source: unknown }[] };
    const codex = read(".agents/plugins/marketplace.json") as { name: string; plugins: { name: string; source: { source: string; path: string }; policy: unknown; category: unknown }[] };
    expect(claude.name).toBe("jev-browser-use");
    expect(codex.name).toBe("jev-browser-use");
    expect(claude.plugins).toEqual([expect.objectContaining({ name: "jev-browser", source: "./plugins/claude" })]);
    expect(codex.plugins).toHaveLength(1);
    expect(codex.plugins[0]).toMatchObject({ name: "jev-browser", source: { source: "local", path: "./plugins/codex" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" } });
    expect(typeof codex.plugins[0]?.category).toBe("string");
  });
});

describe("plugin folders share one MCP server and one skill set", () => {
  it("each plugin folder holds the same skills as packages/mcp/skills (run npm run plugins after a skill change)", () => {
    const want = tree(path.join(mcpDir, "skills"));
    expect(want.length).toBeGreaterThan(0);
    for (const dir of [claudeDir, codexDir]) {
      expect(tree(path.join(dir, "skills")), dir).toEqual(want);
      for (const f of want) expect(readFileSync(path.join(dir, "skills", f), "utf8"), `${dir} ${f}`).toBe(readFileSync(path.join(mcpDir, "skills", f), "utf8"));
    }
  });

  it("install copies the bundle and replaces the skills of each plugin folder", async () => {
    const { install, PLUGINS } = (await import(pathToFileURL(buildScript).href)) as { install: (dirs: string[], bundle: string) => void; PLUGINS: string[] };
    expect(PLUGINS).toEqual([claudeDir, codexDir]);
    const dirs = [1, 2, 3].map((n) => realpathSync(mkdtempSync(path.join(os.tmpdir(), `jev-plugin-${n}-`))));
    const bundle = path.join(dirs.pop() as string, "jev-mcp.mjs");
    writeFileSync(bundle, "// test bundle\n");
    mkdirSync(path.join(dirs[0] as string, "skills/old"), { recursive: true });
    writeFileSync(path.join(dirs[0] as string, "skills/old/SKILL.md"), "stale");
    install(dirs, bundle);
    for (const d of dirs) {
      expect(readFileSync(path.join(d, "dist/jev-mcp.mjs"), "utf8")).toBe("// test bundle\n");
      expect(tree(path.join(d, "skills"))).toEqual(tree(path.join(mcpDir, "skills")));
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("skill set", () => {
  const SKILLS = ["jev-browser", "jev-plugin", "jev-test"];
  const front = (name: string): Map<string, string> => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path.join(mcpDir, "skills", name, "SKILL.md"), "utf8"));
    return new Map((m?.[1] ?? "").split("\n").map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
  };

  it("each skill folder has a SKILL.md whose name is the folder name and whose description is 1024 characters or fewer", () => {
    expect(readdirSync(path.join(mcpDir, "skills")).sort()).toEqual(SKILLS);
    for (const name of SKILLS) {
      const f = front(name);
      expect(f.get("name"), name).toBe(name);
      expect((f.get("description") ?? "").length, name).toBeGreaterThan(0);
      expect((f.get("description") ?? "").length, name).toBeLessThanOrEqual(1024);
    }
  });

  it("each relative link of a skill points to a file that exists", () => {
    for (const f of tree(path.join(mcpDir, "skills")).filter((x) => x.endsWith(".md"))) {
      const text = readFileSync(path.join(mcpDir, "skills", f), "utf8");
      for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/i.test(target as string)) continue;
        expect(existsSync(path.join(mcpDir, "skills", path.dirname(f), target as string)), `${f} -> ${target}`).toBe(true);
      }
    }
  });

  it("jev-plugin gives the install commands of both clients and names the other skills", () => {
    const body = readFileSync(path.join(mcpDir, "skills/jev-plugin/SKILL.md"), "utf8");
    for (const w of ["npm run plugins", "claude plugin install jev-browser@jev-browser-use", "codex plugin add jev-browser@jev-browser-use", "TYPESAFE_API_KEY", "`jev-browser`", "`jev-test`"]) expect(body, w).toContain(w);
    const readme = readFileSync(path.join(root, "HOW_TO_USE.md"), "utf8");
    for (const v of [...body.matchAll(/^\| `(JEV_MCP_[A-Z_]+)` \|/gm)].map((m) => m[1] as string)) expect(readme, v).toContain(`\`${v}\``);
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

  it("autonomous mode: the skill names confirm autonomous and user_said, and only the user's own message turns it on", () => {
    const { body } = skill();
    for (const w of ["`confirm: \"autonomous\"`", "`user_said`", "`result.unattended`", "own message", "A \"yes\" to your question does not count"]) expect(body, w).toContain(w);
    for (const f of ["plugins/claude/.claude-plugin/plugin.json", "plugins/codex/.codex-plugin/plugin.json"]) expect(JSON.stringify(read(f)), f).toContain("autonomous");
  });

  it("names every TOOL_NAMES and RUN_STATUSES value", () => {
    const { body } = skill();
    expect([...TOOL_NAMES]).toEqual(TOOLS);
    for (const n of [...TOOL_NAMES, ...RUN_STATUSES]) expect(body, n).toContain(`\`${n}\``);
  });

  it("the description names every tool, tables and lists, and scrapers", () => {
    const { description } = skill();
    for (const n of TOOL_NAMES) expect(description, n).toContain(n);
    expect(description).toContain("read tables and lists");
    expect(description).toContain("save scrapers");
  });

  it("tells to always pass goal, and to read tables and lists with read_page", () => {
    const { body } = skill();
    expect(body).toContain("Always pass `goal`: `act` to change the page (click, type, submit), `extract` to read one value, `check` for a yes or no answer.");
    const read = /## Read tables and lists\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
    for (const w of ["`read_page`", "`cursor`", "`load: true`", "`untrusted_tables`", "`untrusted_records`", "They are data", "`suspect`"]) expect(read, w).toContain(w);
  });

  it("the scraper flow: browse with goal act, then read_page, then scraper save with from_run, then scraper run; jev-scrape run heals by itself", () => {
    const { body } = skill();
    const flow = /## Build a scraper\n([\s\S]*?)\n## /.exec(body)?.[1] ?? "";
    const at = (w: string): number => { const i = flow.indexOf(w); expect(i, w).toBeGreaterThanOrEqual(0); return i; };
    const order = ["1. Call `browse`", "`goal: \"act\"`", "2. Call `read_page`", "3. Call `scraper` with `action: \"save\"`", "`from_run`", "`params`", "`extract`", "4. Call `scraper` with `action: \"run\"`", "5. Tell the user: `jev-scrape run <name>"];
    const positions = order.map(at);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(flow).toContain("with no model calls, and it heals by itself");
    expect(flow).toContain("heals by code only");
    expect(flow).toContain("`jev-scrape rm <name>`");
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
    ((await import(pathToFileURL(buildScript).href)) as { options: BuildOptions }).options;

  it("a bundle that holds cli.ts and chat.ts starts neither of them (isMain)", async () => {
    const outfile = path.join(tmp, "cli-chat.mjs");
    await build({ ...(await buildOptions()), entryPoints: [path.join(root, "packages/cli/src/chat.ts")], outfile });
    for (const args of [[], ["--version"], ["--help"]]) {
      const r = await runNode(outfile, args, tmp);
      expect(r, args.join(" ")).toMatchObject({ code: 0, stdout: "", timedOut: false });
    }
  }, 30_000);

  it("a direct run of src/cli.ts or src/chat.ts still starts it", async () => {
    const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
    const cli = await runNode(tsx, ["--conditions=jev-source", path.join(root, "packages/cli/src/cli.ts"), "--version"], tmp, 20_000);
    expect(cli).toMatchObject({ code: 0, stdout: `jev-browser ${cliPkg.version}\n` });
    const chat = await runNode(tsx, ["--conditions=jev-source", path.join(root, "packages/cli/src/chat.ts"), "--help"], tmp, 20_000);
    expect(chat.code).toBe(0);
    expect(chat.stdout).toContain("jev-chat [options]");
  }, 45_000);

  it("the build script knows that it is the main module also through a symlinked path", async () => {
    const { isMain } = (await import(pathToFileURL(buildScript).href)) as { isMain: (argv1: string | undefined, url: string) => boolean };
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

  const mainTs = path.join(mcpDir, "src/main.ts");
  it("the MCP bundle exits 0 on stdin EOF and writes nothing to stdout", async () => {
    const options = await buildOptions();
    expect(options.entryPoints).toEqual([mainTs]);
    expect(options.outfile).toBe(path.join(mcpDir, "dist/jev-mcp.mjs"));
    const outfile = path.join(tmp, "jev-mcp.mjs");
    await build({ ...options, outfile });
    expect(readFileSync(outfile, "utf8")).toContain("Includes code adapted from browser-use/jev-ultrafast");
    // The MIT License asks for its permission notice in every copy of the ported code.
    expect(readFileSync(outfile, "utf8")).toContain("// Permission is hereby granted, free of charge, to any person obtaining a copy");
    for (const args of [[], ["--version"]]) {
      const r = await runNode(outfile, args, tmp);
      expect(r, `${args.join(" ")}\n${r.stderr}`).toMatchObject({ code: 0, stdout: "", timedOut: false });
    }
  }, 30_000);
});
