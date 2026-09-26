# jev-browser-use

`jev-browser-use` uses TypeSafe's Jev model to run browser tasks from natural-language instructions. Use the one-shot CLI for one task or `jev-chat` for repeated tasks in the same browser session. The [assistant plugin](#assistant-plugin-claude-code-and-codex) lets Claude Code or Codex run tasks through an MCP server.

Choose `cdp` for direct Chrome control, `chromium` for Chromium through the same CDP code, or `vercel` for Vercel's `agent-browser`. The default is `cdp`.

Jev selects operations, targets, offered text values, and completion answers. Code checks confidence, confirmation, page freshness, retries, and run limits before it acts. Tasks can perform actions, extract visible text, or check a condition. In plugin runs, the user's assistant can also write new text for a field that Jev chose. Jev never writes text.

The package and repository are named `jev-browser-use`. The commands remain `jev-browser` and `jev-chat`. Saved keys and profile copies continue to use the `jev-browser` configuration directory, and environment variable names remain unchanged.

## Install

```
npm install
cp .env.example .env
```

Set `TYPESAFE_API_KEY` in `.env` before running a one-shot task. [.env.example](.env.example) describes the required key and optional engine, model, profile, binary, and storage settings. Chat can ask for and save a key when the environment key is empty. Existing shell environment values take priority over `.env`.

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
| 4 | usage error (missing task, missing key, bad flag or environment value, unknown profile) |
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
| `--max-steps <n>` | Default 25, max 100. `JEV_BROWSER_MAX_STEPS` sets the default. Without this flag, a `JEV_BROWSER_MAX_STEPS` value that is not a number from 1 to 100 is a usage error. |
| `--step-timeout <ms>` | Per browser command. Default 30000. |
| `--run-timeout <ms>` | Default 600000. |
| `--pause-timeout <ms>` | Default 300000. |
| `--confirm <auto\|always\|never\|autonomous>` | `auto`: destructive actions ask on a TTY. `always`: submits ask too. `never`: destructive actions block. `autonomous`: no action asks, and no action blocks for want of a person. The step record of each action that would ask gets an `unattended` audit (see [Autonomous mode](#autonomous-mode)). `cdp` and `chromium` only: with `vercel` it is a usage error. |
| `--dry-run` | Decides and logs, never acts. |
| `--session <name>` | Session name. Default `jev-<8 hex>`. The `vercel` engine uses it as the agent-browser session. Use a unique name per process. |
| `--model <name>` | Default `jev-latest`. |
| `--log-level <info\|debug>` | `debug` adds request states, answers, and token usage. |
| `--log-json` | One JSON object per stderr line. |
| `--keep-open` | Does not close the browser at the end. `cdp` and `chromium` require `--cdp`, leave the owned tab open, and disconnect. A browser launched through the CDP pipe exits with the process. `vercel` leaves its session open. |
| `--screenshot-dir <path>` | Saves one screenshot per step. The direct engines write `step-N.jpg`. The `vercel` engine writes `step-N.png`. |

## Direct engines: `cdp` and `chromium`

The `cdp` engine is the default. The `cdp` and `chromium` options share one direct implementation. It follows the design of `browser-use/jev-ultrafast`, and parts of it are ported from that project under the MIT License. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists those parts and the license text.

How it runs:

1. It launches the selected browser with `--remote-debugging-pipe` and uses one CDP connection. With `--cdp`, it connects to the existing browser through WebSocket.
2. It reads the page with one script inside the page. The script returns the visible text and the elements Jev can click, fill, or select.
3. It normally sends one STEP request per step. Retries and stale observations can require more requests in that step. The request carries the page, the last actions, and the questions for the operation, the target, and the answer.
4. Before an action it checks that the page still matches the observation. When the page changed, it observes again. Readiness checks and waits have limits.
5. When code alone knows the profile (a flag, a profile named in the task, the workspace default, or none) and the start URL (a flag, a URL in the task, or one site of the catalog), it launches the selected browser and loads the first page while the plan request runs. Jev then only decides the goal. When Jev must pick the profile or the site, the plan request runs first.
6. After an input it waits for the work that the input started (timers and requests), at most 3 s. The next STEP request goes out early, on the page after the first frames, while that wait runs. The engine uses the answer only when the page after the wait is the same page; otherwise it asks again. Set `JEV_EARLY_DECISIONS=0` to wait first.

Text for fields: the engine types values from the task and from `--var`. For a field that needs new text (a message, a reply, a description), the CLI and chat can ask a small language model, as `browser-use/jev-ultrafast` does. Set `JEV_TEXT_MODEL` and `JEV_TEXT_API_KEY`, and optionally `JEV_TEXT_BASE_URL` (an OpenAI-compatible endpoint; default `https://openrouter.ai/api/v1`) and `JEV_TEXT_REASONING` (`none` or `low`). The model writes text only for fields that can take new text, never for a password, code, search, or other exact-value field. Before a click or Enter sends its text, the terminal prompt shows the text and asks. The request sends the redacted task, the page URL and title, the labels and current values of the fields (up to 2,000 characters of text already in the field), the recent actions with their typed text, the texts sent in this run, and up to 6,000 characters of page text to that endpoint. Without these variables, such a field blocks with the hint to pass `--var`. The plugin does not use them: there your assistant writes the text.

Where the browser runs:

- With `--profile <name>` the engine copies the profile once to `<config-root>/jev-browser/<browser>/<profile-slug>`; `<browser>` is `chrome` for `cdp` and `chromium` for `chromium`. The configuration root is `$XDG_CONFIG_HOME` or `~/.config`. The copy keeps cookies, storage, and preferences. It skips caches, extensions, and history. Later runs reuse the copy. Use `--refresh-profile` to copy it again, for example after you signed in to a new site in the source browser.
- With `--profile none` the engine starts the selected browser with a temporary directory and deletes it at the end.
- With `--cdp <port>` the engine attaches to a browser that you started with `--remote-debugging-port=<port>`. It opens its own tab and closes only that tab at the end.

The engine closes its launched browser at the end of the run, on SIGINT, and after an error. A browser the engine launched exits when the process closes the CDP pipe, so `--keep-open` cannot keep it running; the one-shot CLI rejects `--keep-open` without `--cdp`. With `--cdp`, `--keep-open` leaves the tab open in the attached browser and disconnects the CLI so it can exit. Use `jev-chat` to keep one browser open between tasks.

Rules for both direct engines:

- A rejected target or uncertain Enter choice gets one retry per step. The engine observes the page again and includes the rejection reason in the next request. A visible retry message explains what happened. Rejected input is not sent; confidence and human confirmation checks still apply. The retry does not offer the rejected target again, but the next step does. A target that repeats without effect, or that stays covered, is not offered again on that page.
- When Jev splits between pressing Enter and clicking the form's submit button (for example "Send"), the engine adds the two probabilities and clicks the button when the sum passes the Enter limit. Only the button that Enter would press qualifies: in a single-line field, the default button (the first submit control) of its form; in a textarea or editor, the default button or a send button of its form; for a form without submit controls, a button in the same form or dialog. The click still needs its own target confidence and confirmation, and it keeps the risk of the Enter: a destructive Enter stays a destructive click.
- In plugin runs, the assistant writes one text per field in a run. A second request for the same field re-asks Jev instead, so a sent message is not written and sent again. After a send took the field's text out of the page, a second request for that field blocks with `needs_text` and a hint to call `browse` again for the next text. When a fill did not stay (the editor dropped the text and the field is empty), the same text goes in one time more, with no new request, if nothing was clicked since. A text that the page moves to a pop-out, or to which it adds a signature, keeps this rule in its new field. A composer that the page replaces with a new element after a send counts as a new field: its text gets a new request and its own dialog.
- `--step-timeout` sets the timeout of every CDP command.
- A JavaScript dialog (`alert`, `confirm`, `prompt`, `beforeunload`) is answered at once: alerts and `beforeunload` prompts are accepted, `confirm` and `prompt` dialogs are dismissed. The message goes to the log.
- A copied profile has one owner at a time. A second launch or refresh fails while that profile is in use. The owner holds `<copy>.jev-lock` until the browser exits. After a forced stop, a lock can remain. Check that no browser process uses the copy before you remove the lock. Existing Chrome singleton locks are preserved.
- Enter is offered only when observed focus can use it. An empty focused editor must be filled first. The snapshot reads native fields and rich-text editors, including their current values. Enter uses the submit confirmation rules. If the focused control or its form has a destructive label, Enter uses the destructive confirmation rules. A change to focus or form state cancels the pending key press.
- When the focused field shows a suggestion list with a highlighted option (a combobox, a command menu, a mention list), Enter picks that option. Jev sees the option as `enter_picks`. The Enter label and the confirmation dialog name it, for example `press Enter on "Q3 Roadmap | Send message | picks Ask AI: …"`, and a destructive word in the option makes Enter destructive. When Jev splits between Enter and a click on that same option, the engine adds the two probabilities, as for the submit button. The engine never changes Enter into a click on another option. A change of the list cancels the pending key press.
- After a fill, a click, or Enter, the engine waits for the work that the input started before it observes the page: the page timers shorter than 1 s that the input set (a debounce), the requests that started after the input, and a new `aria-busy` marker or progress bar (alone, at most 0.5 s). The wait is at most 3 s per input. So a debounced search shows its results, and a saved form shows its saved state, before the next action runs: the next request can go out on the page after the first frames (item 6), but the engine acts on its answer only when the page after the wait is the same. An input that starts no work waits about four frames. The engine reads the requests over CDP; it does not change `fetch` in the page.
- Before DONE or BLOCKED ends the run, the engine checks that the page did not change during the Jev request. When it changed (late results, a finished save), Jev decides again on the new page, one time per step.
- WAIT observes the page until it changed and holds still, at most 1.5 s. A spinner alone does not end the wait.
- Scroll actions can target a panel inside the page. The engine prefers a scrollable panel with focus, then the largest visible panel.
- Known secret values are removed from model requests, logs, and result JSON. The browser still receives the original value when it fills a field.
- The profile copy is complete only when `<copy>/jev-copy.json` exists. The engine copies into a staging directory first and renames it at the end. A copy that ended early is copied again on the next run.
- With `--cdp` the engine opens its tab in the background and keeps the viewport of your window.

The Jev client keeps up to two HTTP connections warm. The engine opens them while the browser starts, or while the page loads after a plan request. Chat mode pings the API every 45 s while it waits for input, so the first request of the next task also finds a warm connection.

Use `--engine vercel` to run the task with `agent-browser`. All three engines produce the same output JSON and the same exit codes.

The `stats` object splits the time: `duration_ms` is the whole run, `jev_ms` is the sum of the Jev request round trips, and `browser_ms` is the sum of the CDP command round trips and settle waits. The plan request and the browser launch can run at the same time, so `jev_ms` plus `browser_ms` can exceed `duration_ms`. The `vercel` engine reports `browser_ms` as 0. `stats.engine` names the engine.

## Chat mode

Chat mode runs many tasks in one browser session. You type a task, the browser does it, and the prompt comes back.

Start it:

```
npm run chat
./bin/jev-chat.js
```

If no environment or saved key is available, chat asks for your TypeSafe API key. Paste the key. The chat checks it with one small request and saves it to `~/.config/jev-browser/config.json` with mode 600. Later runs read the key from that file. `TYPESAFE_API_KEY` in the environment or in `.env` has priority over the file. Set `JEV_BROWSER_CONFIG` to use a different file.

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
| `--confirm <auto\|always\|never\|autonomous>` | Same as the one-shot CLI. |
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

## Assistant plugin (Claude Code and Codex)

The plugin lets Claude Code or Codex run browser tasks with the direct engines. The assistant starts a run with a tool call. Jev chooses every action, as in the CLI. When a form needs new text, such as a reply, the run asks the assistant to write it (see [Assistant-written text](#assistant-written-text-plugin-runs-only)). Before Jev clicks or presses Enter while that text is in a field, the user must allow the action in a dialog. The user can turn off the dialogs of one task with their own words (see [Autonomous mode](#autonomous-mode)).

[plugin/](plugin/) holds the manifests for both clients, the MCP server configuration, and the `jev-browser` skill. The server is one bundled file, `plugin/dist/jev-mcp.mjs`. Git ignores it, so build it after [Install](#install) and after each source change:

```sh
npm run build:mcp
```

The MCP server is not a public command. It supports the `cdp` and `chromium` engines.

### Install in Claude Code

```sh
claude plugin validate ./plugin
claude plugin marketplace add "$PWD" --scope user
claude plugin install jev-browser@jev-browser-use
```

Claude Code loads the plugin from this repository. After a rebuild, start a new session or run `/reload-plugins`. To load the plugin for one session without an install, run `claude --plugin-dir ./plugin`. The tools are named `mcp__plugin_jev-browser_jev__<tool>`. The skill is `/jev-browser:jev-browser`.

### Install in Codex

```sh
codex plugin marketplace add "$PWD"
codex plugin add jev-browser@jev-browser-use
codex mcp list
```

Codex copies the plugin, with the bundle, to its cache under `$CODEX_HOME/plugins/cache/`. After each rebuild, install the plugin again:

```sh
codex plugin remove jev-browser@jev-browser-use
codex plugin add jev-browser@jev-browser-use
```

The plugin supplies the skill `jev-browser:jev-browser`. Do not also link the skill into the Codex profile, because Codex then shows two copies.

If you do not use the Codex plugin, add the server to the Codex `config.toml`. Replace `<repo>` with the absolute path of this repository:

```toml
[mcp_servers.jev]
command = "node"
args = ["<repo>/plugin/dist/jev-mcp.mjs"]
env_vars = ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_DEFAULT_MODEL", "JEV_BROWSER_CONFIG", "XDG_CONFIG_HOME",
  "JEV_BROWSER_ENGINE", "JEV_BROWSER_MAX_STEPS", "AGENT_BROWSER_PROFILE", "JEV_CHROME_BIN", "JEV_CHROMIUM_BIN",
  "JEV_MCP_LOG_LEVEL", "JEV_MCP_ALLOW_FILE", "JEV_MCP_TRUST_ELICITATION", "JEV_MCP_AUTONOMOUS", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

This setup does not install the skill. Link it into a Codex skill folder, for example `ln -s <repo>/plugin/skills/jev-browser ~/.agents/skills/jev-browser`. With the `agent-skill` tool, run `ln -s <repo>/plugin/skills/jev-browser ~/.agent-skills/skills/jev-browser && agent-skill link jev-browser --to codex-pl`. Do not link it to Claude Code profiles; the Claude Code plugin supplies it there.

### API key

The server reads the key at the first `browse` call, not at startup. It uses the first key that it finds:

1. `TYPESAFE_API_KEY` in the server environment.
2. `TYPESAFE_API_KEY` in the package `.env`. The server reads `.env` only when it runs from this repository. It sets only the keys that the environment does not set, so `TYPESAFE_API_KEY=""` in the environment stops the `.env` key from loading.
3. The key that `jev-chat` saved in `~/.config/jev-browser/config.json`, or in the file that `JEV_BROWSER_CONFIG` names.

Claude Code gives the server its full environment and runs the plugin from this repository, so all three sources work. The Codex plugin runs from the Codex cache, so it does not read `.env`. Codex passes only the variables in `env_vars` ([plugin/.codex-mcp.json](plugin/.codex-mcp.json)). The list also holds `DISPLAY`, `WAYLAND_DISPLAY`, and `XDG_RUNTIME_DIR`, so that a headed Chrome can start on a Linux desktop. Codex skips a variable that is not set. With the Codex plugin, set the key in the shell that starts Codex, or save it with `jev-chat`. The `config.toml` setup runs from this repository and reads `.env`.

Without a key, `browse` returns an error that tells how to add one. When the server runs from a copy outside this repository, such as the Codex cache, the error does not name the `.env` file.

### Tools

| Tool | Effect |
|---|---|
| `browse` | Starts a task. `task` is required. Optional: `url`, `profile` (a name, a directory, or `none`), `headed` (default `true`), `engine` (`cdp` or `chromium`), `goal`, `vars`, `max_steps`, `confirm` (`auto`, `always`, `never`, or `autonomous`; default `auto`), `user_said` (with `autonomous` only, 1 to 300 characters), `dry_run`, and `wait_s`. Without `url`, the task continues on the page where the last run ended. A `url` loads the page again. |
| `wait` | Waits for the run to change, then returns its state. It does not change the run. |
| `continue` | Gives the text that a run asks for (`values`, field id to text), or declines the request (`decline`, a short reason). |
| `cancel` | Stops a run. |
| `close_browser` | Closes the Chrome that the server opened. It returns an error while a run is active. |

`browse`, `wait`, and `continue` wait up to `wait_s` seconds (default 40, maximum 50). They return earlier when the run needs the assistant or ends. Each result holds the run state as text JSON and as `structuredContent`. The field `next` tells the assistant what to do.

`isError` means that the call was wrong: for example, an unknown run, a stale text request, a bad URL, an unknown profile, no key, a new task while another run is active, or `confirm: "autonomous"` without the user's words in `user_said`. The error text states the correct call. `blocked` and `failed` are normal results.

### Run statuses

| Status | Meaning |
|---|---|
| `running` | The run is working. The assistant calls `wait`. |
| `needs_text` | The run needs new text. `text_request` lists the fields. The assistant calls `continue`. |
| `confirming` | A dialog asks the user. The assistant calls `wait` at once. It cannot answer the dialog. |
| `paused` | The user must sign in or solve a check in the Chrome window. The run continues when the page is clear. |
| `stopping` | A cancel is in progress. |
| `done`, `blocked`, `failed` | The run ended. `result` holds the reason, the answer, the final URL, and the blocked or error details. `result.text_not_typed` lists the fields where the assistant wrote text that Jev did not type, for example an optional Subject that Jev left empty before it sent the form. A field that showed the text one step late counts as typed when a later step shows the text. `result.sent_texts` lists the texts that a send took out of the page. The assistant must not send them again. |

A `blocked` result with the kind `needs_confirmation` has these causes:

- The user saw the dialog and did not allow the action. `next` says that the dialog was declined.
- The session cannot show a dialog, or the unsent text is too long for one dialog. The hint tells the user to check the text in the Chrome window and do the action there. For a headless run, the hint says to run the task again with `headed: true`, because the user cannot see a headless window.
- The run has `confirm: "never"`. The hint says to call `browse` again with `confirm: "auto"`.
- No call opened the dialog in 60 s, or the dialog got no answer in time. The hint says that no one answered, not that the user declined.

### Dialogs

The server asks the user through an MCP form dialog (elicitation). The assistant cannot answer it, and no tool argument allows one action. Only [autonomous mode](#autonomous-mode), which the user turns on in their own words, turns off the dialogs of a run. A dialog asks:

- To allow a click or Enter while assistant text is in a field, a destructive action, or a submit with `confirm: "always"`. The dialog shows the action, the host, and each unsent text in full with its length. For a send, a submit, or Enter, it also shows what the action sends: the text of each message field and each mention in it, also text that the assistant did not write. Select **Allow** to let Jev continue.
- To use a Chrome profile when Jev is not sure which profile the task names. If the user does not allow it, the run uses the workspace default.

The server shows dialogs only when all of these conditions are true:

- The client supports form dialogs.
- The negotiated MCP protocol version is not a 2026 version.
- `CLAUDE_CODE_SESSION_ATTENDED` is not `0`, or `JEV_MCP_TRUST_ELICITATION=1` is set.

SDK hosts, for example T3 Code, set `CLAUDE_CODE_SESSION_ATTENDED=0`. Without dialogs, an action that needs one blocks with `needs_confirmation`. The assistant text stays in the field, and the Chrome window stays open. Check the text there and do the action yourself. Set `JEV_MCP_TRUST_ELICITATION=1` only when a person answers the dialogs in that client.

Codex with `approval_policy = "never"` declines every dialog, so each action that needs a dialog blocks with `needs_confirmation`. The `codex-pl` profile uses `never`. To get dialogs, start Codex with `-c approval_policy="on-request"`. In autonomous mode no dialog opens, so a run goes to its end also with `never`.

### Autonomous mode

The user can let Jev act with no dialogs for one task. The user writes "autonomous", "autonomously", "don't ask me", "do not ask me", or "without asking" in their own message. The assistant then calls `browse` with `confirm: "autonomous"` and puts those words in `user_said`. In that run:

- Every click, Enter, send, save, submit, and delete goes on with no dialog, also while assistant text is in a field, and also for text of more than 6,000 characters. No action blocks with `needs_confirmation`.
- The run does not ask which profile to use. When Jev is not sure, the run uses the workspace default, as a session without dialogs does. Pass `profile` when the user names one.
- When no person answers in the session, a sign-in wall or a check blocks the run at once. When a person can answer, a headed run pauses as usual.
- Password and one-time-code fields still stop the run, because they need a value that only the user can type. The same applies to a field that needs an exact value that the user did not give. The confidence checks do not change.

The server refuses the call (`isError`) in these cases:

- `confirm: "autonomous"` without `user_said`, or with `user_said` that does not hold one of the words above.
- `user_said` with another `confirm` value.
- `JEV_MCP_AUTONOMOUS=0` in the server environment. This variable only turns the mode off. Nothing is needed to turn it on.
- A `browse` call with the task of the active run and another `confirm` value. No call turns the mode on or off in the middle of a run.

The mode holds for one run. Each view of the run has `autonomous`: `user_said`, `unattended_actions` (the number of audited actions so far), and `profile` (when the run has ended). The result lists each action that ran with no dialog in `result.unattended`: the step, the action, the host, the risk, the step result, `why` (`destructive`, `submit`, `unsent_text`, or `replaced`), the assistant texts in fields at the action, and up to 8 other non-empty fields of the form. The list leaves out credential, secret, payment, and one-time-code fields. Each text has `left`: `true` when no field holds the text after the action, or when a new page loaded; `false` when a field still holds it; `null` when this is not known. Some pages keep the text in the field after a send, so a Send entry can show `left: false`. A fill that replaces text that the run did not type is in the list too, with `replaced_chars`. A fill that adds text at the end of a field replaces nothing, so it is not in the list. A date that code types into a date field is not in the list either. An entry with the result `failed` may have run. A text that an earlier entry shows becomes "same as step N". The CLI result has the same audit in `steps[].unattended`. `next` tells the assistant to report every entry.

Risks of this mode:

- Nobody checks the text before it goes out. The assistant can write wrong text, and page text can try to change what the assistant writes.
- Page text can tell the assistant to turn on the mode. The server checks only that `user_said` holds the words. It cannot see the user's message, so an assistant that makes up the words passes the check. The skill tells the assistant to use only the user's own message.
- Jev can choose a wrong target, for example Enter in a command bar that sends a chat message. The dialog was the last check against such an action. The audit shows it only after it ran.
- A run can go on after its goal, up to `max_steps`, with no dialog to stop it.

`JEV_MCP_REVIEW_TEXT=1` and the client permission prompts still ask. With `browse` on prompt, the prompt shows `confirm` and `user_said` before the run starts.

### Permissions

In Claude Code, add allow rules only for the three tools that do not act on a page:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_jev-browser_jev__wait",
      "mcp__plugin_jev-browser_jev__cancel",
      "mcp__plugin_jev-browser_jev__close_browser"
    ]
  }
}
```

Keep `browse` and `continue` on prompt. The prompt shows the task, the URL, `confirm`, `user_said`, and the text before a page gets them. In bypass mode, set `JEV_MCP_REVIEW_TEXT=1`. Claude Code then prompts for every `continue` call, also in bypass mode, and shows the values.

In its default approval mode, Codex asks before `browse` and `continue`, because their annotations mark them as destructive. It does not ask before `wait`, `cancel`, and `close_browser`.

### URLs

`browse.url` must be an `http` or `https` URL. Set `JEV_MCP_ALLOW_FILE=1` to allow `file:` URLs, for example for local test pages. Other schemes, such as `javascript:` and `chrome:`, return an error.

### Environment

| Variable | Effect |
|---|---|
| `JEV_MCP_LOG_LEVEL` | `debug` adds request states and answers to the server log. The log goes to stderr. |
| `JEV_MCP_ALLOW_FILE` | `1` lets `browse.url` use `file:` URLs. |
| `JEV_MCP_TRUST_ELICITATION` | `1` shows dialogs also when `CLAUDE_CODE_SESSION_ATTENDED=0`. |
| `JEV_MCP_REVIEW_TEXT` | `1` makes Claude Code prompt for every `continue` call, also in bypass mode. The server reads it at startup. Codex does not use it. |
| `JEV_MCP_AUTONOMOUS` | `0` turns off [autonomous mode](#autonomous-mode): `browse` refuses `confirm: "autonomous"`. |

The server also reads `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL`, `JEV_BROWSER_ENGINE`, `JEV_BROWSER_MAX_STEPS`, `AGENT_BROWSER_PROFILE`, `JEV_CHROME_BIN`, `JEV_CHROMIUM_BIN`, `JEV_BROWSER_CONFIG`, and `XDG_CONFIG_HOME`. `JEV_BROWSER_ENGINE=vercel` or an unknown engine gives `cdp` and a warning. A `JEV_BROWSER_MAX_STEPS` value that is not a number from 1 to 100 gives 25 and a warning. The server ignores `AGENT_BROWSER_SESSION`.

### Plugin limits

- The server runs one task at a time. A `browse` call with the same task as the active run returns that run.
- A run can send 3 text requests. A request has at most 4 fields and 4,000 characters of text in total. The assistant has 300 s to answer. This wait does not count toward the run timeout. After 3 rejected answers to one request, the run blocks with `needs_text`.
- A dialog opens only in a tool call that started 5 s ago or less. Otherwise the call returns `confirming`, and the next `wait` opens the dialog. If no call opens a dialog in 60 s, Jev does not do the action, and the hint says that no dialog was shown. A dialog stays open for at most 100 s. These times keep each call below the 2-minute point where Claude Code moves a tool call to the background.
- Unsent text of more than 6,000 characters blocks the action with `needs_confirmation`, because one dialog cannot show it. Autonomous mode shows no dialog, so it does not block there.
- One result is at most about 7,000 tokens. The server cuts the page text first, then the older step lines (down to 3), then answer strings (to 2,000 characters).
- The server keeps the last 10 finished runs. A restart forgets them.
- Chrome stays open between runs, with one tab. A run with another engine, window mode, or profile closes it and launches a new one. Chrome closes on `close_browser`, after 30 minutes with no run, and when the server exits. While the server keeps a profile copy open, a CLI or chat run on the same profile fails. Call `close_browser` first, or use `profile: "none"`.
- `cancel` waits 5 s for the run to stop, then closes Chrome.
- After a run ends, the server keeps the Jev connection warm for 10 minutes.

## Text entry and submission

For an exact message or search query, quote the text in the task or supply a variable:

```sh
./bin/jev-browser.js 'Open wikipedia.org, type "Alan Turing" in the search field, and open the article' --profile none
npm run chat -- --engine cdp --log-level debug
```

In chat, a task can be:

```text
Open app.parallelloop.ai with the Parallelloop profile. Start a new chat, type “List my latest meetings”, and send it.
```

The direct engines support native text fields and `contenteditable` editors. Observations include the editor value and focus. An observed empty editor cannot receive Enter through the task loop; fill and submit are separate actions. Rich-text value changes invalidate a pending keyboard action.

A fill never presses a key that a page can read. It clicks the field, waits for the page, and puts the selection in place with an editing command that has no key. It types only while the field has focus. When the page moves focus to another element, for example a hidden input, the fill types nothing: the run observes again one time, and then it blocks with the reason.

A multiline field can hold text that the run did not type, such as a document, a draft, or project instructions. Then a second question asks Jev if the new text replaces that text or goes at its end. A replace needs a confidence of 0.80, and an add needs 0.60. Below that, the run asks again one time, and then it blocks with a hint. To make the task clear, say "at the end" or "replace" in it. The added text goes on a new line in a text area, after one space in a chat composer, and into a new paragraph in a document editor, one paragraph per line. A text with line breaks cannot go at the end of a chat composer, because a new line can send the message there. After an add, the run checks that the field shows the new text and still holds its old lines. If the check fails, the run blocks before any save or send. The run does not add the same text two times.

Some Save or Delete buttons open a confirmation popup or dialog, for example "Save Changes" with "Confirm". The task is not done until that step closes. Jev cannot report DONE while the step is open. After two tries, the run blocks with a hint.

Quoted text makes the requested value explicit. A `--var` value is the most reliable: it skips the value confidence check. (In plugin runs, the assistant writes the vars, so a var needs the value confidence check. See "Vars" below.) Each field gets its own value question that names the field, so every field of a form can take its own value. A message field never takes the whole task or a clause of it: "send hello team, standup moved to 11 am" without quotes blocks with a value hint, so the instruction is not sent as the message. A description of the text ("with a short change note") and the first words of a long unquoted value ("set the subject to Quarterly budget review for Q3 planning") are not typed either: quote the value or pass it with `--var`. An unquoted value ends at "and" before the next step, so "rename it to budget review and save it" types "budget review", and "rename the file to budget and click Save" types "budget". A button name in quotes, backticks, or bold counts as the name ("and click \"Save\""). Only a sentence dot ends a value, so "rename the file to report.pdf" types "report.pdf". A title such as "Show and Tell" or "Media and press releases" stays whole. When the words after "and" can be a step or part of the value ("search for how to install and run Python", "set the title to Weekly sync and open Settings", "type hello and send it to the team"), Jev gets both values and chooses. A field that hides the longer value by its length still offers both. A message after "type" or "write", or a sentence after "reply with", keeps all its words up to the step that sends it or watches the reply: "type hello and press the Enter key" and "type hello and wait for the response" type "hello", and "type we will review and approve it" types all of it. The model still needs to select the correct field and pass the action checks. A task instruction does not establish that the task succeeded. Check the trace for a fill action and the result for completion evidence.

**Dates.** The direct engines show a date widget as one date field: a native date input, or a group of month, day, and year boxes such as M / D / YYYY. Jev chooses which task date goes into which field. Code types the date in the field's own format and reads the field back. Write a date with the month as a word or as YYYY-MM-DD ("1 September 2026", "2026-09-01"). A numeric date such as 9/1/2026 goes only into a field of the same shape, because its day and month can change places. In another field the run blocks with a hint. A date without a year and a relative date ("next Friday") also block. "from A to B" and "between A and B" name a range. A button of a date picker ("Update", "Done", "OK") and DONE wait until the date fields show the requested dates. The direct engines do not click calendar days for you: a calendar without date fields only blocks a wrong range. See section 5.7 of [DESIGN.md](DESIGN.md).

Text values come from task spans or user variables. The `vercel` engine can also select page-derived values. The CLI and chat do not generate text. In plugin runs, the user's assistant can write new text for one field at a time, with the rules below. Native password fields are excluded from the direct engines' action snapshots; use headed sign-in when needed.

**Chip fields.** A recipients, participants, or tags field adds each value as a chip. Many of these fields add a chip only when you press Enter or click a suggestion. A typed value that is not a chip does not go with the form. The direct engines check such a field before the run leaves it or submits the form:

- The run learns that a field is a chip field when Enter or a click clears its text and a new chip with a remove button shows in front of it. A combobox with a multiselect list is also a chip field.
- Before a fill of another field, a submit click, Enter in another field, or DONE, the run reads the suggestion list of the field. The page settled after the last input, so a slow search has shown its results. When the list shows no options, the run adds the value with a script Enter. A script Enter cannot submit a form. When the list shows options, the run does not press Enter, because Enter can add an option instead of the typed text. The run asks Jev again, with a hint that names the field and the value.
- When the value is still not a chip after that hint, the run blocks `ambiguous` with "typed value not added". It never sends the form without the value.
- Jev's own Enter in a chip field is a script Enter first. When the page ignores it, the normal Enter follows, so Enter still starts a search in a search box with filter chips. An Enter that picks a highlighted option is always the normal Enter, and its confirmation names the option.
- A field that only looks like a chip field (chips with remove buttons that this run did not add) gets the hint one time and no more.
- Before its first chip, a field without ARIA looks like a plain field. The first value then depends on Jev's Enter. An unnamed field shows as "textbox" after its first chip.

### Mentions

A task can ask Jev to mention or tag a person, for example "mention Ann Lee and ask her for the report status", "Tag @ann.lee and Bob Roy in the chat", or "ask @Research Agent to summarise the Q3 notes". The names after mention, tag, ping, @-mention, or at-mention count, and so does every @handle. Jev then adds each person with the message field's own mention picker: it clicks the Mention or @ button, the name, and the picker's Done or Add button. It sends only when the field shows the mention. Typed text such as "@Ann Lee" is not a mention, so a message field never takes a name to mention as its text.

Code also checks these things:

- A send, a submit, or Enter while an open picker holds a checked name that is not added asks Jev again, and the reason names the picker's Done button. When Jev chooses a send again, the run blocks.
- A send of a mention that the run added and that the task does not name asks Jev again. Jev can type the message again, which removes the mention. Otherwise the run blocks, and nothing is sent.
- A fill of the message after the run's mention adds the text at the end and keeps the mention.
- In plugin runs, the send dialog shows the message text and each mention.

Jev cannot type "@" at the cursor, so a field without a Mention or @ button cannot get a mention. In plugin runs, when the text goes in before the mention, each click in the picker needs a dialog.

### Assistant-written text (plugin runs only)

When a form needs new text, such as a reply, Jev can choose `generate` for the field instead of an offered value. The run then gets the status `needs_text`, and the assistant writes the text. Jev still chooses the field and every action.

- **Writable fields.** Only a textarea, a rich-text editor, or an `<input type="text">` with the role `textbox` can take assistant text. Search boxes, comboboxes, number fields, email, phone, and URL inputs, date fields, and boxes of 4 characters or less cannot. Fields with an exact-value `autocomplete` token (for example `email`, `tel`, `username`, `cc-number`, or an address token) cannot. Fields with labels such as To, Cc, Bcc, From, recipient, phone, amount, price, card number, IBAN, account number, street, postal code, user name, URL, website, search, API key, token, or a credential label cannot. A chip field that the run learned, or a combobox with a multiselect list, cannot. For such a field, the run blocks with `needs_credential` and a hint to ask the user for the exact text. The word "search" does not stop a multiline field: a composer such as "Search or ask AI anything..." can take assistant text.
- **One request.** A request holds the field that Jev chose (`f1`, required) and up to 3 other empty writable fields of the same form, in page order. It also holds the task, the page URL and title, the last 5 actions, and up to 6,000 characters of page text.
- **Text at the end of a field.** When Jev adds the text at the end of a field that holds other text, the field in the request has `mode: "append"`, and its `current_value` shows up to 2,000 characters of the field. The assistant writes only the new text. When Jev replaces that text, the field has no `mode`, and `current_value` is also long.
- **Checks.** Each text must fit the field's `max_chars`, and all texts of one request together must fit 4,000 characters. A text must not hold a secret `--var` value of 4 or more characters, the API key, or text that looks like a key or token. The run removes control and invisible characters. In a single-line field, a line break becomes a space. An error names the field and the rule, never the text.
- **Binding and single use.** Each text is bound to the field it was written for, in that document. Jev can type it only into that field, and only one time. If the page changes during the wait, the run observes the page again and asks Jev again; the text stays ready for its field. If a new document loads during the wait, the texts of that request are dropped, and Jev can ask for new text. Jev never sees a text that is bound to another document. When a field of the request is empty again, for example after a send, the unused texts of that request are dropped.
- **Unsent-text gate.** While a field holds assistant text that no click or Enter has sent, every click and every Enter needs a dialog, whatever the label. This includes "Comment" buttons and icon buttons. The dialog shows each unsent text in full. An allowed action does not end the gate: the next click asks again while the text stays in its field. A native field or rich-text editor out of view still counts. A page can remove the field and show the same text in a new field, for example in a Write and Preview tab pair, a list that loads rows as you scroll, or a pop-out editor. The gate then follows the text to the new field, also when that field changes the text a little (a list, curly quotes, capitals, or a length limit), and also when that field holds another text of the assistant. A field that held the text before Jev typed it does not take the gate while it keeps its value. A search query or another text that Jev typed does not take the gate of a sent short reply that it contains ("Sure" in "sure thing contract"). While no rendered field holds the text, a click does not ask. The gate ends when the field is empty and no other field holds the text, or when a new document loads. When the page writes a moved text over another assistant text, that other text keeps its gate: it gates again when a field shows it. A fill that the field did not show right away still gates the next click, also after a scroll, a dropdown selection, going back, and in the next plugin run: some editors keep the text where the page does not show it. Only an allowed click or Enter ends that: its dialog showed the text. In autonomous mode the click or Enter goes on with no dialog, and its audit entry shows the text. A fill after which the page did not settle gates the same way. A later fill of the field keeps the gate, and the dialog then shows the new value (`<secret>` for a secret value). When the later fill did not show either, the dialog also shows the earlier text, because the page can hold both. Typing, selecting a dropdown option, scrolling, waiting, and going back do not need a dialog.
- **Later runs.** The server keeps the unsent text with its tab. When a run ends before the text is sent, for example after a declined dialog, the next `browse` call on the same tab has the same gate. The gate ends there by the same rules. `close_browser` and a new tab end it.
- **Vars.** A value question shows each non-secret var with its key, so a key that names the field helps Jev. A var needs the value confidence (0.55), as a task value does. When Jev splits between a var and new text for a field (for example a var `brief` for "Describe the workflow"), the run asks Jev again with only the vars. A var at 0.75 or more goes in. Otherwise the run asks again without the vars, and the assistant can write the text. A general key such as `text` can still put a var into a wrong field.
- **Sends.** A click on a control with a send word (Send, Post, Reply, Comment, Publish, Share, Tweet, Queue) or an Enter, while assistant text is in a field, is a send when the text then leaves the page. An Enter that picks an option in a popup is a send only when the option has a send word. The next step waits up to 1.5 s while a field still shows the text. After a send, Jev can end the run when the task ends with that send. A later request for the sent field blocks with `needs_text`. A text request after a send lists the sent texts in `sent_texts`, and the result lists them in `result.sent_texts`. A send button in the form of a field with unsent assistant text needs only the submit target confidence (0.50), because the dialog asks the user before the click. An autonomous run has no dialog, so it keeps 0.70.
- **Task and vars.** In plugin runs the assistant writes the task and the vars. A non-secret task or var value typed into a multiline field therefore also counts as unsent text. The run removes control and invisible characters from every non-secret task or var value before it types it, so the page gets the text that the dialog shows. A secret value is typed as it is. A credential field never takes a value from the assistant: the user types it in the Chrome window.

### When a run stops

- A low-confidence target or Enter decision gets one retry per step. The direct engines observe again, include the rejection reason, and print a retry message. If uncertainty remains, the run can return `ambiguous`.
- A stale page or changed focus causes a new observation and decision within a separate retry limit. Input is not sent from the stale decision.
- A fill that the page refuses gets one retry, and then the run blocks with the reason. Examples: focus moved away from the field, the selection is not in place, or a text with line breaks goes at the end of a chat composer. A fill that changed the field and then failed its check blocks at once, with a hint to check the field before any save or send.
- Enter requires submit checks. Labels such as Send can require human confirmation under the current risk rules. A required prompt without an interactive terminal blocks the action. With `--confirm autonomous`, no action asks.
- Repeated actions without a page change can return `loop_detected`. Sign-in walls, confirmation requirements, and run limits also produce blocked results with a reason.
- `ambiguous` with "typed value not added" means that a chip field still holds a typed value that it did not add as a chip. The form was not sent. Add the value in that field (press Enter or click its suggestion), then submit. `ambiguous` with "Enter in ... added ..., not ..." means that Enter added an option instead of the typed value. Check the chips of that field before you submit.
- In plugin runs, `needs_text` means that the run did not get usable new text: the assistant declined, no text came in 300 s, the text failed its checks, or the run used its 3 text requests. Without the text model the CLI and chat never return `needs_text`; with it, a decline, a timeout, or text that fails its checks blocks `needs_text`.

Use `--log-level debug` to inspect the request state and decisions. Restart chat after a source update so the process loads the changed code. A successful local editor test does not establish that every site's editor works.

## Vercel engine

`--engine vercel` uses the `agent-browser` adapter. It shares planning, result types, and exit codes with the direct engines, but uses its own observation, confirmation, recovery, and completion flow. See [DESIGN.md](DESIGN.md) for the engine-specific rules and thresholds.

## Output

This abbreviated example shows the shared result format. `stats.engine` is `cdp`, `chromium`, or `vercel`. A step's `path` describes its decision path and can still be `fast`, `confirm`, or `code`; it is not an engine name.

```json
{
  "version": 1, "task": "...", "outcome": "done", "reason": "answer_state yes 0.99", "confidence": 0.99, "goal": "check",
  "answer": { "kind": "check", "answer": true, "probability": 0.99, "evidence": ["treeitem \"Licious Sept3 Session\""] },
  "final_url": "https://app.parallelloop.ai/workspace/licious-data-project/artifacts/licious-sept3-session",
  "profile": { "directory": "Profile 14", "name": "Parallelloop", "how": "task_exact" },
  "start": { "url": "https://app.parallelloop.ai", "how": "task_url", "confidence": null },
  "steps": [ { "step": 1, "operation": "CLICK", "operation_conf": 0.9, "target": { "ref": "e37", "role": "button", "name": "..." }, "target_conf": 0.35, "action": "click", "risk": "navigational", "path": "fast", "gate": "ok 0.35 (navigational)", "result": "ok" } ],
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
npm run build:mcp # bundles the MCP server into plugin/dist/jev-mcp.mjs, which the plugin runs
npm run mcp       # runs the MCP server from src/mcp/main.ts through tsx, on stdio, with the package .env
```

The live suite launches Chrome. It tests both direct engine names through attachment, native and rich-text entry, editor freshness, browser actions, profiles, and cleanup. It also runs the MCP server on the [reply fixture](test/fixtures/live/reply.html) with a scripted Jev and an in-memory client that answers the dialogs. It does not establish that a local Chromium binary launches. Verify that separately when changing Chromium launch behavior. Smoke runs use real API access and prepared browser profiles; Chromium needs its own prepared profile.

Run `npm run build:mcp` after each change to `src/`, because the plugin runs the bundle and not the source. Git ignores `plugin/dist/`.

## Limits

- Each direct session creates one owned tab. Tasks do not support switching between tabs, file uploads, or drag and drop.
- Copied profiles are separate from source profiles. A sign-in made during a pause lives in the copy under `~/.config/jev-browser/chrome` (`cdp`) or `~/.config/jev-browser/chromium` (`chromium`) or in the agent-browser temp copy (`vercel` engine). Use `--cdp` with a Chrome started with `--remote-debugging-port` to keep sessions in the source browser.
- Observations and request sizes have limits. The direct engines cap target actions at 250 plus page controls; `vercel` caps target candidates at 400. Long pages can require scrolling.
- Thresholds are first estimates. Every step record carries the raw confidences so they can be tuned.
