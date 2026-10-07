import { describe, expect, it } from "vitest";
import type { Action, EditPlan, Observation, Page } from "../../src/fast/model.js";
import { StalePage } from "../../src/fast/model.js";
import { findTarget, replaySteps, skipAhead, stepTimeoutMs, wallOf } from "../../src/scrape/replay.js";
import type { Step } from "../../src/scrape/spec.js";
import { fakeHuman, fakeLogger } from "../fakes.js";
import { el, obs, scrollDown } from "../fast/fakes.js";

const URL = "https://shop.example/";

interface Call { op: string; id?: string; text?: string; edit?: EditPlan; key?: string }

/** A page whose observation comes from `view(n)`: n counts the observes. `stale` makes the first acts throw StalePage. */
function seqPage(view: (n: number, calls: Call[]) => Observation, stale = 0) {
  const calls: Call[] = [];
  let n = 0;
  let left = stale;
  const page = {
    targetId: "t", sessionId: "s", stats: { browserMs: 0, calls: 0 }, calls, get observes() { return n; },
    async observe() { n += 1; return view(n, calls); },
    async fresh() { return true; },
    async act(a: Action, _o: Observation, text?: string, edit?: EditPlan) {
      if (left > 0) { left -= 1; throw new StalePage("changed"); }
      calls.push({ op: "act", id: a.id, ...(text !== undefined ? { text } : {}), ...(edit ? { edit } : {}) });
    },
    async press(key: string) { calls.push({ op: "press", key }); },
    async back() { calls.push({ op: "back" }); },
    async navigate(url: string) { calls.push({ op: "navigate", text: url }); },
    async url() { return URL; },
  };
  return page as unknown as Page & { calls: Call[]; observes: number };
}

/** A clock that moves only when the replay sleeps. */
function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
}

const SEARCH = obs(URL, [
  el("e1", "fill", "Search products", "searchbox", { value: "" }),
  el("e2", "click", "Search", "button"),
  el("e3", "click", "Koramangala 1st Block, Bengaluru", "button", { inferred: true }),
  el("e4", "click", "Koramangala 5th Block, Bengaluru", "button", { inferred: true }),
  el("e5", "click", "Near Koramangala", "button", { popup: [9] }),
  el("e6", "click", "Help", "link"),
  el("e7", "click", "Open Search products", "searchbox"),
  el("e8", "select", "Month → 01", "combobox", { node: 20, current_value: "08" }),
  el("e9", "select", "Month → 09", "combobox", { node: 20, current_value: "08" }),
]);

describe("findTarget", () => {
  it("exact, starts, and contains in normalized form; nth in snapshot order; params filled", () => {
    expect(findTarget(SEARCH, { role: "button", name: "  SEARCH " }, {})?.id).toBe("e2");
    expect(findTarget(SEARCH, { role: "button", name: "{area}", match: "starts" }, { area: "koramangala" })?.id).toBe("e3");
    expect(findTarget(SEARCH, { role: "button", name: "{area}", match: "starts", nth: 1 }, { area: "Koramangala" })?.id).toBe("e4");
    expect(findTarget(SEARCH, { role: "button", name: "{area}", match: "contains", nth: 2 }, { area: "Koramangala" })?.id).toBe("e5");
    expect(findTarget(SEARCH, { role: "button", name: "Koramangala" }, {})).toBeNull();
  });
  it("under prefers controls in a popup", () => {
    expect(findTarget(SEARCH, { role: "button", name: "koramangala", match: "contains", under: "Location" }, {})?.id).toBe("e5");
  });
  it("role relax: one clickable action with the exact name, when no action has the role", () => {
    expect(findTarget(SEARCH, { role: "button", name: "Help" }, {})?.id).toBe("e6");
    const two = obs(URL, [el("e1", "click", "Help", "link"), el("e2", "click", "Help", "menuitem")]);
    expect(findTarget(two, { role: "button", name: "Help" }, {})).toBeNull();
  });
  it("a fill takes any text role; a click action of the same name is not a fill target", () => {
    expect(findTarget(SEARCH, { role: "textbox", name: "Search products" }, {}, "fill")?.id).toBe("e1");
    expect(findTarget(SEARCH, { role: "textbox", name: "Open Search products" }, {}, "fill")).toBeNull();
  });
  it("a select compares the name before ' → ', one control per element", () => {
    expect(findTarget(SEARCH, { role: "combobox", name: "Month" }, {}, "select")?.id).toBe("e8");
    expect(findTarget(SEARCH, { role: "combobox", name: "Month", nth: 1 }, {}, "select")).toBeNull();
  });
});

describe("wallOf", () => {
  it("captcha by title or text; sign-in by auth host or title", () => {
    expect(wallOf({ url: URL, title: "Just a moment...", text: "" })).toBe("captcha");
    expect(wallOf({ url: URL, title: "Shop", text: "Please verify you are human" })).toBe("captcha");
    expect(wallOf({ url: "https://accounts.google.com/signin", title: "Google", text: "" })).toBe("sign_in");
    expect(wallOf({ url: URL, title: "Sign in to continue", text: "" })).toBe("sign_in");
    expect(wallOf({ url: URL, title: "Shop", text: "eggs" })).toBeNull();
  });
  it("JEV_SCRAPE_STEP_MS sets the step timeout", () => {
    expect(stepTimeoutMs({})).toBe(8000);
    expect(stepTimeoutMs({ JEV_SCRAPE_STEP_MS: "2500" })).toBe(2500);
    expect(stepTimeoutMs({ JEV_SCRAPE_STEP_MS: "x" })).toBe(8000);
  });
});

// A shop whose delivery location the profile keeps: the header shows the area in place of "Select Location".
const LOCATION_STEPS: Step[] = [
  { op: "click", target: { role: "button", name: "Select Location" } },
  { op: "fill", target: { role: "textbox", name: "Search a new address" }, value: "{area}" },
  { op: "click", target: { role: "button", name: "{area}", match: "starts" } },
  { op: "click", target: { role: "link", name: "Search for products" } },
  { op: "fill", target: { role: "combobox", name: "Search" }, value: "{query}" },
];
const SET_HOME = obs(URL, [el("e1", "click", "Koramangala", "button"), el("e2", "click", "Search for products", "link")], "7 minutes\nKoramangala");

describe("skipAhead", () => {
  const P = { area: "Koramangala", query: "eggs" };
  it("goes on at the first later step whose control shows, when the values of the steps between show", () => {
    expect(skipAhead(SET_HOME, LOCATION_STEPS, 0, P)).toBe(3);
  });
  it("a value that does not show, or only clicks between, give no skip", () => {
    expect(skipAhead(SET_HOME, LOCATION_STEPS, 0, { ...P, area: "Indiranagar" })).toBeNull();
    const clicks: Step[] = [{ op: "click", target: { role: "button", name: "Sort by price" } }, { op: "click", target: { role: "link", name: "Search for products" } }];
    expect(skipAhead(SET_HOME, clicks, 0, P)).toBeNull();
  });
  it("no later control on the page gives no skip", () => {
    expect(skipAhead(obs(URL, [], "Koramangala"), LOCATION_STEPS, 0, P)).toBeNull();
  });

  // NECC: two unlabelled selects named by their option lists, and the submit. Each option is its own select action.
  const NECC_URL = "https://www.e2necc.com/home/eggprice";
  const MONTHS = "01 02 03 04 05 06 07 08 09 10 11 12";
  const NECC_STEPS: Step[] = [
    { op: "select", target: { role: "combobox", name: MONTHS }, value: "{month}" },
    { op: "select", target: { role: "combobox", name: "2026 2025 2024" }, value: "{year}" },
    { op: "click", target: { role: "button", name: "Get Sheet" } },
  ];
  const selects = (name: string, options: string[], node: number, current: string) =>
    options.filter((o) => o !== current).map((o) => el(`n${node}-${o}`, "select", `${name} → ${o}`, "combobox", { node, current_value: current }));
  // January 2027: the site adds 2027 to the year list and shows it by default. The year step no longer matches.
  const NEW_YEAR = obs(NECC_URL, [
    ...selects(MONTHS, MONTHS.split(" "), 2, "01"),
    ...selects("2027 2026 2025 2024", ["2027", "2026", "2025", "2024"], 3, "2027"),
    el("e9", "click", "Get Sheet", "button"),
  ], "NECC SUGGESTED EGG PRICES 01/2027 Hyderabad 508 525");

  it("a renamed select is never skipped: an option label is no proof that the value is set", () => {
    expect(skipAhead(NEW_YEAR, NECC_STEPS, 1, { month: "01", year: "2025" })).toBeNull();
    // A select step between the missing control and the later control stops the skip too.
    expect(skipAhead(NEW_YEAR, NECC_STEPS, 0, { month: "08", year: "2027" })).toBeNull();
  });
  it("a fill value counts only as a whole word of the text or of a field value, not as a part of a price or a label", () => {
    const steps: Step[] = [
      { op: "fill", target: { role: "textbox", name: "Pincode" }, value: "{pin}" },
      { op: "click", target: { role: "button", name: "Search for products" } },
    ];
    const page = (text: string, extra: Action[] = []) => obs(URL, [el("e2", "click", "Search for products", "button"), ...extra], text);
    // "508" holds "08"; "5600341" holds "560034"; a label holds the value.
    expect(skipAhead(page("Price 508"), steps, 0, { pin: "08" })).toBeNull();
    expect(skipAhead(page("Deliver to 5600341"), steps, 0, { pin: "560034" })).toBeNull();
    expect(skipAhead(page("Deliver to", [el("e3", "click", "Change 560034", "button")]), steps, 0, { pin: "560034" })).toBeNull();
    // A short number is no proof even as a whole word: "08" can be a day or a month in any text.
    expect(skipAhead(page("Delivery on 08 Oct"), steps, 0, { pin: "08" })).toBeNull();
    expect(skipAhead(page("Deliver to 560034"), steps, 0, { pin: "560034" })).toBe(1);
    expect(skipAhead(page("Deliver to", [el("e3", "fill", "Area", "textbox", { value: "560034" })]), steps, 0, { pin: "560034" })).toBe(1);
  });
});

describe("replaySteps", () => {
  const log = fakeLogger();
  const EMPTY = obs(URL, [], "loading");

  it("a guard that refuses a click or an Enter fails the replay as refused and sends no input; other keys are not checked", async () => {
    const view = { ...obs(URL, [el("e1", "click", "Open", "button"), el("e2", "click", "Delete note", "button")], "notes"), focus: { node: 9, label: "Note", role: "textbox", submitLabel: "Delete note" } } as Observation;
    const seen: unknown[] = [];
    const guard = (i: { kind: "click" | "enter"; label: string; url: string }) => { seen.push(i); return /delete/i.test(i.label) ? "not allowed here" : null; };
    const page = seqPage(() => view);
    const steps: Step[] = [{ op: "click", target: { role: "button", name: "Open" } }, { op: "click", target: { role: "button", name: "Delete note" } }];
    expect(await replaySteps(page, steps, {}, { log, guard })).toEqual({ ok: false, step: 1, reason: "step 2: not allowed here", wall: null, refused: true });
    expect(page.calls).toEqual([{ op: "act", id: "e1" }]);
    expect(seen).toEqual([{ kind: "click", label: "Open", url: URL }, { kind: "click", label: "Delete note", url: URL }]);
    const enter = seqPage(() => view);
    expect(await replaySteps(enter, [{ op: "press", key: "Enter" }], {}, { log, guard })).toMatchObject({ ok: false, refused: true });
    expect(enter.calls).toEqual([]);
    expect(seen.at(-1)).toEqual({ kind: "enter", label: "Note | Delete note", url: URL, search: false });
    const searchView = { ...obs(URL, [el("e7", "fill", "Search notes", "searchbox", { node: 7, value: "milk" })], "notes"), focus: { node: 7, label: "Search notes", role: "searchbox", submitLabel: "" } } as Observation;
    await replaySteps(seqPage(() => searchView), [{ op: "press", key: "Enter" }], {}, { log, guard });
    expect(seen.at(-1)).toEqual({ kind: "enter", label: "Search notes", url: URL, search: true });
    const tab = seqPage(() => view);
    expect(await replaySteps(tab, [{ op: "press", key: "Tab" }], {}, { log, guard })).toEqual({ ok: true, steps: 1 });
    expect(tab.calls).toEqual([{ op: "press", key: "Tab" }]);
  });
  it("a missing control of a value that the page shows already skips its steps after a short wait", async () => {
    const results = obs(URL, [el("e5", "fill", "Search", "combobox", { value: "" })], "results");
    const page = seqPage((_n, calls) => (calls.some((c) => c.id === "e2") ? results : SET_HOME));
    const c = clock();
    const r = await replaySteps(page, LOCATION_STEPS, { area: "Koramangala", query: "eggs" }, { log, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ ok: true, steps: 5 });
    expect(page.calls).toEqual([{ op: "act", id: "e2" }, { op: "act", id: "e5", text: "eggs", edit: { mode: "replace" } }]);
    // The skip waits OPTIONAL_MS (1 s), not the step timeout.
    expect(c.now()).toBeGreaterThanOrEqual(1000);
    expect(c.now()).toBeLessThan(2000);
  });
  it("a control that shows late, inside the short wait, gets its step: the replay does not skip it", async () => {
    // The location button renders at the 3rd observe (500 ms), while the header already shows the area.
    const modal = obs(URL, [el("e9", "click", "Select Location", "button"), el("e2", "click", "Search for products", "link")], "7 minutes\nKoramangala");
    const page = seqPage((n) => (n < 3 ? SET_HOME : modal));
    const c = clock();
    const r = await replaySteps(page, LOCATION_STEPS.slice(0, 4), { area: "Koramangala", query: "eggs" }, { log, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ ok: true, steps: 4 });
    // The location button gets its click; the fill and the row that do not show are skipped after the short wait.
    expect(page.calls).toEqual([{ op: "act", id: "e9" }, { op: "act", id: "e2" }]);
  });
  it("a renamed year select fails the replay for the heal: the run never reads the default year", async () => {
    const MONTHS = "01 02 03 04 05 06 07 08 09 10 11 12";
    const steps: Step[] = [
      { op: "select", target: { role: "combobox", name: MONTHS }, value: "{month}" },
      { op: "select", target: { role: "combobox", name: "2026 2025 2024" }, value: "{year}" },
      { op: "click", target: { role: "button", name: "Get Sheet" } },
    ];
    const page = seqPage(() => obs(URL, [
      el("e1", "select", `${MONTHS} → 03`, "combobox", { node: 2, current_value: "01" }),
      el("e2", "select", "2027 2026 2025 2024 → 2025", "combobox", { node: 3, current_value: "2027" }),
      el("e3", "click", "Get Sheet", "button"),
    ], "NECC egg prices 01/2027 Ahmedabad 590"));
    const c = clock();
    const r = await replaySteps(page, steps, { month: "03", year: "2025" }, { log, now: c.now, sleep: c.sleep, stepTimeoutMs: 2000 });
    expect(r).toEqual({ ok: false, step: 1, reason: "step 2: no select \"2026 2025 2024\"", wall: null });
    expect(page.calls).toEqual([{ op: "act", id: "e1" }]);
  });
  it("a location that the page does not show fails at the missing control, for the heal", async () => {
    const page = seqPage(() => obs(URL, [el("e1", "click", "Indiranagar", "button"), el("e2", "click", "Search for products", "link")], "Indiranagar"));
    const c = clock();
    const r = await replaySteps(page, LOCATION_STEPS, { area: "Koramangala", query: "eggs" }, { log, now: c.now, sleep: c.sleep, stepTimeoutMs: 3000 });
    expect(r).toEqual({ ok: false, step: 0, reason: "step 1: no button \"Select Location\"", wall: null });
    expect(page.calls).toEqual([]);
  });

  it("fill replaces, click, press, back, and scroll run in order", async () => {
    const page = seqPage(() => ({ ...SEARCH, actions: [...SEARCH.actions, scrollDown()] }));
    const c = clock();
    const steps: Step[] = [
      { op: "fill", target: { role: "textbox", name: "Search products" }, value: "{query}" },
      { op: "click", target: { role: "button", name: "Search" } },
      { op: "press", key: "Enter" },
      { op: "scroll", direction: "down", times: 2 },
      { op: "back" },
    ];
    const r = await replaySteps(page, steps, { query: "eggs" }, { log, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ ok: true, steps: 5 });
    expect(page.calls).toEqual([
      { op: "act", id: "e1", text: "eggs", edit: { mode: "replace" } }, { op: "act", id: "e2" }, { op: "press", key: "Enter" },
      { op: "act", id: "scroll_down" }, { op: "act", id: "scroll_down" }, { op: "back" },
    ]);
  });
  it("a target that shows after 2 polls", async () => {
    const page = seqPage((n) => (n <= 2 ? EMPTY : SEARCH));
    const c = clock();
    const r = await replaySteps(page, [{ op: "click", target: { role: "button", name: "Search" } }], {}, { log, now: c.now, sleep: c.sleep });
    expect(r.ok).toBe(true);
    expect(page.observes).toBe(3);
    expect(c.sleeps).toEqual([250, 250]);
  });
  it("an optional click whose target is missing is skipped after a short wait", async () => {
    const page = seqPage(() => SEARCH);
    const c = clock();
    const r = await replaySteps(page, [{ op: "click", target: { role: "button", name: "Accept cookies" }, optional: true }, { op: "click", target: { role: "button", name: "Search" } }], {}, { log, now: c.now, sleep: c.sleep });
    expect(r).toEqual({ ok: true, steps: 2 });
    expect(page.calls).toEqual([{ op: "act", id: "e2" }]);
    expect(c.now()).toBeLessThanOrEqual(1000);
  });
  it("a select is a no-op when the current value is the value; else it picks the option", async () => {
    const page = seqPage(() => SEARCH);
    const c = clock();
    expect(await replaySteps(page, [{ op: "select", target: { role: "combobox", name: "Month" }, value: "{m}" }], { m: "08" }, { log, now: c.now, sleep: c.sleep })).toEqual({ ok: true, steps: 1 });
    expect(page.calls).toEqual([]);
    expect(await replaySteps(page, [{ op: "select", target: { role: "combobox", name: "Month" }, value: "09" }], {}, { log, now: c.now, sleep: c.sleep })).toEqual({ ok: true, steps: 1 });
    expect(page.calls).toEqual([{ op: "act", id: "e9" }]);
    const r = await replaySteps(page, [{ op: "select", target: { role: "combobox", name: "Month" }, value: "13" }], {}, { log, now: c.now, sleep: c.sleep });
    expect(r).toMatchObject({ ok: false, step: 0, reason: "step 1: select \"Month\" has no option \"13\"" });
  });
  it("a StalePage observes again, at most 3 times per step", async () => {
    const ok = seqPage(() => SEARCH, 3);
    const c = clock();
    expect((await replaySteps(ok, [{ op: "click", target: { role: "button", name: "Search" } }], {}, { log, now: c.now, sleep: c.sleep })).ok).toBe(true);
    expect(ok.observes).toBe(4);
    const bad = seqPage(() => SEARCH, 4);
    const r = await replaySteps(bad, [{ op: "click", target: { role: "button", name: "Search" } }], {}, { log, now: c.now, sleep: c.sleep });
    expect(r).toMatchObject({ ok: false, step: 0, reason: "step 1: the page kept changing at button \"Search\"" });
    expect(bad.calls).toEqual([]);
  });
  it("a failure returns the index of the step and the reason", async () => {
    const page = seqPage(() => SEARCH);
    const c = clock();
    const r = await replaySteps(page, [
      { op: "fill", target: { role: "searchbox", name: "Search products" }, value: "eggs" },
      { op: "click", target: { role: "button", name: "Go" } },
    ], {}, { log, now: c.now, sleep: c.sleep, stepTimeoutMs: 2000 });
    expect(r).toEqual({ ok: false, step: 1, reason: "step 2: no button \"Go\"", wall: null });
    expect(c.now()).toBeGreaterThanOrEqual(2000);
  });
  it("a sign-in wall or a captcha at a missing target blocks a headless run", async () => {
    const c = clock();
    const signIn = seqPage(() => obs("https://accounts.google.com/signin", [], "Sign in", { title: "Sign in - Google Accounts" }));
    const r1 = await replaySteps(signIn, [{ op: "click", target: { role: "button", name: "Search" } }], {}, { log, now: c.now, sleep: c.sleep, stepTimeoutMs: 1000 });
    expect(r1).toEqual({ ok: false, step: 0, reason: "step 1: a sign-in wall blocks the page", wall: "sign_in" });
    const captcha = seqPage(() => obs(URL, [], "Are you a robot?"));
    const human = fakeHuman({ interactive: true });
    const r2 = await replaySteps(captcha, [{ op: "click", target: { role: "button", name: "Search" } }], {}, { log, now: c.now, sleep: c.sleep, stepTimeoutMs: 1000, human, headed: false });
    expect(r2).toMatchObject({ ok: false, wall: "captcha" });
    expect(human.prompts).toEqual([]);
  });
  it("an interactive headed human pause 'resumed' retries the step", async () => {
    let cleared = false;
    const page = seqPage(() => (cleared ? SEARCH : obs(URL, [], "Verify you are human")));
    const c = clock();
    const human = fakeHuman({ interactive: true, pause: ["resumed"] });
    const pause = human.pause.bind(human);
    human.pause = async (...a) => { cleared = true; return pause(...a); };
    const r = await replaySteps(page, [{ op: "click", target: { role: "button", name: "Search" } }], {}, { log, now: c.now, sleep: c.sleep, stepTimeoutMs: 1000, human, headed: true, name: "shop" });
    expect(r).toEqual({ ok: true, steps: 1 });
    expect(human.kinds).toEqual(["captcha"]);
    expect(human.prompts[0]).toMatch(/^pause:\(captcha\): Solve the captcha in the browser window for the scraper shop/);
  });
  it("a pause that times out blocks", async () => {
    const page = seqPage(() => obs(URL, [], "x", { title: "Log in" }));
    const c = clock();
    const human = fakeHuman({ interactive: true, pause: ["timeout"] });
    const r = await replaySteps(page, [{ op: "click", target: { role: "button", name: "Search" } }], {}, { log, now: c.now, sleep: c.sleep, stepTimeoutMs: 1000, human, headed: true });
    expect(r).toMatchObject({ ok: false, wall: "sign_in" });
  });
  it("wait: ms sleeps; for_text polls until the text shows or the time ends, and goes on", async () => {
    const page = seqPage((n) => (n < 3 ? EMPTY : obs(URL, [], "Results\nADD")));
    const c = clock();
    const r = await replaySteps(page, [{ op: "wait", ms: 700 }, { op: "wait", for_text: "add" }, { op: "wait", for_text: "never", ms: 500 }], {}, { log, now: c.now, sleep: c.sleep });
    expect(r.ok).toBe(true);
    expect(c.sleeps[0]).toBe(700);
  });
  it("an aborted signal stops between steps", async () => {
    const page = seqPage(() => SEARCH);
    const ctl = new AbortController();
    ctl.abort();
    expect(await replaySteps(page, [{ op: "press", key: "Enter" }], {}, { log, signal: ctl.signal })).toMatchObject({ ok: false, step: 0, reason: "step 1: aborted" });
  });
  it("an error of the page fails the step and never throws", async () => {
    const page = seqPage(() => { throw new Error("target closed"); });
    const r = await replaySteps(page, [{ op: "click", target: { role: "button", name: "Search" } }], {}, { log });
    expect(r).toEqual({ ok: false, step: 0, reason: "step 1: click failed: target closed", wall: null });
  });
});
