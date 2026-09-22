#!/usr/bin/env node
/**
 * kit-drift.mjs — proves the ONE-SYSTEM rule: "every web surface for a brand
 * links its ONE kit file first, and defines no reserved token of its own."
 *
 * brand-drift.mjs already proves "no raw hex outside the pack." It says nothing
 * about whether two surfaces on the same pack look alike, because a surface can
 * pass that gate while hand-typing its own `.btn`, its own `--primary`, its own
 * `@font-face` — eight bex surfaces did exactly that on 2026-09-10, and two
 * primary teals were live at once. This is the check that catches that.
 *
 *   import { scanKit, DEFAULT_KIT_RESERVED } from './kit-drift.mjs';
 *   const { hits, filesChecked } = scanKit(repoRoot, config.kit, { exclude });
 *
 * `config.kit` (from bbe.config.json):
 *   {
 *     "url": "https://cdn.brandbuilderengine.com/<brand>/kit/<brand>-kit-v<N>.css",
 *     "version": "1",
 *     "local": "kit/bex-kit-v1.css",   // optional: the repo that BUILDS the kit
 *     "reserved": [ ... ]                  // optional: overrides DEFAULT_KIT_RESERVED
 *   }
 *
 * `local` is for the one repo per brand that builds the kit file (bex-site
 * builds bex-kit-v1.css). Its own pages reference the kit by a local/relative
 * path, not the CDN URL, so `local` is accepted as an equivalent link target,
 * and the file at `local` is exempt from the reserved-token check below (it
 * IS the kit; the kit is allowed to define what it hands out).
 *
 * TWO CHECKS.
 *
 * (a) LINKS THE KIT FIRST. Any HTML file, any HTML-emitting template (a .mjs/.js
 *     file that assembles a whole page: it carries BOTH `<head` and `</head>`, or
 *     it opens with a `<!doctype html>` and lets the browser insert the head. Not
 *     a CSS-loading helper holding one `<link>` for something else, e.g. pages.mjs's
 *     leafletHead()), is read for its
 *     stylesheet references in document order: `<link rel="stylesheet"
 *     href="...">` and `@import url("...")`. The kit (`url` or `local`) must be
 *     the FIRST one. A page with zero stylesheet references and no embedded kit
 *     URL string is also a miss — it built without the kit at all.
 *
 *     The href match tolerates two more shapes past a plain HTML attribute:
 *     escaped quotes from a plain JS string built with concatenation
 *     (`"<link rel=\"stylesheet\" href=\"...\">"`, next-step.mjs's actual
 *     shape), and a bare `${identifier}` template expression whose value is
 *     resolved by finding that identifier's own same-file string assignment
 *     (single- or double-quoted) and comparing its BASENAME against the kit's
 *     — leads-worker/src/render.js links `href="${KIT_PATH}"` where `export
 *     const KIT_PATH = '/_kit/bex-kit-v1.css'` self-hosts the kit (its CSP is
 *     `default-src 'self'`, so the CDN URL never appears in the file). A
 *     variable built from OTHER variables (lib.mjs's
 *     `` `${BASE}${KIT_LOCAL_HREF}?v=${BUILD}` ``) is not resolved — it falls
 *     through to the embedsKitString check same as before.
 *
 * (b) NO RESERVED TOKEN OUTSIDE THE KIT. Any CSS-shaped rule block — in a
 *     `.css` file, a `<style>` block, or a JS template string, all read the same
 *     way brand-drift reads colour literals: as raw text, no parser — outside
 *     the kit file itself must not declare a reserved custom property inside
 *     `:root`, an `@font-face`, or a rule whose selector is EXACTLY one of the
 *     reserved bare selectors. A surface may declare anything prefixed
 *     (`--bex-quiz-accent`) and any selector that is not on the reserved list.
 *
 * Every hit prints as `KIT: <file>:<line> <reason>`. Zero hits is the only pass.
 * There is no ratchet here, unlike brand-drift's baseline: a kit violation is a
 * style fact leaking out of the shared file, and "we'll clean it up later" is
 * the exact failure mode this exists to end.
 */

import { readFileSync } from 'node:fs';
import { relative, resolve, extname } from 'node:path';
import { walkFiles, isExcludedPath, DEFAULT_EXCLUDE } from './brand-drift.mjs';

// The default reserved list. Entries starting with "--" are custom properties
// checked only inside a `:root` block. "@font-face" is checked as a rule
// keyword anywhere. Everything else is checked as an EXACT selector match.
export const DEFAULT_KIT_RESERVED = [
  '--primary', '--secondary', '--accent', '--serif', '--sans', '--ink', '--paper',
  '@font-face',
  '.btn', '.btn-primary', '.btn-ghost', '.nav', 'body', 'h1', 'h2', 'h3', 'h4'
];

const CHECK_EXT = ['.html', '.mjs', '.js', '.cjs', '.css'];
const TEMPLATE_EXT = ['.mjs', '.js', '.cjs'];

export function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function escapeRx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A quote that may be backslash-escaped: a plain JS string built with
// concatenation (`"<link rel=\"stylesheet\"..."`) carries `\"` where an
// HTML file or a backtick template literal carries a bare `"` or `'`. One
// optional literal backslash in front of the quote covers both.
const Q = `\\\\?["']`;

// Every `<link rel="stylesheet" href="...">` and `@import url("...")`, text-wide,
// in document order. Works the same whether the text is an .html file, a
// backtick template literal, or a plain JS string with escaped quotes —
// brand-drift's own approach to colour literals, applied here to stylesheet
// references.
function findStylesheetRefs(text) {
  const refs = [];
  const LINK_RX = new RegExp(`<link\\s+[^>]*rel=${Q}stylesheet${Q}[^>]*>`, 'gi');
  const HREF_RX = new RegExp(`href=${Q}([^"'\\\\]+)${Q}`, 'i');
  let m;
  while ((m = LINK_RX.exec(text)) !== null) {
    const hrefM = m[0].match(HREF_RX);
    refs.push({ index: m.index, href: hrefM ? hrefM[1] : null });
  }
  const IMPORT_RX = new RegExp(`@import\\s+(?:url\\()?${Q}([^"')\\\\]+)${Q}\\)?`, 'gi');
  while ((m = IMPORT_RX.exec(text)) !== null) {
    refs.push({ index: m.index, href: m[1] });
  }
  refs.sort((x, y) => x.index - y.index);
  return refs;
}

// The last path segment of a URL or local path, query string stripped —
// "https://cdn.../bexco/kit/bex-kit-v1.css" and "/_kit/bex-kit-v1.css" and
// "kit/bex-kit-v1.css" all resolve to "bex-kit-v1.css".
function basename(s) {
  if (!s) return '';
  return s.split('?')[0].split('/').pop();
}

// A page that self-hosts the kit (leads-worker: CSP is `default-src 'self'`,
// so the CDN URL never appears — see leads-worker/bbe.config.json) builds its
// href from a same-file constant: `export const KIT_PATH = '/_kit/bex-kit-v1.css';`
// then `href="${KIT_PATH}"`. The literal href text is the template expression,
// not the URL. Resolve a BARE `${identifier}` href by finding that identifier's
// own string assignment in the same file — single- or double-quoted, `const`,
// `let`, `var`, or a bare `name = '...'` — and returning its value. Recursive
// interpolation (a variable built from other variables, e.g. lib.mjs's
// `` `${BASE}${KIT_LOCAL_HREF}?v=${BUILD}` ``) is deliberately NOT resolved:
// the value is no longer one string this scanner can trust as a link target,
// so it falls through to the embedsKitString check same as before.
export function resolveTemplateVar(text, varName) {
  const rx = new RegExp(`\\b${escapeRx(varName)}\\s*=\\s*(["'])((?:(?!\\1)[^\\\\]|\\\\.)*)\\1`);
  const m = rx.exec(text);
  return m ? m[2] : null;
}

// Is this file one of the pages the ONE-SYSTEM-LAW checks apply to? A .html
// file always is. A .mjs/.js/.cjs file is one when it actually assembles a whole
// page (an explicit head element, or a doctype with the head left implicit),
// never merely because it contains a stray `<link>` fragment — see pages.mjs's
// leafletHead() in the
// v1.3.1 changelog entry above. Shared by scanKit's link-first check and by
// head-check.mjs's favicon / og:image check, so the two scanners cannot
// disagree about what counts as a page.
export function isPageFile(ext, text) {
  if (ext === '.html') return true;
  if (!TEMPLATE_EXT.includes(ext)) return false;
  // A whole page, two ways it gets written. An explicit head element is the common
  // one. A doctype with no head element is the other: `<head>` is optional in HTML
  // and the browser inserts it, so a worker can emit
  // `<!doctype html><meta charset="utf-8"><link rel="stylesheet" ...>` and serve a
  // complete document. proveit-domain's worker.js does exactly that, and the old
  // head-element-only rule read it as "not a page", so the kit link check scanned 5
  // files, 0 pages, and passed having proven nothing. Measured 2026-09-16.
  if (/<!doctype\s+html/i.test(text)) return true;
  return /<head[\s>]/i.test(text) && /<\/head>/i.test(text);
}

// Does this href point at the kit? Three ways, in order: the accepted ref
// string (kit.url or kit.local) appears literally in the href; or the href is
// a bare `${var}` template expression whose same-file string assignment's
// basename matches the kit's own basename.
function matchesKit(href, text, acceptedRefs, acceptedBasenames) {
  if (!href) return false;
  if (acceptedRefs.some((a) => href.includes(a))) return true;
  const varM = href.match(/^\$\{(\w+)\}$/);
  if (varM) {
    const resolved = resolveTemplateVar(text, varM[1]);
    if (resolved && acceptedBasenames.includes(basename(resolved))) return true;
  }
  return false;
}

// A .css file IS css, top to bottom. A .html/.mjs/.js/.cjs file is not — most of
// it is markup or JS logic, and running the block scanner over raw JS finds
// false "selectors" in ordinary object literals (`{ body, shell: 'bare' }` reads
// as a rule whose selector is `body`). So for anything that is not already a
// .css file, (b) only looks inside <style>...</style> blocks and backtick
// template-literal strings, which is where a JS file actually carries CSS text
// (siteCss(), workerIndex()'s PAGE template, and the like). Each region keeps
// its offset into the ORIGINAL file so a hit still reports the real line.
function collectCssRegions(text, ext) {
  if (ext === '.css') return [{ start: 0, text }];
  const regions = [];
  const STYLE_RX = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = STYLE_RX.exec(text)) !== null) {
    regions.push({ start: m.index + m[0].indexOf(m[1]), text: m[1] });
  }
  const TPL_RX = /`([^`]*)`/g;
  while ((m = TPL_RX.exec(text)) !== null) {
    regions.push({ start: m.index + 1, text: m[1] });
  }
  return regions;
}

// The link-first rule, for one page. Returns a hit, or null. Pulled out of scanKit
// so a page in the source and a page a build wrote (opts.buildDir) are judged by
// the same code.
function linkFirstHit(rel, text, acceptedRefs, acceptedBasenames) {
  const refs = findStylesheetRefs(text);
  const embedsKitString = acceptedRefs.some((a) => text.includes(a));
  if (refs.length === 0) {
    return embedsKitString ? null
      : { file: rel, line: 1, reason: 'does not link the kit before any other stylesheet (no stylesheet reference found)' };
  }
  if (matchesKit(refs[0].href, text, acceptedRefs, acceptedBasenames)) return null;
  const kitRefIdx = refs.findIndex((r) => matchesKit(r.href, text, acceptedRefs, acceptedBasenames));
  if (kitRefIdx === -1) {
    return embedsKitString ? null
      : { file: rel, line: lineAt(text, refs[0].index), reason: `does not link the kit before any other stylesheet (found ${refs[0].href || '(unresolved href)'} first)` };
  }
  return { file: rel, line: lineAt(text, refs[0].index), reason: `kit not linked FIRST — ${refs[0].href || '(unresolved href)'} loads before it` };
}

// "dist", "./dist", "dist/" all mean the same build directory.
export function normalizeBuildDir(dir) {
  return String(dir).trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

// The files a build wrote, for a site whose pages only exist after the build runs.
// An engine site is the case that forced this: build.mjs calls engine/lib.mjs
// head(), so the source holds no page for a scanner to read. `buildDir` is relative
// to the repo root. The defaults exclude `dist` from the SOURCE walk, so exclusion
// here is judged on the path INSIDE buildDir, while each file still reports its
// repo-relative path (dist/index.html) so a hit points somewhere real.
export function builtFiles(repoRoot, buildDir, exclude = DEFAULT_EXCLUDE) {
  const absRepo = resolve(repoRoot);
  const absBuilt = resolve(absRepo, normalizeBuildDir(buildDir));
  const out = [];
  for (const abs of walkFiles(absBuilt)) {
    if (isExcludedPath(relative(absBuilt, abs), exclude)) continue;
    out.push({ abs, rel: relative(absRepo, abs) });
  }
  return out;
}

/**
 * Scan a repo for kit violations.
 *
 * @param {string} repoRoot
 * @param {{url?:string, local?:string, reserved?:string[]}|null} kitConfig
 * @param {{exclude?: string[], buildDir?: string}} opts  `exclude` is ADDITIVE to
 *   brand-drift's DEFAULT_EXCLUDE. `buildDir` (repo-relative, e.g. "dist") also runs
 *   check (a) on every .html page a build wrote there. Check (b) stays on the source.
 */
export function scanKit(repoRoot, kitConfig, opts = {}) {
  if (!kitConfig || (!kitConfig.url && !kitConfig.local)) {
    return { hits: [], filesChecked: 0, pagesChecked: 0, builtPagesChecked: 0, acceptedRefs: [] };
  }

  const absRepo = resolve(repoRoot);
  const buildDir = opts.buildDir ? normalizeBuildDir(opts.buildDir) : null;
  const exclude = [...DEFAULT_EXCLUDE, ...(opts.exclude || []), ...(buildDir ? [buildDir] : [])];
  const acceptedRefs = [kitConfig.url, kitConfig.local].filter(Boolean);
  const acceptedBasenames = acceptedRefs.map(basename).filter(Boolean);
  const reserved = Array.isArray(kitConfig.reserved) && kitConfig.reserved.length
    ? kitConfig.reserved
    : DEFAULT_KIT_RESERVED;
  const reservedProps = reserved.filter((r) => r.startsWith('--'));
  const reservedSelectors = reserved.filter((r) => r !== '@font-face' && !r.startsWith('--'));
  const checkFontFace = reserved.includes('@font-face');

  const kitLocalRel = kitConfig.local ? kitConfig.local.replace(/^\.?\//, '') : null;

  const hits = [];
  let filesChecked = 0;
  let pagesChecked = 0;

  for (const f of walkFiles(absRepo)) {
    const rel = relative(absRepo, f);
    const ext = extname(f).toLowerCase();
    if (!CHECK_EXT.includes(ext)) continue;
    if (isExcludedPath(rel, exclude)) continue;
    if (kitLocalRel && rel === kitLocalRel) continue; // the kit file itself: exempt

    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    filesChecked++;

    // ---------------------------------------------------------- (a) links first
    if (ext === '.html' || TEMPLATE_EXT.includes(ext)) {
      if (isPageFile(ext, text)) {
        pagesChecked++;
        const hit = linkFirstHit(rel, text, acceptedRefs, acceptedBasenames);
        if (hit) hits.push(hit);
      }
    }

    // ------------------------------------------------- (b) reserved tokens
    const BLOCK_RX = /([^{}]+)\{([^{}]*)\}/g;
    for (const region of collectCssRegions(text, ext)) {
      BLOCK_RX.lastIndex = 0;
      let bm;
      while ((bm = BLOCK_RX.exec(region.text)) !== null) {
        const rawSel = bm[1];
        const leadingWs = rawSel.match(/^\s*/)[0].length;
        const selectorRaw = rawSel.slice(leadingWs).replace(/\/\*[\s\S]*?\*\//g, '').trim();
        if (!selectorRaw) continue;
        const body = bm[2];
        const line = lineAt(text, region.start + bm.index + leadingWs);

        if (checkFontFace && /@font-face\s*$/.test(selectorRaw)) {
          hits.push({ file: rel, line, reason: 'declares @font-face outside the kit' });
          continue;
        }

        const selectors = selectorRaw.split(',').map((s) => s.trim()).filter(Boolean);
        const isRootBlock = selectors.some((s) => s === ':root' || /:root\b/.test(s));
        if (isRootBlock) {
          for (const prop of reservedProps) {
            const propRx = new RegExp(`(^|[;{\\s])${escapeRx(prop)}\\s*:`);
            if (propRx.test(body)) {
              hits.push({ file: rel, line, reason: `:root declares reserved token ${prop} outside the kit` });
            }
          }
        }
        for (const sel of selectors) {
          if (reservedSelectors.includes(sel)) {
            hits.push({ file: rel, line, reason: `reserved selector ${sel} declared outside the kit` });
          }
        }
      }
    }
  }

  // ------------------------------------------------------- built pages (buildDir)
  // Only (a) runs here. Built CSS is the source CSS already checked above plus what
  // the engine writes, and the engine is not this surface's to fix, so (b) stays on
  // the source. Only .html: a built .js bundle is a copy of source already read.
  let builtPagesChecked = 0;
  if (buildDir) {
    for (const { abs, rel } of builtFiles(absRepo, buildDir, [...DEFAULT_EXCLUDE, ...(opts.exclude || [])])) {
      if (extname(abs).toLowerCase() !== '.html') continue;
      let text;
      try { text = readFileSync(abs, 'utf8'); } catch { continue; }
      pagesChecked++;
      builtPagesChecked++;
      const hit = linkFirstHit(rel, text, acceptedRefs, acceptedBasenames);
      if (hit) hits.push(hit);
    }
  }

  return { hits, filesChecked, pagesChecked, builtPagesChecked, acceptedRefs };
}
