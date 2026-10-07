import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import type { Prompter } from "../src/init.js";
import { LLM_KEY_VAR, mergeEnv, mergeGitignore, runInit, terminalPrompter } from "../src/init.js";
import { PassThrough } from "node:stream";
import type { FetchLike } from "../src/llm.js";
import { createLlm } from "../src/llm.js";
import { loadProject, loadSuites } from "../src/load.js";

/** A prompter that answers from a list and records each question. */
function scripted(answers: string[], confirms: boolean[] = []): Prompter & { asked: { q: string; secret: boolean }[]; said: string[] } {
  const asked: { q: string; secret: boolean }[] = [];
  const said: string[] = [];
  return {
    asked, said,
    async ask(q, opts = {}) { asked.push({ q, secret: Boolean(opts.secret) }); const a = answers.shift() ?? ""; return a || opts.default || ""; },
    async confirm(q, fallback) { asked.push({ q, secret: false }); return confirms.length > 0 ? (confirms.shift() as boolean) : fallback; },
    say(l) { said.push(l); },
    close() {},
  };
}

const models = (ids: string[], status = 200): FetchLike => async () => ({ ok: status < 300, status, text: async () => JSON.stringify({ data: ids.map((id) => ({ id })) }) });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jev-init-"));

describe("runInit", () => {
  it("asks each setting, keeps keys in .env only, and writes a config that loads", async () => {
    const dir = tmp();
    const p = scripted(["https://app.example.com/", "", "ts-key-1234", "https://llm.example.com/v1", "llm-key-5678", "gpt-x"], [true, false]);
    expect(await runInit({ dir, given: {}, yes: false, force: false, env: {}, prompter: p, fetch: models(["gpt-x"]) })).toBe(0);
    expect(p.asked.filter((a) => a.secret).map((a) => a.q)).toEqual([expect.stringMatching(/TypeSafe API key/), expect.stringMatching(/API key of that endpoint/)]);
    expect(p.said).toContain("  LLM check: the endpoint answers and has the model \"gpt-x\"");
    const config = fs.readFileSync(path.join(dir, "jev-test.config.yaml"), "utf8");
    expect(config).not.toContain("ts-key-1234");
    expect(config).not.toContain("llm-key-5678");
    const env = parseEnv(fs.readFileSync(path.join(dir, ".env"), "utf8"));
    expect(env).toEqual({ TYPESAFE_API_KEY: "ts-key-1234", [LLM_KEY_VAR]: "llm-key-5678" });
    expect(fs.statSync(path.join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(".env\nreports/\n");
    const project = loadProject(path.join(dir, "jev-test.config.yaml"), { processEnv: env });
    expect(project.env).toEqual({ name: "staging", baseUrl: "https://app.example.com" });
    expect(project.config.llm).toMatchObject({ base_url: "https://llm.example.com/v1", api_key: "llm-key-5678", model: "gpt-x" });
    expect(project.secrets.redact("llm-key-5678 ts-key-1234")).toBe("*** ***");
    expect(createLlm(project.config.llm)?.model).toBe("gpt-x");
    expect(loadSuites(project, [], { tags: ["smoke"], ids: [], grep: null }).map((s) => s.def.cases[0]?.id)).toEqual(["EXAMPLE-001"]);
    expect(fs.existsSync(path.join(dir, ".github"))).toBe(false);
  });

  it("with no LLM URL asks no key or model, and the config has no llm", async () => {
    const dir = tmp();
    const p = scripted(["https://app.example.com", "qa", "", ""], [false, false]);
    expect(await runInit({ dir, given: {}, yes: false, force: false, env: {}, prompter: p })).toBe(0);
    expect(p.asked.map((a) => a.q).some((q) => /Model name/.test(q))).toBe(false);
    const project = loadProject(path.join(dir, "jev-test.config.yaml"), { processEnv: {} });
    expect(createLlm(project.config.llm)).toBeNull();
    expect(project.env.name).toBe("qa");
    expect(fs.existsSync(path.join(dir, ".env"))).toBe(false);
    expect(p.said.join("\n")).toMatch(/Add TYPESAFE_API_KEY to \.env/);
  });

  it("asks again for a bad URL, and stops after three tries", async () => {
    const dir = tmp();
    const ok = scripted(["not a url", "https://app.example.com", "", "", ""]);
    expect(await runInit({ dir, given: {}, yes: false, force: false, env: {}, prompter: ok })).toBe(0);
    expect(ok.said).toContain("  give an http or https URL");
    const bad = scripted(["x", "y", "z"]);
    expect(await runInit({ dir: tmp(), given: {}, yes: false, force: false, env: {}, prompter: bad })).toBe(2);
  });

  it("reports an LLM that fails the check, and stops when the user does not keep it", async () => {
    const dir = tmp();
    const p = scripted(["https://app.example.com", "", "", "https://llm.example.com/v1", "k", "m"], [false]);
    expect(await runInit({ dir, given: {}, yes: false, force: false, env: {}, prompter: p, fetch: models([], 401) })).toBe(2);
    expect(p.said.join("\n")).toMatch(/LLM check: GET \/models answered 401/);
    expect(fs.existsSync(path.join(dir, "jev-test.config.yaml"))).toBe(false);
    const other = scripted(["https://app.example.com", "", "", "https://llm.example.com/v1", "k", "m"], [true, false, false]);
    expect(await runInit({ dir, given: {}, yes: false, force: false, env: {}, prompter: other, fetch: models(["a", "b"]) })).toBe(0);
    expect(other.said).toContain("  LLM check: the endpoint answers, but its 2 model(s) do not include \"m\"");
  });

  it("--yes takes the given values and the env keys, and fails for a missing app URL", async () => {
    const dir = tmp();
    const p = scripted([]);
    const code = await runInit({ dir, given: { appUrl: "https://app.example.com", llmUrl: "https://llm.example.com/v1", llmModel: "m", ciWorkflow: true }, yes: true, force: false,
      env: { TYPESAFE_API_KEY: "from-env-1", [LLM_KEY_VAR]: "from-env-2" }, prompter: p, fetch: models(["m"]) });
    expect(code).toBe(0);
    expect(p.asked).toEqual([]);
    expect(parseEnv(fs.readFileSync(path.join(dir, ".env"), "utf8"))).toEqual({ TYPESAFE_API_KEY: "from-env-1", [LLM_KEY_VAR]: "from-env-2" });
    const wf = fs.readFileSync(path.join(dir, ".github/workflows/jev-test.yml"), "utf8");
    expect(wf).toContain("TYPESAFE_API_KEY: ${{ secrets.TYPESAFE_API_KEY }}");
    expect(wf).toContain(`${LLM_KEY_VAR}: \${{ secrets.${LLM_KEY_VAR} }}`);
    expect(await runInit({ dir: tmp(), given: {}, yes: true, force: false, env: {}, prompter: scripted([]) })).toBe(2);
  });

  it("keeps an existing config unless --force, merges .env and .gitignore, and keeps existing suites", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "jev-test.config.yaml"), "old");
    fs.writeFileSync(path.join(dir, ".env"), "OTHER=1\nTYPESAFE_API_KEY=old\n");
    fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n.env\n");
    fs.mkdirSync(path.join(dir, "suites"));
    fs.writeFileSync(path.join(dir, "suites/mine.suite.yaml"), "suite: Mine\ncases: [{ id: M-1, title: t }]\n");
    const given = { appUrl: "https://app.example.com", jevKey: "new-key-1" };
    expect(await runInit({ dir, given, yes: true, force: false, env: {}, prompter: scripted([]) })).toBe(2);
    expect(fs.readFileSync(path.join(dir, "jev-test.config.yaml"), "utf8")).toBe("old");
    expect(await runInit({ dir, given, yes: true, force: true, env: {}, prompter: scripted([]) })).toBe(0);
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe("OTHER=1\nTYPESAFE_API_KEY=new-key-1\n");
    expect(fs.readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("node_modules/\n.env\nreports/\n");
    expect(fs.existsSync(path.join(dir, "suites/example.suite.yaml"))).toBe(false);
  });
});

describe("env and gitignore merges", () => {
  it("quotes a value with special characters so that .env parses it back", () => {
    const text = mergeEnv("", { A: "plain-value_1", B: "has space#and=hash", C: "" });
    expect(text).toBe("A=plain-value_1\nB='has space#and=hash'\n");
    expect(parseEnv(text)).toEqual({ A: "plain-value_1", B: "has space#and=hash" });
  });
  it("adds only missing lines", () => {
    expect(mergeGitignore("a\n.env", [".env", "reports/"])).toBe("a\n.env\nreports/\n");
    expect(mergeGitignore(".env\nreports/\n", [".env", "reports/"])).toBe(".env\nreports/\n");
  });
});

describe("cli init", () => {
  it("runs init with options and writes the files", async () => {
    const dir = tmp();
    const out: string[] = [];
    const code = await main(["init", "--yes", "--dir", dir, "--app-url", "https://app.example.com", "--env-name", "prod", "--no-example"],
      { out: (s) => out.push(s), err: (s) => out.push(s), env: {}, prompter: scripted([]) });
    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(dir, "jev-test.config.yaml"), "utf8")).toContain("default_environment: prod");
    expect(fs.existsSync(path.join(dir, "suites"))).toBe(false);
  });
});

describe("terminalPrompter", () => {
  it("keeps piped lines that arrive before a question, takes defaults, and answers empty after end of input", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (d) => { shown += String(d); });
    input.end("https://a.example\n\ny\n");
    const p = terminalPrompter(input, output);
    expect(await p.ask("URL")).toBe("https://a.example");
    expect(await p.ask("Name", { default: "staging" })).toBe("staging");
    expect(await p.confirm("OK?", false)).toBe(true);
    expect(await p.ask("Key", { secret: true })).toBe("");
    expect(await p.confirm("More?", true)).toBe(true);
    p.close();
    expect(shown).toContain("Name [staging]: ");
    expect(shown).toContain("Key (hidden): ");
  });
});

it("quotes YAML values so that model names and URL fragments load unchanged", async () => {
  for (const llmModel of ["123", "null", "provider: model", "model # label"]) {
    const dir = tmp();
    const appUrl = "https://app.example/path# part";
    expect(await runInit({ dir, given: { appUrl, llmUrl: "https://llm.example/v1", llmModel }, yes: true, force: false, env: {}, prompter: scripted([]), fetch: models([llmModel]) })).toBe(0);
    const project = loadProject(path.join(dir, "jev-test.config.yaml"), { processEnv: {} });
    expect(project.env.baseUrl).toBe(appUrl);
    expect(project.config.llm.model).toBe(llmModel);
  }
});

it("rejects an empty environment name before writing files", async () => {
  const dir = tmp();
  expect(await runInit({ dir, given: { appUrl: "https://app.example", envName: "" }, yes: true, force: false, env: {}, prompter: scripted([]) })).toBe(2);
  expect(fs.existsSync(path.join(dir, "jev-test.config.yaml"))).toBe(false);
});

it("keeps keys with quote characters unchanged in .env", () => {
  for (const value of ["has'quote", 'has"quote', 'both\'and"quotes', 'all\'three"quotes`']) {
    expect(parseEnv(mergeEnv("", { TYPESAFE_API_KEY: value }))["TYPESAFE_API_KEY"]).toBe(value);
  }
});

it("replaces duplicate and spaced key assignments without changing other values", () => {
  const existing = "OTHER=keep\nTYPESAFE_API_KEY=old\nexport TYPESAFE_API_KEY = stale\nTYPESAFE_API_KEY=stale\n";
  const merged = mergeEnv(existing, { TYPESAFE_API_KEY: "new-key" });
  expect(parseEnv(merged)).toEqual({ OTHER: "keep", TYPESAFE_API_KEY: "new-key" });
  expect(merged).not.toContain("stale");
  expect(merged).not.toContain("old");
});

it("removes keys from endpoint error text before init prints or shortens it", async () => {
  const key = 'private-key-"with-quotes';
  const p = scripted([]);
  expect(await runInit({ dir: tmp(), given: { appUrl: "https://app.example", llmUrl: "https://llm.example/v1", llmModel: "model", llmKey: key }, yes: true, force: false, env: {}, prompter: p,
    fetch: async () => ({ ok: false, status: 401, text: async () => "x".repeat(180) + JSON.stringify({ key }) }) })).toBe(0);
  expect(p.said.join("\n")).not.toContain("priva");
  expect(p.said.join("\n")).toContain("***");
});

it("keeps a secret answer out of terminal history", async () => {
  vi.stubEnv("TERM", "xterm");
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk) => { shown += String(chunk); });
  const p = terminalPrompter(input, output);
  try {
    const key = p.ask("Key", { secret: true });
    input.write("private-secret-key\r");
    expect(await key).toBe("private-secret-key");
    const model = p.ask("Model");
    input.write("\x1b[A");
    input.write("m\r");
    expect(await model).toBe("m");
    expect(shown).not.toContain("private-secret-key");
  } finally { p.close(); input.end(); vi.unstubAllEnvs(); }
});

it("keeps multiline .env entries and replaces a multiline key as one assignment", () => {
  const other = "OTHER='a line\nTYPESAFE_API_KEY=not-an-assignment\nlast line'\n";
  const text = mergeEnv(other + "TYPESAFE_API_KEY='old\nkey'\n", { TYPESAFE_API_KEY: "new-key" });
  expect(text).toBe(other + "TYPESAFE_API_KEY=new-key\n");
  expect(parseEnv(text).TYPESAFE_API_KEY).toBe("new-key");
});

it("rejects a key that .env cannot encode before it writes any file", async () => {
  const dir = tmp();
  const old = "OTHER=keep\n";
  fs.writeFileSync(path.join(dir, ".env"), old);
  expect(await runInit({ dir, given: { appUrl: "https://app.example", jevKey: 'all\'three"quotes` # suffix' }, yes: true, force: false, env: {}, prompter: scripted([]) })).toBe(2);
  expect(fs.existsSync(path.join(dir, "jev-test.config.yaml"))).toBe(false);
  expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe(old);
});
