// Load the config and the suites from disk, fill ${ENV} placeholders, and select the cases of a run.
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import * as z from "zod";
import { ConfigDef, SuiteDef } from "./schema.js";
import type { CaseDef } from "./schema.js";
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
}

export interface LoadedSuite {
  file: string;
  /** The file path from the project root, with "/" separators. Recordings are keyed by it. */
  key: string;
  def: SuiteDef;
}

function zodMessage(e: z.ZodError, file: string): string {
  return `${file}:\n` + e.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

function readYaml(file: string): unknown {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { throw new LoadError(`cannot read ${file}: ${(e as Error).message}`); }
  try { return parseYaml(text); } catch (e) { throw new LoadError(`${file}: not valid YAML: ${(e as Error).message}`); }
}

/** Load jev-test.config.yaml and pick the environment (`--env`, else default_environment, else base_url). */
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
  const envName = opts.envName ?? config.default_environment ?? null;
  let baseUrl = config.base_url ?? "";
  let vars = { ...config.vars };
  if (envName !== null) {
    const env = config.environments[envName];
    if (!env) throw new LoadError(`unknown environment "${envName}". Known: ${Object.keys(config.environments).join(", ") || "none"}`);
    baseUrl = env.base_url;
    vars = { ...vars, ...env.vars };
  }
  if (!baseUrl) throw new LoadError(`${abs}: set base_url, or environments with --env or default_environment`);
  return { root: path.dirname(abs), configPath: abs, config, env: { name: envName, baseUrl: baseUrl.replace(/\/+$/, "") }, vars, secrets, processEnv: opts.processEnv };
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
  return { file, key: path.relative(project.root, file).split(path.sep).join("/"), def: parsed.data };
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
