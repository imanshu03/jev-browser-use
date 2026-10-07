# jev-test

YAML test runner on the jev-browser-use library (`packages/sdk` of this workspace). Read README.md first.

- `src/runner.ts` holds the rules: record, replay, repair, CI mode. `src/engine.ts` is the only file that talks to jev-browser-use.
- Tests use `test/fake.ts` (a fake `Session`). Run `npm test`, `npm run typecheck`, and for browser changes `npm run test:live`.
- Expected results never repair. Keep that rule.
- Secrets never go to Jev or the LLM, and reports show them as `***`.
- Write docs and comments in ASD-STE100 Simplified Technical English, one short line per comment.
