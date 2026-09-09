#!/usr/bin/env node
// bbe contrast — find light/dark colour failures on a RENDERED page.
//
// Why a browser and not a grep: the failure this exists to catch is a token
// that flips in one scheme and not the other. `--ink` goes pale in dark mode,
// `--paper` does not, and a rule that pairs them prints paper on paper. Nothing
// in the stylesheet text is wrong on its own. The defect only exists in the
// computed cascade, in one scheme, so the only instrument that can see it is a
// real engine rendering the page twice.
//
// Two independent checks:
//   A. CONTRAST     WCAG 2.1 ratio, per scheme, text AND svg stroke/fill.
//   B. HALF-WIRED   the same element compared across the two schemes. If the
//                   foreground changed and the background did not (or the
//                   reverse), a token got a dark value and its partner did not.
//                   Catches the bug class even when the contrast happens to
//                   survive, which is what makes it a gate rather than a check.
//
// Findings are grouped by ROOT CAUSE. One bad token that hits 200 nodes reads
// as one finding naming the token, not 200 rows nobody reads.
//
//   bbe contrast <url|file|glob> [--scheme light|dark|both]
//                                [--viewport 1440x1000]
//                                [--json <out>] [--fail-on <level>]
//
// Default --scheme both, default viewport 1440x1000, default --fail-on none
// (report only, exit 0) so it can run before anyone has fixed anything.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function usage(code = 0) {
  console.log(`bbe contrast <url|file|glob> [options]

  --scheme light|dark|both   which colour scheme(s) to render   (default: both)
  --viewport WxH             viewport in css px                 (default: 1440x1000)
  --json <path>              write the machine report here
  --fail-on <level>          contrast | halfwired | both | none (default: none)
  --quiet                    only print the summary line
  --max-examples <n>         example selectors per finding      (default: 3)
  --help

Exit code is 0 unless --fail-on names a category that produced findings.`);
  process.exit(code);
}

export function parseArgs(argv) {
  const opts = {
    targets: [],
    scheme: 'both',
    viewport: { width: 1440, height: 1000 },
    json: null,
    failOn: 'none',
    quiet: false,
    maxExamples: 3
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage(0);
    else if (a === '--scheme') opts.scheme = argv[++i];
    else if (a === '--json') opts.json = argv[++i];
    else if (a === '--fail-on') opts.failOn = argv[++i];
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--max-examples') opts.maxExamples = Number(argv[++i]);
    else if (a === '--viewport') {
      const m = String(argv[++i]).match(/^(\d+)\s*[xX*]\s*(\d+)$/);
      if (!m) { console.error('FAIL: --viewport wants WxH, e.g. 1440x1000'); process.exit(2); }
      opts.viewport = { width: Number(m[1]), height: Number(m[2]) };
    } else if (a.startsWith('-')) { console.error(`FAIL: unknown flag ${a}`); process.exit(2); }
    else opts.targets.push(a);
  }
  if (!['light', 'dark', 'both'].includes(opts.scheme)) {
    console.error('FAIL: --scheme wants light, dark or both'); process.exit(2);
  }
  if (!['contrast', 'halfwired', 'both', 'none'].includes(opts.failOn)) {
    console.error('FAIL: --fail-on wants contrast, halfwired, both or none'); process.exit(2);
  }
  return opts;
}

export const schemesFor = (s) => (s === 'both' ? ['light', 'dark'] : [s]);

// ---------------------------------------------------------------------------
// target resolution: a url stays a url, a path becomes file://, a glob expands
// ---------------------------------------------------------------------------

export function resolveTargets(list) {
  const out = [];
  for (const t of list) {
    if (/^https?:\/\//i.test(t)) { out.push({ url: t, label: t }); continue; }
    if (/^file:\/\//i.test(t)) { out.push({ url: t, label: t }); continue; }
    if (/[*?[]/.test(t)) {
      for (const f of expandGlob(t)) out.push({ url: pathToFileURL(f).href, label: f });
      continue;
    }
    const abs = path.resolve(t);
    if (!fs.existsSync(abs)) { console.error(`FAIL: no such file: ${abs}`); process.exit(2); }
    if (fs.statSync(abs).isDirectory()) {
      const idx = path.join(abs, 'index.html');
      if (!fs.existsSync(idx)) { console.error(`FAIL: directory has no index.html: ${abs}`); process.exit(2); }
      out.push({ url: pathToFileURL(idx).href, label: idx });
      continue;
    }
    out.push({ url: pathToFileURL(abs).href, label: abs });
  }
  return out;
}

// Small glob: supports **, * and ? on path segments. No brace expansion; the
// shell usually does that anyway, and a half-implemented brace is worse than none.
function expandGlob(pattern) {
  const abs = path.resolve(pattern);
  const parts = abs.split(path.sep).filter(Boolean);
  let dirs = [path.sep];
  let files = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const last = i === parts.length - 1;
    const next = [];
    if (seg === '**') {
      for (const d of dirs) { next.push(d); walkDirs(d, next); }
      dirs = next; continue;
    }
    const rx = segRegex(seg);
    for (const d of dirs) {
      let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!rx.test(e.name)) continue;
        const full = path.join(d, e.name);
        if (last && e.isFile()) files.push(full);
        else if (e.isDirectory()) next.push(full);
      }
    }
    if (!last) dirs = next;
  }
  return [...new Set(files)].sort();
}
function walkDirs(root, acc) {
  let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(root, e.name); acc.push(full); walkDirs(full, acc);
  }
}
function segRegex(seg) {
  return new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
}

// ---------------------------------------------------------------------------
// colour maths — exported because the self-test asserts against it directly
// ---------------------------------------------------------------------------

export function parseColor(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s === 'none' || s === 'currentcolor' || s === 'auto') return null;
  let m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.%]+))?\s*\)$/);
  if (m) {
    let a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  return null;
}

export const hex = (c) =>
  c == null ? null
    : '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('') +
      (c.a < 0.999 ? ` @${c.a.toFixed(2)}` : '');

// src over dst, both premultiplied out to straight rgb.
export function over(src, dst) {
  const a = src.a + dst.a * (1 - src.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const f = (s, d) => (s * src.a + d * dst.a * (1 - src.a)) / a;
  return { r: f(src.r, dst.r), g: f(src.g, dst.g), b: f(src.b, dst.b), a };
}

export function luminance({ r, g, b }) {
  const ch = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrastRatio(fg, bg) {
  const L1 = luminance(fg), L2 = luminance(bg);
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

// The threshold a pair has to clear. Large text and graphical objects get 3:1
// (WCAG 2.1 SC 1.4.3 and 1.4.11); everything else 4.5:1.
export function requiredRatio({ kind, fontSize, fontWeight }) {
  if (kind === 'stroke' || kind === 'fill') return 3;
  const px = Number(fontSize) || 0;
  const w = Number(fontWeight) || 400;
  if (px >= 24 || (px >= 18.66 && w >= 700)) return 3;
  return 4.5;
}

export const sameColor = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const x = parseColor(a), y = parseColor(b);
  if (!x || !y) return String(a) === String(b);
  return Math.abs(x.r - y.r) < 0.5 && Math.abs(x.g - y.g) < 0.5 &&
         Math.abs(x.b - y.b) < 0.5 && Math.abs(x.a - y.a) < 0.01;
};

// ---------------------------------------------------------------------------
// the scan
// ---------------------------------------------------------------------------

const PAGE_SRC = fs.readFileSync(path.join(HERE, 'contrast-page.js'), 'utf8');

// A stylesheet the page cannot read (CORS, or file:// with a linked sheet) has
// to be fetched here instead, or every finding on it loses its token name.
async function fetchSheet(href, pageUrl) {
  try {
    if (href.startsWith('file://')) return fs.readFileSync(fileURLToPath(href), 'utf8');
    const res = await fetch(href);
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

export async function scanPage(page, target, opts) {
  const schemes = schemesFor(opts.scheme);
  const notes = [];

  await page.setViewport({ ...opts.viewport, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: schemes[0] }]);

  const resp = await page.goto(target.url, { waitUntil: 'networkidle2', timeout: 45000 }).catch(e => { notes.push('navigation: ' + e.message); return null; });
  if (resp && resp.status() >= 400) notes.push(`http ${resp.status()}`);

  await page.evaluate(PAGE_SRC);
  await page.evaluate('window.__bbeFreeze()');

  // stylesheet inventory, then fill in the blocked ones from node
  const sheets = await page.evaluate('window.__bbeSheets()');
  for (const s of sheets) {
    if (!s.blocked) continue;
    if (!s.href) { notes.push('an inline stylesheet was unreadable'); continue; }
    const text = await fetchSheet(s.href, target.url);
    if (text == null) { notes.push(`stylesheet unreadable, tokens will be unnamed on it: ${s.href}`); continue; }
    s.cssText = text;
  }
  let idx = await page.evaluate((sh) => window.__bbeIndex(sh), sheets);
  // an @import the page could not read has to be fetched here and fed back in.
  // Its rules then land at the end of the index rather than where the import
  // sat, which only matters for ties at equal specificity.
  if (idx.blocked.length) {
    let added = 0;
    for (const href of idx.blocked) {
      const text = await fetchSheet(href, target.url);
      if (text == null) { notes.push(`imported stylesheet unreadable, tokens will be unnamed on it: ${href}`); continue; }
      sheets.push({ href, live: null, cssText: text, blocked: false }); added++;
    }
    if (added) idx = await page.evaluate((sh) => window.__bbeIndex(sh), sheets);
  }
  const ruleCount = idx.count;

  const byScheme = {};
  for (const scheme of schemes) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    // one frame so the restyle has actually landed before anything is read
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    byScheme[scheme] = await page.evaluate('window.__bbeWalk()');
    const un = await page.evaluate('window.__bbeUnmeasured');
    if (un && un.use && scheme === schemes[0]) {
      notes.push(`${un.use} <use> element(s) reference an external sprite; the ink is drawn by the referenced symbol, in another document, and was NOT measured`);
    }
  }

  return { target, schemes, ruleCount, byScheme, notes };
}

// ---------------------------------------------------------------------------
// check A: contrast
// ---------------------------------------------------------------------------

export function contrastFindings(byScheme) {
  const out = [];
  for (const [scheme, recs] of Object.entries(byScheme)) {
    for (const r of recs) {
      if (r.bgUnknown || !r.bg || !r.fg) continue;
      const fg = parseColor(r.fg), bgc = parseColor(r.bg);
      if (!fg || !bgc) continue;
      // a semi-transparent foreground is composited onto its own background
      const flat = fg.a < 0.999 ? over(fg, bgc) : fg;
      const ratio = contrastRatio(flat, bgc);
      const need = requiredRatio(r);
      if (ratio + 0.005 >= need) continue;
      out.push({ ...r, scheme, ratio: Math.round(ratio * 100) / 100, need });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// check B: the half-wired detector
//
// The same element, both schemes. If the foreground moved and the background
// did not, a token got a dark value and its partner did not. That is the whole
// bug class, and it fires even when the contrast survives, which is what makes
// this a gate and not a spot check.
// ---------------------------------------------------------------------------

export function halfWiredFindings(byScheme) {
  const light = byScheme.light, dark = byScheme.dark;
  if (!light || !dark) return [];
  const idx = new Map();
  for (const r of dark) idx.set(r.key + '|' + r.kind, r);

  const out = [];
  for (const L of light) {
    const D = idx.get(L.key + '|' + L.kind);
    if (!D || D.tag !== L.tag) continue;
    if (L.bgUnknown || D.bgUnknown || !L.bg || !D.bg || !L.fg || !D.fg) continue;
    // the canvas legitimately changes on its own; comparing against it invents
    // half-wired findings on every element that has no background of its own
    if (L.bgCanvasAssumed || D.bgCanvasAssumed) continue;

    const fgMoved = !sameColor(L.fg, D.fg);
    const bgMoved = !sameColor(L.bg, D.bg);
    if (fgMoved === bgMoved) continue;      // both moved, or neither: wired

    const lr = contrastRatio(parseColor(L.fg), parseColor(L.bg));
    const dr = contrastRatio(parseColor(D.fg), parseColor(D.bg));
    out.push({
      ...L,
      side: fgMoved ? 'foreground moved, background did not' : 'background moved, foreground did not',
      light: { fg: L.fg, bg: L.bg, ratio: Math.round(lr * 100) / 100 },
      dark:  { fg: D.fg, bg: D.bg, ratio: Math.round(dr * 100) / 100 },
      need: requiredRatio(L),
      stuckToken: fgMoved
        ? (L.bgRule && L.bgRule.tokens[0]) || null
        : (L.fgRule && L.fgRule.tokens[0]) || null,
      movedToken: fgMoved
        ? (L.fgRule && L.fgRule.tokens[0]) || null
        : (L.bgRule && L.bgRule.tokens[0]) || null
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// grouping — this is most of the value
//
// One bad token producing 200 failing nodes has to read as ONE finding that
// names the token, the rule, and the count. A list of 200 rows is noise nobody
// reads, and a report nobody reads is not a gate.
// ---------------------------------------------------------------------------

const tokenOf = (rule) => (rule && rule.tokens && rule.tokens.length) ? rule.tokens.join('+') : null;
const nameFor = (rule, literal) => tokenOf(rule) ? `var(${tokenOf(rule)})` : (literal || 'unknown');

export function groupContrast(findings, maxExamples = 3) {
  const groups = new Map();
  for (const f of findings) {
    const fgName = nameFor(f.fgRule, f.fg);
    const bgName = nameFor(f.bgRule, f.bg);
    const key = [f.scheme, f.kind, fgName, bgName, f.fgRule?.sel || '-', f.bgRule?.sel || '-'].join(' :: ');
    let g = groups.get(key);
    if (!g) {
      g = {
        type: 'contrast', key, scheme: f.scheme, kind: f.kind,
        fgName, bgName,
        fgRule: f.fgRule, bgRule: f.bgRule,
        need: f.need, worst: f.ratio, worstColors: { fg: f.fg, bg: f.bg }, bgStack: f.bgStack || [],
        count: 0, examples: [], onState: !!(f.fgRule?.state || f.bgRule?.state)
      };
      groups.set(key, g);
    }
    g.count++;
    if (f.ratio < g.worst) { g.worst = f.ratio; g.worstColors = { fg: f.fg, bg: f.bg }; }
    if (g.examples.length < maxExamples) g.examples.push({ sel: f.sel, sample: f.sample || '', ratio: f.ratio });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.worst - b.worst);
}

export function groupHalfWired(findings, maxExamples = 3) {
  const groups = new Map();
  for (const f of findings) {
    const fgName = nameFor(f.fgRule, f.light.fg);
    const bgName = nameFor(f.bgRule, f.light.bg);
    const key = [f.side, f.kind, fgName, bgName, f.fgRule?.sel || '-', f.bgRule?.sel || '-'].join(' :: ');
    let g = groups.get(key);
    if (!g) {
      g = {
        type: 'halfwired', key, side: f.side, kind: f.kind,
        fgName, bgName, fgRule: f.fgRule, bgRule: f.bgRule,
        stuckToken: f.stuckToken, movedToken: f.movedToken,
        light: f.light, dark: f.dark, need: f.need, bgStack: f.bgStack || [],
        worstRatio: Math.min(f.light.ratio, f.dark.ratio),
        count: 0, examples: [], onState: !!(f.fgRule?.state || f.bgRule?.state)
      };
      groups.set(key, g);
    }
    g.count++;
    const w = Math.min(f.light.ratio, f.dark.ratio);
    if (w < g.worstRatio) { g.worstRatio = w; g.light = f.light; g.dark = f.dark; }
    if (g.examples.length < maxExamples) g.examples.push({ sel: f.sel, sample: f.sample || '' });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.worstRatio - b.worstRatio);
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

const ruleLine = (r) => {
  if (!r) return '(no author rule found)';
  const where = r.href && r.href !== '(inline)' ? r.href.split('/').pop() : r.href;
  const media = r.media ? `  @media ${r.media}` : '';
  const state = r.state ? '  [state selector, e.g. :hover]' : '';
  return `${r.sel} { ${r.prop || '?'}: ${r.value} }   ${where}${media}${state}`;
};

// Across many pages the same bad rule shows up once per page, so a per-page
// report is still 50 copies of one finding. The rollup collapses them by rule
// and says how many pages carry it, which is the number that decides priority.
export function rollup(pageResults) {
  const agg = new Map();
  for (const p of pageResults) {
    for (const g of [...p.halfwired, ...p.contrast]) {
      const id = (r) => r ? `${r.sel} { ${r.prop}: ${r.value} }` : '(no author rule)';
      const key = [g.type, id(g.fgRule), id(g.bgRule), g.kind, g.scheme || ''].join(' :: ');
      let a = agg.get(key);
      if (!a) {
        a = { type: g.type, kind: g.kind, scheme: g.scheme || null, side: g.side || null,
              fgRule: g.fgRule, bgRule: g.bgRule, fgName: g.fgName, bgName: g.bgName,
              movedToken: g.movedToken || null, stuckToken: g.stuckToken || null,
              light: g.light || null, dark: g.dark || null, need: g.need,
              elements: 0, pages: new Set(), worst: Infinity, examples: new Set() };
        agg.set(key, a);
      }
      a.elements += g.count;
      a.pages.add(p.target.label);
      const w = g.type === 'contrast' ? g.worst : g.worstRatio;
      if (w < a.worst) a.worst = w;
      for (const e of g.examples) if (a.examples.size < 3) a.examples.add(e.sel + (e.sample ? `  "${e.sample}"` : ''));
    }
  }
  return [...agg.values()]
    .map(a => ({ ...a, pages: [...a.pages], pageCount: a.pages.size, examples: [...a.examples] }))
    .sort((x, y) => y.elements - x.elements || x.worst - y.worst);
}

export function renderRollup(pageResults) {
  const rows = rollup(pageResults);
  if (!rows.length) return '';
  const L = ['', '#'.repeat(78), `ALL PAGES, GROUPED BY ROOT CAUSE  (${pageResults.length} pages, ${rows.length} causes)`, '#'.repeat(78)];
  rows.forEach((r, i) => {
    L.push('');
    L.push(`${String(i + 1).padStart(2)}. ${r.type === 'halfwired' ? 'HALF-WIRED' : 'CONTRAST  '}   ` +
      `${r.elements} element${r.elements === 1 ? '' : 's'} on ${r.pageCount} page${r.pageCount === 1 ? '' : 's'}   ` +
      `[${r.kind}${r.scheme ? ', ' + r.scheme + ' scheme' : ''}]`);
    if (r.type === 'halfwired') {
      L.push(`    ${r.side}`);
      L.push(`    moved: ${r.movedToken ? 'var(' + r.movedToken + ')' : r.fgName}    stuck: ${r.stuckToken ? 'var(' + r.stuckToken + ')' : r.bgName}`);
      L.push(`    light ${r.light.fg} on ${r.light.bg} = ${r.light.ratio}:1     dark ${r.dark.fg} on ${r.dark.bg} = ${r.dark.ratio}:1   (needs ${r.need}:1)`);
    } else {
      L.push(`    worst ${r.worst}:1, needs ${r.need}:1`);
    }
    L.push(`    fg: ${ruleLine(r.fgRule)}`);
    L.push(`    bg: ${ruleLine(r.bgRule)}`);
    L.push(`    e.g. ${r.examples.join('   |   ')}`);
    L.push(`    pages: ${r.pages.slice(0, 6).join(' ')}${r.pages.length > 6 ? `  (+${r.pages.length - 6} more)` : ''}`);
  });
  return L.join('\n');
}

export function renderReport(pageResults, opts) {
  const L = [];
  for (const pr of pageResults) {
    const { target, contrast, halfwired, byScheme, notes, ruleCount } = pr;
    const scanned = Object.values(byScheme).reduce((n, r) => n + r.length, 0);
    L.push('');
    L.push('='.repeat(78));
    L.push(target.label);
    L.push('='.repeat(78));
    L.push(`  ${scanned} measurements across ${pr.schemes.join(' + ')}, ${ruleCount} author rules indexed`);
    for (const n of notes) L.push(`  note: ${n}`);

    L.push('');
    L.push(`-- B. HALF-WIRED (${halfwired.reduce((n, g) => n + g.count, 0)} elements in ${halfwired.length} root causes) --`);
    if (!halfwired.length) L.push('   clean');
    halfwired.forEach((g, i) => {
      L.push('');
      L.push(`  ${i + 1}. ${g.count} element${g.count === 1 ? '' : 's'}   ${g.side}`);
      L.push(`     what moved:  ${g.movedToken ? 'var(' + g.movedToken + ')' : g.fgName}`);
      L.push(`     what stuck:  ${g.stuckToken ? 'var(' + g.stuckToken + ')' : g.bgName}`);
      L.push(`     light:  fg ${g.light.fg}  on  bg ${g.light.bg}   ratio ${g.light.ratio}:1`);
      L.push(`     dark:   fg ${g.dark.fg}  on  bg ${g.dark.bg}   ratio ${g.dark.ratio}:1   (needs ${g.need}:1)`);
      L.push(`     fg rule: ${ruleLine(g.fgRule)}`);
      L.push(`     bg rule: ${ruleLine(g.bgRule)}`);
      if (g.bgStack && g.bgStack.length > 1) L.push(`     bg layers: ${g.bgStack.map(l => l.at + ' ' + l.color).join('  over  ')}`);
      L.push(`     kind: ${g.kind}`);
      for (const e of g.examples) L.push(`     e.g. ${e.sel}${e.sample ? '   "' + e.sample + '"' : ''}`);
    });

    L.push('');
    L.push(`-- A. CONTRAST (${contrast.reduce((n, g) => n + g.count, 0)} elements in ${contrast.length} root causes) --`);
    if (!contrast.length) L.push('   clean');
    contrast.forEach((g, i) => {
      L.push('');
      L.push(`  ${i + 1}. ${g.count} element${g.count === 1 ? '' : 's'}   ${g.scheme} scheme   ${g.kind}`);
      L.push(`     worst ${g.worst}:1, needs ${g.need}:1   ${g.worstColors.fg} on ${g.worstColors.bg}`);
      L.push(`     fg: ${g.fgName}   ${ruleLine(g.fgRule)}`);
      L.push(`     bg: ${g.bgName}   ${ruleLine(g.bgRule)}`);
      if (g.bgStack && g.bgStack.length > 1) L.push(`     bg layers: ${g.bgStack.map(l => l.at + ' ' + l.color).join('  over  ')}`);
      for (const e of g.examples) L.push(`     e.g. ${e.sel}  (${e.ratio}:1)${e.sample ? '   "' + e.sample + '"' : ''}`);
    });
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function run(argv) {
  const opts = parseArgs(argv);
  if (!opts.targets.length) usage(2);
  const targets = resolveTargets(opts.targets);

  // puppeteer is a devDependency, not a runtime one: every other bbe command is
  // a few hundred KB of node and this would drag a browser into every consumer
  // that only ever runs the gate. Say so plainly instead of throwing a resolver
  // error at someone who did nothing wrong.
  let puppeteer;
  try { ({ default: puppeteer } = await import('puppeteer')); }
  catch {
    console.error('FAIL: `bbe contrast` needs puppeteer, which is a devDependency of this package.');
    console.error('      Install it where you are running from:  npm i -D puppeteer');
    process.exit(2);
  }
  const browser = await puppeteer.launch({
    headless: 'new',
    // never a --window-size flag: headless Chrome refuses narrow windows and
    // lays out at ~500px instead. setViewport is the only dial that works.
    args: ['--no-sandbox', '--disable-lcd-text', '--force-color-profile=srgb', '--allow-file-access-from-files']
  });

  const pageResults = [];
  try {
    for (const target of targets) {
      const page = await browser.newPage();
      page.on('pageerror', () => {});
      let raw;
      try {
        raw = await scanPage(page, target, opts);
      } catch (e) {
        pageResults.push({ target, schemes: schemesFor(opts.scheme), ruleCount: 0, byScheme: {},
          notes: ['SCAN FAILED: ' + e.message], contrast: [], halfwired: [] });
        await page.close(); continue;
      }
      const contrast = groupContrast(contrastFindings(raw.byScheme), opts.maxExamples);
      const halfwired = groupHalfWired(halfWiredFindings(raw.byScheme), opts.maxExamples);
      pageResults.push({ ...raw, contrast, halfwired });
      await page.close();
    }
  } finally {
    await browser.close();
  }

  if (!opts.quiet) console.log(renderReport(pageResults, opts));
  if (pageResults.length > 1) console.log(renderRollup(pageResults));

  const totals = pageResults.reduce((t, p) => ({
    contrastElements: t.contrastElements + p.contrast.reduce((n, g) => n + g.count, 0),
    contrastCauses: t.contrastCauses + p.contrast.length,
    halfwiredElements: t.halfwiredElements + p.halfwired.reduce((n, g) => n + g.count, 0),
    halfwiredCauses: t.halfwiredCauses + p.halfwired.length
  }), { contrastElements: 0, contrastCauses: 0, halfwiredElements: 0, halfwiredCauses: 0 });

  console.log('');
  console.log(`bbe contrast: ${targets.length} page(s) · ` +
    `HALF-WIRED ${totals.halfwiredCauses} root cause(s) / ${totals.halfwiredElements} element(s) · ` +
    `CONTRAST ${totals.contrastCauses} root cause(s) / ${totals.contrastElements} element(s)`);

  if (opts.json) {
    const payload = {
      tool: 'bbe contrast', version: 1, generated: new Date().toISOString(),
      options: { scheme: opts.scheme, viewport: opts.viewport, failOn: opts.failOn },
      totals,
      rollup: rollup(pageResults),
      pages: pageResults.map(p => ({
        target: p.target.label, url: p.target.url, schemes: p.schemes,
        ruleCount: p.ruleCount, notes: p.notes,
        measurements: Object.fromEntries(Object.entries(p.byScheme).map(([k, v]) => [k, v.length])),
        halfwired: p.halfwired, contrast: p.contrast
      }))
    };
    fs.mkdirSync(path.dirname(path.resolve(opts.json)), { recursive: true });
    fs.writeFileSync(path.resolve(opts.json), JSON.stringify(payload, null, 2));
    console.log(`json: ${path.resolve(opts.json)}`);
  }

  const failC = (opts.failOn === 'contrast' || opts.failOn === 'both') && totals.contrastCauses > 0;
  const failH = (opts.failOn === 'halfwired' || opts.failOn === 'both') && totals.halfwiredCauses > 0;
  return (failC || failH) ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  run(process.argv.slice(2)).then(c => process.exit(c)).catch(e => {
    console.error('FAIL:', e && e.stack || e); process.exit(2);
  });
}
