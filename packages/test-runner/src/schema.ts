// The YAML files: jev-test.config.yaml and *.suite.yaml. Checked with zod after ${ENV} placeholders are filled.
import * as z from "zod";

export const VAR_NAME = /^[a-z][a-z0-9_]{0,39}$/;
const Vars = z.record(z.string().regex(VAR_NAME, "a var name is a-z, 0-9 and _, starts with a letter, at most 40 characters"), z.union([z.string(), z.number(), z.boolean()]).transform(String));
const Ms = z.number().int().min(0).max(600_000);

const Words = z.array(z.string().trim().min(1).max(80).transform((w) => w.toLowerCase())).max(100).default([]);

/** Label words of one scope: a dangerous word makes a click dangerous, and a safe word stops a built-in dangerous word. */
export const ActionWordsDef = z.strictObject({ dangerous: Words, safe: Words });
export type ActionWordsDef = z.infer<typeof ActionWordsDef>;

/** Action words for all pages, and more words for some hosts (a host and its subdomains). */
/** A bare host name, as a URL gives it: no scheme, port, path, user, or wildcard. A trailing dot is dropped. */
const Host = z.string().trim().min(1).transform((h, ctx) => {
  let host = "";
  try {
    const u = new URL(`http://${h}`);
    if (!/[/@?#:*]/.test(h.replace(/^\[[^\]]*\]$/, "")) && u.port === "" && u.pathname === "/") host = u.hostname.toLowerCase().replace(/\.+$/, "");
  } catch { host = ""; }
  if (!host) ctx.addIssue({ code: "custom", message: `"${h}" is not a host name: write only the host, such as app.example.com` });
  return host;
});

export const ActionsDef = ActionWordsDef.extend({ hosts: z.record(Host, ActionWordsDef).default({}) });
export type ActionsDef = z.infer<typeof ActionsDef>;

/** What Jev may do when it records or repairs a step, and what a replay may click. */
export const ConfirmMode = z.enum(["autonomous", "never", "always"]);
export type ConfirmMode = z.infer<typeof ConfirmMode>;

/** `jev`: notes about the app for Jev. `llm`: instructions for the text writer and the judge. */
export const InstructionsDef = z.strictObject({ jev: z.string().optional(), llm: z.string().optional() });
export type InstructionsDef = z.infer<typeof InstructionsDef>;


export const Assertion = z.union([
  z.strictObject({ url_contains: z.string().min(1), timeout_ms: Ms.optional() }),
  z.strictObject({ url_matches: z.string().min(1), timeout_ms: Ms.optional() }),
  z.strictObject({ title_contains: z.string().min(1), timeout_ms: Ms.optional() }),
  z.strictObject({ visible_text: z.string().min(1), timeout_ms: Ms.optional() }),
  z.strictObject({ not_visible_text: z.string().min(1), timeout_ms: Ms.optional() }),
  z.strictObject({ element: z.strictObject({ name: z.string().min(1), role: z.string().optional(), present: z.boolean().default(true) }), timeout_ms: Ms.optional() }),
  z.strictObject({ field_value: z.strictObject({ field: z.string().min(1), value: z.string() }), timeout_ms: Ms.optional() }),
  z.strictObject({ row_contains: z.array(z.string().min(1)).min(1), timeout_ms: Ms.optional() }),
  z.strictObject({ check: z.string().min(1), min_probability: z.number().min(0).max(1).optional() }),
  z.strictObject({ judge: z.string().min(1) }),
]);
export type Assertion = z.infer<typeof Assertion>;

const Click = z.union([z.string().min(1), z.strictObject({
  name: z.string().min(1), role: z.string().optional(), match: z.enum(["exact", "starts", "contains"]).optional(), nth: z.number().int().min(0).optional(), optional: z.boolean().optional(),
})]);

export const StepDef = z.union([
  z.string().min(1),
  z.strictObject({ goto: z.string().min(1) }),
  z.strictObject({ click: Click }),
  z.strictObject({ fill: z.strictObject({ field: z.string().min(1), value: z.string() }) }),
  z.strictObject({ select: z.strictObject({ field: z.string().min(1), option: z.string().min(1) }) }),
  z.strictObject({ press: z.enum(["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp", "PageDown", "PageUp"]) }),
  z.strictObject({ wait: Ms }),
  z.strictObject({ wait_for_text: z.string().min(1), timeout_ms: Ms.optional() }),
  z.strictObject({ use: z.string().min(1) }),
  z.strictObject({ expect: z.union([Assertion, z.array(Assertion).min(1)]) }),
  z.strictObject({ screenshot: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/) }),
]);
export type StepDef = z.infer<typeof StepDef>;

const Steps = z.array(StepDef).default([]);
const Tags = z.array(z.string().regex(/^[A-Za-z0-9_:-]+$/, "a tag is letters, digits, _, : and -")).default([]);

export const CaseDef = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/, "an id is letters, digits, _, . and -"),
  title: z.string().min(1),
  tags: Tags,
  vars: Vars.default({}),
  start: z.string().optional(),
  steps: Steps,
  expect: z.array(Assertion).default([]),
  cleanup: Steps,
  skip: z.string().optional(),
  timeout_ms: Ms.optional(),
});
export type CaseDef = z.infer<typeof CaseDef>;

export const SuiteDef = z.strictObject({
  suite: z.string().min(1),
  tags: Tags,
  vars: Vars.default({}),
  /** This file only, over global.yaml and the environment. */
  confirm: ConfirmMode.optional(),
  actions: ActionsDef.optional(),
  instructions: InstructionsDef.optional(),
  before_all: Steps,
  before_each: Steps,
  after_each: Steps,
  after_all: Steps,
  cases: z.array(CaseDef).min(1),
});
export type SuiteDef = z.infer<typeof SuiteDef>;

export const HealMode = z.enum(["off", "warn", "fail"]);
export type HealMode = z.infer<typeof HealMode>;

const Environment = z.strictObject({
  base_url: z.string().url(),
  vars: Vars.default({}),
  confirm: ConfirmMode.optional(),
  instructions: InstructionsDef.optional(),
  actions: ActionsDef.optional(),
});
export type EnvironmentDef = z.infer<typeof Environment>;

/** global.yaml: the environments and the settings that all suites share. */
export const GlobalDef = z.strictObject({
  environments: z.record(z.string(), Environment).default({}),
  default_environment: z.string().optional(),
  confirm: ConfirmMode.optional(),
  instructions: InstructionsDef.default({}),
  actions: ActionsDef.default({ dangerous: [], safe: [], hosts: {} }),
});
export type GlobalDef = z.infer<typeof GlobalDef>;

export const ConfigDef = z.strictObject({
  /** The global file, from the config directory. A missing file is no error. */
  global: z.string().default("global.yaml"),
  base_url: z.string().url().optional(),
  environments: z.record(z.string(), Environment).default({}),
  default_environment: z.string().optional(),
  vars: Vars.default({}),
  secrets: z.array(z.string()).default([]),
  flows: z.record(z.string(), z.array(StepDef)).default({}),
  suites: z.string().default("suites"),
  recordings: z.string().default(".jev/recordings"),
  reports: z.string().default("reports"),
  browser: z.strictObject({
    headed: z.boolean().default(false),
    browser: z.enum(["chrome", "edge", "brave", "chromium"]).optional(),
    profile: z.string().default("none"),
    workers: z.number().int().min(1).max(16).default(1),
  }).default({ headed: false, profile: "none", workers: 1 }),
  jev: z.strictObject({
    api_key: z.string().default(""),
    model: z.string().default("jev-latest"),
    max_steps: z.number().int().min(1).max(100).default(25),
  }).default({ api_key: "", model: "jev-latest", max_steps: 25 }),
  llm: z.strictObject({
    base_url: z.string().default(""),
    api_key: z.string().default(""),
    model: z.string().default(""),
    judge_model: z.string().optional(),
    text_model: z.string().optional(),
    timeout_ms: Ms.default(60_000),
  }).default({ base_url: "", api_key: "", model: "", timeout_ms: 60_000 }),
  heal: z.strictObject({ local: HealMode.default("warn"), ci: HealMode.default("fail") }).default({ local: "warn", ci: "fail" }),
  timeouts: z.strictObject({
    step_ms: Ms.default(8_000),
    assert_ms: Ms.default(8_000),
    case_ms: Ms.default(300_000),
  }).default({ step_ms: 8_000, assert_ms: 8_000, case_ms: 300_000 }),
});
export type ConfigDef = z.infer<typeof ConfigDef>;
