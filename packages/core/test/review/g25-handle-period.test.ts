// Group 25: a multi-word @handle before a sentence period loses its last word.
import { describe, expect, it } from "vitest";
import { mentionMatches } from "../../src/fast/policy.js";
import { mentionNames } from "../../src/task.js";

describe("group 25: a multi-word @handle at the end of a sentence", () => {
  it("keeps every name word before a period, a comma, or a question mark", () => {
    expect(mentionNames("Ask @Research Agent.").map((m) => m.text)).toEqual(["@Research Agent"]);
    expect(mentionNames("Send the notes to @Ann Lee.").map((m) => m.text)).toEqual(["@Ann Lee"]);
    expect(mentionNames("Ask @Research Agent, then wait").map((m) => m.text)).toEqual(["@Research Agent"]);
    expect(mentionNames("Can you ask @Research Agent?").map((m) => m.text)).toEqual(["@Research Agent"]);
    // Unchanged: a dotted handle stays whole.
    expect(mentionNames("Tag @ann.lee.").map((m) => m.text)).toEqual(["@ann.lee"]);
  });

  it("so the unasked-chip check does not accept another person with the first word", () => {
    const [name] = mentionNames("Send the notes to @Ann Lee.").map((m) => m.text);
    expect(mentionMatches("Ann Smith", name as string)).toBe(false);
  });
});
