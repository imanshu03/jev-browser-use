// Keep-alive HTTP transport for the Jev client. Two warm connections serve a whole run and every chat task.
//
// A new HTTPS connection to the API costs about 0.8 s (TCP, TLS, first request). Node's default fetch drops an
// idle socket after about 3 s, so a request after typing time pays that cost again. This transport keeps the
// sockets open for `keepAliveMs`, and `warm` can open them before the first Jev request.
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
  /**
   * Open the connections before the first Jev request: one GET <baseURL>/ per socket, at the same time, without the key.
   * Nothing when every socket is open, unless `keep`: an idle ping keeps open sockets from their idle timeout. Never
   * throws, not even for a bad URL.
   */
  warm(baseURL: string, opts?: { keep?: boolean }): Promise<void>;
  /** Close the agent and its sockets. Safe to call more than once. */
  close(): Promise<void>;
  readonly stats: TransportStats;
}

/**
 * Timeout of the warm requests. A Jev request sent while both sockets carry a warm GET waits behind one of them.
 * This cap keeps that wait short: the API answers GET / in about 0.3 s, and the browser work before the first
 * step takes about 1 s. The timer starts with the call. undici applies the abort to a request that still waits
 * for its socket only when the socket is open, so a slow connect adds to the wait.
 */
export const WARM_TIMEOUT_MS = 1_500;
/** Sockets of the transport: a step request, and one that the fast engine dropped while it still runs. */
export const SOCKETS = 2;
export const DEFAULT_KEEP_ALIVE_MS = 60_000;

/** The connect function of undici returns the socket it opens (lib/core/connect.js). Its type says void. */
type RawConnector = (options: buildConnector.Options, callback: buildConnector.Callback) => net.Socket | undefined;

export function createTransport(opts: TransportOptions = {}): Transport {
  const keepAliveMs = opts.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  const warmTimeoutMs = opts.warmTimeoutMs ?? WARM_TIMEOUT_MS;
  const log = opts.log;
  /** Fetches in flight. Only a warm can be in flight when this is 0. */
  let inFlight = 0;
  /** Sockets that are open now. */
  let open = 0;
  /**
   * The sockets that still connect. With no fetch in flight, such a connect serves only a warm, and close() destroys
   * it instead of waiting for it. The wait would be undici's 10 s connect timeout, and a pending connect keeps the
   * process alive even when the socket is unref'd, because libuv counts the connect request. With a fetch in flight,
   * close() waits as usual: the connect can carry that fetch.
   */
  const connecting = new Set<net.Socket>();
  // The same options undici uses when no connect function is given: a 10 s connect timeout.
  const rawConnect = buildConnector({ timeout: 10_000 }) as unknown as RawConnector;
  const connect: buildConnector.connector = (options, callback) => {
    const socket = rawConnect(options, (...args) => {
      if (socket) connecting.delete(socket);
      callback(...args);
    });
    if (socket) connecting.add(socket);
  };
  // Two sockets. The fast engine can drop a step request that the page made stale and send the next one at once; the
  // API answers the requests of one connection one at a time (also over HTTP/2: 295 and 596 ms for two at once, against
  // 360 and 353 ms on two connections). A third request waits for a socket instead of opening another.
  const agent = new Agent({ connections: SOCKETS, keepAliveTimeout: keepAliveMs, keepAliveMaxTimeout: 600_000, connect });
  const stats: TransportStats = { connections: 0 };
  // The agent emits "connect" once per socket it opens. The event belongs to this agent only.
  agent.on("connect", () => {
    stats.connections += 1;
    open += 1;
    log?.debug(`jev transport: connection ${stats.connections} opened`);
  });
  agent.on("disconnect", () => { open = Math.max(0, open - 1); });
  let closing: Promise<void> | null = null;
  /** close() aborts a warm that is still in flight, so it never delays the exit. */
  const warmAbort = new AbortController();
  const fetch: Fetch = (input, init) => {
    inFlight += 1;
    const p = undiciFetch(input, { ...init, dispatcher: agent }) as unknown as Promise<Response>;
    return p.finally(() => { inFlight -= 1; });
  };
  return {
    fetch,
    stats,
    async warm(baseURL, opts) {
      // A GET, not a HEAD: undici closes the socket after every HEAD (undici issue #258), and the
      // `reset: false` escape only works when the server echoes "Connection: keep-alive". One GET per socket, at the
      // same time, so each socket is open before a request needs it.
      // Every socket is open: a warm GET would only hold one while a Jev request waits for it. An idle ping sends anyway.
      if (open >= SOCKETS && opts?.keep !== true) return;
      let target = baseURL;
      let url: URL;
      try {
        url = new URL(baseURL);
      } catch (e) {
        log?.debug(`jev transport: warm ${target} failed: ${(e as Error)?.message ?? String(e)}`);
        return;
      }
      const path = `${url.pathname.replace(/\/+$/, "")}/`;
      target = `${url.origin}${path}`;
      const signal = AbortSignal.any([warmAbort.signal, AbortSignal.timeout(warmTimeoutMs)]);
      const one = async (): Promise<string | null> => {
        try {
          const r = await agent.request({ origin: url.origin, path, method: "GET", reset: false, headers: { accept: "application/json" }, signal });
          await r.body.dump();
          return null;
        } catch (e) {
          return (e as Error)?.message ?? String(e);
        }
      };
      const errors = (await Promise.all(Array.from({ length: SOCKETS }, one))).filter((m): m is string => m !== null);
      if (errors.length > 0) log?.debug(`jev transport: warm ${target} failed: ${errors[0]}`);
    },
    close() {
      if (!closing) {
        warmAbort.abort();
        // Do not wait for a connect that only a warm needs. End it now.
        if (inFlight === 0) for (const socket of connecting) socket.destroy(new Error("transport closed"));
        connecting.clear();
        closing = agent.close().then(() => undefined);
      }
      return closing;
    },
  };
}
