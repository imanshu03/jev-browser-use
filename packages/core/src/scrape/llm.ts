// The LLM backend of the scrape kit: it writes an extract draft from a page context (L3 heal, authoring). Claude Code
// headless with no tools, or the OpenAI-compatible text model of src/writer.ts. The backend never gets a tool, and its
// answer is only parsed as JSON: nothing in it runs.
//
// The exported names LlmBackend, LlmReply, and llmFromEnv are a contract of the scrape kit (see
// /tmp/jevscrape/build/SPEC.md, section C8).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../io.js";
import type { TextModelConfig } from "../writer.js";
import { textModelFromEnv } from "../writer.js";

export interface LlmReply { text: string; ms: number }

export interface LlmBackend {
  /** "claude:<model>" or "text:<model>", for logs and stats. */
  readonly name: string;
  /** One completion. Rejects with the reason on a spawn error, a timeout, an error answer, or no text. */
  complete(req: { system: string; user: string; timeoutMs: number; signal?: AbortSignal }): Promise<LlmReply>;
}

/** The Claude model of the scrape kit when JEV_SCRAPE_MODEL does not say. */
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
/** One LLM call may take this long when JEV_SCRAPE_LLM_TIMEOUT_MS does not say. */
export const LLM_TIMEOUT_MS = 180_000;
/** Output tokens of one text model answer: an extract draft is a small JSON object. */
const TEXT_MAX_TOKENS = 4096;
/** Environment keys that the claude child never gets. */
const DROPPED_ENV = /^(?:TYPESAFE_API_KEY|JEV_TEXT_API_KEY|AGENT_BROWSER_.*)$/;

/** The LLM timeout of the environment: JEV_SCRAPE_LLM_TIMEOUT_MS (1000-3600000), else 180000. */
export function llmTimeoutMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env["JEV_SCRAPE_LLM_TIMEOUT_MS"]);
  return Number.isFinite(n) && n >= 1000 && n <= 3_600_000 ? n : LLM_TIMEOUT_MS;
}

/** The claude binary: JEV_SCRAPE_CLAUDE_BIN, else ~/.local/bin/claude when it exists, else claude on PATH, else null. */
export function claudeBin(env: NodeJS.ProcessEnv, exists: (p: string) => boolean = (p) => fs.existsSync(p)): string | null {
  const own = env["JEV_SCRAPE_CLAUDE_BIN"]?.trim();
  if (own) return own;
  const local = path.join(env["HOME"] ?? os.homedir(), ".local", "bin", "claude");
  if (exists(local)) return local;
  for (const dir of (env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, "claude");
    if (exists(full)) return full;
  }
  return null;
}

/** The argv of one headless claude call: one turn, no tools, no session, no MCP server, no slash command. */
export function claudeArgs(model: string, system: string): string[] {
  return ["-p", "--model", model, "--system-prompt", system, "--tools", "", "--max-turns", "1", "--output-format", "json",
    "--no-session-persistence", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands"];
}

/** The environment of the claude child: the process env without the Jev key, the text model key, and AGENT_BROWSER_*. */
export function claudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !DROPPED_ENV.test(k)));
}

/** The JSON that `claude -p --output-format json` prints. */
interface ClaudeOutput { is_error?: unknown; result?: unknown; subtype?: unknown }

/** Claude Code headless, with no tools. The user text goes on stdin; the child runs in a new empty directory. */
export function claudeBackend(env: NodeJS.ProcessEnv, log: Logger, bin: string | null = claudeBin(env)): LlmBackend | null {
  if (!bin) return null;
  const model = env["JEV_SCRAPE_MODEL"]?.trim() || DEFAULT_CLAUDE_MODEL;
  const childEnv = claudeEnv(env);
  return {
    name: `claude:${model}`,
    complete(req) {
      const t0 = Date.now();
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jev-scrape-llm-"));
      const cleanup = (): void => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ } };
      return new Promise<LlmReply>((resolve, reject) => {
        let out = "";
        let err = "";
        let done = false;
        const child = spawn(bin, claudeArgs(model, req.system), { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
        const finish = (e: Error | null, reply?: LlmReply): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          req.signal?.removeEventListener("abort", onAbort);
          cleanup();
          if (e) reject(e);
          else resolve(reply as LlmReply);
        };
        const kill = (why: string): void => { child.kill("SIGKILL"); finish(new Error(why)); };
        const timer = setTimeout(() => kill(`claude timed out after ${req.timeoutMs} ms`), req.timeoutMs);
        const onAbort = (): void => kill("claude call aborted");
        if (req.signal?.aborted) { kill("claude call aborted"); return; }
        req.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf8"); });
        child.stderr?.on("data", (d: Buffer) => { err += d.toString("utf8"); });
        child.on("error", (e) => finish(new Error(`claude did not start (${bin}): ${e.message}`)));
        child.on("close", (code) => {
          let j: ClaudeOutput | null = null;
          try { j = JSON.parse(out) as ClaudeOutput | null; } catch { j = null; }
          if (!j || typeof j !== "object") { finish(new Error(`claude exit ${code ?? "?"}: the output is not JSON: ${(err || out).trim().slice(0, 300)}`)); return; }
          if (j.is_error) { finish(new Error(`claude error: ${String(j.result ?? j.subtype ?? "unknown").slice(0, 300)}`)); return; }
          const text = j.result === undefined || j.result === null ? "" : String(j.result);
          if (!text.trim()) { finish(new Error("claude gave no text")); return; }
          log.debug(`llm ${model}: ${text.length} characters in ${Date.now() - t0} ms`);
          finish(null, { text, ms: Date.now() - t0 });
        });
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(req.user);
      });
    },
  };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The OpenAI-compatible text model of src/writer.ts: one chat call that answers with a JSON object. */
export function textBackend(cfg: TextModelConfig, log: Logger, fetchImpl: FetchLike = fetch as unknown as FetchLike): LlmBackend {
  return {
    name: `text:${cfg.model}`,
    async complete(req) {
      const t0 = Date.now();
      const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs)]) : AbortSignal.timeout(req.timeoutMs);
      const body = {
        model: cfg.model, max_tokens: TEXT_MAX_TOKENS, response_format: { type: "json_object" },
        messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
        ...(cfg.reasoning === "none" ? { reasoning: { enabled: false } } : cfg.reasoning === "low" ? { reasoning: { effort: "low" } } : {}),
      };
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body), signal });
      } catch (e) {
        throw new Error(signal.aborted ? `the text model timed out after ${req.timeoutMs} ms` : `the text model connection failed: ${(e as Error)?.message ?? String(e)}`);
      }
      if (!res.ok) throw new Error(`the text model returned HTTP ${res.status}`);
      const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) throw new Error("the text model gave no text");
      log.debug(`llm ${cfg.model}: ${text.length} characters in ${Date.now() - t0} ms`);
      return { text, ms: Date.now() - t0 };
    },
  };
}

/**
 * The backend of the environment. JEV_SCRAPE_LLM: "claude" (default when a claude binary is found), "text" (JEV_TEXT_*),
 * or "off". Null when it is off or not available.
 */
export function llmFromEnv(env: NodeJS.ProcessEnv, log: Logger): LlmBackend | null {
  const mode = env["JEV_SCRAPE_LLM"]?.trim().toLowerCase() || "";
  if (mode === "off") return null;
  if (mode === "claude") {
    const b = claudeBackend(env, log);
    if (!b) log.warn("JEV_SCRAPE_LLM=claude, but no claude binary was found: set JEV_SCRAPE_CLAUDE_BIN");
    return b;
  }
  const text = textModelFromEnv(env);
  if (mode === "text") {
    if (!text) log.warn("JEV_SCRAPE_LLM=text, but JEV_TEXT_MODEL and JEV_TEXT_API_KEY are not both set");
    return text ? textBackend(text, log) : null;
  }
  if (mode !== "") log.warn(`JEV_SCRAPE_LLM=${mode} is not claude, text, or off; using the default`);
  return claudeBackend(env, log) ?? (text ? textBackend(text, log) : null);
}
