// Pure checks of the in-page script strings of snapshot.ts: they parse, and they hold rule B (pointer rows) and the
// quirks-mode height. No Chrome. The behaviour is checked in pointer-rows.live.test.ts (JEV_LIVE=1).
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import type { Action } from "../../src/fast/model.js";
import { MARKER_SCRIPT, SNAPSHOT_SCRIPT, popupScript } from "../../src/fast/snapshot.js";

const field: Action = { id: "e1", kind: "fill", node: 7, label: "Area", role: "textbox" };
/** Compile a script: a syntax error throws. The script does not run. */
const parses = (script: string): boolean => { new Script(script); return true; };

describe("snapshot script strings", () => {
  it("the snapshot, the marker, and the popup scripts parse", () => {
    expect(parses(SNAPSHOT_SCRIPT)).toBe(true);
    expect(parses(MARKER_SCRIPT)).toBe(true);
    expect(parses(popupScript(field, false))).toBe(true);
    expect(parses(popupScript(field, true))).toBe(true);
  });

  it("the page height is the scroll height of the scrolling element, also for the scroll_down fallback", () => {
    expect(SNAPSHOT_SCRIPT).toContain("height=(document.scrollingElement||document.documentElement).scrollHeight");
    expect(SNAPSHOT_SCRIPT).not.toContain("height=document.documentElement.scrollHeight");
    expect(SNAPSHOT_SCRIPT).toContain("else if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down'");
  });

  it("rule B: the handler test, the selector test, the pointer-root test, the text limit, the dialog order, and the cap", () => {
    expect(SNAPSHOT_SCRIPT).toContain("e.hasAttribute('onclick') || typeof e.onclick==='function'");
    expect(SNAPSHOT_SCRIPT).toContain("k.startsWith('__reactProps$') && !k.startsWith('__reactEventHandlers$')");
    expect(SNAPSHOT_SCRIPT).toContain("const HANDLERS=['onClick','onMouseDown','onPointerDown'];");
    expect(SNAPSHOT_SCRIPT).toContain("e.matches(sel) || e.parentElement?.closest(sel) || e.querySelector(sel)");
    expect(SNAPSHOT_SCRIPT).toContain("getComputedStyle(e).cursor!=='pointer' || (p && getComputedStyle(p).cursor==='pointer')");
    expect(SNAPSHOT_SCRIPT).toContain("t.length>=1 && t.length<=200");
    expect(SNAPSHOT_SCRIPT).toContain("'[role=\"dialog\"],[aria-modal=\"true\"],dialog[open]'");
    expect(SNAPSHOT_SCRIPT).toContain("rows.slice(0,60)");
    expect(SNAPSHOT_SCRIPT).toContain("kind:'click',role:'button',label:text,value:'',inferred:true");
    // The pass runs after the selector loop and before the cap of 250 actions.
    const pass = SNAPSHOT_SCRIPT.indexOf("cache.pointerText(e,selector,visible)");
    expect(pass).toBeGreaterThan(SNAPSHOT_SCRIPT.indexOf("for (const e of document.querySelectorAll(selector))"));
    expect(pass).toBeLessThan(SNAPSHOT_SCRIPT.indexOf("actions.splice(250)"));
  });

  it("the popup script lists pointer rows next to the PICK controls, and keeps its cap of 20", () => {
    const s = popupScript(field, false);
    expect(s).toContain("c.pointerText(x,PICK,shown)");
    expect(s).toContain("picks.length>=20");
  });
});
