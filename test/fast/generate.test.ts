import { describe, expect, it } from "vitest";
import type { TextField } from "../../src/io.js";
import { buildTextRequest, checkTexts, flatText, hostOf, pickFields, sanitizeText } from "../../src/fast/generate.js";
import type { Action } from "../../src/fast/model.js";
import { actionKey, canWriteInto } from "../../src/fast/policy.js";
import { redact, varSpans } from "../../src/task.js";
import type { Span } from "../../src/types.js";
import { LIMITS } from "../../src/types.js";
import { el, obs } from "./fakes.js";

const box = (label: string, extra: Partial<Action> = {}): Action => el("e1", "fill", label, "textbox", { value: "", ...extra });
const none = { banned: new Set<string>(), bound: new Set<number>() };
const same = (s: string): string => s;
const field = (id: string, over: Partial<TextField> = {}): TextField => ({ id, label: id, role: "textbox", required: id === "f1", multiline: false, max_chars: LIMITS.generatedChars, current_value: "", ...over });

describe("canWriteInto", () => {
  it.each([
    ["a textarea", box("Message", { multiline: true })],
    ["a contenteditable", box("Write a comment", { multiline: true })],
    ["a text input", box("Subject", { inputType: "text", maxLength: 120 })],
    ["a field labelled Reply to Ann", box("Reply to Ann", { multiline: true })],
    ["autocomplete off", box("Notes", { inputType: "text", autocomplete: "off" })],
  ])("accepts %s", (_name, a) => {
    expect(canWriteInto(a)).toBe(true);
  });
  it.each([
    ["a searchbox", el("e1", "fill", "Query", "searchbox", { value: "" })],
    ["a combobox", el("e1", "fill", "City", "combobox", { value: "" })],
    ["a spinbutton", el("e1", "fill", "Guests", "spinbutton", { value: "" })],
    ["a click", el("e1", "click", "Reply", "textbox")],
    ["inputType email", box("Address", { inputType: "email" })],
    ["inputType tel", box("Contact", { inputType: "tel" })],
    ["inputType url", box("Link", { inputType: "url" })],
    ["autocomplete email", box("Your details", { autocomplete: "email" })],
    ...["To", "Cc", "Bcc", "Amount", "Card number", "API key", "Search mail", "Password", "  to  "].map((l) => [`the label ${JSON.stringify(l)}`, box(l)] as [string, Action]),
  ])("rejects %s", (_name, a) => {
    expect(canWriteInto(a)).toBe(false);
  });
});

describe("pickFields", () => {
  const actions = [
    el("e1", "fill", "Search mail", "searchbox", { value: "", inputType: "search", form: null }),
    el("e2", "fill", "Cc", "textbox", { value: "", inputType: "email", form: 7 }),
    el("e3", "fill", "Reply", "textbox", { value: "", form: 7, multiline: true }),
    el("e4", "fill", "Subject", "textbox", { value: "", inputType: "text", form: 7, maxLength: 120 }),
    el("e5", "fill", "Signature", "textbox", { value: "Ann", form: 7 }),
    el("e6", "fill", "Password", "textbox", { value: "", inputType: "text", form: 7 }),
    el("e7", "fill", "Notes", "textbox", { value: "", form: 8 }),
    el("e8", "fill", "Summary", "textbox", { value: "", form: 7 }),
    el("e9", "fill", "Tags", "textbox", { value: "", form: 7 }),
    el("e10", "fill", "Footer", "textbox", { value: "", form: 7 }),
    el("e11", "fill", "Extra", "textbox", { value: "", form: 7 }),
    el("e12", "click", "Send", "button", { form: 7 }),
  ];
  const page = obs("https://mail.example/t/1", actions);
  const reply = actions[2] as Action;
  const labels = (p: ReturnType<typeof pickFields>) => p.map((x) => x.field.label);

  it("puts the target first as the only required field, then same-form empty writable fields in document order, up to 4", () => {
    const p = pickFields(page, reply, none, same);
    expect(labels(p)).toEqual(["Reply", "Subject", "Summary", "Tags"]);
    expect(p.map((x) => x.field.id)).toEqual(["f1", "f2", "f3", "f4"]);
    expect(p.map((x) => x.field.required)).toEqual([true, false, false, false]);
    expect(p[0]?.action).toBe(reply);
    expect(p[0]?.field).toEqual({ id: "f1", label: "Reply", role: "textbox", required: true, multiline: true, max_chars: LIMITS.generatedChars, current_value: "" });
    expect(p[1]?.field).toMatchObject({ label: "Subject", multiline: false, max_chars: 120 });
    expect(p.length).toBe(LIMITS.textFields);
  });
  it("leaves out the other form, the Cc email input, search, filled, credential, banned, and bound fields", () => {
    const banned = new Set([actionKey(actions[7] as Action)]);
    const bound = new Set([9]);
    const p = pickFields(page, reply, { banned, bound }, same);
    expect(labels(p)).toEqual(["Reply", "Subject", "Footer", "Extra"]);
    for (const l of ["Notes", "Cc", "Search mail", "Signature", "Password", "Summary", "Tags", "Send"]) expect(labels(p)).not.toContain(l);
  });
  it("a target with a null form gives only f1", () => {
    const lone = el("e1", "fill", "Comment", "textbox", { value: "", form: null, multiline: true });
    expect(labels(pickFields(obs("https://a.b/", [lone, ...actions.slice(3)]), lone, none, same))).toEqual(["Comment"]);
    const noForm = el("e1", "fill", "Comment", "textbox", { value: "" });
    expect(pickFields(obs("https://a.b/", [noForm, ...actions.slice(3)]), noForm, none, same)).toHaveLength(1);
  });
  it("redacts before the cut: a secret var in a long current value leaves no prefix", () => {
    const spans = varSpans({ token: "s3cr3tvalue" });
    const long = el("e1", "fill", "Reply s3cr3tvalue", "textbox", { value: `${"x".repeat(LIMITS.valueChars - 4)}s3cr3tvalue and more`, form: 1, multiline: true });
    const p = pickFields(obs("https://a.b/", [long]), long, none, (s) => redact(s, spans));
    const json = JSON.stringify(p.map((x) => x.field));
    expect(json).not.toContain("s3cr");
    expect(p[0]?.field.current_value.length).toBeLessThanOrEqual(LIMITS.valueChars);
    expect(p[0]?.field.label).toBe("Reply ***");
  });
});

describe("buildTextRequest", () => {
  const spans = varSpans({ token: "s3cr3t" });
  const redactor = (s: string) => redact(s, spans);
  const history = Array.from({ length: 7 }, (_, i) => ({ action: `step ${i} s3cr3t`, kind: "click", text: i === 6 ? "typed s3cr3t\ntext" : null, page_changed: true, step: i + 1, url: "u", operation: "CLICK" }));
  const page = obs("https://mail.example/t/1?k=s3cr3t", [box("Reply", { form: 1 })], "Can we meet?\u202E evil\u200B\u00AD\u{E0041}tag\u2028next line s3cr3t", { title: "Inbox\u202E (3) s3cr3t" });
  const fields = pickFields(page, page.actions[0] as Action, none, redactor).map((p) => p.field);
  const req = buildTextRequest({ id: "t1", task: "reply to Ann with token s3cr3t\u200B", obs: page, history, fields, redactor });

  it("holds no secret from the task, the page, or the history", () => {
    expect(JSON.stringify(req)).not.toContain("s3cr3t");
    expect(req.goal).toBe("reply to Ann with token ***");
    expect(req.page.url).toBe("https://mail.example/t/1?k=***");
  });
  it("removes bidi, zero-width, soft hyphen, and tag characters; a line separator becomes a newline", () => {
    expect(req.untrusted_page_text).toBe("Can we meet? eviltag\nnext line ***");
    expect(req.page.title).toBe("Inbox (3) ***");
    for (const c of ["\u202E", "\u200B", "\u00AD", "\u{E0041}", "\u2028"]) expect(JSON.stringify(req)).not.toContain(c);
  });
  it("holds the last 5 actions, made flat; field ids are f1, f2, ...; the page text is the last key", () => {
    expect(req.recent_actions).toHaveLength(LIMITS.textHistory);
    expect(req.recent_actions[0]).toEqual({ action: "step 2 ***", kind: "click", text: null });
    expect(req.recent_actions[4]).toEqual({ action: "step 6 ***", kind: "click", text: "typed *** text" });
    expect(req.fields.map((f) => f.id)).toEqual(["f1"]);
    expect(Object.keys(req)).toEqual(["id", "goal", "page", "fields", "recent_actions", "untrusted_page_text"]);
    expect(Object.keys(req).at(-1)).toBe("untrusted_page_text");
  });
  it("cuts the page text to LIMITS.textChars", () => {
    const big = buildTextRequest({ id: "t2", task: "t", obs: obs("https://a.b/", [], "x".repeat(9000)), history: [], fields, redactor: same });
    expect(big.untrusted_page_text.length).toBe(LIMITS.textChars);
  });
});

describe("checkTexts", () => {
  const fields = [field("f1", { label: "Reply", multiline: true }), field("f2", { label: "Subject", max_chars: 10 })];
  const secret = (id: string, text: string): Span => ({ id, text, source: "var", secret: true });

  it("rejects a required empty or missing field, an unknown id, a text that is too long, and texts over 4000 in total", () => {
    expect(checkTexts({}, fields, []).errors).toEqual({ f1: "text is required" });
    expect(checkTexts({ f1: "  \n " }, fields, []).errors).toEqual({ f1: "text is required" });
    expect(checkTexts({ f1: "ok", f7: "x" }, fields, []).errors).toEqual({ f7: "unknown field id" });
    expect(checkTexts({ f1: "ok", f2: "a subject that is long" }, fields, []).errors).toEqual({ f2: "longer than 10 characters" });
    const two = [field("f1", { multiline: true }), field("f2", { multiline: true })];
    expect(checkTexts({ f1: "a".repeat(2500), f2: "b".repeat(2000) }, two, []).errors).toEqual({ f1: "the texts together are longer than 4000 characters" });
    expect(checkTexts({ f1: "a".repeat(2000), f2: "b".repeat(2000) }, two, []).errors).toEqual({});
  });
  it("a secret of 4 or more characters inside a text names the key and never echoes the value", () => {
    const r = checkTexts({ f1: "Here is hunter22 for you" }, fields, [secret("v_password", "hunter22")]);
    expect(r.errors).toEqual({ f1: 'holds the secret value "password"; write it without that value' });
    expect(JSON.stringify(r)).not.toContain("hunter22");
    const hidden = checkTexts({ f1: "hun\u200Bter22" }, fields, [secret("v_password", "hunter22")]);
    expect(hidden.errors["f1"]).toContain('"password"');
  });
  it("a 2-character secret does not reject 12:00", () => {
    expect(checkTexts({ f1: "See you at 12:00" }, fields, [secret("v_pin", "12")])).toEqual({ values: { f1: "See you at 12:00" }, errors: {} });
  });
  it.each([
    ["PEM", "-----BEGIN RSA PRIVATE KEY-----\nMIIE"],
    ["sk-", `use sk-${"a1".repeat(12)} now`],
    ["ghp_", `ghp_${"A".repeat(36)}`],
    ["AKIA", "AKIAABCDEFGHIJKLMNOP"],
  ])("rejects a %s key", (_name, text) => {
    const r = checkTexts({ f1: text }, fields, []);
    expect(r.errors).toEqual({ f1: "looks like a key or token; remove it" });
    expect(JSON.stringify(r.errors)).not.toContain(text.slice(0, 8));
  });
  it("CRLF becomes LF, controls go, a newline in a single-line field becomes a space, an empty optional value is dropped", () => {
    const r = checkTexts({ f1: " Tuesday\r\nworks\u0007\r10:00\u202E ", f2: "Re:\n Ann", f3: "" }, [...fields, field("f3")], []);
    expect(r.errors).toEqual({});
    expect(r.values).toEqual({ f1: "Tuesday\nworks\n10:00", f2: "Re: Ann" });
    expect(checkTexts({ f1: "Hi", f2: "   " }, fields, []).values).toEqual({ f1: "Hi" });
  });
});

describe("sanitizeText, flatText, hostOf", () => {
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  const persian = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645";
  it("keeps a single ZWJ in an emoji sequence and a ZWNJ in a Persian word", () => {
    expect(sanitizeText(`We ${family} agree`)).toBe(`We ${family} agree`);
    expect(sanitizeText(persian)).toBe(persian);
  });
  it("removes a run of ZWJ, and a joiner next to a space", () => {
    expect(sanitizeText("a\u200D\u200D\u200Db")).toBe("ab");
    expect(sanitizeText("a \u200Db")).toBe("a b");
  });
  it("collapses a run of variation selectors, removes a leading selector, and removes U+E0100", () => {
    expect(sanitizeText("\u2764\uFE0F\uFE0F\uFE0E")).toBe("\u2764\uFE0F");
    expect(sanitizeText("\uFE0Fstart and \uFE0Fword")).toBe("start and word");
    expect(sanitizeText("a\u{E0100}b\u{E01EF}")).toBe("ab");
  });
  it("maps separators to newlines and strips C0, DEL, and C1 controls but keeps tabs", () => {
    expect(sanitizeText("a\u0085b\u2029c\r\nd\re")).toBe("a\nb\nc\nd\ne");
    expect(sanitizeText("a\u0000b\u001Bc\u007Fd\u009Fe\tf")).toBe("abcde\tf");
    expect(sanitizeText("\u202Aa\u2066b\u061Cc\uFEFFd\u2060e\u00ADf\u{E0001}g\u{E007F}")).toBe("abcdefg");
  });
  it("flatText collapses whitespace after sanitizing; hostOf gives the host", () => {
    expect(flatText("  Send\n\t to \u202EAnn  ")).toBe("Send to Ann");
    expect(hostOf("https://mail.example:8443/t/1?x=1")).toBe("mail.example:8443");
    expect(hostOf("file:///tmp/reply.html")).toBe("local file");
    expect(hostOf("not a url")).toBe("");
  });
});
