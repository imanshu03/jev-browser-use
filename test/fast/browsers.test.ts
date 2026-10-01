import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli.js";
import { browserOf, defaultUserDataDir, detectBrowser, findChrome, launchChrome, profileCopyDir, userAgentMetadata } from "../../src/fast/chrome.js";
import { browserChoice, checkInput, configFor } from "../../src/mcp/setup.js";
import { envBrowser, navBase } from "../../src/scrape/launch.js";
import { UsageError } from "../../src/plan.js";
import { fakeLogger } from "../fakes.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const EDGE_MAC = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
const BRAVE_MAC = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

describe("Edge and Brave discovery", () => {
  it.each([
    ["edge", "darwin", EDGE_MAC],
    ["edge", "linux", "/usr/bin/microsoft-edge-stable"],
    ["edge", "win32", path.join("/pf86", "Microsoft", "Edge", "Application", "msedge.exe")],
    ["brave", "darwin", BRAVE_MAC],
    ["brave", "linux", "/usr/bin/brave-browser"],
    ["brave", "win32", path.join("/local", "BraveSoftware", "Brave-Browser", "Application", "brave.exe")],
  ] as const)("finds %s on %s", (browser, platform, binary) => {
    const env = { PATH: "/usr/bin", "PROGRAMFILES(X86)": "/pf86", LOCALAPPDATA: "/local", HOME: "/h" };
    expect(findChrome(env, { browser, platform, exists: (p) => p === binary })).toBe(binary);
  });
  it("finds an app in ~/Applications on macOS", () => {
    const bin = "/h/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
    expect(findChrome({ HOME: "/h" }, { browser: "brave", platform: "darwin", exists: (p) => p === bin })).toBe(bin);
  });
  it("a named browser uses only its own override and never another browser", () => {
    expect(findChrome({ JEV_EDGE_BIN: "/x/edge", JEV_CHROME_BIN: "/x/chrome" }, { browser: "edge" })).toBe("/x/edge");
    expect(() => findChrome({ JEV_CHROME_BIN: "/x/chrome", HOME: "/h" }, { browser: "brave", platform: "darwin", exists: (p) => p.includes("Google Chrome") })).toThrow(/^brave not found: install Brave, or set JEV_BRAVE_BIN/);
  });
});

describe("detectBrowser and browserOf", () => {
  it("picks Chrome, then Edge, then Brave, then Chromium", () => {
    const has = (...bins: string[]) => (p: string) => bins.includes(p);
    expect(detectBrowser({ HOME: "/h" }, { platform: "darwin", exists: has(EDGE_MAC, BRAVE_MAC, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") })).toBe("chrome");
    expect(detectBrowser({ HOME: "/h" }, { platform: "darwin", exists: has(EDGE_MAC, BRAVE_MAC) })).toBe("edge");
    expect(detectBrowser({ HOME: "/h" }, { platform: "darwin", exists: has(BRAVE_MAC, "/Applications/Chromium.app/Contents/MacOS/Chromium") })).toBe("brave");
    expect(detectBrowser({ PATH: "/usr/bin" }, { platform: "linux", exists: has("/usr/bin/chromium") })).toBe("chromium");
    expect(detectBrowser({ HOME: "/h" }, { platform: "darwin", exists: () => false })).toBeNull();
  });
  it("a binary override in the environment comes before an installed browser", () => {
    expect(detectBrowser({ HOME: "/h", JEV_BRAVE_BIN: "/x/brave" }, { platform: "darwin", exists: (p) => p.includes("Google Chrome.app") })).toBe("brave");
  });
  it("--browser wins, engine chromium means Chromium, else the browser found", () => {
    const exists = (p: string) => p === EDGE_MAC;
    expect(browserOf({ engine: "chromium", browser: "brave" }, {}, { platform: "darwin", exists })).toBe("brave");
    expect(browserOf({ engine: "chromium" }, {}, { platform: "darwin", exists })).toBe("chromium");
    expect(browserOf({ engine: "cdp" }, { HOME: "/h" }, { platform: "darwin", exists })).toBe("edge");
    expect(browserOf({}, { HOME: "/h" }, { platform: "darwin", exists: () => false })).toBeUndefined();
  });
});

describe("Edge and Brave profiles", () => {
  it("reads source profiles from each browser's own folder", () => {
    const env = { HOME: "/h", LOCALAPPDATA: "/l", XDG_CONFIG_HOME: "/c" };
    expect(defaultUserDataDir(env, "darwin", "edge")).toBe("/h/Library/Application Support/Microsoft Edge");
    expect(defaultUserDataDir(env, "darwin", "brave")).toBe("/h/Library/Application Support/BraveSoftware/Brave-Browser");
    expect(defaultUserDataDir(env, "win32", "edge")).toBe(path.join("/l", "Microsoft", "Edge", "User Data"));
    expect(defaultUserDataDir(env, "win32", "brave")).toBe(path.join("/l", "BraveSoftware", "Brave-Browser", "User Data"));
    expect(defaultUserDataDir(env, "linux", "edge")).toBe("/c/microsoft-edge");
    expect(defaultUserDataDir(env, "linux", "brave")).toBe("/c/BraveSoftware/Brave-Browser");
  });
  it("keeps each browser's copies in its own folder", () => {
    const env = { XDG_CONFIG_HOME: "/c" };
    expect(profileCopyDir(env, "Profile 1", "edge")).toBe("/c/jev-browser/edge/profile-1");
    expect(profileCopyDir(env, "Profile 1", "brave")).toBe("/c/jev-browser/brave/profile-1");
    expect(profileCopyDir(env, "Profile 1")).toBe("/c/jev-browser/chrome/profile-1");
  });
  it("sends the browser's own brand in the client hints", () => {
    expect(userAgentMetadata("HeadlessChrome/154.0.1.2", "Microsoft Edge", "darwin", "arm64")?.brands.map((b) => b.brand)).toContain("Microsoft Edge");
    expect(userAgentMetadata("HeadlessChrome/154.0.1.2", "Brave", "darwin", "arm64")?.brands.map((b) => b.brand)).toContain("Brave");
  });
  it("with no browser named, a launch copies the named profile from the browser it finds", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jev-browsers-"));
    tmpDirs.push(root);
    // The fake Edge exits at once, so the launch fails after the copy.
    const env = { HOME: root, LOCALAPPDATA: path.join(root, "local"), XDG_CONFIG_HOME: path.join(root, "config"), JEV_EDGE_BIN: "/usr/bin/false" };
    const source = defaultUserDataDir(env, undefined, "edge");
    fs.mkdirSync(path.join(source, "Profile 1"), { recursive: true });
    fs.writeFileSync(path.join(source, "Profile 1", "Cookies"), "c");
    await expect(launchChrome({ headed: false, profileDirectory: "Profile 1", env, log: fakeLogger() })).rejects.toThrow(/did not answer/);
    const copy = path.join(root, "config", "jev-browser", "edge", "profile-1");
    expect(fs.readFileSync(path.join(copy, "Default", "Cookies"), "utf8")).toBe("c");
    await vi.waitFor(() => expect(fs.existsSync(`${copy}.jev-lock`)).toBe(false));
    expect(fs.existsSync(path.join(root, "config", "jev-browser", "chrome"))).toBe(false);
  });
});

describe("--browser and JEV_BROWSER", () => {
  it("parses the flag and the env value; the flag wins", () => {
    expect(parseArgs(["t", "--browser", "edge"], {}).browser).toBe("edge");
    expect(parseArgs(["t"], { JEV_BROWSER: "Brave" }).browser).toBe("brave");
    expect(parseArgs(["t", "--browser", "chrome"], { JEV_BROWSER: "brave" }).browser).toBe("chrome");
    expect(parseArgs(["t"], {}).browser).toBeUndefined();
  });
  it("rejects an unknown browser and engine chromium with another browser", () => {
    expect(() => parseArgs(["t", "--browser", "firefox"], {})).toThrow(/--browser must be chrome, edge, brave, chromium/);
    expect(() => parseArgs(["t"], { JEV_BROWSER: "safari" })).toThrow(UsageError);
    expect(() => parseArgs(["t", "--engine", "chromium", "--browser", "edge"], {})).toThrow(/use --engine cdp --browser edge/);
    expect(parseArgs(["t", "--engine", "chromium", "--browser", "chromium"], {}).browser).toBe("chromium");
  });
});

describe("MCP browser choice", () => {
  it("the input's browser wins, engine chromium means Chromium, else the server's browser", () => {
    expect(browserChoice({ browser: "edge" }, { engine: "chromium" })).toEqual({ engine: "cdp", browser: "edge" });
    expect(browserChoice({ engine: "chromium" }, { browser: "brave" })).toEqual({ engine: "chromium", browser: "chromium" });
    expect(browserChoice({ engine: "cdp" }, { engine: "chromium", browser: "brave" })).toEqual({ engine: "cdp", browser: "brave" });
    expect(browserChoice({}, { engine: "chromium" })).toEqual({ engine: "chromium" });
    expect(browserChoice({}, { engine: "cdp" })).toEqual({ engine: "cdp" });
  });
  it("configFor carries the browser; checkInput refuses engine chromium with another browser", () => {
    const base = parseArgs([], {});
    expect(configFor({ task: "t", headed: true, confirm: "auto", dry_run: false, browser: "brave" }, base)).toMatchObject({ engine: "cdp", browser: "brave" });
    expect(configFor({ task: "t", headed: true, confirm: "auto", dry_run: false }, base)).not.toHaveProperty("browser");
    expect(checkInput({ task: "t", headed: true, confirm: "auto", dry_run: false, engine: "chromium", browser: "edge" }, {}, [])).toMatch(/engine "chromium" launches Chromium/);
  });
});


describe("scraper browser selection", () => {
  it("uses the saved browser and keeps it in the navigator config", () => {
    expect(envBrowser({}, "edge")).toBe("edge");
    expect(envBrowser({ JEV_BROWSER: "brave" }, "edge")).toBe("brave");
    expect(navBase({}, { headed: false }, "edge")).toMatchObject({ engine: "cdp", browser: "edge" });
    expect(navBase({ JEV_BROWSER: "brave" }, { headed: false })).toMatchObject({ browser: "brave" });
  });
});
