# jev-test reference

## Project layout

```
my-qa/
  jev-test.config.yaml     vars, secrets, flows, browser, Jev, LLM, repair policy
  global.yaml              environments, confirm mode, action words, instructions for Jev and the LLM
  suites/*.suite.yaml      the tests (a suite file name must end with .suite.yaml)
  .jev/recordings/         saved steps, one JSON file for each suite: commit them
  reports/<run id>/        results.json, junit.xml, screenshots, logs (not committed)
  .env                     keys and test credentials for local runs (not committed)
```

## Config: jev-test.config.yaml

```yaml
global: global.yaml            # default; a missing global.yaml is no error
base_url: https://app.example.com   # only for a project with no environments

vars: { org: Test Org }        # {org} in any step
secrets: [TEST_PASSWORD]       # also hidden in reports

flows:                         # reusable steps: `- use: login`
  login:
    - goto: /login
    - fill: { field: Email, value: "${TEST_EMAIL}" }
    - fill: { field: Password, value: "${TEST_PASSWORD}" }
    - click: Sign in
    - expect: { url_matches: "^(?!.*/login)", timeout_ms: 20000 }

suites: suites                 # default
recordings: .jev/recordings    # default
reports: reports               # default

browser:
  headed: false
  browser: chrome              # chrome | edge | brave | chromium
  profile: none                # none for a clean profile; a named Chrome profile runs 1 worker
  workers: 2                   # suites at the same time, 1 to 16

jev:     { api_key: "${TYPESAFE_API_KEY}", model: jev-latest, max_steps: 25 }
llm:     { base_url: https://api.openai.com/v1, api_key: "${JEV_TEST_LLM_API_KEY}", model: gpt-4.1, judge_model: gpt-4.1, text_model: gpt-4.1, timeout_ms: 60000 }
heal:    { local: warn, ci: fail }                 # off | warn | fail
timeouts: { step_ms: 8000, assert_ms: 8000, case_ms: 300000 }
```

- Every key is optional except one base URL: `base_url`, or an environment in `global.yaml` (or in `environments` of the config, the older layout). Unknown keys are errors.
- A secret is the value (4 or more characters) of an env var that `secrets` names, or whose name holds pass, secret, token, api_key (or apikey), private, otp, or pin, in any case. Reports show it as `***`.
- `llm` is any OpenAI-compatible endpoint. Leave `llm.base_url` empty for no LLM. `judge` checks need the endpoint, `llm.judge_model` or `llm.model`, and any key that the endpoint requires.

## Global: global.yaml

```yaml
environments:
  stage: { base_url: https://app.staging.example.com }
  prod:
    base_url: https://app.example.com
    vars: { org: Prod Org }
    confirm: never             # goes over the global confirm
    actions: { dangerous: [save], safe: [] }
    instructions: { llm: Keep replies short. }
default_environment: stage

confirm: autonomous            # autonomous | never | always

actions:                       # click label words, added to the built-in lists
  dangerous: [approve, merge]
  safe: [archive, remove from list]
  hosts:                       # a host and its subdomains
    admin.example.com: { dangerous: [delete user], safe: [] }

instructions:
  jev: The Save button of the editor is the disk icon in the toolbar.
  llm: Write all text in British English.
```

- `confirm` sets what Jev may do when it records or repairs a step, and what a replay of a recorded step may click. `autonomous` (default): every action. `never`: no dangerous click or Enter; the step fails. `always`: also no submit click (save, create, sign in, and so on) and no Enter that submits a form. Explicit `click` and `press` steps are not checked: the author wrote them.
- Recorded Enter checks the focused field, its form, and the option that it selects. The search exception uses the direct engine's rules. A change to focus or the form causes a new observation and risk check before input.
- `actions` changes which labels are dangerous. A `dangerous` word makes a click with that word dangerous. A `safe` phrase stops the built-in dangerous words only where it stands in the label: with `remove from list`, "Remove from list" is safe, but "Delete" and "Remove account" stay dangerous. A host key is a bare host name, such as `app.example.com` (no scheme, port, path, or wildcard); it also matches its subdomains. Built-in dangerous words include delete, remove, pay, buy, send, post, publish, share, reply, and archive. Words are not case-sensitive.
- The order is global, then the environment, then the suite file (see [Suite](#suite-suiteyaml)). Each later level wins: its `confirm` replaces the earlier one, its `actions` words go over the earlier words, and its `instructions` come after the earlier text. Host words go over the other words on that host.
- A word that one scope lists as dangerous and as safe is an error. An environment in both `global.yaml` and the config is an error.
- `instructions.jev` goes to Jev in each step request as notes about the app (at most 1000 characters). Write facts about the app, not rules about the task: extra rules can make Jev skip steps. `instructions.llm` goes to the text writer and to the `judge` checks.
- A secret value in `instructions` is an error.

## Suite: *.suite.yaml

```yaml
suite: Artifacts               # required
tags: [artifacts]              # added to each case
vars: { project: QA Automation }
confirm: never                 # this file only; goes over global.yaml and the environment
actions: { dangerous: [publish], safe: [] }
instructions: { jev: The Artifacts tab lists the newest artifact first., llm: Artifacts are in English. }

before_all:  []                # once, before the first case
before_each: []                # before each case, after `start`
after_each:  []                # after each case, also after a failure
after_all:   []                # once, after the last case; a failure fails the cases of the suite

cases:                         # at least one
  - id: TC-ART-001             # letters, digits, _, . and -; at most 80; unique in all suites
    title: Create an artifact and delete it
    tags: [regression]         # letters, digits, _, : and -
    vars: { name: "jev artifact {now}" }
    start: /                   # a path of the base URL, or a full URL
    steps: []
    expect: []                 # checks after the steps
    cleanup: []                # runs also when the case fails
    skip: "bug 123"            # skips the case with this reason
    timeout_ms: 300000         # default timeouts.case_ms
```

The order of one case: `start`, `before_each`, `steps`, `expect`, a screenshot when the case failed, `cleanup`, `after_each`.

All cases of a suite run in one browser, in file order. Suites run in parallel up to `browser.workers`.

Var names: a-z, 0-9, and `_`; start with a letter; at most 40 characters. Values can be strings, numbers, or booleans.

## Steps

| Step | Does |
|---|---|
| `- Open the Artifacts tab` | Plain language. Jev records it once, replay runs it, repair fixes it. Put exact values in quotes and changing values in `{vars}`. |
| `- goto: /path` | Opens a path of the base URL, or a full URL. |
| `- click: Save` | Clicks a button with that name. |
| `- click: { name: Docs, role: link, match: contains, nth: 0, optional: true }` | `role` default `button`. `match`: `exact` (default), `starts`, or `contains`. `nth` picks one of many matches (from 0). `optional: true` passes when the control is missing. |
| `- fill: { field: Email, value: "{email}" }` | Types into the field with that label. A password or code field, or a secret value, is typed by code only. Jev and the LLM never see it. |
| `- select: { field: Sort, option: Newest }` | Picks an option of a select field. |
| `- press: Enter` | `Enter`, `Escape`, `Tab`, `ArrowDown`, `ArrowUp`, `PageDown`, or `PageUp`. |
| `- wait: 1000` | Waits this many milliseconds. Prefer `wait_for_text`. |
| `- wait_for_text: Saved` | Waits until the text shows. Fails at `timeout_ms` (default `timeouts.assert_ms`). |
| `- use: login` | Runs a flow of the config. Flows can nest 5 deep. |
| `- expect: { visible_text: Saved }` | One check, or a list of checks, in the middle of the steps. |
| `- screenshot: after-save` | Saves a screenshot to the report. Name: letters, digits, `_`, `-`; at most 60. |

A plain-language step fails when Jev cannot do it, or when it does an action that cannot be recorded. Use an explicit step for that action.

## Checks

| Check | Passes when |
|---|---|
| `url_contains: /notes` | The URL holds the text. |
| `url_matches: "^.*/notes/\\d+$"` | The URL matches the regular expression. |
| `title_contains: Notes` | The page title holds the text. |
| `visible_text: Saved` | The page text holds the text. |
| `not_visible_text: Error` | The page text does not hold the text. |
| `element: { name: Sign out, role: button, present: true }` | A control with that name is in view (`present: false`: not in view). |
| `field_value: { field: Title, value: Milk }` | The field in view holds the value. |
| `row_contains: [Milk, "2026-10-07"]` | One table row or list record holds every value. |
| `check: Is the user signed in?` | Jev answers yes with probability 0.7 or more (`min_probability` changes it). |
| `judge: The reply summarizes the artifact` | The LLM reads the page and agrees. |

Code checks poll the page until they pass or reach `timeout_ms` (default `timeouts.assert_ms`). `check` calls Jev and `judge` calls the LLM on every run, also when all action steps replay. A `check` needs a Jev key; a `judge` needs the configured LLM. The report marks these model checks. A `check` or `judge` text must not hold a secret.

## Commands

| Command | Does |
|---|---|
| `jev-test init` | Asks for the settings, checks the Jev key, and writes the config, `global.yaml`, `.env`, `.gitignore` lines, and an example suite. |
| `jev-test validate [files or dirs]` | Checks the config and every suite. |
| `jev-test list [files or dirs]` | Lists the cases that a run selects. |
| `jev-test run [files or dirs]` | Runs the cases. Default: the suites directory of the config. |

| Option | Does |
|---|---|
| `--config <file>` | The config file (default `jev-test.config.yaml`). |
| `--env stage` | An environment of the config. |
| `--tag smoke` | Only cases with this tag. Repeat for AND. Suite tags count. |
| `--id TC-1` | Only this case. Repeat for more. |
| `--grep text` | Only cases whose id or title holds the text. |
| `--headed` | Shows the browser. |
| `--record` | Records every selected plain-language step again. |
| `--ci` | CI mode (also when `CI=true`): a missing recording fails unless `--record` is set. Repairs use `heal.ci` (default `fail`), unless `--heal` changes it. |
| `--heal off\|warn\|fail` | The repair policy. Default `heal.local`, or `heal.ci` in CI mode. |
| `--workers 4` | Suites at the same time. |
| `--report-dir dir` | Writes the reports there. |

`init` options: `--dir`, `--app-url`, `--env-name`, `--llm-url`, `--llm-model`, `--confirm`, `--dangerous` and `--safe` (comma-separated words), `--no-example`, `--ci-workflow`, `--force`, and `--yes` (no questions; the keys come from `TYPESAFE_API_KEY` and `JEV_TEST_LLM_API_KEY` in the environment). `init` checks the Jev key with one small request. When TypeSafe rejects it, `init` asks for the key again, unless you keep it; with `--yes` it only reports.

Exit codes: `0` all passed, `1` a case failed, `2` the config, a suite, or the command line is not valid.

## Record, replay, repair

| Plain-language step | Local run | CI run |
|---|---|---|
| No recording | Jev does it and records it. | Fails: "has no recording", unless `--record` is set. |
| The recording replays | Pass, no model call. | Pass, no model call. |
| The recording fails | With the default `heal.local: warn`, Jev repairs it. The case is `healed` and the new recording is saved. | With the default `heal.ci: fail`, Jev repairs it. The case fails, and the repaired recording goes to the report directory under `recordings/`. |
| `--heal off` | Fails. | Fails. |

A repair keeps the saved steps before the failed one and adds the new steps of Jev. Suite hooks use the same repair policy as case steps. `--heal` changes the policy for the run: `warn` marks a repaired case as `healed`, `fail` marks it as `failed`, and `off` stops at the replay failure.

## Reports

`reports/<run id>/` holds `results.json` (each suite, case, step, check, and error), `junit.xml`, `screenshots/` (one for each failed case, and each `screenshot` step), and `logs/`.

## Known limits

- Jev is weak on date pickers, recipient chips, @mentions, and rich-text editors. Use explicit steps there.
- `element` and `field_value` see only controls in view.
- A case timeout stops the next steps. Cleanup waits for the active browser command or model request to end.
- A named Chrome profile (`browser.profile` other than `none`) runs 1 worker.
