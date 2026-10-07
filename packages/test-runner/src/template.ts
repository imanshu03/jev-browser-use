// Two kinds of placeholders: ${ENV} and ${ENV:-default} are filled when a file loads; {var} is filled when a step runs.

const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const VAR_RE = /(?<!\{)\{([a-z][a-z0-9_]{0,39})\}(?!\})/g;
const SECRET_NAME = /pass(word|wd|code|phrase)?|secret|token|api_?key|private|otp|pin\b/i;

export class TemplateError extends Error {
  override name = "TemplateError";
}

/** Values that come from secret env vars. Reports and logs show them as "***". */
export class Secrets {
  private readonly values = new Set<string>();

  add(value: string): void {
    if (value.length >= 4) this.values.add(value);
  }

  redact(text: string): string {
    let out = text;
    const forms = [...this.values].flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]);
    for (const value of forms.sort((a, b) => b.length - a.length)) out = out.split(value).join("***");
    return out;
  }

  redactData<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactData(v)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redactData(v)])) as T;
    return value;
  }

  list(): string[] {
    return [...this.values];
  }
}

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Fill ${ENV} placeholders in every string of a parsed YAML value. A missing var with no default becomes "". */
export function expandEnv<T>(value: T, env: NodeJS.ProcessEnv, secrets: Secrets, extraSecretNames: ReadonlySet<string> = new Set()): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.replace(ENV_RE, (_m, name: string, def: string | undefined) => {
        const got = env[name] ?? def ?? "";
        if (isSecretName(name) || extraSecretNames.has(name)) secrets.add(got);
        return got;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** The env var names that a parsed YAML value refers to. */
export function envNames(value: unknown): string[] {
  const names = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") for (const m of v.matchAll(ENV_RE)) names.add(m[1] as string);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return [...names];
}

/** Fill {var} placeholders. `{{` and `}}` give a literal brace. An unknown var is an error. */
export function fillVars(text: string, vars: Readonly<Record<string, string>>): string {
  const out = text.replace(VAR_RE, (m, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new TemplateError(`unknown var {${name}} in ${JSON.stringify(text)}. Known: ${Object.keys(vars).sort().join(", ") || "none"}. Write {{ and }} for a literal brace`);
    return v;
  });
  return out.replace(/\{\{/g, "{").replace(/\}\}/g, "}");
}

/** The vars that a text uses. */
export function varNames(text: string): string[] {
  return [...text.matchAll(VAR_RE)].map((m) => m[1] as string);
}

/** Fill the vars of a var map in order, so a later var can use an earlier one. */
export function resolveVars(base: Readonly<Record<string, string>>, more: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = { ...base };
  for (const [k, v] of Object.entries(more)) out[k] = fillVars(v, out);
  return out;
}

/** Built-in vars of one case run. */
export function builtinVars(now: Date, runId: string): Record<string, string> {
  return { now: String(now.getTime()), date: now.toISOString().slice(0, 10), run_id: runId };
}
