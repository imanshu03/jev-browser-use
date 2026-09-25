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
// Dates: native date, month, datetime-local, time, and week inputs are fill actions with `date`. One month, one
// day, and one year part in a container with no other text box are one date group: the snapshot shows the group
// as one fill action with `date` (its label "<group label or Date>[ range start|end] (M/D/YYYY)", its value the
// joined parts) and leaves out the part actions and their "Open" clicks. A part outside a whole group carries
// `datePart`. A day of a calendar grid carries `day`: its ISO date from a machine attribute, its selection, and its
// place in a range. Groups and grids get ids from their own counter.
import type { Action } from "./model.js";

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
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
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
      if (['text','email','url','tel','date','datetime-local','month','time','week'].includes(e.type)) return 'textbox';
    }
    return null;
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
    return {node:identity(e),label:name(e),role:role(e),submitLabel:submits.map(b=>name(b)).join(' | '),
      editable,value:editable ? ('value' in e ? String(e.value) : e.innerText) : '',
      form:owner ? formId(owner) : null,submitDefault:controls[0] && !controls[0].matches(':disabled') ? name(controls[0]) : '',
      multiline:e.tagName==='TEXTAREA' || e.isContentEditable || e.getAttribute('aria-multiline')==='true'};
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
  const inView=e=>{
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) return false;
    const r=e.getBoundingClientRect(), clip=clippedRect(e), x=clip.x+clip.w/2, y=clip.y+clip.h/2;
    return clip.w>0 && clip.h>0 && r.width>0 && r.height>0 && x>=0 && y>=0 && x<innerWidth && y<innerHeight;
  };
  const writable=e=>!e.readOnly && e.getAttribute('aria-readonly')!=='true';
  const owner=e=>e.form||e.closest('form,[role="form"],dialog,[role="dialog"]');
  // Date groups and calendar grids get ids from their own counter. Code only compares them.
  const dates = cache.dates ||= {ids:new WeakMap(), next:1};
  const dateId = e => {
    if (!dates.ids.has(e)) dates.ids.set(e,dates.next++);
    return dates.ids.get(e);
  };
  const NATIVE_DATE={date:'date','datetime-local':'date and time',month:'month',time:'time',week:'week'};
  // A part names a month, a day, or a year: data-type (react-aria), a spinbutton range of 1-12 or 1-31, a placeholder,
  // aria-label, or label token, or a name that ends in day, month, or year. Card expiry parts (autocomplete cc-*) are not parts.
  const PART={month:/^(?:m|mm|month|mois|monat|mes|maand)$/i,day:/^(?:d|dd|day|jour|tag|d[ií]a|dag)$/i,
    year:/^(?:yy|yyyy|year|ann[eé]e|jahr|a[nñ]o|jaar|aaaa|jjjj)$/i};
  const partValue=e=>e.tagName==='INPUT' ? String(e.value) : e.getAttribute('aria-valuenow') ?? '';
  const partOf=e=>{
    const r=role(e);
    if (!['textbox','spinbutton'].includes(r) || e.tagName==='TEXTAREA' || e.type in NATIVE_DATE || /^cc-/i.test(e.getAttribute('autocomplete')||'')) return null;
    const t=(e.getAttribute('data-type')||'').toLowerCase();
    if (t==='month' || t==='day' || t==='year') return t;
    const lo=e.getAttribute('aria-valuemin'), hi=e.getAttribute('aria-valuemax');
    if (r==='spinbutton' && lo==='1' && hi==='12') return 'month';
    if (r==='spinbutton' && lo==='1' && ['28','29','30','31'].includes(hi)) return 'day';
    for (const s of [e.getAttribute('placeholder'),e.getAttribute('aria-placeholder'),e.getAttribute('aria-label'),name(e)]) {
      const v=(s||'').trim().replace(/[.:]$/,'');
      for (const k of ['month','day','year']) if (PART[k].test(v)) return k;
    }
    const n=(e.getAttribute('name')||e.id||'').match(/(?:^|[-_[.])(day|month|year)\]?$/i);
    return n ? n[1].toLowerCase() : null;
  };
  const parts=new Map(), groupOf=new Map(), groups=[];
  for (const e of document.querySelectorAll('input,[role="spinbutton"],[role="textbox"]')) {
    if (!safe(e) || !visible(e) || e.matches(':disabled')) continue;
    const k=partOf(e);
    if (k) parts.set(e,k);
  }
  if (parts.size>=3) {
    const boxes=[...document.querySelectorAll(selector)].filter(e=>safe(e) && visible(e) && !e.matches(':disabled') &&
      ['textbox','searchbox','spinbutton','combobox'].includes(role(e)) && e.tagName!=='SELECT');
    // The group of a part: its nearest ancestor that holds one part of each kind and no other text box.
    const containerOf=e=>{
      for (let a=e.parentElement, depth=0; a && a!==document.body && depth<8; a=a.parentElement, depth++) {
        const inside=boxes.filter(b=>a.contains(b));
        if (inside.some(b=>!parts.has(b))) return null;
        const kinds=inside.map(b=>parts.get(b));
        if (new Set(kinds).size<kinds.length) return null;
        if (kinds.length===3) return {el:a,parts:inside,kinds};
      }
      return null;
    };
    const textBetween=(a,b)=>{
      const r=document.createRange(); r.setStartAfter(a); r.setEndBefore(b);
      return r.toString().replace(/\s+/g,' ').trim();
    };
    const refs=ids=>ids.split(/\s+/).map(id=>document.getElementById(id)).filter(Boolean).map(x=>(x.innerText||x.textContent||'').trim()).join(' ').trim();
    // The group label: aria-labelledby or aria-label of the container or of a role=group around it, or a fieldset legend.
    const labelOf=g=>{
      for (let a=g.el, depth=0; a && a!==document.body && depth<6; a=a.parentElement, depth++) {
        if (depth>0 && boxes.some(b=>a.contains(b) && !g.parts.includes(b))) break;
        if (a.tagName==='FIELDSET') { const t=(a.querySelector(':scope > legend')?.innerText||'').trim(); if (t) return t; }
        const by=a.getAttribute('aria-labelledby'), t=by ? refs(by) : (a.getAttribute('aria-label')||'').trim();
        if (t && (a===g.el || a.getAttribute('role')==='group')) return t;
      }
      return '';
    };
    for (const [e] of parts) {
      if (groupOf.has(e)) continue;
      const g=containerOf(e);
      if (!g || g.parts.some(p=>groupOf.has(p))) continue;
      for (const p of g.parts) groupOf.set(p,g);
      const tok=p=>(p.getAttribute('placeholder')||p.getAttribute('aria-placeholder')||'').trim();
      const between=textBetween(g.parts[0],g.parts[1]);
      g.id=dateId(g.el);
      g.sep=/^[/.-]$/.test(between) ? between : ' ';
      g.order=g.kinds.map(k=>k[0].toUpperCase()).join('');
      g.pad=g.parts.some(p=>parts.get(p)!=='year' && (/^(?:mm|dd)$/i.test(tok(p)) || /^0\d$/.test(partValue(p))));
      g.short=g.parts.some(p=>parts.get(p)==='year' && (/^yy$/i.test(tok(p)) || p.maxLength===2));
      g.label=labelOf(g).replace(/\s+/g,' ').slice(0,60);
      g.ok=g.parts.every(p=>inView(p) && writable(p));
      groups.push(g);
    }
    // Range roles only from a separator between two groups ("-", "–", "to") or from start and end labels.
    const SEP=/^(?:-|–|—|to|until|till|through|bis|au|à|al|tot)$/i;
    const START=/\b(?:start|from|begin|check-?in|depart(?:ure)?)\b/i, END=/\b(?:end|to|until|check-?out|return)\b/i;
    for (let i=0; i+1<groups.length; i++) {
      const a=groups[i], b=groups[i+1];
      if (a.role || owner(a.parts[0])!==owner(b.parts[0])) continue;
      const apart=!a.el.contains(b.el) && !b.el.contains(a.el) && (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (apart && SEP.test(textBetween(a.el,b.el))) { a.bySep=b.bySep=true; a.role='start'; b.role='end'; }
      else if (START.test(a.label) && !END.test(a.label) && END.test(b.label) && !START.test(b.label)) { a.role='start'; b.role='end'; }
      if (a.role) a.range=b.range=a.id;
    }
    for (const g of groups) {
      const values=g.parts.map(partValue);
      const token={month:g.pad?'MM':'M',day:g.pad?'DD':'D',year:g.short?'YY':'YYYY'};
      g.name=(g.label||'Date')+(g.bySep ? ' range '+g.role : '')+' ('+g.kinds.map(k=>token[k]).join(g.sep)+')';
      g.value=values.every(v=>v==='') ? '' : values.join(g.sep);
    }
  }
  // The page locale's numeric date order and separator: a numeric task date goes into a native date input only in that shape.
  let localeShape=null;
  const shapeOf=()=>{
    if (localeShape) return localeShape;
    try {
      const ps=new Intl.DateTimeFormat(undefined,{year:'numeric',month:'numeric',day:'numeric'}).formatToParts(new Date(2026,10,23));
      localeShape={order:ps.filter(p=>['year','month','day'].includes(p.type)).map(p=>p.type[0].toUpperCase()).join(''),
        sep:(ps.find(p=>p.type==='literal')?.value||'').trim()};
    } catch { localeShape={}; }
    return localeShape;
  };
  const isoOf=v=>{
    if (!v) return null;
    if (/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(v)) return v.slice(0,10);
    if (!/^\d{10}(?:\d{3})?$/.test(v)) return null;
    const d=new Date(Number(v.length===10 ? v+'000' : v));
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  };
  // A day of a calendar grid. The ISO day comes from a machine attribute; the shadcn day button's data-day follows the
  // locale and is never read. Without one, code reads the label (a label without a year is not a day).
  const dayOf=(e,grid)=>{
    const cell=e.closest('[role="gridcell"],td')||e, own=[cell,e];
    let day=null;
    for (const x of own) day=day||isoOf(x.getAttribute('data-date'))||isoOf(x.getAttribute('data-value'))||isoOf(x.getAttribute('data-timestamp'))||isoOf(x.getAttribute('title'));
    day=day||isoOf(cell.getAttribute('data-day'))||isoOf(e.querySelector('time[datetime]')?.getAttribute('datetime')||'');
    if (!day && !/\b\d{4}\b/.test(e.getAttribute('aria-label')||name(e))) return null;
    const flag=k=>own.some(x=>{const v=x.getAttribute('data-'+k);return v==='true' || v==='';});
    const start=flag('range-start')||flag('selection-start'), end=flag('range-end')||flag('selection-end');
    const pos=start && end ? 'single' : start ? 'start' : end ? 'end' : flag('range-middle') ? 'middle' : null;
    return {grid:dateId(grid),day,multi:grid.getAttribute('aria-multiselectable')==='true',
      sel:own.some(x=>x.getAttribute('aria-selected')==='true' || x.getAttribute('data-selected')==='true'),...(pos?{pos}:{})};
  };
  const actions=[];
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), clip=clippedRect(e), x=clip.x+clip.w/2, y=clip.y+clip.h/2, rname=role(e);
    if (!rname || clip.w<=0 || clip.h<=0 || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    const form=(f=>f?formId(f):null)(owner(e));
    // A whole date group is one fill action at its first part. Its parts and their "Open" clicks are not actions.
    const group=groupOf.get(e);
    if (group && group.ok) {
      if (e===group.parts[0]) actions.push({node:identity(e),role:'textbox',label:group.name,rect:{x:r.x,y:r.y,w:r.width,h:r.height},
        form,multiline:false,kind:'fill',value:group.value,date:{kind:'group',
          parts:group.parts.map(p=>({part:parts.get(p),node:identity(p),value:partValue(p),spin:p.tagName!=='INPUT'})),
          sep:group.sep,order:group.order,pad:group.pad,short:group.short,...(group.role?{role:group.role,range:group.range}:{})}});
      continue;
    }
    const native=e.tagName==='INPUT' && e.type in NATIVE_DATE;
    const base={node:identity(e),role:rname,label:native ? (name(e)||'Date')+' ('+NATIVE_DATE[e.type]+')' : name(e)||rname,
      rect:{x:r.x,y:r.y,w:r.width,h:r.height},
      form,
      multiline:e.tagName==='TEXTAREA'||e.isContentEditable||e.getAttribute('aria-multiline')==='true',
      ...(e.tagName==='INPUT'?{inputType:String(e.type).toLowerCase()}:{}),
      ...(e.getAttribute('autocomplete')?{autocomplete:e.getAttribute('autocomplete').toLowerCase()}:{}),
      ...(e.maxLength>0?{maxLength:e.maxLength}:{})};
    if (native) base.date={kind:e.type,...(e.min?{min:e.min}:{}),...(e.max?{max:e.max}:{}),...(e.type==='date'?shapeOf():{})};
    if (parts.has(e)) base.datePart=parts.get(e);
    const grid=e.closest('[role="grid"]');
    const day=grid ? dayOf(e,grid) : null;
    if (day) base.day=day;
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=writable(e) &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      // A native date input takes a whole date: TYPE_TEXT only. A click opens the browser's own picker, which is not in the page.
      if (editable && !native) actions.push({...base,kind:'click',value,label:'Open '+base.label});
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
 */
export function actScript(action: Action): string {
  const arg = JSON.stringify({ kind: action.kind, node: action.node, value: action.value ?? null, delta: action.delta ?? 0 });
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
  let x=null,y=null;
  for (const [px,py] of pts) {
    if (px<0 || py<0 || px>=innerWidth || py>=innerHeight) continue;
    const h=document.elementFromPoint(px,py);
    if (h && e.contains(h)) { x=px; y=py; break; }
  }
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
 * Set a native date, month, datetime-local, time, or week input: the native value setter, then input and change events,
 * as Playwright's fill does. Inserted text and typed digits do not work: a date input takes digits in the order of the
 * browser locale. Returns the value that the input holds after it, or null when the node is gone, disabled, read-only,
 * or not such an input.
 */
export function nativeDateScript(node: number, value: string): string {
  return `(([node,value]) => {
  const e=window.__jevFast?.nodes.get(node);
  if (!e?.isConnected || e.tagName!=='INPUT' || !['date','datetime-local','month','time','week'].includes(e.type) || e.disabled || e.readOnly) return null;
  e.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,value);
  e.dispatchEvent(new Event('input',{bubbles:true}));
  e.dispatchEvent(new Event('change',{bubbles:true}));
  return e.value;
})(${JSON.stringify([Math.trunc(node), value])})`;
}

/**
 * Select all text of a date part input before the part text goes in. No key goes to the page: a part's key filter can
 * refuse a select-all chord. False when the input cannot select its text (a number input): the caller then uses the
 * select-all command.
 */
export function selectPartScript(node: number): string {
  return `(node => {
  const e=window.__jevFast?.nodes.get(node);
  if (!e?.isConnected || e.tagName!=='INPUT') return false;
  try { e.select(); } catch { return false; }
  return e.selectionStart===0 && e.selectionEnd===e.value.length;
})(${Math.trunc(node)})`;
}

/** Blur the focused element. A page that checks a date part when it loses focus (the Usage DateInput) then checks the last part too. */
export const BLUR_SCRIPT = "(() => { const e=document.activeElement; if (e && e!==document.body && typeof e.blur==='function') e.blur(); return true; })()";
