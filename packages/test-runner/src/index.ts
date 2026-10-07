// The programmatic API: load a project, run its suites with your own session factory or the jev one, and write reports.
export { main } from "./cli.js";
export { jevSessions, engineEnv } from "./engine.js";
export type { EngineOptions } from "./engine.js";
export { createLlm, parseVerdict } from "./llm.js";
export type { Llm, Verdict } from "./llm.js";
export { CONFIG_FILE, LoadError, loadProject, loadSuite, loadSuites, selectCase } from "./load.js";
export type { Filter, LoadedSuite, Project } from "./load.js";
export { RecordingStore, entryKey } from "./recordings.js";
export { consoleReporter, junitXml, summary, writeReports } from "./report.js";
export { runAll } from "./runner.js";
export type { CaseResult, RunEvent, RunMode, RunOptions, RunReport, SuiteResult } from "./runner.js";
export { runAssertion } from "./asserts.js";
export { Assertion, CaseDef, ConfigDef, StepDef, SuiteDef } from "./schema.js";
export type { JevOutcome, ReplayOutcome, Session, SessionFactory } from "./session.js";
export { JEV_KEY_VAR, LLM_KEY_VAR, checkLlm, renderConfig, runInit, terminalPrompter } from "./init.js";
export type { InitAnswers, InitOptions, Prompter } from "./init.js";
