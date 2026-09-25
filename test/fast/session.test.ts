// BrowserSession: launch, reuse, relaunch, profile keys, close during a launch, the current URL, and epochs.
// Fake Chrome and fake tabs only. No Chrome and no network.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LAUNCH_WAIT_MS } from "../../src/fast/chrome.js";
import type { Chrome, ChromeLaunchOptions, Page } from "../../src/fast/model.js";
import { BrowserSession, ProfileMismatchError, type SessionKey } from "../../src/fast/session.js";
import type { RunConfig } from "../../src/types.js";
import { fakeLogger } from "../fakes.js";
import { fakeChrome, fakePage, obs, type FakeChrome, type FakePage } from "./fakes.js";

function cfg(over: Partial<RunConfig> = {}): RunConfig {
  return {
    task: "t", headed: true, maxSteps: 8, stepTimeoutMs: 1234, runTimeoutMs: 60_000, pauseTimeoutMs: 1000, confirm: "auto", dryRun: false, session: "jev-test",
    model: "m", logLevel: "info", logJson: false, keepOpen: true, agentBrowserBin: "ab", vars: {}, engine: "cdp", ...over,
  };
}

const KEY: SessionKey = { engine: "cdp", headed: true, profileDirectory: "Profile 14" };

/** A tab that shows `url`. */
function tab(url: string): FakePage {
  return fakePage({ pages: { a: obs(url, []) }, start: "a" });
}

/** A launch that records its options and returns a new fake Chrome each time. */
function fakeLaunch() {
  const calls: ChromeLaunchOptions[] = [];
  const chromes: FakeChrome[] = [];
  const launch = async (o: ChromeLaunchOptions): Promise<Chrome> => {
    calls.push(o);
    const c = fakeChrome();
    chromes.push(c);
    return c;
  };
  return { launch, calls, chromes };
}

/** A launch that stays in flight until the test resolves it. */
function heldLaunch() {
  let resolve: (c: Chrome) => void = () => undefined;
  let calls = 0;
  const launch = (_o: ChromeLaunchOptions): Promise<Chrome> => {
    calls += 1;
    return new Promise<Chrome>((r) => { resolve = r; });
  };
  return { launch, finish: (c: Chrome) => resolve(c), get calls() { return calls; } };
}

function session(launch: (o: ChromeLaunchOptions) => Promise<Chrome>, url = "https://example.test/") {
  const log = fakeLogger();
  const opens: { chrome: Chrome; page: FakePage }[] = [];
  const s = new BrowserSession({
    env: { HOME: "/tmp/jev-home" }, log, launch,
    open: async (c) => { const page = tab(url); opens.push({ chrome: c, page }); return page; },
  });
  return { s, log, opens };
}

/** Mark the CDP connection of a fake Chrome as gone, as when the user quits the window. */
function dropConnection(c: FakeChrome): void {
  (c.client as unknown as { closed: boolean }).closed = true;
}

afterEach(() => { vi.useRealTimers(); });

describe("BrowserSession launch and reuse", () => {
  it("launches once, then reuses the open Chrome", async () => {
    const l = fakeLaunch();
    const { s, log } = session(l.launch);
    const chromeFor = s.chromeFor(cfg({ refreshProfile: true, chromeBin: "/opt/chrome" }));
    const a = await chromeFor("Profile 14");
    const b = await chromeFor("Profile 14");
    expect(a).toBe(b);
    expect(s.chrome).toBe(a);
    expect(l.calls).toHaveLength(1);
    expect(l.calls[0]).toEqual({
      browser: "chrome", headed: true, profileDirectory: "Profile 14", refreshProfile: true, chromeBin: "/opt/chrome",
      commandTimeoutMs: 1234, env: { HOME: "/tmp/jev-home" }, log,
    });
    // A second run with the same key also reuses it.
    await s.prepare(KEY);
    expect(await s.chromeFor(cfg())("Profile 14")).toBe(a);
    expect(l.calls).toHaveLength(1);
    expect(l.chromes[0]!.closes).toBe(0);
  });

  it("launches chromium with a temporary profile and passes the cdp port", async () => {
    const l = fakeLaunch();
    const { s } = session(l.launch);
    await s.chromeFor(cfg({ engine: "chromium", headed: false, cdp: 9333 }))(undefined);
    expect(l.calls[0]).toMatchObject({ browser: "chromium", headed: false, cdpPort: 9333 });
    expect(l.calls[0]).not.toHaveProperty("profileDirectory");
    expect(l.calls[0]).not.toHaveProperty("refreshProfile");
    // The temporary profile key matches a later run without a directory.
    await s.prepare({ engine: "chromium", headed: false, profileDirectory: null });
    expect(s.chrome).toBe(l.chromes[0]);
  });

  it("relaunches after client.closed", async () => {
    const l = fakeLaunch();
    const { s, log } = session(l.launch);
    const chromeFor = s.chromeFor(cfg());
    const first = await chromeFor("Profile 14");
    const epoch = s.epoch;
    dropConnection(l.chromes[0]!);
    const second = await chromeFor("Profile 14");
    expect(second).not.toBe(first);
    expect(l.calls).toHaveLength(2);
    expect(l.chromes[0]!.closes).toBe(1);
    expect(s.chrome).toBe(second);
    expect(s.epoch).toBe(epoch + 1);
    expect(log.lines.some((x) => x.startsWith("WARN chrome connection is closed"))).toBe(true);
  });

  it("chromeFor throws ProfileMismatchError on a different directory and keeps the open Chrome", async () => {
    const l = fakeLaunch();
    const { s } = session(l.launch);
    const chromeFor = s.chromeFor(cfg());
    const open = await chromeFor("Profile 14");
    await expect(chromeFor("Profile 2")).rejects.toBeInstanceOf(ProfileMismatchError);
    await expect(chromeFor(undefined)).rejects.toThrow(/open with profile Profile 14 \(cdp, headed\); the task needs a temporary profile/);
    expect(l.calls).toHaveLength(1);
    expect(l.chromes[0]!.closes).toBe(0);
    expect(s.chrome).toBe(open);
  });

  it("chromeFor also throws when the engine or the window mode differs", async () => {
    const l = fakeLaunch();
    const { s } = session(l.launch);
    await s.chromeFor(cfg())("Profile 14");
    await expect(s.chromeFor(cfg({ headed: false }))("Profile 14")).rejects.toBeInstanceOf(ProfileMismatchError);
    await expect(s.chromeFor(cfg({ engine: "chromium" }))("Profile 14")).rejects.toThrow(/needs profile Profile 14 \(chromium, headed\)/);
    expect(l.calls).toHaveLength(1);
  });
});

describe("BrowserSession prepare", () => {
  it("prepare(null) closes Chrome", async () => {
    const l = fakeLaunch();
    const { s } = session(l.launch);
    await s.chromeFor(cfg())("Profile 14");
    const epoch = s.epoch;
    await s.prepare(null);
    expect(l.chromes[0]!.closes).toBe(1);
    expect(s.chrome).toBeNull();
    expect(s.page).toBeNull();
    expect(s.epoch).toBe(epoch + 1);
  });

  it.each([
    ["the engine", { engine: "chromium" }],
    ["headed", { headed: false }],
    ["profileDirectory", { profileDirectory: "Profile 2" }],
    ["profileDirectory (temporary)", { profileDirectory: null }],
  ] as const)("closes Chrome when %s differs", async (_what, over) => {
    const l = fakeLaunch();
    const { s } = session(l.launch);
    await s.chromeFor(cfg())("Profile 14");
    await s.prepare({ ...KEY, ...over });
    expect(l.chromes[0]!.closes).toBe(1);
    expect(s.chrome).toBeNull();
  });

  it("keeps Chrome and its page when the key is the same", async () => {
    const l = fakeLaunch();
    const { s } = session(l.launch);
    const c = await s.chromeFor(cfg())("Profile 14");
    const page = await s.openPage(c);
    const epoch = s.epoch;
    await s.prepare({ ...KEY });
    expect(l.chromes[0]!.closes).toBe(0);
    expect(s.chrome).toBe(c);
    expect(s.page).toBe(page);
    expect(s.epoch).toBe(epoch);
  });

  it("closes Chrome when client.closed, even with the same key", async () => {
    const l = fakeLaunch();
    const { s } = session(l.launch);
    await s.chromeFor(cfg())("Profile 14");
    dropConnection(l.chromes[0]!);
    await s.prepare(KEY);
    expect(l.chromes[0]!.closes).toBe(1);
    expect(s.chrome).toBeNull();
  });

  it("does nothing when no Chrome is open", async () => {
    const l = fakeLaunch();
    const { s } = session(l.launch);
    await s.prepare(KEY);
    expect(s.chrome).toBeNull();
    expect(s.epoch).toBe(0);
    expect(l.calls).toHaveLength(0);
  });
});

describe("BrowserSession close during a launch", () => {
  it("waits for a launch in flight at most LAUNCH_WAIT_MS", async () => {
    vi.useFakeTimers();
    const h = heldLaunch();
    const { s } = session(h.launch);
    const launching = s.chromeFor(cfg())("Profile 14");
    launching.catch(() => undefined);
    let closed = false;
    const closing = s.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(LAUNCH_WAIT_MS - 1);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(closed).toBe(true);
    expect(s.chrome).toBeNull();

    // The launch completes after the close returned. The session closes that Chrome and does not keep it.
    const late = fakeChrome();
    h.finish(late);
    await expect(launching).rejects.toThrow(/closed while chrome was starting/);
    expect(late.closes).toBe(1);
    expect(s.chrome).toBeNull();
  });

  it("closes a Chrome whose launch completes during the wait, then returns", async () => {
    vi.useFakeTimers();
    const h = heldLaunch();
    const { s } = session(h.launch);
    const launching = s.chromeFor(cfg())(undefined);
    launching.catch(() => undefined);
    let closed = false;
    const closing = s.close().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(closed).toBe(false);
    const c = fakeChrome();
    h.finish(c);
    await vi.advanceTimersByTimeAsync(0);
    await closing;
    expect(closed).toBe(true);
    expect(c.closes).toBe(1);
    expect(s.chrome).toBeNull();
    await expect(launching).rejects.toMatchObject({ name: "ChromeError" });
    // No timer from the wait stays behind.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a later run launches a new Chrome after a cancelled launch", async () => {
    vi.useFakeTimers();
    const h = heldLaunch();
    const { s } = session(h.launch);
    const first = s.chromeFor(cfg())("Profile 14");
    first.catch(() => undefined);
    const closing = s.close();
    await vi.advanceTimersByTimeAsync(LAUNCH_WAIT_MS);
    await closing;
    // A new run starts while the old launch is still in flight. It waits for it, then launches again.
    const second = s.chromeFor(cfg())("Profile 14");
    h.finish(fakeChrome());
    await vi.waitFor(() => { expect(h.calls).toBe(2); });
    const next = fakeChrome();
    h.finish(next);
    expect(await second).toBe(next);
    expect(h.calls).toBe(2);
    expect(s.chrome).toBe(next);
  });
});

describe("BrowserSession pages and current URL", () => {
  it("openPage opens a tab and keeps it as the session page", async () => {
    const l = fakeLaunch();
    const { s, opens } = session(l.launch);
    const c = await s.chromeFor(cfg())("Profile 14");
    const page = await s.openPage(c);
    expect(opens).toHaveLength(1);
    expect(opens[0]!.chrome).toBe(c);
    expect(s.page).toBe(page);
    // A tab on a Chrome that the session no longer holds is not kept.
    const other = fakeChrome();
    await s.openPage(other);
    expect(s.page).toBe(page);
  });

  it("currentUrl returns the page URL", async () => {
    const l = fakeLaunch();
    const { s } = session(l.launch, "https://mail.example.test/inbox");
    await s.openPage(await s.chromeFor(cfg())("Profile 14"));
    expect(await s.currentUrl()).toBe("https://mail.example.test/inbox");
  });

  it("currentUrl gives undefined with no page", async () => {
    const l = fakeLaunch();
    const { s } = session(l.launch);
    expect(await s.currentUrl()).toBeUndefined();
    await s.chromeFor(cfg())("Profile 14");
    expect(await s.currentUrl()).toBeUndefined();
    expect(l.chromes[0]!.closes).toBe(0);
  });

  it.each(["about:blank", "", "  about:blank  "])("currentUrl gives undefined for %j", async (url) => {
    const l = fakeLaunch();
    const { s } = session(l.launch, url);
    await s.openPage(await s.chromeFor(cfg())("Profile 14"));
    expect(await s.currentUrl()).toBeUndefined();
    expect(s.page).not.toBeNull();
  });

  it("currentUrl drops a dead tab and keeps Chrome", async () => {
    const l = fakeLaunch();
    const { s } = session(l.launch);
    const c = await s.chromeFor(cfg())("Profile 14");
    const page = await s.openPage(c);
    page.url = async () => { throw new Error("No target with given id found"); };
    const epoch = s.epoch;
    expect(await s.currentUrl()).toBeUndefined();
    expect(s.page).toBeNull();
    expect(s.chrome).toBe(c);
    expect(s.epoch).toBe(epoch);
    expect(l.chromes[0]!.closes).toBe(0);
  });

  it("currentUrl closes the session on client.closed", async () => {
    const l = fakeLaunch();
    const { s } = session(l.launch);
    await s.openPage(await s.chromeFor(cfg())("Profile 14"));
    const epoch = s.epoch;
    dropConnection(l.chromes[0]!);
    expect(await s.currentUrl()).toBeUndefined();
    expect(l.chromes[0]!.closes).toBe(1);
    expect(s.chrome).toBeNull();
    expect(s.page).toBeNull();
    expect(s.epoch).toBe(epoch + 1);
  });
});

describe("BrowserSession keep and close", () => {
  it("keep stores the runner page for the current epoch and ignores a page from an older epoch", async () => {
    const l = fakeLaunch();
    const { s } = session(l.launch);
    await s.chromeFor(cfg())("Profile 14");
    const runnerPage: Page = tab("https://a.test/");
    s.keep(runnerPage, s.epoch);
    expect(s.page).toBe(runnerPage);
    // keep(null) leaves the session page as it is.
    s.keep(null, s.epoch);
    expect(s.page).toBe(runnerPage);

    // A close during the run: the page of that run belongs to the closed Chrome.
    const epoch = s.epoch;
    await s.close();
    await s.chromeFor(cfg())("Profile 14");
    s.keep(tab("https://old.test/"), epoch);
    expect(s.page).toBeNull();
  });

  it("close is idempotent and increments epoch", async () => {
    const l = fakeLaunch();
    const { s } = session(l.launch);
    const c = await s.chromeFor(cfg())("Profile 14");
    await s.openPage(c);
    expect(s.epoch).toBe(0);
    await s.close();
    expect(s.epoch).toBe(1);
    expect(s.chrome).toBeNull();
    expect(s.page).toBeNull();
    await s.close();
    expect(s.epoch).toBe(2);
    expect(l.chromes[0]!.closes).toBe(1);
  });

  it("a close that is in flight makes prepare and chromeFor wait, so a launch never meets the old profile lock", async () => {
    // The idle timer does not wait for its close. The profile lock is free only when the old Chrome has exited.
    let locked = false;
    const launches: FakeChrome[] = [];
    const { s } = session(async () => {
      if (locked) { const e = new Error("profile is locked"); e.name = "ChromeError"; throw e; }
      locked = true;
      const c = fakeChrome();
      c.close = async () => { dropConnection(c); c.closes += 1; await new Promise((r) => setTimeout(r, 30)); locked = false; };
      launches.push(c);
      return c;
    });
    await s.chromeFor(cfg())("Profile 14");
    const idle = s.close();
    expect(s.close()).toBe(idle);
    await s.prepare(KEY);
    const next = await s.chromeFor(cfg())("Profile 14");
    expect(launches).toHaveLength(2);
    expect(next).toBe(launches[1]);
    expect(launches[0]!.closes).toBe(1);
    // A chromeFor without a prepare waits too.
    void s.close();
    const third = await s.chromeFor(cfg())("Profile 14");
    expect(launches).toHaveLength(3);
    expect(third).toBe(launches[2]);
  });

  it("keeps the unsent text of the kept page; a close, a new tab, or a dead tab clears it; a keep from an older epoch is ignored", async () => {
    const l = fakeLaunch();
    const { s } = session(l.launch);
    const c = await s.chromeFor(cfg())("Profile 14");
    const page = await s.openPage(c);
    const entry = { doc: 1.5, node: 4, label: "Reply", text: "Tuesday works.", request: null };
    s.keep(page, s.epoch, [entry]);
    expect(s.unsent).toEqual([entry]);
    s.keep(null, s.epoch, []);
    expect(s.unsent).toEqual([entry]);
    s.keep(page, s.epoch - 1, []);
    expect(s.unsent).toEqual([entry]);
    await s.openPage(c);
    expect(s.unsent).toEqual([]);
    s.keep(page, s.epoch, [entry]);
    page.url = async () => { throw new Error("No target with given id found"); };
    await s.currentUrl();
    expect(s.unsent).toEqual([]);
    s.keep(page, s.epoch, [entry]);
    await s.close();
    expect(s.unsent).toEqual([]);
  });

  it("close ignores an error from Chrome", async () => {
    const c = fakeChrome();
    c.close = async () => { throw new Error("gone"); };
    const { s } = session(async () => c);
    await s.chromeFor(cfg())("Profile 14");
    await expect(s.close()).resolves.toBeUndefined();
    expect(s.chrome).toBeNull();
  });
});
