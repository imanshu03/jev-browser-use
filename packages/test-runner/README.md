# jev-test

Write web app tests as YAML. Write steps in plain language. [jev-browser-use](../../README.md) runs them in Chrome.

- **Record once.** The first run lets Jev do each plain-language step and saves the clicks and fills that it found.
- **Replay after that.** Later runs replay the saved steps with code. No model call, so a run takes seconds.
- **Repair on change.** When a saved step no longer finds its control, Jev does the step again and saves the new steps. Expected results never repair: a wrong result always fails.
- **LLM through LiteLLM.** Free-text fields and `judge` checks use any OpenAI-compatible endpoint, such as the LiteLLM proxy. No Claude Code or Codex CLI is needed.

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
npx jev-test run
```

To record new steps, set `TYPESAFE_API_KEY` (in the environment or in a `.env` file next to the config).

## Commands

| Command | Does |
|---|---|
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
  jev-test.config.yaml     environments, flows, browser, Jev, LLM, repair policy
  suites/*.suite.yaml      the tests
  .jev/recordings/         saved steps, one JSON file per suite: commit them
  reports/<run id>/        results.json, junit.xml, screenshots, logs
  .env                     secrets for local runs (not committed)
```

## Config

```yaml
environments:
  stage: { base_url: https://app.staging.example.com }
  prod:  { base_url: https://app.example.com, vars: { org: Prod Org } }
default_environment: stage

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
llm:     { base_url: "${LITELLM_PROXY_URL}", api_key: "${LITELLM_API_KEY}", model: claude-sonnet-5-5 }
heal:    { local: warn, ci: fail }
timeouts: { step_ms: 8000, assert_ms: 8000, case_ms: 300000 }
```

`${NAME}` and `${NAME:-default}` read environment variables when the file loads. `{name}` reads a var when the step runs. Write `{{` and `}}` for a literal brace.

## Suites

```yaml
suite: Notes
tags: [notes]
vars: { prefix: QA }

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
| `- fill: { field: Email, value: "..." }` | Types into a field by its label. Password and code fields are typed with code only: Jev and the LLM never see them. |
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

A recording is keyed by the step text. When you change the text of a step, only that step records again.

A repair keeps the saved steps that ran before the failure and adds Jev's new steps. Review a repaired recording before you commit it: a repair can also hide a real change in the app.

## LLM through LiteLLM

`llm.base_url` is any OpenAI-compatible endpoint (`.../v1`). jev-test uses it for:

- `judge` checks (`llm.judge_model`, else `llm.model`).
- New text that a step asks Jev to write, such as "write a short reply" (`llm.text_model`, else `llm.model`).

Jev (TypeSafe) still chooses the clicks when a step records or repairs.

## CI

Copy `examples/ci/jev-test.yml` to `.github/workflows/`. It runs `jev-test run --ci`, uploads the reports, and publishes `junit.xml`. Commit `.jev/recordings/` so that CI only replays.

## Use it from code

```ts
import { loadProject, loadSuites, runAll, jevSessions, createLlm, writeReports } from "@imanshu03/jev-test";

const project = loadProject("jev-test.config.yaml", { envName: "stage", processEnv: process.env });
const suites = loadSuites(project, [], { tags: ["smoke"], ids: [], grep: null });
const report = await runAll({
  project, suites, runId: "r1", reportDir: "reports/r1", workers: 2,
  sessions: jevSessions({ config: project.config, secrets: project.secrets, processEnv: project.processEnv, headed: false, logDir: "reports/r1/logs" }),
  llm: createLlm(project.config.llm),
  mode: { ci: false, record: false, heal: "warn" },
});
writeReports("reports/r1", report);
```

`Session` is an interface, so you can run the same suites on another browser driver.

## Known limits

- Jev is weak on date pickers, recipient chips, @mentions and rich-text editors. Use explicit `click` and `fill` steps there, or keep those flows in Playwright.
- `element` and `field_value` see only controls in view.
- When a case times out, its steps can still run while the cleanup starts.
- One browser at a time can use a named Chrome profile, so `browser.profile` other than `none` runs 1 worker.

## Development

This package is `packages/test-runner` in the jev-browser-use workspace. It uses the library `@imanshu03/jev-browser-use` (`packages/sdk`) through the workspace link.

```bash
npm test -w @imanshu03/jev-test           # unit tests (fake browser)
npm run test:live -w @imanshu03/jev-test  # real Chrome on the demo app
npm run typecheck -w @imanshu03/jev-test
```
