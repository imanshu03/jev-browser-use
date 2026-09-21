// Live smoke test: runs the three acceptance commands from DESIGN.md section 11 in sequence.
// Not part of `npm test`. Needs TYPESAFE_API_KEY, Chrome, and the Parallelloop profile.
// SMOKE_ENGINE selects the engine (default cdp). Each row shows the wall time, run time, Jev time, and browser time.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunResult } from "../src/types.js";

export interface SmokeCase { name: string; args: string[]; expect: (r: RunResult) => string | null }

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CASES: SmokeCase[] = [
  {
    name: "1 wikipedia extract",
    args: ["open wikipedia.org and search for Alan Turing, then tell me the title of the article", "--profile", "none"],
    expect: (r) => r.outcome !== "done" ? `outcome ${r.outcome} (${r.reason})`
      : r.goal !== "extract" ? `goal ${r.goal}`
      : r.answer?.kind !== "extract" || !r.answer.text.includes("Alan Turing") ? `answer ${JSON.stringify(r.answer)}` : null,
  },
  {
    name: "2 parallelloop check",
    args: ["open app.parallelloop.ai, login using gmail and check if licious account project has 3rd September artifacts"],
    expect: (r) => r.outcome !== "done" ? `outcome ${r.outcome} (${r.reason})`
      : r.goal !== "check" ? `goal ${r.goal}`
      : r.answer?.kind !== "check" || r.answer.answer !== true ? `answer ${JSON.stringify(r.answer)}`
      : !r.answer.evidence.some((e) => e.includes("Licious Sept3 Session")) ? `evidence ${JSON.stringify(r.answer.evidence)}`
      : !(r.final_url ?? "").includes("app.parallelloop.ai/workspace/licious-data-project") ? `final_url ${r.final_url}`
      : r.steps.length > 6 ? `${r.steps.length} steps` : null,
  },
  {
    name: "3 gmail needs_sign_in",
    args: ["open mail.google.com in the Parallelloop profile and read the subject of the newest email"],
    expect: (r) => r.outcome !== "blocked" ? `outcome ${r.outcome} (${r.reason})`
      : r.blocked?.kind !== "needs_sign_in" ? `kind ${r.blocked?.kind}`
      : !r.blocked.hint.includes("--headed") ? `hint ${r.blocked.hint}` : null,
  },
];

/** The engine under test. `SMOKE_ENGINE=vercel` runs the agent-browser engine. */
export const ENGINE = process.env["SMOKE_ENGINE"] ?? "cdp";
if (!["cdp", "chromium", "vercel"].includes(ENGINE)) throw new Error("SMOKE_ENGINE must be cdp, chromium, or vercel");

function runCli(args: string[]): Promise<{ result: RunResult | null; code: number | null; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const session = `jev-smoke-${randomBytes(3).toString("hex")}`;
    const child = spawn(process.execPath, [path.join(pkgDir, "node_modules", ".bin", "tsx"), `--env-file=${path.join(pkgDir, ".env")}`, path.join(pkgDir, "src", "cli.ts"), ...args, "--engine", ENGINE, "--session", session], { cwd: pkgDir, env: process.env });
    let out = ""; let err = "";
    child.stdout.on("data", (c) => { out += String(c); });
    child.stderr.on("data", (c) => { err += String(c); process.stderr.write(c); });
    child.on("exit", (code) => {
      let result: RunResult | null = null;
      try { result = JSON.parse(out) as RunResult; } catch { /* no JSON */ }
      resolve({ result, code, stderr: err, ms: Date.now() - t0 });
    });
  });
}

export async function smoke(cases: SmokeCase[] = CASES): Promise<boolean> {
  const rows: { name: string; pass: boolean; detail: string; steps: number; requests: number; tokens: number; ms: number; runMs: number; jevMs: number; browserMs: number; confs: string }[] = [];
  for (const c of cases) {
    process.stderr.write(`\n=== ${c.name} (engine ${ENGINE}): jev-browser ${c.args.map((a) => JSON.stringify(a)).join(" ")}\n`);
    const r = await runCli(c.args);
    const failure = r.result ? c.expect(r.result) : `no JSON on stdout (exit ${r.code})`;
    const confs = r.result ? r.result.steps.map((s) => `${s.operation ?? "-"}@${(s.operation_conf ?? 0).toFixed(2)}${s.target_conf !== null ? `/t${s.target_conf.toFixed(2)}` : ""}`).join(" ") : "";
    const st = r.result?.stats;
    rows.push({
      name: c.name, pass: failure === null, detail: failure ?? `${r.result?.outcome}${r.result?.answer ? " " + JSON.stringify(r.result.answer).slice(0, 60) : ""}`,
      steps: r.result?.steps.length ?? 0, requests: st?.jev_requests ?? 0, tokens: (st?.input_tokens ?? 0) + (st?.output_tokens ?? 0),
      ms: r.ms, runMs: st?.duration_ms ?? 0, jevMs: st?.jev_ms ?? 0, browserMs: st?.browser_ms ?? 0, confs,
    });
  }
  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  process.stdout.write(`\nengine ${ENGINE}\n`);
  process.stdout.write(`${pad("case", 24)} ${pad("result", 6)} ${pad("steps", 5)} ${pad("req", 4)} ${pad("tokens", 8)} ${pad("wall", 7)} ${pad("run", 7)} ${pad("jev", 7)} ${pad("browser", 7)} detail\n`);
  for (const r of rows) {
    process.stdout.write(`${pad(r.name, 24)} ${pad(r.pass ? "PASS" : "FAIL", 6)} ${pad(String(r.steps), 5)} ${pad(String(r.requests), 4)} ${pad(String(r.tokens), 8)} ${pad(secs(r.ms), 7)} ${pad(secs(r.runMs), 7)} ${pad(secs(r.jevMs), 7)} ${pad(secs(r.browserMs), 7)} ${r.detail}\n`);
    if (r.confs) process.stdout.write(`${pad("", 24)} confidences: ${r.confs}\n`);
  }
  return rows.every((r) => r.pass);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) smoke().then((ok) => { process.exitCode = ok ? 0 : 1; });
