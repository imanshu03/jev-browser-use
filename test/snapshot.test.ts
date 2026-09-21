import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allowedActions, chunkElements, elementDescription, fingerprint, isCredentialField, LINE_RE, pageHeuristics, parseSnapshot, parseTree } from "../src/snapshot.js";
import type { Element } from "../src/types.js";
import { snap } from "./fakes.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")).data;

describe("LINE_RE and parseTree", () => {
  it("parses role, name with escaped quotes, brackets and value text", () => {
    const m = LINE_RE.exec('  - combobox "EN" [expanded=false, ref=e37]: English');
    expect(m?.[1]).toBe("  ");
    expect(m?.[2]).toBe("combobox");
    expect(m?.[3]).toBe("EN");
    expect(m?.[5]).toBe("English");
    const roots = parseTree('- link "Say \\"hi\\"" [ref=e2, url=https://x.org/a]\n  - StaticText "child"');
    expect(roots[0]?.name).toBe('Say "hi"');
    expect(roots[0]?.attrs["url"]).toBe("https://x.org/a");
    expect(roots[0]?.children[0]?.role).toBe("StaticText");
    expect(roots[0]?.children[0]?.depth).toBe(1);
  });
});

describe("parseSnapshot on wikipedia-home", () => {
  const page = parseSnapshot({ url: "https://www.wikipedia.org/", title: "Wikipedia", interactive: fixture("wikipedia-home.snapshot"), full: fixture("wikipedia-home.full") });
  it("keeps 114 refs, the searchbox and folds combobox options", () => {
    expect(page.refCount).toBe(114);
    const sb = page.elements.find((e) => e.ref === "e34");
    expect(sb).toMatchObject({ role: "searchbox", name: "Search Wikipedia" });
    const cb = page.elements.find((e) => e.ref === "e37");
    expect(cb?.options).toContain("Deutsch");
    expect(cb?.value).toBe("English");
    expect(cb?.state).toBe("expanded=false");
    expect(page.elements.some((e) => e.role === "option")).toBe(false);
    expect(page.elements.find((e) => e.ref === "e8")?.href).toBe("https://en.wikipedia.org/");
  });
  it("sets under from the full tree and headings", () => {
    const en = page.elements.find((e) => e.ref === "e8");
    expect(en?.under).toContain('navigation "Top languages"');
    expect(page.headings[0]).toContain("Wikipedia");
  });
  it("pageHeuristics is false on wikipedia", () => {
    expect(pageHeuristics(page).signInWall).toBe(false);
  });
});

describe("dedupe, cap, under", () => {
  it("collapses identical role|name|under and keeps different under apart", () => {
    const tree = '- list "Inbox" [ref=e1]\n  - row "Mail A" [ref=e2]\n    - button "Star" [ref=e3]\n  - row "Mail B" [ref=e4]\n    - button "Star" [ref=e5]\n- button "Star" [ref=e6]\n- button "Star" [ref=e7]';
    const page = parseSnapshot({ url: "https://x", title: "t", interactive: snap(tree) });
    const stars = page.elements.filter((e) => e.name === "Star");
    expect(stars.map((s) => s.under)).toEqual(['row "Mail A" > list "Inbox"', 'row "Mail B" > list "Inbox"', ""]);
    expect(stars[2]?.seen).toBe(2);
  });
  it("falls back to empty under without a full tree and uses the nearest heading", () => {
    const tree = '- heading "Section" [level=2, ref=e1]\n- link "Go" [ref=e2]';
    const page = parseSnapshot({ url: "https://x", title: "t", interactive: snap(tree) });
    expect(page.elements.find((e) => e.ref === "e2")?.under).toBe('heading "Section"');
    const plain = parseSnapshot({ url: "https://x", title: "t", interactive: snap('- link "Go" [ref=e2]') });
    expect(plain.elements[0]?.under).toBe("");
    const tree2 = '- main "M" [ref=e0]\n  - heading "Section" [level=2, ref=e1]\n  - link "Go" [ref=e2]';
    const page2 = parseSnapshot({ url: "https://x", title: "t", interactive: snap(tree2) });
    expect(page2.elements.find((e) => e.ref === "e2")?.under).toBe('heading "Section" > main "M"');
  });
  it("caps at 1000 by ROLE_PRIORITY then document order and flags truncated", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 1100; i++) lines.push(`- link "L${i}" [ref=e${i}]`);
    lines.push('- button "B" [ref=e2000]');
    const page = parseSnapshot({ url: "https://x", title: "t", interactive: snap(lines.join("\n")) });
    expect(page.truncated).toBe(true);
    expect(page.elements.length).toBe(1000);
    expect(page.elements.some((e) => e.ref === "e2000")).toBe(true);
    expect(page.elements[0]?.ref).toBe("e1");
    expect(page.elements.some((e) => e.ref === "e1100")).toBe(false);
  });
  it("drops disabled elements from actions and empty names except inputs", () => {
    const tree = '- button "X" [disabled, ref=e1]\n- textbox [ref=e2]\n- cell [ref=e3]';
    const page = parseSnapshot({ url: "https://x", title: "t", interactive: snap(tree) });
    expect(page.elements.map((e) => e.ref)).toEqual(["e1", "e2"]);
    expect(allowedActions(page.elements[0] as Element)).toEqual([]);
  });
});

describe("fingerprint and chunks", () => {
  const el = (ref: string, role: string, name: string): Element => ({ ref, role, name, depth: 0, under: "", key: `${role}|${name}|`, attrs: {}, state: "", value: "", seen: 1, index: 0 });
  it("is stable across ref renumbering, changes with typed values, ignores hash and utm", () => {
    const a = fingerprint("https://x/p?utm_source=a#h", [el("e1", "link", "A")], []);
    const b = fingerprint("https://x/p", [el("e9", "link", "A")], []);
    expect(a).toBe(b);
    expect(fingerprint("https://x/p", [el("e1", "link", "A")], ["typed"])).not.toBe(a);
    expect(a).toHaveLength(16);
  });
  it("chunks in document order by 200", () => {
    const els = Array.from({ length: 450 }, (_, i) => el(`e${i}`, "link", `L${i}`));
    const chunks = chunkElements(els);
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(chunks[1]?.[0]?.ref).toBe("e200");
  });
  it("allowedActions per role", () => {
    expect(allowedActions(el("e1", "textbox", "n"))).toEqual(["fill", "click", "hover"]);
    expect(allowedActions({ ...el("e1", "combobox", "n"), options: ["a"] })).toEqual(["select", "fill", "click", "hover"]);
    expect(allowedActions(el("e1", "checkbox", "n"))).toEqual(["check", "uncheck", "click", "hover"]);
    expect(allowedActions(el("e1", "link", "n"))).toEqual(["click", "hover"]);
    expect(allowedActions(el("e1", "spinbutton", "n"))).toEqual(["fill", "hover"]);
  });
  it("isCredentialField and elementDescription", () => {
    expect(isCredentialField(el("e1", "textbox", "Password"))).toBe(true);
    expect(isCredentialField({ ...el("e1", "textbox", "x"), attrs: { type: "password" } })).toBe(true);
    expect(isCredentialField(el("e1", "textbox", "Email"))).toBe(false);
    const d = elementDescription({ ...el("e1", "link", "Go"), href: "https://x.org/path/a", seen: 3, under: 'main "M"' });
    expect(d).toEqual({ role: "link", name: "Go", under: 'main "M"', seen: 3, href: "/path/a" });
  });
  it("pageHeuristics fires on auth hosts and password fields and sign-in headings", () => {
    const chooser = parseSnapshot({ url: "https://accounts.google.com/v3/signin", title: "Sign in", interactive: snap('- heading "Choose an account" [level=1, ref=e1]\n- button "Use another account" [ref=e2]') });
    expect(pageHeuristics(chooser).signInWall).toBe(true);
    const pw = parseSnapshot({ url: "https://x.com/login", title: "t", interactive: snap('- textbox "Password" [ref=e1]') });
    expect(pageHeuristics(pw).signInWall).toBe(true);
  });
});
