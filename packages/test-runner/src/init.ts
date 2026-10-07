// jev-test init: ask for the settings of a project and write its config, .env, .gitignore lines, and an example suite.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { FetchLike } from "./llm.js";
import { CONFIG_FILE } from "./load.js";

/** The env var names that init writes to .env. The config refers to them, so no key goes into the config file. */
export const JEV_KEY_VAR = "TYPESAFE_API_KEY";
export const LLM_KEY_VAR = "JEV_TEST_LLM_API_KEY";

export interface Prompter {
  ask(question: string, opts?: { default?: string; secret?: boolean }): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  say(line: string): void;
  close(): void;
}

export interface InitAnswers {
  envName: string;
  appUrl: string;
  jevKey: string;
  llmUrl: string;
  llmKey: string;
  llmModel: string;
  example: boolean;
  ciWorkflow: boolean;
}

export interface InitOptions {
  dir: string;
  /** Values given on the command line. A value that is given is not asked. */
  given: Partial<InitAnswers>;
  /** Ask nothing: take the given values, the env keys, and the defaults. */
  yes: boolean;
  force: boolean;
  env: NodeJS.ProcessEnv;
  prompter: Prompter;
  fetch?: FetchLike;
}

const ENV_NAME = /^[a-z][a-z0-9_-]{0,30}$/;
const SAFE_ENV_VALUE = /^[A-Za-z0-9_\-.:/+=@]*$/;

function isHttpUrl(s: string): boolean {
  try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
}

/** A prompter on a terminal or a pipe. A secret answer is not echoed. Lines are buffered, so piped answers are not lost; end of input answers "". */
export function terminalPrompter(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Prompter {
  const rl = readline.createInterface({ input, output, terminal: Boolean((input as NodeJS.ReadStream).isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  let closed = false;
  rl.on("close", () => { closed = true; });
  let muted = false;
  const raw = rl as unknown as { _writeToOutput: (s: string) => void };
  const write = raw._writeToOutput.bind(rl);
  raw._writeToOutput = (s: string) => { if (!muted) write(s); else if (s.includes("\n")) write("\n"); };
  const question = async (q: string, secret = false): Promise<string> => {
    // After the input closes, readline cannot show a prompt, but the lines that it buffered still come first.
    if (closed) output.write(q);
    else { rl.setPrompt(q); rl.prompt(); }
    muted = secret;
    const r = await lines.next();
    muted = false;
    if (r.done || closed) output.write("\n");
    return r.done ? "" : String(r.value);
  };
  return {
    async ask(q, opts = {}) {
      const hint = opts.secret ? " (hidden)" : opts.default ? ` [${opts.default}]` : "";
      const a = (await question(`${q}${hint}: `, Boolean(opts.secret))).trim();
      return a || opts.default || "";
    },
    async confirm(q, fallback) {
      const a = (await question(`${q} [${fallback ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
      return a ? a.startsWith("y") : fallback;
    },
    say(line) { output.write(line + "\n"); },
    close() { if (!closed) rl.close(); },
  };
}

/** Check an OpenAI-compatible endpoint with GET /models. It reports; it never stops init. */
export async function checkLlm(baseUrl: string, apiKey: string, model: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<{ ok: boolean; detail: string }> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, { method: "GET", headers, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) return { ok: false, detail: `GET /models answered ${res.status}: ${text.slice(0, 200)}` };
    const ids = ((JSON.parse(text) as { data?: { id?: unknown }[] }).data ?? []).map((m) => String(m.id ?? ""));
    if (ids.length > 0 && !ids.includes(model)) return { ok: true, detail: `the endpoint answers, but its ${ids.length} model(s) do not include "${model}"` };
    return { ok: true, detail: ids.length > 0 ? `the endpoint answers and has the model "${model}"` : "the endpoint answers" };
  } catch (e) {
    return { ok: false, detail: `the endpoint did not answer: ${(e as Error).message}` };
  }
}

export function renderConfig(a: InitAnswers): string {
  const llm = a.llmUrl
    ? [
      "# Any OpenAI-compatible endpoint (OpenAI, a LiteLLM proxy, OpenRouter, a local server). Used for judge checks and new field text.",
      "llm:",
      `  base_url: ${a.llmUrl}`,
      `  api_key: \${${LLM_KEY_VAR}}`,
      `  model: ${a.llmModel}`,
    ]
    : [
      "# No LLM is set, so judge checks fail with a hint. To add one, run jev-test init --force or add:",
      "# llm:",
      "#   base_url: https://api.openai.com/v1",
      `#   api_key: \${${LLM_KEY_VAR}}`,
      "#   model: <model name>",
    ];
  return [
    "# Created by jev-test init. Keys are in .env, which git ignores.",
    "environments:",
    `  ${a.envName}:`,
    `    base_url: ${a.appUrl}`,
    `default_environment: ${a.envName}`,
    "",
    "suites: suites",
    "recordings: .jev/recordings",
    "reports: reports",
    "",
    "browser:",
    "  headed: false",
    "  workers: 1",
    "",
    "# Jev chooses the clicks when a step records or repairs. A replay needs no key.",
    "jev:",
    `  api_key: \${${JEV_KEY_VAR}}`,
    "",
    ...llm,
    "",
    "heal:",
    "  local: warn",
    "  ci: fail",
    "",
  ].join("\n");
}

export function exampleSuite(appUrl: string): string {
  return [
    "suite: Example",
    "tags: [example]",
    "",
    "cases:",
    "  - id: EXAMPLE-001",
    "    title: The home page opens",
    "    tags: [smoke]",
    "    start: /",
    "    expect:",
    `      - url_contains: ${JSON.stringify(new URL(appUrl).host)}`,
    "",
  ].join("\n");
}

export function ciWorkflow(withLlm: boolean): string {
  return [
    "name: jev-test",
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      tag: { description: Tag filter (empty for all), default: smoke }",
    "  pull_request:",
    "",
    "jobs:",
    "  run:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with: { node-version: 22, registry-url: https://npm.pkg.github.com, scope: \"@imanshu03\" }",
    "      - run: npm ci",
    "        env:",
    "          NODE_AUTH_TOKEN: ${{ secrets.PACKAGES_TOKEN }}",
    "      - run: npx jev-test run --ci ${{ inputs.tag && format('--tag {0}', inputs.tag) || '' }} --report-dir reports/ci",
    "        env:",
    `          ${JEV_KEY_VAR}: \${{ secrets.${JEV_KEY_VAR} }}`,
    ...(withLlm ? [`          ${LLM_KEY_VAR}: \${{ secrets.${LLM_KEY_VAR} }}`] : []),
    "      - uses: actions/upload-artifact@v4",
    "        if: always()",
    "        with: { name: jev-test-reports, path: reports/ci }",
    "",
  ].join("\n");
}

/** Set `values` in .env text: replace a line of the same key, else append. Empty values are not written. */
export function mergeEnv(existing: string, values: Record<string, string>): string {
  const lines = existing ? existing.replace(/\n$/, "").split("\n") : [];
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    const quoted = SAFE_ENV_VALUE.test(value) ? value : `'${value}'`;
    const i = lines.findIndex((l) => l.replace(/^export\s+/, "").startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${quoted}`;
    else lines.push(`${key}=${quoted}`);
  }
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

/** Add the lines that a .gitignore lacks. */
export function mergeGitignore(existing: string, want: readonly string[]): string {
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  const add = want.filter((w) => !have.has(w));
  if (add.length === 0) return existing;
  return (existing && !existing.endsWith("\n") ? existing + "\n" : existing) + add.join("\n") + "\n";
}

class InitError extends Error {
  override name = "InitError";
}

/** Ask for a value until it is valid. With --yes, or after 3 tries, a missing or bad value is an error. */
async function value(o: InitOptions, key: keyof InitAnswers, question: string, opts: { default?: string; secret?: boolean; envVar?: string; required?: boolean; check?: (s: string) => string | null }): Promise<string> {
  const given = o.given[key];
  const check = (s: string): string | null => (!s ? (opts.required ? "a value is needed" : null) : opts.check ? opts.check(s) : null);
  if (typeof given === "string") {
    const problem = check(given);
    if (problem) throw new InitError(`--${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${problem}`);
    return given;
  }
  if (o.yes) {
    const v = (opts.envVar ? o.env[opts.envVar] : undefined) ?? opts.default ?? "";
    const problem = check(v);
    if (problem) throw new InitError(`${question}: ${problem}. Pass it as an option, or run init without --yes`);
    return v;
  }
  for (let tries = 0; ; tries++) {
    const v = await o.prompter.ask(question, { ...(opts.default ? { default: opts.default } : {}), ...(opts.secret ? { secret: true } : {}) });
    const problem = check(v);
    if (!problem) return v;
    if (tries >= 2) throw new InitError(`${question}: ${problem}`);
    o.prompter.say(`  ${problem}`);
  }
}

async function flag(o: InitOptions, key: "example" | "ciWorkflow", question: string, fallback: boolean): Promise<boolean> {
  const given = o.given[key];
  if (typeof given === "boolean") return given;
  return o.yes ? fallback : o.prompter.confirm(question, fallback);
}

/** Run init. Returns the exit code: 0 done, 2 not done (a config exists, or a value is missing or not valid). */
export async function runInit(o: InitOptions): Promise<number> {
  const say = (l: string) => o.prompter.say(l);
  const configPath = path.join(o.dir, CONFIG_FILE);
  try {
    if (fs.existsSync(configPath) && !o.force) throw new InitError(`${configPath} exists. Run init with --force to write it again`);
    if (!o.yes) say("jev-test init: answer each question, or press Enter to take the value in [brackets].\n");
    const appUrl = await value(o, "appUrl", "URL of the web app to test", { required: true, check: (s) => (isHttpUrl(s) ? null : "give an http or https URL") });
    const envName = await value(o, "envName", "Name of this environment", { default: "staging", check: (s) => (ENV_NAME.test(s) ? null : "use a-z, 0-9, _ and -, starting with a letter") });
    const jevKey = await value(o, "jevKey", "TypeSafe API key for Jev (empty: add it later; replays need no key)", { secret: true, envVar: JEV_KEY_VAR });
    const llmUrl = await value(o, "llmUrl", "OpenAI-compatible base URL for the LLM, such as https://api.openai.com/v1 (empty: no LLM)", { check: (s) => (isHttpUrl(s) ? null : "give an http or https URL") });
    let llmKey = "";
    let llmModel = "";
    if (llmUrl) {
      llmKey = await value(o, "llmKey", "API key of that endpoint (empty if it needs none)", { secret: true, envVar: LLM_KEY_VAR });
      llmModel = await value(o, "llmModel", "Model name", { required: true });
      const r = await checkLlm(llmUrl, llmKey, llmModel, o.fetch);
      say(`  LLM check: ${r.detail}`);
      if (!r.ok && !o.yes && !(await o.prompter.confirm("Keep these LLM settings anyway?", true))) throw new InitError("stopped: the LLM settings were not kept");
    }
    const suitesDir = path.join(o.dir, "suites");
    const hasSuites = fs.existsSync(suitesDir) && fs.readdirSync(suitesDir).some((f) => f.endsWith(".suite.yaml"));
    const example = hasSuites ? false : await flag(o, "example", "Write an example suite?", true);
    const ci = await flag(o, "ciWorkflow", "Write a GitHub Actions workflow?", false);
    const a: InitAnswers = { envName, appUrl: appUrl.replace(/\/+$/, ""), jevKey, llmUrl: llmUrl.replace(/\/+$/, ""), llmKey, llmModel, example, ciWorkflow: ci };

    const written: string[] = [];
    const put = (rel: string, text: string, mode?: number) => {
      const p = path.join(o.dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text, mode !== undefined ? { mode } : undefined);
      if (mode !== undefined) fs.chmodSync(p, mode);
      written.push(rel);
    };
    put(CONFIG_FILE, renderConfig(a));
    const envPath = path.join(o.dir, ".env");
    const envText = mergeEnv(fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "", { [JEV_KEY_VAR]: a.jevKey, [LLM_KEY_VAR]: a.llmKey });
    if (envText) put(".env", envText, 0o600);
    const ignorePath = path.join(o.dir, ".gitignore");
    const ignore = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8") : "";
    const merged = mergeGitignore(ignore, [".env", "reports/"]);
    if (merged !== ignore) put(".gitignore", merged);
    if (a.example) put("suites/example.suite.yaml", exampleSuite(a.appUrl));
    if (a.ciWorkflow) put(".github/workflows/jev-test.yml", ciWorkflow(Boolean(a.llmUrl)));

    say(`\nWrote ${written.join(", ")} in ${o.dir}.`);
    if (!a.jevKey) say(`Add ${JEV_KEY_VAR} to .env before you record new steps.`);
    if (a.ciWorkflow) say(`Add the repository secrets PACKAGES_TOKEN, ${JEV_KEY_VAR}${a.llmUrl ? `, and ${LLM_KEY_VAR}` : ""} for the workflow.`);
    say("Next: npx jev-test validate, then npx jev-test run");
    return 0;
  } catch (e) {
    if (!(e instanceof InitError)) throw e;
    say(`error: ${e.message}`);
    return 2;
  } finally {
    o.prompter.close();
  }
}
