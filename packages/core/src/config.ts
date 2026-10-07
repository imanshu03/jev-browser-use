// Key store for chat mode. Reads the TypeSafe API key from the environment or a config file. Checks a key with one small request.
import { APIConnectionError, AuthenticationError, PermissionDeniedError, TypeSafeClient } from "@typesafe-ai/sdk";
import type { SystemOneRequest, TypeSafeClientConfig, Usage } from "@typesafe-ai/sdk";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type KeySource = "env" | "file";

export interface LoadedKey { key: string; source: KeySource }

export type KeyCheck =
  | { ok: true; model: string; usage: Usage }
  | { ok: false; kind: "rejected" | "network" | "other"; message: string };

/** The part of TypeSafeClient that validateKey uses. Tests inject a fake. */
export interface KeyCheckClient {
  systemOne(request: SystemOneRequest): Promise<{ model: string; usage: Usage }>;
}

export type ClientFactory = (config: TypeSafeClientConfig) => KeyCheckClient;

/** Where the key file lives. `JEV_BROWSER_CONFIG` overrides the default under the XDG config directory. */
export function configPath(env: NodeJS.ProcessEnv): string {
  const override = env["JEV_BROWSER_CONFIG"];
  if (override) return path.resolve(override);
  const base = env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
  return path.join(base, "jev-browser", "config.json");
}

/** The environment wins over the file. A missing or malformed file gives null. */
export function loadKey(env: NodeJS.ProcessEnv): LoadedKey | null {
  const fromEnv = env["TYPESAFE_API_KEY"];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return { key: fromEnv, source: "env" };
  try {
    const raw = fs.readFileSync(configPath(env), "utf8");
    const data = JSON.parse(raw) as unknown;
    if (data && typeof data === "object") {
      const key = (data as Record<string, unknown>)["typesafe_api_key"];
      if (typeof key === "string" && key.length > 0) return { key, source: "file" };
    }
  } catch { /* missing or malformed */ }
  return null;
}

/** The real file behind the config path. A symlink resolves to its target, also when the target is missing. */
function realConfigPath(env: NodeJS.ProcessEnv): string {
  let file = configPath(env);
  for (let hops = 0; hops < 16; hops++) {
    let st: fs.Stats;
    try { st = fs.lstatSync(file); } catch { return file; }
    if (!st.isSymbolicLink()) return file;
    file = path.resolve(path.dirname(file), fs.readlinkSync(file));
  }
  return file;
}

/** Write the key file with mode 600 inside a directory with mode 700. Writes through a symlink. Returns the config path. */
export function saveKey(key: string, env: NodeJS.ProcessEnv): string {
  const file = configPath(env);
  const target = realConfigPath(env);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.config.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const body = JSON.stringify({ typesafe_api_key: key, saved_at: new Date().toISOString() }, null, 2) + "\n";
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
  return file;
}

/** Delete the key file when it exists. Deletes the target of a symlink and keeps the link. */
export function forgetKey(env: NodeJS.ProcessEnv): void {
  const target = realConfigPath(env);
  try { fs.unlinkSync(target); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** A key is one token of 20 or more characters with no whitespace. */
export function looksLikeKey(s: string): boolean {
  const t = s.trim();
  return t.length >= 20 && !/\s/.test(t);
}

function scrub(message: string, key: string): string {
  return key.length > 0 ? message.split(key).join("***") : message;
}

/** Send one tiny request with the key. Maps SDK errors to rejected, network, or other. The message never holds the key. */
export async function validateKey(key: string, model: string, clientFactory: ClientFactory = (c) => new TypeSafeClient(c)): Promise<KeyCheck> {
  const client = clientFactory({ apiKey: key, defaultModel: model, logLevel: "off", timeout: 15_000 });
  try {
    const r = await client.systemOne({ state: { ok: true }, questions: { ok: { type: "noul", instructions: "Is ok true?" } } });
    return { ok: true, model: r.model, usage: r.usage };
  } catch (e) {
    const message = scrub(String((e as Error)?.message ?? e), key);
    if (e instanceof AuthenticationError || e instanceof PermissionDeniedError) return { ok: false, kind: "rejected", message };
    if (e instanceof APIConnectionError) return { ok: false, kind: "network", message };
    return { ok: false, kind: "other", message };
  }
}
