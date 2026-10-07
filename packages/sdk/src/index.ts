// The public library API of jev-browser-use: the parts that another package (such as a test runner) builds on.
// Names exported here are a contract. Change them only with a version bump.

// Browser
export { BROWSER_KINDS, browserOf, defaultUserDataDir, detectBrowser, launchChrome, listProfiles } from "@imanshu03/jev-core/fast/chrome.js";
export type { BrowserKind, ProfileEntry } from "@imanshu03/jev-core/fast/chrome.js";
export { openPage } from "@imanshu03/jev-core/fast/page.js";
export { cliBrowser as createBrowser, lazyNavigator as createNavigator, navBase as baseRunConfig } from "@imanshu03/jev-core/scrape/launch.js";
export type { BrowserOptions } from "@imanshu03/jev-core/scrape/launch.js";
export type { ScrapeBrowser as Browser, NavigatorDeps } from "@imanshu03/jev-core/scrape/runner.js";
export type { Action, Chrome, ChromeLaunchOptions, GeoPoint, Observation, Page, PageOptions } from "@imanshu03/jev-core/fast/model.js";
export { StalePage } from "@imanshu03/jev-core/fast/model.js";
export type { PageRead, ReadOptions, RecordGroup, TableRead, TextBlock } from "@imanshu03/jev-core/fast/read-types.js";

// Jev runs
export { FastRunner, riskOf, riskOfEnter, searchFormButton, wordsFor } from "@imanshu03/jev-core/fast/loop.js";
export type { FastRunnerDeps } from "@imanshu03/jev-core/fast/loop.js";
export { createOracle } from "@imanshu03/jev-core/jev.js";
export type { Oracle } from "@imanshu03/jev-core/jev.js";
export { createTransport } from "@imanshu03/jev-core/transport.js";
export type { Transport } from "@imanshu03/jev-core/transport.js";
export type { ActionRules, ActionWords, Goal, Outcome, RunConfig, RunResult, StepRecord } from "@imanshu03/jev-core/types.js";
export { DEFAULT_PROFILE_NAME, DESTRUCTIVE_WORDS, LIMITS, SUBMIT_WORDS, secretKey } from "@imanshu03/jev-core/types.js";

// Keys
export { validateKey } from "@imanshu03/jev-core/config.js";
export type { KeyCheck } from "@imanshu03/jev-core/config.js";

// People, logs, and text
export { createHuman, createLogger } from "@imanshu03/jev-core/io.js";
export type { Human, Logger, TextReply, TextRequest, TextSource } from "@imanshu03/jev-core/io.js";
export { createTextModel, textModelFromEnv } from "@imanshu03/jev-core/writer.js";
export type { TextModelConfig } from "@imanshu03/jev-core/writer.js";
export { textBackend } from "@imanshu03/jev-core/scrape/llm.js";
export type { LlmBackend, LlmReply } from "@imanshu03/jev-core/scrape/llm.js";

// Record and replay
export { stepsFromRecords, beforeRepeat } from "@imanshu03/jev-core/scrape/record.js";
export type { RecordedSteps, RecordOptions } from "@imanshu03/jev-core/scrape/record.js";
export { replaySteps, STEP_MS } from "@imanshu03/jev-core/scrape/replay.js";
export type { ReplayGuardInput, ReplayOptions, ReplayResult } from "@imanshu03/jev-core/scrape/replay.js";
export { Step, Target, PRESS_KEYS } from "@imanshu03/jev-core/scrape/spec.js";
export { fillTemplate } from "@imanshu03/jev-core/scrape/spec.js";
