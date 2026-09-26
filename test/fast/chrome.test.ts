import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COPY_MARKER, acquireProfileLock, attachTarget, defaultUserDataDir, findChrome, listProfiles, plainUserAgent, profileCopyDir, syncProfile, userAgentMetadata } from "../../src/fast/chrome.js";
import type { CdpClient } from "../../src/fast/model.js";
import { fakeLogger } from "../fakes.js";

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("findChrome", () => {
  it("takes JEV_CHROME_BIN first", () => {
    expect(findChrome({ JEV_CHROME_BIN: "/opt/my-chrome" }, { exists: () => false })).toBe("/opt/my-chrome");
  });
  it("finds the darwin app bundle", () => {
    const bin = findChrome({}, { platform: "darwin", exists: (p) => p.includes("Google Chrome.app") });
    expect(bin).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });
  it("looks up linux names on PATH", () => {
    const bin = findChrome({ PATH: "/nowhere:/usr/bin" }, { platform: "linux", exists: (p) => p === "/usr/bin/chromium" });
    expect(bin).toBe("/usr/bin/chromium");
  });
  it("throws a chrome not found message when none exists", () => {
    expect(() => findChrome({ PATH: "" }, { platform: "linux", exists: () => false })).toThrow(/^chrome not found/);
  });
});

describe("defaultUserDataDir", () => {
  it("follows the platform", () => {
    expect(defaultUserDataDir({ HOME: "/h" }, "darwin")).toBe("/h/Library/Application Support/Google/Chrome");
    expect(defaultUserDataDir({ HOME: "/h" }, "linux")).toBe("/h/.config/google-chrome");
    expect(defaultUserDataDir({ LOCALAPPDATA: "/l" }, "win32")).toBe(path.join("/l", "Google", "Chrome", "User Data"));
  });
});

describe("listProfiles", () => {
  it("reads profile.info_cache from Local State", () => {
    const udd = tmp("jev-udd-");
    fs.writeFileSync(path.join(udd, "Local State"), JSON.stringify({
      profile: { info_cache: { Default: { name: "Person 1" }, "Profile 14": { name: "Parallelloop" } } },
    }));
    expect(listProfiles(udd)).toEqual([{ directory: "Default", name: "Person 1" }, { directory: "Profile 14", name: "Parallelloop" }]);
  });
  it("returns an empty list when the file is missing or malformed", () => {
    const udd = tmp("jev-udd-");
    expect(listProfiles(udd)).toEqual([]);
    fs.writeFileSync(path.join(udd, "Local State"), "{not json");
    expect(listProfiles(udd)).toEqual([]);
    fs.writeFileSync(path.join(udd, "Local State"), JSON.stringify({ profile: {} }));
    expect(listProfiles(udd)).toEqual([]);
  });
});

describe("profileCopyDir", () => {
  it("slugs the profile directory under XDG_CONFIG_HOME", () => {
    expect(profileCopyDir({ XDG_CONFIG_HOME: "/x" }, "Profile 14")).toBe(path.join("/x", "jev-browser", "chrome", "profile-14"));
    expect(profileCopyDir({ HOME: "/h" }, "Default")).toBe(path.join("/h", ".config", "jev-browser", "chrome", "default"));
    expect(profileCopyDir({ HOME: "/h" }, "  Weird__Name!! ")).toBe(path.join("/h", ".config", "jev-browser", "chrome", "weird-name"));
  });
});

describe("syncProfile", () => {
  function fakeSource(): string {
    const src = tmp("jev-src-");
    const prof = path.join(src, "Profile 14");
    fs.mkdirSync(path.join(prof, "Cache"), { recursive: true });
    fs.mkdirSync(path.join(prof, "Service Worker", "CacheStorage"), { recursive: true });
    fs.mkdirSync(path.join(prof, "Network"), { recursive: true });
    fs.mkdirSync(path.join(prof, "Local Storage", "leveldb"), { recursive: true });
    fs.writeFileSync(path.join(src, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 14": { name: "P" } } } }));
    fs.writeFileSync(path.join(prof, "Cache", "data_0"), "cache");
    fs.writeFileSync(path.join(prof, "Service Worker", "CacheStorage", "x"), "sw");
    fs.writeFileSync(path.join(prof, "Network", "Cookies"), "cookies");
    fs.writeFileSync(path.join(prof, "Cookies"), "cookies-legacy");
    fs.writeFileSync(path.join(prof, "Local Storage", "leveldb", "000001.ldb"), "ls");
    fs.writeFileSync(path.join(prof, "Local Storage", "leveldb", "LOG"), "nested log stays");
    fs.writeFileSync(path.join(prof, "History"), "history");
    fs.writeFileSync(path.join(prof, "chrome_debug.log"), "log");
    fs.writeFileSync(path.join(prof, "Preferences"), JSON.stringify({ profile: { exit_type: "Crashed", exited_cleanly: false, name: "P" }, other: 1 }));
    return src;
  }

  it("copies cookies and storage, skips caches and history, and rewrites Preferences", async () => {
    const src = fakeSource();
    const dest = path.join(tmp("jev-dest-"), "profile-14");
    fs.mkdirSync(dest, { recursive: true });
    const log = fakeLogger();
    const r = await syncProfile({ sourceUserDataDir: src, profileDirectory: "Profile 14", dest, refresh: false, log });
    expect(r.copied).toBe(true);
    expect(r.files).toBe(6); // Local State, Network/Cookies, Cookies, 000001.ldb, nested LOG, Preferences
    expect(r.ms).toBeGreaterThanOrEqual(0);
    const d = path.join(dest, "Default");
    expect(fs.readFileSync(path.join(dest, "Local State"), "utf8")).toContain("Profile 14");
    expect(fs.readFileSync(path.join(d, "Network", "Cookies"), "utf8")).toBe("cookies");
    expect(fs.readFileSync(path.join(d, "Cookies"), "utf8")).toBe("cookies-legacy");
    expect(fs.existsSync(path.join(d, "Local Storage", "leveldb", "000001.ldb"))).toBe(true);
    expect(fs.existsSync(path.join(d, "Local Storage", "leveldb", "LOG"))).toBe(true);
    expect(fs.existsSync(path.join(d, "Cache"))).toBe(false);
    expect(fs.existsSync(path.join(d, "Service Worker"))).toBe(false);
    expect(fs.existsSync(path.join(d, "History"))).toBe(false);
    expect(fs.existsSync(path.join(d, "chrome_debug.log"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "SingletonLock"))).toBe(false);
    const prefs = JSON.parse(fs.readFileSync(path.join(d, "Preferences"), "utf8")) as { profile: Record<string, unknown>; other: number };
    expect(prefs.profile["exit_type"]).toBe("Normal");
    expect(prefs.profile["exited_cleanly"]).toBe(true);
    expect(prefs.profile["name"]).toBe("P");
    expect(prefs.other).toBe(1);
  });

  it("blocks concurrent copy and refresh, preserving locks and profile data", async () => {
    const src = fakeSource();
    const dest = path.join(tmp("jev-exclusive-"), "profile-14");
    const opts = { sourceUserDataDir: src, profileDirectory: "Profile 14", dest, refresh: false, log: fakeLogger() };
    await syncProfile(opts);
    const release = acquireProfileLock(dest);
    const before = fs.readFileSync(`${dest}.jev-lock`, "utf8");
    try {
      expect(() => acquireProfileLock(dest)).toThrow(/profile is locked/);
      await expect(syncProfile(opts)).rejects.toThrow(/profile is locked/);
      await expect(syncProfile({ ...opts, refresh: true })).rejects.toThrow(/profile is locked/);
      expect(fs.readFileSync(`${dest}.jev-lock`, "utf8")).toBe(before);
      expect(fs.readFileSync(path.join(dest, "Default", "Cookies"), "utf8")).toBe("cookies-legacy");
    } finally { release(); release(); }
    expect((await syncProfile({ ...opts, refresh: true })).copied).toBe(true);
  });

  it("preserves a Chrome singleton lock, including a dangling symlink", async () => {
    const src = fakeSource();
    const dest = path.join(tmp("jev-singleton-"), "profile-14");
    const opts = { sourceUserDataDir: src, profileDirectory: "Profile 14", dest, refresh: false, log: fakeLogger() };
    await syncProfile(opts);
    const lock = path.join(dest, "SingletonLock");
    fs.symlinkSync(`host-${process.pid}`, lock);
    for (const refresh of [false, true]) await expect(syncProfile({ ...opts, refresh })).rejects.toThrow(/Chrome lock exists/);
    expect(fs.readlinkSync(lock)).toBe(`host-${process.pid}`);
    expect(fs.existsSync(`${dest}.jev-lock`)).toBe(false);
  });

  it("reuses an existing copy and recopies on refresh", async () => {
    const src = fakeSource();
    const dest = path.join(tmp("jev-dest-"), "profile-14");
    const log = fakeLogger();
    await syncProfile({ sourceUserDataDir: src, profileDirectory: "Profile 14", dest, refresh: false, log });
    fs.writeFileSync(path.join(dest, "Default", "Cookies"), "changed by chrome");
    const again = await syncProfile({ sourceUserDataDir: src, profileDirectory: "Profile 14", dest, refresh: false, log });
    expect(again.copied).toBe(false);
    expect(again.files).toBe(0);
    expect(fs.readFileSync(path.join(dest, "Default", "Cookies"), "utf8")).toBe("changed by chrome");
    const fresh = await syncProfile({ sourceUserDataDir: src, profileDirectory: "Profile 14", dest, refresh: true, log });
    expect(fresh.copied).toBe(true);
    expect(fs.readFileSync(path.join(dest, "Default", "Cookies"), "utf8")).toBe("cookies-legacy");
  });

  it("writes the marker last, copies through a staging dir, and copies again when the marker is missing", async () => {
    const src = fakeSource();
    const dest = path.join(tmp("jev-dest-"), "profile-14");
    const log = fakeLogger();
    await syncProfile({ sourceUserDataDir: src, profileDirectory: "Profile 14", dest, refresh: false, log });
    const marker = JSON.parse(fs.readFileSync(path.join(dest, COPY_MARKER), "utf8")) as { files: number; profileDirectory: string };
    expect(marker).toMatchObject({ files: 6, profileDirectory: "Profile 14" });
    expect(fs.readdirSync(path.dirname(dest)).filter((n) => n.includes(".tmp-"))).toEqual([]);
    // A copy that ended early: Preferences exists, the marker does not. It is not reused.
    fs.rmSync(path.join(dest, COPY_MARKER));
    fs.rmSync(path.join(dest, "Default", "Cookies"));
    fs.mkdirSync(`${dest}.tmp-999`, { recursive: true });
    const again = await syncProfile({ sourceUserDataDir: src, profileDirectory: "Profile 14", dest, refresh: false, log });
    expect(again.copied).toBe(true);
    expect(fs.existsSync(path.join(dest, "Default", "Cookies"))).toBe(true);
    expect(fs.existsSync(path.join(dest, COPY_MARKER))).toBe(true);
    expect(fs.existsSync(`${dest}.tmp-999`)).toBe(false);
    expect(log.lines.some((l) => l.startsWith("WARN") && l.includes("no jev-copy.json"))).toBe(true);
  });

  it("copies a database and its -journal side by side and warns when a file changed size during the copy", async () => {
    const src = fakeSource();
    const prof = path.join(src, "Profile 14");
    fs.writeFileSync(path.join(prof, "Cookies-journal"), "journal");
    fs.writeFileSync(path.join(prof, "Web Data"), "wd");
    const dest = path.join(tmp("jev-dest-"), "profile-14");
    const log = fakeLogger();
    const realCopy = fs.copyFileSync;
    const spy = vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, mode) => {
      realCopy(from, to, mode);
      if (String(from).endsWith("Web Data")) fs.appendFileSync(String(from), "grew while copying");
    });
    try {
      const r = await syncProfile({ sourceUserDataDir: src, profileDirectory: "Profile 14", dest, refresh: false, log });
      expect(r.copied).toBe(true);
      const copied = spy.mock.calls.map((c) => path.basename(String(c[0])));
      expect(copied.indexOf("Cookies-journal")).toBe(copied.indexOf("Cookies") + 1);
      expect(fs.readFileSync(path.join(dest, "Default", "Cookies-journal"), "utf8")).toBe("journal");
      expect(log.lines.some((l) => l.startsWith("WARN") && l.includes("Web Data") && l.includes("changed size"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("skips a file it cannot read and continues", async () => {
    const src = fakeSource();
    const prof = path.join(src, "Profile 14");
    fs.writeFileSync(path.join(prof, "Login Data"), "secret", { mode: 0o000 });
    const dest = path.join(tmp("jev-dest-"), "profile-14");
    const log = fakeLogger();
    const r = await syncProfile({ sourceUserDataDir: src, profileDirectory: "Profile 14", dest, refresh: false, log });
    fs.chmodSync(path.join(prof, "Login Data"), 0o600);
    expect(r.copied).toBe(true);
    expect(fs.existsSync(path.join(dest, "Default", "Cookies"))).toBe(true);
    expect(log.lines.some((l) => l.includes("skipped") && l.includes("Login Data"))).toBe(true);
  });
});

describe("attachTarget", () => {
  function client() {
    const sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
    const c: CdpClient = {
      closed: false,
      async send(method, params, sessionId) {
        sent.push({ method, params: params ?? {}, ...(sessionId !== undefined ? { sessionId } : {}) });
        if (method === "Target.createTarget") return { targetId: "T" };
        if (method === "Target.attachToTarget") return { sessionId: "S" };
        return {};
      },
      on() { return () => undefined; },
      async close() { /* nothing */ },
    };
    return { c, sent };
  }
  it("attached: the tab opens in the background and keeps the window's viewport", async () => {
    const { c, sent } = client();
    const t = await attachTarget(c, "about:blank", { headed: false, attached: true });
    expect(t).toEqual({ targetId: "T", sessionId: "S" });
    expect(sent[0]).toEqual({ method: "Target.createTarget", params: { url: "about:blank", newWindow: false, background: true } });
    expect(sent.map((s) => s.method)).not.toContain("Emulation.setDeviceMetricsOverride");
    expect(sent.filter((s) => s.sessionId === "S").map((s) => s.method)).toEqual(["Page.enable", "Emulation.setFocusEmulationEnabled"]);
  });
  it("a headless user agent goes out without HeadlessChrome; a headed one keeps Chrome's own", async () => {
    const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.8037.57 Safari/537.36";
    expect(plainUserAgent(ua)).toBe(ua.replace("HeadlessChrome", "Chrome"));
    expect(plainUserAgent(ua.replace("HeadlessChrome", "Chrome"))).toBeNull();
    expect(plainUserAgent(undefined)).toBeNull();
    const { c, sent } = client();
    await attachTarget(c, "about:blank", { headed: false, attached: false, userAgent: "UA" });
    expect(sent.find((s) => s.method === "Emulation.setUserAgentOverride")?.params).toEqual({ userAgent: "UA" });
    const meta = userAgentMetadata("HeadlessChrome/154.0.8037.57", false, "darwin", "arm64");
    const withHints = client();
    await attachTarget(withHints.c, "about:blank", { headed: false, attached: false, userAgent: "UA", ...(meta ? { userAgentMetadata: meta } : {}) });
    expect(withHints.sent.find((s) => s.method === "Emulation.setUserAgentOverride")?.params).toEqual({ userAgent: "UA", userAgentMetadata: meta });
    const plain = client();
    await attachTarget(plain.c, "about:blank", { headed: false, attached: false });
    expect(plain.sent.map((s) => s.method)).not.toContain("Emulation.setUserAgentOverride");
  });
  it("the client hints of the override follow Chrome's own brand list: Chrome 154 on macOS sends Chromium, Google Chrome, Not A(Brand", () => {
    // Headless Chrome 154 with no override sent sec-ch-ua: "Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99".
    expect(userAgentMetadata("HeadlessChrome/154.0.8037.57", false, "darwin", "arm64")).toEqual({
      brands: [{ brand: "Chromium", version: "154" }, { brand: "Google Chrome", version: "154" }, { brand: "Not A(Brand", version: "99" }],
      fullVersionList: [{ brand: "Chromium", version: "154.0.8037.57" }, { brand: "Google Chrome", version: "154.0.8037.57" }, { brand: "Not A(Brand", version: "99.0.0.0" }],
      platform: "macOS", platformVersion: "", architecture: "arm", model: "", mobile: false, bitness: "64", wow64: false, formFactors: ["Desktop"],
    });
    expect(userAgentMetadata("HeadlessChrome/154.0.8037.57", false, "darwin", "arm64", "26.6.2")?.platformVersion).toBe("26.6.2");
    // Another seed: another GREASE brand, version, and order. Chromium has no "Google Chrome".
    const m = userAgentMetadata("HeadlessChrome/155.0.1.2", true, "linux", "x64");
    expect(m?.brands).toEqual([{ brand: "Chromium", version: "155" }, { brand: "Not(A:Brand", version: "24" }]);
    expect(m).toMatchObject({ platform: "Linux", architecture: "x86", bitness: "64" });
    expect(userAgentMetadata("HeadlessChrome", false)).toBeNull();
    expect(userAgentMetadata(undefined, false)).toBeNull();
  });
  it("launched headless: foreground tab with the fixed viewport; headed: no viewport override", async () => {
    const { c, sent } = client();
    await attachTarget(c, "about:blank", { headed: false, attached: false });
    expect(sent[0]?.params).toEqual({ url: "about:blank", newWindow: false });
    expect(sent.find((s) => s.method === "Emulation.setDeviceMetricsOverride")?.params).toEqual({ width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    const headed = client();
    await attachTarget(headed.c, "about:blank", { headed: true, attached: false });
    expect(headed.sent.map((s) => s.method)).not.toContain("Emulation.setDeviceMetricsOverride");
  });
});


describe("Chromium engine discovery and profiles", () => {
  it("uses its own binary override and does not fall back to Google Chrome", () => {
    expect(findChrome({ JEV_CHROMIUM_BIN: "/custom/chromium", JEV_CHROME_BIN: "/custom/chrome" }, { browser: "chromium" })).toBe("/custom/chromium");
    expect(() => findChrome({ JEV_CHROME_BIN: "/custom/chrome", PATH: "/usr/bin" }, { browser: "chromium", platform: "linux", exists: (p) => p.endsWith("google-chrome") })).toThrow(/chromium not found/);
  });
  it.each([
    ["darwin", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
    ["linux", "/usr/bin/chromium-browser"],
    ["win32", path.join("/local", "Chromium", "Application", "chrome.exe")],
  ] as const)("finds Chromium on %s", (platform, binary) => {
    expect(findChrome({ PATH: "/usr/bin", LOCALAPPDATA: "/local" }, { browser: "chromium", platform, exists: (p) => p === binary })).toBe(binary);
  });
  it("keeps source profiles and persistent copies separate from Chrome", () => {
    const env = { HOME: "/home/test", LOCALAPPDATA: "/local", XDG_CONFIG_HOME: "/config" };
    expect(defaultUserDataDir(env, "darwin", "chromium")).toBe("/home/test/Library/Application Support/Chromium");
    expect(defaultUserDataDir(env, "linux", "chromium")).toBe("/config/chromium");
    expect(defaultUserDataDir(env, "win32", "chromium")).toBe(path.join("/local", "Chromium", "User Data"));
    expect(profileCopyDir(env, "Default", "chromium")).toBe("/config/jev-browser/chromium/default");
    expect(profileCopyDir(env, "Default", "chromium")).not.toBe(profileCopyDir(env, "Default"));
  });
});
