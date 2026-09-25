# jev-browser-use design

This document defines the design of the one-shot CLI, chat mode, and the MCP server of the assistant plugin for `jev-browser-use`. The package name is `jev-browser-use`; the command names remain `jev-browser` and `jev-chat`. Configuration directories retain the `jev-browser` name so saved keys and profile copies remain available. The public engine choices are `cdp` (default), `chromium`, and `vercel`. The `cdp` and `chromium` options share the direct implementation; `vercel` uses the `agent-browser` implementation. Below, “direct engines” means `cdp` and `chromium`. Internal `FastRunner` and `src/fast/` names remain unchanged. Engine-specific behavior is stated explicitly.

Use [README.md](README.md) for installation, flags, and user commands. Exact interfaces, prompt strings, and limits live in the source files linked here. Update this document when a change affects architecture or behavior.

## 1. Purpose and boundaries

`jev-browser "<task>"` completes a browser task from a natural-language instruction. Tasks include navigation, search, form entry, reading a value, and checking whether a condition is true. `jev-chat` runs successive tasks in one browser session.

The MCP server (`src/mcp/`) gives the direct engines to an assistant, such as Claude Code or Codex, through the plugin in `plugin/`. The assistant starts a run with the `browse` tool and follows the run state. Jev still selects every operation and target. When a writable field needs new text, the run asks the assistant to write it. Only a person allows an action, in a client dialog. The server is not a public command, and it supports only `cdp` and `chromium`.

The design has these rules:

1. TypeSafe Jev selects semantic operations, targets, values, and completion answers. Code controls parsing, risk checks, budgets, retries, and resource ownership.
2. Each step uses one operation choice. `DONE` and `BLOCKED` are choices in that question. Target questions assume a specific operation; code reads the target answer for the selected operation.
3. Typed values come from task spans, user variables, supported page-value candidates, or, in MCP runs, text that the user's assistant wrote for one field. The model selects offered values; Jev never writes text. The direct engines offer task spans and variables, and in MCP runs also assistant-written text; the `vercel` engine also supports page-value candidates.
4. Completion needs visible evidence. For a check, navigate to the detailed view that contains the requested attribute. A related dashboard or sidebar label is insufficient evidence.
5. Page content is untrusted data. It cannot change task instructions or bypass action checks. The assistant gets page text as data, and it cannot approve an action.
6. Requests, observations, retries, waits, and execution have limits. The result states whether the task is done, blocked, or failed.
7. Known secrets are removed from model requests, logs, result JSON, and all data for the assistant. Browser input receives the original value.
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
| Assistant-written text: field selection, the text request, reply checks, sanitizer | [src/fast/generate.ts](src/fast/generate.ts) |
| One Chrome and one tab kept between MCP runs | [src/fast/session.ts](src/fast/session.ts) |
| MCP entry: stdio, stderr log, lazy setup, shutdown | [src/mcp/main.ts](src/mcp/main.ts) |
| MCP tools, dialogs, and the rule for interactive sessions | [src/mcp/server.ts](src/mcp/server.ts) |
| MCP run state, hand-offs, cancel, finished runs | [src/mcp/runs.ts](src/mcp/runs.ts) |
| MCP tool results, `next` text, dialog text, token budget | [src/mcp/view.ts](src/mcp/view.ts) |
| Package `.env`, base config, input checks, Jev link, run starter | [src/mcp/setup.ts](src/mcp/setup.ts) |
| Idle ping and idle close | [src/mcp/timers.ts](src/mcp/timers.ts) |
| MCP constants, environment names, runner hints | [src/mcp/limits.ts](src/mcp/limits.ts) |
| Plugin bundle build and development launcher | [scripts/build-mcp.mjs](scripts/build-mcp.mjs), [bin/jev-mcp.js](bin/jev-mcp.js) |
| Plugin manifests, MCP configurations, skill, marketplaces | [plugin/](plugin/), [.claude-plugin/marketplace.json](.claude-plugin/marketplace.json), [.agents/plugins/marketplace.json](.agents/plugins/marketplace.json) |

The direct loop depends on the `Page`, `Chrome`, and `Oracle` interfaces. Browser modules perform I/O; policy modules construct questions and interpret answers. Keep this separation so decision tests can run without Chrome or the API.

The MCP server does not change the loop. It gives `FastRunner` its own `Human`, and also a `TextSource`, an `AbortSignal`, `RunnerHints`, and `fromAssistant: true`. The CLI and chat give none of the last four, so their requests and hint texts stay the same. Only `src/mcp/server.ts` and `src/mcp/main.ts` import the MCP SDK. `runs.ts`, `view.ts`, `setup.ts`, and `timers.ts` have no SDK imports, so tests can use them without a client.

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

In MCP runs, the assistant can add generated spans. A generated span has the id `g<n>`, the source `generated`, and `secret: false`. Its `field` binds it to one field: the key `<doc>|<node>` (the document's `performance.timeOrigin` and the node identity at request time), the redacted field label, and the text request id. A step request offers only the generated spans of the current document, because a span of another document can never pass the binding check. When a new document loads during the wait for text, the spans of that request are removed, and the re-ask says that the text was dropped. The CLI and chat never create generated spans.

`canWriteInto()` in `src/fast/policy.ts` decides which fields can take assistant text. All of these must be true:

- The action is a fill, and its role is `textbox`. This excludes search boxes, comboboxes, and number fields.
- An input has no type or the type `text`. This excludes email, phone, and URL inputs, which the snapshot maps to `textbox`.
- The `autocomplete` token does not match `EXACT_AUTOCOMPLETE` (for example `email`, `tel`, `username`, `one-time-code`, `cc-*`, and address tokens).
- The label matches neither `CREDENTIAL_NAME` nor `EXACT_VALUE_NAME` (recipients, amounts, prices, card and account numbers, address parts, user names, URLs, keys, tokens, and search).

With `fromAssistant`, the assistant wrote the task and the vars, so code does not treat them as the user's own words. A credential field never takes a value, secret or not; the hint tells the user to type it in the Chrome window. A var needs Jev's own confidence against the value gate, as a task span does; only a CLI or chat `--var` counts as 1 (section 5.1). A non-secret task or var value that fills a multiline field counts as unsent assistant text (section 5.1). Every non-secret task or var value goes through `sanitizeText` before it is typed, as generated text does, so the page gets the text that the dialog shows. A secret value is typed as it is. Step records and history keep at most 120 characters of a typed value; the page gets the full text. The value is redacted before it is cut, so a cut never keeps part of a secret.

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

The direct request asks the value of each TYPE_TEXT field in its own question, `value_<key>`. The question names its field (`[key] label`, role, current value). A single question for "the field that the TYPE_TEXT question chooses" does not know the field. Its answer mixes the values of every likely field, and on a form with two or more fields it fell below the 0.55 value gate. In a replay of bench requests, the per-field questions chose the right value for 48 of 51 plugin fields and 36 of 42 CLI fields, against 21 and 18 for the shared question. The step request holds up to `LIMITS.valueHeads` (8) value questions: the focused field first, then the empty fields, then the others. A fill of a field without a value question sends one more request, `VALUE`, with the same state and only that question (`buildValueStep`). An oversized request drops the extra value questions before it cuts page text. A `VALUE` request over budget blocks `page_too_large`, as a STEP request over budget does.

A value question can also offer `generate`, but only for a field that passes `canWriteInto` in a run with a text source (`canGenerate`). `meta.generate` is true when such a field is offered. Only then do the TYPE_TEXT operation text, the value question, and the `needs_credential_or_value` reason use the `*_GEN` texts in `src/fast/policy.ts`. `generate` means "write new text for this field"; the loop then asks the assistant. A search box, an email field, or a credential field never offers `generate`. Without a text source the request has no `*_GEN` text. `readValue` reads `generate` only from a question that offered it; otherwise it reads `none`.

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

A generated span shows in `typed_values` in a fixed form: `{ id, text, secret: false, source: "generated", field }`. The text is cut to 120 characters, and `field` is the bound field label. `typed_values` lists generated spans first, then the other spans, with `MAX_GROUP` as the cap for both groups together. The operation and target questions read it:

1. Until a fill types text that the assistant wrote in this run (`StepInput.textTyped`), it lists every span. This is always true without a text source. A shorter list lowered the operation confidence in a fill: a long project name got 0.39-0.54 against 0.82 in the CLI; a workflow name got TYPE_TEXT 0.75 with the whole task listed and 0.33 without it, and a click on the field won 8 of 8 asks. The whole task also lowered false DONE on a date picker (0 of 24 against 5 of 24).
2. After that fill, it lists every span except the whole task and the clauses. On a project form whose description was written first, the name then went in 13 of 24 asks, against 3 of 24 with every span and 4 of 24 with only the spans that a value question offers. The offered-only list also let "Create Project" pass its gates with the name empty in 5 of 24 asks. After a chat send, p(DONE) was about the same with each list (0.70 against 0.60-0.69).

**Vars in plugin runs.** In a run with a text source, a value question shows a non-secret var as `{ var: <key>, value: <text> }`. The assistant chooses the key, and SKILL.md tells it to name the key after the field label. With the key, a vars-only question gave "message" 0.81-0.84 against 0.67-0.70 without it. The CLI shows the text alone.

A var and `generate` both mean "the caller's text goes here", so a value question that offers both splits between them. With a var "brief" and the task "Describe the workflow and send it", the question gave the var 0.41-0.56 and `generate` 0.41-0.57, and neither passed the value gate. In the plugin, 0 of 15 runs of that case passed. The var fallback (`resolveValue` in `src/fast/loop.ts`) runs only in plugin runs, only when the answer is `generate` below the value gate or a var below it, and only when the question offers a non-secret var that no fill of this run typed:

1. One VALUE request offers only those vars and `none`, with the VALUE_Q text (`buildValueStep` with `{ vars }`). A var at `GATES.varOnly` (0.75) or above is the value.
2. Otherwise one VALUE request offers the question without its vars (`{ noVars: true }`). An answer other than `none` is the value. For `generate`, the assistant writes the text.
3. Otherwise the first answer stays, and the value gate applies to it.

With only vars and `none`, a var that is not the text of the field can still get a high confidence: a var with the general key "text" went to "Project Name" at 0.61-0.70. The correct vars got 0.78-0.89 ("message", "description", "name"), and "brief" got 0.69-0.79. At 0.75, a brief below the gate goes to the assistant, which writes the text; the send dialog shows it. A general key at 0.75 or above can still go into a wrong field. This case stays open. The fallback adds one or two requests of about 350 ms, only when the question splits. A generate that is confident (0.85-0.96 on a brief with a channel var) sends no extra request.

The value question of a field offers:

1. In a field that can take new text, in a run with a text source: the text written for this field (never text written for another field), then the task and `--var` spans, then `generate` and `none`. It leaves out `clause` and `whole_task` spans, `after_verb` spans of more than `LIMITS.genSpanWords` (4) words, descriptions of text, and task spans whose text repeats the written text. The two values of a maybe cut are the exception: see the pair rule below. Without the fragment filter, Jev chose the whole task as the chat message 3 of 3 times; two options with the same text split the probability.
2. In a field that can take new text, in a run without a text source: the task and `--var` spans without `clause` and `whole_task` spans, without descriptions of text, and without `after_verb` spans of more than 4 words whose verb does not name the value. A long name after `named`, `called`, `titled`, `type`, `enter`, `fill`, `search for`, `find`, or `query` stays. Jev then answers `none` for a message that the task only describes, and the CLI does not type or send the instruction itself ("send hello team, standup moved to 11 am in the chat", "a polite message that confirms our meeting on Tuesday"). A value after `to` or `as` of more than 4 words is also left out ("set the subject to Quarterly budget review for Q3 planning"): the field then answers `none`, and the run asks for `--var` or quotes. The two values of a maybe cut are the exception: see the pair rule below.
3. In any other field (a search box, an email field, a credential field): every task and `--var` span, then `none`.

A description of text is an `after_verb` span that starts with a lower-case "a", "an", or "some" and names a kind of text (message, reply, note, description, summary, comment, and similar), at any length: "with a short change note", "type a polite message that confirms our meeting". A title in title case ("A Note on Pricing") and the object of `named`, `called`, or `titled` are names and never count. The CLI typed and saved "a short change note" 3 of 3 times, and "a short description" 1 of 3 times, before this rule.

When a rule leaves out a span, it also leaves out the spans cut from it (`Span.parent`): the cut before the first preposition ("a short description" of "a short description of the follow-up") and a proper noun that starts it and cuts it short ("My Quarterly Report Draft" of "My Quarterly Report Draft 2026"). The first words of a hidden value are a wrong, shorter value. A name is two or more capitalized words, with name particles between them ("Ludwig van Beethoven"). A cut that is a name is not a cut when the span goes on with a person qualifier ("from", "at", "by", "who", "that", "which") or with a preposition before lower-case words ("with the leads"), or does not go on: "Sarah Connor" of "Sarah Connor from the Berlin office" stays. When capitalized words follow "for", "with", "on", or "and", the span is one title, and its first words stay a cut: "Weekly Sync" of "Weekly Sync with Design Team". A value of more than 10 words is not a span, but its cuts are (`Span.longCut`). In a value (after named, called, titled, to, or as), a cut that ends at or before the first "and" before a lower-case word is not a long cut when that word is a verb that starts a next step (a step or flow verb, or leave, navigate, take, switch, view, note, let, look, scroll, observe, sign, log): "Priya" of "Assign the bug to Priya and leave a note that the crash only happens on older Android phones", "Acme" of "Rename the workspace to Acme and reload the page to confirm ...". Before a noun it stays a long cut: "Crash" of "Crash and data loss when uploading large files from the mobile app" is the start of a title. A maybe cut of a value of more than 10 words is offered alone, because the longer value is not a span ("Weekly sync" of "Weekly sync and make sure the reminder toggle is turned on"). A field that can take new text leaves the other long cuts out: "Type can you summarize the key points of the Q3 report for me" does not offer "can you summarize the key points". A search box and a field that takes an exact value keep them ("machine learning engineer jobs" of a long query, "John Smith" of "John Smith from the Berlin office who leads ...").

A maybe cut and its longer value are a pair (`Span.pair`: each names the other). Each value of a pair meets the hide rules by its own text and verb. When one of them passes, the head shows both; when both fail, it hides both. So "Set the channel topic to Launch prep and open Settings" offers "Launch prep" and "Launch prep and open Settings", and "Type hello and send it to Ann" offers "hello" in the plugin too. A longer value that shows only because of its pair does not show its own cuts: "Launch" of "Launch prep and open Settings" stays hidden. It also goes when the head drops its cut because the cut repeats the text written for the field. An earlier version gave the maybe cut the longer value as its parent. The head then hid the cut with its long parent and offered only words of the next step ("Settings", "the list"). In the round-7 lab, the CLI then blocked 36 of 36 times on three such tasks, and the plugin lost "hello". When the head offered both values, Jev chose the right one 94 of 96 times in the CLI and never chose a wrong value above the 0.55 value gate. Both values lower the confidence of a short right cut ("invoices": 0.48-0.66, against 0.65-0.72 with one value), so a run can ask again; it does not type a wrong value. In the plugin, a task value typed into a multiline field is unsent assistant text, so the send dialog shows it (section 5.1).

An `after_verb` value ends at a clause break and also at "and" before the next step of the task (`stepAfterAnd`). Only a sentence dot is a clause break: a dot before a space, another dot, or the end. A dot inside a word is part of the value ("report.pdf", "Q3 Report v2.1"). A value that starts with a URL or a domain ends at the "and" after it ("Go to amazon.com and search for running shoes" gives "amazon.com"). The step verb (save, send, open, invite, and about 60 others) must be in lower case. The word after the verb is read without the marks before and after it: "Save" in quotes, backticks, bold, or brackets counts as Save ("and click \"Save\"", "and click `Save`", "and press **Enter**"). A word of marks only is skipped ("and press ⏎ Enter"). Each "and" is one of three kinds:

- Sure: the value ends there. Click or tap before the end of the task or a clause, a capitalized word, an article, a pronoun, "on", or a lower-case control or key name ("and click Save", "and click save", "and click on it"); press or hit before the end, a capitalized word, a control or key name, a key chord in any case, "the", or "on" ("and press Enter", "and press cmd+s"); submit before the end, a capitalized word, an article, or a pronoun; a verb for people before a name ("and invite Ann Lee"); any step verb that ends the task or a clause, or takes a pronoun, an article, "to", "with", or "then" ("and save it", "and open the artifact"); "back", "now", or "changes" at the end ("and go back", "and save changes"); "back to" after a step verb that is not a send verb (save, send, post, reply, publish, submit) ("and go back to the list"); any step verb before a lower-case task field and "to" or "as" ("and set priority to High", "and change status to Done", "and mark severity as critical": priority, status, assignee, owner, severity, stage, column, due date, estimate, milestone, sprint), except in a search query; a step of a form flow before a pronoun ("and verify it", "and download it"), except in a search query; and a two-word step (sign in, up, or out; log in or out; make sure) at the end of a clause or before a pronoun, when the words before the "and" hold no sign or log step ("and sign out", "and make sure it is saved"), except in a search query. The steps of a form flow are continue, proceed, finish, apply, cancel, verify, ensure, refresh, reload, wait, download, export, and edit. "sign" and "log" alone never cut ("review and sign the contract" stays whole).
- Maybe: another step verb before a capitalized word ("and open Licious", "how to install and run Python", "Review and approve Q3 budget"); "back", "now", or "changes" with more words after them, "changes to" and "now to" after any step verb, and "back to" after a send verb ("approve changes to pricing", "Review and publish changes to the docs site", "Review contract and send back to legal"); a step verb before one or two other lower-case words and "to" or "as" ("and move card to Done", "how to copy and paste text to Excel"); a step verb before "label" or "tag" and one word at the end ("and add label bug"); a step of a form flow at the end, before an article, or before a capitalized word ("and continue", "and refresh the page", "Hurry up and wait", "Deploy and verify the fix", "draft and edit the blog post"); a two-word step in any other place ("User can sign up and log in", "Pack bags and make sure passports are ready"); and in a search query, the sure forms of a task field and of a form flow ("how to set and change status to away", "how to pause and continue a download"). A maybe cut whose longer value holds a quote mark after the "and" is offered alone, because a value with a quote mark inside is not a span ("Fix login bug" of 'Create a task named Fix login bug and choose "High"'). The same words start a step in one task and belong to a query or a title in another, so both values are offered as a pair: the cut first, then the longer value.
- None: the "and" belongs to the value. A title in title case ("Show and Tell", "Save the Date and Send Invites"), a noun after a word that looks like a verb ("closed and open issues", "Budget and schedule update", "Media and press releases", "Opens and click rate", "Grow revenue and hit 1M ARR"), and a quote.

So "rename it to budget review and save it" gives "budget review", "Rename the file to budget and click Save" gives "budget", and "Change the project instructions to Always answer in English and save" gives "Always answer in English". A cut before every capitalized word lost "how to start and stop Docker containers" and saved "Review" as a task name. A cut before every click, press, or hit saved "Media" for "Media and press releases". A sure cut before every step of a form flow lost "how to pause and continue a download" and "Hurry up and wait", so most of those cuts are maybe cuts. A cut before the first preposition that goes past a maybe "and" is neither value, so it is not a span ("hello and send it" of "hello and send it to the team", "Review and approve changes" of "Review and approve changes to pricing").

A lead word or a kind of text at the start of a message after type, write, enter, fill, or put ("in", "out", "the message", "the text", "the reply", "the following") makes a maybe cut: "Type in hello world" offers "hello world" first, then "in hello world", and "Type the message Hello team" offers "Hello team". The lead word counts only in lower case, and "out of" is not a lead: "Type The text is too small", "Type In Progress", and "Type Out of office" stay whole. A message after type, write, enter, fill, or put ends only at "and" before a step that sends it or acts on the page: click or tap before the end, a capitalized word, "the", "on", or a control name; press or hit before the end, a capitalized word, a control or key name, or a key chord in any case, or before "the" and a key name or up to two words and key, button, arrow, or icon ("and press the Enter key", "and hit the Send button", "and press the down arrow", "and press ctrl+enter"); send, post, reply, save, publish, or submit at the end, before a pronoun at the end, or before "the message" (or another kind of text) at the end ("Type hello and press Enter" gives "hello", "write thanks and send it" gives "thanks", "type hello team and send the message" gives "hello team"). A send verb (or share) before "[it or the message] to <someone>" or "now", before a pronoun and more words, before a determiner and a kind of text, or before with, by, using, or via is a maybe cut ("and send it to Ann", "and send it to the team", "and post it to #general", "and send the message to Ann", "and send it now", "and send it right away", "and post it in #general", "and save it as a draft", "and save the draft", "and send your message", "and send with ctrl+enter"). So is "use the Send button" or "use the Enter key". Share is not a send verb: "and share" and "and share it" at the end are maybe cuts, and a sentence before them keeps the message whole ("Type Please read and share" offers "Please read" and "Please read and share"; "Type I'll read and share" stays whole). A key chord with a dash or spaces is a chord ("ctrl-enter", "cmd + enter"). It is not a cut when the words before the "and" hold a subject pronoun ("thanks I will read and send it to the team", "I will check and reply to Ann"), when the person is you, me, us, him, her, or them ("and send it to you tomorrow"), or when reply goes to a lower-case word ("and reply to the RFC"). Other words stay in the message: "type we will review and approve it", "I will check and reply to you soon", "we shipped and hit our target", "we shipped and hit the Q3 target", "please sign and submit the form by Friday". A cut there gave a wrong short message ("we will review", "thanks"). After type, enter, fill, or put, a pick from a list is sure too ("Type Berlin and select the first suggestion" gives "Berlin"), unless a subject pronoun starts the value. So is a step that watches the reply, unless the words before the "and" hold a subject pronoun: wait at the end, or wait, check, verify, confirm, ensure, see, or make sure before a word for the reply (reply, response, answer, result, output, bot, assistant, agent) after only small words ("Type hello and wait for the response", "Type hi and check that the bot replies"). When another noun comes after the reply word, and for other "wait for" or "wait until", it is a maybe cut ("Type hi and check the answer key", "Type please restart and wait for the update to finish"). Other watch words stay in the message ("Type thanks and confirm the meeting time"). A value after "with" or "as" is a message only when it is a sentence: a subject pronoun starts it, or a subject pronoun with a helping verb (will, can, am, have, 'm, 'll, and similar) comes before its first "and" ("Reply with we will review and approve it", "Reply with thanks I will read and share it"). A title has no helping verb: "Save the filter as Issues I reported and close it" gives "Issues I reported", and "Save the doc as Phase I plan and close it" gives "Phase I plan". "Reply with ok and close it" gives "ok", and "Save the text as budget notes and close it" gives "budget notes". An earlier version kept every message whole, so "Type hello and press Enter" offered only "hello and press Enter", and the CLI typed and sent it. A version that read "the post" or "the chat" before "with" as a message verb kept "urgent and assign it to Ann" as one value. A version that read any subject pronoun before the "and" as a sentence offered nothing for "Issues I reported". These wordings stay open: "Write hello and wait for the response" keeps the watch step, because write always gives a message; "Type ace and continue" keeps "and continue", because the steps of a form flow cut only in a value; a label of marks only at the end ("and click ✓") does not cut.

The table in `test/fast/value-corpus.test.ts` holds the task wording of every review round with the value that a head must offer, the wrong values that it must not offer, and the wrong values that it can offer only together with the right value (`notAlone`). A change to these rules must pass all of it.

`extractSpans` also drops fragments around a quoted value. An `after_verb` or `clause` fragment loses its outer quote marks, and a fragment that still holds a quote mark is not kept (`projects for "jev browser` goes, `"jev browser` becomes a duplicate of the quoted span). A `'` or `’` is an apostrophe, not a quote mark, when a letter comes before it and a letter comes after it (`it's`, `O'Brien`, `Macy’s`), or when a letter comes before it and no single quote is open (`kids’ shoes`). A `‘`, or a `'` with no letter before it, opens a quote, and the next `'` or `’` with no letter after it closes it. So `‘Macy’s’` is the quoted value `Macy’s`, and `it's done to O'Brien` has no quoted value. After a search verb (`search`, `search for`, `find`, `look up`, `query`), a fragment that starts with a quoted value and adds lower-case words after it stays without its quote marks (`"machine learning" jobs` becomes `machine learning jobs`). Words that start another instruction or name the field, the site, or the place end that form (`and`, `then`, `as`, `for`, `on`, `in`, `from`, `now`, and similar, and any capitalized word): `"jev browser" and open the first result` and `"Ada Lovelace" on Wikipedia` are not values. A mark after a letter or a digit is an apostrophe when no quote is open (`80's music`). Without this cleanup, a quoted search query got a value confidence of 0.41-0.53 in its own field; with it, 0.56-0.64. A verb with extra spaces inside ("search  for") is read as the same verb.

The observation also carries field facts that never reach Jev: `form` (the identity of the field's form or dialog), `multiline`, `inputType`, `autocomplete`, `maxLength`, the document id `doc`, `filled` (the node ids of all form controls in the document with a non-blank value, in view or not), and `texts` (the node id and value of each such control that is rendered: not hidden, aria-hidden, or inert). The focus also carries `form` (with the same identity as the actions' `form`), `submitDefault`, the name of the form's first submit control in tree order (image buttons count), or "" when that control is disabled, and `multiline`; the state for Jev leaves all three out. Form identities come from their own counter, so element node ids and the step request stay the same as without these facts. `actionSpace` and the target criteria copy only named fields, so these facts stay in code.

### 4.3 Request types

| Request | Engine | Trigger and answers |
|---|---|---|
| PLAN | All three | Unresolved profile, site, search, or goal |
| OBSERVE | `vercel` | `operation`, `page_kind`, operation-specific targets, speculative value and risk answers |
| STEP | `cdp`, `chromium` | `operation`, `page_kind`, `blocked_reason`, targets, one `value_<key>` per TYPE_TEXT field (up to 8), goal-specific answer questions |
| VALUE | `cdp`, `chromium` | A fill of a field without a value question in STEP; the STEP state and one `value_<key>` |
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

The direct gate uses target confidence, value confidence, label-based risk, the runner-up rule for submit or destructive clicks, and human confirmation. It does not run the `vercel` semantic risk or `target_ok` questions. A `--var` of the CLI or chat has value confidence 1 for the gate. In a plugin run (`fromAssistant`), the assistant wrote the vars, so a var needs Jev's own confidence, as a task span does. Low target or value confidence, or a close runner-up, bans the target for the rest of the step and allows one new request per step. The next step offers the target again. A dialog does not change the URL, so a ban per URL took a field away for the rest of the run, and its value went into another field. A repeat (the same action executed `LIMITS.sigRepeatBan` times on a URL) and a target that stays covered are banned on that URL for the run. Before retrying, observe the page again and add a bounded, redacted `retry_reason` to the request state. The reason states which decision was rejected and that no input was sent. Report the retry in normal chat output. Reset target and value metadata before reading the next decision.

A model CONFIRM request and a human confirmation prompt have separate roles. `--confirm auto` asks the human for destructive actions. `always` also asks for submits. `never` blocks destructive actions. A required human confirmation without a TTY blocks with `needs_confirmation`.

In the direct engines, Enter is unavailable when observed focus is absent or the focused editor is empty. Offer TYPE_TEXT for supported editors and check their current values before submission. Enforce the same rule in execution if a model returns an unavailable Enter choice. Enter is at least a submit action. A destructive label on the focused control or its form makes it destructive. Apply the corresponding operation-confidence threshold and human confirmation before pressing Enter. Enter and a click on the focused field's submit button do the same thing, so the operation question splits its probability between PRESS_ENTER and CLICK; in the bench, Enter alone stayed below 0.70 in 21 of 45 CLI chat runs after the text was typed. When Enter is below its threshold, the loop looks at the `click_target` answer. It must be the button that Enter would press: a button (not the focused element) with a submit or destructive name, in the focused element's form or dialog, and that form must be known (the focus `form`, or the form of the focused element's action from an older adapter). In a single-line field, when the form has submit controls, it must be the default button (the focus `submitDefault`): implicit submission presses only the first submit control, and none when that control is disabled. In a textarea or an editor (focus `multiline`), Enter presses no button and a script sends: the default button or a submit control with a send name ("Send", "Post reply") qualifies. "Submit as Solved" next to "Submit as Pending" does not. A form without submit controls, whose Send button a script handles, needs only the shared form or dialog. A select, a checkbox, or a field out of view in one form never takes the button of another form, and a toolbar button outside any form never qualifies. Then the loop adds the two: `p(PRESS_ENTER) + p(CLICK) * p(that button)`. When the sum passes the Enter threshold, the loop clicks the button. The click passes its own gates (target confidence, runner-up, the unsent-text gate, and confirmation), and its risk class is at least the risk class of the Enter: a destructive Enter stays a destructive click. Otherwise, low Enter confidence uses the same one-retry budget and fresh observation as a rejected target; block as ambiguous if confidence remains below the threshold. Recheck focus and form state after the prompt. A dry run records the proposed action without executing it.

**Send button in the form of unsent text.** A click on a button whose label has a send word (`SEND_WORDS`: send, post, reply, comment, publish, share, tweet, queue) is destructive, and its target gate is 0.70. The gate is 0.50 (the submit gate) when all of these are true: the button is in a known form or dialog, a field of that form shows unsent assistant text, and `confirm` is `auto` or `always`. The unsent-text gate then asks the user before the click and shows the text, so the 0.70 gate only repeated that check. On the workflow builder, "Send message" got 0.55-0.69 in 7 of 21 runs. Jev then clicked other tabs while the brief stayed unsent, and each click asked the user. A run without dialogs blocks `needs_confirmation` at the click, with the hint to do the action in Chrome. The runner-up rule stays. Any other `confirm` setting keeps the 0.70 gate.

The target gates (low target, runner-up, repeat) apply to a `generate` choice as to any TYPE_TEXT choice. Then the loop applies these checks in order. `fieldKey` is `<doc>|<node>` of the target.

1. A credential label blocks `needs_credential` with the credential hint. The assistant is never asked.
2. A field that fails `canWriteInto` blocks `needs_credential`: the field takes an exact value.
3. A `generate` confidence below the data-entry value threshold (0.55) records `low_value`, bans the target for the step, and asks again.
4. A field whose text a send of this run took out of the page (the send record below) blocks `needs_text` with the hint "the text for "<label>" was sent in step N; a run writes and sends one text per field. For the next text, call browse again". This includes a field that a task or var value filled. Before this rule, the re-ask of check 7 asked again at each step until the run stopped with `loop_detected`.
5. After a send, a `generate` needs a TYPE_TEXT operation confidence of `GATES.textAfterSend` (0.50) or more. Below it, the loop records the gate "text after a send", bans the target for the step, and asks again. The fills of a second text after a send had 0.33-0.48 (a workflow brief typed into the workflow title); the first fills had 0.57-0.94.
6. A generated span bound to `fieldKey` is used again with the gate `generated gN cached`. No new request goes out.
7. A run writes one text per field. The loop keeps a record of each text that a fill typed: its field `<doc>|<node>`, label, form, text, and request. The record also says if the fill did not stay: the observation right after it showed the field in view and empty, and no control held the text (an editor that dropped the insert). A page that changes the text or moves it to another control kept it. A control holds a text when its value contains the text as whole words (whitespace runs count as one space; no letter or digit next to either end, so "ok" is not in "book"), or contains it as whole words after case, curly quotes, list marks at line starts, symbols, and emoji are made the same (only for a text with 2 or more letters or digits: "+1" is not in "Room 1"), or is the start of the text cut by a length limit (at least 24 letters and a third of the text). Sentence marks count: "Tuesday works." is not in "Tuesday works for me.". A control that held the text before the fill, with the same value after it, does not count for the fill: a title that starts the description does not hide a lost description. The record also says if a click, Enter, select, or back ran after the fill, and which other controls held the text before the fill. When the text moves to another control, at the fill or later, the record applies to that control too, also when the control adds words (a signature, an "@name"). At the fill, it moves only when the text left the typed field: a control that copies the text (a "Menu link title" that copies the title, an excerpt) is another field, and it gets its own request. A control that held the text before the fill ("Q3 plan" inside the Notes) does not take the record. A generate for a field with a record never sends a new request:
   - When the field holds the text, it re-asks: "already holds the text written for it".
   - When the fill did not stay, the field is empty, it has the label and form of the record, and no click, Enter, select, or back ran after the fill, the same text goes in one time more, with the gate `generated gN again` and no new request. That span is not kept: a fill that does not run leaves nothing for a later step.
   - In every other case it re-asks: the text was typed and is not in the field now. It can have gone out.

   A text request never lists a field with a record as an extra field, and a generated span of another request for such a field re-asks. A field that the page replaces with a new element is a new field: it gets its own request, and its text gets its own dialog before any click. A fill that did not stay does not count as typed, so the result names the field in `text_not_typed`. A later observation that shows the record's own text in its field, or in a control that took the record, counts it as typed: the field showed the text late. A dialog or an allowed click is no proof, because an editor that dropped the insert shows the text only in the dialog, and another value in the field is no proof either. A fill that ran, but whose next observation did not settle, counts as typed: the text went into the page, and the run blocks "page keeps changing". Without this rule, a filled chat composer got three text requests, a composer that a send emptied got the same message a second time, and a later request for Subject wrote Reply again, so Reply went out two times. Earlier versions also matched a field by its label, typed a text again after any loss without a click, and read a changed text as a lost one. That put one post's comment under another post, and sent a text again after a select, a late-clearing composer, or a Markdown editor. A version that moved the record only onto a control with exactly the text sent a reply two times when the pop-out added a signature.

8. Without a `TextSource`, the run blocks `needs_text`. After `LIMITS.textRequests` (3) requests, it blocks `needs_text` "text request limit reached (3)".
9. A dry run records `skipped` with the gate `generate dry_run` and sends no request.
10. Otherwise the loop builds one text request (section 8) and waits up to `LIMITS.textWaitMs` (300 s). The request lists the texts that a send of this run took out of the page (`sent_texts`), and it never lists a sent field as an extra field. The wait does not count toward `runTimeoutMs`. A decline, a timeout, or a text that fails `checkTexts` blocks `needs_text`; a cancel blocks `human_aborted`. A block hint names the field and the rule, never the text.
11. Each returned text becomes a generated span bound to its own field, before any page work. The loop then observes again. If the document, the field, or its value changed during the wait, it asks Jev again with no ban, and the span stays ready.

A span choice also has a binding check. A generated span whose `field.key` is not `fieldKey` makes the loop ask again with the gate `generated value gN belongs to "<label>"`. After a fill that ran (an `ok` fill, or a fill whose next observation did not settle), a generated span is removed, so each text is typed one time.

History keeps the line breaks of typed text: each line is squashed, and empty lines go. A two-line message that history showed as one line made Jev type it again; with the line break, Enter and the Send click together went from 0.42-0.50 to 0.73-0.78. Logs and the step record keep one line.

**Unsent-text gate.** After a fill of a generated span, or with `fromAssistant` of a non-secret span into a multiline field, the loop records an unsent entry: the document, the node, the label, the exact typed text, the request id, the other controls that held the text before the fill with their values then (not for a secret value), and `pending` when the fill did not stay. The fill is an `ok` fill, or a fill that ran when the observation after it did not settle. That fill is pending, because no observation shows where the text is; without the entry, a click in the next run posted the text with no dialog. Every fill replaces the entry of its field, except that a fill that did not stay keeps the pending entries of its field: the page can hold their texts too. Without this rule, an editor that keeps its text outside the control got the text two times from the retype, or an earlier text and a later one, and the dialog showed only one. When the new value does not count as assistant text, a field that had an entry keeps it with the new value (`<secret>` for a secret value), so the field stays gated and the dialog shows what the field holds. That entry is pending when the fill did not stay and the field had pending entries. Before each CLICK and each PRESS_ENTER, `pruneUnsent` updates the entries and returns the ones that gate the action:

- A new document drops the entry.
- A field that holds a value gates. The snapshot lists only controls in the viewport, so a field that is not in `actions` still holds its text while `filled` lists its node.
- Pages remove a field and show the same text in a new one: tab panels, lists that load rows on scroll, and pop-out editors. When a control in `texts` holds the entry's text (as the record rule above reads it: also changed or cut by the page), the entry moves to that node and gates. Two kinds of control do not take it:
  - A control that held the text before the fill and has had the same value in every observation since the fill. The entry keeps these controls with their values, so the rule also holds for task text and in a later run. An observation that shows another value there (for example empty) drops that control from the list: a later return to the old value is then the moved text. Without this, a smart-reply pop-out that the first Comment sent took the same reply again after "Pop out", and the next Comment posted it with no dialog. A new value there can be the text that the page moved (a pop-out that adds the quoted mail), so that control can take it. With a list of nodes only, a sent reply moved onto a Title that held its start, the next click showed it as unsent, and each later run on the tab blocked.
  - A control whose value comes from a text that this run typed there, when that typed text holds the entry's text. An observation that shows that control blank ends this: a later value there did not come from that fill. Without this, a reply that the page moved to an expanded composer and back lost its gate, and Comment or Enter posted it with no dialog. The control still shows the typed text, or every word of it and more than the entry's text (a mention chip changed it). And the control holds the entry's text no more times than the typed text does: a second copy came from somewhere else, so that control can take it. Without this rule, a sent "Sure" moved into a later search query "sure thing contract", and the next click and the next run showed it again. A version that also counted any control with another entry as typed text hid a reply that the page put, with a signature, into a pop-out that had sent a longer text.

  A control that holds exactly the text comes first, then one that contains it without an entry of its own, then one that contains it with an entry, then one that holds it changed without an entry of its own, then one that holds it changed with an entry. A control is another entry's only while it holds that entry's text. Another entry's longer text can contain this text, so a control without an entry comes first. A sent "+1" does not take the dialog of a later reply: a changed match needs 2 or more letters or digits, and the own entry of the control stays (next bullet). Without the last step, a changed reply did not show when the page put it in a pop-out that kept its own unsent text, or in a composer that a sent text's entry still named, and the dialog showed only the other text. The record of the typed text applies to the new control too. Without the changed match, a composer that turned "- " lines into a list lost the gate, and a "Comment" click posted the text with no dialog.
- One control shows each text once. When several entries are on one control and it holds the text of some of them, the others move to a control that holds their text (with the same two exceptions). When no control holds it, the entry stays with no field and does not gate; it gates again when a control shows the text. The control's own entry (one that did not move) gives way only when a moved text is all that the control holds. A page that changed the own text (a mention chip) otherwise let a sent "Thanks" inside it take the dialog, and the changed reply went out unseen. When the own entry stays but the control shows only the moved text, the entry is marked as overwritten: the page wrote the moved text over it. It still shows in the dialog of that click, because the page can keep its text in another place (a Drafts panel). The mark ends when the control shows the entry's text again, or when a fill replaces the entry. A pending entry that did not move always gates, also next to an entry with the same text: the page can hold both copies.
- The records are read before any move, so a move of one entry never gives another entry's record to a control.
- The check runs on the observation of the decision. When the click or Enter then goes stale (the page changed, for example a field that showed its value late), the entries, the generated spans, and the record keys come back as they were, so the next click still asks.
- A pending entry gates: the fill did not stay, and no click or Enter ran since. The page can hold the text where the control does not show it (an editor with its model outside the control). This holds with the field in view, out of view, or gone, and in a later run on the tab, because the flag goes with the entry. A click or Enter clears the flag, because it asked with the text in the dialog. A select or back asked nothing, so it does not clear the flag: with that rule, a priority select between the fill and "Create" let the click post the text with no dialog. A move to a control that holds the text also clears the flag.
- A field in view that is empty, with no other control that holds the text, drops the entry. An overwritten own entry does not drop: its empty control shows that the moved text went, not its own text. It stays with no field, and it gates again when a control shows its text. Without this rule, a pop-out that added a signature to the moved text let a later "Done" click save the overwritten text with no dialog.
- Any other entry whose field is gone and whose text is in no rendered control stays, but it does not gate. It gates again when a control of the document holds the text again.

When an entry drops, the unused generated spans of the same request drop too. While one entry gates, the click or Enter needs a human confirmation, whatever its label, also with `confirm: "auto"`. A dry run does not ask. `confirm: "never"` blocks `needs_confirmation` with the `confirmNever` hint, and a non-interactive `Human` blocks it with the `noConfirm` hint. Unsent text of more than `LIMITS.confirmTextChars` (6,000) characters blocks `needs_confirmation` because one dialog cannot show it. Otherwise `human.confirm` gets `ConfirmDetail` with the action, the host, and the label and full text of each gating entry. An allowed action does not clear the entries, so the next click asks again while the field still holds the text. The CLI and chat pass no unsent text, so their `typed` list is empty.

The MCP server keeps the entries with its tab (section 7). `FastRunnerDeps.unsent` seeds a run on that tab with the entries of the run before it, without their request ids, and `unsentText()` gives the entries when the run ends. A later `browse` call therefore cannot send text that an earlier run typed without a dialog.

**Send record.** A send is a click on a control with a send word, or an Enter, that the unsent-text gate asked about. A destructive word alone is not a send: "Delete draft" also takes the text out of the page. After a send, the loop watches the gating entries whose text a control showed; a pending entry gives no evidence that the page had the text. Each observation checks them. An entry is sent when the observation shows its text in no control: a new document, or its field in view and empty or not in `filled`, and no control in `texts` holds the text. `filled` also lists hidden controls. So a composer behind a confirm dialog, or a form that the page hid after the send, still holds its text and gives no record. A text that stays (a send error) gives no record either. An action other than WAIT in a later step ends the watch: a fill, a click, or a scroll can take a text out of the page that the send did not take.

The step after a send first waits while a rendered control still shows the text (a "sending" state). It observes every `waitPollMs` (100 ms), at most `fastWaitMs` (1.5 s). The workflow builder shows "sending" for 250 ms, and a DONE on that page fell below its gate. The loop keeps each sent text with its label and step (`sentTexts()`) and marks the record of the typed text as sent (check 4 above). The step request then gets `sent_texts` (each text redacted and cut to 120 characters) and the DONE_SENT text (section 6.1). The CLI and chat have no unsent text, so they have no send record, and their requests do not change.

Known limits of the gate: TYPE_TEXT, SELECT, scroll, WAIT, and GO_BACK are not gated. A `div[role=textbox]` that is not contenteditable is not in `filled` or `texts`, so its entry does not gate while it is out of view. While no rendered control holds the text, for example while a Preview tab shows it, a click does not ask; a page that sends the text from its own state then sends it without a dialog. In one document, a later click asks again while a field out of view still holds the text. A control that the page fills with a word of a sent short reply, or a query that an earlier run typed, still takes the sent entry: the next click shows the sent text again, and an unattended run blocks.

### 5.2 Direct iteration

1. Check the cancel signal and the step and run limits, then use the held post-action observation or observe the page. The run time does not include time spent waiting for assistant text.
2. Check deterministic stall detection and save a screenshot if configured.
3. Build one STEP request from the observation, history, available values, bans, and DONE suppression.
4. Read the operation and matching target answer. A low-confidence BLOCKED can use the runner-up operation unless wall evidence supports blocking.
5. Handle sign-in, captcha, loading, and error-page conditions. One error-page back action is allowed.
6. Handle completion, an explicit block, or the selected browser action. Apply confidence, credential, repeat, and confirmation checks. A `generate` value choice asks the assistant for text first (section 5.1).
7. Before input, check the observation. A stale page causes a bounded new observation and decision. A persistently covered target is banned.
8. After an action, observe again, compare fingerprints, update history, and hold that observation for the next step.

WAIT polls for a change within its cap. After the per-URL wait limit, scroll when possible; otherwise block for lack of change. A history entry for an executed action remains recorded if the later observation fails to settle.

An MCP run has a cancel signal. The runner checks it after the plan and before Chrome starts, at step start, before and after each STEP request, before page input, and after each text, confirmation, or pause wait. A cancel blocks `human_aborted` with "the run was cancelled".

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

Direct fingerprints include URL, text, action semantics and values, and scroll state; geometry is excluded. Direct bans use stable node identity plus action label. A gate ban lasts one step. Execution counts ban a target on its URL after its repeat limit.

Vercel fingerprints include normalized URL, element identity, and typed values. Action signatures include the fingerprint, action, stable element key, and value. Per-page memory holds bans, waits, recoveries, and uncertainty counts. Repeated fingerprints without a new action signature also contribute to loop detection.

A model progress score or a model judgment about the last action is not used for stall detection. Code compares observations and counts executions.

## 6. Completion, blocking, and human hand-off

### 6.1 Act

In the `vercel` engine, operation DONE triggers VERIFY. `done_final >= 0.70` completes the task. After two rejected verifications, suppress DONE for two steps.

In the direct engines, DONE completes an act goal when `P(DONE) >= 0.50`. A lower value suppresses DONE for two steps. The direct engines have no separate VERIFY request. The operation prompt must therefore require evidence for the full goal.

While a send of this run is recorded (`sent_texts` in the state, section 5.1), the DONE option has the DONE_SENT text: "Every requirement is visibly satisfied, or the goal ends with sending a text and a recent action sent that text (see sent_texts), or the detailed view needed to answer the goal is visible." After a send, the page often shows only the next state of the app, such as an empty composer or a loading view. On the workflow builder, P(DONE) after the send was 0.16-0.19 with the old text and 0.90-0.92 with DONE_SENT. For a chat with one send, it went from 0.41-0.50 to 0.96-0.97. Tasks with a step after the send stayed low: 0.07-0.11 before a second send, and 0.09-0.11 before a rename. Without a send record, the DONE text does not change.

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
| `human_aborted` | User aborts the pause or interrupts the run, or an MCP `cancel` stops it |
| `needs_text` | MCP runs: no usable new text. No writer is attached, the assistant declined, no text came in 300 s, the text failed its checks, or the run used its 3 text requests |

A blocked result includes a hint, relevant leading probabilities, and `resume: { session, url }`. Failure kinds are `browser`, `jev`, and `internal`. Failures are distinct from a supported decision to block.

`RunnerHints` replace the CLI hint texts for another front end: `headed`, `noConfirm`, `noConfirmHeadless`, `confirmNever`, `value`, and `credential`. A credential label uses `credential`, then `value`, then the CLI text. This applies to a credential field with no offered value too. `confirm: "never"` uses `confirmNever`, then `noConfirm`, then the CLI text. A headless run without dialogs uses `noConfirmHeadless`, then `noConfirm`: the user cannot see a headless window, so the hint tells the assistant to run the task again with `headed: true`. The MCP server sets all six in `MCP_HINTS` (`src/mcp/limits.ts`).

Sign-in and captcha classification normally needs page-kind confidence 0.60. The `vercel` engine also combines a lower sign-in probability with credential fields, sign-in headings, or authentication hosts. The direct engines cross-check wall reasons against the operation and page-kind answers. Error-page handling uses the separate 0.70 gate.

### 6.5 Human hand-off

A headed run can pause with or without a TTY. Print `PAUSED`, then poll every five seconds: observe the page and ask WALL whether it is a sign-in wall or an application page. Resume on `app_page` at confidence at least 0.50. Stop at `pauseTimeoutMs`.

With a TTY, Enter also resumes and `q` aborts. Without a TTY, use page polling. Headless runs block with a hint to use `--headed`. Allow at most two pauses per run. Chat uses its existing readline input for prompts so task input and confirmation input share one owner.

The MCP server replaces the TTY with run states that the assistant reads through `wait` (`src/mcp/runs.ts`). Each hand-off returns the status to `running` when it ends.

| Hand-off | MCP status | Result |
|---|---|---|
| `text.write` | `needs_text` | Valid values through `continue` resume the run. A decline, 300 s, or a cancel blocks it. Values with errors keep `needs_text` with `text_request.errors`; after 3 failed attempts the runner gets the text and blocks. |
| `human.confirm`, kind `action` | `confirming` | The next young tool call opens a dialog (section 9.1). Allow resumes the run. Deny, a declined dialog, no pickup in 60 s, the deadline, or a cancel blocks `needs_confirmation`. |
| `human.confirm`, kind `profile` | `confirming` | Allow uses that profile. Deny or a timeout uses the workspace default. |
| `human.pause` | `paused` | The manager polls the WALL check every 5 s. A clear page resumes the run. A timeout or a cancel blocks it. |
| `cancel` | `stopping` | The run stays active until the runner settles, then ends `blocked` or `failed`. |

A dialog reaches a person only in an interactive session (section 9.1). In a non-interactive session, `Human.interactive` is false, and the loop blocks as it does without a TTY. The view writes its own pause message for the kind `sign_in` or `captcha`; it does not show the TTY text.

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

The MCP server keeps one Chrome and one tab between runs in a `BrowserSession` (`src/fast/session.ts`). The session stores the key of the open Chrome: engine, headed mode, and profile directory (null for a temporary profile). Before each run, the starter resolves the profile with `prePlan`. When Jev must choose the profile, the session closes Chrome first. Otherwise it closes Chrome when the key differs or the connection has closed. `chromeFor` reuses Chrome only for the same key and throws `ProfileMismatchError` for any other key, so a run never uses another profile silently. When a task names no URL, the run continues on the current page, as in chat.

`epoch` increases on every close. `keep(page, epoch, unsent)` keeps the run's tab and its unsent assistant text only when no close happened since the run started, so a tab of a closed Chrome is never reused. The next run on that tab gets the unsent text. A close, a new tab, and a dead tab clear it. `close` waits at most `LAUNCH_WAIT_MS` for a launch in flight and is idempotent. A close during another close returns the close in flight. `prepare` and `chromeFor` wait for a close in flight, because the profile copy is free only when the old Chrome has exited; the idle close does not wait for its own close. A `browser` failure closes the session.

Chrome closes on `close_browser`, after 30 minutes with no run, when a cancel does not settle in 5 s, and at server shutdown. The server launches Chrome through the pipe, so Chrome also exits with the server process. Shutdown runs one time, on stdin end or close, SIGTERM, SIGINT, or SIGHUP: it cancels the run, then closes the session, the Jev transport, and the server, and exits 0. A watchdog exits 1 after 15 s.

Alerts and before-unload dialogs are accepted. Confirm and prompt dialogs are dismissed. Handle dialog events promptly because an open JavaScript dialog can block renderer commands.

## 8. Secrets, HTTP transport, and observability

`redactingOracle()` removes known secrets from every request, including planning and hand-off requests. Request builders remove secrets before text caps can leave a partial value. `redactData()` processes string values before JSON escaping. Preserve candidate identifiers so answer lookup still works. Redaction must not mutate the browser observation or the original value used for input.

The logger applies redaction to plain messages and structured data. Final results are also redacted, including titles, URLs, evidence, and failure details. API keys, environment files, profile copies, and runtime logs stay out of version control.

Chat loads a key from the environment or its configuration file. Saved keys use mode 600; the configuration directory uses mode 700 when created. Validate a supplied key with a small request and remove the key from reported validation errors. Configuration paths can be overridden for isolated tests.

One HTTP transport serves key validation, model requests, and optional warm-up calls. It reuses a connection and limits warm-up time. Chat sends idle warm-up requests while waiting for input. The MCP server sends them every 45 s for 10 minutes after a run ends, only when a key is loaded and no run is active; it sends none before the first run ends. A running task owns its model traffic. Closing the transport aborts outstanding warm-up work so it cannot delay exit.

**What reaches the assistant.** In MCP runs, the assistant (the harness model) gets two kinds of data:

- The text request (`buildTextRequest` in `src/fast/generate.ts`). It holds the redacted goal, the page URL and title, the fields, the last 5 actions, the texts that a send of this run took out of the page (`sent_texts`, each cut to 120 characters, only after a send), and up to 6,000 characters of page text. `untrusted_page_text` is the last key. Every string is redacted first, then sanitized, then cut, so a cut never keeps part of a secret. A field's `current_value` has at most 80 characters.
- The tool result view (`viewOf` in `src/mcp/view.ts`). `result.sent_texts` lists the texts that a send of the run took out of the page, each cut to 120 characters. Every string goes through the run's redactor and the API key removal. Page-derived strings are made flat (one line), and the page text is sanitized. Redaction runs before and after sanitizing, because sanitizing can join the parts of a secret. A step line redacts the value and the target name before it cuts the value to 60 characters.

`continue` values are checked for the API key as sent and after the runner's normalization (line breaks, then `sanitizeText`), so format characters between the characters of the key do not hide it. A decline reason loses the key in the same way.

`sanitizeText` converts line and paragraph separators to `\n`. It removes C0 and C1 controls except tab and newline, every format character (bidi controls, zero-width characters, soft hyphen, and tag characters), and supplementary variation selectors. It collapses a run of variation selectors. A single ZWJ or ZWNJ between two visible characters stays, so emoji sequences and Persian words keep their form.

**Key screen.** `checkTexts` rejects a text that holds a secret var value of at least `LIMITS.secretMinChars` (4) characters, and a text that matches `KEY_PATTERN` (private keys and common API key and token forms). Its errors name the var key, never the value. `RunManager.answerText` also rejects a value that holds the TypeSafe API key, so such a text never goes to the runner. Views, error texts, and the log remove the key.

The MCP logger writes to stderr. Each run's redactor also becomes the stderr logger's redactor, with the API key removal added.

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

Default limits are 25 steps, 30 seconds per browser command, 600 seconds per run, and 300 seconds per human pause. These are checked by the relevant loop, command, and pause paths; they are not a single global cancellation timer. Exact ranges and overrides are defined by the argument parsers. A `JEV_BROWSER_MAX_STEPS` value that is not a finite number from 1 to 100 is a usage error when `--max-steps` is absent.

`src/cli.ts` and `src/chat.ts` start only when `process.argv[1]` is their own file and the module file name is `cli.*` or `chat.*`. In the plugin bundle every module shares one URL, so this check stops the CLI from starting inside the MCP server.

### 9.1 MCP contract

The MCP server uses stdio. Stdout carries only JSON-RPC. `src/mcp/main.ts` sends `console.log`, `info`, `debug`, and `warn` to stderr, and the log goes to stderr. Startup launches no Chrome and sends no network request; the first `browse` call does. `plugin/dist/jev-mcp.mjs` is the bundle of `src/mcp/main.ts`, built by `npm run build:mcp`. It loads the package `.env` only when a parent directory (up to 4 levels) has the `jev-browser-use` `package.json`, and it sets only keys that the environment does not set.

The tools are `browse`, `wait`, `continue`, `cancel`, and `close_browser` (`TOOL_NAMES` in `src/mcp/view.ts`). Their annotations mark `browse` and `continue` as destructive and open-world, `wait` as read-only, and `cancel` and `close_browser` as not destructive and not open-world. With `JEV_MCP_REVIEW_TEXT=1`, `continue` also has `_meta["anthropic/requiresUserInteraction"]`. The input schemas are strict.

Every result is `{ content: [{ type: "text", text: JSON.stringify(view) }], structuredContent: view }`. `isError: true` means a wrong call only, and its text states the correct call. The view keys are `run`, `status`, `next`, `task`, `elapsed_s`, `steps`, `last_step`, and then the optional `confirmation`, `pause`, `result`, and `text_request`. `text_request` is last, and `untrusted_page_text` is its last key. A view fits `MCP.viewTokens` (7,000 estimated tokens): the page text is cut first, then the oldest step lines (down to 3), then answer strings (to 2,000 characters). Codex shows only `structuredContent` to its model and cuts tool output above about 10,000 tokens.

`next` names the run id and, for `needs_text`, the request id. When the run sent a text, `next` for `done`, `blocked`, and `failed` adds "The texts in result.sent_texts were sent. Do not send them again.": a blocked run after a send must not make the assistant run the whole task again. For a `needs_confirmation` block, `next` adds that the dialog was declined only when the hint is "the user did not allow <action>". The other hints of that kind mean that no person declined a dialog. The loop gives that hint for every false answer, so `RunManager` records how each confirmation ended (`ConfirmEnd`). When no call opened the dialog in time (`no_pickup`), or the dialog failed or got no answer in time (`no_answer`), it replaces the hint with one that says so.

The statuses are `running`, `needs_text`, `confirming`, `paused`, `stopping`, `done`, `blocked`, and `failed` (`RUN_STATUSES` in `src/mcp/runs.ts`). The server runs one run at a time. `browse` with the task of the active run returns that run; another task returns `isError`. The manager keeps the last 10 finished runs.

`wait`, `browse`, and `continue` wait up to `wait_s` (at most 50 s). They return at once when the run needs the assistant or ends, or when a confirmation is not yet sent. A confirmation opens as a form elicitation only in a call that started `MCP.freshCallMs` (5 s) ago or less, so that a call with a dialog ends before Claude Code moves it to the background at 2 minutes. An older call returns `confirming`, and the next `wait` opens the dialog. A confirmation that no call opens in 60 s is not allowed. A dialog lasts at most 100 s and never past the runner's confirmation deadline (120 s). The action is allowed only when the client returns `accept` with `allow: true`. An error does not allow the action, and it counts as no answer.

A run is interactive only when all of these are true at `browse`: the client has the `elicitation` capability with form support, the negotiated protocol version does not start with `2026`, and `CLAUDE_CODE_SESSION_ATTENDED` is not `0` or `JEV_MCP_TRUST_ELICITATION=1`. `browse.url` must be `http:` or `https:`; `file:` needs `JEV_MCP_ALLOW_FILE=1`. `browse.profile` must be `none` or a listed name or directory of the selected engine.

`cancel` aborts the run signal and resolves the open hand-off. The run is `stopping` until the runner settles. After 5 s the manager closes Chrome and waits 5 s again. While a run is `stopping`, `browse` and `close_browser` return `isError`.

## 10. Validation and risk controls

Run `npm test` and `npm run typecheck` for code changes. Also run `npm run test:live` for changes to page scripts, CDP, profile ownership, or process cleanup. Run `npm run build:mcp` for MCP server changes. The live suite uses local fixtures and an API stand-in; it requires Chrome but does not need a real Jev key. The suite tests attachment under both direct engine names against Chrome, and it runs the MCP server on [test/fixtures/live/reply.html](test/fixtures/live/reply.html) with a real `BrowserSession`. A Chromium launch needs separate verification with an installed Chromium binary.

Use [test/fakes.ts](test/fakes.ts) for Oracle, Human, logger, transport, and `vercel` browser fakes. Use [test/fast/fakes.ts](test/fast/fakes.ts) for direct browser and observation fakes. Stored fixtures and local HTML pages live under [test/fixtures/](test/fixtures/).

Maintain coverage for these behaviors:

| Area | Required cases |
|---|---|
| Engine selection | All three public names, flag and environment precedence, rejected old names, engine-specific binary discovery, isolated profile paths, selected name in success and failure results |
| Task and plan | Span extraction, the "and" cut kinds, the value heads of the task wording table (pairs, hidden cuts), URL order, variables, profile precedence, default profile, ambiguity, current-page continuation, PLAN skipped or overlapped |
| State and budgets | Parsed state and values, disabled controls, stable identities, per-operation heads, choice limits, trim order, oversized-page block |
| Decisions | Every goal, supported action, completion hold, block reason, risk band, runner-up rejection, missing value, dry run, repeat and wait cap |
| Vercel execution | Tournament, dependent CONFIRM, select options, page-derived values, covered-click retry, Escape and RECOVER, extraction and VERIFY |
| Direct execution | Fresh and stale targets, focus changes, form changes, covered geometry, dynamic text, native select, document and panel scrolling |
| Secrets | Real fill followed by another request, quotes and backslashes, newlines, nested log data, long values before trimming, final results, unchanged browser input |
| Human interaction | Headless block, headed polling without a TTY, TTY resume and abort, prompt refusal, exhausted pause budget |
| Ownership | Concurrent profile launch and refresh rejected, existing locks retained, lock release after exit, temporary cleanup, attached tab preservation |
| Process lifetime | SIGINT during launch, error cleanup, CLI exit with keep-open after success and failure, chat connection reuse |
| Interfaces | Exactly one result JSON document, exit mapping, argument errors, browser envelopes, CDP response matching, HTTP connection close |
| Assistant text | `canWriteInto`, field batches, redaction before cuts, sanitizing, `checkTexts` rules, the `generate` option and its texts, binding, single use, the unsent-text gate with fields out of view, the text request cap, cancel checkpoints, the var fallback, the send record and its wait, the block after a send, the send gate in the form |
| MCP server | Tool names, annotations, and schemas; each status in the view; the token budget; `next` texts; dialogs and the interactive rule; cancel and `stopping`; idle timers; session reuse and relaunch; only JSON-RPC on stdout; exit on stdin end and on signals; the bundle and the plugin files |

Use [test/mcp/helpers.ts](test/mcp/helpers.ts) for the scripted reply oracle, the fake mail page on a `BrowserSession`, the fake Jev link, and the in-memory MCP client.

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
- Assistant text in the wrong place: fill only fields that pass `canWriteInto`, bind each text to one field in one document, use it one time, and ask Jev again when the page changed during the wait.
- Assistant text sent without consent: gate every click and Enter while unsent text exists, show the full text in the dialog, and let only a person answer. No tool argument, page text, or model answer can approve an action.
- Page text that gives instructions to the assistant: label it `untrusted_page_text`, put it last, sanitize it, and state in the skill that all result strings are data.
- Secrets in assistant text: redact requests and views, reject secret var values, key patterns, and the API key.

Residual risks of assistant text:

- Page JavaScript can read a filled field before the send dialog. The dialog protects the send, but not the page's access to the typed text.
- Labels such as "Authorize", "Approve", or "Merge" are not risk words. Without unsent text, a click on such a control needs no dialog under `confirm: "auto"`.
- SELECT is not gated while unsent text exists. A `div[role=textbox]` that is not contenteditable does not gate while it is out of view. While no rendered control holds the unsent text, clicks are not gated, except for a pending entry until the next click or Enter.
- The harness model can write wrong or manipulated text. The user sees the text in the `continue` prompt (when it is not allowed by a rule) and in the send dialog.
- In a session where a person does not answer dialogs, `JEV_MCP_TRUST_ELICITATION=1` lets the client answer them.
- A send word on a control that does not send ("Share settings"), or a page that empties the composer before a send fails, can give a false send record. DONE_SENT can then end a run early. A page that keeps the sent text in a visible control gives no record, and the run behaves as before.

## 11. Acceptance runs

[scripts/smoke.ts](scripts/smoke.ts) runs the following three cases through the real CLI. Run it with `npm run smoke`; set `SMOKE_ENGINE` to `cdp`, `chromium`, or `vercel` to select the engine. The default is `cdp`. It reports pass/fail, confidence, requests, tokens, and timing, and exits 1 if a case fails.

These cases need the real API and browser state. The Parallelloop and Gmail expectations depend on the prepared account and copied profile for the selected browser. Chromium needs its own prepared profile; Chrome profile state is not shared automatically. They are not substitutes for isolated regression tests.

1. `jev-browser "open wikipedia.org and search for Alan Turing, then tell me the title of the article" --profile none` must return done with an extract answer containing `Alan Turing`.
2. `jev-browser "open app.parallelloop.ai, login using gmail and check if licious account project has 3rd September artifacts"` must return done with a true check answer, evidence containing `Licious Sept3 Session`, and a final URL under `app.parallelloop.ai/workspace/licious-data-project`. The prepared scenario targets four to six steps; the smoke script enforces the upper bound of six.
3. `jev-browser "open mail.google.com in the Parallelloop profile and read the subject of the newest email"` must return blocked with `needs_sign_in` and a hint containing `--headed` when the prepared copy is signed out. It must not crash.

The account state can change. Record the starting conditions and actual result when interpreting a smoke failure. Run tasks against real accounts only within the user's requested scope.

The assistant plugin has these acceptance runs. They need the real API and an assistant client. First run `npm test`, `npm run typecheck`, `npm run test:live`, and `npm run build:mcp`. Then serve the fixtures with `python3 -m http.server 8765 --bind 127.0.0.1 --directory test/fixtures/live`.

1. **Claude Code** in an attended session with `claude --plugin-dir ./plugin`. Task: "Open http://127.0.0.1:8765/reply.html with a temporary profile, read Ann's message, and reply that the time she proposes works." Expect `browse` with `url` and `profile: "none"`, one text request with Reply and Subject but no Cc, text that names Tuesday and 10:00 and does not hold "HACKED", one dialog with the full text, and `done`. Record the value gate in the stderr log (`generated g1 t1`). If Jev chooses a task fragment instead of `generate`, check the fragment filter of the field's value question and `LIMITS.genSpanWords`.
2. **Codex** with `-c approval_policy="on-request"`: the same run and result. With `approval_policy = "never"`, expect `blocked` with `needs_confirmation`.
3. **Speed.** A task that needs no new text runs as fast as the CLI.
4. **Manual checks.** A 3,000-character reply shows in full in the Claude Code dialog. With `JEV_MCP_REVIEW_TEXT=1` in bypass mode, Claude Code prompts for `continue` and shows the values.
