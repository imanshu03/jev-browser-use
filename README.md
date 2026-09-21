# jev-browser

`jev-browser` automates a browser task from one sentence of natural language.

- TypeSafe's Jev model makes every semantic decision (which operation, which element, which value, done or blocked).
- The `cdp` and `chromium` engines use a direct DevTools (CDP) connection. The `vercel` engine uses Vercel's `agent-browser` CLI.
- Code makes every deterministic decision: parsing, budgets, thresholds, retries, loop detection.

## Install

```
npm install
echo 'TYPESAFE_API_KEY=...' > .env
```

Node 22 or later. Install Google Chrome for `cdp` or Chromium for `chromium`. `agent-browser` ships with the package for the `vercel` engine.

## Engines

| Engine | Browser control |
|---|---|
| `cdp` (default) | Controls installed Chrome directly through the Chrome DevTools Protocol. |
| `chromium` | Launches installed Chromium and controls it through the same CDP implementation. |
| `vercel` | Uses Vercel's `agent-browser` CLI. |

Select an engine with `--engine` in either CLI or chat, or set `JEV_BROWSER_ENGINE`. The flag overrides a valid environment setting. The old names `fast` and `legacy` are no longer accepted. The `cdp` and `chromium` engines share the same decision and browser-control code.

Use `--chrome-bin <path>` to override the direct engine's browser binary. Otherwise `cdp` uses `JEV_CHROME_BIN` and Chrome discovery; `chromium` uses `JEV_CHROMIUM_BIN` and Chromium discovery. On macOS and Linux, `cdp` discovery can fall back to Chromium if Chrome is absent. The selected engine still determines the source profile directory. Chromium discovery only checks Chromium locations. Install Chromium before using this option; the CLI does not download it.

Chromium uses its own source profiles and stores copies under `~/.config/jev-browser/chromium`. Chrome copies stay under `~/.config/jev-browser/chrome`. The copy root uses `$XDG_CONFIG_HOME` when set, otherwise `~/.config`. With the one-shot `--cdp <port>` flag, either direct engine uses the browser at that port and opens an owned tab. The selected engine does not change the attached browser binary or profile.

```sh
./bin/jev-browser.js "open wikipedia.org" --engine cdp --profile none
./bin/jev-browser.js "open wikipedia.org" --engine chromium --profile none
./bin/jev-browser.js "open wikipedia.org" --engine vercel --profile none
```

## Usage

```
npm start -- "open wikipedia.org and search for Alan Turing, then tell me the title of the article" --profile none
./bin/jev-browser.js "open app.parallelloop.ai and check if licious account project has 3rd September artifacts"
```

The result goes to stdout as one JSON document. The trace goes to stderr. The exit code tells the outcome.

| Exit | Meaning |
|------|---------|
| 0 | done |
| 2 | blocked (sign-in wall, captcha, overlay, ambiguous page, loop, max steps, ...) |
| 3 | failed (browser or API error) |
| 4 | usage error (missing task, missing key, bad flag, unknown profile) |
| 130 | interrupted |

## Flags

| Flag | Effect |
|------|--------|
| `--engine <cdp\|chromium\|vercel>` | Which engine runs the task. Default `cdp`. The environment variable `JEV_BROWSER_ENGINE` sets the default. |
| `--profile <name\|dir\|none>` | Profile from the selected browser. A flag wins over a task mention; otherwise use the available `Parallelloop` profile. With no matching default, the direct engines use a temporary profile. `none` explicitly requests a temporary profile. |
| `--refresh-profile` | `cdp` and `chromium`. Copies the selected browser profile again, even when a copy exists. |
| `--chrome-bin <path>` | Browser binary override for `cdp` and `chromium`. Defaults to engine-specific discovery or its environment override. |
| `--url <start url>` | Start page. Skips URL resolution. |
| `--goal <act\|extract\|check>` | Skips the goal question. |
| `--headed` | Shows the window and enables the pause hand-off for sign-in walls. |
| `--cdp <port>` | One-shot attachment to a running browser. `cdp` and `chromium` use its DevTools WebSocket; `vercel` uses `agent-browser`. Launch binary and profile-copy settings do not change the attached browser. |
| `--var key=value` | A value Jev may type. Repeatable. Keys that contain pass, pin, otp, secret, token, or code are secret and redacted. |
| `--max-steps <n>` | Default 25, max 100. |
| `--step-timeout <ms>` | Per browser command. Default 30000. |
| `--run-timeout <ms>` | Default 600000. |
| `--pause-timeout <ms>` | Default 300000. |
| `--confirm <auto\|always\|never>` | `auto`: destructive actions ask on a TTY. `always`: submits ask too. `never`: destructive actions block. |
| `--dry-run` | Decides and logs, never acts. |
| `--session <name>` | Session name. Default `jev-<8 hex>`. The `vercel` engine uses it as the agent-browser session. Use a unique name per process. |
| `--model <name>` | Default `jev-latest`. |
| `--log-level <info\|debug>` | `debug` adds request states, answers, and token usage. |
| `--log-json` | One JSON object per stderr line. |
| `--keep-open` | Does not close the browser at the end. `cdp` and `chromium` require `--cdp`, leave the owned tab open, and disconnect. A browser launched through the CDP pipe exits with the process. `vercel` leaves its session open. |
| `--screenshot-dir <path>` | Saves one screenshot per step. The direct engines write `step-N.jpg`. The `vercel` engine writes `step-N.png`. |

## Direct engines: `cdp` and `chromium`

The `cdp` engine is the default. The `cdp` and `chromium` options share one direct implementation. It follows the design of `browser-use/jev-ultrafast`.

How it runs:

1. It launches the selected browser with `--remote-debugging-pipe` and uses one CDP connection. With `--cdp`, it connects to the existing browser through WebSocket.
2. It reads the page with one script inside the page. The script returns the visible text and the elements Jev can click, fill, or select.
3. It sends one Jev request per step. The request carries the page, the last actions, and the questions for the operation, the target, and the answer.
4. Before an action it checks that the page still matches the observation. When the page changed, it observes again. Readiness checks and waits have limits.
5. When code alone knows the profile (a flag, a profile named in the task, the workspace default, or none) and the start URL (a flag, a URL in the task, or one site of the catalog), it launches the selected browser and loads the first page while the plan request runs. Jev then only decides the goal. When Jev must pick the profile or the site, the plan request runs first.

Where the browser runs:

- With `--profile <name>` the engine copies the profile once to `<config-root>/jev-browser/<browser>/<profile-slug>`; `<browser>` is `chrome` for `cdp` and `chromium` for `chromium`. The configuration root is `$XDG_CONFIG_HOME` or `~/.config`. The copy keeps cookies, storage, and preferences. It skips caches, extensions, and history. Later runs reuse the copy. Use `--refresh-profile` to copy it again, for example after you signed in to a new site in the source browser.
- With `--profile none` the engine starts the selected browser with a temporary directory and deletes it at the end.
- With `--cdp <port>` the engine attaches to a browser that you started with `--remote-debugging-port=<port>`. It opens its own tab and closes only that tab at the end.

The engine closes its launched browser at the end of the run, on SIGINT, and after an error. A browser the engine launched exits when the process closes the CDP pipe, so `--keep-open` cannot keep it running; the one-shot CLI rejects `--keep-open` without `--cdp`. With `--cdp`, `--keep-open` leaves the tab open in the attached browser and disconnects the CLI so it can exit. Use `jev-chat` to keep one browser open between tasks.

Rules for both direct engines:

- `--step-timeout` sets the timeout of every CDP command.
- A JavaScript dialog (`alert`, `confirm`, `prompt`, `beforeunload`) is answered at once: alerts and `beforeunload` prompts are accepted, `confirm` and `prompt` dialogs are dismissed. The message goes to the log.
- A copied profile has one owner at a time. A second launch or refresh fails while that profile is in use. The owner holds `<copy>.jev-lock` until the browser exits. After a forced stop, a lock can remain. Check that no browser process uses the copy before you remove the lock. Existing Chrome singleton locks are preserved.
- Enter uses the submit confirmation rules. If the focused control or its form has a destructive label, Enter uses the destructive confirmation rules. A change to focus or form state cancels the pending key press.
- Scroll actions can target a panel inside the page. The engine prefers a scrollable panel with focus, then the largest visible panel.
- Known secret values are removed from model requests, logs, and result JSON. The browser still receives the original value when it fills a field.
- The profile copy is complete only when `<copy>/jev-copy.json` exists. The engine copies into a staging directory first and renames it at the end. A copy that ended early is copied again on the next run.
- With `--cdp` the engine opens its tab in the background and keeps the viewport of your window.

The Jev client keeps one HTTP connection warm for the whole run. When the plan needs no Jev request, the engine opens the connection while the browser starts. Chat mode pings the API every 45 s while it waits for input, so the first request of the next task also finds a warm connection.

Use `--engine vercel` to run the task with `agent-browser`. All three engines produce the same output JSON and the same exit codes.

The `stats` object splits the time: `duration_ms` is the whole run, `jev_ms` is the sum of the Jev request round trips, and `browser_ms` is the sum of the CDP command round trips and settle waits. The plan request and the browser launch can run at the same time, so `jev_ms` plus `browser_ms` can exceed `duration_ms`. The `vercel` engine reports `browser_ms` as 0. `stats.engine` names the engine.

## Chat mode

Chat mode runs many tasks in one browser session. You type a task, the browser does it, and the prompt comes back.

Start it:

```
npm run chat
./bin/jev-chat.js
```

The first run asks for your TypeSafe API key. Paste the key. The chat checks it with one small request and saves it to `~/.config/jev-browser/config.json` with mode 600. Later runs read the key from that file. `TYPESAFE_API_KEY` in the environment or in `.env` has priority over the file. Set `JEV_BROWSER_CONFIG` to use a different file.

To change the saved key, start with `--reset-key`, or type `/key` in the chat. When `TYPESAFE_API_KEY` is set in the environment or in `.env`, the chat uses that key and tells you so. `--reset-key` and `/key` cannot override it. Unset it to use the saved key.

Chat mode shows the browser window by default. Use `--headless` to hide it.

The browser stays open between tasks. When a task names no URL and no known site, it continues on the current page. With `cdp` or `chromium`, chat keeps one browser and one tab. `/close`, `/headed`, `/profile`, `/quit`, Ctrl-C, and the end of input close the browser.

### Commands

| Command | Effect |
|---------|--------|
| `/help` | Lists the commands and flags. |
| `/quit`, `/exit` | Closes the browser and exits. Ctrl-C at the prompt does the same. |
| `/key` | Asks for a new API key, checks it, and saves it. |
| `/headed on` or `/headed off` | Shows or hides the window for the next task. Closes an open browser first. |
| `/profile <name or none>` | Sets the selected browser profile for the next task. Closes an open browser first. |
| `/var <key=value>` | Adds a value Jev may type in later tasks. Keys with pass, pin, otp, secret, token, or code are secret. |
| `/stats` | Prints the session totals: tasks, time, tokens, requests, session name, timeouts. |
| `/url` | Prints the URL of the current page. |
| `/close` | Closes the browser. The chat stays open. |
| anything else | Runs as a task. This includes a line that starts with `/` but is not a listed command, for example a file path. |

### Flags

| Flag | Effect |
|------|--------|
| `--engine <cdp\|chromium\|vercel>` | Which engine runs the tasks. Default `cdp`, or `JEV_BROWSER_ENGINE`. |
| `--profile <name\|dir\|none>` | Profile from the selected browser. Default: the available `Parallelloop` profile. `none` requests a temporary profile. |
| `--refresh-profile` | `cdp` and `chromium`. Copies the selected browser profile again. |
| `--chrome-bin <path>` | Binary override for `cdp` and `chromium`, with the same selection rules as the one-shot CLI. |
| `--session <name>` | Session name. Default `jev-chat-<8 hex>`. |
| `--model <name>` | Default `jev-latest`. |
| `--max-steps <n>` | Default 25, max 100. |
| `--confirm <auto\|always\|never>` | Same as the one-shot CLI. |
| `--log-level <info\|debug>` | `info` prints one line per step. `debug` prints the full trace. |
| `--var <key=value>` | A value Jev may type. Repeatable. Same as the one-shot CLI. |
| `--headless` | Hides the browser window. |
| `--reset-key` | Forgets the saved key and asks for a new one. Has no effect on `TYPESAFE_API_KEY` from the environment or `.env`. |
| `--help` | Prints the usage text. |

Choose the chat engine at startup, for example `npm run chat -- --engine chromium --profile none`. Chat has no engine-switch command and does not accept `--cdp`. Chat mode takes no task argument. Use `jev-browser "<task>"` for one task.

### The metrics line

After every task the chat prints the result and one metrics line:

```
✔ done · Alan Turing - Wikipedia
  url https://en.wikipedia.org/wiki/Alan_Turing
time 4.2 s (jev 2.1 s · browser 1.6 s) · input 44,120 tokens · output 61 tokens · 2 steps · 3 requests
```

The numbers are for that task only. `time` is the run time in seconds. `jev` is the time inside Jev requests. `browser` is the time inside browser commands and settle waits. `input` and `output` are the Jev tokens. `requests` is the number of Jev requests. `/stats` and the exit message show the session totals with the same split.

## How decisions are made (`vercel` engine)

1. PLAN (0 or 1 Jev request). Code resolves the Chrome profile from the task or the flag, the start URL from the task or the site catalog, and asks Jev for the goal type: `act`, `extract`, or `check`.
2. OBSERVE (1 request per step). Code takes an interactive snapshot, the page text, and the URL. The state holds the goal, the page, up to 250 element rows, and the last 10 actions. One `operation` choice carries the options the page can use: `CLICK`, `TYPE_TEXT`, `SELECT`, `PRESS_KEY`, `SCROLL_DOWN`, `SCROLL_UP`, `GO_BACK`, `WAIT`, `OPEN_URL`, `DONE`, `BLOCKED`. Speculative heads name the target for each operation (`click_target_k`, `type_text_target`, `select_target`) and the value to type. Code reads only the head that matches the chosen operation.
3. Gate. Each action gets a risk class (`read_only`, `navigational`, `data_entry`, `submit`, `destructive`). A plain click at target confidence 0.60 or more acts at once. Lower confidence, fills on multi-field pages, selects, and submit or destructive actions go through one CONFIRM request with the chosen element in the state. Destructive actions need a human `y` on a TTY.
4. Act. Code runs the agent-browser command, waits for the page to settle, and observes again. `page_changed` is recorded per action.
5. Finish. `DONE` on an `act` goal runs VERIFY (`done_final >= 0.70`). On an `extract` goal it runs EXTRACT over page lines, then VERIFY (`answer_ok >= 0.70`). On a `check` goal the `answer_state` and `evidence` answers from the same OBSERVE are the result when `answer_state` confidence is 0.60 or more.

Every typed value is a verbatim substring of the task, a `--var` value, or a line of page text that Jev picked. Code never composes text.

### Stops

- Sign-in wall or captcha: headless runs block with `needs_sign_in` or `captcha`. Headed runs pause. Without a TTY the pause polls the page every 5 s and resumes when Jev sees an app page.
- Covered click: code scrolls the element into view and retries. On the second covered click on the same page it presses Escape and runs one RECOVER request to dismiss the overlay.
- Loops: three actions in a row without a page change, a repeated action signature, or the same page fingerprint four times in six observations end the run with `loop_detected`.
- Pages that do not fit the Jev budget lose text, history, and element chunks in a fixed order. When they still do not fit the run ends with `page_too_large`.

## Output

This abbreviated example shows the shared result format. `stats.engine` is `cdp`, `chromium`, or `vercel`. A step's `path` describes its decision path and can still be `fast`, `confirm`, or `code`; it is not an engine name.

```json
{
  "version": 1, "task": "...", "outcome": "done", "reason": "answer_state yes 0.99", "confidence": 0.99, "goal": "check",
  "answer": { "kind": "check", "answer": true, "probability": 0.99, "evidence": ["treeitem \"Licious Sept3 Session\""] },
  "final_url": "https://app.parallelloop.ai/workspace/licious-data-project/artifacts/licious-sept3-session",
  "profile": { "directory": "Profile 14", "name": "Parallelloop", "how": "task_exact" },
  "start": { "url": "https://app.parallelloop.ai", "how": "task_url", "confidence": null },
  "steps": [ { "step": 1, "operation": "CLICK", "operation_conf": 0.9, "target": { "ref": "e37", "role": "button", "name": "..." }, "target_conf": 0.35, "action": "click", "risk": "navigational", "path": "fast", "gate": "ok:high", "result": "ok" } ],
  "blocked": null, "error": null,
  "stats": { "steps": 2, "jev_requests": 4, "input_tokens": 20853, "output_tokens": 2910, "duration_ms": 22527, "model": "jev-1.13.0", "pauses": 0, "jev_ms": 18100, "browser_ms": 3900, "engine": "cdp" }
}
```

## Development

```
npm run typecheck
npm test          # offline; Jev, Chrome, and agent-browser are faked
npm run test:live # launches headless Chrome on a temporary profile with local HTTP/CDP fixtures; no external API or real key
npm run smoke     # live: the three acceptance runs, prints a pass/fail table (SMOKE_ENGINE selects cdp, chromium, or vercel; default cdp)
```

The live suite launches Chrome. It tests both direct engine names through attachment, plus browser actions, profiles, and cleanup. It does not establish that a local Chromium binary launches. Verify that separately when changing Chromium launch behavior. Smoke runs use real API access and prepared browser profiles; Chromium needs its own prepared profile.

## Limits

- One tab. No new tabs, no file uploads, no drag and drop.
- Copied profiles are separate from source profiles. A sign-in made during a pause lives in the copy under `~/.config/jev-browser/chrome` (`cdp`) or `~/.config/jev-browser/chromium` (`chromium`) or in the agent-browser temp copy (`vercel` engine). Use `--cdp` with a Chrome started with `--remote-debugging-port` to keep sessions in the source browser.
- Observations and request sizes have limits. The direct engines cap target actions at 250 plus page controls; `vercel` caps target candidates at 400. Long pages can require scrolling.
- Thresholds are first estimates. Every step record carries the raw confidences so they can be tuned.
- Jev's primary language is English. Other languages work with lower accuracy.
