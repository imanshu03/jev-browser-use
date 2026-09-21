// Keep-alive HTTP transport for the Jev client. One warm connection serves a whole run and every chat task.
//
// A new HTTPS connection to the API costs about 0.8 s (TCP, TLS, first request). Node's default fetch drops an
// idle socket after about 3 s, so a request after typing time pays that cost again. This transport keeps the
// socket open for `keepAliveMs`, and `warm` can open it before the first Jev request.
import type { Fetch } from "@typesafe-ai/sdk";
import type net from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import type { Logger } from "./io.js";

export interface TransportOptions {
  /** How long an idle socket stays open, in ms. Default: 60 s. */
  keepAliveMs?: number;
  /** Timeout of the warm request, in ms. Default: WARM_TIMEOUT_MS. Tests set a small value. */
  warmTimeoutMs?: number;
  log?: Logger;
}

export interface TransportStats {
  /** Sockets this transport opened. */
  connections: number;
}

export interface Transport {
  /** A fetch for TypeSafeClient. Every request goes through one keep-alive agent. */
  fetch: Fetch;
  /** Open the connection before the first Jev request: one GET <baseURL>/ without the key. Never throws, not even for a bad URL. */
  warm(baseURL: string): Promise<void>;
  /** Close the agent and its sockets. Safe to call more than once. */
  close(): Promise<void>;
  readonly stats: TransportStats;
}

/**
 * Timeout of the warm request. The transport has one socket, so a Jev request sent during a warm waits behind it.
 * This cap keeps that wait short: the API answers GET / in about 0.3 s, and the browser work before the first
 * step takes about 1 s. The timer starts with the call. undici applies the abort to a request that still waits
 * for its socket only when the socket is open, so a slow connect adds to the wait.
 */
export const WARM_TIMEOUT_MS = 1_500;
export const DEFAULT_KEEP_ALIVE_MS = 60_000;

/** The connect function of undici returns the socket it opens (lib/core/connect.js). Its type says void. */
type RawConnector = (options: buildConnector.Options, callback: buildConnector.Callback) => net.Socket | undefined;

export function createTransport(opts: TransportOptions = {}): Transport {
  const keepAliveMs = opts.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  const warmTimeoutMs = opts.warmTimeoutMs ?? WARM_TIMEOUT_MS;
  const log = opts.log;
  /** Fetches in flight. Only a warm can be in flight when this is 0. */
  let inFlight = 0;
  /**
   * A socket that connects for a warm alone. close() destroys it instead of waiting for the connect. The wait
   * would be undici's 10 s connect timeout, and a pending connect keeps the process alive even when the socket
   * is unref'd, because libuv counts the connect request. A fetch that starts during the connect takes the
   * socket over, and close() then waits for it as usual.
   */
  let warmSocket: net.Socket | null = null;
  // The same options undici uses when no connect function is given: a 10 s connect timeout.
  const rawConnect = buildConnector({ timeout: 10_000 }) as unknown as RawConnector;
  const connect: buildConnector.connector = (options, callback) => {
    const socket = rawConnect(options, (...args) => {
      if (warmSocket === socket) warmSocket = null;
      callback(...args);
    });
    if (inFlight === 0 && socket) warmSocket = socket;
  };
  // connections: 1 makes a second request wait for the one socket instead of opening another.
  const agent = new Agent({ connections: 1, keepAliveTimeout: keepAliveMs, keepAliveMaxTimeout: 600_000, connect });
  const stats: TransportStats = { connections: 0 };
  // The agent emits "connect" once per socket it opens. The event belongs to this agent only.
  agent.on("connect", () => {
    stats.connections += 1;
    log?.debug(`jev transport: connection ${stats.connections} opened`);
  });
  let closing: Promise<void> | null = null;
  /** close() aborts a warm that is still in flight, so it never delays the exit. */
  const warmAbort = new AbortController();
  const fetch: Fetch = (input, init) => {
    inFlight += 1;
    warmSocket = null;
    const p = undiciFetch(input, { ...init, dispatcher: agent }) as unknown as Promise<Response>;
    return p.finally(() => { inFlight -= 1; });
  };
  return {
    fetch,
    stats,
    async warm(baseURL) {
      // A GET, not a HEAD: undici closes the socket after every HEAD (undici issue #258), and the
      // `reset: false` escape only works when the server echoes "Connection: keep-alive".
      let target = baseURL;
      try {
        const url = new URL(baseURL);
        const path = `${url.pathname.replace(/\/+$/, "")}/`;
        target = `${url.origin}${path}`;
        const signal = AbortSignal.any([warmAbort.signal, AbortSignal.timeout(warmTimeoutMs)]);
        const r = await agent.request({ origin: url.origin, path, method: "GET", reset: false, headers: { accept: "application/json" }, signal });
        await r.body.dump();
      } catch (e) {
        log?.debug(`jev transport: warm ${target} failed: ${(e as Error)?.message ?? String(e)}`);
      }
    },
    close() {
      if (!closing) {
        warmAbort.abort();
        // Do not wait for a connect that only a warm needs. End it now.
        if (warmSocket) { warmSocket.destroy(new Error("transport closed")); warmSocket = null; }
        closing = agent.close().then(() => undefined);
      }
      return closing;
    },
  };
}
