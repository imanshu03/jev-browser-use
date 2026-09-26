import type { ChoiceResponse, Questions, TypeSafeClient } from "@typesafe-ai/sdk";
import { choice } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { choiceProblem, createOracle } from "../src/jev.js";
import { fakeLogger } from "./fakes.js";

const q = choice("Which one?", { a: "A", b: "B", c: "C" });
const ans = (over: Partial<ChoiceResponse>): ChoiceResponse => ({ type: "choice", choice: "a", confidence: 0.6, probabilities: { a: 0.6, b: 0.3, c: 0.1 }, ...over } as ChoiceResponse);

describe("choiceProblem (the answer check of browser-use/jev-ultrafast validate_choice)", () => {
  it("a good answer has no problem; probabilities may leave out options and round to 0.02", () => {
    expect(choiceProblem(ans({}), q)).toBeNull();
    expect(choiceProblem(ans({ probabilities: { a: 0.595, b: 0.395 } as never }), q)).toBeNull();
    expect(choiceProblem(ans({ choice: "b", probabilities: { a: 0.45, b: 0.45, c: 0.1 } as never }), q)).toBeNull();
  });
  it("names each bad shape", () => {
    expect(choiceProblem(ans({ choice: "d" as never }), q)).toMatch(/not an option/);
    expect(choiceProblem(ans({ probabilities: { a: 0.6, b: 0.3, z: 0.1 } as never }), q)).toMatch(/"z", which is not an option/);
    expect(choiceProblem(ans({ probabilities: { a: 0.6, b: 0.3, c: Number.NaN } as never }), q)).toMatch(/not a number from 0 to 1/);
    expect(choiceProblem(ans({ probabilities: { a: 1.2, b: -0.2 } as never }), q)).toMatch(/not a number from 0 to 1/);
    expect(choiceProblem(ans({ probabilities: { a: 0.6, b: 0.1 } as never }), q)).toMatch(/add up to 0\.700/);
    expect(choiceProblem(ans({ choice: "c" }), q)).toMatch(/does not have the highest probability/);
    expect(choiceProblem(ans({ confidence: 2 }), q)).toMatch(/confidence/);
    expect(choiceProblem(ans({ probabilities: undefined as never }), q)).toBe("no probabilities");
  });
});

describe("createOracle checks the shape of each choice answer", () => {
  const questions: Questions = { operation: q, target: choice("Which element?", { "1": "one", "2": "two" }) };
  const bad = { type: "choice", choice: "2", confidence: 0.9, probabilities: { "1": 0.9, "2": 0.1 } };
  const good = { type: "choice", choice: "1", confidence: 0.9, probabilities: { "1": 0.9, "2": 0.1 } };
  const client = (targets: unknown[]) => {
    let n = 0;
    return { calls: () => n, c: { async systemOne() { const target = targets[Math.min(n++, targets.length - 1)]; return { answers: { operation: ans({}), target }, model: "jev-test", usage: { input_tokens: 1, output_tokens: 1 } }; } } as unknown as TypeSafeClient };
  };
  it("a bad answer asks one time more; a good second answer is used", async () => {
    const k = client([bad, good]);
    const log = fakeLogger();
    const oracle = createOracle(k.c, "jev-test", log);
    const r = await oracle.ask("step", { goal: "x" }, questions);
    expect(k.calls()).toBe(2);
    expect(oracle.stats.requests).toBe(2);
    expect(r.answers["target"]).toMatchObject({ choice: "1" });
    expect(log.lines.some((l) => /answer "target" has a bad shape \(choice "2" does not have the highest probability\); asking again/.test(l))).toBe(true);
  });
  it("a head that is bad again is dropped: no code reads it, and the log names it; good heads stay", async () => {
    const k = client([bad, bad]);
    const log = fakeLogger();
    const r = await createOracle(k.c, "jev-test", log).ask("step", { goal: "x" }, questions);
    expect(k.calls()).toBe(2);
    expect(Object.keys(r.answers)).toEqual(["operation"]);
    expect(log.lines.some((l) => /answer "target" dropped: choice "2" does not have the highest probability/.test(l))).toBe(true);
  });
  it("good answers go out with one request", async () => {
    const k = client([good]);
    await createOracle(k.c, "jev-test", fakeLogger()).ask("step", { goal: "x" }, questions);
    expect(k.calls()).toBe(1);
  });
});
