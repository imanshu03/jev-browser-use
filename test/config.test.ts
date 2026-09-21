import { APIConnectionError, AuthenticationError } from "@typesafe-ai/sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, forgetKey, loadKey, looksLikeKey, saveKey, validateKey, type ClientFactory, type KeyCheckClient } from "../src/config.js";

const FAKE_KEY = "test-key-0123456789abcdef";
let dir = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-config-"));
  env = { JEV_BROWSER_CONFIG: path.join(dir, "sub", "config.json") };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe("configPath", () => {
  it("uses JEV_BROWSER_CONFIG, else XDG_CONFIG_HOME, else ~/.config", () => {
    expect(configPath({ JEV_BROWSER_CONFIG: "rel/c.json" })).toBe(path.resolve("rel/c.json"));
    expect(configPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/jev-browser/config.json");
    expect(configPath({})).toBe(path.join(os.homedir(), ".config", "jev-browser", "config.json"));
  });
});

describe("loadKey, saveKey, forgetKey", () => {
  it("env beats file; missing file -> null; malformed file -> null", () => {
    saveKey(FAKE_KEY, env);
    expect(loadKey({ ...env, TYPESAFE_API_KEY: "env-key" })).toEqual({ key: "env-key", source: "env" });
    expect(loadKey(env)).toEqual({ key: FAKE_KEY, source: "file" });
    expect(loadKey({ JEV_BROWSER_CONFIG: path.join(dir, "none.json") })).toBeNull();
    fs.writeFileSync(env["JEV_BROWSER_CONFIG"] as string, "{not json");
    expect(loadKey(env)).toBeNull();
    fs.writeFileSync(env["JEV_BROWSER_CONFIG"] as string, JSON.stringify({ other: 1 }));
    expect(loadKey(env)).toBeNull();
    expect(loadKey({ ...env, TYPESAFE_API_KEY: "" })).toBeNull();
  });
  it("saveKey writes JSON with mode 600 in a 700 directory and returns the path", () => {
    const p = saveKey(FAKE_KEY, env);
    expect(p).toBe(env["JEV_BROWSER_CONFIG"]);
    const data = JSON.parse(fs.readFileSync(p, "utf8")) as { typesafe_api_key: string; saved_at: string };
    expect(data.typesafe_api_key).toBe(FAKE_KEY);
    expect(new Date(data.saved_at).toString()).not.toBe("Invalid Date");
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(p)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(p))).toEqual(["config.json"]);
  });
  it("saveKey and forgetKey act on the target of a symlink and keep the link", () => {
    const real = path.join(dir, "real", "config.json");
    const link = path.join(dir, "link.json");
    const linked = { JEV_BROWSER_CONFIG: link };
    saveKey("old-key-0123456789abcdef", { JEV_BROWSER_CONFIG: real });
    fs.symlinkSync(real, link);
    expect(saveKey(FAKE_KEY, linked)).toBe(link);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(loadKey({ JEV_BROWSER_CONFIG: real })).toEqual({ key: FAKE_KEY, source: "file" });
    forgetKey(linked);
    expect(fs.existsSync(real)).toBe(false);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(loadKey(linked)).toBeNull();
    expect(saveKey(FAKE_KEY, linked)).toBe(link);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(loadKey({ JEV_BROWSER_CONFIG: real })).toEqual({ key: FAKE_KEY, source: "file" });
  });
  it("forgetKey deletes the file and tolerates a missing file", () => {
    saveKey(FAKE_KEY, env);
    forgetKey(env);
    expect(fs.existsSync(env["JEV_BROWSER_CONFIG"] as string)).toBe(false);
    expect(() => forgetKey(env)).not.toThrow();
  });
});

describe("looksLikeKey", () => {
  it("wants 20+ characters and no whitespace", () => {
    expect(looksLikeKey(FAKE_KEY)).toBe(true);
    expect(looksLikeKey(`  ${FAKE_KEY}  `)).toBe(true);
    expect(looksLikeKey("short")).toBe(false);
    expect(looksLikeKey("")).toBe(false);
    expect(looksLikeKey("has a space in the middle of it")).toBe(false);
  });
});

describe("validateKey", () => {
  const configs: unknown[] = [];
  const factory = (behaviour: KeyCheckClient["systemOne"]): ClientFactory => (config) => { configs.push(config); return { systemOne: behaviour }; };
  it("success -> ok with model and usage; the client gets the key, model, and a timeout", async () => {
    const f = factory(async () => ({ model: "jev-1.2", usage: { input_tokens: 3, output_tokens: 1 } }));
    expect(await validateKey(FAKE_KEY, "jev-latest", f)).toEqual({ ok: true, model: "jev-1.2", usage: { input_tokens: 3, output_tokens: 1 } });
    expect(configs[0]).toEqual({ apiKey: FAKE_KEY, defaultModel: "jev-latest", logLevel: "off", timeout: 15000 });
  });
  it("AuthenticationError -> rejected; APIConnectionError -> network; Error -> other; the key never leaks", async () => {
    const rejected = await validateKey(FAKE_KEY, "m", factory(async () => { throw new AuthenticationError(401, { error: "bad" }, new Headers(), `invalid key ${FAKE_KEY}`); }));
    expect(rejected).toMatchObject({ ok: false, kind: "rejected" });
    expect((rejected as { message: string }).message).not.toContain(FAKE_KEY);
    expect(await validateKey(FAKE_KEY, "m", factory(async () => { throw new APIConnectionError("ECONNREFUSED"); }))).toEqual({ ok: false, kind: "network", message: "ECONNREFUSED" });
    expect(await validateKey(FAKE_KEY, "m", factory(async () => { throw new Error("boom"); }))).toEqual({ ok: false, kind: "other", message: "boom" });
  });
});
