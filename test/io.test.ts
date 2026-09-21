import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/io.js";
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
