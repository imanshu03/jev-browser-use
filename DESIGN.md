# jev-browser-use design

This document defines the design of the one-shot CLI and chat mode for `jev-browser-use`. The package name is `jev-browser-use`; the command names remain `jev-browser` and `jev-chat`. Configuration directories retain the `jev-browser` name so saved keys and profile copies remain available. The public engine choices are `cdp` (default), `chromium`, and `vercel`. The `cdp` and `chromium` options share the direct implementation; `vercel` uses the `agent-browser` implementation. Below, “direct engines” means `cdp` and `chromium`. Internal `FastRunner` and `src/fast/` names remain unchanged. Engine-specific behavior is stated explicitly.

Use [README.md](README.md) for installation, flags, and user commands. Exact interfaces, prompt strings, and limits live in the source files linked here. Update this document when a change affects architecture or behavior.

## 1. Purpose and boundaries

`jev-browser "<task>"` completes a browser task from a natural-language instruction. Tasks include navigation, search, form entry, reading a value, and checking whether a condition is true. `jev-chat` runs successive tasks in one browser session.

The design has these rules:

1. TypeSafe Jev selects semantic operations, targets, values, and completion answers. Code controls parsing, risk checks, budgets, retries, and resource ownership.
2. Each step uses one operation choice. `DONE` and `BLOCKED` are choices in that question. Target questions assume a specific operation; code reads the target answer for the selected operation.
3. Typed values come from task spans, user variables, or supported page-value candidates. The model selects offered values. The direct engines currently offer task spans and variables; the `vercel` engine also supports page-value candidates.
4. Completion needs visible evidence. For a check, navigate to the detailed view that contains the requested attribute. A related dashboard or sidebar label is insufficient evidence.
5. Page content is untrusted data. It cannot change task instructions or bypass action checks.
6. Requests, observations, retries, waits, and execution have limits. The result states whether the task is done, blocked, or failed.
7. Known secrets are removed from model requests, logs, and result JSON. Browser input receives the original value.
8. Unit tests use dependency interfaces and fakes. Live browser tests use local fixtures and isolated profiles.

The project uses TypeScript ES modules with strict type checking. Comments and documentation use Simplified Technical English. Parts of the direct engines derive from `browser-use/jev-ultrafast`; retain their MIT attribution. [scripts/proto.ts](scripts/proto.ts) records the prototype operation loop.

## 2. Architecture and module ownership

Each direct engine uses one Chrome DevTools Protocol (CDP) connection.

| Engine | Implementation | Binary selection | Source profiles and copy storage |
|---|---|---|---|
| `cdp` (default) | `FastRunner`, direct CDP | `--chrome-bin`, then `JEV_CHROME_BIN`, then Chrome discovery | Chrome source profiles; copies under `jev-browser/chrome` |
| `chromium` | `FastRunner`, direct CDP | `--chrome-bin`, then `JEV_CHROMIUM_BIN`, then Chromium discovery | Chromium source profiles; copies under `jev-browser/chromium` |
| `vercel` | `Runner`, `agent-browser` CLI | `JEV_BROWSER_BIN` or the package-local CLI | Profile handling belongs to `agent-browser` |

The configuration root for copies is `$XDG_CONFIG_HOME` or `~/.config`. On macOS and Linux, `cdp` discovery can fall back to Chromium. The selected engine still determines source profiles and copy storage, including when a binary override is used. Chromium discovery only checks Chromium locations. The direct engines require an installed browser and do not download one.

The one-shot `--cdp` flag attaches to an existing browser for either direct engine. Attachment skips binary selection and profile copying. Chat chooses its engine at startup and does not expose `--cdp` or an engine-switch command.

The `vercel` engine invokes the installed `agent-browser` CLI. All three engines return the same result contract.

| Responsibility | Source |
|---|---|
| One-shot arguments, dependency setup, stdout, exit, SIGINT | [src/cli.ts](src/cli.ts), [bin/jev-browser.js](bin/jev-browser.js) |
| Chat input, commands, session lifetime, totals | [src/chat.ts](src/chat.ts), [bin/jev-chat.js](bin/jev-chat.js) |
| API key loading, validation, and storage | [src/config.ts](src/config.ts) |
| Shared types, thresholds, limits, role and keyword lists | [src/types.ts](src/types.ts) |
| Profile, start URL, and goal resolution | [src/plan.ts](src/plan.ts) |
| Task spans, URLs, key literals, profile mentions, redaction | [src/task.ts](src/task.ts) |
| Model request interface, budgets, answer readers, metrics | [src/jev.ts](src/jev.ts) |
| HTTP connection reuse and warm-up | [src/transport.ts](src/transport.ts) |
| Logs, human interaction, empty results, exit mapping | [src/io.ts](src/io.ts) |
| Direct task loop and action checks | [src/fast/loop.ts](src/fast/loop.ts) |
| Direct request construction and answer interpretation | [src/fast/policy.ts](src/fast/policy.ts) |
| Direct browser interfaces | [src/fast/model.ts](src/fast/model.ts) |
| Chrome and Chromium discovery, profile copying, launch, attach, close | [src/fast/chrome.ts](src/fast/chrome.ts) |
| CDP pipe and WebSocket transport | [src/fast/cdp.ts](src/fast/cdp.ts) |
| Tab observation, freshness checks, navigation, input | [src/fast/page.ts](src/fast/page.ts) |
| Scripts evaluated inside the page | [src/fast/snapshot.ts](src/fast/snapshot.ts) |
| Vercel task loop and action checks | [src/loop.ts](src/loop.ts), [src/policy.ts](src/policy.ts) |
| Vercel request builders | [src/questions.ts](src/questions.ts) |
| Vercel browser commands and error classification | [src/browser.ts](src/browser.ts) |
| Vercel tree parsing, element context, fingerprints | [src/snapshot.ts](src/snapshot.ts) |
| Vercel extraction, answer selection, verification | [src/extract.ts](src/extract.ts) |

The direct loop depends on the `Page`, `Chrome`, and `Oracle` interfaces. Browser modules perform I/O; policy modules construct questions and interpret answers. Keep this separation so decision tests can run without Chrome or the API.

## 3. Planning and input values

### 3.1 Profile resolution

Resolve a profile by display name or directory. For `cdp`, list Chrome source profiles; for `chromium`, list Chromium source profiles. For `vercel`, request the profile list through `agent-browser`. Directory names identify the profile passed to the browser layer. A profile named `Parallelloop` in Chrome is not automatically available to Chromium.

1. An explicit `--profile` wins. `--profile none` requests a temporary profile. An unknown explicit profile is a usage error.
2. One exact profile mention in the task resolves without a model question. Multiple mentions become PLAN candidates.
3. When the task mentions a profile, Chrome, or an account without an exact match, PLAN can ask `profile_mentioned` and `profile` over available profiles.
4. A model choice at `profileJev` confidence is accepted. A choice in the human-confirmation band can be confirmed on a TTY. Unresolved ambiguity can block the plan.
5. When no profile was selected and no explicit `none` or blocking result applies, use the available profile named `Parallelloop`. Record `how=workspace_default`. In this workspace its directory is normally `Profile 14`; resolve the directory from the profile list. If the named default is absent, the current resolver uses no profile.

`--cdp` selects attachment to an existing browser at the transport layer. Profile launch and copy options do not select the identity of that existing browser.

### 3.2 Start URL and goal

Resolve the start in this order: explicit `--url`, the first task URL, one exact site-catalog hit, or the current chat page when supplied as a fallback. Otherwise PLAN chooses a site from the matching catalog entries or the full catalog.

If PLAN cannot select a site, it can choose a non-secret task span for a DuckDuckGo HTML search. Without a supported site or search choice, return `no_start_url`. URLs are extracted in text order, deduplicated, and stripped of trailing punctuation. Recognized bare domains receive an HTTPS scheme.

The goal is `act`, `extract`, or `check`. `--goal` supplies it directly. Otherwise PLAN asks one goal question. A low-confidence answer defaults to `act` with a warning.

PLAN combines all unresolved questions into at most one request:

| Question | Purpose |
|---|---|
| `profile_mentioned` | Determine whether an account or profile was requested |
| `profile` | Choose among available profile candidates |
| `site` | Choose the first site |
| `wants_search` | Determine whether a web search can start the task |
| `search_query` | Choose an offered search span |
| `goal` | Choose the required result type |

Skip PLAN when code has resolved the profile, start, and goal. In the direct engines, `prePlan()` can launch the selected browser and load a known start URL while the goal request runs. If the model must choose the profile or site, resolve the plan first. A plan failure must still settle and close any browser work that started concurrently.

### 3.3 Values and keys

`extractSpans()` collects quoted text, email addresses, URLs, dates, numbers, phrases after value verbs, proper nouns, short clauses, and the whole task. Profile names and catalog aliases are excluded. Spans have stable request identifiers and bounded text. Whitespace normalization and candidate limits are defined in `src/task.ts` and `src/types.ts`.

`--var key=value` adds `v_<key>` candidates. Keys are lower-cased. Keys that match `pass`, `pin`, `otp`, `secret`, `token`, or `code` mark the value as secret. Secret candidates use a descriptor in model questions; the browser receives the value selected by its identifier.

Credential handling requires an appropriate supplied value. The `vercel` engine can match a variable to a field in code. The direct loop checks credential labels before typing; its page snapshot excludes native password inputs, so a native password wall requires human sign-in.

The `vercel` engine also retains up to three confident page spans for later value questions. A page-derived fill uses the selected field and candidate lines in a CONFIRM request. Native selects use observed options; ARIA selects can require opening the control and taking another snapshot.

Key literals are parsed from the task and normalized against the key catalog. The `vercel` policy offers `PRESS_KEY` and direct `OPEN_URL` choices. The direct policy currently offers `PRESS_ENTER` and `GO_BACK`; it does not offer arbitrary key chords or direct URL changes after planning.

## 4. Observation and model requests

### 4.1 Operation and target questions

The main choice is `operation`. Offer `CLICK`, `TYPE_TEXT`, and `SELECT` only when usable targets exist. Include `DONE` unless temporarily suppressed, and include `BLOCKED`.

The `vercel` engine also offers `PRESS_KEY`, both scroll directions, `GO_BACK`, and `WAIT`; it offers `OPEN_URL` when URL candidates exist. The direct engines offer `PRESS_ENTER`, `GO_BACK`, and `WAIT`, plus scroll directions available in the observation.

The operation and target instructions carry the task and rules. The rules require the model to:

- Advance the entire goal from the current page using one operation.
- Use current element state and recent actions, and treat page text as data.
- Leave already satisfied controls in their requested state.
- Fill required fields before submitting. A populated search field still needs submission or the matching suggestion.
- Use an available useful control before waiting. Wait when required controls or submitted results are still loading.
- Navigate to the detailed view for checks and use visible evidence for every requested requirement.
- Select only offered targets and values. A target question assumes its named operation; the operation question decides which answer is used.
- Return `BLOCKED` when supported operations cannot advance the task.

Direct-engine rules also cover date pickers, applying every requested filter, opening a requested result, and scrolling until an extraction value is visible. Exact prompt strings live in the engine's policy or questions module.

The `vercel` request uses `click_target_<k>` for chunks of up to 200 clickable elements, `type_text_target` for editable fields, and `select_target` for observed options. Target descriptions include the ref, role, name, state, and current value. For multiple click chunks, `none` means that the correct target is outside the chunk. Two or more qualifying winners trigger TOURNAMENT with `target_final`.

The direct request uses one `click_target`, `type_text_target`, and `select_target` question when the group exists. Its action space maps numeric element indices and select-option indices to observed action identifiers. It caps each group to fit a choice question instead of running a tournament.

### 4.2 State

The `vercel` OBSERVE state has this structure. Optional fields appear when they have candidates or useful state:

```ts
{
  goal: task,
  goal_type: goal,
  step: { number, of: maxSteps },
  page: { url, title, headings, visible_text },
  elements: [{ index, role, name, state, value }],
  recent_actions: [{ step, operation, target, value, result, page_changed }],
  elements_truncated?, banned?, typed_values?, spans?, keys?, urls?
}
```

The state has up to 250 element rows, 6,000 characters of visible text, and the last ten actions before trimming. Parse quoted names, bracket attributes, and the value after the trailing colon in a snapshot line. Remove ref and heading-level attributes from the state description; retain disabled, checked, selected, and expanded state. Disabled elements are not targets.

The direct STEP state carries the same task intent in this shape:

```ts
{
  goal: task,
  page: { url, title, text },
  elements: [{ index, label, role, value, operations, options? }],
  focus: { node, label, role, submitLabel, editable, value } | null,
  recent_actions: [{ action, kind, text, page_changed }],
  typed_values?, keys?
}
```

Rows can also carry checked, selected, and expanded state. The browser observation holds raw node identities, page and keyboard guards, geometry, and a fingerprint. These execution details remain in the browser layer. Request construction removes secrets before shortening text.

### 4.3 Request types

| Request | Engine | Trigger and answers |
|---|---|---|
| PLAN | All three | Unresolved profile, site, search, or goal |
| OBSERVE | `vercel` | `operation`, `page_kind`, operation-specific targets, speculative value and risk answers |
| STEP | `cdp`, `chromium` | `operation`, `page_kind`, `blocked_reason`, targets, `type_text_value`, goal-specific answer questions |
| TOURNAMENT | `vercel` | Multiple click-chunk winners; `target_final` chooses one |
| CONFIRM | `vercel` | Selected target needs a second decision; action, value, option, risk, scope, credential, and optional target-validity answers |
| RECOVER | `vercel` | An overlay remains after code recovery; `is_dismissible` and `dismiss_target` |
| EXTRACT | `vercel` | Extraction goal reaches DONE; `answer_<k>` selects candidate lines |
| ANSWER_FINAL | `vercel` | Multiple extraction winners; `answer_final` selects the answer |
| VERIFY | `vercel` | Act completion or extraction candidate; `done_final`, optional `answer_ok`, and `evidence_<k>` |
| WALL | All three | During human sign-in hand-off; `signin_wall` or `app_page` |

Vercel speculative questions include `value`, `submit_with_enter`, `value_from_page`, `irreversible`, `submits`, `in_task_scope`, `key`, and optional `open_url`. Check goals add `answer_state` and `evidence` to the main request in all three engines. Direct extraction goals add `answer_visible` and `answer_line` to STEP.

### 4.4 Limits and large pages

`assertOptionCount()` rejects empty choice questions and questions with more than 255 options. `checkBudget()` estimates token use from serialized state and questions. Current soft limits are 60,000 tokens for the full request and 28,000 for state plus the longest question, using 2.2 characters per estimated token. `src/types.ts` is the source for these values.

The `vercel` parser keeps up to 1,000 actionable elements. The question builder prioritizes roles and offers up to 400 candidates, with at most 200 per click chunk. A compact full snapshot supplies row and section context when needed. Duplicate collapse uses `role|name|under`; the nearest named ancestors form `under`. Ref changes must not move a ban to another element.

For an oversized raw snapshot, the `vercel` runner can request a depth-limited snapshot and a main-region snapshot. Its request trim sequence reduces or removes page text, shortens descriptions, reduces history, removes repeated links, caps state rows, and drops trailing click chunks down to one. Record every cut. If the request still exceeds the budget, return `page_too_large`.

The direct page script keeps up to 250 target actions, then adds scroll and wait controls. It records the omitted count. The request trim sequence reduces text from 6,000 to 3,000 to 1,500 characters, limits elements to 150, and finally drops the extraction answer-line question. Failure after the final step returns `page_too_large`.

Vercel extraction considers up to 1,800 lines, in requests of at most 600 lines and chunks of 200. Candidate lines live in question criteria. Direct extraction offers up to 254 unique visible lines plus `none`. Line length is capped at 160 characters in both paths.

## 5. Action checks and the task loop

### 5.1 Risk and confirmation

Risk classes are `read_only`, `navigational`, `data_entry`, `submit`, and `destructive`. The current threshold table in `src/types.ts` is:

| Risk | Target | Value | In task scope | Target valid | Human confirmation |
|---|---:|---:|---:|---:|---|
| read_only | 0.20 | 0.50 | 0.00 | 0.00 | No |
| navigational | 0.25 | 0.50 | 0.30 | 0.00 | No |
| data_entry | 0.30 | 0.55 | 0.40 | 0.00 | No |
| submit | 0.50 | 0.70 | 0.60 | 0.60 | With `--confirm always` |
| destructive | 0.70 | 0.85 | 0.80 | 0.85 | Required |

The `vercel` gate uses applicable columns for the selected action. Its risk is the highest class from the action, label keywords, and model risk answers. CONFIRM can ask `target_ok` for submit or destructive risk. A close runner-up blocks a submit or destructive target when its probability is at least half the selected target's probability.

The direct gate uses target confidence, value confidence, label-based risk, the runner-up rule for submit or destructive clicks, and human confirmation. It does not run the `vercel` semantic risk or `target_ok` questions. A supplied variable has value confidence 1 for the gate. Low target or value confidence bans the target and allows one new request per step. Before retrying, observe the page again and add a bounded, redacted `retry_reason` to the request state. The reason states which decision was rejected and that no input was sent. Report the retry in normal chat output. Reset target and value metadata before reading the next decision.

A model CONFIRM request and a human confirmation prompt have separate roles. `--confirm auto` asks the human for destructive actions. `always` also asks for submits. `never` blocks destructive actions. A required human confirmation without a TTY blocks with `needs_confirmation`.

In the direct engines, Enter is unavailable when observed focus is absent or the focused editor is empty. Offer TYPE_TEXT for supported editors and check their current values before submission. Enforce the same rule in execution if a model returns an unavailable Enter choice. Enter is at least a submit action. A destructive label on the focused control or its form makes it destructive. Apply the corresponding operation-confidence threshold and human confirmation before pressing Enter. Low Enter confidence uses the same one-retry budget and fresh observation as a rejected target; block as ambiguous if confidence remains below the threshold. Recheck focus and form state after the prompt. A dry run records the proposed action without executing it.

### 5.2 Direct iteration

1. Check the step and run limits, then use the held post-action observation or observe the page.
2. Check deterministic stall detection and save a screenshot if configured.
3. Build one STEP request from the observation, history, available values, bans, and DONE suppression.
4. Read the operation and matching target answer. A low-confidence BLOCKED can use the runner-up operation unless wall evidence supports blocking.
5. Handle sign-in, captcha, loading, and error-page conditions. One error-page back action is allowed.
6. Handle completion, an explicit block, or the selected browser action. Apply confidence, credential, repeat, and confirmation checks.
7. Before input, check the observation. A stale page causes a bounded new observation and decision. A persistently covered target is banned.
8. After an action, observe again, compare fingerprints, update history, and hold that observation for the next step.

WAIT polls for a change within its cap. After the per-URL wait limit, scroll when possible; otherwise block for lack of change. A history entry for an executed action remains recorded if the later observation fails to settle.

### 5.3 Vercel iteration

The `vercel` runner observes the interactive tree, page text, URL, and title. It joins a compact full snapshot when context or extraction requires it. It then runs OBSERVE and interprets page kind, operation, and targets.

A plain navigational click can use the direct path at target confidence 0.60 when risk checks allow it. A direct fill additionally needs one fillable field, a confident task value, and no credential or page-value requirement. A supplied variable can use the code path. High-confidence select choices can also use the direct path. Other candidates use CONFIRM with the selected element in state; this includes low-confidence candidates, multi-field fills, dependent options, page-derived values, and risky actions.

The action gate applies after either path. `submit_with_enter` can combine a `vercel` fill and Enter. `select_option` distinguishes native option labels from option refs. The browser wrapper classifies covered targets, unknown refs, timeouts, usage errors, closed tabs, visibility failures, and launch errors. Supported retries take another observation before acting.

After input, use bounded load and settle waits before the next observation. Browser envelope warnings trigger dialog dismissal without an extra dialog-status request.

### 5.4 Covered targets and overlays

For a `vercel` covered click, first try scrolling the target into view, wait for `coveredRetryMs` (300 ms), and retry. The action helper also supports a bounded longer retry. If coverage remains, press Escape and compare the page. If Escape did not clear the overlay, run RECOVER over fresh dismissal candidates.

RECOVER needs `is_dismissible` at least 0.50 and `dismiss_target` confidence at least 0.60. Prefer close or reject controls when ranking candidates. Cap recoveries per page. An unresolved overlay blocks or hands off in headed mode.

Each direct engine checks several points inside the target before input. It can act through an uncovered part of a card or row. If every point is covered, it observes again. Repeated coverage bans the target. It has no separate RECOVER request; visible dismissal controls remain ordinary click targets.

### 5.5 Stall and repeat detection

After an executed action, set `page_changed` from the before and after fingerprints. Three consecutive non-WAIT actions without a change cause `loop_detected`. Human-resume entries reset the direct stall sequence.

Direct fingerprints include URL, text, action semantics and values, and scroll state; geometry is excluded. Direct bans are scoped by URL and stable node identity plus action label. Execution counts ban a target after its repeat limit.

Vercel fingerprints include normalized URL, element identity, and typed values. Action signatures include the fingerprint, action, stable element key, and value. Per-page memory holds bans, waits, recoveries, and uncertainty counts. Repeated fingerprints without a new action signature also contribute to loop detection.

A model progress score or a model judgment about the last action is not used for stall detection. Code compares observations and counts executions.

## 6. Completion, blocking, and human hand-off

### 6.1 Act

In the `vercel` engine, operation DONE triggers VERIFY. `done_final >= 0.70` completes the task. After two rejected verifications, suppress DONE for two steps.

In the direct engines, DONE completes an act goal when `P(DONE) >= 0.50`. A lower value suppresses DONE for two steps. The direct engines have no separate VERIFY request. The operation prompt must therefore require evidence for the full goal.

### 6.2 Check

All three engines use `answer_state` and `evidence` from the main request. The answer choices are `yes`, `no`, and `not_visible_yet`. A yes or no at confidence 0.60 or greater completes the check. Return a boolean answer, `probability=P(yes)`, and the selected evidence.

An uncertain answer holds completion. After two holds on the same fingerprint, return `answer="unknown"` with the leading probabilities. `not_visible_yet` is never treated as a confident negative. A check does not require a separate VERIFY request.

### 6.3 Extract

The `vercel` engine builds candidates from the title, role-prefixed names in the full tree, and body text. It deduplicates lines and selects chunk winners. Multiple winners use ANSWER_FINAL; equivalent role-prefixed values can contribute to the same answer probability. VERIFY then needs `answer_ok >= 0.70`. Rejected lines are banned. An uncertain extraction can scroll and retry within its limits.

Each direct engine reads its answer from STEP. Completion requires `answer_visible >= 0.60` and an offered `answer_line` with confidence at least 0.20. Otherwise DONE is suppressed for two steps. The answer is the selected visible line, subject to secret removal.

### 6.4 Blocked and failed results

| Blocked kind | Cause |
|---|---|
| `needs_sign_in` | A sign-in wall remains after available hand-offs |
| `captcha` | A human verification check remains |
| `overlay` | A blocking overlay cannot be dismissed |
| `needs_confirmation` | Required confirmation is unavailable or refused |
| `needs_credential` | No suitable supplied value is available |
| `ambiguous` | Target, answer, or page stability remains uncertain |
| `loop_detected` | Repeats, unchanged actions, or exhausted waits prevent progress |
| `max_steps` | Step budget is exhausted |
| `impossible` | Supported operations cannot complete the task, or the error-page retry fails |
| `no_start_url` | Planning cannot select a usable start |
| `ambiguous_profile` | Planning cannot select the requested identity |
| `page_too_large` | Request exceeds the budget after trimming |
| `run_timeout` | Run time budget is exhausted |
| `human_aborted` | User aborts the pause or interrupts the run |

A blocked result includes a hint, relevant leading probabilities, and `resume: { session, url }`. Failure kinds are `browser`, `jev`, and `internal`. Failures are distinct from a supported decision to block.

Sign-in and captcha classification normally needs page-kind confidence 0.60. The `vercel` engine also combines a lower sign-in probability with credential fields, sign-in headings, or authentication hosts. The direct engines cross-check wall reasons against the operation and page-kind answers. Error-page handling uses the separate 0.70 gate.

### 6.5 Human hand-off

A headed run can pause with or without a TTY. Print `PAUSED`, then poll every five seconds: observe the page and ask WALL whether it is a sign-in wall or an application page. Resume on `app_page` at confidence at least 0.50. Stop at `pauseTimeoutMs`.

With a TTY, Enter also resumes and `q` aborts. Without a TTY, use page polling. Headless runs block with a hint to use `--headed`. Allow at most two pauses per run. Chat uses its existing readline input for prompts so task input and confirmation input share one owner.

## 7. Browser state, profiles, and resource lifetime

### 7.1 Observation and input

The direct snapshot reads visible text and supported controls in one page evaluation. It assigns stable node identities with a WeakMap and retains live node references for execution. Target actions exclude disabled, hidden, inert, and unsupported controls. Native selects expose available unselected options. Editable fields offer fill and click actions.

Before a targeted action, compare the page key and target guard. The page key includes document identity, URL, viewport, safe form values, and scroll state. The target guard includes identity, accessible name, value, state, link destination, and nearby form, dialog, or row text. Geometry is resolved and hit-tested immediately before input.

Keyboard input also compares `key_guard`, which includes focus and the focused control's surrounding state. A focus change, form change, or rich-text editor value change invalidates a pending Enter action. Native inputs, textareas, and contenteditable editors expose their values; contenteditable editors support true, empty, and plaintext-only attribute forms. Text changes elsewhere need not invalidate an unrelated targeted click or fill.

Document scrolling and panel scrolling are separate actions. A panel action retains its node identity and scroll position. Prefer a scrollable panel with focus, then the largest visible panel. Clip observations to the panel viewport and check that the panel is still usable before scrolling.

After input, use bounded readiness and render checks. Editable-combobox fills can wait briefly for options. A document that never reaches `readyState=complete` is accepted after the cap instead of paying the full wait on every observation. Navigation-context loss is a stale-page condition; a closed transport or command timeout is a browser failure.

### 7.2 Profile ownership

Each direct engine copies a named profile to its own jev-browser configuration directory and reuses it. It preserves cookies, storage, and preferences, and excludes caches, extensions, history, and other listed entries. `--refresh-profile` replaces the copy from the source profile. `--profile none` creates a temporary directory.

A copy is prepared in a staging directory. Write `jev-copy.json` when copying is complete, then rename the staging directory into place. A directory without the marker is incomplete. Log copy problems and files that change size during copying; a live source profile can produce an inconsistent database copy.

Acquire `<copy>.jev-lock` before copying or reuse and hold it until the launched browser process exits. Reject another launch or refresh while the lock exists. Preserve Chrome singleton locks. A remaining lock is not proof that its owner has stopped; after a forced stop, verify that no browser uses the directory before removing a lock manually.

The source profile is not modified by the direct copy operation. Changes made in the reused direct copy can persist between runs. The `vercel` profile-copy behavior belongs to `agent-browser`; it must not be described as the direct engines' persistent-copy mechanism.

### 7.3 Launch, attach, and close

This section applies to `cdp` and `chromium`. Browser resource handling for `vercel` belongs to the `agent-browser` adapter.

A launched Chrome or Chromium process uses `--remote-debugging-pipe`; the client sends NUL-terminated JSON on the child pipes. An attached browser uses its DevTools WebSocket. CDP matches responses to pending command identifiers, routes events by session, enforces command timeouts, and rejects pending calls when the transport closes.

Each session creates and owns a tab. In attach mode, create the tab in the background and retain the existing viewport. Closing an attached session closes its owned tabs and connection, not the user's browser.

The one-shot CLI closes resources after completion and errors. With `--cdp --keep-open`, it leaves the tab open but disconnects so the CLI exits. A pipe-launched browser cannot outlive the one-shot process through this flag, so that flag combination is rejected. SIGINT also handles a launch in flight within a bounded wait.

Chat retains the browser and its tab between tasks. `/close`, profile or headed-mode changes, quit, EOF, and interruption end the owned browser session. If the connection has closed between tasks, a later task can launch a new browser.

Alerts and before-unload dialogs are accepted. Confirm and prompt dialogs are dismissed. Handle dialog events promptly because an open JavaScript dialog can block renderer commands.

## 8. Secrets, HTTP transport, and observability

`redactingOracle()` removes known secrets from every request, including planning and hand-off requests. Request builders remove secrets before text caps can leave a partial value. `redactData()` processes string values before JSON escaping. Preserve candidate identifiers so answer lookup still works. Redaction must not mutate the browser observation or the original value used for input.

The logger applies redaction to plain messages and structured data. Final results are also redacted, including titles, URLs, evidence, and failure details. API keys, environment files, profile copies, and runtime logs stay out of version control.

Chat loads a key from the environment or its configuration file. Saved keys use mode 600; the configuration directory uses mode 700 when created. Validate a supplied key with a small request and remove the key from reported validation errors. Configuration paths can be overridden for isolated tests.

One HTTP transport serves key validation, model requests, and optional warm-up calls. It reuses a connection and limits warm-up time. Chat sends idle warm-up requests while waiting for input. A running task owns its model traffic. Closing the transport aborts outstanding warm-up work so it cannot delay exit.

Step records include operation and target confidence, runner-up probability, value confidence, risk, gate, action, result, request count, and duration. Debug logs add request state, answer probabilities, cuts, and token use. The result records total time, model round-trip time, browser time, token use, request count, pauses, and engine. Overlapping planning and browser work means component times can exceed total elapsed time. The `vercel` engine currently reports browser time as zero.

## 9. CLI and result contract

[README.md](README.md) describes user commands, flags, and engine settings. [src/cli.ts](src/cli.ts) and [src/chat.ts](src/chat.ts) define the accepted arguments. [package.json](package.json) defines runtime requirements and scripts.

The one-shot CLI accepts engine, profile, refresh, browser binary, start URL, goal, headed mode, CDP attachment, variables, step and time budgets, confirmation, dry run, session, model, logging, keep-open, and screenshot options. Default engine is `cdp`; `JEV_BROWSER_ENGINE` can set the default. `--engine` overrides a valid environment default. The accepted names are exactly `cdp`, `chromium`, and `vercel`; `fast` and `legacy` are rejected. Chat exposes the supported subset through flags and session commands.

`bin/jev-browser.js` loads the package-local `.env` when present and starts the TypeScript entry point. API access requires `TYPESAFE_API_KEY`. Chat can use its saved key. `TYPESAFE_DEFAULT_MODEL`, `JEV_CHROME_BIN`, `JEV_CHROMIUM_BIN`, `JEV_BROWSER_BIN`, `JEV_BROWSER_MAX_STEPS`, profile/session variables, and configuration overrides are resolved by their owning modules.

For a completed run attempt, stdout is one versioned `RunResult` JSON document. The trace goes to stderr. Help, version, and argument errors use their dedicated output paths. Chat uses human-readable results and session totals.

The result fields are defined in `src/types.ts`:

- Identity and status: `version`, redacted `task`, `goal`, `outcome`, `reason`, and `confidence`.
- Answer: an extract value with line identifier and evidence, a check boolean or `unknown` with probability and evidence, or null.
- Location and plan: `final_url`, `final_title`, `profile`, and `start`.
- Execution: ordered `steps`, optional `blocked` details, optional `error`, and `stats`.

Step records use `operation` and `operation_conf`. Consumers must use the shared result contract for all three engines. `stats.engine` records the selected public engine name, including failures and interrupted runs. `StepRecord.path` keeps its decision-path values (`fast`, `confirm`, `code`, or null); it is independent of engine selection.

| Exit code | Meaning |
|---:|---|
| 0 | Done |
| 2 | Blocked |
| 3 | Failed |
| 4 | Usage or configuration error |
| 130 | Interrupted |

Default limits are 25 steps, 30 seconds per browser command, 600 seconds per run, and 300 seconds per human pause. These are checked by the relevant loop, command, and pause paths; they are not a single global cancellation timer. Exact ranges and overrides are defined by the argument parsers.

## 10. Validation and risk controls

Run `npm test` and `npm run typecheck` for code changes. Also run `npm run test:live` for changes to page scripts, CDP, profile ownership, or process cleanup. The live suite uses local fixtures and an API stand-in; it requires Chrome but does not need a real Jev key. The suite tests attachment under both direct engine names against Chrome. A Chromium launch needs separate verification with an installed Chromium binary.

Use [test/fakes.ts](test/fakes.ts) for Oracle, Human, logger, transport, and `vercel` browser fakes. Use [test/fast/fakes.ts](test/fast/fakes.ts) for direct browser and observation fakes. Stored fixtures and local HTML pages live under [test/fixtures/](test/fixtures/).

Maintain coverage for these behaviors:

| Area | Required cases |
|---|---|
| Engine selection | All three public names, flag and environment precedence, rejected old names, engine-specific binary discovery, isolated profile paths, selected name in success and failure results |
| Task and plan | Span extraction, URL order, variables, profile precedence, default profile, ambiguity, current-page continuation, PLAN skipped or overlapped |
| State and budgets | Parsed state and values, disabled controls, stable identities, per-operation heads, choice limits, trim order, oversized-page block |
| Decisions | Every goal, supported action, completion hold, block reason, risk band, runner-up rejection, missing value, dry run, repeat and wait cap |
| Vercel execution | Tournament, dependent CONFIRM, select options, page-derived values, covered-click retry, Escape and RECOVER, extraction and VERIFY |
| Direct execution | Fresh and stale targets, focus changes, form changes, covered geometry, dynamic text, native select, document and panel scrolling |
| Secrets | Real fill followed by another request, quotes and backslashes, newlines, nested log data, long values before trimming, final results, unchanged browser input |
| Human interaction | Headless block, headed polling without a TTY, TTY resume and abort, prompt refusal, exhausted pause budget |
| Ownership | Concurrent profile launch and refresh rejected, existing locks retained, lock release after exit, temporary cleanup, attached tab preservation |
| Process lifetime | SIGINT during launch, error cleanup, CLI exit with keep-open after success and failure, chat connection reuse |
| Interfaces | Exactly one result JSON document, exit mapping, argument errors, browser envelopes, CDP response matching, HTTP connection close |

Use process-level assertions for exit behavior; a mocked close call cannot establish that a process exits. Keep pure decision logic and parsing extensively covered, and cover every reachable terminal outcome. Fixed test counts are not a completion criterion.

The main risks and controls are:

- Similar targets: retain role and row context, apply confidence thresholds, and report ambiguity with leading probabilities.
- Premature completion: require detailed evidence, apply goal-specific completion checks, and suppress rejected DONE choices.
- Wrong field or value: restrict candidates, check current values, apply credential rules, and use dependent questions where the engine supports them.
- Slow or changing pages: use bounded settling, fresh observations, and stable target identities before retrying.
- False stalls: include field and scroll state in fingerprints and count action signatures.
- Excessive requests: cap candidates and history, apply ordered trimming, and block after budget exhaustion.
- Profile interference: hold exclusive ownership and preserve existing browser locks.
- Secret exposure: redact structured data at request, log, and result boundaries while retaining original input locally.
- Browser and API changes: keep transport and error mapping isolated, with fixtures and bounded failures.

## 11. Acceptance runs

[scripts/smoke.ts](scripts/smoke.ts) runs the following three cases through the real CLI. Run it with `npm run smoke`; set `SMOKE_ENGINE` to `cdp`, `chromium`, or `vercel` to select the engine. The default is `cdp`. It reports pass/fail, confidence, requests, tokens, and timing, and exits 1 if a case fails.

These cases need the real API and browser state. The Parallelloop and Gmail expectations depend on the prepared account and copied profile for the selected browser. Chromium needs its own prepared profile; Chrome profile state is not shared automatically. They are not substitutes for isolated regression tests.

1. `jev-browser "open wikipedia.org and search for Alan Turing, then tell me the title of the article" --profile none` must return done with an extract answer containing `Alan Turing`.
2. `jev-browser "open app.parallelloop.ai, login using gmail and check if licious account project has 3rd September artifacts"` must return done with a true check answer, evidence containing `Licious Sept3 Session`, and a final URL under `app.parallelloop.ai/workspace/licious-data-project`. The prepared scenario targets four to six steps; the smoke script enforces the upper bound of six.
3. `jev-browser "open mail.google.com in the Parallelloop profile and read the subject of the newest email"` must return blocked with `needs_sign_in` and a hint containing `--headed` when the prepared copy is signed out. It must not crash.

The account state can change. Record the starting conditions and actual result when interpreting a smoke failure. Run tasks against real accounts only within the user's requested scope.
