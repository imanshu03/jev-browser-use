import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSession } from "../../src/fast/session.js";
import { MCP } from "../../src/mcp/limits.js";
import type { Run, RunManager } from "../../src/mcp/runs.js";
import type { JevLink } from "../../src/mcp/setup.js";
import { startIdleTimers } from "../../src/mcp/timers.js";

function setup(over: { key?: string | null; chrome?: boolean } = {}) {
  const state = { ended: null as number | null, active: null as Run | null, chrome: over.chrome ?? true, warms: 0, closes: 0, keeps: [] as boolean[] };
  const runs = { lastRunEndedAt: () => state.ended, active: () => state.active } as unknown as RunManager;
  const jev = { key: () => (over.key === undefined ? "tsk-test-key-0123456789" : over.key), warm: async (o?: { keep?: boolean }) => { state.warms += 1; state.keeps.push(o?.keep === true); } } as unknown as JevLink;
  const session = { get chrome() { return state.chrome ? {} : null; }, close: async () => { state.closes += 1; state.chrome = false; } } as unknown as BrowserSession;
  const stop = startIdleTimers({ runs, jev, session, now: () => Date.now(), setInterval });
  return { state, stop };
}

describe("startIdleTimers", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sends no ping before the first run ends", async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(MCP.idlePingMs * 20);
    expect(t.state.warms).toBe(0);
    t.stop();
  });

  it("pings every 45 s after a run, for 10 minutes", async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(MCP.idlePingMs * 2);
    t.state.ended = Date.now();
    await vi.advanceTimersByTimeAsync(MCP.idlePingMs);
    expect(t.state.warms).toBe(1);
    // An idle ping: it also sends when the sockets are open, so they do not reach their idle timeout.
    expect(t.state.keeps).toEqual([true]);
    await vi.advanceTimersByTimeAsync(MCP.idlePingMs * 3);
    expect(t.state.warms).toBe(4);
    await vi.advanceTimersByTimeAsync(MCP.pingWindowMs);
    const after = t.state.warms;
    // The run ended at 90 s. Pings run at 135 s, 180 s, ..., 675 s: 13 pings in the 10 minutes after it.
    expect(after).toBe(13);
    await vi.advanceTimersByTimeAsync(MCP.idlePingMs * 5);
    expect(t.state.warms).toBe(after);
    t.stop();
  });

  it("sends no ping while a run is active or without a key", async () => {
    const t = setup();
    t.state.ended = Date.now();
    t.state.active = {} as Run;
    await vi.advanceTimersByTimeAsync(MCP.idlePingMs * 3);
    expect(t.state.warms).toBe(0);
    t.stop();
    const u = setup({ key: null });
    u.state.ended = Date.now();
    await vi.advanceTimersByTimeAsync(MCP.idlePingMs * 3);
    expect(u.state.warms).toBe(0);
    u.stop();
  });

  it("closes Chrome after 30 idle minutes, once; not while a run is active; not before a run", async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(MCP.idleCloseMs * 2);
    expect(t.state.closes).toBe(0);
    t.state.ended = Date.now();
    await vi.advanceTimersByTimeAsync(MCP.idleCloseMs - MCP.idleCheckMs);
    expect(t.state.closes).toBe(0);
    await vi.advanceTimersByTimeAsync(MCP.idleCheckMs);
    expect(t.state.closes).toBe(1);
    await vi.advanceTimersByTimeAsync(MCP.idleCloseMs);
    expect(t.state.closes).toBe(1);
    t.stop();
    const u = setup();
    u.state.ended = Date.now();
    u.state.active = {} as Run;
    await vi.advanceTimersByTimeAsync(MCP.idleCloseMs * 2);
    expect(u.state.closes).toBe(0);
    u.stop();
  });

  it("stop() clears both timers, and the timers do not keep the process alive", async () => {
    const created: { unref: boolean }[] = [];
    const spy = ((fn: () => void, ms: number) => {
      const h = setInterval(fn, ms);
      const rec = { unref: false };
      created.push(rec);
      const orig = h.unref.bind(h);
      h.unref = () => { rec.unref = true; return orig(); };
      return h;
    }) as unknown as typeof setInterval;
    const state = { warms: 0 };
    const stop = startIdleTimers({
      runs: { lastRunEndedAt: () => Date.now(), active: () => null } as unknown as RunManager,
      jev: { key: () => "k", warm: async () => { state.warms += 1; } } as unknown as JevLink,
      session: { chrome: null, close: async () => undefined } as unknown as BrowserSession,
      now: () => Date.now(), setInterval: spy,
    });
    expect(created).toEqual([{ unref: true }, { unref: true }]);
    stop();
    await vi.advanceTimersByTimeAsync(MCP.idlePingMs * 3);
    expect(state.warms).toBe(0);
  });
});
