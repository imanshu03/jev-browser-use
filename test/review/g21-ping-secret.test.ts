// Group 21: the mention verb "ping" holds "pin", so SECRET_LEAD marks the name and the words after it secret.
import { describe, expect, it } from "vitest";
import { buildStep } from "../../src/fast/policy.js";
import { extractSpans } from "../../src/task.js";
import { el, obs } from "../fast/fakes.js";

describe("group 21: ping is a mention verb, not a credential word", () => {
  it("a name after 'ping' is not secret, and Jev sees the goal and the picker option", () => {
    const task = "ping Cleo Park and ask her for the report status";
    const spans = extractSpans(task);
    const name = spans.find((s) => s.source === "mention");
    expect(name?.text).toBe("Cleo Park");
    expect(name?.secret).toBe(false);
    expect(spans.filter((s) => s.secret)).toEqual([]);
    const o = obs("https://chat.test/", [
      el("e1", "fill", "Type a message", "textbox", { multiline: true, value: "" }),
      el("e2", "click", "Mention", "button"),
      el("e3", "click", "Cleo Park", "option", { popup: [1] }),
      el("e4", "click", "Send", "button"),
    ], "Chat with Cleo Park and the team");
    const b = buildStep({ task, goal: "act", obs: o, history: [], spans, keys: [], bannedActionIds: new Set(), doneBanned: false, canGenerate: true } as never);
    const state = b.state as { goal: string; elements: { label: string }[] };
    expect(state.goal).toBe(task);
    expect(state.elements.map((e) => e.label)).toContain("Cleo Park");
  });

  it("'shipping' before a value does not make it secret", () => {
    const spans = extractSpans("Search for shipping rates to Berlin");
    expect(spans.filter((s) => s.secret)).toEqual([]);
  });
});
