import { describe, expect, it } from "vitest";
import { extractKeys, extractProfileMentions, extractSpans, extractUrls, mentionsProfileWord, redact, varSpans } from "../src/task.js";

describe("extractUrls", () => {
  it("finds http URLs and strips trailing punctuation", () => {
    expect(extractUrls("open https://example.com/a, then read.")).toEqual(["https://example.com/a"]);
  });
  it("finds bare domains", () => {
    expect(extractUrls("open wikipedia.org and search")).toEqual(["https://wikipedia.org"]);
    expect(extractUrls("open app.parallelloop.ai and login")).toEqual(["https://app.parallelloop.ai"]);
  });
  it("returns none when no URL", () => {
    expect(extractUrls("search for cats")).toEqual([]);
  });
  it("dedupes and keeps text order", () => {
    expect(extractUrls("go to github.com then https://github.com and mail.google.com")).toEqual(["https://github.com", "https://mail.google.com"]);
  });
});

describe("extractSpans", () => {
  const texts = (t: string, ex: string[] = []) => extractSpans(t, ex).map((s) => s.text);
  it("finds quoted text first", () => {
    const s = extractSpans('search for "Alan Turing" on wikipedia');
    expect(s[0]).toMatchObject({ id: "s1", text: "Alan Turing", source: "quoted" });
  });
  it("handles curly quotes", () => {
    expect(texts("type “hello world” into the box")[0]).toBe("hello world");
  });
  it("finds emails, currency numbers and dates", () => {
    const t = texts("email bob@example.com about $12.50 due 2026-03-01 or March 3");
    expect(t).toContain("bob@example.com");
    expect(t).toContain("$12.50");
    expect(t).toContain("2026-03-01");
    expect(t).toContain("March 3");
  });
  it("finds text after a value verb", () => {
    const s = extractSpans("open wikipedia and search for Alan Turing, then tell me the title");
    const av = s.find((x) => x.source === "after_verb");
    expect(av?.text).toBe("Alan Turing");
    expect(av?.verb).toBe("search for");
  });
  it("finds text after named", () => {
    expect(texts("open the project named Licious Data")).toContain("Licious Data");
  });
  it("finds proper nouns, clauses and the whole task last", () => {
    const s = extractSpans("go to Hacker News, then read the top story");
    expect(s.some((x) => (x.source === "proper_noun" || x.source === "after_verb") && x.text === "Hacker News")).toBe(true);
    expect(extractSpans("Open Wikipedia and read Alan Turing").some((x) => x.source === "proper_noun" && x.text === "Alan Turing")).toBe(true);
    expect(s.some((x) => x.source === "clause")).toBe(true);
    expect(s[s.length - 1]?.source).toBe("whole_task");
  });
  it("dedupes case-insensitively and caps at 40", () => {
    const long = Array.from({ length: 60 }, (_, i) => `"item ${i}"`).join(" and ");
    const s = extractSpans(long);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(new Set(s.map((x) => x.text.toLowerCase())).size).toBe(s.length);
  });
  it("excludes profile names and catalog aliases", () => {
    expect(texts("open gmail in the Parallelloop profile", ["Parallelloop", "gmail"])).not.toContain("Parallelloop");
    expect(texts("open gmail in the Parallelloop profile", ["Parallelloop", "gmail"])).not.toContain("gmail");
  });
  it("marks spans after password as secret", () => {
    const s = extractSpans('log in with password "hunter2"');
    expect(s.find((x) => x.text === "hunter2")?.secret).toBe(true);
  });
});

describe("varSpans", () => {
  it("uses v_<key> ids and secret keys", () => {
    const s = varSpans({ email: "a@b.c", password: "x" });
    expect(s).toEqual([
      { id: "v_email", text: "a@b.c", source: "var", secret: false },
      { id: "v_password", text: "x", source: "var", secret: true },
    ]);
  });
});

describe("extractKeys", () => {
  it("normalises key words and chords", () => {
    expect(extractKeys("press Escape then Cmd+K and Ctrl+Enter")).toEqual([
      { label: "k1", key: "Meta+k" }, { label: "k2", key: "Control+Enter" }, { label: "k3", key: "Escape" },
    ]);
  });
});

describe("extractProfileMentions", () => {
  const profiles = [{ directory: "Profile 14", name: "Parallelloop" }, { directory: "Profile 2", name: "BP" }, { directory: "Default", name: "Personal" }];
  it("matches by name or directory as a whole word", () => {
    expect(extractProfileMentions("use Profile 14", profiles).map((p) => p.name)).toEqual(["Parallelloop"]);
    expect(extractProfileMentions("open gmail in the parallelloop profile", profiles).map((p) => p.name)).toEqual(["Parallelloop"]);
    expect(extractProfileMentions("set bpm to 120", profiles)).toEqual([]);
    expect(extractProfileMentions("use BP and Parallelloop", profiles).length).toBe(2);
  });
  it("mentionsProfileWord", () => {
    expect(mentionsProfileWord("check my account")).toBe(true);
    expect(mentionsProfileWord("open wikipedia")).toBe(false);
  });
});

describe("redact", () => {
  it("replaces secrets", () => {
    const spans = [{ id: "v_password", text: "hunter2", source: "var" as const, secret: true }, { id: "s1", text: "keep", source: "quoted" as const, secret: false }];
    expect(redact("pw hunter2 keep hunter2", spans)).toBe("pw *** keep ***");
  });
});
