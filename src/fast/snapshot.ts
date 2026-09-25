// In-page scripts of the fast engine. Strings only. The page runs them through Runtime.evaluate.
//
// Ported from browser-use/jev-ultrafast (jev_ultrafast/snapshot.js and jev_ultrafast/browser.py).
// MIT License. Copyright (c) 2026 Browser Use.
// Changes: the snapshot object also returns `readyState`, the document id `doc`, `filled`, and `texts`, the scroll
// and wait pseudo-actions carry `node:null` so every action has the same shape, and each action carries
// the field facts `form`, `multiline`, `inputType`, `autocomplete`, and `maxLength`. Code uses these
// facts to decide where assistant-written text may go; they never reach Jev. Forms get ids from their own
// counter, so element node ids stay the same as in the reference. The focus also carries its `form` and the
// name of the form's default button, `submitDefault`, and `multiline`, for the Enter-to-click rule.
import type { Action } from "./model.js";

/** Mention chips in an editor: TipTap, CKEditor, quill-mention, Slack, and the MentionInput of the platform. */
const MENTION_SELECTOR = '[data-mention],[data-mention-id],[data-mention-display],[data-type="mention"],.mention,ts-mention';
/** Atomic inline elements of an editor: mention chips, and void or decorator nodes (images, embeds, variables). */
const ATOM_SELECTOR = `${MENTION_SELECTOR},[contenteditable="false"],[data-slate-void],[data-lexical-decorator]`;
/** Containers of a popup: a picker, a menu, a listbox, or a dialog. */
const POPUP_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"],dialog,[data-radix-popper-content-wrapper]';

/**
 * Read visible content and controls in one evaluation. Node identity lives in `window.__jevFast`:
 * a WeakMap gives each element a code-owned id, a Map keeps the live reference for execution.
 * Returns null when the document has no body yet.
 */
export const SNAPSHOT_SCRIPT: string = String.raw`(() => {
  if (!document.body) return null;
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
  const POPUP=${JSON.stringify(POPUP_SELECTOR)}, MENTION=${JSON.stringify(MENTION_SELECTOR)}, ATOM=${JSON.stringify(ATOM_SELECTOR)};
  const popupsOf = e => {
    const out=[];
    for (let p=e.closest(POPUP);p;p=p.parentElement?.closest(POPUP)) out.push(formId(p));
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
    const atoms=editable ? atomsOf(e) : null, popup=popupsOf(e);
    return {node:identity(e),label:name(e),role:role(e),submitLabel:submits.map(b=>name(b)).join(' | '),
      editable,value:editable ? ('value' in e ? String(e.value) : e.innerText) : '',
      form:owner ? formId(owner) : null,submitDefault:controls[0] && !controls[0].matches(':disabled') ? name(controls[0]) : '',
      multiline:e.tagName==='TEXTAREA' || e.isContentEditable || e.getAttribute('aria-multiline')==='true',
      ...(atoms?.mentions.length ? {mentions:atoms.mentions} : {}),...(popup.length ? {popup} : {})};
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
  cache.keyGuard=()=>[cache.pageKey(),cache.focus(),cache.focus() ? cache.guard(document.activeElement) : null];
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
  // Lists where aria-selected marks the option that Enter picks, not a chosen one: the list of a combobox (aria-controls,
  // aria-owns, or aria-activedescendant) and a cmdk list. A multi-select list keeps aria-selected as the choice.
  const lists=new Set();
  for (const c of document.querySelectorAll('[role="combobox"],[aria-activedescendant]')) {
    for (const id of ((c.getAttribute('aria-controls')||'')+' '+(c.getAttribute('aria-owns')||'')).split(/\s+/)) {
      const l=id ? document.getElementById(id) : null;
      if (l) lists.add(l);
    }
    const active=document.getElementById(c.getAttribute('aria-activedescendant')||'')?.closest('[role="listbox"]');
    if (active) lists.add(active);
  }
  const highlight=e=>(e.hasAttribute('cmdk-item') || [...lists].some(l=>l.contains(e))) && !e.closest('[aria-multiselectable="true"]');
  const actions=[];
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    // A control inside an option that takes no pointer events (the checkbox of a multi-select option) is part of the option.
    if (e.parentElement?.closest('[role="option"]') && getComputedStyle(e).pointerEvents==='none') continue;
    const r=e.getBoundingClientRect(), clip=clippedRect(e), x=clip.x+clip.w/2, y=clip.y+clip.h/2, rname=role(e);
    if (!rname || clip.w<=0 || clip.h<=0 || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const popup=popupsOf(e);
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
    if (rname==='option' && base.selected!==undefined && highlight(e)) { base.highlighted=base.selected; delete base.selected; }
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
      const atoms=editable ? atomsOf(e) : null;
      actions.push({...base,kind:editable?'fill':'click',value,
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
    texts:filled.filter(c=>{const e=cache.nodes.get(c[0]);return e && visible(e);}).map(c=>[c[0],c[1]])};
})()`;

/** The semantic marker of the whole page, or null when the document has no body. */
export const MARKER_SCRIPT: string = `(() => { const state=${SNAPSHOT_SCRIPT}; return state?.marker ?? null; })()`;

/**
 * Post-input settle. Resolves after two animation frames or 50 ms. A fill in an editable
 * combobox waits for visible options instead, up to 200 ms. `null` means a generic settle.
 */
export function settleScript(action: Action | null): string {
  const arg = JSON.stringify(action === null ? { kind: "key", node: null } : { kind: action.kind, node: action.node });
  return String.raw`(action => new Promise(resolve => {
  const field=action.node===null ? null : window.__jevFast?.nodes.get(action.node);
  const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
  let frames=0, stopped=false;
  const finish=()=>{stopped=true;resolve()};
  setTimeout(finish,autocomplete ? 200 : 50);
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
 * card. When every point is on an atom, a plain fill takes the first one, and an `append` fill gets null.
 */
export function actScript(action: Action, append = false): string {
  const arg = JSON.stringify({ kind: action.kind, node: action.node, value: action.value ?? null, delta: action.delta ?? 0, append });
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
  if (x===null && atom && !action.append) [x,y]=atom;
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
 * Put the caret at the end of a field that has focus, for a fill that adds text and keeps the field's chips. In an editor
 * the caret goes after the last text or chip of the last block, before a trailing <br>. Returns the field text before
 * the caret, or null when the field is gone or focus is not in it.
 */
export function caretEndScript(node: number): string {
  return `(() => {
  const e=window.__jevFast?.nodes.get(${Math.trunc(node)}), a=document.activeElement;
  if (!e?.isConnected || !a || !(a===e || e.contains(a))) return null;
  if ('value' in e && typeof e.setSelectionRange==='function') { const n=String(e.value).length; e.setSelectionRange(n,n); return {before:String(e.value)}; }
  const s=getSelection();
  if (!s) return null;
  let t=e;
  while (t.lastChild && t.lastChild.nodeType===1 && t.lastChild.nodeName!=='BR' && !t.lastChild.matches(${JSON.stringify(ATOM_SELECTOR)})) t=t.lastChild;
  const last=t.lastChild, range=document.createRange();
  if (last && last.nodeType===3) range.setStart(last,last.length);
  else if (last && last.nodeName==='BR') range.setStartBefore(last);
  else range.setStart(t,t.childNodes.length);
  range.collapse(true);
  s.removeAllRanges();
  s.addRange(range);
  return {before:e.textContent||''};
})()`;
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
