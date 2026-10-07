import { describe, expect, it } from "vitest";
import { Secrets, TemplateError, envNames, expandEnv, fillVars, resolveVars, varNames } from "../src/template.js";

describe("expandEnv", () => {
  it("fills ${NAME} and ${NAME:-default}, and a missing var with no default is empty", () => {
    const s = new Secrets();
    const out = expandEnv({ a: "${HOST}/x", b: ["${MISSING:-fallback}"], c: "${MISSING}", n: 3 }, { HOST: "https://h" }, s);
    expect(out).toEqual({ a: "https://h/x", b: ["fallback"], c: "", n: 3 });
  });
  it("keeps the values of secret-looking names and of named secrets for redaction", () => {
    const s = new Secrets();
    expandEnv({ a: "${ADMIN_PASSWORD}", b: "${API_KEY}", c: "${PLAIN}", d: "${MY_CODE}" }, { ADMIN_PASSWORD: "hunter22", API_KEY: "sk-abcdef", PLAIN: "visible", MY_CODE: "9911" }, s, new Set(["MY_CODE"]));
    expect(s.redact("hunter22 sk-abcdef visible 9911")).toBe("*** *** visible ***");
  });
  it("lists env names", () => {
    expect(envNames({ a: "${A} ${B:-x}", b: ["${C}"] }).sort()).toEqual(["A", "B", "C"]);
  });
});

describe("fillVars", () => {
  it("fills {var}, keeps {{ }} as literal braces, and names unknown vars", () => {
    expect(fillVars("Add {title} {{json}}", { title: "Milk" })).toBe("Add Milk {json}");
    expect(() => fillVars("Add {nope}", { title: "x" })).toThrow(TemplateError);
    expect(() => fillVars("Add {nope}", { title: "x" })).toThrow(/unknown var \{nope\}.*Known: title/);
  });
  it("leaves upper-case braces alone: only var names are placeholders", () => {
    expect(fillVars("{Upper} text", {})).toBe("{Upper} text");
  });
  it("lists vars and resolves var maps in order", () => {
    expect(varNames("a {x} b {y_2}")).toEqual(["x", "y_2"]);
    expect(resolveVars({ now: "1" }, { title: "Note {now}", full: "{title}!" })).toEqual({ now: "1", title: "Note 1", full: "Note 1!" });
  });
});

it("removes a secret from text that already has JSON escapes", () => {
  const secrets = new Secrets();
  const value = 'private-"value\\with\nlines';
  secrets.add(value);
  expect(secrets.redact(JSON.stringify({ value }))).toBe('{"value":"***"}');
});
