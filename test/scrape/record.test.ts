import { describe, expect, it } from "vitest";
import type { Action } from "../../src/fast/model.js";
import { beforeRepeat, boundParams, dismissName, startSelectSteps, stepsFromRecords } from "../../src/scrape/record.js";
import type { Step } from "../../src/scrape/spec.js";
import type { StepRecord } from "../../src/types.js";

let n = 0;
function rec(action: StepRecord["action"], target: { role: string; name: string; under?: string } | null, value: string | null = null, result: StepRecord["result"] = "ok"): StepRecord {
  n += 1;
  return {
    step: n, url: "https://shop.example/", title: "Shop", page_kind: "task_page", page_kind_conf: 0.9, done_p: 0.1, operation: null, operation_conf: 0.9,
    target: target ? { ref: `e${n}`, role: target.role, name: target.name, under: target.under ?? "" } : null, target_conf: 0.8, runner_up: null,
    action, value, value_conf: value ? 0.9 : null, risk: "navigational", path: "fast", gate: "ok", result, error: null, jev_requests: 1, duration_ms: 10,
  };
}

const PARAMS = { area: "Koramangala", query: "chicken curry cut" };

describe("stepsFromRecords", () => {
  it("maps the C5 table", () => {
    const out = stepsFromRecords([
      rec("click", { role: "link", name: "Search" }),
      rec("fill", { role: "searchbox", name: "Search products" }, "eggs"),
      rec("press_key", null, "Enter"),
      rec("select", { role: "combobox", name: "Month → 08" }, "08"),
      rec("scroll_down", null),
      rec("wait", null),
      rec("go_back", null),
      rec("none", null, null, "done"),
    ], {});
    expect(out.steps).toEqual([
      { op: "click", target: { role: "link", name: "Search" } },
      { op: "fill", target: { role: "searchbox", name: "Search products" }, value: "eggs" },
      { op: "press", key: "Enter" },
      { op: "select", target: { role: "combobox", name: "Month" }, value: "08" },
      { op: "scroll", direction: "down", times: 1 },
      { op: "wait", ms: 1000 },
      { op: "back" },
    ]);
    expect(out.skipped).toEqual([]);
  });
  it("a click or a key that submits or deletes is never saved: each run would place the order again", () => {
    const risky = (r: StepRecord, risk: StepRecord["risk"]): StepRecord => ({ ...r, risk });
    const out = stepsFromRecords([
      risky(rec("click", { role: "button", name: "Add to cart" }), "submit"),
      risky(rec("click", { role: "button", name: "Place order" }), "destructive"),
      risky(rec("press_key", null, "Enter"), "submit"),
      risky(rec("click", { role: "button", name: "Delete account" }), "destructive"),
      risky(rec("click", { role: "link", name: "Help" }), null),
    ], PARAMS);
    expect(out.steps).toEqual([{ op: "click", target: { role: "link", name: "Help" } }]);
    expect(out.skipped).toEqual([
      "step " + (n - 4) + " click: a submit action is not replayed: a scraper never submits or deletes with no confirmation",
      "step " + (n - 3) + " click: a destructive action is not replayed: a scraper never submits or deletes with no confirmation",
      "step " + (n - 2) + " press_key: a submit action is not replayed: a scraper never submits or deletes with no confirmation",
      "step " + (n - 1) + " click: a destructive action is not replayed: a scraper never submits or deletes with no confirmation",
    ]);
  });
  it("the submit of a search form right after a {param} fill is kept; after another fill it is not", () => {
    const risky = (r: StepRecord): StepRecord => ({ ...r, risk: "submit" });
    const search = stepsFromRecords([rec("fill", { role: "textbox", name: "Search for atta dal" }, "chicken curry cut"), risky(rec("click", { role: "button", name: "Submit" })), risky(rec("press_key", null, "Enter"))], PARAMS);
    expect(search.steps).toEqual([
      { op: "fill", target: { role: "textbox", name: "Search for atta dal" }, value: "{query}" },
      { op: "click", target: { role: "button", name: "Submit" } },
    ]);
    expect(search.skipped).toHaveLength(1);
    const comment = stepsFromRecords([rec("fill", { role: "textbox", name: "Your review" }, "chicken curry cut"), risky(rec("click", { role: "button", name: "Save" }))], PARAMS);
    expect(comment.steps).toHaveLength(1);
    const destructive = stepsFromRecords([rec("fill", { role: "searchbox", name: "Search" }, "chicken curry cut"), { ...rec("click", { role: "button", name: "Buy now" }), risk: "destructive" }], PARAMS);
    expect(destructive.steps).toHaveLength(1);
  });
  it("a fill value equal to a param becomes {param}", () => {
    const out = stepsFromRecords([rec("fill", { role: "textbox", name: "Search delivery location" }, "koramangala ")], PARAMS);
    expect(out.steps[0]).toEqual({ op: "fill", target: { role: "textbox", name: "Search delivery location" }, value: "{area}" });
  });
  it("a suggestion row whose name starts with a param value becomes {param} with match starts", () => {
    const out = stepsFromRecords([
      rec("click", { role: "button", name: "Koramangala 1st Block, Bengaluru, Karnataka" }),
      rec("click", { role: "button", name: "Koramangala" }),
      rec("click", { role: "button", name: "Near Koramangala, Bengaluru" }),
    ], PARAMS);
    expect(out.steps).toEqual([
      { op: "click", target: { role: "button", name: "{area}", match: "starts" } },
      { op: "click", target: { role: "button", name: "{area}" } },
      { op: "click", target: { role: "button", name: "{area}", match: "contains" } },
    ]);
  });
  it("the longest param value wins", () => {
    const out = stepsFromRecords([rec("fill", { role: "searchbox", name: "Search" }, "chicken curry cut")], { a: "chicken", query: "chicken curry cut" });
    expect(out.steps[0]).toMatchObject({ value: "{query}" });
  });
  it("select names lose ' → option'; the value maps to a param", () => {
    const out = stepsFromRecords([rec("select", { role: "combobox", name: "01 02 03 → 08" }, "08")], { month: "08" });
    expect(out.steps[0]).toEqual({ op: "select", target: { role: "combobox", name: "01 02 03" }, value: "{month}" });
  });
  it("a select control name takes no param: a param value in an unlabelled select's option list is there by chance", () => {
    const out = stepsFromRecords([
      rec("select", { role: "combobox", name: "01 02 03 04 05 06 07 08 09 10 11 12 → 08" }, "08"),
      rec("select", { role: "combobox", name: "2026\n   2025\n   2024 → 2026" }, "2026"),
    ], { month: "08", year: "2026" });
    expect(out.steps).toEqual([
      { op: "select", target: { role: "combobox", name: "01 02 03 04 05 06 07 08 09 10 11 12" }, value: "{month}" },
      { op: "select", target: { role: "combobox", name: "2026 2025 2024" }, value: "{year}" },
    ]);
  });
  it("secret fills are skipped; failed records are skipped", () => {
    const out = stepsFromRecords([
      rec("fill", { role: "textbox", name: "Password" }, "<secret>"),
      rec("fill", { role: "textbox", name: "PIN" }, "***"),
      rec("click", { role: "button", name: "Go" }, null, "failed"),
      rec("click", { role: "button", name: "Next" }),
    ], {});
    expect(out.steps).toEqual([{ op: "click", target: { role: "button", name: "Next" } }]);
    expect(out.skipped).toHaveLength(3);
    expect(out.skipped[0]).toMatch(/a secret value is not saved/);
    expect(out.skipped[2]).toMatch(/click: failed$/);
    for (const s of out.skipped) expect(s).not.toContain("***");
  });
  it("consecutive scrolls in one direction merge", () => {
    const out = stepsFromRecords([rec("scroll_down", null), rec("scroll_down", null), rec("scroll_down", null), rec("scroll_up", null), rec("scroll_down", null)], {});
    expect(out.steps).toEqual([{ op: "scroll", direction: "down", times: 3 }, { op: "scroll", direction: "up", times: 1 }, { op: "scroll", direction: "down", times: 1 }]);
  });
  it("DISMISS_WORDS clicks are optional", () => {
    const out = stepsFromRecords([rec("click", { role: "button", name: "Accept all cookies" }), rec("click", { role: "button", name: "×" }), rec("click", { role: "button", name: "Book now" })], {});
    expect(out.steps.map((s) => s.op === "click" && s.optional === true)).toEqual([true, true, false]);
    expect(dismissName("Close")).toBe(true);
    expect(dismissName("Closet organiser")).toBe(false);
  });
  it("a cut name ending with '…' becomes a starts match", () => {
    const out = stepsFromRecords([
      rec("click", { role: "link", name: "Licious Chicken Curry Cut (Skinless) – 450 g pack of fresh…" }),
      rec("select", { role: "combobox", name: "2026 2025 2024 2023 2022 2021 2020 2019 2018 2017 2016 2015 2014 2013 20…" }, "2025"),
    ], {});
    expect(out.steps[0]).toEqual({ op: "click", target: { role: "link", name: "Licious Chicken Curry Cut (Skinless) – 450 g pack of fresh", match: "starts" } });
    expect(out.steps[1]).toMatchObject({ op: "select", target: { name: "2026 2025 2024 2023 2022 2021 2020 2019 2018 2017 2016 2015 2014 2013 20", match: "starts" }, value: "2025" });
  });
  it("a literal brace in a recorded text is escaped", () => {
    const out = stepsFromRecords([rec("fill", { role: "textbox", name: "Code {x}" }, "a}b{c")], {});
    expect(out.steps[0]).toEqual({ op: "fill", target: { role: "textbox", name: "Code {{x}}" }, value: "a}}b{{c" });
  });
  it("keys other than the replay keys, open_url, and nameless targets are skipped", () => {
    const out = stepsFromRecords([rec("press_key", null, "Control+a"), rec("open_url", null, "https://x"), rec("click", { role: "button", name: "" })], {});
    expect(out.steps).toEqual([]);
    expect(out.skipped).toHaveLength(3);
  });
  it("keeps the under of a target", () => {
    const out = stepsFromRecords([rec("click", { role: "button", name: "Confirm", under: "Location dialog" })], {});
    expect(out.steps[0]).toEqual({ op: "click", target: { role: "button", name: "Confirm", under: "Location dialog" } });
  });
});

describe("beforeRepeat", () => {
  it("keeps the steps before the first step that repeats an earlier one", () => {
    const click = (name: string): Step => ({ op: "click", target: { role: "button", name } });
    expect(beforeRepeat([click("Get Sheet"), click("Get Sheet"), click("Print Sheet")])).toEqual([click("Get Sheet")]);
    expect(beforeRepeat([click("A"), click("B"), click("A"), click("C")])).toEqual([click("A"), click("B")]);
    expect(beforeRepeat([click("A"), click("B")])).toEqual([click("A"), click("B")]);
    expect(beforeRepeat([])).toEqual([]);
  });
});

describe("boundParams", () => {
  it("names the params of the start URL and of the step targets and values", () => {
    const steps: Step[] = [
      { op: "fill", target: { role: "textbox", name: "Search" }, value: "{query}" },
      { op: "click", target: { role: "button", name: "{area}", match: "starts" } },
      { op: "wait", for_text: "{title}" },
      { op: "press", key: "Enter" },
    ];
    expect([...boundParams("https://x.example/{city}/{{literal}}", steps)].sort()).toEqual(["area", "city", "query", "title"]);
  });
});

describe("startSelectSteps", () => {
  const sel = (node: number, name: string, option: string, current: string): Action =>
    ({ id: `e${node}${option}`, node, kind: "select", role: "combobox", label: `${name} → ${option}`, value: "", current_value: current, rect: null, form: null, multiline: false } as unknown as Action);
  // NECC: two unlabelled selects named by their option lists, with the page's own line breaks.
  const NECC = [
    sel(2, "01 \n        02 \n        09 \n        12", "01", "09"), sel(2, "01 \n        02 \n        09 \n        12", "08", "09"),
    sel(3, "2026 \n      2025", "2025", "2026"),
  ];
  it("a param that a select shows at the start gets a select step, with the name squashed", () => {
    expect(startSelectSteps(NECC, { month: "09", year: "2026" }, new Set())).toEqual([
      { op: "select", target: { role: "combobox", name: "01 02 09 12" }, value: "{month}" },
      { op: "select", target: { role: "combobox", name: "2026 2025" }, value: "{year}" },
    ]);
  });
  it("a bound param, an empty value, a value no select shows, and a value two selects show give no step", () => {
    expect(startSelectSteps(NECC, { month: "09", year: "2026" }, new Set(["month", "year"]))).toEqual([]);
    expect(startSelectSteps(NECC, { month: "", year: "1999" }, new Set())).toEqual([]);
    const two = [sel(4, "From", "x", "2026"), sel(5, "To", "x", "2026")];
    expect(startSelectSteps(two, { year: "2026" }, new Set())).toEqual([]);
  });
  it("selects with one name are told apart by nth", () => {
    const same = [sel(4, "Year", "x", "2025"), sel(5, "Year", "x", "2026")];
    expect(startSelectSteps(same, { year: "2026" }, new Set())).toEqual([{ op: "select", target: { role: "combobox", name: "Year", nth: 1 }, value: "{year}" }]);
  });
});
