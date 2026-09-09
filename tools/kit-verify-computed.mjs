#!/usr/bin/env node
// LEVEL 2 of `bbe kit --verify`: computed styles in a real browser.
//
// A normalized text diff proves the two stylesheets SAY the same thing. It cannot
// prove they DO the same thing: a dropped @import, a rule the cascade never
// reaches, a shorthand a browser expands differently. So the harness below
// instantiates every module in outputs.web.components.order, loads the page twice
// — once with the reference CSS, once with the emitted CSS — and compares
// getComputedStyle property by property.
//
// TWO TRAPS THIS FILE IS BUILT AROUND:
//
//  1. THE FONT. CSS requires @import before any rule. Emit it later and the
//     browser drops it silently, every face falls back to system-ui, and BOTH
//     pages then agree perfectly on the wrong font. A green run would be
//     worthless. So the harness proves the brand face actually loaded — the font
//     is in document.fonts, document.fonts.check passes, AND the same string
//     measures a different width than it does in a forced fallback — and the run
//     FAILS if it did not, on either page.
//
//  2. THE MARQUEE. A 48s always-on animation makes `transform` a moving target.
//     Animations are paused after load; animation-name and animation-duration are
//     read off the cascade, which pausing does not touch.
//
// Viewport is set with page.setViewport. Never a --window-size flag: headless
// Chrome refuses to lay out narrower than about 500px that way, so a flag-set
// width silently measures a different layout than the one asked for.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROPS = [
  'font-family', 'font-size', 'font-weight', 'letter-spacing', 'line-height',
  'text-transform', 'color', 'background-color', 'background-image', 'opacity',
  'border-radius', 'border-top-width', 'border-top-color', 'border-top-style',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-left', 'box-shadow', 'outline-color', 'outline-width',
  'transition-property', 'transition-duration', 'transition-timing-function',
  'animation-name', 'animation-duration', 'animation-direction', 'animation-timing-function',
  'display', 'flex-direction', 'gap', 'grid-template-columns', 'justify-content',
  'align-items', 'width', 'height', 'min-height', 'max-width', 'aspect-ratio',
  'object-fit', 'object-position', 'clip-path', 'mask-image', 'overflow',
  'transform', 'position', 'z-index', 'text-wrap', 'stroke', 'fill', 'stroke-width'
];

const ARROW = '<span class="circ"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>';
const ICO = '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>';
const PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// One block per module in outputs.web.components.order. A brand that does not
// declare a module simply does not get its block on the page.
const BLOCKS = {
  base: `<section class="wrap" data-mod="base">
    <p class="mono" data-l="mono">Label</p>
    <p class="eyebrow" data-l="eyebrow">Eyebrow</p>
    <h1 data-l="h1">Headline <b data-l="h1b">one</b></h1>
    <h2 data-l="h2">Second</h2>
    <h3 data-l="h3">Third</h3>
    <p class="lead" data-l="lead">A lead paragraph that runs to the measure.</p>
    <p data-l="p">Body copy.</p>
    <a href="#" data-l="a">A link</a>
  </section>`,
  nav: `<header class="top" data-mod="nav"><div class="wrap"><nav class="nav">
      <a class="logo" href="#"><img class="lk" src="${PX}" alt="" data-l="nav-logo"></a>
      <ul data-l="nav-ul"><li><a href="#" data-l="nav-a">Work</a></li><li><a href="#">About</a></li></ul>
      <a class="btn" href="#" data-l="nav-btn">Start ${ARROW}</a>
    </nav></div></header>`,
  button: `<section class="wrap" data-mod="button"><div class="acts" data-l="acts">
      <a class="btn" href="#" data-l="btn">Primary ${ARROW}</a>
      <a class="btn paper" href="#" data-l="btn-paper">Paper ${ARROW}</a>
      <a class="btn ghost" href="#" data-l="btn-ghost">Ghost ${ARROW}</a>
      <a class="btn sm" href="#" data-l="btn-sm">Small ${ARROW}</a>
      <a class="btn wide" href="#" data-l="btn-wide">Wide ${ARROW}</a>
    </div><p class="fine" data-l="fine">Fine print</p></section>`,
  card: `<section class="wrap" data-mod="card"><div class="cards" data-l="cards">
      <article class="card" data-l="card"><span class="ico" data-l="card-ico">${ICO}</span>
        <h3 data-l="card-h3">Dark card</h3><p data-l="card-p">What it does.</p>
        <a class="go" href="#" data-l="card-go">Open <svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></a></article>
      <article class="card paper" data-l="card-paper"><h3>Paper card</h3><p data-l="card-paper-p">On light.</p>
        <a class="go" href="#" data-l="card-paper-go">Open</a></article>
    </div></section>`,
  stat: `<section class="wrap" data-mod="stat"><div class="stat" data-l="stat">
      <b data-l="stat-b">50,000</b><span data-l="stat-span">entrepreneurs</span></div></section>`,
  faces: `<section class="wrap" data-mod="faces">
      <div class="faces" data-l="faces"><img src="${PX}" alt="" data-l="faces-img"><img src="${PX}" alt=""></div>
      <p class="by" data-l="by"><img src="${PX}" alt="" data-l="by-img"><span><b data-l="by-b">A name</b> and a role</span></p></section>`,
  roadmap: `<section class="wrap" data-mod="roadmap"><div class="rm" data-l="rm">
      <div class="scr on" data-l="rm-scr">
        <div class="step" data-l="rm-step"><span>Step 1</span><span class="bars" data-l="rm-bars"><i class="done" data-l="rm-bar-done"></i><i class="live" data-l="rm-bar-live"></i><i></i></span></div>
        <p class="q" data-l="rm-q">What are you building?</p>
        <div class="tiles" data-l="rm-tiles">
          <button class="tile" data-l="rm-tile"><span class="x" data-l="rm-x"></span>A brand</button>
          <button class="tile picked" data-l="rm-tile-picked"><span class="x" data-l="rm-x-picked"></span>A product</button></div>
        <input data-l="rm-input" placeholder="Your name">
        <div class="foot" data-l="rm-foot"><button class="back" data-l="rm-back">Back</button><span class="proof" data-l="rm-proof">1 of 5</span></div>
      </div>
      <div class="scr done" data-l="rm-done"><p class="q">Done</p><p class="sum" data-l="rm-sum">Here is <b data-l="rm-sum-b">your</b> roadmap.</p>
        <div class="first" data-l="rm-first"><span class="lab" data-l="rm-lab">First step</span>Do this.</div>
        <a class="btn" href="#" data-l="rm-btn">Go ${ARROW}</a></div>
      <div class="greet" data-l="rm-greet"><p class="eyebrow" data-l="rm-greet-eyebrow">Welcome</p><h2 data-l="rm-greet-h2">Hello</h2>
        <p class="line" data-l="rm-line">One line.</p><p class="fine" data-l="rm-greet-fine">No spam.</p>
        <div class="faces" data-l="rm-greet-faces"><img src="${PX}" alt=""></div></div>
    </div></section>
    <section class="__INK__" data-mod="roadmap-dark"><div class="wrap"><div class="rm" data-contrast="dark" data-l="rm-dark">
      <div class="tiles"><button class="tile" data-l="rm-dark-tile"><span class="x"></span>On ink</button></div>
      <div class="greet"><p class="eyebrow" data-l="rm-dark-eyebrow">Welcome</p></div></div></div></section>`,
  footer: `<footer class="foot" data-mod="footer"><div class="wrap">
      <div class="cols" data-l="foot-cols">
        <div><img class="lk" src="${PX}" alt="" data-l="foot-lk"><p class="tag" data-l="foot-tag">A tagline that runs on.</p></div>
        <div><h4 data-l="foot-h4">Column</h4><ul><li data-l="foot-li"><a href="#" data-l="foot-a">A link</a></li></ul></div>
        <div><h4>Column</h4><ul><li><a href="#">A link</a></li></ul></div>
        <div><h4>Column</h4><ul><li><a href="#">A link</a></li></ul></div></div>
      <div class="bar" data-l="foot-bar"><span>© 2026</span><span>Terms</span></div></div></footer>`,
  wall: `<section class="wrap" data-mod="wall"><div class="wall" data-l="wall">
      <img src="${PX}" alt="" data-l="wall-img"><img src="${PX}" alt=""><img src="${PX}" alt=""></div>
      <span class="stars" data-l="stars"><svg viewBox="0 0 24 24" data-l="stars-svg"><path d="M12 2l3 7h7l-5 4 2 7-7-4-7 4 2-7-5-4h7z"/></svg></span></section>`,
  marquee: `<section data-mod="marquee"><div class="marq" data-l="marq"><div class="track" data-l="marq-track">
      <img src="${PX}" alt="" data-l="marq-img"><img src="${PX}" alt=""></div></div>
      <div class="marq rev" data-l="marq-rev"><div class="track" data-l="marq-rev-track"><img src="${PX}" alt=""></div></div></section>`,
  motion: `<section class="wrap" data-mod="motion"><div class="rise" data-l="rise">Reveal</div>
      <div class="rise in" data-l="rise-in">Revealed</div></section>`
};

// The same set again inside the ink surface, so every .on-ink flip is measured.
function inkBlock(inkClass) {
  return `<section class="${inkClass}" data-mod="on-ink"><div class="wrap">
      <p class="eyebrow" data-l="ink-eyebrow">Eyebrow</p>
      <p class="lead" data-l="ink-lead">A lead on ink.</p>
      <p class="fine" data-l="ink-fine">Fine print</p>
      <nav class="nav"><ul><li><a href="#" data-l="ink-nav-a">Work</a></li></ul></nav>
      <a class="btn paper" href="#" data-l="ink-btn-paper">Paper ${ARROW}</a>
      <a class="btn ghost" href="#" data-l="ink-btn-ghost">Ghost ${ARROW}</a>
      <div class="faces" data-l="ink-faces"><img src="${PX}" alt="" data-l="ink-faces-img"></div>
      <p class="by" data-l="ink-by"><b data-l="ink-by-b">A name</b> and a role</p>
    </div></section>`;
}

export function harnessHtml(order, inkClass, cssHref) {
  // __INK__ is the ink surface class, which is brand-blind and comes from the
  // pack. A dark-contrast widget is only ever used on an ink section, so the
  // harness has to put it on one — measuring it on the page ground reports a
  // 1:1 contrast that no real page has.
  const body = (order.map((n) => BLOCKS[n] || '').join('\n') + '\n' + inkBlock(inkClass)).split('__INK__').join(inkClass);
  return `<!doctype html><html class="js"><head><meta charset="utf-8">
<title>kit harness</title>
<link rel="stylesheet" href="${cssHref}">
</head><body>
${body}
<div id="fontprobe" style="position:absolute;left:-9999px;top:0">
  <span id="probe-brand">Handgloves 0123456789</span>
  <span id="probe-fallback" style="font-family:'__no_such_face__',Arial,sans-serif">Handgloves 0123456789</span>
</div>
</body></html>`;
}

// ---------------------------------------------------------------- the run

const HOVER_TARGETS = ['btn', 'btn-paper', 'btn-ghost', 'ink-btn-paper', 'ink-btn-ghost', 'card', 'rm-tile'];

async function serve(dir) {
  const http = await import('node:http');
  const types = { '.css': 'text/css', '.html': 'text/html; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

async function measure(page, url, props) {
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.evaluate(async () => { try { await document.fonts.ready; } catch (e) {} });

  // The marquee runs for 48s and never stops, so `transform` is a moving target:
  // two page loads a second apart read two different matrices and the comparison
  // reports a difference that is only the clock. Pin every animation to time zero
  // — deterministic on both pages, and it leaves animation-name/duration/direction
  // alone because those come from the cascade, not the playback.
  await page.evaluate(() => {
    for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = 0; } catch (e) {} }
  });

  // ---- the font proof, before anything else is believed ---------------------
  const font = await page.evaluate(() => {
    const brand = document.getElementById('probe-brand');
    const fallback = document.getElementById('probe-fallback');
    const stack = getComputedStyle(brand).fontFamily;
    const first = (stack.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
    const loaded = [...document.fonts].map((f) => `${f.family} ${f.weight} ${f.status}`);
    let check = false;
    try { check = document.fonts.check(`400 16px "${first}"`); } catch (e) {}
    return {
      declaredFirstFamily: first,
      stack,
      fontFaceEntries: loaded,
      familyLoaded: loaded.some((f) => f.toLowerCase().startsWith(first.toLowerCase() + ' ') && /loaded/.test(f)),
      fontsCheck: check,
      brandWidth: brand.getBoundingClientRect().width,
      fallbackWidth: fallback.getBoundingClientRect().width
    };
  });
  font.distinctFromFallback = Math.abs(font.brandWidth - font.fallbackWidth) > 0.5;
  font.proved = font.fontsCheck && font.familyLoaded && font.distinctFromFallback;

  // ---- rest state -----------------------------------------------------------
  const rest = await page.evaluate((PROPS) => {
    const out = [];
    document.querySelectorAll('body *').forEach((el, i) => {
      if (el.closest('#fontprobe')) return;
      const cs = getComputedStyle(el);
      const vals = {};
      for (const p of PROPS) vals[p] = cs.getPropertyValue(p);
      out.push({
        i,
        label: el.getAttribute('data-l') || '',
        tag: el.tagName.toLowerCase(),
        cls: el.getAttribute('class') || '',
        vals
      });
    });
    return out;
  }, props);

  // ---- freeze, then hover ---------------------------------------------------
  await page.addStyleTag({ content: '*{animation-play-state:paused!important;transition:none!important}' });
  const hover = [];
  for (const label of HOVER_TARGETS) {
    const sel = `[data-l="${label}"]`;
    if (!(await page.$(sel))) continue;
    await page.hover(sel);
    const shot = await page.evaluate((args) => {
      const [s, PROPS] = args;
      const root = document.querySelector(s);
      const grab = (el, tag) => {
        const cs = getComputedStyle(el);
        const vals = {};
        for (const p of PROPS) vals[p] = cs.getPropertyValue(p);
        return { part: tag, vals };
      };
      const parts = [grab(root, 'self')];
      const before = getComputedStyle(root, '::before');
      const bv = {};
      for (const p of PROPS) bv[p] = before.getPropertyValue(p);
      parts.push({ part: '::before', vals: bv });
      const circ = root.querySelector('.circ');
      if (circ) {
        parts.push(grab(circ, '.circ'));
        const cb = getComputedStyle(circ, '::before');
        const cbv = {};
        for (const p of PROPS) cbv[p] = cb.getPropertyValue(p);
        parts.push({ part: '.circ::before', vals: cbv });
        const svg = circ.querySelector('svg');
        if (svg) parts.push(grab(svg, '.circ svg'));
      }
      const go = root.querySelector('.go svg');
      if (go) parts.push(grab(go, '.go svg'));
      const x = root.querySelector('.x');
      if (x) parts.push(grab(x, '.x'));
      return parts;
    }, [sel, props]);
    for (const p of shot) hover.push({ label, ...p });
    await page.mouse.move(0, 0);
  }
  return { font, rest, hover };
}


// ---------------------------------------------------------------- LEVEL 2, DARK
//
// Ruling 66 turned the scheme into a pack value, so the kit now carries a second
// rendering the reference file has never had. Level 1 cannot say a word about it
// — it diffs against a stylesheet with no dark blocks in it — and the light
// comparison above cannot either, because in a light browser the new blocks do
// not apply at all. So the dark rendering is measured on its own terms:
//
//   1. the six remapped tokens resolve to their dark values
//   2. the ladder tokens and the accent hold
//   3. every text/background pair still clears WCAG AA
//   4. what .on-ink actually computes to on a page that is already dark
//
// (4) is the open question the pack records at outputs.web.dark.openQuestion and
// this file does NOT try to answer. It measures it, prints the number, and stops.

// Composite a possibly-translucent colour over an opaque one, then WCAG.
const CONTRAST_FN = `
  function parseC(c){
    if(!c||c==='transparent') return {r:0,g:0,b:0,a:0};
    const m=String(c).match(/rgba?\\(([^)]+)\\)/); if(!m) return null;
    const p=m[1].split(',').map(x=>parseFloat(x));
    return {r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1};
  }
  function over(fg,bg){
    const a=fg.a; return {r:fg.r*a+bg.r*(1-a), g:fg.g*a+bg.g*(1-a), b:fg.b*a+bg.b*(1-a), a:1};
  }
  function lum(c){const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};
    return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b);}
  function ratio(a,b){const L1=lum(a),L2=lum(b);const hi=Math.max(L1,L2),lo=Math.min(L1,L2);
    return (hi+0.05)/(lo+0.05);}
  function hex(c){const h=v=>Math.round(v).toString(16).padStart(2,'0');return '#'+h(c.r)+h(c.g)+h(c.b);}
  // The ground an element actually sits on: walk up compositing background-colour
  // until something opaque. Records whether a gradient sits in that stack, because
  // a ratio against the flat layer alone is only part of the truth there.
  function ground(el){
    let node=el, stack=[], gradient=null;
    while(node){
      const cs=getComputedStyle(node);
      const bg=parseC(cs.backgroundColor);
      if(cs.backgroundImage && cs.backgroundImage!=='none' && !gradient)
        gradient=node===el?'own':(node.getAttribute('data-l')||node.tagName.toLowerCase());
      if(bg && bg.a>0) stack.push(bg);
      if(bg && bg.a===1) return {color:stack.reduceRight((acc,c)=>acc?over(c,acc):c,null), gradient, found:true};
      node=node.parentElement;
    }
    const base={r:255,g:255,b:255,a:1};
    return {color:stack.reduceRight((acc,c)=>over(c,acc),base), gradient, found:false};
  }
`;

async function measureScheme(page, url, themeAttr = null, discArrow = []) {
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.evaluate((t) => {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }, themeAttr);
  await page.evaluate(async () => { try { await document.fonts.ready; } catch (e) {} });
  await page.evaluate(() => { for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = 0; } catch (e) {} } });

  return page.evaluate(new Function('PAIRS', `
    ${CONTRAST_FN}
    const root = getComputedStyle(document.documentElement);
    const tokens = {};
    for (const s of document.styleSheets) {
      let rules; try { rules = s.cssRules; } catch(e) { continue; }
      for (const r of rules||[]) {
        const grab = (st) => { for (const p of st) if (p.startsWith('--')) tokens[p] = root.getPropertyValue(p).trim(); };
        if (r.style) grab(r.style);
        if (r.cssRules) for (const rr of r.cssRules) if (rr.style) grab(rr.style);
      }
    }

    // ---- WCAG AA over every element that actually carries text -------------
    const pairs = [];
    document.querySelectorAll('body *').forEach((el, ix) => {
      if (el.closest('#fontprobe')) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
      // A bare <path> tells nobody anything, so an unlabelled node borrows the
      // nearest labelled ancestor. ix is document order and is the same on both
      // renders, which is what lets a dark failure be matched to its light twin.
      const own = el.getAttribute('data-l');
      const near = own || (el.closest('[data-l]') ? el.closest('[data-l]').getAttribute('data-l') + ' > ' + el.tagName.toLowerCase() : el.tagName.toLowerCase());
      const label = near;
      const g = ground(el);
      if (!g.color) return;

      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim().length);
      if (hasText) {
        const fg = parseC(cs.color);
        if (fg && fg.a > 0) {
          const size = parseFloat(cs.fontSize);
          const weight = parseInt(cs.fontWeight, 10) || 400;
          const large = size >= 24 || (size >= 18.66 && weight >= 700);
          const composited = over(fg, g.color);
          pairs.push({
            ix, kind: 'text', label, sample: [...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.nodeValue.trim()).join(' ').slice(0,24),
            fg: cs.color, bg: hex(g.color), gradient: g.gradient,
            size: Math.round(size*10)/10, weight, large,
            need: large ? 3 : 4.5, got: Math.round(ratio(composited, g.color)*100)/100
          });
        }
      }
      if (el.namespaceURI === 'http://www.w3.org/2000/svg' && cs.stroke && cs.stroke !== 'none') {
        const st = parseC(cs.stroke);
        if (st && st.a > 0) {
          pairs.push({
            ix, kind: 'svg stroke', label, sample: el.tagName,
            fg: cs.stroke, bg: hex(g.color), gradient: g.gradient,
            size: parseFloat(cs.strokeWidth) || null, weight: null, large: true,
            need: 3, got: Math.round(ratio(over(st, g.color), g.color)*100)/100
          });
        }
      }
    });

    // ---- the open question: what does .on-ink compute to here? -------------
    const inkSection = document.querySelector('[data-mod="on-ink"]');
    const pageGround = ground(document.body);
    const onInk = inkSection ? (() => {
      const g = ground(inkSection);
      const own = getComputedStyle(inkSection).backgroundColor;
      const texts = {};
      for (const l of ['ink-eyebrow','ink-lead','ink-fine','ink-by-b','ink-nav-a']) {
        const e = inkSection.querySelector('[data-l="'+l+'"]');
        if (e) texts[l] = { color: getComputedStyle(e).color, on: hex(ground(e).color) };
      }
      return {
        ownBackground: own,
        ground: hex(g.color),
        page: hex(pageGround.color),
        separates: hex(g.color) !== hex(pageGround.color),
        ratioAgainstPage: Math.round(ratio(g.color, pageGround.color)*10000)/10000,
        texts
      };
    })() : null;

    // ---- RULING 69: the disc/arrow law, measured in the browser ------------
    //
    // The emitter measures the same pairs off the emitted values. This is the
    // SECOND, independent instrument: the real cascade, in a real engine, at the
    // real OS preference. Two measurements from two sources or it does not count.
    const discArrow = (PAIRS || []).map((p) => {
      const disc = document.querySelector(p.discSel);
      const arrow = disc ? disc.querySelector('svg') : null;
      if (!disc || !arrow) return { ...p, found: false };
      const dg = ground(disc);
      const st = parseC(getComputedStyle(arrow).stroke);
      if (!dg.color || !st) return { ...p, found: false };
      return {
        ...p, found: true,
        disc: hex(dg.color),
        arrow: hex(over(st, dg.color)),
        same: hex(over(st, dg.color)) === hex(dg.color),
        ratio: Math.round(ratio(over(st, dg.color), dg.color) * 100) / 100
      };
    });

    return { tokens, pairs, onInk, discArrow, page: hex(pageGround.color) };
  `), discArrow);
}


// Ruling 66 says an explicit choice wins in BOTH directions, which is a claim
// about the cascade, not about the text of the file. So it gets driven: every
// combination of OS preference and reader choice is loaded and the tokens read
// back. `expect` is which side of the remap should win in that cell.
export function schemeMatrix(scheme) {
  if (scheme === 'system') {
    return [
      { name: 'OS light, no choice', os: 'light', attr: null, expect: 'light' },
      { name: 'OS dark, no choice', os: 'dark', attr: null, expect: 'dark' },
      { name: 'OS light, reader chose dark', os: 'light', attr: 'dark', expect: 'dark' },
      { name: 'OS dark, reader chose light', os: 'dark', attr: 'light', expect: 'light' }
    ];
  }
  return [
    { name: 'OS light, no choice', os: 'light', attr: null, expect: 'dark' },
    { name: 'OS dark, no choice', os: 'dark', attr: null, expect: 'dark' },
    { name: 'OS light, reader chose light', os: 'light', attr: 'light', expect: 'light' },
    { name: 'OS dark, reader chose light', os: 'dark', attr: 'light', expect: 'light' }
  ];
}

// The dark half of level 2, as a report. Three assertions and one measurement.
// The measurement (.on-ink) is deliberately not an assertion: the pack records
// it as an open question for Andrew, so this prints the number and rules nothing.
function darkReport({ LIGHT, CELLS, model, remap, scheme }) {
  const out = [`LEVEL 2, DARK — the emitted kit driven through every scheme cell (scheme "${scheme}")`];
  let ok = true;

  const cellOf = (expect, attr) => CELLS.find((c) => c.expect === expect && c.attr === attr) || CELLS.find((c) => c.expect === expect);
  const ASK_DARK = cellOf('dark', null);
  const ASK_LIGHT = cellOf('light', scheme === 'dark' ? 'light' : null);
  const DARK = ASK_DARK.m;
  const EMITLIGHT = ASK_LIGHT.m;

  // ---- 0. the cascade: does an explicit choice win in both directions? -----
  //
  // Ruling 66's third clause is a claim about the cascade, so it gets driven
  // rather than read off the file. Each cell is a real page load at that OS
  // preference with that data-theme, and the tokens are read back.
  out.push('', '  0. THE CASCADE — every combination of OS preference and reader choice, loaded');
  const cellRows = [];
  for (const c of CELLS) {
    const wrong = Object.entries(remap).filter(([t, e]) => !rgbEq((c.m.tokens[t] || '').trim(), e[c.expect]));
    if (wrong.length) ok = false;
    cellRows.push([
      c.name,
      `prefers ${c.os}`,
      c.attr ? `data-theme="${c.attr}"` : '(none)',
      c.expect,
      wrong.length ? `WRONG: ${wrong.map(([t]) => t).join(' ')}` : 'all six correct'
    ]);
  }
  out.push(col(['cell', 'OS', 'reader choice', 'must render', 'result'], [28, 14, 18, 12, 30], cellRows));

  // ---- 1. the remapped tokens flip -----------------------------------------
  const flipRows = [];
  for (const [token, e] of Object.entries(remap)) {
    const light = (EMITLIGHT.tokens[token] || '').trim();
    const dark = (DARK.tokens[token] || '').trim();
    const good = rgbEq(dark, e.dark) && rgbEq(light, e.light);
    if (!good) ok = false;
    flipRows.push([token, e.dark, light, dark, good ? 'flipped' : `resolved ${dark || '(nothing)'}`]);
  }
  out.push('', '  1. THE SIX REMAPPED TOKENS, resolved in the browser');
  out.push(col(['token', 'pack says (dark)', 'light render', 'dark render', 'verdict'], [10, 24, 24, 24, 26], flipRows));

  // ---- 2. the ladder and the accent hold -----------------------------------
  const holds = [
    ...Object.values(model.ladder).map((l) => l.cssVar),
    model.roles.accentPrimary
  ].filter((v, i2, a) => v && a.indexOf(v) === i2);
  const holdRows = [];
  for (const token of holds) {
    const light = (EMITLIGHT.tokens[token] || '').trim();
    const dark = (DARK.tokens[token] || '').trim();
    const held = light === dark && light !== '';
    if (!held) ok = false;
    holdRows.push([token, light, dark, held ? 'held' : 'MOVED']);
  }
  out.push('', '  2. THE LADDER AND THE ACCENT — these must not move');
  out.push(col(['token', 'light render', 'dark render', 'verdict'], [10, 24, 24, 10], holdRows));

  // ---- 3. WCAG AA in dark ---------------------------------------------------
  //
  // Split into PRE-EXISTING (already failing on the reference kit in light) and
  // NEW IN DARK (the scheme did it). Only the second kind is ruling 66's to
  // answer for, and lumping them together would hide both.
  const fails = DARK.pairs.filter((p) => p.got < p.need);
  const lightFails = LIGHT.pairs.filter((p) => p.got < p.need);
  const lightById = new Map(LIGHT.pairs.map((p) => [`${p.ix}|${p.kind}`, p]));
  const isNew = (p) => {
    const twin = lightById.get(`${p.ix}|${p.kind}`);
    return !twin || twin.got >= twin.need;
  };
  const newFails = fails.filter(isNew);
  const carried = fails.filter((p) => !isNew(p));

  // Name a computed colour by the token that holds it, so a wall of rgb() reads
  // as the design decision underneath it.
  // Every token holding this colour, not just the first. Two tokens resolving to
  // one value is exactly what the remap does, and hiding it behind whichever name
  // came first would hide the finding.
  const label = (tokens, css) => {
    const hits = Object.entries(tokens).filter(([k, v]) => k.startsWith('--') && rgbEq(v, css)).map(([k]) => k);
    return hits.length ? hits.slice(0, 3).join('/') : css;
  };

  out.push('', '  3. WCAG AA — every text/background pair and every SVG stroke, on the dark render');
  out.push(`     pairs measured ${DARK.pairs.length}  ·  clearing AA ${DARK.pairs.length - fails.length}  ·  failing ${fails.length}`);
  out.push(`     of those: ${newFails.length} NEW IN DARK, ${carried.length} already failing on the same page in light`);

  const grouped = (list) => {
    const g = new Map();
    for (const p of list) {
      const k = `${p.fg}|${p.bg}|${p.need}`;
      if (!g.has(k)) g.set(k, { fg: p.fg, bg: p.bg, need: p.need, got: p.got, n: 0, eg: [] });
      const e = g.get(k);
      e.n++; e.got = Math.min(e.got, p.got);
      if (e.eg.length < 3) e.eg.push(p.label);
    }
    return [...g.values()].sort((a, b) => a.got - b.got);
  };

  if (newFails.length) {
    out.push('', '     NEW IN DARK — distinct colour pairs, worst first');
    out.push(col(['text colour', 'on ground', 'need', 'got', 'n', 'where'], [36, 30, 5, 6, 4, 44],
      grouped(newFails).map((g) => [
        `${label(DARK.tokens, g.fg)}  ${g.fg}`,
        `${label(DARK.tokens, g.bg)}  ${g.bg}`,
        String(g.need), String(g.got), String(g.n), g.eg.join(', ')
      ])));
  }
  if (carried.length) {
    out.push('', '     ALREADY FAILING IN LIGHT — not ruling 66\'s doing, but real');
    out.push(col(['text colour', 'on ground', 'need', 'got', 'n', 'where'], [36, 30, 5, 6, 4, 44],
      grouped(carried).map((g) => [
        `${label(DARK.tokens, g.fg)}  ${g.fg}`,
        `${label(DARK.tokens, g.bg)}  ${g.bg}`,
        String(g.need), String(g.got), String(g.n), g.eg.join(', ')
      ])));
  }
  if (lightFails.length) {
    out.push('', '     THE LIGHT RENDER, for the record — pairs failing AA with no dark block in play');
    out.push(col(['text colour', 'on ground', 'need', 'got', 'n', 'where'], [36, 30, 5, 6, 4, 44],
      grouped(lightFails).map((g) => [
        `${label(LIGHT.tokens, g.fg)}  ${g.fg}`,
        `${label(LIGHT.tokens, g.bg)}  ${g.bg}`,
        String(g.need), String(g.got), String(g.n), g.eg.join(', ')
      ])));
  }
  if (!fails.length) out.push('     (none — every pair clears AA on the dark render)');
  else {
    out.push('');
    out.push('     A failure here is a finding about the DESIGN, not a bug in the emitter. The remap');
    out.push('     applies values the kit already ships, so a pair that fails in dark fails because of');
    out.push('     what those values are and where the kit uses them. Andrew rules it before this ships.');
  }

  // ---- 3b. THE DISC/ARROW LAW, measured in the browser ----------------------
  //
  // RULING 69: an arrow's colour follows its DISC, never the page. The emitter
  // measures this off its own values; this measures it again in a real engine at
  // a real OS preference, which is the only instrument that can see the cascade.
  // Asserted, not merely printed: the ghost-on-ink pair was 1:1 before the fix.
  let lawOk = true;
  const law = DARK.discArrow || [];
  if (law.length) {
    out.push('', '  3b. THE DISC/ARROW LAW — each disc and ITS arrow, on the dark render');
    const rows = law.map((p) => {
      const bad = !p.found || p.same || p.ratio < 3;
      if (bad) { ok = false; lawOk = false; }
      return [p.name, p.discSel, p.found ? p.disc : '(not found)', p.found ? p.arrow : '—',
        p.found ? `${p.ratio}:1` : '—',
        !p.found ? 'THE HARNESS HAS NO SUCH ELEMENT' : p.same ? 'SAME COLOUR — the arrow vanished into its disc' : p.ratio < 3 ? 'FAIL, under 3:1' : 'differ, clears 3:1'];
    });
    out.push(col(['variant', 'disc selector', 'disc', 'arrow', 'ratio', 'verdict'], [22, 30, 10, 10, 9, 44], rows));
    out.push(`     ${lawOk ? 'PASS — every disc and its arrow differ and clear 3:1 in dark.' : 'FAIL — a disc and its arrow do not read against each other in dark.'}`);
  }

  // ---- 4. the open question, measured --------------------------------------
  out.push('', '  4. .on-ink ON A DARK PAGE — the open question at outputs.web.dark.openQuestion');
  const rowsOI = [];
  for (const [name, m] of [['light', LIGHT.onInk], ['dark', DARK.onInk]]) {
    if (!m) continue;
    rowsOI.push([name, m.ground, m.page, m.separates ? 'yes' : 'NO — same colour', String(m.ratioAgainstPage)]);
  }
  out.push(col(['render', '.on-ink ground', 'page ground', 'separates?', 'contrast'], [8, 16, 14, 18, 9], rowsOI));
  if (DARK.onInk) {
    out.push('');
    out.push(col(['.on-ink text', 'colour', 'sits on'], [16, 26, 12],
      Object.entries(DARK.onInk.texts).map(([k, v]) => [k, v.color, v.on])));
    out.push(DARK.onInk.separates
      ? '     .on-ink still reads as a break on a dark page.'
      : `     .on-ink and the page ground compute to the SAME colour (${DARK.onInk.ground}), contrast ${DARK.onInk.ratioAgainstPage}:1.`);
    out.push('     NOT RULED HERE. The pack lists two options (let .on-ink go no-op and lean on');
    out.push('     --card/--band, or give it a raised value in dark) and names Andrew as who rules it.');
  }

  out.push('', `  LEVEL 2 DARK — TOKENS: ${ok ? 'PASS, the six flip and the ladder plus the accent hold' : 'FAIL, a token did not resolve as the remap states'}`);
  out.push(`  LEVEL 2 DARK — CONTRAST: ${newFails.length
    ? `${newFails.length} pair(s) NEW IN DARK fail WCAG AA. UNRULED DESIGN FINDING, not an emitter fault.`
    : 'no new WCAG AA failure in dark.'}`);
  out.push(`  LEVEL 2 DARK — DISC/ARROW: ${law.length ? (lawOk ? `PASS, all ${law.length} pair(s) differ and clear 3:1` : 'FAIL, an arrow does not read on its own disc') : 'not measured — the emitter passed no pairs.'}`);
  out.push(`  LEVEL 2 DARK — .on-ink: ${DARK.onInk ? (DARK.onInk.separates ? 'still separates from the page ground.' : `computes to the SAME colour as the page ground (${DARK.onInk.ground}), 1:1. UNRULED, measured only.`) : 'not measured.'}`);
  return { ok, report: out.join('\n'), fails, newFails, onInk: DARK.onInk };
}

// A hex and an rgb() spelling of one colour are the same colour. Compare as numbers.
function rgbEq(a, b) {
  const norm = (c) => {
    const t = String(c).trim();
    const m = t.match(/rgba?\(([^)]+)\)/);
    if (m) { const p = m[1].split(',').map((x) => parseFloat(x)); return `${Math.round(p[0])},${Math.round(p[1])},${Math.round(p[2])},${p.length > 3 ? p[3] : 1}`; }
    const h = t.replace('#', '');
    if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(h)) return t.toLowerCase();
    const f = h.length === 3 ? h.split('').map((c2) => c2 + c2).join('') : h;
    return `${parseInt(f.slice(0, 2), 16)},${parseInt(f.slice(2, 4), 16)},${parseInt(f.slice(4, 6), 16)},1`;
  };
  return norm(a) === norm(b);
}

function col(heads, widths, rows) {
  const cut = (s, w) => (String(s ?? '').length > w ? String(s).slice(0, w - 1) + '…' : String(s ?? ''));
  const lines = ['  ' + heads.map((h, i) => h.padEnd(widths[i])).join('  ')];
  lines.push('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push('  ' + r.map((c, i) => cut(c, widths[i]).padEnd(widths[i])).join('  '));
  return lines.join('\n');
}

export async function run({ emittedCss, targetCss, schemeCss = null, model, scheme = 'light', remap = null, discArrow = [] }) {
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer')).default;
  } catch (e) {
    return { ok: false, report: 'LEVEL 2 — SKIPPED: puppeteer is not installed in this tree.\n  Install it with `npm i -D puppeteer` and re-run with --computed.' };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbe-kit-'));
  fs.writeFileSync(path.join(dir, 'target.css'), targetCss);
  fs.writeFileSync(path.join(dir, 'emitted.css'), emittedCss);
  const order = model.order;
  fs.writeFileSync(path.join(dir, 'target.html'), harnessHtml(order, model.inkClass, 'target.css'));
  fs.writeFileSync(path.join(dir, 'emitted.html'), harnessHtml(order, model.inkClass, 'emitted.css'));
  if (schemeCss) {
    fs.writeFileSync(path.join(dir, 'scheme.css'), schemeCss);
    fs.writeFileSync(path.join(dir, 'scheme.html'), harnessHtml(order, model.inkClass, 'scheme.css'));
  }

  const { server, port } = await serve(dir);
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let A, B, LIGHT = null, CELLS = null;
  const wantDark = scheme !== 'light' && !!remap && !!schemeCss;
  try {
    const page = await browser.newPage();
    // Viewport with setViewport, never a --window-size flag: headless Chrome
    // refuses to lay out narrower than ~500px that way.
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    // Pin the scheme for the reference comparison instead of trusting the
    // headless default. The emitted file now carries dark blocks; if the browser
    // came up in dark the two pages would be compared in different schemes and
    // every difference would be the emulation, not the emitter.
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    A = await measure(page, `http://127.0.0.1:${port}/target.html`, PROPS);
    B = await measure(page, `http://127.0.0.1:${port}/emitted.html`, PROPS);

    if (wantDark) {
      // The WCAG baseline is measured on the REFERENCE kit, so "this pair was
      // already failing" is a claim about the live stylesheet rather than about
      // our own output. (The comparison above has just proved the two render
      // identically in light, so this costs a page load and buys honesty.)
      LIGHT = await measureScheme(page, `http://127.0.0.1:${port}/target.html`, null, discArrow);

      // Then drive the whole matrix on the file this run actually emits.
      CELLS = [];
      for (const cell of schemeMatrix(scheme)) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: cell.os }]);
        CELLS.push({ ...cell, m: await measureScheme(page, `http://127.0.0.1:${port}/scheme.html`, cell.attr, discArrow) });
      }
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
    }
  } finally {
    await browser.close();
    server.close();
  }

  // ---- compare ---------------------------------------------------------------
  const rows = [];
  const n = Math.min(A.rest.length, B.rest.length);
  for (let i = 0; i < n; i++) {
    const a = A.rest[i], b = B.rest[i];
    const who = a.label || `${a.tag}${a.cls ? '.' + a.cls.split(' ').join('.') : ''}`;
    for (const p of PROPS) {
      if (a.vals[p] !== b.vals[p]) rows.push({ el: who, state: 'rest', prop: p, t: a.vals[p], e: b.vals[p] });
    }
  }
  const hn = Math.min(A.hover.length, B.hover.length);
  for (let i = 0; i < hn; i++) {
    const a = A.hover[i], b = B.hover[i];
    for (const p of PROPS) {
      if (a.vals[p] !== b.vals[p]) rows.push({ el: `${a.label} ${a.part}`, state: 'hover', prop: p, t: a.vals[p], e: b.vals[p] });
    }
  }

  const trunc = (s, n2 = 46) => (String(s).length > n2 ? String(s).slice(0, n2 - 1) + '…' : String(s));
  const out = ['LEVEL 2 — computed styles, headless Chrome, viewport 1440x1000'];
  out.push(`  elements measured : ${A.rest.length} target / ${B.rest.length} emitted`);
  out.push(`  hover shots       : ${A.hover.length} target / ${B.hover.length} emitted`);
  out.push(`  properties/element: ${PROPS.length}`);
  out.push(`  comparisons       : ${(n + hn) * PROPS.length}`);

  const fontLines = [];
  for (const [name, m] of [['target', A.font], ['emitted', B.font]]) {
    fontLines.push(`  ${name.padEnd(8)} declared "${m.declaredFirstFamily}" · document.fonts.check ${m.fontsCheck ? 'PASS' : 'FAIL'} · @font-face loaded ${m.familyLoaded ? 'YES' : 'NO'} · width vs forced fallback ${m.brandWidth.toFixed(1)} vs ${m.fallbackWidth.toFixed(1)} -> ${m.distinctFromFallback ? 'DIFFERENT (real face)' : 'IDENTICAL (silent fallback)'}`);
  }
  const fontOk = A.font.proved && B.font.proved;
  out.push('\n  FONT PROOF — did the brand face actually load, on both pages?');
  out.push(...fontLines);
  out.push(`  ${fontOk ? 'PROVED: both pages rendered in the brand face, so the comparison below is meaningful.' : 'NOT PROVED: at least one page fell back. Every computed-style result below is worthless.'}`);
  if (A.font.fontFaceEntries.length) out.push(`  faces present: ${A.font.fontFaceEntries.slice(0, 8).join(' | ')}${A.font.fontFaceEntries.length > 8 ? ` … +${A.font.fontFaceEntries.length - 8}` : ''}`);

  out.push('\n  DISAGREEMENTS');
  if (!rows.length) out.push('  (none)');
  else {
    const cols = [['element', 'el', 26], ['state', 'state', 5], ['property', 'prop', 26], ['target', 't', 46], ['emitted', 'e', 46]];
    out.push('  ' + cols.map(([h, , w]) => h.padEnd(w)).join('  '));
    out.push('  ' + cols.map(([, , w]) => '-'.repeat(w)).join('  '));
    for (const r of rows.slice(0, 200)) out.push('  ' + cols.map(([, k, w]) => trunc(r[k], w).padEnd(w)).join('  '));
    if (rows.length > 200) out.push(`  … and ${rows.length - 200} more`);
  }
  out.push(`\n  LEVEL 2 (light): ${rows.length === 0 && fontOk ? 'PASS — zero computed-style disagreements, brand face proved loaded on both pages' : `FAIL — ${rows.length} disagreement(s)${fontOk ? '' : ', and the font proof did not hold'}`}`);

  let darkOk = true;
  if (wantDark) {
    const d = darkReport({ LIGHT, CELLS, model, remap, scheme });
    darkOk = d.ok;
    out.push('', '='.repeat(78), d.report);
  }

  const ok = rows.length === 0 && fontOk && darkOk;
  return { ok, rows, cells: CELLS, light: LIGHT, font: { target: A.font, emitted: B.font }, report: out.join('\n') };
}
