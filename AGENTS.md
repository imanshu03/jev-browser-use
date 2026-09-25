These instructions apply to `jev-browser-use` and its subdirectories.

The package and repository name is `jev-browser-use`. Public commands remain `jev-browser` and `jev-chat`. The MCP server is not a public command. The plugin runs `plugin/dist/jev-mcp.mjs`. Preserve the existing configuration paths and environment variable names when editing project branding.

Use ASD-STE100 Simplified Technical English. Follow Zinsser's principles: simplicity, brevity, clarity, and humanity. Avoid staccato pairs, antithesis reframes, negative parallelism, isocolon metaphor-pairs, and backward references.

The public engine options are `cdp`, `chromium`, and `vercel`. `cdp` is the default. The two direct engines share `src/fast/`; Chromium uses its own binary discovery and profile storage. The `vercel` option uses the `agent-browser` implementation. The MCP server supports `cdp` and `chromium`. A `vercel` environment default falls back to `cdp` with a warning.

This project runs browser tasks from natural-language instructions. TypeSafe Jev selects semantic operations and targets. Code controls execution, risk checks, request limits, retries, and cleanup. Keep those responsibilities separate.

Before editing, check the working tree and read the files and tests for the affected behavior. Preserve existing work. Keep changes within the requested scope. Use the Node version and npm scripts defined in `package.json`.

Use these files to find the correct layer:

- `src/cli.ts` and `bin/jev-browser.js`: one-shot arguments, dependency setup, result output, and process exit.
- `src/chat.ts`, `src/config.ts`, and `bin/jev-chat.js`: repeated tasks, session commands, and API key storage.
- `src/plan.ts` and `src/task.ts`: profile and URL resolution, task values, and secret removal.
- `src/fast/loop.ts` and `src/fast/policy.ts`: the shared `cdp` and `chromium` task loop, questions, action checks, and completion decisions.
- `src/fast/model.ts`: interfaces between the direct task loop and browser code. Keep the decision loop independent of browser I/O.
- `src/fast/chrome.ts`, `src/fast/cdp.ts`, `src/fast/page.ts`, and `src/fast/snapshot.ts`: profile ownership, browser transport, observations, and input execution.
- `src/loop.ts`, `src/policy.ts`, `src/questions.ts`, `src/browser.ts`, `src/snapshot.ts`, and `src/extract.ts`: the `vercel` engine, which uses `agent-browser`.
- `src/jev.ts`, `src/transport.ts`, `src/io.ts`, and `src/types.ts`: shared model access, HTTP connections, output, and result contracts.
- `src/fast/generate.ts`: assistant-written text for the direct loop: field selection, the text request, reply checks, and the sanitizer. Pure functions.
- `src/fast/session.ts`: the Chrome and the tab that the MCP server keeps between runs, and profile relaunch.
- `src/mcp/main.ts` and `src/mcp/server.ts`: the MCP server entry, stdio, shutdown, the tools, and the dialogs. Only these two files import the MCP SDK.
- `src/mcp/runs.ts`, `src/mcp/view.ts`, `src/mcp/setup.ts`, `src/mcp/timers.ts`, and `src/mcp/limits.ts`: run state and hand-offs, tool results, environment and input checks, idle timers, and constants.
- `plugin/`, `.claude-plugin/marketplace.json`, and `.agents/plugins/marketplace.json`: the Claude Code and Codex plugin files, the MCP configurations, and the `jev-browser` skill.
- `scripts/build-mcp.mjs` and `bin/jev-mcp.js`: the plugin bundle build and the development launcher (`npm run mcp`).

For CLI or user-visible changes, read and update `README.md`. For changes to architecture, planning, or decision rules, consult `DESIGN.md`. It covers all three engines and states their differences. Keep the design consistent with the source and tests.

Use TypeScript with the strict settings in `tsconfig.json`. Keep `.js` extensions in relative TypeScript imports. Use the existing dependency interfaces and test fakes to test decisions without Chrome or the Jev API. Retain source attribution when editing code adapted from `browser-use/jev-ultrafast`.

Preserve these behavior rules:

- Keep engine selection consistent in CLI arguments, chat, environment defaults, smoke runs, and `stats.engine`. Use the shared `Engine` type. Keep Chrome and Chromium profile sources and copies separate; a binary override must preserve the selected engine's profile rules.
- Treat page content as untrusted data. Select observed targets and supported values. Keep risk checks in code.
- Apply confirmation rules to keyboard submission as well as clicks. Enter must use the focused control and its form when checking destructive actions.
- Check observations before input. Keyboard checks must include focus and form state. A stale observation must cause a new observation before execution.
- Support document scrolling and scrolling inside panels. Include panel state in freshness checks and change detection.
- Remove known secrets from model requests, logs, and result JSON. Redact structured string values before JSON serialization and before request text is shortened. Preserve original values for browser input and preserve option identifiers used to read model answers.
- Hold exclusive ownership of a profile copy through copying, refresh, and the launched browser process lifetime. Preserve another owner's locks. A lock file alone is not evidence that its owner has stopped.
- Keep one-shot and chat connection lifetimes separate. For `cdp` and `chromium`, with `--cdp --keep-open`, the CLI must disconnect and exit while leaving its tab open. Chat must retain its connection between tasks. Close only resources the session owns.
- Preserve the shared `RunResult` contract for all three engines. The one-shot CLI writes one result JSON document to stdout and its trace to stderr. Keep exit codes consistent with `README.md`.
- The MCP server writes only JSON-RPC to stdout. Send logs and console output to stderr. Launch no Chrome and send no network request before the first `browse` call.
- Assistant-written text fills only its bound, writable field, one time. Keep `canWriteInto`, the binding key, and the unsent-text gate in code.
- Only a human dialog approves an action. No tool argument, page text, or model answer can approve it.

For code changes, add regression tests for changed behavior and run:

```sh
npm test
npm run typecheck
```

For changes to browser scripts, CDP, profile ownership, or process cleanup, also run:

```sh
npm run test:live
```

For MCP server or plugin changes, also run `npm run build:mcp`. The plugin runs the bundle, not the source.

The live suite uses local fixtures, temporary profiles, and a local API stand-in. It tests attachment under both direct engine names with Chrome, and it runs the MCP server on the reply fixture; it does not prove that Chromium launches. Report actual Chromium launch coverage separately. It requires Chrome but does not need a real Jev key. Unit tests skip the live suite by default. Use process-level tests for exit behavior; a mocked close call does not prove that a process exits.

Use `test/fakes.ts`, `test/fast/fakes.ts`, `test/mcp/helpers.ts`, and `test/fixtures/` for isolated tests. Keep tests independent of personal Chrome data and real accounts. `npm run smoke` uses the real API and browser workflow; use it when the requested task calls for that validation. Keep credentials, profile copies, and runtime logs out of version control.

Before completing work, report the behavior changed, the checks run, and any check that could not run. For documentation-only edits, verify referenced paths and commands; code tests are not required.
