// Load the config and the suites from disk, fill ${ENV} placeholders, and select the cases of a run.
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import * as z from "zod";
import { ConfigDef, GlobalDef, SuiteDef } from "./schema.js";
import type { ActionWordsDef, ActionsDef, CaseDef, ConfirmMode, EnvironmentDef } from "./schema.js";
import { Secrets, expandEnv } from "./template.js";

export const CONFIG_FILE = "jev-test.config.yaml";
export const SUITE_SUFFIX = ".suite.yaml";

export class LoadError extends Error {
  override name = "LoadError";
}

export interface Project {
  root: string;
  configPath: string;
  config: ConfigDef;
  /** The environment of the run, and its base URL. */
  env: { name: string | null; baseUrl: string };
  /** Config vars with the environment vars over them. */
  vars: Record<string, string>;
  secrets: Secrets;
  processEnv: NodeJS.ProcessEnv;
  /** global.yaml with the environment over it. */
  policy: Policy;
}

/** The settings of global.yaml for the environment of the run. */
export interface Policy {
  /** The global file that the project read, or null when there is none. */
  globalPath: string | null;
  confirm: ConfirmMode;
  actions: ActionsDef;
  /** Notes for Jev, global first. Empty when there are none. */
  jevNotes: string;
  /** Instructions for the text writer and the judge, global first. Empty when there are none. */
  llmInstructions: string;
}

export interface LoadedSuite {
  file: string;
  /** The file path from the project root, with "/" separators. Recordings are keyed by it. */
  key: string;
  def: SuiteDef;
  /** global.yaml, then the environment, then the confirm, actions, and instructions of this suite file. */
  policy: Policy;
}

function zodMessage(e: z.ZodError, file: string): string {
  return `${file}:\n` + e.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

function readYaml(file: string): unknown {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { throw new LoadError(`cannot read ${file}: ${(e as Error).message}`); }
  try { return parseYaml(text); } catch (e) { throw new LoadError(`${file}: not valid YAML: ${(e as Error).message}`); }
}

const NO_WORDS: ActionWordsDef = { dangerous: [], safe: [] };

/** The policy of a project with no global.yaml: Jev may do every action, with the built-in words only. */
export const DEFAULT_POLICY: Policy = { globalPath: null, confirm: "autonomous", actions: { ...NO_WORDS, hosts: {} }, jevNotes: "", llmInstructions: "" };

/** A word that is dangerous and safe in one scope is an error: the reader cannot tell which one wins. */
function checkWords(w: ActionWordsDef, where: string, file: string): void {
  const both = w.dangerous.filter((x) => w.safe.includes(x));
  if (both.length > 0) throw new LoadError(`${file}: ${where} lists ${both.map((x) => JSON.stringify(x)).join(", ")} as dangerous and as safe`);
}

/** `top` over `base`: a safe word of `top` stops a dangerous word of `base`, and a dangerous word of `top` stops a safe one. */
function overlayWords(base: ActionWordsDef, top: ActionWordsDef): ActionWordsDef {
  const uniq = (a: string[]) => [...new Set(a)];
  return {
    dangerous: uniq([...base.dangerous.filter((x) => !top.safe.includes(x)), ...top.dangerous]),
    safe: uniq([...base.safe.filter((x) => !top.dangerous.includes(x)), ...top.safe]),
  };
}

function overlayActions(base: ActionsDef, top: ActionsDef): ActionsDef {
  const hosts: Record<string, ActionWordsDef> = {};
  for (const h of new Set([...Object.keys(base.hosts), ...Object.keys(top.hosts)])) hosts[h] = overlayWords(base.hosts[h] ?? NO_WORDS, top.hosts[h] ?? NO_WORDS);
  return { ...overlayWords(base, top), hosts };
}

function checkActions(a: ActionsDef, where: string, file: string): void {
  checkWords(a, where, file);
  for (const [h, w] of Object.entries(a.hosts)) checkWords(w, `${where} host ${h}`, file);
}

/** The policy of one suite: the suite's own settings go over the project policy (global.yaml, then the environment). */
export function suitePolicy(base: Policy, suite: Pick<SuiteDef, "confirm" | "actions" | "instructions">): Policy {
  const join = (a: string, b: string | undefined) => [a, b?.trim()].filter(Boolean).join("\n");
  return {
    ...base,
    confirm: suite.confirm ?? base.confirm,
    actions: suite.actions ? overlayActions(base.actions, suite.actions) : base.actions,
    jevNotes: join(base.jevNotes, suite.instructions?.jev),
    llmInstructions: join(base.llmInstructions, suite.instructions?.llm),
  };
}

/** Load jev-test.config.yaml and global.yaml, and pick the environment (`--env`, else default_environment, else base_url). */
export function loadProject(configPath: string, opts: { envName?: string; processEnv: NodeJS.ProcessEnv }): Project {
  const abs = path.resolve(configPath);
  const raw = readYaml(abs);
  const secrets = new Secrets();
  const named = new Set(Array.isArray((raw as { secrets?: unknown })?.secrets) ? ((raw as { secrets: unknown[] }).secrets.map(String)) : []);
  const parsed = ConfigDef.safeParse(expandEnv(raw ?? {}, opts.processEnv, secrets, named));
  if (!parsed.success) throw new LoadError(zodMessage(parsed.error, abs));
  const config = parsed.data;
  secrets.add(config.jev.api_key || opts.processEnv["TYPESAFE_API_KEY"] || "");
  secrets.add(config.llm.api_key);
  for (const name of named) secrets.add(opts.processEnv[name] ?? "");

  const globalPath = path.resolve(path.dirname(abs), config.global);
  let global = GlobalDef.parse({});
  let globalFound: string | null = null;
  if (fs.existsSync(globalPath)) {
    const g = GlobalDef.safeParse(expandEnv(readYaml(globalPath) ?? {}, opts.processEnv, secrets, named));
    if (!g.success) throw new LoadError(zodMessage(g.error, globalPath));
    global = g.data;
    globalFound = globalPath;
  } else if (config.global !== "global.yaml") {
    throw new LoadError(`${abs}: the global file ${globalPath} does not exist`);
  }
  for (const name of Object.keys(global.environments)) {
    if (config.environments[name]) throw new LoadError(`the environment "${name}" is in ${abs} and in ${globalPath}. Keep it in one file`);
  }
  if (global.default_environment && config.default_environment && global.default_environment !== config.default_environment) {
    throw new LoadError(`default_environment is "${config.default_environment}" in ${abs} and "${global.default_environment}" in ${globalPath}. Keep it in one file`);
  }
  const environments: Record<string, EnvironmentDef> = { ...global.environments, ...config.environments };
  checkActions(global.actions, "actions", globalPath);
  for (const [name, e] of Object.entries(environments)) if (e.actions) checkActions(e.actions, `environments.${name}.actions`, global.environments[name] ? globalPath : abs);

  const envName = opts.envName ?? config.default_environment ?? global.default_environment ?? null;
  let baseUrl = config.base_url ?? "";
  let vars = { ...config.vars };
  let env: EnvironmentDef | null = null;
  if (envName !== null) {
    env = environments[envName] ?? null;
    if (!env) throw new LoadError(`unknown environment "${envName}". Known: ${Object.keys(environments).join(", ") || "none"}`);
    baseUrl = env.base_url;
    vars = { ...vars, ...env.vars };
  }
  if (!baseUrl) throw new LoadError(`${abs}: set base_url, or environments with --env or default_environment`);

  const join = (a: string | undefined, b: string | undefined) => [a?.trim(), b?.trim()].filter(Boolean).join("\n");
  const policy: Policy = {
    globalPath: globalFound,
    confirm: env?.confirm ?? global.confirm ?? "autonomous",
    actions: env?.actions ? overlayActions(global.actions, env.actions) : global.actions,
    jevNotes: join(global.instructions.jev, env?.instructions?.jev),
    llmInstructions: join(global.instructions.llm, env?.instructions?.llm),
  };
  for (const [what, text] of [["instructions.jev", policy.jevNotes], ["instructions.llm", policy.llmInstructions]] as const) {
    if (secrets.redact(text) !== text) throw new LoadError(`${globalPath}: ${what} holds a secret value, and Jev or the LLM would get it. Remove the secret from the text`);
  }
  return {
    root: path.dirname(abs), configPath: abs, config: { ...config, environments }, env: { name: envName, baseUrl: baseUrl.replace(/\/+$/, "") },
    vars, secrets, processEnv: opts.processEnv, policy,
  };
}

/** The suite files under the given paths (files or directories). No path: the suites directory of the config. */
export function findSuiteFiles(project: Project, paths: readonly string[]): string[] {
  const roots = paths.length > 0 ? paths.map((p) => path.resolve(p)) : [path.resolve(project.root, project.config.suites)];
  const out = new Set<string>();
  const walk = (p: string): void => {
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { throw new LoadError(`no such file or directory: ${p}`); }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) if (!name.startsWith(".") && name !== "node_modules") walk(path.join(p, name));
    } else if (p.endsWith(SUITE_SUFFIX)) out.add(p);
    else if (paths.length > 0 && roots.includes(p)) throw new LoadError(`${p}: a suite file name ends with ${SUITE_SUFFIX}`);
  };
  roots.forEach(walk);
  return [...out];
}

export function loadSuite(project: Project, file: string): LoadedSuite {
  const raw = readYaml(file);
  const parsed = SuiteDef.safeParse(expandEnv(raw ?? {}, project.processEnv, project.secrets, new Set(project.config.secrets)));
  if (!parsed.success) throw new LoadError(zodMessage(parsed.error, file));
  const ids = new Set<string>();
  for (const c of parsed.data.cases) {
    if (ids.has(c.id)) throw new LoadError(`${file}: case id ${c.id} is used twice`);
    ids.add(c.id);
  }
  if (parsed.data.actions) checkActions(parsed.data.actions, "actions", file);
  for (const [what, text] of [["instructions.jev", parsed.data.instructions?.jev], ["instructions.llm", parsed.data.instructions?.llm]] as const) {
    if (text && project.secrets.redact(text) !== text) throw new LoadError(`${file}: ${what} holds a secret value, and Jev or the LLM would get it. Remove the secret from the text`);
  }
  return { file, key: path.relative(project.root, file).split(path.sep).join("/"), def: parsed.data, policy: suitePolicy(project.policy, parsed.data) };
}

export interface Filter {
  tags: string[];
  ids: string[];
  grep: string | null;
}

/** A case runs when it has every tag of the filter (suite tags count), its id is in `ids` (when given), and grep matches its id or title. */
export function selectCase(suite: SuiteDef, c: CaseDef, f: Filter): boolean {
  const tags = new Set([...suite.tags, ...c.tags].map((t) => t.toLowerCase().replace(/^@/, "")));
  if (!f.tags.every((t) => tags.has(t.toLowerCase().replace(/^@/, "")))) return false;
  if (f.ids.length > 0 && !f.ids.includes(c.id)) return false;
  if (f.grep && !`${c.id} ${c.title}`.toLowerCase().includes(f.grep.toLowerCase())) return false;
  return true;
}

/** Load every suite and keep the cases that the filter selects. Suites with no selected case are left out. Duplicate case ids across suites are an error. */
export function loadSuites(project: Project, paths: readonly string[], f: Filter): LoadedSuite[] {
  const seen = new Map<string, string>();
  const out: LoadedSuite[] = [];
  for (const file of findSuiteFiles(project, paths)) {
    const s = loadSuite(project, file);
    for (const c of s.def.cases) {
      const other = seen.get(c.id);
      if (other) throw new LoadError(`case id ${c.id} is in ${other} and in ${s.key}`);
      seen.set(c.id, s.key);
    }
    const cases = s.def.cases.filter((c) => selectCase(s.def, c, f));
    if (cases.length > 0) out.push({ ...s, def: { ...s.def, cases } });
  }
  return out;
}
