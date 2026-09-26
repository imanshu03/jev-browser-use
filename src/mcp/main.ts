// Entry of the jev-browser-use MCP server (stdio). It runs on load.
// SDK imports live only in this file and in server.ts.
//
// Stdout carries only JSON-RPC: console output and the log go to stderr. Startup launches no Chrome and sends no
// network request; the first browse call does. One guarded shutdown runs on stdin end or close, SIGTERM, SIGINT,
// and SIGHUP: it cancels the run, then closes the browser session, the Jev transport, and the server.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import { VERSION } from "../cli.js";
import { defaultUserDataDir, listProfiles } from "../fast/chrome.js";
import { BrowserSession } from "../fast/session.js";
import { createLogger } from "../io.js";
import { createTransport } from "../transport.js";
import { MCP, MCP_ENV } from "./limits.js";
import { RunManager, stripKey } from "./runs.js";
import { buildServer } from "./server.js";
import { baseConfig, createJevLink, fastStarter, findPackageRoot, loadPackageEnv } from "./setup.js";
import { startIdleTimers } from "./timers.js";

// 1. Nothing but JSON-RPC may reach stdout. A library that prints goes to stderr.
for (const name of ["log", "info", "debug", "warn"] as const) {
  console[name] = (...args: unknown[]) => { process.stderr.write(format(...args) + "\n"); };
}

// 2. The package .env fills keys that the client did not pass. A copy outside the repository has no package .env.
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = findPackageRoot(here);
const envFile = loadPackageEnv(here, process.env);
const env = process.env;

// 3. The stderr log. Its redactor removes the API key; each run adds its own secrets.
const log = createLogger(process.stderr, env[MCP_ENV.logLevel] === "debug" ? "debug" : "info", false);

// 4. Lazy parts: no Chrome and no connection until browse.
const base = baseConfig(env, log);
const transport = createTransport({ log });
const jev = createJevLink(env, log, transport, { packageEnv: packageRoot !== null });
log.redactor = (s) => stripKey(s, jev.key());
const session = new BrowserSession({ env, log });
const profiles = (engine: "cdp" | "chromium") => listProfiles(defaultUserDataDir(env, undefined, engine === "chromium" ? "chromium" : "chrome"));
const runs = new RunManager({
  start: fastStarter({ session, jev, base, env, profiles }), log,
  precheck: () => void jev.client(), forceStop: () => session.close(), secret: () => jev.key(),
});

// 5. The server. JEV_MCP_REVIEW_TEXT is read once, when the server is built.
const handle = serveStdio(() => buildServer({
  runs, version: VERSION, env, profiles, secret: () => jev.key(), engine: base.engine === "chromium" ? "chromium" : "cdp", log,
  closeBrowser: async () => { const open = session.chrome !== null; await session.close(); return open; },
}), { onerror: (e) => log.warn(`mcp: ${stripKey(e.message, jev.key())}`) });

// 6. Idle timers. Both are unref'd, so they never keep the process alive.
const stopTimers = startIdleTimers({ runs, jev, session, now: () => Date.now(), setInterval });

log.info(`jev-browser MCP server ${VERSION} ready (engine ${base.engine ?? "cdp"}${envFile ? `, env from ${envFile}` : ""})`);

// 7. One guarded shutdown. The watchdog exits with 1 when a close step hangs.
let closing = false;
async function shutdown(why: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info(`shutdown: ${why}`);
  setTimeout(() => { process.stderr.write(`shutdown did not end in ${MCP.shutdownWatchdogMs} ms\n`); process.exit(1); }, MCP.shutdownWatchdogMs);
  stopTimers();
  await runs.shutdown().catch((e: unknown) => log.warn(`shutdown: runs: ${String(e)}`));
  await session.close().catch((e: unknown) => log.warn(`shutdown: browser: ${String(e)}`));
  await jev.close().catch((e: unknown) => log.warn(`shutdown: jev: ${String(e)}`));
  await handle.close().catch((e: unknown) => log.warn(`shutdown: server: ${String(e)}`));
  process.exit(0);
}
process.stdin.on("end", () => { void shutdown("stdin end"); });
process.stdin.on("close", () => { void shutdown("stdin close"); });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => { void shutdown(signal); });
process.on("unhandledRejection", (e) => { log.warn(`unhandled rejection: ${String((e as Error | null)?.stack ?? e)}`); });
process.on("uncaughtException", (e) => { log.warn(`uncaught exception: ${String(e.stack ?? e)}`); void shutdown("uncaught exception"); });
