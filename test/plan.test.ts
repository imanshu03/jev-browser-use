import { describe, expect, it } from "vitest";
import type { ChoiceQuestion } from "@typesafe-ai/sdk";
import { catalogHits, planQuestions, prePlan, resolvePlan, SEARCH_URL, UsageError } from "../src/plan.js";
import { extractSpans } from "../src/task.js";
import type { RunConfig } from "../src/types.js";
import { fakeHuman, fakeLogger, fakeOracle, type OracleScript } from "./fakes.js";

const profiles = [{ directory: "Profile 14", name: "Parallelloop" }, { directory: "Profile 2", name: "BP" }, { directory: "Default", name: "Personal" }];
const cfg = (task: string, over: Partial<RunConfig> = {}): RunConfig => ({
  task, headed: false, maxSteps: 25, stepTimeoutMs: 1000, runTimeoutMs: 1000, pauseTimeoutMs: 1000, confirm: "auto", dryRun: false, session: "s", model: "m",
  logLevel: "info", logJson: false, keepOpen: false, agentBrowserBin: "ab", vars: {}, ...over,
});
const run = (task: string, script: OracleScript = [], over: Partial<RunConfig> = {}, human = fakeHuman({ interactive: false })) => {
  const oracle = fakeOracle(script);
  const spans = extractSpans(task, []);
  return resolvePlan(cfg(task, over), profiles, spans, oracle, human, fakeLogger()).then((plan) => ({ plan, oracle }));
};

describe("catalogHits and planQuestions", () => {
  it("matches aliases as whole words", () => {
    expect(catalogHits("open gmail now").map((s) => s.key)).toEqual(["gmail"]);
    expect(catalogHits("go to stack overflow and hn").map((s) => s.key)).toEqual(["stackoverflow", "hacker_news"]);
    expect(catalogHits("open wikipedia.org").map((s) => s.key)).toEqual(["wikipedia"]);
    expect(catalogHits("read the news")).toEqual([]);
  });
  it("builds only the questions asked", () => {
    const q = planQuestions({ profileCandidates: profiles, askProfileMentioned: true, askSite: null, spans: [], askGoal: true });
    expect(Object.keys(q)).toEqual(["profile_mentioned", "profile", "goal"]);
    expect(Object.keys((q["profile"] as ChoiceQuestion).criteria)).toEqual(["Profile 14", "Profile 2", "Default", "no_profile_mentioned"]);
    const q2 = planQuestions({ profileCandidates: null, askProfileMentioned: false, askSite: catalogHits("gmail or drive"), spans: [], askGoal: false });
    expect(Object.keys(q2)).toEqual(["site", "wants_search", "search_query"]);
  });
});

describe("profile resolution", () => {
  it("--profile flag wins; none launches without a profile; unknown throws UsageError", async () => {
    expect((await run("open gmail", [], { profile: "bp", goal: "act" })).plan.profile).toEqual({ profile: profiles[1], how: "flag", confidence: null });
    expect((await run("open gmail", [], { profile: "none", goal: "act" })).plan.profile).toEqual({ profile: null, how: "flag", confidence: null });
    await expect(run("open gmail", [], { profile: "nope", goal: "act" })).rejects.toThrow(UsageError);
  });
  it("one exact mention -> task_exact with no Jev when everything else is settled", async () => {
    const { plan, oracle } = await run("open gmail in the Parallelloop profile", [], { goal: "extract" });
    expect(plan.profile).toEqual({ profile: profiles[0], how: "task_exact", confidence: null });
    expect(oracle.requests.length).toBe(0);
    expect(plan.jevRequests).toBe(0);
  });
  it("two mentions -> PLAN over the two; account word -> PLAN over all; none -> workspace default, goal still asked", async () => {
    const two = await run("use BP or Parallelloop to open gmail", [{ name: "plan", answers: () => ({ profile: { choice: "Profile 2", confidence: 0.9 }, goal: "act" }) }]);
    expect(Object.keys((two.oracle.requests[0]?.questions["profile"] as ChoiceQuestion).criteria)).toEqual(["Profile 14", "Profile 2", "no_profile_mentioned"]);
    expect(two.plan.profile).toMatchObject({ profile: profiles[1], how: "jev", confidence: 0.9 });
    const word = await run("open gmail with my work account", [{ name: "plan", answers: () => ({ profile_mentioned: 0.2, goal: "act" }) }]);
    expect(word.oracle.requests[0]?.questions["profile_mentioned"]).toBeDefined();
    expect(word.plan.profile).toMatchObject({ profile: profiles[0], how: "workspace_default" });
    const none = await run("open gmail", [{ name: "plan", answers: () => ({ goal: "check" }) }]);
    expect(Object.keys(none.oracle.requests[0]?.questions ?? {})).toEqual(["goal"]);
    expect(none.plan.profile).toMatchObject({ how: "workspace_default", profile: profiles[0] });
    expect(none.plan.goal).toBe("check");
  });
  it("0.6 with human yes -> human; 0.6 non-TTY -> default; mentioned 0.9 with all options < 0.5 -> ambiguous_profile", async () => {
    const mid: OracleScript = [{ name: "plan", answers: () => ({ profile_mentioned: 0.9, profile: { choice: "Profile 2", confidence: 0.6 }, goal: "act" }) }];
    const yes = await run("open gmail with my account", mid, {}, fakeHuman({ interactive: true, confirm: [true] }));
    expect(yes.plan.profile).toMatchObject({ profile: profiles[1], how: "human" });
    const no = await run("open gmail with my account", mid);
    expect(no.plan.profile).toMatchObject({ how: "workspace_default" });
    const amb = await run("open gmail with my account", [{ name: "plan", answers: () => ({ profile_mentioned: 0.9, profile: { choice: "Profile 2", confidence: 0.3, probabilities: { "Profile 14": 0.3, "Profile 2": 0.3, Default: 0.2, no_profile_mentioned: 0.2 } }, goal: "act" }) }]);
    expect(amb.plan.profile.blocked).toBe("ambiguous_profile");
    expect(amb.plan.top.length).toBe(3);
  });
  it("the profile question passes a profile detail with the name and the directory; a no uses the workspace default", async () => {
    const mid: OracleScript = [{ name: "plan", answers: () => ({ profile_mentioned: 0.9, profile: { choice: "Profile 2", confidence: 0.6 }, goal: "act" }) }];
    const human = fakeHuman({ interactive: true, confirm: [false] });
    const no = await run("open gmail with my account", mid, {}, human);
    expect(human.prompts).toEqual(["confirm:Use Chrome profile BP (Profile 2)? [y/N] "]);
    expect(human.details).toEqual([{ kind: "profile", name: "BP", directory: "Profile 2" }]);
    expect(no.plan.profile).toMatchObject({ how: "workspace_default", profile: profiles[0] });
  });
});

describe("start resolution", () => {
  it("flag, task URL, one catalog hit", async () => {
    expect((await run("open gmail", [], { url: "https://x", goal: "act" })).plan.start).toEqual({ url: "https://x", how: "flag", confidence: null });
    expect((await run("open https://a.b/c", [], { goal: "act" })).plan.start).toMatchObject({ url: "https://a.b/c", how: "task_url" });
    expect((await run("open gmail", [], { goal: "act", profile: "none" })).plan.start).toMatchObject({ url: "https://mail.google.com", how: "catalog_exact" });
  });
  it("two hits -> site over the two; site 0.75 -> catalog_jev", async () => {
    const r = await run("open gmail or drive", [{ name: "plan", answers: () => ({ site: { choice: "google_drive", confidence: 0.75 }, goal: "act" }) }], { profile: "none" });
    expect(Object.keys((r.oracle.requests[0]?.questions["site"] as ChoiceQuestion).criteria)).toEqual(["gmail", "google_drive", "none_of_these"]);
    expect(r.plan.start).toMatchObject({ url: "https://drive.google.com", how: "catalog_jev", confidence: 0.75 });
  });
  it("search fallback encodes the span; otherwise no_start_url", async () => {
    const r = await run('find "Alan Turing" birthday', [{ name: "plan", answers: () => ({ site: "none_of_these", wants_search: 0.9, search_query: { choice: "s1", confidence: 0.8 }, goal: "extract" }) }], { profile: "none" });
    expect(r.plan.start).toMatchObject({ url: SEARCH_URL("Alan Turing"), how: "search_query" });
    expect(r.plan.start.url).toContain("Alan%20Turing");
    const none = await run("do the thing", [{ name: "plan", answers: () => ({ site: "none_of_these", wants_search: 0.1, goal: "act" }) }], { profile: "none" });
    expect(none.plan.start.blocked).toBe("no_start_url");
  });
  it("fallbackUrl -> current_page with no site question; a task URL, --url, or one catalog hit still wins", async () => {
    const fb = await run("click the second result", [{ name: "plan", answers: () => ({ goal: "act" }) }], { profile: "none", fallbackUrl: "https://a.b/page" });
    expect(fb.plan.start).toEqual({ url: "https://a.b/page", how: "current_page", confidence: null });
    expect(Object.keys(fb.oracle.requests[0]?.questions ?? {})).toEqual(["goal"]);
    const settled = await run("click the second result", [], { profile: "none", goal: "act", fallbackUrl: "https://a.b/page" });
    expect(settled.oracle.requests.length).toBe(0);
    expect(settled.plan.start.how).toBe("current_page");
    expect((await run("open https://c.d/e", [], { profile: "none", goal: "act", fallbackUrl: "https://a.b/page" })).plan.start).toMatchObject({ url: "https://c.d/e", how: "task_url" });
    expect((await run("do it", [], { profile: "none", goal: "act", url: "https://f.g", fallbackUrl: "https://a.b/page" })).plan.start).toMatchObject({ url: "https://f.g", how: "flag" });
    expect((await run("open gmail", [], { profile: "none", goal: "act", fallbackUrl: "https://a.b/page" })).plan.start).toMatchObject({ url: "https://mail.google.com", how: "catalog_exact" });
    const two = await run("open gmail or drive", [{ name: "plan", answers: () => ({ site: { choice: "google_drive", confidence: 0.75 }, goal: "act" }) }], { profile: "none", fallbackUrl: "https://a.b/page" });
    expect(two.plan.start).toMatchObject({ how: "current_page" });
    expect(two.oracle.requests[0]?.questions["site"]).toBeUndefined();
  });
  it("--goal skips the goal question and PLAN is skipped entirely when everything is settled", async () => {
    const r = await run("open https://a.b in the BP profile", [], { goal: "check" });
    expect(r.oracle.requests.length).toBe(0);
    expect(r.plan).toMatchObject({ goal: "check", jevRequests: 0, profile: { how: "task_exact" }, start: { how: "task_url" } });
  });
});

describe("prePlan: what code knows before any Jev request", () => {
  it("--profile none + task URL + --goal: profile undefined (temporary), URL known, no Jev", () => {
    expect(prePlan(cfg("open https://a.b/c", { profile: "none", goal: "act" }), profiles)).toEqual({ profileDirectory: undefined, startUrl: "https://a.b/c", current: false, needsJev: false });
  });
  it("profile from the flag, an exact mention, or the workspace default is known; no profile at all is the temporary directory", () => {
    expect(prePlan(cfg("open https://a.b", { profile: "bp", goal: "act" }), profiles).profileDirectory).toBe("Profile 2");
    expect(prePlan(cfg("open https://a.b in the BP profile", { goal: "act" }), profiles).profileDirectory).toBe("Profile 2");
    expect(prePlan(cfg("open https://a.b", { goal: "act" }), profiles).profileDirectory).toBe("Profile 14");
    expect(prePlan(cfg("open https://a.b", { goal: "act" }), [{ directory: "Profile 2", name: "BP" }]).profileDirectory).toBeUndefined();
    expect(() => prePlan(cfg("open https://a.b", { profile: "nope" }), profiles)).toThrow(UsageError);
  });
  it("two mentions or an account word leave the profile to Jev: null and needsJev", () => {
    expect(prePlan(cfg("use BP or Parallelloop to open https://a.b", { goal: "act" }), profiles)).toMatchObject({ profileDirectory: null, startUrl: "https://a.b", needsJev: true });
    expect(prePlan(cfg("open https://a.b with my work account", { goal: "act" }), profiles)).toMatchObject({ profileDirectory: null, needsJev: true });
    expect(prePlan(cfg("open https://a.b with my work account", { goal: "act" }), [])).toMatchObject({ profileDirectory: undefined, needsJev: false });
  });
  it("URL from --url, the task, or one catalog hit is known; current_page sets current", () => {
    expect(prePlan(cfg("do it", { profile: "none", goal: "act", url: "https://f.g" }), profiles)).toMatchObject({ startUrl: "https://f.g", current: false });
    expect(prePlan(cfg("open wikipedia.org and search", { profile: "none", goal: "act" }), profiles)).toMatchObject({ startUrl: "https://wikipedia.org", current: false });
    expect(prePlan(cfg("open gmail", { profile: "none", goal: "act" }), profiles)).toMatchObject({ startUrl: "https://mail.google.com", current: false });
    expect(prePlan(cfg("click the second result", { profile: "none", goal: "act", fallbackUrl: "https://a.b/page" }), profiles)).toEqual({ profileDirectory: undefined, startUrl: "https://a.b/page", current: true, needsJev: false });
  });
  it("two catalog hits or no site leave the URL to Jev: null and needsJev", () => {
    expect(prePlan(cfg("open gmail or drive", { profile: "none", goal: "act" }), profiles)).toEqual({ profileDirectory: undefined, startUrl: null, current: false, needsJev: true });
    expect(prePlan(cfg("do the thing", { profile: "none", goal: "act" }), profiles)).toEqual({ profileDirectory: undefined, startUrl: null, current: false, needsJev: true });
  });
  it("no --goal needs Jev even when the profile and the URL are known", () => {
    expect(prePlan(cfg("open https://a.b/c", { profile: "none" }), profiles)).toEqual({ profileDirectory: undefined, startUrl: "https://a.b/c", current: false, needsJev: true });
  });
  it("agrees with resolvePlan on the profile and the URL whenever it says they are known", async () => {
    const cases: [string, Partial<RunConfig>][] = [
      ["open https://a.b/c", { profile: "none" }], ["open gmail in the Parallelloop profile", {}], ["open https://a.b", { profile: "bp", goal: "extract" }],
      ["click the second result", { profile: "none", fallbackUrl: "https://a.b/page" }], ["open wikipedia.org", {}], ["do it", { url: "https://f.g" }],
    ];
    for (const [task, over] of cases) {
      const pre = prePlan(cfg(task, over), profiles);
      const { plan } = await run(task, [{ name: "plan", answers: () => ({ goal: "act" }) }], over);
      expect(pre.profileDirectory).toBe(plan.profile.profile?.directory);
      expect(pre.startUrl).toBe(plan.start.url);
      expect(pre.current).toBe(plan.start.how === "current_page");
      expect(pre.needsJev).toBe(plan.jevRequests === 1);
    }
  });
});
