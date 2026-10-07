// Parse the snapshot tree. Build ParsedPage. Chunk. Fingerprint.
import { createHash } from "node:crypto";
import type { SnapshotData } from "./browser.js";
import type { ActionKind, Element, ParsedPage } from "./types.js";
import { ACTIONABLE_ROLES, AUTH_HOST, CLICK_ROLES, CREDENTIAL_NAME, FILL_ROLES, LIMITS, ROLE_PRIORITY, SIGN_IN_HEADING } from "./types.js";

export interface TreeNode {
  ref?: string;
  role: string;
  name: string;
  depth: number;
  attrs: Record<string, string | true>;
  valueText?: string;
  children: TreeNode[];
  parent?: TreeNode;
  order: number;
}

export const LINE_RE = /^(\s*)- (\S+?)(?: "((?:[^"\\]|\\.)*)")?((?:\s\[[^\]]*\])*)(?::\s(.*))?$/;

const SECTION_ROLES = new Set(["dialog", "alertdialog", "navigation", "banner", "main", "complementary", "contentinfo",
  "form", "search", "region", "list", "table", "grid", "row", "listitem", "heading", "tabpanel", "menu"]);

function parseAttrs(groups: string): Record<string, string | true> {
  const attrs: Record<string, string | true> = {};
  for (const g of groups.matchAll(/\[([^\]]*)\]/g)) {
    for (const part of (g[1] ?? "").split(",")) {
      const p = part.trim();
      if (!p) continue;
      const eq = p.indexOf("=");
      if (eq < 0) attrs[p] = true;
      else attrs[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
    }
  }
  return attrs;
}

export function parseTree(snapshot: string): TreeNode[] {
  const roots: TreeNode[] = [];
  const stack: TreeNode[] = [];
  let order = 0;
  for (const line of snapshot.split("\n")) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const depth = Math.floor((m[1] ?? "").length / 2);
    const node: TreeNode = {
      role: m[2] ?? "",
      name: (m[3] ?? "").replace(/\\"/g, '"'),
      depth,
      attrs: parseAttrs(m[4] ?? ""),
      children: [],
      order: order++,
    };
    if (m[5] !== undefined) node.valueText = m[5];
    const ref = node.attrs["ref"];
    if (typeof ref === "string") node.ref = ref;
    while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? 0) >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) { node.parent = parent; parent.children.push(node); } else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function walk(nodes: TreeNode[], fn: (n: TreeNode) => void): void {
  for (const n of nodes) { fn(n); walk(n.children, fn); }
}

function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function sectionOf(node: TreeNode, lastHeading: TreeNode | undefined): string {
  const parts: string[] = [];
  for (let p = node.parent; p && parts.length < 3; p = p.parent) {
    if (SECTION_ROLES.has(p.role) && p.name) parts.push(`${p.role} "${cut(p.name, LIMITS.underChars)}"`);
  }
  if (parts.length < 3 && lastHeading && lastHeading.name && lastHeading.depth <= node.depth) {
    const h = `heading "${cut(lastHeading.name, LIMITS.underChars)}"`;
    if (!parts.includes(h)) parts.unshift(h);
  }
  return parts.slice(0, 3).join(" > ");
}

function stateOf(attrs: Record<string, string | true>): string {
  return Object.entries(attrs)
    .filter(([k]) => k !== "ref" && k !== "level" && k !== "url")
    .map(([k, v]) => (v === true ? k : `${k}=${v}`))
    .join(", ");
}

export function elementKey(role: string, name: string, under: string): string {
  return `${role}|${name}|${under}`;
}

export function parseSnapshot(input: { url: string; title: string; interactive: SnapshotData; full?: SnapshotData }): ParsedPage {
  const interRoots = parseTree(input.interactive.snapshot);
  const fullRoots = input.full ? parseTree(input.full.snapshot) : null;
  const contextByRef = new Map<string, { node: TreeNode; lastHeading: TreeNode | undefined }>();
  const collect = (roots: TreeNode[]) => {
    let lastHeading: TreeNode | undefined;
    walk(roots, (n) => {
      if (n.ref) contextByRef.set(n.ref, { node: n, lastHeading });
      if (n.role === "heading") lastHeading = n;
    });
  };
  collect(interRoots);
  if (fullRoots) collect(fullRoots);      // the full tree wins for `under`

  const headings: string[] = [];
  walk(fullRoots ?? interRoots, (n) => { if (n.role === "heading" && n.name && headings.length < 20) headings.push(n.name); });

  const raw: Element[] = [];
  const foldedOptions = new Set<string>();
  let index = 0;
  const pushElement = (ref: string, node: TreeNode | null, roleFallback: string, nameFallback: string) => {
    const role = node?.role || roleFallback;
    const name = cut((node?.name || nameFallback).trim(), LIMITS.nameChars);
    const attrs = node?.attrs ?? {};
    const ctx = contextByRef.get(ref);
    const under = ctx ? sectionOf(ctx.node, ctx.lastHeading) : "";
    const el: Element = {
      ref, role, name, depth: node?.depth ?? 0, under, key: elementKey(role, name, under), attrs,
      state: stateOf(attrs), value: cut((node?.valueText ?? "").trim(), LIMITS.valueChars), seen: 1, index: index++,
    };
    if (typeof attrs["url"] === "string") el.href = attrs["url"];
    if (node && (role === "combobox" || role === "listbox" || role === "menu")) {
      const all = node.children.filter((c) => c.role === "option");
      const opts = all.slice(0, LIMITS.optionsPerElement);
      if (opts.length > 0) {
        el.options = opts.map((o) => o.name);
        el.optionRefs = opts.map((o) => o.ref ?? "");
        if (role === "combobox") for (const o of all) if (o.ref) foldedOptions.add(o.ref);
      }
    }
    raw.push(el);
  };
  const seenRefs = new Set<string>();
  walk(interRoots, (n) => {
    if (!n.ref || seenRefs.has(n.ref)) return;
    seenRefs.add(n.ref);
    pushElement(n.ref, n, n.role, n.name);
  });
  for (const [ref, r] of Object.entries(input.interactive.refs)) {
    if (seenRefs.has(ref)) continue;
    seenRefs.add(ref);
    pushElement(ref, null, r.role, r.name);
  }

  const KEEP_EMPTY = new Set(["searchbox", "textbox", "textarea", "combobox", "button", "link", "checkbox"]);
  const kept = raw.filter((e) => ACTIONABLE_ROLES.has(e.role) && !foldedOptions.has(e.ref)
    && (e.name.length > 0 || e.value.length > 0 || KEEP_EMPTY.has(e.role)));

  const byKey = new Map<string, Element>();
  for (const e of kept) {
    const prev = byKey.get(e.key);
    if (prev) prev.seen += 1; else byKey.set(e.key, e);
  }
  let elements = [...byKey.values()];
  let truncated = false;
  if (elements.length > LIMITS.maxElements) {
    truncated = true;
    elements = [...elements]
      .sort((a, b) => (ROLE_PRIORITY[a.role] ?? 9) - (ROLE_PRIORITY[b.role] ?? 9) || a.index - b.index)
      .slice(0, LIMITS.maxElements)
      .sort((a, b) => a.index - b.index);
  }
  return {
    url: input.url, title: input.title, elements, refCount: Object.keys(input.interactive.refs).length,
    headings, fingerprint: fingerprint(input.url, elements, []), truncated,
  };
}

export function chunkElements(elements: Element[], size: number = LIMITS.chunkSize): Element[][] {
  const out: Element[][] = [];
  for (let i = 0; i < elements.length; i += size) out.push(elements.slice(i, i + size));
  return out;
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url.split("#")[0] ?? url;
  }
}

export function fingerprint(url: string, elements: Element[], typedValues: string[]): string {
  const keys = [...new Set(elements.map((e) => e.key))].sort();
  const typed = [...typedValues].sort();
  return createHash("sha1").update(normalizeUrl(url) + "\n" + keys.join("\n") + "\n" + typed.join("\n")).digest("hex").slice(0, 16);
}

export function allowedActions(el: Element): ActionKind[] {
  if (el.attrs["disabled"] === true) return [];
  const r = el.role;
  let out: ActionKind[];
  if (r === "textbox" || r === "searchbox" || r === "textarea") out = ["fill", "click"];
  else if (r === "combobox") out = el.options && el.options.length > 0 ? ["select", "fill", "click"] : ["fill", "click"];
  else if (r === "checkbox" || r === "switch") out = ["check", "uncheck", "click"];
  else if (r === "radio") out = ["check", "click"];
  else if (r === "slider" || r === "spinbutton") out = ["fill"];
  else if (ACTIONABLE_ROLES.has(r)) out = ["click"];
  else out = [];
  out.push("hover");
  return out;
}

export function isCredentialField(el: Element): boolean {
  return FILL_ROLES.has(el.role) && (CREDENTIAL_NAME.test(el.name) || el.attrs["type"] === "password");
}

export function isClickable(el: Element): boolean {
  return el.attrs["disabled"] !== true && CLICK_ROLES.has(el.role);
}

export function isFillable(el: Element): boolean {
  return el.attrs["disabled"] !== true && FILL_ROLES.has(el.role);
}

export function isSelectable(el: Element): boolean {
  return el.attrs["disabled"] !== true && el.role === "combobox" && (el.options?.length ?? 0) > 0;
}

/** `[e34] button "Licious Account"` as used in the target heads. */
export function elementLabel(el: Element, nameChars: number = LIMITS.nameChars): string {
  return `[${el.ref}] ${el.role} "${cut(el.name, nameChars)}"`;
}

/** Criteria value of one element in a target head. */
export function headDescription(el: Element, nameChars: number = LIMITS.nameChars): Record<string, string> {
  const d: Record<string, string> = { element: elementLabel(el, nameChars) };
  if (el.state) d["state"] = el.state;
  if (el.value) d["current_value"] = el.value;
  if (el.under) d["under"] = el.under;
  if (el.seen > 1) d["seen"] = String(el.seen);
  return d;
}

/** Element row in the OBSERVE state. */
export function stateRow(el: Element): Record<string, string> {
  const r: Record<string, string> = { index: el.ref, role: el.role, name: el.name };
  if (el.state) r["state"] = el.state;
  if (el.value) r["value"] = el.value;
  return r;
}

export function elementDescription(el: Element, nameChars: number = LIMITS.nameChars): Record<string, string | number | string[]> {
  const d: Record<string, string | number | string[]> = { role: el.role, name: cut(el.name, nameChars) };
  if (el.under) d["under"] = el.under;
  if (el.state) d["state"] = el.state;
  if (el.seen > 1) d["seen"] = el.seen;
  if (el.options && el.options.length > 0) d["options"] = el.options.slice(0, 20);
  if (el.href) { try { d["href"] = new URL(el.href).pathname; } catch { d["href"] = el.href; } }
  return d;
}

export function compactLine(el: Element): string {
  return `${el.ref} ${el.role} "${el.name}"${el.under ? ` | under: ${el.under}` : ""}`;
}

export function describeTarget(el: Element): string {
  return `${el.role} "${el.name}"`;
}

export function pageHeuristics(page: ParsedPage): { signInWall: boolean } {
  let host = "";
  try { host = new URL(page.url).host; } catch { host = page.url; }
  const signInWall = AUTH_HOST.test(host) || page.elements.some(isCredentialField) || page.headings.some((h) => SIGN_IN_HEADING.test(h));
  return { signInWall };
}

/** True when `name` contains one of `words` as a whole word or phrase. */
export function keywordHit(name: string, words: string[]): boolean {
  const n = name.toLowerCase();
  return words.some((w) => new RegExp(`(?<![a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z])`, "i").test(n));
}
