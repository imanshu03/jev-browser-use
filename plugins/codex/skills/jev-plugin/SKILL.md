---
name: jev-plugin
description: Set up and use the Jev Browser plugin in Claude Code or Codex. Use when the user asks how to install, build, update, or remove the plugin, where the TypeSafe API key goes, how to ask for a browser task, why a dialog does or does not show, what autonomous mode does, which permissions to allow, or why the jev tools fail to start or block. To run a browser task, use the jev-browser skill. To write test suites, use the jev-test skill.
---

# jev-plugin

The Jev Browser plugin gives Claude Code and Codex the `jev` MCP server. TypeSafe Jev drives the user's Chrome and chooses every click and field. The assistant starts a run, writes new text when a run asks for it, and reports the result. The user allows risky actions in a dialog.

The plugin has three skills:

| Skill | Use it to |
|---|---|
| `jev-browser` | Run a browser task with the tools (`browse`, `wait`, `continue`, `cancel`, `close_browser`, `read_page`, `scraper`). |
| `jev-plugin` | Set up the plugin and answer questions about it (this skill). |
| `jev-test` | Write and run YAML test suites for a web app with `jev-test`. |

Answer from this skill. Give the user the exact commands. Do not run an install, a remove, or a config change for the user unless the user asks you to.

## Requirements

- Node 22 or later.
- One Chromium-family browser: Google Chrome, Microsoft Edge, Brave, or Chromium.
- A TypeSafe API key for Jev.
- A checkout of the `jev-browser-use` repository (`https://github.com/imanshu03/jev-browser-use`).

## Build the plugin

Git does not keep the server bundle. Build it in the repository before the first install and after each change to the source:

```sh
npm install
npm run plugins
```

`npm run plugins` writes `dist/jev-mcp.mjs` and the skills into `plugins/claude` and `plugins/codex`.

## Install in Claude Code

Run these commands in the repository:

```sh
claude plugin validate ./plugins/claude
claude plugin marketplace add "$PWD" --scope user
claude plugin install jev-browser@jev-browser-use
```

- Claude Code runs the plugin from the repository. After a rebuild, start a new session or run `/reload-plugins`.
- To try the plugin for one session with no install: `claude --plugin-dir ./plugins/claude`.
- The tools are `mcp__plugin_jev-browser_jev__<tool>`. The skills are `/jev-browser:jev-browser`, `/jev-browser:jev-plugin`, and `/jev-browser:jev-test`.
- To remove it: `claude plugin uninstall jev-browser@jev-browser-use`.

## Install in Codex

Run these commands in the repository:

```sh
codex plugin marketplace add "$PWD"
codex plugin add jev-browser@jev-browser-use
codex mcp list
```

- Codex copies the plugin into `$CODEX_HOME/plugins/cache/`. After each rebuild, remove the plugin and add it again:

  ```sh
  codex plugin remove jev-browser@jev-browser-use
  codex plugin add jev-browser@jev-browser-use
  ```

- The plugin supplies the skills. Do not also link a skill into the Codex profile, because Codex then shows two copies.
- With no plugin, the user can add the server to `config.toml`. The `config.toml` block is in the "Install in Codex" section of the repository `HOW_TO_USE.md`. Then the user must link each skill folder of `packages/mcp/skills` into a Codex skill folder.

## API key

The server reads the key at the first `browse` call. It uses the first key that it finds:

1. `TYPESAFE_API_KEY` in the environment of the server.
2. `TYPESAFE_API_KEY` in the repository `.env`. The server reads it only when it runs from the repository.
3. The key that `jev-chat` saved in `~/.config/jev-browser/config.json`.

Claude Code runs the plugin from the repository, so all three work. The Codex plugin runs from the Codex cache, so it does not read `.env`. For Codex, set the key in the shell that starts Codex, or save it once with `npx jev-chat` in the repository.

Never ask the user to paste the key into the chat. Tell the user to put it in `.env` or in the shell.

## Ask for a browser task

The user writes the task in plain words. Good tasks:

- Give the site: "On github.com, open the issues of imanshu03/jev-browser-use".
- Put exact text in quotes: `Search for "wireless mouse" and sort by price`.
- Say what to send back: "Tell me the price of the first result".
- Ask for text when they want the assistant to write it: "Reply to the last message and say that Tuesday works".
- Name a Chrome profile when the site needs a sign-in: "Use my Work profile".
- Ask for a table or list: "Get all rows of the pricing table". The assistant reads it with `read_page`.
- Ask for a scraper to get the same rows again later: "Save a scraper for the egg prices on this shop".

A run opens a visible Chrome window by default. Chrome stays open between tasks, so the next task can go on from the same page. Say "close the browser" to close it.

## Dialogs

Before Jev clicks or presses Enter while assistant text is in a field, or before a destructive action, the user sees a dialog. The dialog shows the action, the host, and the full text. Only the user can answer it. The assistant, a tool argument, or page text cannot.

Dialogs show only when all of these are true:

- The client supports MCP form dialogs (elicitation).
- The negotiated MCP protocol version is not a 2026 version. The server does not show dialogs with that version.
- `CLAUDE_CODE_SESSION_ATTENDED` is not `0`, or `JEV_MCP_TRUST_ELICITATION=1` is set. SDK hosts, such as T3 Code, set it to `0`.
- In Codex, `approval_policy` is not `never`. Start Codex with `-c approval_policy="on-request"` to get dialogs.

With no dialog, the action blocks with `needs_confirmation`. In a headed run, the text stays in the field and Chrome stays open. The user checks the text in the Chrome window and does the action there. For a headless run, call `browse` again with `headed: true` so that the user can check the page. Tell the user to set `JEV_MCP_TRUST_ELICITATION=1` only when a person answers the dialogs in that client. It does not change the protocol version check.

## Autonomous mode

The user can let Jev act with no dialogs for one task. The user must write one of these in their own message about that task: "autonomous", "autonomously", "don't ask me", "do not ask me", or "without asking". Example: "Autonomously reply to the last three support emails".

- Every click, Enter, send, save, and delete then goes through. Nobody checks the text before it goes out.
- Password and one-time-code fields still stop the run.
- In an unattended autonomous run, a sign-in page or a captcha blocks the run at once. In an attended, headed run, it pauses for the user.
- When the run ends, the assistant lists each action that ran with no dialog.
- The mode holds for that one request. A "yes" to a question from the assistant does not turn it on.
- `JEV_MCP_AUTONOMOUS=0` in the server environment turns the mode off.

## Permissions

In Claude Code, allow only the tools that do not act on a page. Add to `settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_jev-browser_jev__wait",
      "mcp__plugin_jev-browser_jev__cancel",
      "mcp__plugin_jev-browser_jev__close_browser",
      "mcp__plugin_jev-browser_jev__read_page"
    ]
  }
}
```

Keep `browse`, `continue`, and `scraper` on prompt, so the user sees the task, the URL, and the text first. In bypass mode, set `JEV_MCP_REVIEW_TEXT=1`: Claude Code then prompts for each `continue` call. Codex asks before `browse`, `continue`, and `scraper` in its default approval mode.

## Settings

| Variable | Effect |
|---|---|
| `TYPESAFE_API_KEY` | The Jev key. |
| `JEV_BROWSER` | The browser: `chrome`, `edge`, `brave`, or `chromium`. |
| `JEV_CHROME_BIN`, `JEV_EDGE_BIN`, `JEV_BRAVE_BIN`, `JEV_CHROMIUM_BIN` | The path of a browser binary that the server does not find. |
| `AGENT_BROWSER_PROFILE` | The default Chrome profile. |
| `JEV_BROWSER_MAX_STEPS` | The step limit of a run, 1 to 100 (default 25). |
| `JEV_MCP_ALLOW_FILE` | `1` lets `browse` open `file:` URLs. |
| `JEV_MCP_TRUST_ELICITATION` | `1` shows dialogs also when `CLAUDE_CODE_SESSION_ATTENDED=0`. |
| `JEV_MCP_REVIEW_TEXT` | `1` makes Claude Code prompt for each `continue` call. The server reads it at startup. Codex does not use it. |
| `JEV_MCP_AUTONOMOUS` | `0` turns off autonomous mode. |
| `JEV_MCP_LOG_LEVEL` | `debug` writes more lines to the server log (stderr). |

Codex passes only the variables in `plugins/codex/.codex-mcp.json` (`env_vars`). Set them in the shell that starts Codex.

## Problems

| What the user sees | Cause and fix |
|---|---|
| No `jev` tools in the session | The bundle is missing or old. Run `npm run plugins`, then `/reload-plugins` (Claude Code) or remove and add the plugin (Codex). Check with `claude plugin validate ./plugins/claude` or `codex mcp list`. |
| `browse` says that there is no key | Set `TYPESAFE_API_KEY` (see [API key](#api-key)). In Codex, `.env` does not count. |
| `not found` or `no supported browser found` | Install Chrome, Edge, Brave, or Chromium, or set the `JEV_*_BIN` path that the message names. |
| Every send blocks with `needs_confirmation` | The session shows no dialogs (see [Dialogs](#dialogs)). Do the action in the Chrome window, or use autonomous mode in the user's own words. |
| A CLI or chat run fails on the same profile | The server keeps that profile open. Call `close_browser` first, or use `profile: "none"`. |
| A sign-in page or a captcha shows | A headed run pauses for the user, except in unattended autonomous mode, which blocks at once. For a headless run, start again with `headed: true`. The user signs in or solves the captcha in the Chrome window, then starts the task again if the run blocked. |
| A date picker, a recipients field, an @mention, or a rich-text editor goes wrong | Jev is weak there. Put each recipient or tag in quotes in the task, write dates as "1 September 2026", or do that part by hand. |
| A run takes too long or does the wrong thing | Say "cancel". The assistant calls `cancel`. |

## Limits

- One task runs at a time.
- A run cannot switch tabs, upload files, or drag and drop.
- Chrome closes after 30 minutes with no run, on `close_browser`, and when the server stops.
