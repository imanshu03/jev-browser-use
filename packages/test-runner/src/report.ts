// Run reports: live console lines, results.json, and JUnit XML for CI.
import fs from "node:fs";
import path from "node:path";
import type { CaseResult, RunEvent, RunReport } from "./runner.js";

const MARK: Record<CaseResult["status"], string> = { passed: "PASS", healed: "HEAL", failed: "FAIL", skipped: "SKIP" };

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function consoleReporter(write: (line: string) => void): (e: RunEvent) => void {
  return (e) => {
    if (e.type === "suite_start") write(`\n${e.suite} (${e.cases} case${e.cases === 1 ? "" : "s"})`);
    else if (e.type === "case_end") {
      const r = e.result;
      write(`  ${MARK[r.status]}  ${r.id}  ${r.title}  ${secs(r.ms)}${r.jevRequests > 0 ? `  jev ${r.jevRequests} req` : ""}`);
      if (r.error) write(`        ${r.error}`);
      for (const h of r.healed) write(`        repaired: ${h}`);
      if (r.screenshot) write(`        screenshot: ${r.screenshot}`);
    } else if (e.result.recordingsSaved) write(`  recordings saved: ${e.result.recordingsSaved}`);
  };
}

export function summary(r: RunReport): string {
  const t = r.totals;
  return `${t.total} case(s): ${t.passed} passed, ${t.healed} repaired, ${t.failed} failed, ${t.skipped} skipped in ${secs(r.ms)}`;
}

function xml(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function junitXml(r: RunReport): string {
  const out = [`<?xml version="1.0" encoding="UTF-8"?>`, `<testsuites name="jev-test" tests="${r.totals.total}" failures="${r.totals.failed}" skipped="${r.totals.skipped}" time="${(r.ms / 1000).toFixed(3)}">`];
  for (const s of r.suites) {
    const failed = s.cases.filter((c) => c.status === "failed").length;
    const skipped = s.cases.filter((c) => c.status === "skipped").length;
    out.push(`  <testsuite name="${xml(s.suite)}" file="${xml(s.key)}" tests="${s.cases.length}" failures="${failed}" skipped="${skipped}" time="${(s.ms / 1000).toFixed(3)}">`);
    for (const c of s.cases) {
      out.push(`    <testcase classname="${xml(s.suite)}" name="${xml(`${c.id} ${c.title}`)}" time="${(c.ms / 1000).toFixed(3)}">`);
      if (c.status === "failed") out.push(`      <failure message="${xml(c.error ?? "failed")}">${xml(c.steps.map((x) => `${x.ok ? "ok  " : "FAIL"} [${x.how}] ${x.label}${x.detail ? ` - ${x.detail}` : ""}`).join("\n"))}</failure>`);
      if (c.status === "skipped") out.push(`      <skipped message="${xml(c.error ?? "")}"/>`);
      if (c.status === "healed") out.push(`      <system-out>${xml(`repaired: ${c.healed.join("; ")}`)}</system-out>`);
      out.push(`    </testcase>`);
    }
    out.push(`  </testsuite>`);
  }
  out.push(`</testsuites>`);
  return out.join("\n") + "\n";
}

export function writeReports(dir: string, r: RunReport): { json: string; junit: string } {
  fs.mkdirSync(dir, { recursive: true });
  const json = path.join(dir, "results.json");
  const junit = path.join(dir, "junit.xml");
  fs.writeFileSync(json, JSON.stringify(r, null, 2) + "\n");
  fs.writeFileSync(junit, junitXml(r));
  return { json, junit };
}
