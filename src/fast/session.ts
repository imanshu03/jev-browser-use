// One Chrome and one tab that stay open between runs. Pure I/O. No decisions.
//
// Ported from the chat lifecycle in src/chat.ts (chromeFor, closeChrome, currentUrl). Chat keeps its own copy for now.
import type { Logger } from "../io.js";
import type { RunConfig } from "../types.js";
import { LIMITS } from "../types.js";
import { LAUNCH_WAIT_MS, browserOf, launchChrome } from "./chrome.js";
import type { BrowserKind } from "./chrome.js";
import type { Chrome, ChromeLaunchOptions, GeoPoint, Page, UnsentText } from "./model.js";
import { openPage as openTab } from "./page.js";

/**
 * What an open Chrome was launched with. `geo`: the geolocation override of its tabs; absent and null both mean none. A
 * run with another geo needs another Chrome: each tab gets the override when it opens.
 */
/** `browser` is null when no browser is installed; the launch then reports that. */
export interface SessionKey { browser: BrowserKind | null; headed: boolean; profileDirectory: string | null; geo?: GeoPoint | null }  // null = temporary profile

/** The open Chrome runs on another profile, browser, or window mode than the run asks for. The session never reuses it silently. */
export class ProfileMismatchError extends Error {
  override name = "ProfileMismatchError";
}

export interface SessionOptions {
  env: NodeJS.ProcessEnv; log: Logger;
  launch?: (o: ChromeLaunchOptions) => Promise<Chrome>;  // default launchChrome
  open?: (c: Chrome, log: Logger) => Promise<Page>;      // default openPage(c, { settleTimeoutMs: LIMITS.settleDomMs, log })
}

/** Two geolocation overrides are the same: both none (absent or null), or the same point and accuracy (absent = 50 m). */
function sameGeo(a: GeoPoint | null | undefined, b: GeoPoint | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.latitude === b.latitude && a.longitude === b.longitude && (a.accuracy ?? 50) === (b.accuracy ?? 50);
}

function sameKey(a: SessionKey, b: SessionKey): boolean {
  return a.browser === b.browser && a.headed === b.headed && a.profileDirectory === b.profileDirectory && sameGeo(a.geo, b.geo);
}

function describeKey(k: SessionKey): string {
  const geo = k.geo ? `, geo ${k.geo.latitude},${k.geo.longitude}${k.geo.accuracy !== undefined ? ` accuracy ${k.geo.accuracy} m` : ""}` : "";
  return `${k.profileDirectory === null ? "a temporary profile" : `profile ${k.profileDirectory}`} (${k.browser ?? "no browser"}, ${k.headed ? "headed" : "headless"}${geo})`;
}

/** Resolve when `p` settles or after `ms`, whichever comes first. The timer is cleared when `p` settles first. */
function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void p.then(() => undefined, () => undefined).then(() => { clearTimeout(timer); resolve(); });
  });
}

export class BrowserSession {
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: Logger;
  private readonly launch: (o: ChromeLaunchOptions) => Promise<Chrome>;
  private readonly open: (c: Chrome, log: Logger) => Promise<Page>;
  private _chrome: Chrome | null = null;
  private _page: Page | null = null;
  private _epoch = 0;
  /** The key of the open Chrome. Set when the launch completes. */
  private key: SessionKey | null = null;
  /** A launch in flight. close waits for it, so a stop during the launch still removes a temporary profile. */
  private launching: Promise<Chrome> | null = null;
  /** A close in flight. A later close returns it, and prepare and chromeFor wait for it before they look at Chrome. */
  private closing: Promise<void> | null = null;
  /** Unsent assistant text on the session page, from the run that used it last. */
  private _unsent: UnsentText[] = [];
  /** `<doc>` -> mention chips that runs added on the session page. */
  private _chips: [string, string[]][] = [];

  constructor(opts: SessionOptions) {
    this.env = opts.env;
    this.log = opts.log;
    this.launch = opts.launch ?? launchChrome;
    this.open = opts.open ?? ((c, l) => openTab(c, { settleTimeoutMs: LIMITS.settleDomMs, log: l }));
  }

  get chrome(): Chrome | null { return this._chrome; }
  get page(): Page | null { return this._page; }
  /** +1 on every close. A page from a run that started before a close belongs to a closed Chrome. */
  get epoch(): number { return this._epoch; }
  /** Unsent assistant text on the session page. The next run on the page gets it, so its gate applies there too. */
  get unsent(): UnsentText[] { return this._unsent.map((u) => ({ ...u })); }
  /** Mention chips that earlier runs added on the session page. The next run's unasked-chip gate covers them too. */
  get chips(): [string, string[]][] { return this._chips.map(([d, n]) => [d, [...n]]); }

  /** null: the plan decides the profile, so close any open Chrome. Otherwise close when the key differs from the open key or client.closed. */
  async prepare(key: SessionKey | null): Promise<void> {
    // The idle timer does not wait for its close. A profile copy is free only when that close ended.
    if (this.closing) await this.closing;
    if (key === null) { await this.close(); return; }
    if (this.launching) { await this.close(); return; }
    const c = this._chrome;
    if (!c) return;
    if (c.client.closed) {
      this.log.warn("chrome connection is closed; the next task launches a new one");
      await this.close();
      return;
    }
    if (this.key === null || !sameKey(this.key, key)) {
      this.log.info(`chrome is open with ${this.key ? describeKey(this.key) : "an unknown profile"}; closing it for ${describeKey(key)}`);
      await this.close();
    }
  }

  /**
   * Reuse the open Chrome when its key matches; relaunch after client.closed; throw ProfileMismatchError when the
   * directory, browser, window mode, or geolocation differs.
   */
  chromeFor(cfg: RunConfig): (profileDirectory: string | undefined) => Promise<Chrome> {
    return async (profileDirectory) => {
      const want: SessionKey = { browser: browserOf(cfg, this.env) ?? null, headed: cfg.headed, profileDirectory: profileDirectory ? profileDirectory : null, geo: cfg.geo ?? null };
      // Never two launches at once, and never a launch while a close is in flight: the profile lock is free only
      // when the old Chrome has exited. A launch that a close cancelled rejects; the checks below then see no Chrome.
      if (this.closing) await this.closing;
      if (this.launching) await this.launching.catch(() => undefined);
      if (this.closing) await this.closing;
      // The user can quit the window between tasks. A Chrome whose connection is gone is closed, then launched again.
      if (this._chrome && this._chrome.client.closed) {
        this.log.warn("chrome connection is closed; launching a new one");
        await this.close();
      }
      if (this._chrome) {
        const open = this.key;
        if (open !== null && sameKey(open, want)) return this._chrome;
        throw new ProfileMismatchError(`chrome is open with ${open ? describeKey(open) : "an unknown profile"}; the task needs ${describeKey(want)}. Close the browser, then run the task again`);
      }
      return this.launchFor(cfg, want);
    };
  }

  /** Opens a tab and keeps it as the session page. */
  async openPage(chrome: Chrome): Promise<Page> {
    const page = await this.open(chrome, this.log);
    // A close during the open leaves another Chrome, or none, in the session. The page is then not kept.
    if (chrome === this._chrome) { this._page = page; this._unsent = []; this._chips = []; }
    return page;
  }

  /** Keeps runner.page and its unsent text only when no close happened since `epoch`. keep(null) changes nothing. */
  keep(page: Page | null, epoch: number, unsent: readonly UnsentText[] = [], chips: readonly (readonly [string, readonly string[]])[] = []): void {
    if (page && epoch === this._epoch && this._chrome) {
      this._page = page;
      this._unsent = unsent.map((u) => ({ ...u }));
      this._chips = chips.map(([d, n]) => [d, [...n]]);
    }
  }

  /** The URL of the session page. undefined for no page, "", and about:blank. Closes on client.closed; drops a dead tab. */
  async currentUrl(): Promise<string | undefined> {
    if (this._chrome?.client.closed) { await this.close(); return undefined; }
    const page = this._page;
    if (!page) return undefined;
    let url: string;
    try { url = await page.url(); } catch {
      if (this._page === page) { this._page = null; this._unsent = []; this._chips = []; }
      return undefined;
    }
    const t = url.trim();
    return t === "" || t === "about:blank" ? undefined : url;
  }

  /**
   * Close the tab and Chrome. Idempotent. Waits at most LAUNCH_WAIT_MS for a launch in flight. A close while
   * another close is in flight returns that close.
   */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    // First and synchronous: a keep() from a run that started before this close is ignored, and a launch that
    // completes after this point closes its own Chrome.
    this._epoch += 1;
    this._page = null;
    this._unsent = []; this._chips = [];
    const p: Promise<void> = this.shut().finally(() => { if (this.closing === p) this.closing = null; });
    this.closing = p;
    return p;
  }

  private async shut(): Promise<void> {
    if (this.launching) await settleWithin(this.launching, LAUNCH_WAIT_MS);
    const c = this._chrome;
    this._chrome = null;
    this._page = null;
    this._unsent = []; this._chips = [];
    this.key = null;
    if (!c) return;
    await c.close().catch(() => undefined);
  }

  private async launchFor(cfg: RunConfig, want: SessionKey): Promise<Chrome> {
    const epoch = this._epoch;
    const dir = want.profileDirectory;
    const p = this.launch({
      ...(want.browser ? { browser: want.browser } : {}),
      headed: cfg.headed, ...(dir !== null ? { profileDirectory: dir } : {}), ...(cfg.refreshProfile ? { refreshProfile: true } : {}),
      ...(cfg.cdp !== undefined ? { cdpPort: cfg.cdp } : {}), ...(cfg.chromeBin ? { chromeBin: cfg.chromeBin } : {}),
      ...(want.geo ? { geolocation: want.geo } : {}),
      commandTimeoutMs: cfg.stepTimeoutMs, env: this.env, log: this.log,
    }).then(async (c) => {
      if (this._epoch !== epoch) {
        // A close ran while Chrome started. Nothing else owns this Chrome, so close it here.
        await c.close().catch(() => undefined);
        const e = new Error("the browser session closed while chrome was starting");
        e.name = "ChromeError";
        throw e;
      }
      this._chrome = c;
      this.key = want;
      return c;
    });
    this.launching = p;
    try { return await p; } finally { if (this.launching === p) this.launching = null; }
  }
}
