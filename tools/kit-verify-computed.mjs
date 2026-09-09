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
    <section class="wrap" data-mod="roadmap-dark"><div class="rm" data-contrast="dark" data-l="rm-dark">
      <div class="tiles"><button class="tile" data-l="rm-dark-tile"><span class="x"></span>On ink</button></div>
      <div class="greet"><p class="eyebrow" data-l="rm-dark-eyebrow">Welcome</p></div></div></section>`,
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
  const body = order.map((n) => BLOCKS[n] || '').join('\n') + '\n' + inkBlock(inkClass);
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

export async function run({ emittedCss, targetCss, model }) {
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

  const { server, port } = await serve(dir);
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let A, B;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    A = await measure(page, `http://127.0.0.1:${port}/target.html`, PROPS);
    B = await measure(page, `http://127.0.0.1:${port}/emitted.html`, PROPS);
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
  out.push(`\n  LEVEL 2: ${rows.length === 0 && fontOk ? 'PASS — zero computed-style disagreements, brand face proved loaded on both pages' : `FAIL — ${rows.length} disagreement(s)${fontOk ? '' : ', and the font proof did not hold'}`}`);

  return { ok: rows.length === 0 && fontOk, rows, font: { target: A.font, emitted: B.font }, report: out.join('\n') };
}
