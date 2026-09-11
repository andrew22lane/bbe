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
 *     "kitLocal": "kit/bex-kit-v1.css",   // optional: the repo that BUILDS the kit
 *     "reserved": [ ... ]                  // optional: overrides DEFAULT_KIT_RESERVED
 *   }
 *
 * `kitLocal` is for the one repo per brand that builds the kit file (bex-site
 * builds bex-kit-v1.css). Its own pages reference the kit by a local/relative
 * path, not the CDN URL, so `kitLocal` is accepted as an equivalent link target,
 * and the file at `kitLocal` is exempt from the reserved-token check below (it
 * IS the kit; the kit is allowed to define what it hands out).
 *
 * TWO CHECKS.
 *
 * (a) LINKS THE KIT FIRST. Any HTML file, any HTML-emitting template (a .mjs/.js
 *     file whose text contains `<head` or a `<link rel="stylesheet"` tag), is
 *     read for its stylesheet references in document order: `<link
 *     rel="stylesheet" href="...">` and `@import url("...")`. The kit
 *     (`url` or `kitLocal`) must be the FIRST one. A page with zero stylesheet
 *     references and no embedded kit URL string is also a miss — it built
 *     without the kit at all.
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

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function escapeRx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Every `<link rel="stylesheet" href="...">` and `@import url("...")`, text-wide,
// in document order. Works the same whether the text is an .html file or a JS
// template string holding markup — brand-drift's own approach to colour
// literals, applied here to stylesheet references.
function findStylesheetRefs(text) {
  const refs = [];
  const LINK_RX = /<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi;
  let m;
  while ((m = LINK_RX.exec(text)) !== null) {
    const hrefM = m[0].match(/href=["']([^"']+)["']/i);
    refs.push({ index: m.index, href: hrefM ? hrefM[1] : null });
  }
  const IMPORT_RX = /@import\s+(?:url\()?["']([^"')]+)["']\)?/gi;
  while ((m = IMPORT_RX.exec(text)) !== null) {
    refs.push({ index: m.index, href: m[1] });
  }
  refs.sort((x, y) => x.index - y.index);
  return refs;
}

function isKitHref(href, acceptedRefs) {
  return !!href && acceptedRefs.some((a) => href.includes(a));
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

/**
 * Scan a repo for kit violations.
 *
 * @param {string} repoRoot
 * @param {{url?:string, kitLocal?:string, reserved?:string[]}|null} kitConfig
 * @param {{exclude?: string[]}} opts  ADDITIVE to brand-drift's DEFAULT_EXCLUDE.
 */
export function scanKit(repoRoot, kitConfig, opts = {}) {
  if (!kitConfig || (!kitConfig.url && !kitConfig.kitLocal)) {
    return { hits: [], filesChecked: 0, acceptedRefs: [] };
  }

  const absRepo = resolve(repoRoot);
  const exclude = [...DEFAULT_EXCLUDE, ...(opts.exclude || [])];
  const acceptedRefs = [kitConfig.url, kitConfig.kitLocal].filter(Boolean);
  const reserved = Array.isArray(kitConfig.reserved) && kitConfig.reserved.length
    ? kitConfig.reserved
    : DEFAULT_KIT_RESERVED;
  const reservedProps = reserved.filter((r) => r.startsWith('--'));
  const reservedSelectors = reserved.filter((r) => r !== '@font-face' && !r.startsWith('--'));
  const checkFontFace = reserved.includes('@font-face');

  const kitLocalRel = kitConfig.kitLocal ? kitConfig.kitLocal.replace(/^\.?\//, '') : null;

  const hits = [];
  let filesChecked = 0;

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
      const looksLikePage = ext === '.html'
        || /<head[\s>]/i.test(text)
        || /<link\s+[^>]*rel=["']stylesheet["']/i.test(text);
      if (looksLikePage) {
        const refs = findStylesheetRefs(text);
        const embedsKitString = acceptedRefs.some((a) => text.includes(a));
        if (refs.length === 0) {
          if (!embedsKitString) {
            hits.push({ file: rel, line: 1, reason: 'does not link the kit before any other stylesheet (no stylesheet reference found)' });
          }
        } else if (!isKitHref(refs[0].href, acceptedRefs)) {
          const kitRefIdx = refs.findIndex((r) => isKitHref(r.href, acceptedRefs));
          if (kitRefIdx === -1) {
            if (!embedsKitString) {
              hits.push({ file: rel, line: lineAt(text, refs[0].index), reason: `does not link the kit before any other stylesheet (found ${refs[0].href || '(unresolved href)'} first)` });
            }
          } else {
            hits.push({ file: rel, line: lineAt(text, refs[0].index), reason: `kit not linked FIRST — ${refs[0].href || '(unresolved href)'} loads before it` });
          }
        }
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

  return { hits, filesChecked, acceptedRefs };
}
