// Idle timers of the MCP server: keep the Jev connection warm for a short time after a run, and close Chrome
// after a long idle time. The server starts in every assistant session, so nothing runs before the first run ends.
import type { BrowserSession } from "../fast/session.js";
import { MCP } from "./limits.js";
import type { RunManager } from "./runs.js";
import type { JevLink } from "./setup.js";

export interface TimerDeps { runs: RunManager; jev: JevLink; session: BrowserSession; now: () => number; setInterval: typeof setInterval }

/** Both timers are unref'd. Returns stop(). */
export function startIdleTimers(d: TimerDeps): () => void {
  // Ping: only after a run ended, for pingWindowMs, while no run is active, and when a key exists.
  const ping = d.setInterval(() => {
    const ended = d.runs.lastRunEndedAt();
    if (ended === null || d.now() - ended >= MCP.pingWindowMs || d.runs.active() !== null || d.jev.key() === null) return;
    void d.jev.warm().catch(() => undefined);
  }, MCP.idlePingMs);
  // Idle close: no run is active and no run ended in idleCloseMs.
  const idle = d.setInterval(() => {
    const ended = d.runs.lastRunEndedAt();
    if (ended === null || d.runs.active() !== null || d.now() - ended < MCP.idleCloseMs || d.session.chrome === null) return;
    void d.session.close().catch(() => undefined);
  }, MCP.idleCheckMs);
  ping.unref?.();
  idle.unref?.();
  return () => { clearInterval(ping); clearInterval(idle); };
}
