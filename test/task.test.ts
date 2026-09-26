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
  it("drops fragments around a quoted value: outer quote marks go, and a fragment with a mark inside is not kept", () => {
    const s = extractSpans('Search projects for "jev browser"');
    expect(s.map((x) => [x.source, x.text])).toEqual([["quoted", "jev browser"], ["after_verb", "projects"], ["whole_task", 'Search projects for "jev browser"']]);
    const p = extractSpans('Create a project named "QA Regression 12" with description "Nightly regression suite"').map((x) => x.text);
    expect(p.filter((t) => /QA Regression 12/.test(t))).toEqual(["QA Regression 12", 'Create a project named "QA Regression 12" with description "Nightly regression suite"']);
    expect(p).toContain("Nightly regression suite");
    // An apostrophe inside a word is not a quote mark: these fragments stay.
    expect(texts("send it's done to O'Brien, then close")).toEqual(expect.arrayContaining(["O'Brien", "send it's done to O'Brien"]));
  });
  it("keeps a quoted value with more words after it only as a search query of lower-case words", () => {
    expect(texts('Search for "machine learning" jobs in Berlin')).toContain("machine learning jobs");
    expect(texts('Search for "machine learning" jobs in Berlin')).not.toContain("machine learning jobs in Berlin");
    for (const t of ['look up "Ada Lovelace" on Wikipedia', 'search for "roadmap" in Linear', 'search for "invoice 42" from Acme', 'search for "hello" now']) {
      expect(texts(t).filter((x) => /^(Ada Lovelace|roadmap|invoice 42|hello) /.test(x))).toEqual([]);
    }
    expect(texts('search for "jev browser" and open the first result').filter((t) => /^jev browser /.test(t))).toEqual([]);
    expect(texts('Search this page for "roadmap" and open the matching workflow').filter((t) => /^roadmap /.test(t))).toEqual([]);
    expect(texts('type "hello" and press Enter').filter((t) => /^hello /.test(t))).toEqual([]);
    expect(texts('write "Thanks!" and send it').filter((t) => /^Thanks! /.test(t))).toEqual([]);
    expect(texts('Enter "Weekly sync" as the title and click Save').filter((t) => /^Weekly sync /.test(t))).toEqual([]);
    expect(texts('Rename the display name to "New Name" and save')).not.toContain("New Name and save");
  });
  it("reads single quotes and apostrophes apart", () => {
    for (const t of ["search for ‘machine learning’ jobs in Berlin", "search for 'machine learning' jobs in Berlin"]) {
      const s = texts(t);
      expect(s[0]).toBe("machine learning");
      expect(s).toContain("machine learning jobs");
      expect(s.filter((x) => /[’']/.test(x) && x !== t)).toEqual([]);
    }
    expect(texts("find ‘Macy’s’ stores near me").slice(0, 2)).toEqual(["Macy’s", "Macy’s stores near me"]);
    expect(texts("search for kids’ shoes")).toContain("kids’ shoes");
    // An apostrophe opens no quote: no quoted span in "it's done to O'Brien".
    expect(extractSpans("send it's done to O'Brien, then close").filter((s) => s.source === "quoted")).toEqual([]);
    // After a digit too: "80's music", "Q4's plan".
    expect(texts("search for 80's music")).toContain("80's music");
    expect(texts("set the title to Q4's plan")).toContain("Q4's plan");
  });
  it("ends an after-verb value at 'and' before the next step", () => {
    expect(texts("Rename the artifact to Q3 Budget Review and save it")).toContain("Q3 Budget Review");
    expect(texts("Change the project instructions to Always answer in English and save")).toContain("Always answer in English");
    expect(texts("Open the command bar, search for Q3 Roadmap and open the artifact")).toContain("Q3 Roadmap");
    expect(texts("Search projects for licious and open it")).toContain("licious");
    // "and" inside a value stays: "maximum" is not a step.
    expect(texts("Set max turns to 250 and maximum output tokens to 8000")).toContain("250 and maximum output tokens");
    expect(texts("Rename the artifact to budget review and save it")).toContain("budget review");
    expect(texts("Create a project called Apollo Launch and invite Ann Lee")).toContain("Apollo Launch");
    // A capitalized word or a noun after "and" belongs to the value; so does "and" inside a quote.
    for (const [t, v] of [["Rename the channel to Show and Tell", "Show and Tell"], ["Create a folder named Copy and Paste Guides", "Copy and Paste Guides"],
      ["Set the subject to Budget and schedule update", "Budget and schedule update"], ["Set the filter name to closed and open issues", "closed and open issues"]] as const) {
      expect(texts(t)).toContain(v);
    }
    const after = (t: string) => extractSpans(t).filter((x) => x.source === "after_verb").map((x) => x.text);
    expect(after('Set the button label to "save and close"')).not.toContain("save");
    expect(after('Set the button label to "save and send the report"')).not.toContain("save");
    // A message after "type" or "write" keeps its words together.
    expect(after("Type we will review and approve it in the comment box")).toEqual(["we will review and approve it"]);
    expect(after("Write thanks and confirm the meeting time in the reply")).not.toContain("thanks");
    // So does a message after "with" or "as" when a verb for a message comes first, or when a pronoun starts it.
    expect(after("Reply with we will review and approve it")).toEqual(["we will review and approve it"]);
    expect(after("Answer with I will check and update the doc tomorrow")).not.toContain("I will check");
    expect(after("Post a comment as we will fix and publish it tomorrow")).not.toContain("we will fix");
    expect(after("Set the note as I will check and update the doc tomorrow")).not.toContain("I will check");
    // "with" or "as" before a name ends the value at the next step.
    expect(after("Save it as budget review and close it")).toContain("budget review");
  });
  it("ends a value before a step that acts on the page, and a message before the step that sends it", () => {
    const after = (t: string) => extractSpans(t).filter((x) => x.source === "after_verb").map((x) => x.text);
    for (const [t, v] of [["Rename the file to budget and click Save", "budget"], ["Create a folder named Tax Receipts 2026 and click Create", "Tax Receipts 2026"],
      ["Set the title to weekly sync and press Enter", "weekly sync"], ["Set the subject to lunch plans and hit Send", "lunch plans"],
      ["Rename the doc to budget review and click on Save", "budget review"], ["Change the status message to out of office and save changes", "out of office"],
      ["Rename the channel to general chat and go back", "general chat"], ["Set the date to 15 September 2026 and click Update", "15 September 2026"],
      ["Look up weather in Paris and press Enter", "weather in Paris"],
      ["Type hello and press Enter", "hello"], ["Write thanks and send it", "thanks"], ["Type lgtm and click Comment", "lgtm"], ["Type ok and send", "ok"],
      ["Write sounds good and click Send", "sounds good"], ["Reply with thanks and send it", "thanks"], ["Type hello team and send the message", "hello team"]] as const) {
      expect(texts(t)).toContain(v);
      expect(after(t).filter((x) => x.startsWith(`${v} and`))).toEqual([]);
    }
    // A step verb before a capitalized word can start a step or belong to the value: both values, the cut first. The cut
    // and the longer value are a pair (each names the other), and the cut has no parent: a head that hides the longer
    // value by its length still offers the pair when the cut passes ("Launch prep" of "Launch prep and open Settings").
    for (const [t, cut, full] of [["Search for Q3 Roadmap and open Licious", "Q3 Roadmap", "Q3 Roadmap and open Licious"],
      ["Look up how to install and run Python", "how to install", "how to install and run Python"],
      ["Set the channel topic to Launch prep and open Settings", "Launch prep", "Launch prep and open Settings"],
      ["Type hello and send it to the team", "hello", "hello and send it to the team"]] as const) {
      const spans = extractSpans(t).filter((x) => x.source === "after_verb");
      const c = spans.findIndex((x) => x.text === cut);
      const f = spans.findIndex((x) => x.text === full);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(f).toBeGreaterThan(c);
      expect(spans[c]?.pair).toBe(spans[f]?.id);
      expect(spans[f]?.pair).toBe(spans[c]?.id);
      expect(spans[c]?.parent).toBeUndefined();
    }
    // A cut before a preposition that goes past the maybe "and" is neither value, so it is not a span.
    expect(texts("Type hello and send it to Ann")).not.toContain("hello and send it");
    expect(texts("Create a task named Review and approve changes to pricing")).not.toContain("Review and approve changes");
    // A title in title case and a noun after "and" stay whole.
    for (const [t, v] of [["Create a playlist called Hit and Run", "Hit and Run"], ["Create an event named Save the Date and Send Invites", "Save the Date and Send Invites"],
      ["Create a project named Build and Run Tests", "Build and Run Tests"]] as const) {
      expect(after(t)).toContain(v);
    }
  });
  it("names the span that a cut comes from, and squashes the spaces of a verb", () => {
    const s = extractSpans("set the subject to Quarterly budget review for Q3 planning, then send it");
    const full = s.find((x) => x.text === "Quarterly budget review for Q3 planning");
    expect(full).toMatchObject({ source: "after_verb", verb: "to" });
    expect(s.find((x) => x.text === "Quarterly budget review")?.parent).toBe(full?.id);
    expect(s.find((x) => x.text === "Quarterly")?.parent).toBe(full?.id);
    const as = extractSpans("save it as My Quarterly Report Draft 2026");
    expect(as.find((x) => x.text === "My Quarterly Report Draft")?.parent).toBe(as.find((x) => x.text === "My Quarterly Report Draft 2026")?.id);
    // A title that goes on with capitalized words is one value: its first words are a cut.
    for (const [t, cut] of [["Rename the meeting to Weekly Sync with Design Team", "Weekly Sync"], ["Create a page named Onboarding Guide for New Hires", "Onboarding Guide"]] as const) {
      expect(extractSpans(t).find((x) => x.text === cut)?.parent).toBeDefined();
    }
    expect(extractSpans("Add a contact named Ludwig van Beethoven from Bonn").find((x) => x.text === "Ludwig van Beethoven")?.parent).toBeUndefined();
    // A name that the value only goes on after is not a cut: "Sarah Connor from the Berlin office".
    for (const [t, name] of [["set the owner to Sarah Connor from the Berlin office", "Sarah Connor"], ["put Maria Lopez from Finance as the approver", "Maria Lopez"], ["assign it to Priya Raman from the platform team", "Priya Raman"]] as const) {
      const n = extractSpans(t).find((x) => x.text === name);
      expect(n).toBeDefined();
      expect(n?.parent).toBeUndefined();
    }
    expect(extractSpans("search  for cats").find((x) => x.source === "after_verb")?.verb).toBe("search for");
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
