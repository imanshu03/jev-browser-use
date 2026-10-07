# jev-browser-use

Run browser tasks from plain-language instructions. TypeSafe's Jev model chooses each click, field, and answer in your browser. Code checks confidence, risk, and page freshness before each action, and asks you before a risky one.

Use it as:

- **A command line:** `jev-browser` runs one task, and `jev-chat` runs many tasks in one browser.
- **A Claude Code or Codex plugin:** your assistant starts browser tasks and writes new text, such as replies, when a form needs it.
- **Scrapers:** `jev-scrape` saves the path to a table or a list once, then gets the rows again with no model call. It repairs itself when the site changes.
- **Web app tests:** `jev-test` runs YAML test cases. Jev records each plain-language step once, and later runs replay it with code.

Read [HOW_TO_USE.md](HOW_TO_USE.md) for every command, flag, and rule.

## Quick start

You need Node 22 or later, one of Google Chrome, Microsoft Edge, Brave, or Chromium, and a TypeSafe API key.

```sh
npm install
cp .env.example .env    # then set TYPESAFE_API_KEY

npx jev-browser "open wikipedia.org, search for Alan Turing, and tell me the title of the article" --profile none
npx jev-chat
```

| Goal | Read |
|---|---|
| Run one task, or many in chat | [Usage](HOW_TO_USE.md#usage), [Chat mode](HOW_TO_USE.md#chat-mode) |
| Use the plugin in Claude Code or Codex | [Assistant plugin](HOW_TO_USE.md#assistant-plugin-claude-code-and-codex) |
| Save and run a scraper | [Scraping](HOW_TO_USE.md#scraping-jev-scrape) |
| Test a web app with YAML suites | [jev-test](packages/test-runner/README.md) |

## Repository layout

The repository is an npm workspace. The engine is in one package, and every front end uses it.

| Folder | Package | Holds |
|---|---|---|
| [packages/core](packages/core) | `@imanshu03/jev-core` | The engine: Chrome over CDP, the Jev step loop, record and replay, and the page reader. |
| [packages/mcp](packages/mcp) | `@imanshu03/jev-mcp` | The MCP server and the skills `jev-browser`, `jev-plugin`, and `jev-test`. |
| [packages/cli](packages/cli) | `@imanshu03/jev-cli` | The commands `jev-browser`, `jev-chat`, and `jev-scrape`. |
| [packages/sdk](packages/sdk) | `@imanshu03/jev-browser-use` | The public library API for other tools. |
| [packages/test-runner](packages/test-runner) | `@imanshu03/jev-test` | YAML test suites for web apps. |
| [plugins/claude](plugins/claude), [plugins/codex](plugins/codex) | - | The Claude Code and Codex plugins. Both run the same MCP server bundle. |

In this repository the packages use each other's TypeScript source, so a change in `core` shows at once in the other packages. Edit the skills only in `packages/mcp/skills`. `npm run plugins` builds the MCP server and copies it, with the skills, into each plugin folder.

## Development

```sh
npm test            # every package, offline
npm run typecheck   # every package
npm run test:live   # headless Chrome on local fixtures; no real key
npm run plugins     # the MCP bundle and the skill copies of both plugins
```

[AGENTS.md](AGENTS.md) holds the rules for code changes. See [Development](HOW_TO_USE.md#development) and [Publishing](HOW_TO_USE.md#publishing) for more.

Parts of the direct engine are adapted from [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) under the MIT License. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists them.
