// Resolve profile, start URL, and goal. One PLAN request at most.
import { choice, noul } from "@typesafe-ai/sdk";
import type { ChoiceCriteria, JsonValue, Questions } from "@typesafe-ai/sdk";
import type { ProfileEntry } from "./browser.js";
import type { Human, Logger } from "./io.js";
import type { Oracle } from "./jev.js";
import { choiceOf, noulOf } from "./jev.js";
import { extractProfileMentions, extractUrls, mentionsProfileWord } from "./task.js";
import type { Goal, RunConfig, Span } from "./types.js";
import { DEFAULT_PROFILE_NAME, GATES, LIMITS } from "./types.js";

export class UsageError extends Error {
  constructor(message: string) { super(message); this.name = "UsageError"; }
}

export interface SiteEntry { key: string; url: string; aliases: string[]; description: string }

const site = (key: string, url: string, aliases: string[], description: string): SiteEntry => ({ key, url, aliases, description });
export const SITE_CATALOG: SiteEntry[] = [
  site("wikipedia", "https://www.wikipedia.org", ["wiki", "wikipedia"], "The free encyclopedia"),
  site("google", "https://www.google.com", ["google"], "Google web search"),
  site("gmail", "https://mail.google.com", ["gmail", "google mail"], "Google email"),
  site("google_calendar", "https://calendar.google.com", ["google calendar", "calendar"], "Google Calendar"),
  site("google_drive", "https://drive.google.com", ["google drive", "drive"], "Google Drive files"),
  site("google_docs", "https://docs.google.com", ["google docs"], "Google Docs"),
  site("google_maps", "https://maps.google.com", ["google maps", "maps"], "Google Maps"),
  site("youtube", "https://www.youtube.com", ["youtube"], "Video site"),
  site("github", "https://github.com", ["github"], "Code hosting"),
  site("gitlab", "https://gitlab.com", ["gitlab"], "Code hosting"),
  site("linkedin", "https://www.linkedin.com", ["linkedin"], "Professional network"),
  site("x_twitter", "https://x.com", ["twitter", "x.com"], "X, formerly Twitter"),
  site("reddit", "https://www.reddit.com", ["reddit"], "Discussion forums"),
  site("amazon", "https://www.amazon.com", ["amazon"], "Online shop"),
  site("ebay", "https://www.ebay.com", ["ebay"], "Auction shop"),
  site("stackoverflow", "https://stackoverflow.com", ["stackoverflow", "stack overflow"], "Programming Q&A"),
  site("npm", "https://www.npmjs.com", ["npm", "npmjs"], "Node package registry"),
  site("pypi", "https://pypi.org", ["pypi"], "Python package index"),
  site("hacker_news", "https://news.ycombinator.com", ["hacker news", "hn"], "Hacker News"),
  site("duckduckgo", "https://duckduckgo.com", ["duckduckgo", "ddg"], "Web search"),
  site("bing", "https://www.bing.com", ["bing"], "Web search"),
  site("notion", "https://www.notion.so", ["notion"], "Notes and wikis"),
  site("slack", "https://app.slack.com", ["slack"], "Team chat"),
  site("linear", "https://linear.app", ["linear"], "Issue tracker"),
  site("jira", "https://www.atlassian.com/software/jira", ["jira"], "Issue tracker"),
  site("confluence", "https://www.atlassian.com/software/confluence", ["confluence"], "Team wiki"),
  site("figma", "https://www.figma.com", ["figma"], "Design tool"),
  site("vercel", "https://vercel.com", ["vercel"], "Deployment platform"),
  site("netlify", "https://app.netlify.com", ["netlify"], "Deployment platform"),
  site("aws_console", "https://console.aws.amazon.com", ["aws", "aws console"], "Amazon Web Services console"),
  site("gcp_console", "https://console.cloud.google.com", ["gcp", "google cloud"], "Google Cloud console"),
  site("azure_portal", "https://portal.azure.com", ["azure"], "Azure portal"),
  site("cloudflare", "https://dash.cloudflare.com", ["cloudflare"], "Cloudflare dashboard"),
  site("stripe", "https://dashboard.stripe.com", ["stripe"], "Stripe dashboard"),
  site("shopify", "https://admin.shopify.com", ["shopify"], "Shopify admin"),
  site("trello", "https://trello.com", ["trello"], "Boards"),
  site("asana", "https://app.asana.com", ["asana"], "Tasks"),
  site("dropbox", "https://www.dropbox.com", ["dropbox"], "Files"),
  site("zoom", "https://zoom.us", ["zoom"], "Video calls"),
  site("example", "https://example.com", ["example.com", "example site"], "Example domain"),
  site("mdn", "https://developer.mozilla.org", ["mdn"], "Web docs"),
];

export const SEARCH_URL = (q: string): string => `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}`;

export interface ProfileResolution {
  profile: ProfileEntry | null;
  how: "flag" | "task_exact" | "jev" | "human" | "workspace_default" | "none";
  confidence: number | null;
  blocked?: "ambiguous_profile";
}

export interface StartResolution {
  url: string | null;
  how: "flag" | "task_url" | "catalog_exact" | "catalog_jev" | "search_query" | "current_page" | "none";
  confidence: number | null;
  blocked?: "no_start_url";
}

export interface Plan {
  profile: ProfileResolution;
  start: StartResolution;
  goal: Goal;
  goalConfidence: number | null;
  jevRequests: 0 | 1;
  top: { label: string; p: number }[];
}

/** What the code knows before any Jev request. The fast engine starts Chrome on it while the plan request runs. */
export interface PrePlan {
  /** The profile directory when Jev is not asked about the profile. `undefined` = temporary profile. `null` = Jev decides. */
  profileDirectory: string | null | undefined;
  /** The start URL when Jev is not asked about the site. `null` = Jev decides. */
  startUrl: string | null;
  /** True when the start URL is the page the browser already shows. No navigation then. */
  current: boolean;
  /** True when Jev must decide the profile, the site, or the goal. */
  needsJev: boolean;
}

/** The part of the plan that code decides. Jev fills the rest. */
interface CodePlan {
  profile: ProfileResolution;
  profileCandidates: ProfileEntry[] | null;
  askProfileMentioned: boolean;
  start: StartResolution;
  askSite: SiteEntry[] | null;
  askGoal: boolean;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function catalogHits(task: string): SiteEntry[] {
  return SITE_CATALOG.filter((s) => s.aliases.some((a) => new RegExp(`(?<![\\w.])${esc(a)}(?![\\w-])`, "i").test(task)));
}

export function catalogWords(): string[] {
  return SITE_CATALOG.flatMap((s) => [s.key, ...s.aliases]);
}

export function planQuestions(input: { profileCandidates: ProfileEntry[] | null; askProfileMentioned: boolean; askSite: SiteEntry[] | null; spans: Span[]; askGoal: boolean }): Questions {
  const q: Questions = {};
  if (input.profileCandidates) {
    if (input.askProfileMentioned) {
      q["profile_mentioned"] = noul("Does `task` name a Chrome profile, browser account, or identity from `profiles` that the browser must use?",
        { true: "The task names one of the listed profiles by name or directory, or an account that one profile clearly represents", false: "The task does not say which browser profile or account to use" });
    }
    const c: ChoiceCriteria = {};
    for (const p of input.profileCandidates) c[p.directory] = { name: p.name, directory: p.directory };
    c["no_profile_mentioned"] = "The task does not name a profile or account";
    q["profile"] = choice("Which Chrome profile in `profiles` does `task` ask to use? Pick no_profile_mentioned if the task does not name one.", c);
  }
  if (input.askSite) {
    const c: ChoiceCriteria = {};
    for (const s of input.askSite) c[s.key] = { site: s.description, url: s.url, also_called: s.aliases };
    c["none_of_these"] = "A site that is not in this list, or no site named";
    q["site"] = choice("Which website in the options does `task` ask to open first? Pick none_of_these if the site is not listed or the task does not name a site.", c);
    q["wants_search"] = noul("Can the first step of `task` be done by searching the web for a phrase in `spans`, because the task names no specific website?",
      { true: "The task asks to find, look up, or search for something and names no site or an unknown site", false: "The task names a specific site or page to open" });
    const sc: ChoiceCriteria = {};
    for (const s of input.spans) if (!s.secret) sc[s.id] = { text: s.text, from: s.source };
    sc["none_of_these"] = "No span names the thing to search for";
    q["search_query"] = choice("Which span in `spans` is the phrase to search the web for as the first step of `task`? Pick the span that names the thing to find, not the action. Pick none_of_these if no span fits.", sc);
  }
  if (input.askGoal) {
    q["goal"] = choice("What does `task` ask for at the end?", {
      act: "Change something in the browser: click, fill, submit, navigate. Nothing has to be reported back.",
      extract: "Report a value that is visible on a page, such as a title, subject, number, name, or date.",
      check: "Answer yes or no about the state of a page, such as whether a message exists, an item is present, or an order shipped.",
    });
  }
  return q;
}

/** Resolve what code can decide: the profile from a flag or an exact mention, the start URL from a flag, the task, or the catalog. */
function planByCode(cfg: RunConfig, profiles: ProfileEntry[]): CodePlan {
  const task = cfg.task;
  let profile: ProfileResolution = { profile: null, how: "none", confidence: null };
  let profileCandidates: ProfileEntry[] | null = null;
  let askProfileMentioned = false;
  if (cfg.profile !== undefined) {
    if (cfg.profile.toLowerCase() === "none") profile = { profile: null, how: "flag", confidence: null };
    else {
      const hit = profiles.find((p) => p.name.toLowerCase() === cfg.profile?.toLowerCase() || p.directory.toLowerCase() === cfg.profile?.toLowerCase());
      if (!hit) throw new UsageError(`unknown profile "${cfg.profile}". Available: ${profiles.map((p) => `${p.name} (${p.directory})`).join(", ") || "none"}`);
      profile = { profile: hit, how: "flag", confidence: null };
    }
  } else {
    const mentions = extractProfileMentions(task, profiles);
    if (mentions.length === 1) profile = { profile: mentions[0] as ProfileEntry, how: "task_exact", confidence: null };
    else if (mentions.length >= 2) profileCandidates = mentions;
    else if (mentionsProfileWord(task) && profiles.length > 0) { profileCandidates = profiles; askProfileMentioned = true; }
  }

  let start: StartResolution = { url: null, how: "none", confidence: null };
  let askSite: SiteEntry[] | null = null;
  const hits = catalogHits(task);
  if (cfg.url) start = { url: cfg.url, how: "flag", confidence: null };
  else {
    const taskUrl = extractUrls(task)[0];
    if (taskUrl) start = { url: taskUrl, how: "task_url", confidence: null };
    else if (hits.length === 1) start = { url: (hits[0] as SiteEntry).url, how: "catalog_exact", confidence: null };
    else if (cfg.fallbackUrl) start = { url: cfg.fallbackUrl, how: "current_page", confidence: null };
    else askSite = hits.length >= 2 ? hits : SITE_CATALOG;
  }

  return { profile, profileCandidates, askProfileMentioned, start, askSite, askGoal: cfg.goal === undefined };
}

/** A profile that nothing named falls back to the workspace default, when that profile exists. */
function withDefaultProfile(profile: ProfileResolution, profiles: ProfileEntry[]): ProfileResolution {
  if (profile.profile !== null || profile.blocked || profile.how === "flag") return profile;
  const def = profiles.find((p) => p.name.toLowerCase() === DEFAULT_PROFILE_NAME.toLowerCase());
  return def ? { profile: def, how: "workspace_default", confidence: profile.confidence } : profile;
}

/**
 * What is known before any Jev request. Pure: no request, no prompt. Throws UsageError for an unknown --profile,
 * as resolvePlan does. The profile is known when Jev is not asked about it (flag, task_exact, workspace_default,
 * or no profile at all). The URL is known for flag, task_url, catalog_exact, and current_page.
 */
export function prePlan(cfg: RunConfig, profiles: ProfileEntry[]): PrePlan {
  const c = planByCode(cfg, profiles);
  const profileDirectory = c.profileCandidates ? null : withDefaultProfile(c.profile, profiles).profile?.directory;
  return {
    profileDirectory,
    startUrl: c.askSite ? null : c.start.url,
    current: c.start.how === "current_page",
    needsJev: c.profileCandidates !== null || c.askSite !== null || c.askGoal,
  };
}

export async function resolvePlan(cfg: RunConfig, profiles: ProfileEntry[], spans: Span[], oracle: Oracle, human: Human, log: Logger): Promise<Plan> {
  const task = cfg.task;
  const code = planByCode(cfg, profiles);
  const { profileCandidates, askProfileMentioned, askSite, askGoal } = code;
  let { profile, start } = code;

  let goal: Goal = cfg.goal ?? "act";
  let goalConfidence: number | null = null;
  let jevRequests: 0 | 1 = 0;
  let top: { label: string; p: number }[] = [];

  if (profileCandidates || askSite || askGoal) {
    const questions = planQuestions({ profileCandidates, askProfileMentioned, askSite, spans, askGoal });
    const state: Record<string, JsonValue> = {
      task,
      profiles: (profileCandidates ?? []).map((p) => ({ directory: p.directory, name: p.name })),
      spans: spans.filter((s) => !s.secret).map((s) => ({ id: s.id, text: s.text, from: s.source })),
      sites: (askSite ?? []).map((s) => ({ key: s.key, url: s.url, also_called: s.aliases })),
    };
    const r = await oracle.ask("plan", state, questions);
    jevRequests = 1;
    const A = r.answers;

    if (profileCandidates) {
      const mentioned = askProfileMentioned ? noulOf(A, "profile_mentioned") : 1;
      const p = choiceOf(A, "profile");
      const best = p && p.choice !== "no_profile_mentioned" ? profileCandidates.find((c) => c.directory === p.choice) ?? null : null;
      if (mentioned < GATES.profileMentioned || !p) profile = { profile: null, how: "none", confidence: mentioned };
      else if (best && p.confidence >= GATES.profileJev) profile = { profile: best, how: "jev", confidence: p.confidence };
      else if (best && p.confidence >= GATES.profileHuman) {
        const ok = human.interactive && await human.confirm(`Use Chrome profile ${best.name} (${best.directory})? [y/N] `, LIMITS.confirmPromptMs, { kind: "profile", name: best.name, directory: best.directory });
        if (ok) profile = { profile: best, how: "human", confidence: p.confidence };
        else { log.warn(`profile ${best.name} at ${p.confidence.toFixed(2)} not confirmed; using the workspace default`); profile = { profile: null, how: "none", confidence: p.confidence }; }
      } else if (mentioned >= GATES.profileJev) {
        top = Object.entries(p.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label, pp]) => ({ label, p: Number(pp.toFixed(3)) }));
        profile = { profile: null, how: "none", confidence: p.confidence, blocked: "ambiguous_profile" };
      } else profile = { profile: null, how: "none", confidence: p.confidence };
    }

    if (askSite) {
      const s = choiceOf(A, "site");
      const hit = s && s.choice !== "none_of_these" ? askSite.find((e) => e.key === s.choice) : undefined;
      if (s && hit && s.confidence >= GATES.site) start = { url: hit.url, how: "catalog_jev", confidence: s.confidence };
      else {
        const ws = noulOf(A, "wants_search");
        const sq = choiceOf(A, "search_query");
        const span = sq && sq.choice !== "none_of_these" ? spans.find((x) => x.id === sq.choice) : undefined;
        if (ws >= GATES.wantsSearch && sq && span && sq.confidence >= GATES.searchQuery) start = { url: SEARCH_URL(span.text), how: "search_query", confidence: sq.confidence };
        else {
          if (top.length === 0 && s) top = Object.entries(s.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([label, pp]) => ({ label, p: Number(pp.toFixed(3)) }));
          start = { url: null, how: "none", confidence: s?.confidence ?? null, blocked: "no_start_url" };
        }
      }
    }

    if (askGoal) {
      const g = choiceOf(A, "goal");
      if (g && g.confidence >= GATES.goal && (g.choice === "act" || g.choice === "extract" || g.choice === "check")) { goal = g.choice; goalConfidence = g.confidence; }
      else { log.warn(`goal unclear (${g?.choice ?? "?"} at ${g?.confidence.toFixed(2) ?? "?"}); using act`); goalConfidence = g?.confidence ?? null; }
    }
  }

  profile = withDefaultProfile(profile, profiles);
  return { profile, start, goal, goalConfidence, jevRequests, top };
}
