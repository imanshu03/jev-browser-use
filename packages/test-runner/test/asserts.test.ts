import { describe, expect, it } from "vitest";
import { runAssertion } from "../src/asserts.js";
import type { Llm } from "../src/llm.js";
import { FakeSession } from "./fake.js";

function ctx(session: FakeSession, extra: { llm?: Llm | null; timeoutMs?: number } = {}) {
  let t = 0;
  return { session, vars: { name: "Milk" }, llm: extra.llm ?? null, timeoutMs: extra.timeoutMs ?? 0, pollMs: 100, sleep: async (ms: number) => { t += ms; }, now: () => t };
}

describe("runAssertion", () => {
  it("polls until the text shows, and fails with the last detail at the timeout", async () => {
    const s = new FakeSession();
    let reads = 0;
    const read = s.read.bind(s);
    s.read = async () => { reads += 1; if (reads === 3) s.page.text = "Saved Milk"; return read(); };
    expect(await runAssertion({ visible_text: "saved {name}" }, ctx(s, { timeoutMs: 1000 }))).toMatchObject({ pass: true, label: 'page shows "saved Milk"' });
    const gone = new FakeSession();
    expect(await runAssertion({ visible_text: "never" }, ctx(gone, { timeoutMs: 300 }))).toEqual({ pass: false, label: 'page shows "never"', detail: "the text is not on the page" });
  });
  it("checks URL, title, absence, element, and field value", async () => {
    const s = new FakeSession();
    s.page = { url: "https://app.example/notes/42", title: "Notes - Demo", text: "Notes", rows: [], actions: [
      { kind: "click", role: "button", label: "Sign out" },
      { kind: "fill", role: "textbox", label: "Note title", value: "Milk" },
      { kind: "select", role: "combobox", label: "Sort → Newest", current_value: "Newest" },
    ] };
    const pass = async (a: Parameters<typeof runAssertion>[0]) => (await runAssertion(a, ctx(s))).pass;
    expect(await pass({ url_contains: "/notes/" })).toBe(true);
    expect(await pass({ url_matches: "/notes/\\d+$" })).toBe(true);
    expect(await pass({ title_contains: "notes" })).toBe(true);
    expect(await pass({ not_visible_text: "error" })).toBe(true);
    expect(await pass({ element: { name: "Sign out", present: true } })).toBe(true);
    expect(await pass({ element: { name: "Sign out", role: "link", present: true } })).toBe(false);
    expect(await pass({ element: { name: "Delete", present: false } })).toBe(true);
    expect(await pass({ field_value: { field: "Note title", value: "{name}" } })).toBe(true);
    expect(await pass({ field_value: { field: "Sort", value: "newest" } })).toBe(true);
  });
  it("row_contains needs every value in one row", async () => {
    const s = new FakeSession();
    s.page.rows = [["Milk", "2026-10-07"], ["Bread", "2026-10-08"]];
    expect((await runAssertion({ row_contains: ["milk", "10-07"] }, ctx(s))).pass).toBe(true);
    expect((await runAssertion({ row_contains: ["milk", "10-08"] }, ctx(s))).pass).toBe(false);
  });
  it("check asks Jev and passes only on yes at the probability", async () => {
    const s = new FakeSession();
    s.onJev = () => ({ ok: true, steps: [], reason: "", jevRequests: 1, check: { answer: true, probability: 0.65 } });
    expect(await runAssertion({ check: "Is {name} listed?" }, ctx(s))).toMatchObject({ pass: false, model: "jev" });
    expect(await runAssertion({ check: "Is {name} listed?", min_probability: 0.6 }, ctx(s))).toMatchObject({ pass: true });
    expect(s.calls).toContain("jev check Is Milk listed?");
  });
  it("judge sends the page to the LLM, and fails with a hint when no LLM is set", async () => {
    const s = new FakeSession();
    s.page.text = "Summary: three points";
    let seen = "";
    const llm: Llm = { model: "m", judge: async (criteria, page) => { seen = `${criteria}|${page.text}`; return { pass: true, reason: "it summarizes" }; } };
    expect(await runAssertion({ judge: "The reply summarizes {name}" }, ctx(s, { llm }))).toEqual({ pass: true, label: "LLM judge: The reply summarizes Milk", detail: "it summarizes", model: "llm" });
    expect(seen).toBe("The reply summarizes Milk|Summary: three points");
    expect((await runAssertion({ judge: "x" }, ctx(s))).detail).toMatch(/needs the LLM/);
  });
});
