// One Chrome DevTools Protocol connection: a pipe to a Chrome we launched, or a WebSocket to
// a Chrome we attached to. Pure transport. No page logic lives here.
import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { CdpClient } from "./model.js";

export class CdpError extends Error {
  method: string;
  code?: number;
  constructor(message: string, method: string, code?: number) {
    super(message);
    this.name = "CdpError";
    this.method = method;
    if (code !== undefined) this.code = code;
  }
}

export interface CdpOptions {
  /** Per-command timeout. Default 30000 ms. */
  timeoutMs?: number;
}

type EventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

interface Pending {
  method: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Transport {
  write(text: string): void;
  end(): Promise<void>;
}

/** Shared message matching, event dispatch, and timeouts. Both transports use it. */
function createCore(transport: Transport, opts: CdpOptions): CdpClient & { receive(text: string): void; fail(err: Error): void } {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const pending = new Map<number, Pending>();
  const handlers = new Map<string, Set<EventHandler>>();
  let nextId = 1;
  let closed = false;
  let closing: Promise<void> | null = null;

  function receive(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg["id"] === "number") {
      const p = pending.get(msg["id"]);
      if (!p) return;
      pending.delete(msg["id"]);
      clearTimeout(p.timer);
      const error = msg["error"] as { message?: string; code?: number } | undefined;
      if (error) {
        p.reject(new CdpError(String(error.message ?? "unknown CDP error"), p.method, typeof error.code === "number" ? error.code : undefined));
        return;
      }
      p.resolve((msg["result"] as Record<string, unknown> | undefined) ?? {});
      return;
    }
    if (typeof msg["method"] === "string") {
      const set = handlers.get(msg["method"]);
      if (!set) return;
      const params = (msg["params"] as Record<string, unknown> | undefined) ?? {};
      const sessionId = typeof msg["sessionId"] === "string" ? msg["sessionId"] : undefined;
      for (const h of set) {
        try {
          h(params, sessionId);
        } catch {
          // A handler error never breaks the transport.
        }
      }
    }
  }

  function fail(err: Error): void {
    if (closed) return;
    closed = true;
    for (const [id, p] of pending) {
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new CdpError(err.message, p.method));
    }
  }

  return {
    get closed() { return closed; },
    receive,
    fail,
    send(method, params, sessionId) {
      if (closed) return Promise.reject(new CdpError("connection closed", method));
      const id = nextId++;
      const msg: Record<string, unknown> = { id, method, params: params ?? {} };
      if (sessionId !== undefined) msg["sessionId"] = sessionId;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new CdpError(`timeout: ${method} gave no reply in ${timeoutMs} ms`, method));
        }, timeoutMs);
        pending.set(id, { method, resolve, reject, timer });
        try {
          transport.write(JSON.stringify(msg));
        } catch (e) {
          pending.delete(id);
          clearTimeout(timer);
          reject(new CdpError(`write failed: ${(e as Error).message}`, method));
        }
      });
    },
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      return () => { set.delete(handler); };
    },
    close() {
      if (closing) return closing;
      closing = (async () => {
        fail(new Error("connection closed"));
        await transport.end().catch(() => undefined);
      })();
      return closing;
    },
  };
}

/**
 * Connect to a Chrome launched with `--remote-debugging-pipe` and
 * `stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]`. Chrome reads NUL-terminated JSON
 * on fd 3 and writes NUL-terminated JSON on fd 4.
 */
export function connectPipe(child: ChildProcess, opts: CdpOptions = {}): CdpClient {
  const input = child.stdio[3] as Writable | null | undefined;
  const output = child.stdio[4] as Readable | null | undefined;
  if (!input || !output) throw new Error("child has no CDP pipe on fd 3 and 4");

  const core = createCore({
    write(text) { input.write(text + "\0"); },
    end() {
      return new Promise<void>((resolve) => {
        if (input.writableEnded || input.destroyed) return resolve();
        input.end(() => resolve());
      });
    },
  }, opts);

  // Partial frames stay as bytes, so a multi-byte character split across chunks survives.
  let buffered: Buffer = Buffer.alloc(0);
  output.on("data", (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    buffered = buffered.length ? Buffer.concat([buffered, bytes]) : bytes;
    let start = 0;
    for (;;) {
      const end = buffered.indexOf(0, start);
      if (end < 0) break;
      core.receive(buffered.subarray(start, end).toString("utf8"));
      start = end + 1;
    }
    buffered = start ? Buffer.from(buffered.subarray(start)) : buffered;
  });
  output.on("end", () => core.fail(new Error("CDP pipe ended")));
  output.on("close", () => core.fail(new Error("CDP pipe closed")));
  output.on("error", (e: Error) => core.fail(new Error(`CDP pipe error: ${e.message}`)));
  input.on("error", (e: Error) => core.fail(new Error(`CDP pipe error: ${e.message}`)));
  child.once("exit", (code, signal) => core.fail(new Error(`chrome exited (code ${code ?? "null"}, signal ${signal ?? "null"})`)));

  return core;
}

/** Connect to a running Chrome over its DevTools WebSocket. One JSON text frame per message. */
export async function connectWebSocket(url: string, opts: CdpOptions = {}): Promise<CdpClient> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error(`websocket connect failed: ${url}`)); };
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });

  const core = createCore({
    write(text) { ws.send(text); },
    end() {
      return new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        const done = () => { ws.removeEventListener("close", done); resolve(); };
        ws.addEventListener("close", done);
        ws.close();
        setTimeout(done, 1000).unref();
      });
    },
  }, opts);

  ws.addEventListener("message", (ev: MessageEvent) => {
    const data = ev.data as unknown;
    if (typeof data === "string") core.receive(data);
    else if (data instanceof ArrayBuffer) core.receive(Buffer.from(data).toString("utf8"));
    else if (Buffer.isBuffer(data)) core.receive(data.toString("utf8"));
  });
  ws.addEventListener("close", () => core.fail(new Error("websocket closed")));
  ws.addEventListener("error", () => core.fail(new Error("websocket error")));
  return core;
}
