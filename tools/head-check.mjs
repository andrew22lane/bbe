#!/usr/bin/env node
/**
 * head-check.mjs — proves Andrew's 2026-09-15 rule: "same favicon should be
 * used for all pages created, and a default branded share image must be auto
 * set up for all pages made."
 *
 * OPT-IN, the same posture as kit-drift.mjs. `bbe.config.json`'s existing
 * `kit` object gains two optional keys, both absolute URLs:
 *
 *   "kit": {
 *     "url": "...",
 *     "favicon": "https://cdn.brandbuilderengine.com/<brand>/brand/.../favicon.svg",
 *     "ogImage": "https://cdn.brandbuilderengine.com/<brand>/brand/kit/<brand>-og-default.jpg"
 *   }
 *
 * Absent either key, that half of the check is skipped, not failed — a repo
 * that has not opted in behaves exactly as it did before this file existed.
 * `kit.favicon` and `kit.ogImage` are independent: a brand can wire in one
 * before the other.
 *
 *   import { scanHead } from './head-check.mjs';
 *   const { hits, filesChecked } = scanHead(repoRoot, config.kit, { exclude });
 *
 * Runs against every file kit-drift.mjs already treats as a page (isPageFile,
 * imported from there so the two scanners cannot disagree about what a page
 * is): any `.html` file, or a `.mjs`/`.js`/`.cjs` file that assembles a whole
 * page — carries both `<head` and `</head>`.
 *
 * TWO CHECKS.
 *
 * (a) ONE FAVICON, NO EXCEPTIONS. When `kit.favicon` is set, every page must
 *     carry a `<link rel="icon" ...>` whose href resolves to EXACTLY
 *     `kit.favicon`. Missing the link entirely is one hit. A link present but
 *     pointing somewhere else is one hit. There is no ratchet: the whole
 *     point of the rule is ONE favicon everywhere, so a partial rollout is
 *     exactly the bug this exists to catch.
 *
 * (b) A SHARE IMAGE ON EVERY PAGE. When `kit.ogImage` is set, every page must
 *     carry a `<meta property="og:image" content="...">` with ANY non-empty
 *     value. The value is never compared to `kit.ogImage` — a page-specific
 *     share image (a blog post's own card, say) is allowed to override the
 *     brand default; only its PRESENCE is required. `<meta name="twitter:card"
 *     content="...">` is required alongside it, because Twitter/X ignores
 *     og:image without one.
 *
 * Href/content resolution tolerates the same two escaping shapes kit-drift.mjs
 * already handles, because it scans the same raw file text kit-drift.mjs does
 * (a `<link>`/`<meta>` tag reads the same whether it sits in an .html file, a
 * backtick template literal, or a plain JS string built with escaped quotes):
 * a backslash-escaped quote from string concatenation, and a bare `${identifier}`
 * template expression resolved via that identifier's own same-file string
 * assignment (resolveTemplateVar, imported from kit-drift.mjs).
 *
 * Every hit prints as `HEAD: <file>:<line> <reason>`, one of:
 *   missing rel=icon
 *   favicon <found> != kit.favicon
 *   missing og:image
 *   missing twitter:card
 *
 * Zero hits is the only pass.
 */

import { readFileSync } from 'node:fs';
import { relative, resolve, extname } from 'node:path';
import { walkFiles, isExcludedPath, DEFAULT_EXCLUDE } from './brand-drift.mjs';
import { isPageFile, resolveTemplateVar, lineAt } from './kit-drift.mjs';

const PAGE_EXT = ['.html', '.mjs', '.js', '.cjs'];

// A quote that may be backslash-escaped — kit-drift.mjs's own Q, duplicated
// here rather than imported so this file's regexes stay self-contained.
const Q = `\\\\?["']`;

function attr(tagText, name) {
  const rx = new RegExp(`${name}=${Q}([^"'\\\\]*)${Q}`, 'i');
  const m = tagText.match(rx);
  return m ? m[1] : null;
}

// Every `<link ... rel="icon" ...>`, text-wide, in document order. Same
// approach as kit-drift.mjs's findStylesheetRefs: run over the raw file text
// so a tag sitting inside a backtick template literal or an escaped-quote JS
// string is found exactly like one sitting in a plain .html file.
function findIconLinks(text) {
  const links = [];
  const LINK_RX = new RegExp(`<link\\s+[^>]*rel=${Q}icon${Q}[^>]*>`, 'gi');
  let m;
  while ((m = LINK_RX.exec(text)) !== null) {
    links.push({ index: m.index, href: attr(m[0], 'href') });
  }
  return links;
}

// Every `<meta ...>` tag, text-wide. `>` never needs escaping inside an
// attribute value in any of the three shapes this scanner reads (HTML,
// backtick literal, escaped-quote JS string), so a plain `[^>]*` boundary is
// safe here the way it is not for quote characters.
function findMetaTags(text) {
  const tags = [];
  const META_RX = /<meta\s+[^>]*>/gi;
  let m;
  while ((m = META_RX.exec(text)) !== null) {
    tags.push({ index: m.index, tag: m[0] });
  }
  return tags;
}

// Resolve a possibly-templated href/content value to the literal string it
// stands for. A bare `${identifier}` is resolved via that identifier's own
// same-file string assignment (kit-drift.mjs's resolveTemplateVar); anything
// else — a literal string, or a `${a}${b}` built from more than one piece —
// is returned as-is, the same "don't guess" posture kit-drift.mjs takes for
// an unresolvable stylesheet href.
function resolveValue(raw, text) {
  if (!raw) return raw;
  const varM = raw.match(/^\$\{(\w+)\}$/);
  if (varM) {
    const resolved = resolveTemplateVar(text, varM[1]);
    if (resolved != null) return resolved;
  }
  return raw;
}

/**
 * Scan a repo for missing/mismatched favicon and share-image tags.
 *
 * @param {string} repoRoot
 * @param {{favicon?:string, ogImage?:string}|null} kitConfig  the same object
 *   bbe.config.json's "kit" key already holds — url/local/reserved are
 *   ignored here, only favicon/ogImage matter.
 * @param {{exclude?: string[]}} opts  ADDITIVE to brand-drift's DEFAULT_EXCLUDE.
 */
export function scanHead(repoRoot, kitConfig, opts = {}) {
  const wantFavicon = !!(kitConfig && typeof kitConfig.favicon === 'string' && kitConfig.favicon);
  const wantOgImage = !!(kitConfig && typeof kitConfig.ogImage === 'string' && kitConfig.ogImage);

  if (!wantFavicon && !wantOgImage) {
    return { hits: [], filesChecked: 0, faviconChecked: false, ogImageChecked: false };
  }

  const absRepo = resolve(repoRoot);
  const exclude = [...DEFAULT_EXCLUDE, ...(opts.exclude || [])];
  const hits = [];
  let filesChecked = 0;

  for (const f of walkFiles(absRepo)) {
    const rel = relative(absRepo, f);
    const ext = extname(f).toLowerCase();
    if (!PAGE_EXT.includes(ext)) continue;
    if (isExcludedPath(rel, exclude)) continue;

    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (!isPageFile(ext, text)) continue;
    filesChecked++;

    // ---------------------------------------------------------- (a) favicon
    if (wantFavicon) {
      const links = findIconLinks(text);
      if (links.length === 0) {
        hits.push({ file: rel, line: 1, reason: 'missing rel=icon' });
      } else {
        const resolved = links.map((l) => ({ ...l, value: resolveValue(l.href, text) }));
        const match = resolved.find((l) => l.value === kitConfig.favicon);
        if (!match) {
          const first = resolved[0];
          hits.push({
            file: rel,
            line: lineAt(text, first.index),
            reason: `favicon ${first.value || '(unresolved href)'} != kit.favicon`
          });
        }
      }
    }

    // --------------------------------------------------------- (b) og:image
    if (wantOgImage) {
      const metas = findMetaTags(text);

      const ogMeta = metas.find((m) => attr(m.tag, 'property') === 'og:image');
      const ogContent = ogMeta ? attr(ogMeta.tag, 'content') : null;
      if (!ogMeta || !ogContent) {
        hits.push({ file: rel, line: ogMeta ? lineAt(text, ogMeta.index) : 1, reason: 'missing og:image' });
      }

      const twMeta = metas.find((m) => attr(m.tag, 'name') === 'twitter:card');
      const twContent = twMeta ? attr(twMeta.tag, 'content') : null;
      if (!twMeta || !twContent) {
        hits.push({ file: rel, line: twMeta ? lineAt(text, twMeta.index) : 1, reason: 'missing twitter:card' });
      }
    }
  }

  return { hits, filesChecked, faviconChecked: wantFavicon, ogImageChecked: wantOgImage };
}
