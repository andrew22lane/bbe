/* bbe contrast — the half that runs INSIDE the browser.
 *
 * Loaded as text by tools/contrast-scan.mjs and evaluated in the page realm.
 * It is a plain script, not a module, because it installs three functions on
 * window and gets called again per colour scheme:
 *
 *   __bbeSheets()          which stylesheets are readable and which are CORS-blocked
 *   __bbeIndex(sheets)     build the author-rule index (selector -> props -> var() names)
 *   __bbeWalk()            walk every rendered element and measure it, in the CURRENT scheme
 *
 * The point of the rule index is attribution. Knowing a button prints
 * #FBF7F9 on #FBF7F9 is a pixel. Knowing the rule is ".btn-quiet .go" with
 * background:var(--ink) and the icon is color:var(--paper) is a fix.
 */
(() => {
const W = window;

/* --- colour helpers, mirrored from the node side ------------------------- */
function parseColor(str){
  if(!str) return null;
  const s = String(str).trim().toLowerCase();
  if(s === 'transparent') return {r:0,g:0,b:0,a:0};
  if(s === 'none' || s === 'currentcolor' || s === 'auto') return null;
  let m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,\/]\s*([\d.%]+))?\s*\)$/);
  if(m){ const a = m[4]===undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4])/100 : parseFloat(m[4])); return {r:+m[1],g:+m[2],b:+m[3],a}; }
  m = s.match(/^#([0-9a-f]{3,8})$/);
  if(m){ let h=m[1]; if(h.length===3||h.length===4) h=h.split('').map(c=>c+c).join('');
    const a = h.length===8 ? parseInt(h.slice(6,8),16)/255 : 1;
    return {r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16),a}; }
  return null;
}
function over(src,dst){ const a = src.a + dst.a*(1-src.a); if(a===0) return {r:0,g:0,b:0,a:0};
  const f=(s,d)=>(s*src.a + d*dst.a*(1-src.a))/a;
  return {r:f(src.r,dst.r),g:f(src.g,dst.g),b:f(src.b,dst.b),a}; }
function css(c){ return c.a >= 0.999
  ? 'rgb(' + [c.r,c.g,c.b].map(v=>Math.round(v)).join(', ') + ')'
  : 'rgba(' + [c.r,c.g,c.b].map(v=>Math.round(v)).join(', ') + ', ' + (Math.round(c.a*1000)/1000) + ')'; }

/* --- the author-rule index ----------------------------------------------- */

const PROPS = ['color','background','background-color','background-image','stroke','fill','opacity','border-color'];

/* State pseudo-classes are stripped so ".btn:hover .go" still matches ".btn .go"
   and the finding can say "on hover" instead of silently vanishing. Pseudo
   ELEMENTS are stripped too, and the rule is tagged, because ::before is not
   the element we measured. */
const STATE_RX = /:(?:hover|focus|focus-visible|focus-within|active|visited|target|link|any-link|checked|disabled|enabled|placeholder-shown|autofill|default|user-invalid|user-valid)\b/g;
const PSEUDO_EL_RX = /::[a-zA-Z-]+(\([^)]*\))?/g;

function specificity(sel){
  let a=0,b=0,c=0;
  let t = sel.replace(PSEUDO_EL_RX, () => { c++; return ' '; });
  t = t.replace(/\[[^\]]*\]/g, () => { b++; return ' '; })
       .replace(/#[\w-]+/g, () => { a++; return ' '; })
       .replace(/\.[\w-]+/g, () => { b++; return ' '; })
       .replace(/:(?:not|is|has)\([^)]*\)/g, () => { b++; return ' '; })
       .replace(/:where\([^)]*\)/g, () => ' ')
       .replace(/:[\w-]+(\([^)]*\))?/g, () => { b++; return ' '; });
  c += (t.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g)||[]).length;
  return a*10000 + b*100 + c;
}

function tokensIn(value){
  const out = []; const rx = /var\(\s*(--[\w-]+)/g; let m;
  while((m = rx.exec(value))) out.push(m[1]);
  return out;
}

function splitSelectors(text){
  const out = []; let depth = 0, cur = '';
  for(const ch of text){
    if(ch === '(' || ch === '[') depth++;
    else if(ch === ')' || ch === ']') depth--;
    if(ch === ',' && depth === 0){ out.push(cur); cur = ''; } else cur += ch;
  }
  if(cur.trim()) out.push(cur);
  return out;
}

function indexSheets(sheets){
  const rules = [];
  const blocked = [];
  let order = 0;
  const shim = document.implementation.createHTMLDocument('bbe-contrast-shim');

  function walk(list, href, media){
    for(const r of list){
      /* @import. document.styleSheets lists only TOP-LEVEL sheets, so an
         imported sheet is invisible unless it is walked through the import
         rule. That is not an edge case: the Club imports the DH brand kit,
         and the rule that decides its card text lives in there. Skipping it
         attributed a real failure to the wrong rule, in the wrong file. */
      if(r.styleSheet && r.selectorText === undefined){
        const ihref = r.styleSheet.href || href;
        let ilist = null;
        try { ilist = r.styleSheet.cssRules; } catch(e) { ilist = null; }
        if(ilist) walk(ilist, ihref, media);
        else if(ihref) blocked.push(ihref);
        continue;
      }
      if(r.cssRules && r.selectorText === undefined){
        const cond = r.conditionText || (r.media && r.media.mediaText) || '';
        walk(r.cssRules, href, media ? media + ' and ' + cond : cond);
        continue;
      }
      if(!r.selectorText || !r.style) continue;
      const decls = {};
      for(const p of PROPS){
        const v = r.style.getPropertyValue(p);
        if(v && v.trim()) decls[p] = { value: v.trim(), tokens: tokensIn(v) };
      }
      if(Object.keys(decls).length === 0) continue;
      const ord = order++;
      for(const raw of splitSelectors(r.selectorText)){
        const sel = raw.trim(); if(!sel) continue;
        PSEUDO_EL_RX.lastIndex = 0; STATE_RX.lastIndex = 0;
        const hasPseudoEl = PSEUDO_EL_RX.test(sel);
        STATE_RX.lastIndex = 0;
        const hasState = STATE_RX.test(sel);
        PSEUDO_EL_RX.lastIndex = 0; STATE_RX.lastIndex = 0;
        const base = sel.replace(PSEUDO_EL_RX,'').replace(STATE_RX,'').trim();
        if(!base) continue;
        rules.push({ sel, base, hasPseudoEl, hasState, decls, media, href, order: ord, spec: specificity(sel) });
      }
    }
  }

  for(const s of sheets){
    let list = null;
    if(s.cssText != null){
      const st = shim.createElement('style'); st.textContent = s.cssText; shim.head.appendChild(st);
      try { list = st.sheet.cssRules; } catch(e) { list = null; }
    } else if (s.live != null){
      try { list = document.styleSheets[s.live].cssRules; } catch(e) { list = null; }
    }
    if(!list) continue;
    try { walk(list, s.href || '(inline)', ''); } catch(e) { /* one bad sheet must not kill the scan */ }
  }
  return { rules, blocked };
}

W.__bbeSheets = function(){
  return [...document.styleSheets].map((s,i) => {
    try { void s.cssRules.length; return { href: s.href, live: i, cssText: null, blocked: false }; }
    catch(e){ return { href: s.href, live: null, cssText: null, blocked: true }; }
  });
};

W.__bbeIndex = function(sheets){
  const r = indexSheets(sheets);
  W.__bbeRules = r.rules;
  return { count: r.rules.length, blocked: [...new Set(r.blocked)] };
};

/* --- matching an element to the rules that styled it --------------------- */

function matchingRules(el){
  const out = [];
  const rules = W.__bbeRules || [];
  for(const r of rules){
    let ok = false;
    try { ok = el.matches(r.base); } catch(e) { ok = false; }
    if(ok) out.push(r);
  }
  return out;
}

/* Best-effort cascade winner for one property: highest specificity, then last
   in document order. Inline style beats everything. It is best-effort on
   purpose -- the exact winner matters less than naming a rule a human can go
   and open. */
function winner(el, prop, matched){
  if(el.style && el.style.getPropertyValue(prop)){
    return { sel: '(inline style)', href: '(inline)', media: '', hasState: false, prop, spec: 1000000, order: 1e9,
             value: el.style.getPropertyValue(prop).trim(), tokens: tokensIn(el.style.getPropertyValue(prop)) };
  }
  /* The measurement is of the RESTING element -- nothing is hovered or focused
     in a headless render -- so a `:hover` rule did not decide this colour and
     must not be named as the cause. Attribution costs a whole wrong fix when it
     points at a state rule, so state rules are only used when nothing else
     declared the property at all, and then they are flagged. */
  let best = null, stateBest = null;
  for(const r of matched){
    const d = r.decls[prop]; if(!d) continue;
    if(r.hasPseudoEl) continue;
    const slot = r.hasState ? 'state' : 'rest';
    const cur = slot === 'state' ? stateBest : best;
    const better = !cur || r.spec > cur.spec || (r.spec === cur.spec && r.order > cur.order);
    if(!better) continue;
    if(slot === 'state') stateBest = { r, spec: r.spec, order: r.order };
    else best = { r, spec: r.spec, order: r.order };
  }
  if(!best) best = stateBest;
  if(!best) return null;
  const d = best.r.decls[prop];
  return { sel: best.r.sel, href: best.r.href, media: best.r.media, hasState: best.r.hasState, prop,
           value: d.value, tokens: d.tokens, spec: best.spec, order: best.order };
}

/* The background shorthand and background-color are the same job here, and the
   pick has to compare them against each other rather than trying one and then
   the other. CSSOM expands `background: transparent` into a longhand but leaves
   `background: var(--card)` as a pending substitution, so background-color reads
   empty on exactly the rule that matters. Trying background-color first therefore
   names the losing rule every time a token is involved -- which is every time
   anyone cares. */
function bgWinner(el, matched){
  const cands = [];
  for(const p of ['background-color','background']){
    const w = winner(el, p, matched);
    if(w) cands.push(w);
  }
  if(!cands.length) return null;
  cands.sort((a,b) => (b.spec - a.spec) || (b.order - a.order));
  return cands[0];
}

/* --- effective background ------------------------------------------------ */
/* Walk up through transparent and rgba(...,0) until something opaque is found.
   A background-image or gradient anywhere in that stack is reported UNKNOWN,
   never guessed: an average colour that happens to pass is a false negative
   with a number attached, which is worse than an honest gap. */

function effectiveBackground(el){
  let acc = { r:0, g:0, b:0, a:0 };
  let node = el;
  const stack = [];
  while(node && node.nodeType === 1){
    const cs = getComputedStyle(node);
    const bi = cs.backgroundImage;
    if(bi && bi !== 'none'){
      return { unknown: true, reason: 'background-image', at: describe(node), stack };
    }
    const c = parseColor(cs.backgroundColor);
    if(c && c.a > 0){
      const op = parseFloat(cs.opacity);
      const layer = { r:c.r, g:c.g, b:c.b, a: c.a * (isNaN(op) ? 1 : op) };
      acc = over(acc, layer);
      stack.push({ at: describe(node), color: cs.backgroundColor });
      if(acc.a >= 0.999){
        return { unknown:false, color: acc, at: describe(node), el: node, stack };
      }
    }
    node = node.parentElement;
  }
  /* Nothing opaque all the way to <html>: the canvas shows through. Chrome
     paints white, or rgb(18,18,18) when the used color-scheme is dark. That is
     an engine fact, not a guess, but it is tagged so a reader can discount it. */
  const rootCS = getComputedStyle(document.documentElement);
  const darkCanvas = (rootCS.colorScheme || '').indexOf('dark') !== -1 &&
                     (rootCS.colorScheme || '').indexOf('light') === -1;
  const canvas = darkCanvas ? {r:18,g:18,b:18,a:1} : {r:255,g:255,b:255,a:1};
  acc = over(acc, canvas);
  return { unknown:false, color: acc, at: '(canvas)', el: null, canvasAssumed: true, stack };
}

/* --- identity ------------------------------------------------------------ */

function describe(el){
  if(!el || el.nodeType !== 1) return '(none)';
  let s = el.tagName.toLowerCase();
  if(el.id) s += '#' + el.id;
  const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0,4);
  if(cls.length) s += '.' + cls.join('.');
  return s;
}

/* A stable key across the two renders. Both schemes are measured on the SAME
   page load -- emulateMediaFeatures restyles without reloading -- so the index
   path is identical by construction, and no id/class heuristic is needed. */
function pathKey(el){
  const parts = [];
  let n = el;
  while(n && n.parentNode && n.parentNode.nodeType === 1){
    const sibs = n.parentNode.children;
    let i = 0; for(; i < sibs.length; i++) if(sibs[i] === n) break;
    parts.unshift(i);
    n = n.parentNode;
  }
  return parts.join('/');
}

function directText(el){
  let t = '';
  for(const n of el.childNodes) if(n.nodeType === 3) t += n.nodeValue;
  return t.replace(/\s+/g,' ').trim();
}

/* Only elements that actually PAINT. <svg> and <g> inherit a fill they never
   put on screen, and measuring them invents a finding per icon wrapper.
   <use> is out too, and for a sharper reason: the ink it puts on screen belongs
   to the referenced symbol, in another document, unreachable from
   querySelectorAll. Its OWN computed fill is the CSS initial, black, so
   measuring it reported the Club's glyph covers as black-on-near-black when
   the symbol actually draws fill="none" stroke="currentColor" in --accent.
   A blind spot named out loud beats a confident wrong number, so these are
   counted and reported as unmeasured instead. */
const SVG_SHAPES = new Set(['path','line','circle','rect','polyline','polygon','ellipse','text','tspan']);

/* --- the walk ------------------------------------------------------------ */

function isVisuallyHidden(el, cs, box){
  if(box.width <= 2 && box.height <= 2) return true;
  const clip = (cs.clip || '') + ' ' + (cs.clipPath || '');
  if(/rect\(0px[,\s]/.test(clip) || /inset\(\s*(50%|100%)/.test(clip)) return true;
  if(parseFloat(cs.textIndent) <= -999) return true;
  return false;
}

W.__bbeWalk = function(){
  const records = [];
  let unmeasuredUse = 0;
  const all = document.querySelectorAll('*');
  for(const el of all){
    const tag = el.tagName.toLowerCase();
    if(tag === 'use'){ unmeasuredUse++; continue; }
    if(tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta' ||
       tag === 'head' || tag === 'title' || tag === 'br' || tag === 'defs' ||
       tag === 'symbol' || tag === 'clippath' || tag === 'lineargradient' || tag === 'stop') continue;
    /* getComputedStyle on a display:none element returns values that mean
       nothing, so anything with no box is skipped outright. */
    let rects; try { rects = el.getClientRects(); } catch(e) { continue; }
    if(!rects || rects.length === 0) continue;
    const box = el.getBoundingClientRect();
    if(box.width <= 0 || box.height <= 0) continue;

    const cs = getComputedStyle(el);
    if(cs.visibility === 'hidden' || cs.display === 'none') continue;
    /* The screen-reader-only pattern: a 1px box clipped to nothing. It has a
       client rect, so it survives every other filter, and its contrast is
       meaningless because no sighted reader ever sees it. */
    if(isVisuallyHidden(el, cs, box)) continue;

    /* effective opacity: the element's own, times every ancestor's */
    let eff = 1, n = el;
    while(n && n.nodeType === 1){
      const o = parseFloat(getComputedStyle(n).opacity);
      if(!isNaN(o)) eff *= o;
      n = n.parentElement;
    }
    if(eff <= 0.001) continue;

    const matched = matchingRules(el);
    const bg = effectiveBackground(el);
    const bgRule = bg.el ? bgWinner(bg.el, matchingRules(bg.el)) : null;

    const base = {
      key: pathKey(el),
      tag,
      id: el.id || '',
      classes: (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean),
      sel: describe(el),
      rect: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
      opacity: Math.round(eff*1000)/1000,
      fontSize: parseFloat(cs.fontSize) || 0,
      fontWeight: cs.fontWeight,
      bg: bg.unknown ? null : css(bg.color),
      bgUnknown: !!bg.unknown,
      bgReason: bg.reason || null,
      bgAt: bg.at,
      /* every layer that contributed, nearest first. A translucent tint sitting
         on an opaque card is the thing a reader has to see: naming only the
         opaque layer sends them to the wrong rule. */
      bgStack: (bg.stack || []).map(x => ({ at: x.at, color: x.color })),
      bgCanvasAssumed: !!bg.canvasAssumed,
      bgRule: bgRule ? { sel: bgRule.sel, prop: bgRule.prop, value: bgRule.value, tokens: bgRule.tokens, media: bgRule.media, href: bgRule.href, state: bgRule.hasState } : null
    };

    /* ---- text foreground ---- */
    const text = directText(el);
    if(text){
      const fg = parseColor(cs.color);
      if(fg && fg.a > 0.001){
        const rule = winner(el, 'color', matched) || nearestColorRule(el);
        records.push(Object.assign({}, base, {
          kind: 'text',
          fg: css({ r:fg.r, g:fg.g, b:fg.b, a: fg.a * eff }),
          fgRaw: cs.color,
          sample: text.slice(0,40),
          fgRule: rule ? { sel: rule.sel, prop: rule.prop, value: rule.value, tokens: rule.tokens, media: rule.media, href: rule.href, state: rule.hasState } : null
        }));
      }
    }

    /* ---- svg stroke and fill ----
       The near-invisible arrow on the Club is an SVG stroke, not text. A
       text-only checker walks straight past it, so both are measured. The Club
       draws stroke="currentColor", and the engine resolves that at computed
       time, so the value read here is already the real ink; the attribution
       then falls back to the winning `color` rule, which is where a human has
       to go to fix it. */
    const isSvg = el.namespaceURI === 'http://www.w3.org/2000/svg';
    if(isSvg && SVG_SHAPES.has(tag)){
      const sw = parseFloat(cs.strokeWidth);
      const stroke = parseColor(cs.stroke);
      if(stroke && stroke.a > 0.001 && (isNaN(sw) ? true : sw > 0)){
        let rule = winner(el, 'stroke', matched);
        let via = 'stroke';
        if(!rule || /currentcolor/i.test(rule.value)){
          const cr = winner(el, 'color', matched) || nearestColorRule(el);
          if(cr){ rule = cr; via = 'color (currentColor)'; }
        }
        records.push(Object.assign({}, base, {
          kind: 'stroke', via,
          fg: css({ r:stroke.r, g:stroke.g, b:stroke.b, a: stroke.a * eff }),
          fgRaw: cs.stroke, sample: '',
          fgRule: rule ? { sel: rule.sel, prop: rule.prop, value: rule.value, tokens: rule.tokens, media: rule.media, href: rule.href, state: rule.hasState } : null
        }));
      }
      const fill = parseColor(cs.fill);
      if(fill && fill.a > 0.001 && cs.fill !== 'none'){
        let rule = winner(el, 'fill', matched);
        let via = 'fill';
        if(!rule || /currentcolor/i.test(rule.value)){
          const cr = winner(el, 'color', matched) || nearestColorRule(el);
          if(cr){ rule = cr; via = 'color (currentColor)'; }
        }
        records.push(Object.assign({}, base, {
          kind: 'fill', via,
          fg: css({ r:fill.r, g:fill.g, b:fill.b, a: fill.a * eff }),
          fgRaw: cs.fill, sample: '',
          fgRule: rule ? { sel: rule.sel, prop: rule.prop, value: rule.value, tokens: rule.tokens, media: rule.media, href: rule.href, state: rule.hasState } : null
        }));
      }
    }
  }
  W.__bbeUnmeasured = { use: unmeasuredUse };
  return records;
};

/* currentColor inherits, so the rule that actually decides an svg stroke often
   sits on an ancestor. Walk up until a rule declares `color`. */
function nearestColorRule(el){
  let n = el.parentElement;
  let hops = 0;
  while(n && hops < 12){
    const r = winner(n, 'color', matchingRules(n));
    if(r) return r;
    n = n.parentElement; hops++;
  }
  return null;
}

/* Animations that never stop can hang a headless render, and a mid-transition
   colour is not the colour anyone ships. Freeze everything before measuring. */
W.__bbeFreeze = function(){
  const st = document.createElement('style');
  st.id = 'bbe-contrast-freeze';
  st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;' +
                   'animation-play-state:paused!important;caret-color:transparent!important}';
  document.head.appendChild(st);
  try { document.getAnimations().forEach(a => { try { a.pause(); } catch(e){} }); } catch(e){}
  return true;
};
})();
