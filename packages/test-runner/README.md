# jev-test

Write web app tests as YAML. Write steps in plain language. [jev-browser-use](../../README.md) runs them in Chrome.

- **Record once.** The first run lets Jev do each plain-language step and saves the clicks and fills that it found.
- **Replay after that.** Later runs replay the saved steps with code. No model call, so a run takes seconds.
- **Repair on change.** When a saved step no longer finds its control, Jev does the step again and saves the new steps. Expected results never repair: a wrong result always fails.
- **Any OpenAI-compatible LLM.** `judge` checks and new field text use the endpoint that you give at `jev-test init`: OpenAI, a LiteLLM proxy, OpenRouter, or a local server. No Claude Code or Codex CLI is needed, and no provider is built in.

## Quick start

In the jev-browser-use repository:

```bash
npm install

# Terminal 1: the demo app
node packages/test-runner/examples/demo/serve.mjs

# Terminal 2: run the demo suite (the committed recording replays; no Jev key needed)
npx jev-test run --config packages/test-runner/examples/demo/jev-test.config.yaml
```

In your own project, install the package from GitHub Packages. Add an `.npmrc` with `@imanshu03:registry=https://npm.pkg.github.com` and a token with `read:packages`, then:

```bash
npm install --save-dev @imanshu03/jev-test
npx jev-test init     # asks for the settings and writes the project files
npx jev-test run
```

## Set up a project: `jev-test init`

`init` asks for each setting and writes the project files:

| Question | Goes to |
|---|---|
| URL of the web app, and a name for that environment | `global.yaml` |
| TypeSafe API key for Jev (optional: a replay needs no key). `init` checks it. | `.env` as `TYPESAFE_API_KEY` |
| OpenAI-compatible base URL (optional), such as `https://api.openai.com/v1` | `jev-test.config.yaml` |
| API key of that endpoint (optional) | `.env` as `JEV_TEST_LLM_API_KEY` |
| Model name | `jev-test.config.yaml` |
| What Jev may do in the environment: `autonomous`, `never`, or `always` | `global.yaml` |
| More dangerous click words, and safe click words (optional, comma-separated) | `global.yaml` |
| Example suite? GitHub Actions workflow? | `suites/example.suite.yaml`, `.github/workflows/jev-test.yml` |

- Keys go only to `.env`. The config refers to them as `${TYPESAFE_API_KEY}` and `${JEV_TEST_LLM_API_KEY}`. `init` adds `.env` and `reports/` to `.gitignore` and makes `.env` readable only by you. The terminal does not show a key while you type it.
- `init` checks the Jev key with one small request. When TypeSafe rejects the key, `init` asks for it again unless you keep it. When TypeSafe does not answer, `init` keeps the key by default.
- `init` checks the LLM endpoint with `GET /models` and tells you when it does not answer or does not have the model.
- Each action word list has at most 100 words. Each word has at most 80 characters.
- It does not overwrite an existing config or `global.yaml`. Use `--force` to write them again; `.env` keeps its other lines.
- With no questions, for scripts and CI: `npx jev-test init --yes --app-url https://app.example.com --llm-url https://api.openai.com/v1 --llm-model gpt-4.1 --confirm never --dangerous "approve, merge" --safe archive`. With `--yes`, a rejected Jev key is only reported, and the keys come from `TYPESAFE_API_KEY` and `JEV_TEST_LLM_API_KEY` in the environment. You can also pass `--jev-key` and `--llm-key`, but the shell can keep them in its history.

## Commands

| Command | Does |
|---|---|
| `jev-test init` | Asks for the settings, checks the Jev key, and writes the config, `global.yaml`, `.env`, and an example suite. |
| `jev-test run [files or dirs]` | Runs the cases. Default: the `suites` directory of the config. |
| `jev-test list [files or dirs]` | Lists the cases that a run selects. |
| `jev-test validate` | Checks the config and every suite. |

| Option | Does |
|---|---|
| `--env stage` | Picks an environment of the config. |
| `--tag smoke` | Runs only cases with this tag. Repeat for AND. Suite tags count. |
| `--id TC-1` | Runs only this case. Repeat for more. |
| `--grep text` | Runs cases whose id or title holds the text. |
| `--record` | Records every plain-language step again. |
| `--ci` | CI mode (also when `CI=true`): a step with no recording fails, and a repair fails the case. |
| `--heal off\|warn\|fail` | Repair policy. Default: `heal.local`, or `heal.ci` in CI mode. |
| `--headed` | Shows the browser. |
| `--workers 4` | Runs this many suites at the same time. |
| `--report-dir dir` | Writes the reports there. |

Exit codes: `0` all passed, `1` a case failed, `2` the command line, config or a suite is not valid.

## Project layout

```
my-qa/
  jev-test.config.yaml     vars, secrets, flows, browser, Jev, LLM, repair policy
  global.yaml              environments, confirm mode, action words, instructions for Jev and the LLM
  suites/*.suite.yaml      the tests
  .jev/recordings/         saved steps, one JSON file per suite: commit them
  reports/<run id>/        results.json, junit.xml, screenshots, logs
  .env                     secrets for local runs (not committed)
```

## Config

```yaml
global: global.yaml            # the default; a project without global.yaml can set base_url here

vars: { org: Test Org }        # {org} in any step
secrets: [TEST_PASSWORD]       # also hidden in reports (names with password, token, secret, key are hidden anyway)

flows:                          # reusable steps: `- use: login`
  login:
    - goto: /login
    - fill: { field: Email, value: "${TEST_EMAIL}" }
    - fill: { field: Password, value: "${TEST_PASSWORD}" }
    - click: Sign in

browser: { headed: false, workers: 2, profile: none }   # profile: a Chrome profile name, or none for a clean one
jev:     { api_key: "${TYPESAFE_API_KEY}", model: jev-latest, max_steps: 25 }
llm:     { base_url: https://api.openai.com/v1, api_key: "${JEV_TEST_LLM_API_KEY}", model: gpt-4.1 }   # any OpenAI-compatible endpoint
heal:    { local: warn, ci: fail }
timeouts: { step_ms: 8000, assert_ms: 8000, case_ms: 300000 }
```

Secrets: a plain-language step, a `check`, or a `judge` text that holds a secret value fails at once, because Jev, the LLM, and the recording file would get the value. Type a secret with an explicit `fill` step. A secret is a value of an env var named in `secrets`, or whose name holds password, secret, token, key, otp, or pin, and that is 4 or more characters long.

`${NAME}` and `${NAME:-default}` read environment variables when the file loads. `{name}` reads a var when the step runs. Write `{{` and `}}` for a literal brace.

## Global settings: `global.yaml`

`global.yaml` sits next to the config. It holds the environments and the settings that every suite shares. Each environment, and then each suite file, can change them for itself. The suite file wins: a suite file with `confirm: autonomous` runs autonomously also in an environment with `confirm: never`.

```yaml
environments:
  stage: { base_url: https://app.staging.example.com }
  prod:
    base_url: https://app.example.com
    vars: { org: Prod Org }
    confirm: never                       # prod: no dangerous action
    actions: { dangerous: [save] }        # prod: Save is dangerous too
default_environment: stage

confirm: autonomous

actions:
  dangerous: [approve, merge]
  safe: [archive, remove from list]
  hosts:
    admin.example.com: { dangerous: [delete user] }

instructions:
  jev: The Save button of the editor is the disk icon in the toolbar.
  llm: Write all text in British English.
```

**`confirm`** sets what Jev may do when it records or repairs a step, and what a replay of a recorded step may click:

| Value | Jev and recorded replays may |
|---|---|
| `autonomous` (default) | Do every action. |
| `never` | Do no dangerous click or Enter. Such a step fails. |
| `always` | Do no dangerous click or Enter, no submit click (save, create, sign in, ...), and no Enter that submits a form. |

Explicit `click` and `press` steps are not checked: you wrote them. A replay that the confirm mode stops fails at once, with no repair. Enter checks the focused field, its form, and the option that it selects. A search is allowed only when the direct engine's search rules permit it. If focus or the form changes before Enter, the replay observes the page and checks the action again.

**`actions`** changes which click labels are dangerous. The built-in dangerous words include delete, remove, pay, buy, send, post, publish, share, reply, and archive.

- A `dangerous` word makes each click whose label holds it dangerous, such as `approve`.
- A `safe` phrase stops the built-in dangerous words only where it stands in the label. With `remove from list`, "Remove from list" is safe, but "Delete" and "Remove account (not remove from list)" stay dangerous.
- `hosts` gives words for one host and its subdomains, over the other words. A key is a bare host name such as `app.example.com`: a scheme, port, path, or wildcard is an error.
- Under `autonomous`, the words still set how sure Jev must be before it clicks: a dangerous click needs a higher confidence.

**`instructions`**: `jev` goes to Jev in each step request as notes about the app (at most 1,000 characters). Write facts about the app, not rules for the task, because extra rules can make Jev skip steps. `llm` goes to the text writer and to every `judge` check.

The order is global, then the environment, then the suite file (see [Suites](#suites)). Each later level wins: its `confirm` replaces the earlier one, its `actions` words go over the earlier words, and its `instructions` come after the earlier text. These are errors: one word that is dangerous and safe in one scope, one environment in both `global.yaml` and the config, and a secret value in `instructions`. A project that keeps its `environments` in the config (the older layout) still works.

## Suites

```yaml
suite: Notes
tags: [notes]
vars: { prefix: QA }
confirm: never                    # this file only: over global.yaml and the environment
actions: { safe: [archive] }      # this file only
instructions: { jev: The notes list shows the newest note first. }

before_all:  [ { use: login } ]   # once per suite, in the suite's browser
before_each: []
after_each:  []
after_all:   []

cases:
  - id: NOTE-001
    title: Add a note and delete it
    tags: [smoke]
    start: /app.html                  # opened before the steps
    vars: { title: "{prefix} note {now}" }
    steps:
      - Add a note titled "{title}"   # plain language: Jev records it once
      - expect: { row_contains: ["{title}"] }
      - Delete the note "{title}"
    expect:
      - not_visible_text: "{title}"
    cleanup:                          # runs also when the case fails
      - click: { name: "Delete {title}", match: contains, optional: true }
    # skip: "bug 123"                 # skips the case with this reason
```

Built-in vars: `{now}` (milliseconds, a unique suffix), `{date}` (YYYY-MM-DD), `{run_id}`.

### Steps

| Step | Does |
|---|---|
| `- Add a note titled "{title}"` | Plain language. Jev records it, replay runs it, repair fixes it. Put exact values in quotes. |
| `- goto: /path` | Opens a path of the base URL, or a full URL. |
| `- click: Save` or `{ name, role, match, nth, optional }` | Clicks a control by its name. |
| `- fill: { field: Email, value: "..." }` | Types into a field by its label. Password and code fields are typed with code only and checked after input. Jev and the LLM never see them. |
| `- select: { field: Sort, option: Newest }` | Picks an option. |
| `- press: Enter` | Presses a key. |
| `- wait: 1000` / `- wait_for_text: Saved` | Waits a time, or until a text shows (fails when it does not). |
| `- use: login` | Runs a flow of the config. |
| `- expect: {...}` | Checks a result in the middle of the steps. |
| `- screenshot: name` | Saves a screenshot to the report. |

### Expected results

| Check | Passes when |
|---|---|
| `url_contains: /notes` / `url_matches: "regex"` | The URL matches. |
| `title_contains: Notes` | The page title holds the text. |
| `visible_text: Saved` / `not_visible_text: Error` | The page text holds (or does not hold) the text. |
| `element: { name: Sign out, role: button, present: true }` | A control with that name is in view (or not). |
| `field_value: { field: Title, value: Milk }` | The field holds the value. |
| `row_contains: [Milk, 2026-10-07]` | One table row or list record holds every value. |
| `check: Is the user signed in?` | Jev answers yes (probability at least 0.7, or `min_probability`). |
| `judge: The reply summarizes the artifact` | The LLM reads the page and agrees. |

Code checks poll until they pass or time out (`timeout_ms`, default `timeouts.assert_ms`). `check` and `judge` use a model, so the report marks them. Prefer code checks.

## Record, replay, repair

| State of a plain-language step | Local run | CI run |
|---|---|---|
| No recording | Jev does it and records it | Fails: "has no recording" |
| Recording replays | Pass, no model call | Pass, no model call |
| Recording fails | Jev repairs it. The case is `HEAL` and the new recording is saved. | Jev repairs it. The case fails, and the repaired recording goes to `reports/.../recordings/` for review. |
| `--heal off` | Fails | Fails |

A completed action that cannot be recorded fails the step. Use an explicit step for that action.

Recordings for suites outside the project go under `_external/` in the recordings directory.

A recording is keyed by the step text. When you change the text of a step, only that step records again.

Suite hook repairs use the same repair policy as case steps. A failed `after_all` hook fails the suite cases.

A repair keeps the saved steps that ran before the failure and adds Jev's new steps. Review a repaired recording before you commit it: a repair can also hide a real change in the app.

## The LLM

`llm.base_url` is any OpenAI-compatible endpoint (`.../v1`): OpenAI, a LiteLLM proxy, OpenRouter, or a local server such as Ollama. The runner calls only `POST /chat/completions` (and `init` calls `GET /models`). It uses the LLM for:

- `judge` checks (`llm.judge_model`, else `llm.model`).
- New text that a step asks Jev to write, such as "write a short reply" (`llm.text_model`, else `llm.model`).

`instructions.llm` of `global.yaml` goes to both, as a second system message after the runner's own rules.

Jev (TypeSafe) still chooses the clicks when a step records or repairs.

The model must accept the request parameters. Judge requests use `temperature: 0` and `max_tokens: 300`. The new-text writer uses `max_tokens` and JSON mode. GPT-5 rejects the judge temperature parameter; see the [official parameter limits](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.4).

## CI

Run `jev-test init --ci-workflow`, or copy `examples/ci/jev-test.yml` to `.github/workflows/`. It runs `jev-test run --ci`, uploads the reports, and publishes `junit.xml`. Commit `.jev/recordings/` so that CI only replays.

## Use it from code

```ts
import { loadProject, loadSuites, runAll, jevSessions, createLlm, writeReports } from "@imanshu03/jev-test";

const project = loadProject("jev-test.config.yaml", { envName: "stage", processEnv: process.env });
const suites = loadSuites(project, [], { tags: ["smoke"], ids: [], grep: null });
const report = await runAll({
  project, suites, runId: "r1", reportDir: "reports/r1", workers: 2,
  sessions: jevSessions({
    config: project.config, secrets: project.secrets, processEnv: project.processEnv, headed: false, logDir: "reports/r1/logs",
    policy: project.policy, envName: project.env.name,
  }),
  llm: createLlm(project.config.llm, undefined, project.policy.llmInstructions),
  mode: { ci: false, record: false, heal: "warn" },
});
writeReports("reports/r1", report);
```

`Session` is an interface, so you can run the same suites on another browser driver.

## Known limits

- Jev is weak on date pickers, recipient chips, @mentions and rich-text editors. Use explicit `click` and `fill` steps there, or keep those flows in Playwright.
- `element` and `field_value` see only controls in view.
- A case timeout cancels further steps. Cleanup waits for the active browser command or model request to finish.
- One browser at a time can use a named Chrome profile, so `browser.profile` other than `none` runs 1 worker.

## Development

This package is `packages/test-runner` in the jev-browser-use workspace. It uses the library `@imanshu03/jev-browser-use` (`packages/sdk`) through the workspace link.

```bash
npm test -w @imanshu03/jev-test           # unit tests (fake browser)
npm run test:live -w @imanshu03/jev-test  # real Chrome on the demo app
npm run typecheck -w @imanshu03/jev-test
```
