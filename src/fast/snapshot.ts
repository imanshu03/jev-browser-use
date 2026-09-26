// In-page scripts of the fast engine. Strings only. The page runs them through Runtime.evaluate.
//
// Ported from browser-use/jev-ultrafast (jev_ultrafast/snapshot.js and jev_ultrafast/browser.py).
// MIT License. Copyright (c) 2026 Browser Use.
// Changes: the snapshot object also returns `readyState`, the document id `doc`, `filled`, and `texts`, the scroll
// and wait pseudo-actions carry `node:null` so every action has the same shape, and each action carries
// the field facts `form`, `multiline`, `inputType`, `autocomplete`, and `maxLength`. Code uses these
// facts to decide where assistant-written text may go; they never reach Jev. Forms get ids from their own
// counter, so element node ids stay the same as in the reference. The focus also carries its `form` and the
// name of the form's default button, `submitDefault`, and `multiline`, for the Enter-to-click rule, and
// `enterOption`, the option that Enter picks. The snapshot also returns `busy`. The settle after a fill, a key, or a
// click follows the timers that the input started (`causalArmScript`); the page layer counts the requests over CDP. A
// single-line text input also carries its chip facts, `token` (see TokenFacts in model.ts); they never reach Jev either.
// An editor carries its mention chips, `mentions`, and the facts `bareText` and `otherAtoms`. Each action and the focus
// carry `popup`, the popups around them.
import { COMPOSER_SEND_WORDS, LIMITS } from "../types.js";
import type { Action } from "./model.js";

/** Options of a suggestion popup. */
const OPTION = '[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="treeitem"],[role="gridcell"]';
/** Suggestion popups: ARIA popups and cmdk lists. */
const POPUP = '[role="listbox"],[role="menu"],[role="grid"],[role="tree"],[cmdk-list]';
/** Marks of the highlighted option: cmdk, Radix, Ariakit, Headless UI, React Aria. */
const MARKED = '[data-selected="true"],[data-highlighted]:not([data-highlighted="false"]),[data-active-item],[data-focus]:not([data-focus="false"]),[data-focused="true"],[data-active="true"]';
/** Markers of work in progress. Class names are left out: many pages keep a "loading" or "spinner" class. */
const BUSY = '[aria-busy="true"],[role="progressbar"]:not([aria-valuenow])';
/** In-page source: the option texts of a popup, the signature that shows a change of its options. */
const POPUP_SIG = `p=>[...p.querySelectorAll(${JSON.stringify(OPTION)})].map(o=>o.textContent).join('\\n').slice(0,4000)`;
/** Popups next to a chip field: the suggestion popups, dialogs (a popover of search results), and Radix popper wrappers. */
const NEAR_POPUP = `${POPUP},[role="dialog"],[data-radix-popper-content-wrapper]`;
/** The names of a send or submit control, which ends the box of a chip field: COMPOSER_SEND_WORDS and "submit". */
const BOX_SEND = String.raw`\b(?:${[...COMPOSER_SEND_WORDS, "submit"].join("|")})\b`;
/** The popups around an element (`Action.popup`): NEAR_POPUP, alert dialogs, and <dialog>. */
const POPUP_CHAIN = `${NEAR_POPUP},[role="alertdialog"],dialog`;
/** Mention chips in an editor: TipTap, CKEditor, quill-mention, Slack, and the MentionInput of the platform. */
const MENTION_SELECTOR = '[data-mention],[data-mention-id],[data-mention-display],[data-type="mention"],.mention,ts-mention';
/** Atomic inline elements of an editor: mention chips, and void or decorator nodes (images, embeds, variables). */
const ATOM_SELECTOR = `${MENTION_SELECTOR},[contenteditable="false"],[data-slate-void],[data-lexical-decorator]`;

/**
 * Read visible content and controls in one evaluation. Node identity lives in `window.__jevFast`:
 * a WeakMap gives each element a code-owned id, a Map keeps the live reference for execution.
 * Returns null when the document has no body yet.
 */
export const SNAPSHOT_SCRIPT: string = String.raw`(() => {
  if (!document.body) return null;
  const OPTION=${JSON.stringify(OPTION)}, POPUP=${JSON.stringify(POPUP)}, MARKED=${JSON.stringify(MARKED)}, BUSY=${JSON.stringify(BUSY)};
  const cache = window.__jevFast ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  // Form ids have their own counter. Code only compares them, and element node ids do not change.
  const forms = cache.forms ||= {ids:new WeakMap(), next:1};
  const formId = f => {
    if (!forms.ids.has(f)) forms.ids.set(f,forms.next++);
    return forms.ids.get(f);
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    // A textbox never takes its name from its content: its text is its value. Only an input button is named by its value
    // (a Radix checkbox is a <button value="on">).
    const field=seen.size===1 && ['textbox','searchbox'].includes(role(e));
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (e.tagName==='INPUT' && ['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' || field ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('aria-placeholder') || e.getAttribute('placeholder') || e.getAttribute('data-placeholder') || e.querySelector('[data-placeholder]')?.getAttribute('data-placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  // The popups around an element, innermost first. Ids come from the form counter, so a dialog has the same id as the
  // form of the controls in it.
  const CHAIN=${JSON.stringify(POPUP_CHAIN)}, MENTION=${JSON.stringify(MENTION_SELECTOR)}, ATOM=${JSON.stringify(ATOM_SELECTOR)};
  const popupChain = e => {
    const out=[];
    for (let p=e.closest(CHAIN);p;p=p.parentElement?.closest(CHAIN)) out.push(formId(p));
    return out;
  };
  // The top-level atoms of an editor. A mention chip has a mention attribute, class, or tag, or text that starts with
  // "@". Other atoms (images, embeds, variables) are only counted. The bare text is the text outside every atom.
  const atomsOf = e => {
    if (!e.isContentEditable) return null;
    const top=[...e.querySelectorAll(ATOM)].filter(a=>{const p=a.parentElement?.closest(ATOM);return !p || !e.contains(p) || p===e;});
    if (!top.length) return null;
    const chip=a=>a.matches(MENTION) || Boolean(a.querySelector(MENTION)) || /^@\S/.test((a.textContent||'').trim());
    const label=a=>{const m=a.matches(MENTION) ? a : a.querySelector(MENTION) || a;
      return (m.getAttribute('data-mention-display')||m.getAttribute('data-label')||m.getAttribute('data-value')||m.textContent||'')
        .replace(/\s+/g,' ').trim().replace(/^@/,'').trim().slice(0,80);};
    const mentions=top.filter(chip).map(label).filter(Boolean);
    let bare='', n;
    const walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);
    while ((n=walker.nextNode())) if (!top.some(a=>a.contains(n))) bare+=n.textContent;
    return {mentions,bareText:bare.replace(/\s+/g,' ').trim(),otherAtoms:top.filter(a=>!chip(a)).length};
  };
  cache.focus=()=>{
    const e=document.activeElement;
    if (!e || e===document.body || e===document.documentElement) return null;
    const form=e.form || e.closest('form');
    // form.elements leaves out image buttons, so take the submit controls of the form in tree order.
    const controls=form ? [...document.querySelectorAll('button,input')].filter(b=>b.form===form && ['submit','image'].includes(b.type)) : [];
    const submits=controls.filter(b=>!b.matches(':disabled'));
    const editable=safe(e) && (e.isContentEditable || ['TEXTAREA','INPUT'].includes(e.tagName) && ['textbox','searchbox','spinbutton','combobox'].includes(role(e)));
    const owner=e.form || e.closest('form,[role="form"],dialog,[role="dialog"]');
    const pick=editable ? cache.pick(e) : null, atoms=editable ? atomsOf(e) : null, popup=popupChain(e);
    return {node:identity(e),label:name(e),role:role(e),submitLabel:submits.map(b=>name(b)).join(' | '),
      editable,value:editable ? ('value' in e ? String(e.value) : e.innerText) : '',
      form:owner ? formId(owner) : null,submitDefault:controls[0] && !controls[0].matches(':disabled') ? name(controls[0]) : '',
      multiline:e.tagName==='TEXTAREA' || e.isContentEditable || e.getAttribute('aria-multiline')==='true',
      ...(pick?.option ? {enterOption:{node:identity(pick.option),label:name(pick.option)}} : {}),
      ...(atoms?.mentions.length ? {mentions:atoms.mentions} : {}),...(popup.length ? {popup} : {})};
  };
  // The option that Enter in the focused field picks, and the popups that Enter acts on. In this order: the active
  // descendant of the field or its combobox; the highlighted option of a popup that the field controls; the highlighted
  // option of a popup whose options changed in the settle after the last fill into the field. The last one finds a
  // portaled or detached list (cmdk, mention menus) that no ARIA link names. There a bare aria-selected counts only on
  // a cmdk item: in other lists it can mark the chosen row, not the highlight.
  cache.pick=e=>{
    const byId=id=>id ? document.getElementById(id) : null;
    const usable=o=>o.matches(OPTION) && visible(o) && o.getAttribute('aria-disabled')!=='true';
    const hosts=[e,e.closest('[role="combobox"]')].filter(Boolean);
    for (const h of hosts) {
      const o=byId(h.getAttribute('aria-activedescendant'));
      if (o && usable(o)) return {option:o,pops:[o.closest(POPUP)||o]};
    }
    const ids=hosts.flatMap(h=>[h.getAttribute('aria-controls'),h.getAttribute('aria-owns')].join(' ').split(/\s+/)).filter(Boolean);
    let pops=ids.map(byId).filter(p=>p && visible(p)).map(p=>p.matches(POPUP) ? p : p.querySelector(POPUP)).filter(Boolean);
    let loose='[aria-selected="true"]';
    if (!pops.length) {
      const c=window.__jevCausal;
      pops=c?.field && (c.field===e || c.field.contains(e)) ? (c.changed||[]).filter(p=>p.isConnected && visible(p)) : [];
      loose='[cmdk-item][aria-selected="true"]';
    }
    if (!pops.length) return null;
    for (const p of pops) {
      const o=[...p.querySelectorAll(MARKED)].find(usable) || [...p.querySelectorAll(loose)].find(usable);
      if (o) return {option:o,pops};
    }
    return {option:null,pops};
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select,[contenteditable]')].filter(safe)
      .map(e=>[identity(e),e.isContentEditable ? e.innerText : e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly]),
    (cache.scrollers||[]).map(e=>[identity(e),e.scrollTop,e.scrollHeight,e.clientHeight,e.isConnected])];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.isContentEditable ? e.innerText : e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };
  // Enter acts on the suggestion popup of the focused field too: an Enter decided on an old popup is stale.
  cache.keyGuard=()=>{
    const f=cache.focus(), e=document.activeElement, pick=f?.editable ? cache.pick(e) : null;
    return [cache.pageKey(),f,f ? cache.guard(e) : null,pick ? pick.pops.map(p=>(p.innerText||'').slice(0,4000)) : null];
  };
  // Chip (token) fields. See TokenFacts in model.ts. Items have their own id counter, so element node ids do not change.
  const items = cache.items ||= {ids:new WeakMap(), next:1};
  const itemId = e => {
    if (!items.ids.has(e)) items.ids.set(e,items.next++);
    return items.ids.get(e);
  };
  const OTHER_FIELD='input:not([type="hidden"]),textarea,select,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],'+
    '[role="textbox"],[role="combobox"],[role="searchbox"],[role="spinbutton"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"]';
  const REMOVE=/^(?:remove|delete|clear|deselect|unselect|dismiss)\b|^[x×✕✖⨯]$/i, SEND=new RegExp(${JSON.stringify(BOX_SEND)},'i');
  const NEAR=${JSON.stringify(NEAR_POPUP)};
  // The own box of a single-line text input: the highest ancestor, up to 3 levels up, that holds no other field and no
  // send or submit control. It does not go past a table cell or row. Null for other fields, and when the parent already
  // holds another field or such a control.
  cache.tokenBox=e=>{
    if (e?.tagName!=='INPUT' || !['text','email','search','url','tel'].includes(e.type) || e.getAttribute('aria-multiline')==='true') return null;
    let box=null;
    for (let a=e.parentElement,d=0; a && d<3 && a!==document.body; a=a.parentElement,d++) {
      if ([...a.querySelectorAll(OTHER_FIELD)].some(x=>x!==e && !x.contains(e)) ||
        [...a.querySelectorAll('button,input[type="submit"],input[type="image"],[role="button"]')]
          .some(b=>b.form && ['submit','image'].includes(b.type) || SEND.test(name(b)))) break;
      box=a;
      if (a.matches('td,th,tr,[role="cell"],[role="gridcell"],[role="row"]')) break;
    }
    return box;
  };
  // 2: a remove name; 1: an icon-only button; 0: another control.
  const removeKind=b=>{
    const n=(b.getAttribute('aria-label')||b.getAttribute('title')||b.textContent||'').trim();
    return REMOVE.test(n) ? 2 : n==='' && b.querySelector('svg,img') ? 1 : 0;
  };
  const ITEM_ATTR=/^(?:title|aria-label|data-[\w-]*(?:value|mail|name|label|title|text|user|tag)[\w-]*)$/i;
  // Text nodes, not innerText: CSS text-transform changes innerText. The text of a remove control is left out. An item
  // with more than 40 elements is not a chip (a message list before a chat input): it gets its cut text only.
  const tokenItem=(x,field)=>{
    if (x.getElementsByTagName('*').length>40) return [itemId(x),(x.textContent||'').slice(0,400).replace(/\s+/g,' ').trim().slice(0,200),0];
    const controls=[x,...x.querySelectorAll('button,[role="button"]')].filter(b=>b.matches('button,[role="button"]'));
    const kinds=controls.map(removeKind), removers=controls.filter((b,i)=>kinds[i]>0);
    const words=[], walker=document.createTreeWalker(x,NodeFilter.SHOW_TEXT); let n;
    while ((n=walker.nextNode())) { const t=n.textContent.trim(); if (t && !removers.some(b=>b.contains(n))) words.push(t); }
    const own=words.join(' ').replace(/\s+/g,' ').trim(), attrs=[];
    for (const y of [x,...x.querySelectorAll('*')].slice(0,40))
      for (const at of y.attributes) if (ITEM_ATTR.test(at.name) && at.value.trim()) attrs.push(at.value.trim());
    let kind=Math.max(0,...kinds);
    if (x.matches('[data-tag-index]') || x.querySelector('[data-tag-index]')) kind=2;
    if (x.matches('label,legend') || x.querySelector('label,legend') || own.toLowerCase()===field.toLowerCase()) kind=0;
    return [itemId(x),[own,...attrs].join(' ').replace(/\s+/g,' ').slice(0,200),kind];
  };
  // The open popups next to a field: the elements it controls; and, only while it has focus, a listbox, menu, or dialog
  // at its box (48 px up or down) and a positioned element with text after the field in its box (an inline suggestion
  // list). A popup found by its place belongs to the focused field: a list under one field also lies next to the field
  // below it. A popup in its closing state (data-state="closed" during the exit animation) is not open.
  cache.popupsOf=(e,box,all)=>{
    const out=[];
    const add=p=>{
      if (p?.isConnected && !p.contains(e) && visible(p) && !p.closest('[data-state="closed"]') && !p.querySelector(':scope > [data-state="closed"]') &&
        !out.some(o=>o.contains(p)||p.contains(o))) out.push(p);
    };
    for (const x of [e,e.closest('[role="combobox"]')])
      for (const id of ((x?.getAttribute('aria-controls')||'')+' '+(x?.getAttribute('aria-owns')||'')).split(/\s+/)) if (id) add(document.getElementById(id));
    if (document.activeElement!==e) return out;
    const r=(box||e).getBoundingClientRect();
    for (const p of all||document.querySelectorAll(NEAR)) {
      const q=p.getBoundingClientRect();
      if (q.width>0 && q.height>0 && q.left<r.right && q.right>r.left && q.top<r.bottom+48 && q.bottom>r.top-48) add(p);
    }
    if (box) for (const p of box.querySelectorAll('*'))
      if (e.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING && !p.matches('button,a,input,[role="button"]') &&
        ['absolute','fixed'].includes(getComputedStyle(p).position) && p.innerText?.trim()) add(p);
    return out;
  };
  const tokenFacts=(e,popups)=>{
    const box=cache.tokenBox(e);
    if (!box) return null;
    const field=name(e), levels=[];
    for (let c=e; c!==box; c=c.parentElement) {
      const before=[];
      for (let s=c.parentElement.firstElementChild; s && s!==c; s=s.nextElementSibling) before.push(s);
      levels.unshift(before);
    }
    const found=levels.flat().filter(x=>!x.matches('script,style,template') && visible(x))
      .map(x=>tokenItem(x,field)).filter(([,t,k])=>t || k).slice(-20);
    const combo=e.getAttribute('role')==='combobox' || e.hasAttribute('aria-haspopup');
    const chips=found.filter(([,t,k])=>t && (k===2 || k===1 && combo)).map(([,t])=>t);
    const owner=e.closest('[role="combobox"]');
    const lists=[e,owner].flatMap(x=>((x?.getAttribute('aria-controls')||'')+' '+(x?.getAttribute('aria-owns')||'')).split(/\s+/))
      .filter(Boolean).map(id=>document.getElementById(id)).filter(Boolean);
    const multi=Boolean(owner) && lists.some(l=>l.matches('[role="listbox"][aria-multiselectable="true"]') || l.querySelector('[role="listbox"][aria-multiselectable="true"]'));
    const popup=cache.popupsOf(e,box,popups).length>0 || e.getAttribute('aria-expanded')==='true';
    return {items:found,chips,...(multi?{multi:true}:{}),...(popup?{popup:true}:{})};
  };
  const clippedRect=e=>{
    const r=e.getBoundingClientRect();
    let left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);
    for (let p=e.parentElement;p;p=p.parentElement) {
      const style=getComputedStyle(p), box=p.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {top=Math.max(top,box.top);bottom=Math.min(bottom,box.bottom);}
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {left=Math.max(left,box.left);right=Math.min(right,box.right);}
    }
    return {x:left,y:top,w:Math.max(0,right-left),h:Math.max(0,bottom-top)};
  };
  cache.scrollers=[...document.querySelectorAll('body *')].filter(e=>
    visible(e) && e.scrollHeight>e.clientHeight+2 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
  const scrollAction=dir=>{
    const candidates=cache.scrollers.filter(e=>dir>0 ? e.scrollTop+e.clientHeight<e.scrollHeight-2 : e.scrollTop>0)
      .map(e=>({e,r:clippedRect(e)})).filter(({r})=>r.w>0 && r.h>0)
      .sort((a,b)=>Number(b.e.contains(document.activeElement))-Number(a.e.contains(document.activeElement)) || b.r.w*b.r.h-a.r.w*a.r.h);
    // Prefer the panel with focus, then the largest visible panel. Each action names its actual node.
    for (const {e,r} of candidates) {
      const points=[[.5,.5],[.25,.25],[.75,.75],[.25,.75],[.75,.25]];
      if (!points.some(([x,y])=>{const hit=document.elementFromPoint(r.x+r.w*x,r.y+r.h*y);return hit && e.contains(hit);})) continue;
      return {id:dir>0?'scroll_down':'scroll_up',kind:'scroll',node:identity(e),
        label:(dir>0?'Scroll down':'Scroll up')+' in '+(name(e).slice(0,100)||'panel'),delta:dir*560,
        value:String(e.scrollTop),rect:r};
    }
    return null;
  };
  const actions=[], popups=[...document.querySelectorAll(NEAR)].filter(visible);
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    // A control inside an option that takes no pointer events (the checkbox of a multi-select option) is part of the option.
    if (e.parentElement?.closest('[role="option"]') && getComputedStyle(e).pointerEvents==='none') continue;
    const r=e.getBoundingClientRect(), clip=clippedRect(e), x=clip.x+clip.w/2, y=clip.y+clip.h/2, rname=role(e);
    if (!rname || clip.w<=0 || clip.h<=0 || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const popup=popupChain(e);
    const base={node:identity(e),role:rname,label:name(e)||rname,
      rect:{x:r.x,y:r.y,w:r.width,h:r.height},
      form:(f=>f?formId(f):null)(e.form||e.closest('form,[role="form"],dialog,[role="dialog"]')),
      multiline:e.tagName==='TEXTAREA'||e.isContentEditable||e.getAttribute('aria-multiline')==='true',
      ...(e.tagName==='INPUT'?{inputType:String(e.type).toLowerCase()}:{}),
      ...(e.getAttribute('autocomplete')?{autocomplete:e.getAttribute('autocomplete').toLowerCase()}:{}),
      ...(e.maxLength>0?{maxLength:e.maxLength}:{}),
      ...(popup.length?{popup}:{})};
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (rname==='option' && base.checked===undefined) {
      // A multi-select option shows its state with a checkbox inside it; a Radix item with data-state.
      const box=e.querySelector('[role="checkbox"],input[type="checkbox"]');
      const state=box ? box.getAttribute('aria-checked') ?? (box.tagName==='INPUT' ? String(box.checked) : null) : null;
      if (state!==null) base.checked=state;
      else if (e.getAttribute('data-state')==='checked') base.checked='true';
    }
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      const token=editable ? tokenFacts(e,popups) : null, atoms=editable ? atomsOf(e) : null;
      actions.push({...base,kind:editable?'fill':'click',value,...(token?{token}:{}),
        ...(atoms?.mentions.length ? {mentions:atoms.mentions,bareText:atoms.bareText} : {}),
        ...(atoms?.otherAtoms ? {otherAtoms:atoms.otherAtoms} : {})});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  while ((node=walker.nextNode()) && length<6000) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect(), clip=clippedRect(parent);
    if (clip.w>0 && clip.h>0 && r.bottom>clip.y && r.top<clip.y+clip.h && r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  const omitted_actions=Math.max(0,actions.length-250);
  actions.splice(250);
  actions.forEach((a,i)=>a.id='e'+(i+1));
  const down=scrollAction(1),up=scrollAction(-1);
  if (down) actions.push(down);
  else if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',node:null,label:'Scroll down',delta:560});
  if (up) actions.push(up);
  else if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',node:null,label:'Scroll up',delta:-560});
  actions.push({id:'wait',kind:'wait',node:null,label:'Wait for the page to update'});
  const filled=page_key[6].filter(c=>typeof c[1]==='string' && c[1].trim()!=='');
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions,focus:cache.focus(),key_guard:cache.keyGuard(),
    readyState:document.readyState,doc:performance.timeOrigin,filled:filled.map(c=>c[0]),
    texts:filled.filter(c=>{const e=cache.nodes.get(c[0]);return e && visible(e);}).map(c=>[c[0],c[1]]),
    busy:[...document.querySelectorAll(BUSY)].some(visible)};
})()`;

/** The semantic marker of the whole page, or null when the document has no body. */
export const MARKER_SCRIPT: string = `(() => { const state=${SNAPSHOT_SCRIPT}; return state?.marker ?? null; })()`;

/**
 * Post-input settle without the causal tracker (a scroll, a select, or a document where the arm failed), and the two
 * frames around a causal settle. Resolves after two animation frames or 50 ms. A fill in an editable combobox waits
 * for visible options instead, up to 200 ms. `null` means a generic settle.
 */
export function settleScript(action: Action | null): string {
  const arg = JSON.stringify(action === null ? { kind: "key", node: null } : { kind: action.kind, node: action.node });
  return String.raw`(action => new Promise(resolve => {
  const field=action.node===null ? null : window.__jevFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false;
  const finish=()=>{stopped=true;resolve()};
  // The native timer: the causal tracker must not count the settle's own timer as work of the input.
  (window.__jevCausal?.native || setTimeout).call(window,finish,autocomplete ? 200 : 50);
  const ready=()=>{
    if (stopped) return;
    const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
      .split(/\s+/).filter(Boolean);
    const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
    const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
    if (++frames>=2 && (!autocomplete || options.some(e=>{
      const r=e.getBoundingClientRect();
      return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
        e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
    }))) finish();
    else requestAnimationFrame(ready);
  };
  requestAnimationFrame(ready);
}))(` + arg + `)`;
}

/**
 * Arm the causal settle right before a fill, a key, or a click. Installed once per document: proxies around setTimeout,
 * setInterval, and their clear functions. While armed, a new timer shorter than `causalTimerMaxMs` is work that the
 * input started when it is created during the input, in a tracked callback, or in the follow window (`causalFollowMs`)
 * after one. The follow window gets past the React scheduler, which runs the effect of a debounced state change in a message
 * task, not a timer. Poll chains stop: a timer more than `causalGenerations` deep does not count, nor a callback that
 * schedules itself again with no shorter delay (a debounce that waits again for its rest counts). An interval counts
 * until its first run. Requests are not wrapped: the page layer counts them over CDP, which the page cannot see.
 * `node` is the field of a fill. The script keeps the option texts of each popup, so the end can tell which popups the
 * fill changed. Returns true when armed.
 */
export function causalArmScript(node: number | null): string {
  const arg = JSON.stringify({ node, follow: LIMITS.causalFollowMs, max: LIMITS.causalTimerMaxMs, gens: LIMITS.causalGenerations });
  return String.raw`(o => {
  const W=window, POPUP=${JSON.stringify(POPUP)}, BUSY=${JSON.stringify(BUSY)}, sig=${POPUP_SIG};
  let s=W.__jevCausal;
  if (!s) {
    s=W.__jevCausal={armed:false,until:0,depth:0,cur:0,last:0,timers:new Map(),seen:new WeakMap(),busy:new WeakSet(),fill:null,field:null,changed:[],native:W.setTimeout};
    const tracking=()=>s.armed && (s.depth>0 || performance.now()<s.until);
    const wrap=native=>new Proxy(native,{apply(fn,self,args){
      const cb=args[0], delay=Number(args[1])||0;
      if (!tracking() || typeof cb!=='function' || delay>=s.max) return Reflect.apply(fn,self,args);
      const gen=(s.depth>0 ? s.cur : s.last)+1, prior=s.seen.get(cb);
      if (gen>s.gens || (prior!==undefined && delay>=prior)) return Reflect.apply(fn,self,args);
      s.seen.set(cb,delay);
      let id, first=true;
      const run=function(...rest){
        if (!first) return cb.apply(this,rest);
        first=false; s.timers.delete(id); s.depth++;
        const cur=s.cur; s.cur=gen;
        try { return cb.apply(this,rest); }
        finally { s.depth--; s.cur=cur; s.last=Math.max(s.last,gen); if (s.armed) s.until=Math.max(s.until,performance.now()+s.follow); }
      };
      id=Reflect.apply(fn,self,[run,...args.slice(1)]);
      s.timers.set(id,gen);
      return id;
    }});
    const clear=native=>new Proxy(native,{apply(fn,self,args){ s.timers.delete(args[0]); return Reflect.apply(fn,self,args); }});
    W.setTimeout=wrap(W.setTimeout); W.setInterval=wrap(W.setInterval);
    W.clearTimeout=clear(W.clearTimeout); W.clearInterval=clear(W.clearInterval);
  }
  s.follow=o.follow; s.max=o.max; s.gens=o.gens;
  s.timers.clear(); s.seen=new WeakMap(); s.cur=0; s.last=0;
  s.busy=new WeakSet(document.querySelectorAll(BUSY));
  const field=o.node===null ? null : W.__jevFast?.nodes.get(o.node);
  s.fill=field ? {field,before:new Map([...document.querySelectorAll(POPUP)].map(p=>[p,sig(p)]))} : null;
  s.armed=true; s.until=Infinity;
  return true;
})(` + arg + `)`;
}

/**
 * The state of an armed causal settle: `pending` tracked timers, the rest of the follow window in ms, and `busy` when an
 * aria-busy or indeterminate progressbar shows that was not there at the arm. `close` ends the input window (the
 * settle calls it after two frames). `extend` opens a follow window: a counted request ended, and its response handler
 * can start more work. Null when the document has no armed tracker (it navigated away).
 */
export function causalStateScript(close: boolean, extend: boolean): string {
  return `((close,extend) => {
  const s=window.__jevCausal;
  if (!s || !s.armed) return null;
  const now=performance.now();
  if (close) s.until=Math.min(s.until,now);
  if (extend) s.until=Math.max(s.until,now+s.follow);
  const busy=[...document.querySelectorAll(${JSON.stringify(BUSY)})].some(e=>!s.busy.has(e) && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
  return {pending:s.timers.size,follow:Math.max(0,Math.round(s.until-now)),busy};
})(${close},${extend})`;
}

/**
 * End the causal settle: new timers no longer count. After a fill, the popups whose options changed since the arm are
 * kept with the field, for `enterOption`.
 */
export const CAUSAL_END_SCRIPT: string = `(() => {
  const s=window.__jevCausal;
  if (!s) return null;
  s.armed=false; s.until=0; s.timers.clear();
  if (s.fill) {
    const f=s.fill, sig=${POPUP_SIG};
    s.fill=null; s.field=f.field;
    s.changed=[...document.querySelectorAll(${JSON.stringify(POPUP)})].filter(p=>{ const now=sig(p); return now!=='' && f.before.get(p)!==now; });
  }
  return true;
})()`;

/**
 * Resolve the target of a click, fill, or select right before input. Returns `{x, y}` at the
 * centre of the element, or null when the element is gone, disabled, hidden, read-only for a
 * fill, outside the viewport, or covered. A select sets its value here and fires input and change.
 */
/**
 * Resolve the click point of an observed node right before input.
 * Change from the reference: the reference hit-tests the centre only. Cards and rows often have
 * sibling content over their centre (a row wrapper with the text laid on top), so this script tries
 * the centre, a 3x3 grid, and four inset corners, and returns the first point that lands inside the
 * element. Null means every point is covered, out of view, hidden, or disabled.
 * A fill takes a point that is not on a mention chip or another atom of the editor: a click on a chip can open its
 * card. When every point is on an atom, a plain fill takes the first one, and a fill that keeps the chips
 * (`EditPlan.keepChips`) gets null.
 */
export function actScript(action: Action, keepChips = false): string {
  const arg = JSON.stringify({ kind: action.kind, node: action.node, value: action.value ?? null, delta: action.delta ?? 0, keepChips });
  return `(action => {
  const e=window.__jevFast?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  const r=e.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const inset=Math.min(4,r.width/4,r.height/4);
  const pts=[[0.5,0.5],[0.25,0.25],[0.75,0.25],[0.25,0.75],[0.75,0.75],[0.5,0.25],[0.5,0.75],[0.1,0.5],[0.9,0.5]]
    .map(([fx,fy])=>[r.x+r.width*fx,r.y+r.height*fy]);
  pts.push([r.x+inset,r.y+inset],[r.x+r.width-inset,r.y+inset],[r.x+inset,r.y+r.height-inset],[r.x+r.width-inset,r.y+r.height-inset]);
  const onAtom=h=>{const a=h.closest(${JSON.stringify(ATOM_SELECTOR)});return Boolean(a) && a!==e && e.contains(a);};
  let x=null,y=null,atom=null;
  for (const [px,py] of pts) {
    if (px<0 || py<0 || px>=innerWidth || py>=innerHeight) continue;
    const h=document.elementFromPoint(px,py);
    if (!h || !e.contains(h)) continue;
    if (action.kind==='fill' && onAtom(h)) { atom=atom || [px,py]; continue; }
    x=px; y=py; break;
  }
  if (x===null && atom && !action.keepChips) [x,y]=atom;
  if (x===null) return null;
  if (action.kind==='scroll') e.scrollBy({top:action.delta,behavior:'instant'});
  if (action.kind==='select') {
    if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
        !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value=action.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return {x,y};
})(${arg})`;
}

/**
 * Read the popup next to a chip field (`cache.popupsOf` of the last snapshot): open, its text, the texts of its
 * clickable options, and busy. With `focus`, focus the field first. Null when the node is gone.
 */
export function popupScript(action: Action, focus: boolean): string {
  const arg = JSON.stringify({ node: action.node, focus });
  return `(a => {
  const c=window.__jevFast, e=c?.nodes.get(a.node);
  if (!e?.isConnected || !c.popupsOf) return null;
  if (a.focus && document.activeElement!==e) e.focus();
  const shown=x=>x.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  const PICK='button,a[href],[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="treeitem"],[role="gridcell"],[role="button"]';
  const popups=c.popupsOf(e,c.tokenBox(e)), picks=[];
  for (const p of popups) for (const x of p.querySelectorAll(PICK)) {
    const outer=x.parentElement?.closest(PICK);
    if (picks.length>=20 || (outer && p.contains(outer)) || x.matches(':disabled') || x.closest('[aria-disabled="true"]') || !shown(x)) continue;
    const t=(x.getAttribute('aria-label')||x.textContent||'').replace(/\\s+/g,' ').trim().slice(0,200);
    if (t) picks.push(t);
  }
  const text=popups.map(p=>p.innerText||'').join('\\n').replace(/[ \\t]+/g,' ').trim().slice(0,2000);
  // An expanded field whose popup the script cannot find reads as busy: its options are unknown.
  const lost=e.getAttribute('aria-expanded')==='true' && popups.length===0;
  const busy=lost || e.getAttribute('aria-busy')==='true' || /\\b(?:loading|searching)\\b/i.test(text) ||
    popups.some(p=>p.matches('[aria-busy="true"]') || p.querySelector('[aria-busy="true"],[role="progressbar"],[class*="spin"]'));
  return {open:popups.length>0 || lost,text,picks,busy};
})(${arg})`;
}

/**
 * A script Enter on a focused chip field: keydown, then keypress when the keydown was not handled, then keyup. The
 * events are not trusted, so they have no default action: they never submit a form. Only the page's own key handler
 * can act on them. `prevented` is true when a handler called preventDefault.
 */
export function commitScript(action: Action): string {
  const arg = JSON.stringify({ node: action.node });
  return `(a => {
  const e=window.__jevFast?.nodes.get(a.node);
  if (!e?.isConnected) return {skipped:'gone'};
  if (document.activeElement!==e) return {skipped:'focus'};
  const key=type=>{
    const ev=new KeyboardEvent(type,{key:'Enter',code:'Enter',bubbles:true,cancelable:true,composed:true});
    for (const k of ['keyCode','which']) Object.defineProperty(ev,k,{get:()=>13});
    Object.defineProperty(ev,'charCode',{get:()=>type==='keypress' ? 13 : 0});
    return ev;
  };
  const down=key('keydown');
  e.dispatchEvent(down);
  let prevented=down.defaultPrevented;
  if (!prevented && e.isConnected) { const press=key('keypress'); e.dispatchEvent(press); prevented=press.defaultPrevented; }
  if (e.isConnected) e.dispatchEvent(key('keyup'));
  return {prevented};
})(${arg})`;
}

/** The page key and one node's guard, as `[pageKey, guard]`, or null when no cache exists. */
export function pageKeyGuardScript(node: number): string {
  return `(() => { const c=window.__jevFast; return c ? [c.pageKey(),c.guard(c.nodes.get(${Math.trunc(node)}))] : null; })()`;
}

/** The page key alone: document identity, URL, scroll, viewport, and safe form values. Null when no cache exists. */
export const PAGE_KEY_SCRIPT = "(() => { const c=window.__jevFast; return c ? c.pageKey() : null; })()";

/** The current document readiness. Used by the navigation poll. */
export const READY_STATE_SCRIPT = "document.readyState";

/** The identity of the current document. The same value is the first entry of the page key and the marker. */
export const DOC_ID_SCRIPT = "performance.timeOrigin";

/** The current location. */
export const LOCATION_SCRIPT = "location.href";

/** Keyboard input also checks focus and the form or dialog around the focused control. */
export const KEY_GUARD_SCRIPT = "(() => { const c=window.__jevFast; return c ? c.keyGuard() : null; })()";

/**
 * The wait between the steps of a fill: two animation frames and one task turn, at most 50 ms. An editor copies the
 * browser selection into its own model in that time (slate-react on `selectionchange`). The fill runs inside the armed
 * causal settle, so these timers are native: the tracker must not count them as work of the input.
 */
export const EDIT_SETTLE_SCRIPT = "new Promise(r => { const t = window.__jevCausal?.native || setTimeout; t.call(window, r, 50); requestAnimationFrame(() => requestAnimationFrame(() => t.call(window, r, 0))); })";

/** The names of a control that sends a message from a composer: COMPOSER_SEND_WORDS, as SEND_BUTTON in loop.ts. */
const SEND_CONTROL = String.raw`\b(?:${COMPOSER_SEND_WORDS.join("|")})\b`;

/** One step of a fill, read in the page. See `editScript`. */
export interface EditStep {
  ok: boolean;
  /** Why the step failed. "" when `ok`. */
  why: string;
  /** The field text: `innerText` of an editor, `value` of an input or textarea. */
  text: string;
  kind: "input" | "textarea" | "editable";
  /** The field holds no text (zero-width characters do not count). */
  blank: boolean;
  /** "read" only. */
  shape?: "input" | "textarea" | "composer" | "document";
  /** "check" only: the block of the caret has no text. */
  caretBlank?: boolean;
  /** "check" only: the text before the caret ends with white space. */
  spaceBefore?: boolean;
  /** "check" only: false for an input without a selection API (email, number). Code then checks focus only. */
  selectable?: boolean;
}

/**
 * One step of a fill, in the page. It never types. `step`:
 * - "read": the field text, its kind, and its shape (`FieldShape` in model.ts). Focus must be on the field or inside it.
 * - "check": focus is on the field or inside it, the field is visible, and the selection is where `mode` needs it: all
 *   of the text for replace, a caret with no text after it for append. An input without a selection API (email,
 *   number) checks focus only.
 * - "blank": after a new line, the caret is in an empty block inside the field, and the field still holds each line of
 *   `keep`.
 */
export function editScript(node: number, step: "read" | "check" | "blank", mode: "replace" | "append" = "replace", keep: string[] = []): string {
  const arg = JSON.stringify({ node: Math.trunc(node), step, mode, keep, send: SEND_CONTROL });
  return String.raw`(a => {
  const host=window.__jevFast?.nodes.get(a.node);
  if (!host?.isConnected) return {ok:false,why:'the field is gone',text:'',kind:'input',blank:true};
  // A role=textbox wrapper that is not editable itself: the text control inside it that the click focused is the field.
  const inner=document.activeElement;
  const e=!host.isContentEditable && !['INPUT','TEXTAREA'].includes(host.tagName) && inner && inner!==host && host.contains(inner) &&
    (['INPUT','TEXTAREA'].includes(inner.tagName) || inner.isContentEditable) ? inner : host;
  const norm=t=>String(t||'').replace(/[\u200B\uFEFF]/g,'').replace(/\s+/g,' ').trim();
  const kind=e.tagName==='TEXTAREA' ? 'textarea' : e.tagName==='INPUT' ? 'input' : 'editable';
  const text=kind==='editable' ? e.innerText : String(e.value??'');
  // The text of an editor inside a range, without the placeholder that Slate renders as text in an empty editor.
  const textIn=x=>{
    let t='';
    const w=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);
    for (let n=w.nextNode();n;n=w.nextNode()) {
      if (n.parentElement?.closest('[data-slate-placeholder]') || !x.intersectsNode(n)) continue;
      t+=n.data.slice(n===x.startContainer ? x.startOffset : 0,n===x.endContainer ? x.endOffset : n.data.length);
    }
    return t;
  };
  const range=(sc,so,ec,eo)=>{const x=document.createRange();x.setStart(sc,so);x.setEnd(ec,eo);return x;};
  const all=()=>{const x=document.createRange();x.selectNodeContents(e);return x;};
  const out=(ok,why,more)=>({ok,why:ok?'':why,text,kind,blank:norm(kind==='editable' ? textIn(all()) : text)==='',...more});
  const act=document.activeElement;
  const where=n=>!n || n===document.body || n===document.documentElement ? 'nothing' :
    (n.tagName.toLowerCase()+(n.id ? '#'+n.id : n.classList?.length ? '.'+n.classList[0] : '')+
      (n.getAttribute('aria-label') ? ' "'+n.getAttribute('aria-label').slice(0,40)+'"' : ''));
  if (!act || (act!==e && !e.contains(act))) return out(false,'focus is on '+where(act)+', not on the field');
  if (!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return out(false,'the field is hidden');
  const inline=x=>/^inline/.test(getComputedStyle(x).display);
  if (a.step==='read') {
    if (kind!=='editable') return out(true,'',{shape:kind});
    // A send-like control in the field's form or dialog, or else in the containers around the field that hold no other
    // text field (up to 6): a new line can send there.
    const send=new RegExp(a.send,'i');
    const name=b=>b.getAttribute('aria-label')||b.innerText||b.value||b.getAttribute('title')||'';
    const fields='textarea,[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"],input:not([type]),input[type="text"],input[type="search"],input[type="email"],input[type="url"],input[type="tel"],input[type="number"]';
    const scope=e.closest('form,[role="form"],dialog,[role="dialog"]');
    const roots=scope ? [scope] : [];
    for (let p=e.parentElement,i=0;p && !scope && i<6 && ![...p.querySelectorAll(fields)].some(f=>f!==e && !e.contains(f) && !f.contains(e));p=p.parentElement,i++) roots.push(p);
    const sends=roots.some(r=>[...r.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]')]
      .some(b=>!e.contains(b) && send.test(name(b))));
    // Blocks with text, below the wrappers that hold all of them (Draft.js puts one wrapper around the blocks).
    let box=e;
    while (box.children.length===1 && !inline(box.children[0]) && box.children[0].children.length>0) box=box.children[0];
    const blocks=[...box.children].filter(c=>!inline(c) && norm(c.innerText)!=='').length;
    const rich=e.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"],ul,ol,li,blockquote,pre,table');
    return out(true,'',{shape:!sends && (blocks>=2 || rich) ? 'document' : 'composer'});
  }
  if (kind!=='editable') {
    if (typeof e.selectionStart!=='number') return out(true,'',{selectable:false});
    const v=String(e.value), s0=e.selectionStart, s1=e.selectionEnd;
    const ok=a.mode==='replace' ? s0===0 && s1===v.length : s0===v.length && s1===v.length;
    return out(ok,'the selection is not where the '+a.mode+' needs it',{selectable:true,caretBlank:v.trim()==='',spaceBefore:/\s$/.test(v.slice(0,s0))});
  }
  const s=getSelection();
  if (!s || !s.rangeCount || !e.contains(s.anchorNode) || !e.contains(s.focusNode)) return out(false,'the selection is outside the field');
  const r=s.getRangeAt(0);
  const before=textIn(range(e,0,r.startContainer,r.startOffset)), after=textIn(range(r.endContainer,r.endOffset,e,e.childNodes.length));
  let block=r.endContainer.nodeType===3 ? r.endContainer.parentElement : r.endContainer;
  while (block && block!==e && inline(block)) block=block.parentElement;
  const within=(block && block!==e ? block : e), inBlock=document.createRange();
  inBlock.selectNodeContents(within);
  const caretBlank=norm(textIn(inBlock))==='';
  if (a.step==='blank') {
    const now=norm(e.innerText), lost=a.keep.find(l=>!now.includes(norm(l)));
    if (lost!==undefined) return out(false,'the field lost the line "'+norm(lost).slice(0,40)+'"');
    return out(s.isCollapsed && !!block && block!==e && caretBlank,'the caret is not in a new empty line inside the field');
  }
  const ok=a.mode==='replace' ? norm(before)==='' && norm(after)==='' : s.isCollapsed && norm(after)==='';
  return out(ok,'the selection is not where the '+a.mode+' needs it',{caretBlank,spaceBefore:/\s$/.test(before.replace(/[\u200B\uFEFF]/g,''))});
})(${arg})`;
}
