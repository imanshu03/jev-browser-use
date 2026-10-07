import { describe, expect, it } from "vitest";
import { BrowserError, classifyError, createBrowser, parseEnvelope, type SpawnFn } from "../src/browser.js";

describe("parseEnvelope", () => {
  it("parses success", () => {
    expect(parseEnvelope('{"success":true,"data":{"url":"https://x"},"error":null}')).toEqual({ success: true, data: { url: "https://x" }, error: null });
  });
  it("parses failure with type and code and warning", () => {
    expect(parseEnvelope('{"success":false,"data":null,"error":"Missing","type":"missing_arguments"}')).toMatchObject({ success: false, error: "Missing", type: "missing_arguments" });
    expect(parseEnvelope('{"success":false,"data":null,"error":"gone","code":"tab_gone"}')).toMatchObject({ code: "tab_gone" });
    expect(parseEnvelope('{"success":true,"data":{},"error":null,"warning":"A dialog is pending"}')).toMatchObject({ warning: "A dialog is pending" });
  });
  it("handles junk", () => {
    expect(parseEnvelope("").success).toBe(false);
    expect(parseEnvelope("not json").success).toBe(false);
  });
});

describe("classifyError", () => {
  it("classifies each fixture string", () => {
    expect(classifyError({ error: "Element '@e64' is covered by <div.min-h-[1.5rem].w-full inside div#root> at its click point" }, false)).toBe("covered");
    expect(classifyError({ error: "Unknown ref: e999" }, false)).toBe("unknown_ref");
    expect(classifyError({ error: "Timeout 30000ms exceeded" }, false)).toBe("timeout");
    expect(classifyError({ error: null }, true)).toBe("timeout");
    expect(classifyError({ error: "Missing arguments", type: "missing_arguments" }, false)).toBe("usage");
    expect(classifyError({ error: "tab closed", code: "tab_gone" }, false)).toBe("tab_gone");
    expect(classifyError({ error: "element is not visible" }, false)).toBe("not_visible");
    expect(classifyError({ error: "Failed to launch chrome" }, false)).toBe("launch");
    expect(classifyError({ error: "something else" }, false)).toBe("other");
  });
});

describe("createBrowser", () => {
  function spy() {
    const calls: { args: string[]; timeout: number; env: NodeJS.ProcessEnv }[] = [];
    let reply = '{"success":true,"data":{"url":"https://a","title":"A","text":"t","snapshot":"- link \\"x\\" [ref=e1]","refs":{"e1":{"role":"link","name":"x"}}},"error":null}';
    const spawn: SpawnFn = async (_bin, args, timeout, env) => { calls.push({ args, timeout, env }); return { stdout: reply, stderr: "", code: 0, timedOut: false }; };
    return { calls, spawn, setReply: (r: string) => { reply = r; } };
  }
  it("puts global flags on every argv and sets the env timeout", async () => {
    const s = spy();
    const b = createBrowser({ bin: "ab", session: "s1", profileDirectory: "Profile 14", headed: true, commandTimeoutMs: 30000 }, s.spawn);
    await b.click("e1");
    expect(s.calls[0]?.args).toEqual(["--session", "s1", "--profile", "Profile 14", "--headed", "click", "@e1", "--json"]);
    expect(s.calls[0]?.env["AGENT_BROWSER_DEFAULT_TIMEOUT"]).toBe("25000");
    expect(s.calls[0]?.timeout).toBe(30000);
  });
  it("open uses the long timeout and cdp replaces profile", async () => {
    const s = spy();
    const b = createBrowser({ bin: "ab", session: "s1", profileDirectory: "Profile 14", cdp: 9222, headed: false, commandTimeoutMs: 30000 }, s.spawn);
    const r = await b.open("https://a");
    expect(r).toEqual({ url: "https://a", title: "A" });
    expect(s.calls[0]?.args.slice(0, 4)).toEqual(["--session", "s1", "--cdp", "9222"]);
    expect(s.calls[0]?.timeout).toBe(60000);
  });
  it("throws a classified BrowserError and dismisses a pending dialog once", async () => {
    const s = spy();
    const b = createBrowser({ bin: "ab", session: "s1", headed: false, commandTimeoutMs: 30000 }, s.spawn);
    s.setReply('{"success":false,"data":null,"error":"Element is covered by <div#banner>"}');
    await expect(b.click("e1")).rejects.toMatchObject({ kind: "covered", coveringSelector: "<div#banner>" });
    s.setReply('{"success":true,"data":{"url":"u"},"error":null,"warning":"a dialog is open"}');
    await b.getUrl();
    expect(s.calls.some((c) => c.args.includes("dialog") && c.args.includes("dismiss"))).toBe(true);
    expect(b.lastWarning).toBe("a dialog is open");
  });
  it("waitLoad returns false on error and snapshot parses refs", async () => {
    const s = spy();
    const b = createBrowser({ bin: "ab", session: "s1", headed: false, commandTimeoutMs: 30000 }, s.spawn);
    const snap = await b.snapshot({ interactive: true, urls: true });
    expect(snap.refs["e1"]).toEqual({ role: "link", name: "x" });
    expect(s.calls[0]?.args).toContain("--urls");
    s.setReply('{"success":false,"data":null,"error":"Timeout"}');
    expect(await b.waitLoad("networkidle", 1000)).toBe(false);
    expect(new BrowserError("other", "m", "raw").kind).toBe("other");
  });
});
