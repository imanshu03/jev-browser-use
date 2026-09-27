// The page reader of the fast engine: one in-page script that reads the whole document (tables, record groups, form
// values, and visible text), and a code-only loader that scrolls until the page stops growing. Pure I/O. No decisions.
//
// READ_FN walks the flat tree once (open shadow roots and slots included) and keeps, per visible element, the range of
// its text pieces and of its slots. Tables, record groups, headings, and text blocks then read those ranges; no second
// walk and no layout change. Prior art: TABLES_SCRIPT and the card probes of /tmp/jevscrape/probe (the width fix and the
// section rows of the NECC table; the Blinkit and Zepto card facts).
import type { Page } from "./model.js";
import { StalePage } from "./model.js";
import type { ReadOptions, ScrollState } from "./read-types.js";
import { READ_LIMITS } from "./read-types.js";
import { CREDENTIAL_NAME } from "../types.js";

/** The limits of one read: READ_LIMITS with the overrides of `opts.limits`. A value that is not a number >= 0 is ignored. */
export function readLimits(opts: ReadOptions = {}): typeof READ_LIMITS {
  const out: Record<string, number> = { ...READ_LIMITS };
  for (const [k, v] of Object.entries(opts.limits ?? {})) {
    if (k in READ_LIMITS && typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
  }
  return out as unknown as typeof READ_LIMITS;
}

/** normKey of read-types.ts as page source. The signatures use it in the page; a unit test keeps both the same. */
export const NORM_KEY_SRC = String.raw`(s => String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/\s*[:*]+$/, '').trim())`;

/**
 * The reader. `cfg` = {limits, text, cred, flags}. Returns a PageRead without `stats.ms`, or null with no body.
 *
 * Visible text: an element with display none, an sr-only box (absolute or fixed, at most 2x2 px, clipped), and their
 * subtrees are out; a text node is out when its element is not visibility visible or its range has no size. Text under
 * aria-hidden="true" stays (shops render prices there). Opacity is not checked: lazy pages fade in below the fold.
 */
const READ_FN = String.raw`function (cfg) {
  if (!document.body) return null;
  const L = cfg.limits;
  const CRED = new RegExp(cfg.cred, cfg.flags);
  const SECRET_AC = /password|one-time-code|cc-/i;
  // A private field by its words (a label, a placeholder, a title) or by its name or id: a card, a CVV, an account.
  const PRIVATE_WORDS = /\b(?:card|cvv|cvc|cvn|iban|ssn|social security|account (?:number|no)|routing|tax ?id|passport)\b/i;
  const PRIVATE_NAME = /card|cvv|cvc|iban|ssn|acct|account_?(?:no|num)|routing|passport|(?:^|[^a-z])[mt]pin(?:[^a-z]|$)/i;
  const normKey = ${NORM_KEY_SRC};
  let cut = false, nodes = 0;
  const squash = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const clip = (s, n) => { if (s.length <= n) return s; cut = true; return s.slice(0, n); };
  const WS = /^\s*$/;
  // Never rendered as page text. A select keeps its value (meta), not its options.
  const SKIP = new Set(['script','style','noscript','template','title','desc','head','meta','link','base','iframe','frame',
    'frameset','object','embed','datalist','option','optgroup','map','area','track','source','param','wbr']);
  const NOKIDS = new Set(['select','textarea','canvas','video','audio']);
  const BLOCK = new Set(['block','flex','grid','list-item','table-cell','table-caption','flow-root']);
  const HLEV = {h1:1,h2:2,h3:3,h4:4,h5:5,h6:6};
  const range = document.createRange();

  // ---- One walk of the flat tree. Per element (index ix in pre-order): parent, end of subtree, text piece range,
  // slot range, line-through, heading level, and the last heading before it.
  const pieces = [];   // {t, ix, blk, hl, ws}: visible text in document order
  const own = [];      // {ix, text, alt?, btn?}: elements with own text, images with alt, input buttons
  const ELS = [], IX = new Map(), PAR = [], DEP = [], END = [], PS = [], PE = [], OS = [], OE = [], LT = [], LV = [], HB = [];
  const tableIx = [], headIx = [], ctrlIx = [], formIx = [], buckets = [];
  let lastHead = -1;

  const TID = ix => { const e = ELS[ix]; return e.getAttribute('data-testid') || e.getAttribute('data-test-id') || e.getAttribute('data-qa') || null; };
  const SHB = [], SHF = [];
  // Shape key: tag, up to 2 class tokens in source order with digit runs as '#'; the full key adds the testid.
  const baseShape = ix => {
    let s = SHB[ix];
    if (s !== undefined) return s;
    const e = ELS[ix];
    s = e.localName.toLowerCase();
    const cl = e.classList;
    if (cl) for (let i = 0, n = 0; i < cl.length && n < 2; i++) { if (cl[i]) { s += '.' + cl[i].toLowerCase().replace(/\d+/g, '#'); n++; } }
    SHB[ix] = s;
    return s;
  };
  const shape = ix => {
    let s = SHF[ix];
    if (s !== undefined) return s;
    const t = TID(ix);
    s = baseShape(ix) + (t ? '[testid=' + t.replace(/\d+/g, '#') + ']' : '');
    SHF[ix] = s;
    return s;
  };
  const kidsOf = e => {
    if (e.shadowRoot) return e.shadowRoot.childNodes;
    if (e.localName === 'slot' && typeof e.assignedNodes === 'function') { const a = e.assignedNodes(); if (a.length) return a; }
    return e.childNodes;
  };
  const srOnly = (e, cs) => {
    if (!/^rect\(\s*[01]px/.test(cs.clip || '') && !/^inset\(\s*50%/.test(cs.clipPath || '')) return false;
    const r = e.getBoundingClientRect();
    return r.width <= 2 && r.height <= 2;
  };
  const hasText = ix => { for (let i = PS[ix]; i < PE[ix]; i++) if (!pieces[i].ws) return true; return false; };
  // Buckets of same-shape children with at least 2 slots each. Two or more members, or one member with a testid (a
  // row of cards can hold one card): a bucket is a group only when it has minRecords members after the merge.
  const NOREC = new Set(['tr','td','th','tbody','thead','tfoot','option','col','colgroup','caption']);
  function bucket(pix, kid) {
    if (kid.length < 2 && !TID(kid[0])) return;
    const m = new Map();
    for (const k of kid) {
      if (OE[k] - OS[k] < 2 || NOREC.has(ELS[k].localName)) continue;
      const s = shape(k), b = m.get(s);
      if (b) b.push(k); else m.set(s, [k]);
    }
    for (const [s, members] of m) if (members.length >= 2 || TID(members[0])) buckets.push({pix, shape: s, members});
  }

  function walk(e, pix, blk, hl) {
    nodes++;
    const ln = e.localName;
    if (SKIP.has(ln)) return -1;
    const cs = getComputedStyle(e);
    const disp = cs.display;
    if (disp === 'none') return -1;
    const pos = cs.position;
    if ((pos === 'absolute' || pos === 'fixed') && srOnly(e, cs)) return -1;
    const ix = ELS.length;
    const role = e.getAttribute('role');
    let lv = HLEV[ln] || 0;
    if (!lv && role === 'heading') lv = Math.min(6, Math.max(1, parseInt(e.getAttribute('aria-level'), 10) || 2));
    ELS.push(e); IX.set(e, ix); PAR.push(pix); DEP.push(pix >= 0 ? DEP[pix] + 1 : 0); END.push(0); PS.push(pieces.length); PE.push(0); OS.push(own.length); OE.push(0);
    LT.push(String(cs.textDecorationLine || '').indexOf('line-through') >= 0 ? 1 : 0); LV.push(lv); HB.push(lastHead);
    const vis = cs.visibility === 'visible';
    if (BLOCK.has(disp)) blk = ix;
    if (lv) hl = lv;
    if (ln === 'table' || role === 'table' || role === 'grid' || role === 'treegrid') tableIx.push(ix);
    if (ln === 'input' || ln === 'select' || ln === 'textarea' || ln === 'button') {
      if (!(ln === 'input' && e.type === 'hidden')) ctrlIx.push(ix);
      if (ln === 'input' || ln === 'select') formIx.push(ix);
    }
    if (vis && ln === 'img') { const alt = squash(e.getAttribute('alt')); if (alt) own.push({ix, text: '', alt}); }
    else if (vis && ln === 'input' && (e.type === 'submit' || e.type === 'button')) { const v = squash(e.value); if (v) own.push({ix, text: v, btn: true}); }
    const kids = NOKIDS.has(ln) || cs.contentVisibility === 'hidden' ? null : kidsOf(e);
    if (kids && kids.length) {
      const n = kids.length, tv = [];
      let ownT = '';
      // Own text first: a slot comes before the slots of its descendants.
      if (vis) for (let i = 0; i < n; i++) {
        const k = kids[i];
        if (k.nodeType !== 3 || !k.data) continue;
        if (WS.test(k.data)) { tv[i] = ' '; continue; }
        range.selectNodeContents(k);
        const r = range.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        tv[i] = k.data;
        ownT += k.data;
      }
      if (ownT) own.push({ix, text: ownT});
      const kid = [];
      for (let i = 0; i < n; i++) {
        const k = kids[i];
        if (k.nodeType === 3) {
          const t = tv[i];
          if (t === undefined) continue;
          if (t === ' ') { const last = pieces[pieces.length - 1]; if (!last || !last.ws) pieces.push({t, ix, blk, hl, ws: true}); }
          else pieces.push({t, ix, blk, hl, ws: false});
        } else if (k.nodeType === 1) {
          if (k.localName === 'br') { nodes++; if (vis) pieces.push({t: '\n', ix, blk, hl, ws: true}); continue; }
          const c = walk(k, ix, blk, hl);
          if (c >= 0) kid.push(c);
        }
      }
      if (kid.length) bucket(ix, kid);
    }
    PE[ix] = pieces.length; OE[ix] = own.length; END[ix] = ELS.length;
    if (lv && hasText(ix)) { lastHead = ix; headIx.push(ix); }
    return ix;
  }
  walk(document.body, -1, 0, 0);

  // ---- Text helpers over the piece ranges. Pieces of two blocks join with a space.
  const joinRange = (a, b, max) => {
    let out = '', last = -2;
    for (let i = a; i < b; i++) {
      const p = pieces[i];
      if (last !== -2 && p.blk !== last) out += ' ';
      out += p.t; last = p.blk;
      if (out.length > max) break;
    }
    return squash(out);
  };
  const textOf = (ix, max) => clip(joinRange(PS[ix], PE[ix], max * 2 + 16), max);
  const inside = (x, a) => a <= x && x < END[a];
  /** The last index of the sorted list at or before x, or -1. */
  const floorIn = (list, x) => { let lo = 0, hi = list.length - 1, at = -1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid] <= x) { at = mid; lo = mid + 1; } else hi = mid - 1; } return at; };
  /** The member of a sorted list of disjoint subtrees that holds x, or -1. */
  const holder = (list, x) => { const i = floorIn(list, x); return i >= 0 && inside(x, list[i]) ? list[i] : -1; };
  const hasCtl = ix => { const i = floorIn(ctrlIx, END[ix] - 1); return i >= 0 && ctrlIx[i] >= ix; };
  const absHref = e => {
    const v = e.getAttribute('href');
    if (!v) return null;
    try { const u = new URL(v, e.baseURI || document.baseURI); return /^(https?|file):$/.test(u.protocol) ? u.href : null; } catch (err) { return null; }
  };
  const byId = (e, id) => { const root = e.getRootNode(); return root && typeof root.getElementById === 'function' ? root.getElementById(id) : document.getElementById(id); };
  const labelText = x => IX.has(x) ? textOf(IX.get(x), L.cellChars) : clip(squash(x.textContent), L.cellChars);
  const headText = ix => ix >= 0 ? textOf(ix, L.cellChars) : '';

  // ---- Tables: HTML tables and ARIA grids. Inner tables first: a table that holds a read table is a layout table.
  const CELL_SEL = '[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]';
  const GRID_SEL = 'table,[role="table"],[role="grid"],[role="treegrid"]';
  const NUM = /^[-+−]?(?:[₹$€£¥]|rs\.?|inr)?\s?[-+−]?\d[\d,]*(?:\.\d+)?\s?%?$/i;
  const cellCache = new Map(), linkCache = new Map();
  const ctext = cix => { let t = cellCache.get(cix); if (t === undefined) { t = textOf(cix, L.cellChars); cellCache.set(cix, t); } return t; };
  const clink = cix => {
    if (linkCache.has(cix)) return linkCache.get(cix);
    const e = ELS[cix];
    const a = e.localName === 'a' && e.hasAttribute('href') ? e : e.querySelector('a[href]');
    const h = a ? absHref(a) : null;
    linkCache.set(cix, h);
    return h;
  };
  function readTable(tix) {
    const t = ELS[tix], html = t.localName === 'table';
    const trole = t.getAttribute('role');
    if (html && (trole === 'presentation' || trole === 'none')) return null;
    const trs = (html ? Array.from(t.rows) : Array.from(t.querySelectorAll('[role="row"]')).filter(r => r.closest(GRID_SEL) === t)).filter(r => IX.has(r));
    const n = trs.length;
    if (n < 2) return null;
    const span = (c, attr, prop) => { if (html) return c[prop]; const v = parseInt(c.getAttribute(attr), 10); return isNaN(v) ? 1 : v; };
    const colspan = c => Math.max(1, span(c, 'aria-colspan', 'colSpan') || 1);
    const cells = trs.map(r => (html ? Array.from(r.cells) : Array.from(r.querySelectorAll(CELL_SEL)).filter(c => c.closest('[role="row"]') === r)).filter(c => IX.has(c)));
    // A form in a table: more than half of the cells hold a control (the NECC month and year form).
    let total = 0, ctl = 0;
    for (const row of cells) for (const c of row) { total++; if (hasCtl(IX.get(c))) ctl++; }
    if (!total || ctl * 2 > total) return null;
    // The full grid with rowspan and colspan. Columns past the cap are not kept.
    const W = L.columns, grid = trs.map(() => []), len = trs.map(() => 0);
    for (let r = 0; r < n; r++) {
      let c = 0;
      for (const cell of cells[r]) {
        while (c < W && grid[r][c] !== undefined) c++;
        const cs = colspan(cell), rs0 = span(cell, 'aria-rowspan', 'rowSpan');
        const rs = rs0 === 0 ? n - r : Math.min(Math.max(1, rs0 || 1), n - r);
        const cix = IX.get(cell);
        for (let dr = 0; dr < rs; dr++) {
          const g = grid[r + dr];
          for (let dc = 0; dc < cs && c + dc < W; dc++) g[c + dc] = cix;
          if (len[r + dr] < c + cs) len[r + dr] = c + cs;
        }
        c += cs;
      }
    }
    // Width: the widest row whose cells all have colspan 1 (NECC declares colspan="302" in a 32-column table).
    let width = 0, widest = 0;
    for (let r = 0; r < n; r++) {
      if (len[r] > widest) widest = len[r];
      if (cells[r].length && len[r] > width && cells[r].every(c => colspan(c) === 1)) width = len[r];
    }
    if (!width) width = widest;
    let colCut = false;
    if (width > W) { width = W; colCut = true; cut = true; }
    if (width < 2) return null;
    // Section rows: one cell over the whole width. They label the rows below them and are never header rows.
    const sec = cells.map(row => row.length === 1 && colspan(row[0]) >= width);
    const body = [];
    for (let r = 0; r < n; r++) if (!sec[r]) body.push(r);
    const isTh = c => c.localName === 'th' || c.getAttribute('role') === 'columnheader';
    const texts = r => { const out = []; for (let c = 0; c < width; c++) { const x = grid[r][c]; out.push(x === undefined ? '' : ctext(x)); } return out; };
    let head = 0;
    if (html) while (head < body.length && trs[body[head]].parentElement && trs[body[head]].parentElement.localName === 'thead') head++;
    if (!head) {
      while (head < body.length && cells[body[head]].length && cells[body[head]].every(isTh)) head++;
      if (head === body.length && head > 1) head = 1;
    }
    if (!head && body.length >= 2) {
      const a = texts(body[0]), b = texts(body[1]);
      if (a.filter(s => NUM.test(s)).length < width / 2 && b.filter(s => NUM.test(s)).length >= width / 2) head = 1;
    }
    const headers = [];
    for (let c = 0; c < width; c++) {
      const parts = [];
      for (let h = 0; h < head; h++) { const x = grid[body[h]][c]; if (x === undefined) continue; const s = ctext(x); if (s && parts.indexOf(s) < 0) parts.push(s); }
      headers.push(parts.length ? parts.join(' / ') : 'col' + (c + 1));
    }
    const headSet = new Set(body.slice(0, head));
    const rows = [], sections = [];
    let section = null, count = 0;
    for (let r = 0; r < n; r++) {
      if (sec[r]) { const s = ctext(IX.get(cells[r][0])); section = s || null; if (s) sections.push(s); continue; }
      if (headSet.has(r)) continue;
      const g = grid[r];
      let any = false;
      for (let c = 0; c < width && !any; c++) if (g[c] !== undefined && hasText(g[c])) any = true;
      if (!any) continue;
      count++;
      if (rows.length >= L.rows) continue;
      const row = {section, cells: texts(r)};
      const links = {};
      let linked = false;
      for (let c = 0; c < width; c++) { const x = g[c]; if (x === undefined) continue; const h = clink(x); if (h) { links[c] = h; linked = true; } }
      if (linked) row.links = links;
      rows.push(row);
    }
    if (count < 2) return null;
    if (count > rows.length) cut = true;
    let caption = html && t.caption && IX.has(t.caption) ? textOf(IX.get(t.caption), L.cellChars) : '';
    if (!caption) caption = clip(squash(t.getAttribute('aria-label')), L.cellChars);
    if (!caption) caption = clip(squash((t.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => { const x = byId(t, id); return x ? labelText(x) : ''; }).join(' ')), L.cellChars);
    const heading = headText(HB[tix]);
    let nested = false;
    for (let x = PAR[tix]; x >= 0 && !nested; x = PAR[x]) { const e = ELS[x], rl = e.getAttribute('role'); nested = e.localName === 'td' || e.localName === 'th' || rl === 'cell' || rl === 'gridcell'; }
    return {ix: tix, out: {id: '', kind: html ? 'html' : 'aria', caption, heading, headers, header_rows: head, width, rows, sections,
      row_count: count, truncated: count > rows.length || colCut, nested,
      signature: {kind: 'table', headers: headers.map(normKey), width, caption: normKey(caption), heading: normKey(heading)}}};
  }
  const accepted = [];
  for (let i = tableIx.length - 1; i >= 0; i--) {
    const tix = tableIx[i];
    if (accepted.some(a => a.ix > tix && a.ix < END[tix])) continue;
    const t = readTable(tix);
    if (t) accepted.push(t);
  }
  accepted.sort((a, b) => a.ix - b.ix);
  const tableRoots = accepted.map(a => a.ix);
  const keptTables = accepted.slice(0, L.tables);
  if (accepted.length > keptTables.length) cut = true;
  const tableId = new Map();
  keptTables.forEach((a, i) => { a.out.id = 't' + (i + 1); tableId.set(a.ix, a.out.id); });

  // ---- Record groups. Members inside a read table are out (its rows are the records there).
  for (const b of buckets) b.members = b.members.filter(m => holder(tableRoots, m) < 0);
  const cand = buckets.filter(b => b.members.length && (b.members.length >= 2 || TID(b.members[0])));
  const P = cand.map((_, i) => i);
  const find = i => { while (P[i] !== i) { P[i] = P[P[i]]; i = P[i]; } return i; };
  // Each merged set keeps its members (sorted, disjoint) and the parents of its buckets. Two sets never merge when a
  // parent of one lies inside a member of the other: a card and a part of another card are never one group.
  const setMembers = cand.map(b => b.members.slice()), setPix = cand.map(b => [b.pix]);
  const mergeSorted = (a, b) => { const out = []; let i = 0, j = 0; while (i < a.length || j < b.length) out.push(j >= b.length || (i < a.length && a[i] < b[j]) ? a[i++] : b[j++]); return out; };
  /** True when an element in [lo, hi) of the document order has its own visible text. The own list is in document order. */
  const textIn = (lo, hi) => {
    let a = 0, b = own.length;
    while (a < b) { const m = (a + b) >> 1; if (own[m].ix < lo) a = m + 1; else b = m; }
    for (let k = a; k < own.length && own[k].ix < hi; k++) if (own[k].text) return true;
    return false;
  };
  /** Text between the last member of a and the first member of b (a label such as "More to Explore"). */
  const gapText = (a, b) => { const lo = END[a[a.length - 1]], hi = b[0]; return lo <= hi && textIn(lo, hi); };
  /** Merge two sets. False when they must stay apart. */
  const union = (i, j) => {
    i = find(i); j = find(j);
    if (i === j) return true;
    if (setPix[j].some(p => holder(setMembers[i], p) >= 0) || setPix[i].some(p => holder(setMembers[j], p) >= 0)) return false;
    // A text between two sets is a section label: the cards below "More to Explore" are not search results.
    if (gapText(setMembers[i], setMembers[j]) || gapText(setMembers[j], setMembers[i])) return false;
    P[j] = i;
    setMembers[i] = mergeSorted(setMembers[i], setMembers[j]);
    setPix[i] = setPix[i].concat(setPix[j]);
    setMembers[j] = setPix[j] = null;
    return true;
  };
  /** Merge bucket i into the first set of the list that takes it; else the list gets i. */
  const joinList = (map, key, i) => {
    const list = map.get(key);
    if (!list) { map.set(key, [i]); return; }
    if (!list.some(j => union(j, i))) list.push(i);
  };
  const sharedTid = members => { const t = TID(members[0]); return t && members.every(m => TID(m) === t) ? t : null; };
  // Merge: the same member shape and parent shape, and parents with a common ancestor within 3 levels (Zepto's cards
  // in 3+6+6+6 row containers); or the same testid. Never across a text between the sets (a section label).
  // Shallow parents first: an outer bucket (the cards) merges before the buckets inside its members can.
  const order = cand.map((_, i) => i).sort((a, b) => DEP[cand[a].pix] - DEP[cand[b].pix] || cand[a].pix - cand[b].pix);
  const seenShape = new Map(), seenTid = new Map();
  for (const i of order) {
    const b = cand[i];
    b.tid = sharedTid(b.members);
    const ps = shape(b.pix);
    for (let x = PAR[b.pix], d = 0; x >= 0 && d < 3; x = PAR[x], d++) joinList(seenShape, b.shape + '|' + ps + '|' + x, i);
    if (b.tid) joinList(seenTid, b.tid, i);
  }
  let groups = [];
  for (let i = 0; i < cand.length; i++) {
    if (find(i) !== i) continue;
    const members = setMembers[i];
    if (members.length < L.minRecords) continue;
    const slots = members.map(m => OE[m] - OS[m]).sort((a, b) => a - b);
    groups.push({members, median: slots[slots.length >> 1], drop: false});
  }
  // Slot keys: the path from the record root to the slot element, one base shape per level; '.' is the root.
  const keyOf = (s, r) => { if (s === r) return '.'; const parts = []; for (let x = s; x >= 0 && x !== r; x = PAR[x]) parts.push(baseShape(x)); return parts.reverse().join('>'); };
  const keysMemo = new Map();
  const keysOf = r => {
    let ks = keysMemo.get(r);
    if (ks) return ks;
    const seen = new Map();
    ks = new Set();
    for (let o = OS[r]; o < OE[r] && ks.size < L.slots; o++) { const k = keyOf(own[o].ix, r), n = (seen.get(k) || 0) + 1; seen.set(k, n); ks.add(n > 1 ? k + '@' + n : k); }
    keysMemo.set(r, ks);
    return ks;
  };
  const jaccard = (a, b) => { let i = 0; for (const k of a) if (b.has(k)) i++; const u = a.size + b.size - i; return u ? i / u : 1; };
  // One template: the keys that at least half of the records have (the first 60) must be at least half of the keys of
  // the median record. A few same-shape page sections (header, main, footer) share no template: not a group.
  groups = groups.filter(g => {
    const sample = g.members.slice(0, 60), freq = new Map();
    for (const r of sample) for (const k of keysOf(r)) freq.set(k, (freq.get(k) || 0) + 1);
    const shares = sample.map(r => { const ks = keysOf(r); let n = 0; for (const k of ks) if (freq.get(k) * 2 >= sample.length) n++; return ks.size ? n / ks.size : 0; }).sort((a, b) => a - b);
    return shares[shares.length >> 1] >= 0.5;
  });
  // Nesting: every record of B lies inside records of A (the hosts). A only wraps B when B covers at least 80% of the
  // hosts' slots and the B records of one host are alike (Zepto's row wrappers): drop A. B is a part of A's template
  // when it sits in at least half of A's records (tags inside a Blinkit card): drop B. Else both stay (a page layout
  // of a few same-shape sections that holds the cards in one of them).
  for (const A of groups) for (const B of groups) {
    if (A === B || holder(A.members, B.members[0]) < 0) continue;
    const hosts = new Map();
    let all = true;
    for (const b of B.members) { const a = holder(A.members, b); if (a < 0) { all = false; break; } const l = hosts.get(a); if (l) l.push(b); else hosts.set(a, [b]); }
    if (!all) continue;
    let slotsB = 0, slotsA = 0, most = 0;
    for (const b of B.members) slotsB += OE[b] - OS[b];
    for (const [a, l] of hosts) { slotsA += OE[a] - OS[a]; if (l.length > most) most = l.length; }
    let alike = true;
    if (most > 1) {
      let sum = 0, pairs = 0;
      for (const l of hosts.values()) {
        if (l.length < 2 || pairs >= 20) continue;
        for (let i = 1; i < l.length && i < 6; i++) { sum += jaccard(keysOf(l[0]), keysOf(l[i])); pairs++; }
      }
      alike = !pairs || sum / pairs >= 0.5;
    }
    if (slotsA && slotsB / slotsA >= 0.8 && alike) A.drop = true;
    else if (hosts.size * 2 >= A.members.length) B.drop = true;
  }
  groups = groups.filter(g => !g.drop);
  const groupsSeen = groups.length;
  groups.sort((a, b) => b.members.length * b.median - a.members.length * a.median || a.members[0] - b.members[0]);
  if (groups.length > L.groups) { groups = groups.slice(0, L.groups); cut = true; }
  groups.sort((a, b) => a.members[0] - b.members[0]);
  const facts = (s, r) => {
    const f = {};
    for (let x = s; x >= 0; x = PAR[x]) {
      const e = ELS[x], ln = e.localName, rl = e.getAttribute('role');
      if (LT[x] || ln === 's' || ln === 'del' || ln === 'strike') f.struck = true;
      if (x !== r && (ln === 'button' || rl === 'button')) f.button = true;
      if (e.getAttribute('aria-disabled') === 'true' || (typeof e.matches === 'function' && e.matches(':disabled'))) f.disabled = true;
      if (LV[x]) f.heading = true;
      if (!f.href && ln === 'a') { const h = absHref(e); if (h) f.href = h; }
      if (x === r) break;
    }
    return f;
  };
  const recordHref = r => {
    const e = ELS[r];
    if (e.localName === 'a') { const h = absHref(e); if (h) return h; }
    const up = e.parentElement && e.parentElement.closest('a[href]');
    if (up) { const h = absHref(up); if (h) return h; }
    let one = null;
    for (const a of e.querySelectorAll('a[href]')) { const h = absHref(a); if (!h) continue; if (one && one !== h) return null; one = h; }
    return one;
  };
  const recordId = new Map();
  const groupOut = groups.map((g, gi) => {
    const id = 'g' + (gi + 1);
    for (const m of g.members) recordId.set(m, id);
    const take = g.members.slice(0, L.rows);
    if (take.length < g.members.length) cut = true;
    const info = new Map(), records = [];
    for (const r of take) {
      const slots = [], seen = new Map();
      for (let o = OS[r]; o < OE[r]; o++) {
        if (slots.length >= L.slots) { cut = true; break; }
        const s = own[o];
        let key = keyOf(s.ix, r);
        const n = (seen.get(key) || 0) + 1;
        seen.set(key, n);
        if (n > 1) key += '@' + n;
        const f = facts(s.ix, r);
        const slot = {key, text: clip(squash(s.text), L.cellChars)};
        if (f.struck) slot.struck = true;
        if (s.btn || f.button) slot.button = true;
        if (f.disabled) slot.disabled = true;
        if (f.heading) slot.heading = true;
        if (f.href) slot.href = f.href;
        if (s.alt) slot.alt = clip(s.alt, L.cellChars);
        slots.push(slot);
        let i = info.get(key);
        if (!i) { i = {key, filled: 0, samples: [], struck: 0, button: 0, heading: 0}; info.set(key, i); }
        i.filled++;
        const sample = (slot.text || slot.alt || '').slice(0, 60);
        if (sample && i.samples.length < 3 && i.samples.indexOf(sample) < 0) i.samples.push(sample);
        if (slot.struck) i.struck++;
        if (slot.button) i.button++;
        if (slot.heading) i.heading++;
      }
      const rec = {slots};
      const h = recordHref(r);
      if (h) rec.href = h;
      records.push(rec);
    }
    const first = g.members[0], tid = sharedTid(g.members);
    const slotInfo = Array.from(info.values());
    const shapeKey = shape(first), parent = PAR[first] >= 0 ? shape(PAR[first]) : '';
    return {id, shape: shapeKey, testid: tid, heading: headText(HB[first]), count: g.members.length, records, slots: slotInfo,
      truncated: take.length < g.members.length,
      signature: {kind: 'records', shape: shapeKey, parent, testid: tid,
        slot_keys: slotInfo.filter(i => i.filled * 2 >= records.length).map(i => i.key).sort()}};
  });

  // ---- Visible text blocks in reading order. Adjacent pieces of one block join; 'in' names the table or group.
  const inOf = ix => { for (let x = ix; x >= 0; x = PAR[x]) { const t = tableId.get(x); if (t) return t; const g = recordId.get(x); if (g) return g; } return null; };
  const text = [];
  if (cfg.text) {
    let total = 0;
    for (let i = 0; i < pieces.length;) {
      const blk = pieces[i].blk;
      let raw = '', first = -1;
      for (; i < pieces.length && pieces[i].blk === blk; i++) { raw += pieces[i].t; if (first < 0 && !pieces[i].ws) first = i; }
      if (first < 0) continue;
      let t = squash(raw);
      if (!t) continue;
      if (text.length >= L.textBlocks || total >= L.textChars) { cut = true; break; }
      t = clip(t, Math.min(L.blockChars, L.textChars - total));
      total += t.length;
      const b = {text: t, tag: blk >= 0 ? ELS[blk].localName : 'body'};
      if (pieces[first].hl) b.level = pieces[first].hl;
      const where = inOf(pieces[first].ix);
      if (where) b.in = where;
      text.push(b);
    }
  }

  // ---- Meta: headings h1-h3 and form values. Never a password, hidden, or file input, nor a credential field. A text
  // input that is private (an OTP, a PIN, a card, a CVV, an account number) or a short digit box is left out too.
  const headings = [];
  for (const h of headIx) {
    if (LV[h] > 3) continue;
    if (headings.length >= L.headings) { cut = true; break; }
    headings.push(headText(h));
  }
  const labelOf = e => {
    let s = (e.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => { const x = byId(e, id); return x ? labelText(x) : ''; }).join(' ');
    if (!squash(s)) s = e.getAttribute('aria-label') || '';
    if (!squash(s) && e.labels) s = Array.from(e.labels).map(labelText).join(' ');
    return clip(squash(s), L.cellChars);
  };
  const selected = [];
  for (const ix of formIx) {
    const e = ELS[ix], ln = e.localName;
    let kind, value, shown;
    if (ln === 'select') {
      const opts = Array.from(e.selectedOptions || []);
      if (!opts.length) continue;
      kind = 'select';
      value = opts.map(o => o.value).join(', ');
      shown = opts.map(o => squash(o.label || o.textContent)).join(', ');
    } else {
      const ty = e.type;
      if (ty === 'radio' || ty === 'checkbox') { if (!e.checked) continue; kind = ty; value = e.value; shown = null; }
      else if (ty === 'text' || ty === 'search') { if (!squash(e.value)) continue; kind = 'input'; value = e.value; shown = e.value; }
      else continue;
    }
    const name = e.getAttribute('name') || e.id || '';
    const label = labelOf(e);
    if (CRED.test(name) || CRED.test(e.id || '') || CRED.test(label) || SECRET_AC.test(e.getAttribute('autocomplete') || '')) continue;
    if (kind === 'input') {
      // A typed value: an OTP, a PIN, a card, or an account number stays out, by any of the names of its field. A short
      // digit box (an OTP or PIN box) stays out too.
      const words = [label, e.getAttribute('placeholder') || '', e.getAttribute('title') || ''];
      if (words.some(w => CRED.test(w) || PRIVATE_WORDS.test(w)) || PRIVATE_NAME.test(e.getAttribute('name') || '') || PRIVATE_NAME.test(e.id || '')) continue;
      const digits = (e.getAttribute('inputmode') || '') === 'numeric' || /^\[?(?:\\d|0-9)/.test(e.getAttribute('pattern') || '');
      if (digits && e.maxLength > 0 && e.maxLength <= 8) continue;
    }
    if (selected.length >= L.formValues) { cut = true; break; }
    selected.push({kind, name: clip(name, L.cellChars), label, value: clip(String(value), L.cellChars), text: clip(squash(shown === null ? (label || value) : shown), L.cellChars)});
  }

  const se = document.scrollingElement || document.documentElement;
  return {version: 1, url: location.href, title: document.title, meta: {headings, selected, lang: document.documentElement.lang || ''},
    tables: keptTables.map(a => a.out), groups: groupOut, text,
    stats: {tables_seen: accepted.length, groups_seen: groupsSeen, nodes, scroll_height: se ? se.scrollHeight : 0, viewport_height: innerHeight, truncated: cut}};
}`;

/**
 * The in-page reader. One Runtime.evaluate with returnByValue. Returns a PageRead without `stats.ms` (the page adapter
 * sets it), or null when the document has no body yet.
 */
export function readScript(opts: ReadOptions = {}): string {
  const cfg = { limits: readLimits(opts), text: opts.text !== false, cred: CREDENTIAL_NAME.source, flags: CREDENTIAL_NAME.flags };
  return `(${READ_FN})(${JSON.stringify(cfg)})`;
}

/**
 * The scroll state for Page.wheel and the loader: scroll position, scroll height (the scrolling element, so a quirks-mode
 * page counts its body), viewport, width for the wheel point, and the element count.
 */
export const SCROLL_STATE_SCRIPT = "(() => { const se = document.scrollingElement || document.documentElement; return { y: Math.round(scrollY), height: se ? se.scrollHeight : 0, viewport: innerHeight, width: innerWidth, nodes: document.getElementsByTagName('*').length }; })()";

/** The load rule of a scraper file (LoadRule in src/scrape/spec.ts) as the loader reads it. */
export interface LoadOptions {
  /** Wheel scrolls at most. 0 = no scroll. */
  maxScrolls: number;
  /** Rounds at the bottom with no growth before the page counts as loaded. */
  stableRounds: number;
  /** Wait after each scroll, in ms. */
  pauseMs: number;
  /** The whole load, in ms. */
  maxMs: number;
}

export interface LoadReport {
  scrolls: number;
  ms: number;
  /** The page stopped growing before a cap. */
  stable: boolean;
  /** Scroll height and element count at the end. */
  height: number;
  nodes: number;
  /** The cap that ended the load: "stable", "scrolls", "time", or "no_wheel" (the page has no Page.wheel). */
  end: "stable" | "scrolls" | "time" | "no_wheel";
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Scroll the page with Page.wheel until its scroll height and element count stay the same for `stableRounds` rounds at
 * the bottom, or a cap ends it. Code only: no Jev request, no click. Never throws for a page that does not grow.
 *
 * One round: a wheel of 0.9 viewport, the pause, then `wheel(0)`, which reads the state with no input in the page
 * adapter. A round at the bottom (y + viewport >= height - 2) with the same height and element count as the round
 * before adds one stable round; any other round sets it back to 0. A StalePage (the document is navigating) counts as a
 * round with growth. Known limit: a virtualized list (rows leave the DOM) loses rows.
 */
export async function loadAll(page: Page, opts: LoadOptions, sleep: (ms: number) => Promise<void> = realSleep): Promise<LoadReport> {
  const start = Date.now();
  const wheel = page.wheel?.bind(page);
  if (!wheel) return { scrolls: 0, ms: 0, stable: false, height: 0, nodes: 0, end: "no_wheel" };
  /** The state, or null when the document is navigating. */
  const state = async (dy: number): Promise<ScrollState | null> => {
    try {
      return await wheel(dy);
    } catch (e) {
      if (e instanceof StalePage) return null;
      throw e;
    }
  };
  let last = await state(0);
  let scrolls = 0;
  let stable = 0;
  const done = (end: LoadReport["end"]): LoadReport => ({ scrolls, ms: Date.now() - start, stable: end === "stable", height: last?.height ?? 0, nodes: last?.nodes ?? 0, end });
  for (;;) {
    if (stable >= Math.max(1, opts.stableRounds)) return done("stable");
    if (scrolls >= opts.maxScrolls) return done("scrolls");
    const left = opts.maxMs - (Date.now() - start);
    if (left <= 0) return done("time");
    await state(Math.max(100, Math.round(0.9 * (last?.viewport ?? 800))));
    scrolls += 1;
    await sleep(Math.max(0, Math.min(opts.pauseMs, left)));
    const now = await state(0);
    const grew = now === null || last === null || now.height !== last.height || (now.nodes ?? 0) !== (last.nodes ?? 0);
    const bottom = now !== null && now.y + now.viewport >= now.height - 2;
    stable = bottom && !grew ? stable + 1 : 0;
    if (now !== null) last = now;
  }
}
