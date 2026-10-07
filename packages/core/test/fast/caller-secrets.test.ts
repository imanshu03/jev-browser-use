import type { ChoiceQuestion } from "@typesafe-ai/sdk";
import { expect, it } from "vitest";
import { FastRunner } from "../../src/fast/loop.js";
import { navBase } from "../../src/scrape/launch.js";
import { LIMITS } from "../../src/types.js";
import { fakeHuman, fakeLogger, fakeOracle } from "../fakes.js";
import { el, fakeChrome, fakePage, obs } from "./fakes.js";

it("removes caller secrets before limits cut page text and before logs or results are written", async () => {
  const secret = 'private-value-"with-escape';
  const url = "https://app.example";
  const page = fakePage({ start: "main", pages: { main: obs(url, [el("e1", "click", `Continue ${secret}`, "button")], "Page", { title: "x".repeat(LIMITS.titleChars - 5) + secret }) } });
  const log = fakeLogger();
  const oracle = fakeOracle((_name, _state, q) => ({
    page_kind: "task_page", operation: "CLICK",
    click_target: { choice: Object.keys((q["click_target"] as ChoiceQuestion | undefined)?.criteria ?? {})[0] ?? "", confidence: 0.99 },
  }));
  const result = await new FastRunner({
    cfg: { ...navBase({}, { headed: false, maxSteps: 1 }), task: "Click Continue", url, profile: "none", goal: "act", confirm: "autonomous", keepOpen: true },
    profiles: [], chrome: async () => fakeChrome(), openPage: async () => page, oracle, log,
    human: fakeHuman({ interactive: false }), sleep: async () => undefined,
    redactor: (text) => text.split(secret).join("***"),
  }).run();
  const requests = JSON.stringify(oracle.requests);
  expect(requests).not.toContain("private-value");
  expect(requests).not.toContain("priva");
  expect(requests).toContain("***");
  expect(JSON.stringify(result)).not.toContain("private-value");
  expect(JSON.stringify(log.lines)).not.toContain("private-value");
  expect(page.calls).toContainEqual(expect.objectContaining({ op: "act", id: "e1" }));
});
