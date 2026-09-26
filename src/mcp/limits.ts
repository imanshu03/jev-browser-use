// Constants of the MCP server: call timing, run bookkeeping, idle timers, environment names, and the runner hints.
import type { RunnerHints } from "../io.js";

export const MCP = {
  waitDefaultS: 40, waitMaxS: 50,
  freshCallMs: 5_000,          // only a call this young opens a dialog
  confirmPickupMs: 60_000,     // a confirmation that no call opens in this time is denied
  confirmDialogMs: 100_000,    // freshCallMs + this < 120 s (Claude auto-background)
  textAttempts: 3, finishedRuns: 10, cancelWaitMs: 5_000,
  idlePingMs: 45_000, pingWindowMs: 600_000, idleCloseMs: 1_800_000, idleCheckMs: 60_000,
  shutdownWatchdogMs: 15_000, viewSteps: 8,
  viewTokens: 7_000,           // estimated tokens per view; Codex cuts tool output above 10k tokens
} as const;

export const MCP_ENV = {
  logLevel: "JEV_MCP_LOG_LEVEL",                 // "debug" | other
  allowFile: "JEV_MCP_ALLOW_FILE",               // "1": browse.url may be file:
  trustElicitation: "JEV_MCP_TRUST_ELICITATION", // "1": trust elicitation in unattended sessions
  reviewText: "JEV_MCP_REVIEW_TEXT",             // "1": continue requires user interaction in Claude Code
  autonomous: "JEV_MCP_AUTONOMOUS",              // "0": browse refuses confirm "autonomous"
} as const;

/** How the user turns on autonomous mode. The no-dialog hints give these words, so the assistant does not ask a yes/no question. */
const AUTONOMY_WORDS = "The user can write \"autonomous\" or \"don't ask me\" in their own message to let Jev act without dialogs. Do not ask the user a yes/no question for it";

/** Hints that tell the assistant what to do next. They replace the CLI texts in the runner. */
export const MCP_HINTS: RunnerHints = {
  headed: "call browse again with headed: true, then sign in in the Chrome window when the run pauses",
  noConfirm: `this session cannot show the user a confirmation dialog, so Jev did not do it. Text that the assistant wrote stays in the field. Ask the user to check it in the Chrome window and do the action there, or set JEV_MCP_TRUST_ELICITATION=1 when a person answers dialogs in this client. ${AUTONOMY_WORDS}`,
  noConfirmHeadless: `this session cannot show the user a confirmation dialog, so Jev did not do it. The run was headless, so the user cannot see the page. You cannot do the action yourself. To let the user check the text and do the action, call browse again with headed: true, or set JEV_MCP_TRUST_ELICITATION=1 when a person answers dialogs in this client. ${AUTONOMY_WORDS}`,
  confirmNever: "confirm is \"never\" for this run, so Jev did not do it. Text that the assistant wrote stays in the field. Call browse again with confirm \"auto\" so that the user can allow the action in a dialog, or ask the user to check the text in the Chrome window and do the action there",
  value: "ask the user for the exact text, or use exact text that the user already gave, then call browse again with that text in quotes in the task",
  credential: "tell the user to type it in the Chrome window, then call browse again. Never send it through the assistant",
  unattendedWall: "this run is autonomous and no person answers in this session, so Jev did not wait for a sign-in. Tell the user to sign in in the Chrome window (a headed run shows it), then call browse again",
};
