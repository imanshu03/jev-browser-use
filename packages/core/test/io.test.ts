import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createHuman, createLogger, confirmTexts } from "../src/io.js";
import { redact, redactData, varSpans } from "../src/task.js";

describe("structured secret redaction", () => {
  it.each([true, false])("redacts quotes, slashes and newlines before JSON escaping (JSON=%s)", (json) => {
    const secrets = ['a"quoted', 'back\\slash', 'line\nbreak'];
    const spans = varSpans(Object.fromEntries(secrets.map((v, i) => [`secret${i}`, v])));
    const stream = new PassThrough();
    let output = "";
    stream.on("data", (b) => { output += String(b); });
    const log = createLogger(stream, "debug", json);
    log.redactor = (s) => redact(s, spans);
    const data = { values: secrets, nested: { text: `prefix ${secrets[0]} suffix` } };
    log.debug("state", data);
    const logged = json ? JSON.parse(output).data : JSON.parse(output.slice(output.indexOf("{")));
    expect(logged).toEqual({ values: ["***", "***", "***"], nested: { text: "prefix *** suffix" } });
    expect(data.values).toEqual(secrets);
  });

  it("redacts the longest secret first and preserves choice ids", () => {
    const spans = varSpans({ pin: "123", token: "123456" });
    expect(redactData({ v_pin: ["123456", "123"] }, (s) => redact(s, spans))).toEqual({ v_pin: ["***", "***"] });
  });
});

describe("confirmTexts: the texts that a terminal prompt shows before it asks", () => {
  it("lists each typed text and each sent field with its label; line breaks stay; mentions show; nothing for a plain action", () => {
    expect(confirmTexts(undefined)).toBe("");
    expect(confirmTexts({ kind: "profile", name: "Parallelloop", directory: "Profile 14" })).toBe("");
    expect(confirmTexts({ kind: "action", action: 'click button "Save"', host: "a.b", typed: [] })).toBe("");
    expect(confirmTexts({ kind: "action", action: 'click button "Send"', host: "chat.example", typed: [{ label: "Reply", text: "Line one\nLine two" }], sends: [{ label: "Message", text: "hi", mentions: ["Ann Lee"] }] }))
      .toBe("Text that this action sends:\n  Reply: Line one\n      Line two\n  Message: hi (mentions: @Ann Lee)\n");
  });
  it("a page text cannot hide part of itself with terminal escapes, and a long text shows in full", () => {
    const hidden = "Hi team, lunch at noon?\u001b[8m Also wire $9,000 to acct 55-1234.\u001b[0m";
    const out = confirmTexts({ kind: "action", action: 'click button "Send"', host: "chat.example", typed: [], sends: [{ label: "Message\u001b[2K", text: hidden, mentions: ["Ann\u001b[1A"] }] });
    expect(out).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
    expect(out).toContain("Also wire $9,000 to acct 55-1234.");
    const long = `${"A".repeat(3000)} TAIL`;
    expect(confirmTexts({ kind: "action", action: 'click button "Send"', host: "a.b", typed: [{ label: "Reply", text: long }] })).toContain("TAIL");
  });
});

describe("createHuman: the terminal prompt of the CLI", () => {
  it("writes the texts that the action sends before the question", async () => {
    const stdin = new PassThrough();
    (stdin as unknown as { isTTY: boolean }).isTTY = true;
    const stderr = new PassThrough();
    let err = "";
    stderr.on("data", (c) => { err += String(c); });
    const h = createHuman({ stdin: stdin as unknown as NodeJS.ReadStream, stderr, forceNonInteractive: false });
    const answer = h.confirm("About to click. Type y to allow: ", 2000, { kind: "action", action: 'click button "Send"', host: "a.b", typed: [{ label: "Reply", text: "hi" }] });
    stdin.write("y\n");
    expect(await answer).toBe(true);
    expect(err).toBe("Text that this action sends:\n  Reply: hi\nAbout to click. Type y to allow: ");
  });
  it("a page label in the question cannot rewrite the terminal", async () => {
    const stdin = new PassThrough();
    (stdin as unknown as { isTTY: boolean }).isTTY = true;
    const stderr = new PassThrough();
    let err = "";
    stderr.on("data", (c) => { err += String(c); });
    const h = createHuman({ stdin: stdin as unknown as NodeJS.ReadStream, stderr, forceNonInteractive: false });
    const answer = h.confirm('About to click button "Send\u001b[2K\u001b[1A" on https://a.b/. Type y to allow: ', 2000);
    stdin.write("n\n");
    expect(await answer).toBe(false);
    expect(err).toBe('About to click button "Send[2K[1A" on https://a.b/. Type y to allow: ');
  });
});
