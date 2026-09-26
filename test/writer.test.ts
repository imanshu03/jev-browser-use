import { describe, expect, it } from "vitest";
import type { TextRequest } from "../src/io.js";
import { DEFAULT_TEXT_BASE_URL, TEXT_MODEL_RULES, createTextModel, parseTextAnswer, textModelFromEnv } from "../src/writer.js";
import { fakeLogger } from "./fakes.js";

const req: TextRequest = {
  id: "t1", goal: "reply to Ann that Tuesday works", page: { url: "https://mail.example/t/1", title: "Mail" },
  fields: [{ id: "f1", label: "Reply", role: "textbox", required: true, multiline: true, max_chars: 4000, current_value: "" }],
  recent_actions: [], untrusted_page_text: "Can we meet on Tuesday?",
};

/** A fetch that answers each call with the next content, and records the bodies. */
function fetcher(contents: unknown[], status = 200) {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const f = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    urls.push(url);
    headers.push(init.headers);
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    const content = contents[Math.min(bodies.length - 1, contents.length - 1)];
    return { ok: status < 400, status, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return { f, bodies, urls, headers };
}

const cfg = { baseUrl: "https://llm.example/v1", model: "small-model", apiKey: "k" };
const ok = () => ({});

describe("textModelFromEnv", () => {
  it("is off without a model and a key; the base URL defaults to OpenRouter; reasoning takes none or low", () => {
    expect(textModelFromEnv({})).toBeNull();
    expect(textModelFromEnv({ JEV_TEXT_MODEL: "m" })).toBeNull();
    expect(textModelFromEnv({ JEV_TEXT_API_KEY: "k" })).toBeNull();
    expect(textModelFromEnv({ JEV_TEXT_MODEL: "m", JEV_TEXT_API_KEY: "k" })).toEqual({ baseUrl: DEFAULT_TEXT_BASE_URL, model: "m", apiKey: "k" });
    expect(textModelFromEnv({ JEV_TEXT_MODEL: "m", JEV_TEXT_API_KEY: "k", JEV_TEXT_BASE_URL: "http://127.0.0.1:8790/v1/", JEV_TEXT_REASONING: "none" }))
      .toEqual({ baseUrl: "http://127.0.0.1:8790/v1", model: "m", apiKey: "k", reasoning: "none" });
    expect(textModelFromEnv({ JEV_TEXT_MODEL: "m", JEV_TEXT_API_KEY: "k", JEV_TEXT_REASONING: "high" })).not.toHaveProperty("reasoning");
  });
});

describe("parseTextAnswer", () => {
  it("takes a JSON object of text for known field ids; null and blank values are left out", () => {
    expect(parseTextAnswer('{"f1": "Tuesday works for me.", "f2": null, "f3": " "}', ["f1", "f2", "f3"])).toEqual({ values: { f1: "Tuesday works for me." } });
    expect(parseTextAnswer('```json\n{"f1": "x"}\n```', ["f1"])).toEqual({ values: { f1: "x" } });
  });
  it("names each bad answer", () => {
    expect(parseTextAnswer(undefined, ["f1"])).toEqual({ problem: "no text in the answer" });
    expect(parseTextAnswer("Sure! Here is the reply.", ["f1"])).toEqual({ problem: "the answer is not JSON" });
    expect(parseTextAnswer('["x"]', ["f1"])).toEqual({ problem: "the answer is not a JSON object" });
    expect(parseTextAnswer('{"text": "x"}', ["f1"])).toEqual({ problem: 'the answer has the key "text", which is not a field id' });
    expect(parseTextAnswer('{"f1": 3}', ["f1"])).toEqual({ problem: "the value of f1 is not text" });
  });
});

describe("createTextModel", () => {
  it("one call with the rules and the request; the answer goes back as text; the log names the fields, never the text", async () => {
    const k = fetcher(['{"f1": "Tuesday works for me."}']);
    const log = fakeLogger();
    const r = await createTextModel({ ...cfg, reasoning: "none" }, log, k.f).write(req, { timeoutMs: 5000, check: ok });
    expect(r).toEqual({ kind: "text", values: { f1: "Tuesday works for me." } });
    expect(k.urls).toEqual(["https://llm.example/v1/chat/completions"]);
    expect(k.headers[0]?.["authorization"]).toBe("Bearer k");
    expect(k.bodies[0]).toMatchObject({ model: "small-model", response_format: { type: "json_object" }, reasoning: { enabled: false } });
    expect(k.bodies[0]?.["messages"]).toEqual([{ role: "system", content: TEXT_MODEL_RULES }, { role: "user", content: JSON.stringify(req) }]);
    expect(log.lines.some((l) => /text model small-model wrote f1 in \d+ ms/.test(l))).toBe(true);
    expect(log.lines.join("\n")).not.toContain("Tuesday works");
  });
  it("a value that breaks a rule asks one time more with the rule, never the text; a second bad answer still goes back", async () => {
    const k = fetcher(['{"f1": "too long"}', '{"f1": "short"}']);
    const r = await createTextModel(cfg, fakeLogger(), k.f).write(req, { timeoutMs: 5000, check: (v) => (v["f1"] === "too long" ? { f1: "text is longer than max_chars" } : {}) });
    expect(r).toEqual({ kind: "text", values: { f1: "short" } });
    expect(k.bodies).toHaveLength(2);
    expect(JSON.stringify(k.bodies[1]?.["messages"])).toContain("f1: text is longer than max_chars");
    const again = fetcher(['{"f1": "too long"}']);
    expect(await createTextModel(cfg, fakeLogger(), again.f).write(req, { timeoutMs: 5000, check: () => ({ f1: "bad" }) })).toEqual({ kind: "text", values: { f1: "too long" } });
    expect(again.bodies).toHaveLength(2);
  });
  it("no f1 is a decline; a bad answer twice is a decline; an HTTP error is a decline; a slow model is a timeout", async () => {
    expect(await createTextModel(cfg, fakeLogger(), fetcher(['{"f1": null}']).f).write(req, { timeoutMs: 5000, check: ok })).toEqual({ kind: "declined", reason: "the text model found no text for the field in the goal" });
    expect(await createTextModel(cfg, fakeLogger(), fetcher(["no json"]).f).write(req, { timeoutMs: 5000, check: ok })).toEqual({ kind: "declined", reason: "the text model gave no valid answer" });
    expect(await createTextModel(cfg, fakeLogger(), fetcher(["{}"], 401).f).write(req, { timeoutMs: 5000, check: ok })).toEqual({ kind: "declined", reason: "the text model returned HTTP 401" });
    const slow = async (_url: string, init: { signal: AbortSignal }) => new Promise<never>((_r, reject) => { init.signal.addEventListener("abort", () => reject(new Error("aborted"))); });
    expect(await createTextModel(cfg, fakeLogger(), slow).write(req, { timeoutMs: 50, check: ok })).toEqual({ kind: "timeout" });
  });
});
