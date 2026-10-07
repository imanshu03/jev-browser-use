// jev-test: run, list, and check YAML test suites.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { jevSessions } from "./engine.js";
import { createLlm } from "./llm.js";
import { CONFIG_FILE, LoadError, loadProject, loadSuites } from "./load.js";
import type { Filter } from "./load.js";
import { consoleReporter, summary, writeReports } from "./report.js";
import { runAll } from "./runner.js";
import { HealMode } from "./schema.js";

const HELP = `jev-test - YAML test suites run by Jev in Chrome

Usage:
  jev-test run [suite files or dirs...] [options]   Run the cases (default: the suites directory of the config)
  jev-test list [suite files or dirs...] [options]  List the cases that a run would select
  jev-test validate [suite files or dirs...]        Check the config and the suites

Options:
  --config <file>     Config file (default ${CONFIG_FILE})
  --env <name>        Environment of the config
  --tag <tag>         Only cases with this tag (repeat for AND)
  --id <id>           Only this case id (repeat for more)
  --grep <text>       Only cases whose id or title holds the text
  --headed            Show the browser
  --record            Record every plain-language step again with Jev
  --ci                CI mode: never record a missing step; a repaired step fails (also when CI=true)
  --heal <mode>       off | warn | fail (default: heal.local, or heal.ci in CI mode)
  --workers <n>       Suites at the same time (default browser.workers)
  --report-dir <dir>  Write the reports here (default: <reports of the config>/<run id>)
  -h, --help          Show this help

Exit codes: 0 all passed, 1 a case failed, 2 the config, a suite, or the command line is not valid.`;

function envWithDotenv(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return env;
  return { ...parseEnv(fs.readFileSync(file, "utf8")), ...env };
}

export async function main(argv: string[], io: { out: (s: string) => void; err: (s: string) => void; env: NodeJS.ProcessEnv } = {
  out: (s) => process.stdout.write(s + "\n"), err: (s) => process.stderr.write(s + "\n"), env: process.env,
}): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: {
        config: { type: "string" }, env: { type: "string" }, tag: { type: "string", multiple: true }, id: { type: "string", multiple: true },
        grep: { type: "string" }, headed: { type: "boolean" }, record: { type: "boolean" }, ci: { type: "boolean" }, heal: { type: "string" },
        workers: { type: "string" }, "report-dir": { type: "string" }, help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  const [command, ...paths] = args.positionals;
  if (args.values.help || !command) { io.out(HELP); return command || args.values.help ? 0 : 2; }
  if (!["run", "list", "validate"].includes(command)) { io.err(`unknown command "${command}"\n\n${HELP}`); return 2; }

  const configPath = path.resolve(args.values.config ?? CONFIG_FILE);
  const filter: Filter = { tags: args.values.tag ?? [], ids: args.values.id ?? [], grep: args.values.grep ?? null };
  let project, suites;
  try {
    project = loadProject(configPath, { ...(args.values.env ? { envName: args.values.env } : {}), processEnv: envWithDotenv(path.dirname(configPath), io.env) });
    suites = loadSuites(project, paths, command === "validate" ? { tags: [], ids: [], grep: null } : filter);
  } catch (e) {
    io.err(e instanceof LoadError ? e.message : `error: ${(e as Error).message}`);
    return 2;
  }

  if (command === "validate") {
    io.out(`ok: ${suites.length} suite(s), ${suites.reduce((n, s) => n + s.def.cases.length, 0)} case(s); environment ${project.env.name ?? "(none)"} at ${project.env.baseUrl}`);
    return 0;
  }
  if (command === "list") {
    for (const s of suites) {
      io.out(`${s.def.suite}  (${s.key})`);
      for (const c of s.def.cases) io.out(`  ${c.id}  ${c.title}${[...s.def.tags, ...c.tags].length ? `  [${[...s.def.tags, ...c.tags].join(", ")}]` : ""}${c.skip ? "  (skip)" : ""}`);
    }
    return 0;
  }
  if (suites.length === 0) { io.err("no case matches the filter"); return 2; }

  const ci = Boolean(args.values.ci) || /^(1|true)$/i.test(io.env["CI"] ?? "");
  const healArg = args.values.heal ? HealMode.safeParse(args.values.heal) : null;
  if (healArg && !healArg.success) { io.err("--heal must be off, warn, or fail"); return 2; }
  const heal = healArg?.data ?? (ci ? project.config.heal.ci : project.config.heal.local);
  const workers = args.values.workers ? Number(args.values.workers) : project.config.browser.workers;
  if (!Number.isInteger(workers) || workers < 1) { io.err("--workers must be a whole number above 0"); return 2; }
  const sharedProfile = project.config.browser.profile.toLowerCase() !== "none";
  if (sharedProfile && workers > 1) io.err(`browser.profile is "${project.config.browser.profile}": one browser at a time can use a profile, so the run uses 1 worker`);

  const runId = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const reportDir = args.values["report-dir"] ? path.resolve(args.values["report-dir"]) : path.join(project.root, project.config.reports, runId);
  let sessions;
  try {
    sessions = jevSessions({ config: project.config, secrets: project.secrets, processEnv: project.processEnv, headed: Boolean(args.values.headed) || project.config.browser.headed, logDir: path.join(reportDir, "logs") });
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    return 2;
  }
  io.out(`jev-test run ${runId}: environment ${project.env.name ?? "(none)"} at ${project.env.baseUrl}; heal ${heal}${ci ? "; CI mode" : ""}${args.values.record ? "; recording all steps" : ""}`);
  const report = await runAll({
    project, suites, sessions, llm: createLlm(project.config.llm), runId, reportDir,
    mode: { ci, record: Boolean(args.values.record), heal }, workers: sharedProfile ? 1 : workers,
    onEvent: consoleReporter(io.out), onLog: (l) => io.err(l),
  });
  const files = writeReports(reportDir, report);
  io.out(`\n${summary(report)}\nreports: ${files.junit}, ${files.json}`);
  return report.totals.failed > 0 ? 1 : 0;
}
