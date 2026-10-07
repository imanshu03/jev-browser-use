import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { junitXml, summary } from "../src/report.js";
import type { RunReport } from "../src/runner.js";
import { tempProject } from "./fake.js";

const REPORT: RunReport = {
  runId: "r", environment: "stage", baseUrl: "https://x", startedAt: "2026-10-07T00:00:00.000Z", ms: 2500,
  totals: { passed: 1, healed: 1, failed: 1, skipped: 1, total: 4 },
  suites: [{
    suite: "Notes & <Lists>", key: "suites/notes.suite.yaml", ms: 2000, recordingsSaved: null, cases: [
      { id: "N-1", title: "ok", tags: [], status: "passed", ms: 100, error: null, steps: [], assertions: [], healed: [], screenshot: null, jevRequests: 0 },
      { id: "N-2", title: "fixed", tags: [], status: "healed", ms: 100, error: null, steps: [], assertions: [], healed: ["Add: no button"], screenshot: null, jevRequests: 2 },
      { id: "N-3", title: "bad", tags: [], status: "failed", ms: 100, error: 'expected "x"', steps: [{ label: "Add", how: "replay", ok: false, ms: 5, detail: "no <button>" }], assertions: [], healed: [], screenshot: null, jevRequests: 0 },
      { id: "N-4", title: "later", tags: [], status: "skipped", ms: 0, error: "bug 12", steps: [], assertions: [], healed: [], screenshot: null, jevRequests: 0 },
    ],
  }],
};

describe("reports", () => {
  it("writes JUnit XML with escaped text, failures, skips, and repairs", () => {
    const x = junitXml(REPORT);
    expect(x).toContain('<testsuite name="Notes &amp; &lt;Lists&gt;" file="suites/notes.suite.yaml" tests="4" failures="1" skipped="1" time="2.000">');
    expect(x).toContain('<failure message="expected &quot;x&quot;">FAIL [replay] Add - no &lt;button&gt;</failure>');
    expect(x).toContain('<skipped message="bug 12"/>');
    expect(x).toContain("<system-out>repaired: Add: no button</system-out>");
  });
  it("sums up the run", () => {
    expect(summary(REPORT)).toBe("4 case(s): 1 passed, 1 repaired, 1 failed, 1 skipped in 2.5s");
  });
});

describe("cli", () => {
  const cfg = tempProject("base_url: https://app.example\n", { "a.suite.yaml": "suite: A\ncases:\n  - { id: A-1, title: one, tags: [smoke] }\n  - { id: A-2, title: two }\n" });
  const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s), env: {} } }; };
  it("validates and lists with filters", async () => {
    const v = io();
    expect(await main(["validate", "--config", cfg], v.io)).toBe(0);
    expect(v.out[0]).toBe("ok: 1 suite(s), 2 case(s); environment (none) at https://app.example");
    const l = io();
    expect(await main(["list", "--config", cfg, "--tag", "smoke"], l.io)).toBe(0);
    expect(l.out).toEqual(["A  (suites/a.suite.yaml)", "  A-1  one  [smoke]"]);
  });
  it("exits 2 for a bad option, an unknown command, a bad config, and a filter with no case", async () => {
    expect(await main(["run", "--nope"], io().io)).toBe(2);
    expect(await main(["go"], io().io)).toBe(2);
    expect(await main(["validate", "--config", "/no/such.yaml"], io().io)).toBe(2);
    expect(await main(["run", "--config", cfg, "--id", "Z-9"], io().io)).toBe(2);
    expect(await main(["run", "--config", cfg, "--heal", "maybe"], io().io)).toBe(2);
  });
});
