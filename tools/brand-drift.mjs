#!/usr/bin/env node
/**
 * brand-drift.mjs - proves canon lock #1: "every value reads a token, no hardcoded hex."
 *
 *   node brand-drift.mjs --repo <path> --pack <slug|path>     one repo against one pack
 *   node brand-drift.mjs --repo <path>                        no pack: everything counts as UNREGISTERED
 *   node brand-drift.mjs --estate <estate.json>                table over many repos
 *   node brand-drift.mjs --selftest                            plant a defect, assert it goes RED
 *   node brand-drift.mjs --repo <path> --pack <slug> --strict FONT,WEIGHT   opt categories into failing
 *   node brand-drift.mjs --repo <path> --pack <slug> --baseline <file>     per-category ratchet file
 *
 * Exit 0 zero BRAND hits (and no strict/ratchet breach). Exit 1 any BRAND hit, any strict
 * category with a hit, or any category over its ratchet baseline. Exit 2 bad input or a
 * failed selftest.
 *
 * UNREGISTERED never changes the exit code. It is a colour no pack owns yet, which could be
 * a plain grey nobody bothered to name, or a brand colour nobody wrote down. It gets printed
 * so a human can look, and it stays a WARN so routine work does not go red for an untyped
 * neutral. Same two-tier law as gate-lint.mjs: a check that fails on routine work gets
 * switched off, and then it protects nothing.
 *
 * PHASE A STEP 4 (2026-09-09): the hex scan above proved 18 of 18 CLEAN while the estate
 * shipped three generations of one typeface, three button implementations, and hand-typed
 * fonts in every repo. It was clean on the one layer that had numbers in it. Five new
 * categories close that: FONT, WEIGHT, BUTTON, NOKIT, NOBRIEF. Each is its own colour of
 * drift, reported separately, so a repo's report says WHICH kind it has.
 *
 * THE RATCHET, and why the new categories do not fail on day one. Every DH surface will
 * measure non-zero on these the first time this runs — that is the honest baseline, not a
 * bug. If day one made the estate go red on 5 new categories at once, the nightly job stops
 * being useful and gets switched off, per the exact two-tier law already written above for
 * UNREGISTERED and in gate-lint.mjs. So:
 *
 *   - Each new category defaults to WARN: it is counted and printed, never fails the build.
 *   - `--strict <CSV of categories>` opts specific categories into failing when their count
 *     is > 0. A repo's own `bbe.config.json` can carry the same thing as a `"strict"` array
 *     — the two are unioned. NOBRIEF can never be made strict (see its own note below):
 *     asking for it is a printed WARN, not an error, and it stays advisory.
 *   - `--baseline <file>` is a SEPARATE ratchet from bbe.config.json's own single `baseline`
 *     number (which is BRAND-only and used by bin/bbe-gate). This one is a small JSON object,
 *     one count per new category: `{"FONT":12,"WEIGHT":3,"BUTTON":5,"NOKIT":8,"NOBRIEF":20}`.
 *     Missing file: today's counts are WRITTEN as the starting baseline (bootstrap; not a
 *     failure). Existing file: today's counts are compared against it. Any category ABOVE
 *     its recorded baseline is an exit-1 FAIL, regardless of `--strict` — a regression is a
 *     regression whether or not the category is opted into strict yet. Any category AT or
 *     BELOW its baseline auto-lowers the file to lock the improvement in (never raises it,
 *     same one-way ratchet `bin/bbe-gate --write-baseline` already uses for BRAND). This is
 *     what makes the estate-wide sweep converge instead of staying red forever at the same
 *     number.
 *
 * Node stdlib only. Reasoning and the seven checks: GATE-LINT-PLAN.md next door.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative, dirname, basename, resolve, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const HOME = homedir();
const VAULT_DEFAULT = process.env.VAULT || join(HOME, 'dh-work', 'dh-hub', 'vault');

// ---------- defaults ----------
const DEFAULT_INCLUDE_EXT = ['.mjs', '.js', '.cjs', '.ts', '.css', '.html', '.svelte', '.astro', '.jsx', '.tsx', '.json', '.py'];

// Segment-level exclusions. Matched against each path SEGMENT (a directory name or the
// filename), not a substring of the full path, so a repo named e.g. "dist-site" that is
// not actually a build output dir does not vanish by accident. `*` is a simple glob:
// matches any run of characters within the segment.
export const DEFAULT_EXCLUDE = [
  'node_modules', '.git', '.wrangler', 'dist', 'dist-*', 'blog-dist', '_astro',
  'static/assets/vendor', 'vendor', '.bak*', '*.bak*', 'src.bak*',
  // Any dot-directory or dot-file. Added 2026-09-03 after a sibling session's untracked
  // `.review/` screenshot + HTML dumps put 1,072 phantom hits on the Embody row. Dot paths
  // are tool state, never build source.
  '.*'
];

function segmentGlobToRegExp(pattern) {
  // Escape regex metachars, then turn our own `*` back into a wildcard.
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`);
}

function isExcludedPath(relPath, excludePatterns) {
  const segs = relPath.split(sep).filter(Boolean);
  // A pattern with a "/" in it (e.g. "static/assets/vendor") must match a run of
  // consecutive segments, not one segment.
  for (const pat of excludePatterns) {
    if (pat.includes('/')) {
      const patSegs = pat.split('/');
      const rxs = patSegs.map(segmentGlobToRegExp);
      for (let i = 0; i + rxs.length <= segs.length; i++) {
        if (rxs.every((rx, j) => rx.test(segs[i + j]))) return true;
      }
    } else {
      const rx = segmentGlobToRegExp(pat);
      if (segs.some((s) => rx.test(s))) return true;
    }
  }
  return false;
}

function walk(dir, base, out) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = join(dir, name);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, base, out);
    else out.push(p);
  }
}

// ---------- colour literal extraction ----------
// Word-boundary hex: the char immediately before "#" must not be part of an identifier,
// a path, or a URL-ish run, so a sha like 8d8241b099c298e5 or a fragment like /x#1c5e62
// does not get treated as a bare hex on its own (the fragment case is a known limit, see
// KNOWN LIMITS below: a `#hex` glued straight onto a URL still matches because it IS a
// valid standalone hex token once the `/` boundary is satisfied).
const HEX_RX = /(?<![\w/.-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const FUNC_RX = /\b(?:rgba?|hsla?)\([^)]*\)/gi;

function extractLiterals(text) {
  const found = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    let m;
    HEX_RX.lastIndex = 0;
    while ((m = HEX_RX.exec(line)) !== null) found.push({ line: i + 1, literal: m[0] });
    FUNC_RX.lastIndex = 0;
    while ((m = FUNC_RX.exec(line)) !== null) found.push({ line: i + 1, literal: m[0] });
  });
  return found;
}

// ---------- non-colour drift checks (Phase A step 4, 2026-09-09) ----------
// FONT, WEIGHT and BUTTON all walk the same shape: find a `{...}` block whose selector
// matches, then look inside its body for one property's LITERAL value (never a `var(...)`
// reference, which is the compliant form). The scanner is intentionally not a real CSS
// parser — it brace-matches every `{`/`}` pair it finds, so it also reaches into
// @media/@supports bodies for free (their "selector" text starts with `@` and gets
// skipped as a rule of its own, but the walk keeps going and finds the real selectors
// nested inside). Known limit, same shape as the hex scanner's URL-fragment note: a
// selector containing a literal `{` or `}` inside a bracketed attribute selector
// (`[data-x="{"]`) would desync the brace count. Not observed in this estate; documented
// rather than assumed away.
//
// PERFORMANCE TRAP, hit and fixed 2026-09-09, TWICE, measuring against dh-club's
// scripts/_data/courses-raw.json (~3.9MB, 6,897 `{`, mostly plain-text JSON values with
// no CSS in them at all). First attempt used the regex `[^{}]*\{` in a `while (exec())`
// loop. That regex is not "catastrophic backtracking" in the exponential sense — no
// nested quantifiers — but it IS quadratic on exactly this shape of input: a long run of
// plain text that ends in `}` rather than `{` (an ordinary closing JSON brace) makes every
// attempted match inside that run fail only after `[^{}]*` backtracks across the ENTIRE
// remaining run one character at a time, and the engine then retries at the next start
// position and does it again — O(run length) work per position, O(run length²) for the
// run. Measured: 43 SECONDS for one file, on a bare loop with no per-match work at all.
// The fix is not "filter earlier" (that was the first, insufficient fix) — it's not using
// a backtracking regex to walk braces at all. This is a single manual linear scan,
// character by character, with an explicit stack, so it is O(n) by construction and
// cannot regress into O(n²) no matter what the input looks like.
function walkCssBlocks(text, selectorTest, onBlock) {
  const n = text.length;
  const opens = []; // stack of { openIdx, selector } for each unmatched '{'
  let selectorStart = 0;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (ch === '{') {
      opens.push({ openIdx: i + 1, selector: text.slice(selectorStart, i) });
      selectorStart = i + 1;
    } else if (ch === '}') {
      const open = opens.pop();
      if (open) {
        if (!AT_RULE_SELECTOR_RX.test(open.selector) && selectorTest.test(open.selector)) {
          const body = text.slice(open.openIdx, i);
          const line = text.slice(0, open.openIdx).split('\n').length; // rare path: only real matches pay this
          onBlock(open.selector, body, line);
        }
      }
      selectorStart = i + 1;
    }
  }
}

// ---- FONT: any font-family declaration, any Google Fonts @import/<link>, any @font-face ----
const FONT_FAMILY_DECL_RX = /font-family\s*:\s*([^;}]+)/gi;
const FONT_GOOGLE_RX = /fonts\.(?:googleapis|gstatic)\.com/gi;
const FONT_FACE_RX = /@font-face\b/gi;

function findFontHits(text) {
  const hits = [];
  const lines = text.split('\n');
  lines.forEach((lineText, i) => {
    FONT_FAMILY_DECL_RX.lastIndex = 0;
    let m;
    while ((m = FONT_FAMILY_DECL_RX.exec(lineText)) !== null) {
      hits.push({ line: i + 1, kind: 'font-family', literal: m[0].trim() });
    }
    FONT_GOOGLE_RX.lastIndex = 0;
    if (FONT_GOOGLE_RX.test(lineText)) hits.push({ line: i + 1, kind: 'google-fonts-url', literal: lineText.trim().slice(0, 160) });
    FONT_FACE_RX.lastIndex = 0;
    if (FONT_FACE_RX.test(lineText)) hits.push({ line: i + 1, kind: '@font-face', literal: lineText.trim().slice(0, 160) });
  });
  return hits;
}

// ---- WEIGHT: a font-weight LITERAL on an h1/h2/h3 selector (ruling 64: headlines are one
// colour and one weight, and that weight is the pack's) ----
const HEADING_SELECTOR_RX = /\bh[123]\b/i;
const AT_RULE_SELECTOR_RX = /^\s*@/;
const FONT_WEIGHT_PROP_RX = /font-weight\s*:\s*([^;]+)/i;
const VAR_REF_RX = /^var\(/i;

function findHeadingWeightHits(text) {
  const hits = [];
  walkCssBlocks(text, HEADING_SELECTOR_RX, (selector, body, line) => {
    const fw = FONT_WEIGHT_PROP_RX.exec(body);
    if (!fw) return;
    const val = fw[1].trim();
    if (VAR_REF_RX.test(val)) return; // token reference — compliant, not a literal
    hits.push({ line, selector: selector.trim().replace(/\s+/g, ' '), literal: val });
  });
  return hits;
}

// ---- BUTTON: a background/background-color LITERAL inside .btn or button, outside the kit ----
const BUTTON_SELECTOR_RX = /(\.btn\b|\bbutton\b)/i;
const BACKGROUND_PROP_RX = /\bbackground(?:-color)?\s*:\s*([^;]+)/i;

function findButtonBackgroundHits(text) {
  const hits = [];
  walkCssBlocks(text, BUTTON_SELECTOR_RX, (selector, body, line) => {
    const bg = BACKGROUND_PROP_RX.exec(body);
    if (!bg) return;
    const val = bg[1].trim();
    if (VAR_REF_RX.test(val)) return;
    hits.push({ line, selector: selector.trim().replace(/\s+/g, ' '), literal: val });
  });
  return hits;
}

// ---- NOKIT / NOBRIEF: is this file an HTML entry point at all? ----
// "HTML entry" is deliberately broader than the .html extension: a server-rendered
// template (functions/lib/html.js in dh-club, which is where the Club's third copy of the
// type system was hiding — real example, measured 2026-09-09) or an email template can be a
// .js/.mjs/.cjs file that builds a full page as a template literal. Detected the same way a
// browser would: it contains an <html ...> tag or a doctype, literally, in the source text.
// Known limit: a page assembled by string concatenation with no literal "<html" anywhere in
// one file is invisible to this, same class of limit as the hex scanner's runtime-built
// colour. NOBRIEF stays scoped to the narrower, extension-based sense ("built HTML page")
// per the spec — a template that never fully resolves is not yet "built".
const HTML_DOCUMENT_RX = /<html[\s>]|<!doctype\s+html/i;

function isHtmlEntryPoint(ext, text) {
  if (ext === '.html' || ext === '.htm') return true;
  return HTML_DOCUMENT_RX.test(text);
}

const BBE_BRIEF_META_RX = /<meta\s+name=["']bbe-brief["']\s+content=["'][^"']*["']/i;

// ---------- normalisation, shared between pack colours and found literals ----------
function normaliseHex(hex) {
  let h = hex.toLowerCase();
  if (!h.startsWith('#')) return h;
  let body = h.slice(1);
  if (body.length === 3) body = body.split('').map((c) => c + c).join(''); // #abc -> #aabbcc
  else if (body.length === 4) { // #rgba -> expand then treat below
    body = body.split('').map((c) => c + c).join('');
  }
  if (body.length === 8 && body.slice(6) === 'ff') body = body.slice(0, 6); // strip ff alpha
  return '#' + body;
}

function normaliseColour(literal) {
  const t = literal.trim();
  if (t.startsWith('#')) return normaliseHex(t);
  // rgb/rgba/hsl/hsla: normalise whitespace and case, leave numbers as-is. Good enough to
  // de-duplicate; exact numeric equivalence (e.g. rgba(0,0,0,1) vs #000) is out of scope.
  return t.toLowerCase().replace(/\s+/g, '');
}

// ---------- pack colour set ----------
function flattenColours(obj, out, prefix = '') {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_') || k === 'evidence') continue;
    if (v == null) continue;
    if (typeof v === 'string') {
      if (/^#/.test(v) || /^(rgba?|hsla?)\(/i.test(v)) out.set(normaliseColour(v), prefix ? `${prefix}.${k}` : k);
      continue;
    }
    if (typeof v !== 'object') continue;
    if (typeof v.value === 'string') {
      out.set(normaliseColour(v.value), prefix ? `${prefix}.${k}` : k);
      continue;
    }
    flattenColours(v, out, prefix ? `${prefix}.${k}` : k);
  }
}

function packColourSet(pack) {
  const map = new Map(); // normalised value -> name
  if (pack?.outputs?.web?.palette) flattenColours(pack.outputs.web.palette, map, 'outputs.web.palette');
  if (pack?.outputs?.card?.palette) flattenColours(pack.outputs.card.palette, map, 'outputs.card.palette');
  if (pack?.tokens?.color) flattenColours(pack.tokens.color, map, 'tokens.color');
  return map;
}

// ---------- resolving --pack ----------
export function resolvePackPath(pack, vault = VAULT_DEFAULT) {
  if (!pack) return null;
  if (existsSync(pack)) return resolve(pack);
  const guess = join(vault, 'core', 'brand-packs', `${pack}.brandpack.json`);
  return guess;
}

// ---------- the scan ----------
// TWO CALL SHAPES, one implementation. The object form is what
// vault/core/engine/estate-status.mjs has always called and must keep working:
//
//   scanRepo({ repo, pack, packPath, include, exclude })
//
// The positional form is the one a consumer reaches for, and the one bbe-gate uses:
//
//   scanRepo(repoDir, packSlugOrPath, { exclude })
//
// They land on the same code path on purpose. The bex CI count (110) disagreeing
// with the nightly estate count (283) on one unchanged tree was never two different
// scanners; it was two different EXCLUDE lists reaching one scanner. So there is
// one scanner, and the exclude list is the thing a repo declares out loud, in
// bbe.config.json.
export function scanRepo(a, b, c) {
  const opts = typeof a === 'string'
    ? { repo: a, ...(b ? { pack: b } : {}), ...(c || {}) }
    : (a || {});
  const {
    repo,
    pack = null,
    packPath = null,
    include = DEFAULT_INCLUDE_EXT,
    exclude = DEFAULT_EXCLUDE
  } = opts;
  const absRepo = resolve(repo);
  if (!existsSync(absRepo)) {
    return { error: `repo not found: ${absRepo}` };
  }

  let packColours = new Map();
  let packName = null;
  let packJson = null;
  let resolvedPackPath = packPath;
  if (pack && !resolvedPackPath) resolvedPackPath = resolvePackPath(pack);
  if (resolvedPackPath) {
    if (!existsSync(resolvedPackPath)) {
      return { error: `pack not found: ${resolvedPackPath}` };
    }
    try { packJson = JSON.parse(readFileSync(resolvedPackPath, 'utf8')); }
    catch (e) { return { error: `${resolvedPackPath} is not valid JSON: ${e.message}` }; }
    packColours = packColourSet(packJson);
    packName = packJson?.meta?.slug || packJson?.meta?.name || basename(resolvedPackPath);
  }

  // NOKIT reads outputs.web.kit.url. No pack given at all, or a pack that has not been
  // through `bbe kit` yet and carries no outputs.web.kit: skip the check with a stated
  // reason rather than guessing at a URL nobody wrote down.
  const KIT_URL = packJson?.outputs?.web?.kit?.url || null;
  let nokitSkipped = null;
  if (!resolvedPackPath) nokitSkipped = 'no pack given — nothing to check HTML entries against';
  else if (!KIT_URL) nokitSkipped = `pack ${packName || resolvedPackPath} has no outputs.web.kit.url — not emitted yet`;

  const allFiles = [];
  walk(absRepo, absRepo, allFiles);

  const scanned = [];
  const excluded = [];
  for (const f of allFiles) {
    const rel = relative(absRepo, f);
    const bn = basename(f);
    if (bn.endsWith('.brandpack.json')) { excluded.push(rel); continue; }
    if (/\.min\.(js|css)$/i.test(bn)) { excluded.push(rel); continue; }
    if (isExcludedPath(rel, exclude)) { excluded.push(rel); continue; }
    const ext = bn.includes('.') ? bn.slice(bn.lastIndexOf('.')) : '';
    if (!include.includes(ext)) { continue; } // not excluded, just not a scannable type; don't clutter the excluded list
    scanned.push(f);
  }

  const brand = [];
  const unregistered = [];
  const brandByFile = new Map();
  const unregByFile = new Map();
  const generated = [];
  let neutralSkipped = 0;

  // Phase A step 4: FONT / WEIGHT / BUTTON / NOKIT / NOBRIEF. Same file set as the hex
  // scan, same GENERATED-file exemption ("not the brand kit itself" — a file emitted from
  // the pack is the kit, and the kit is where fonts and weights are SUPPOSED to live).
  const font = [], weight = [], button = [], nokit = [], nobrief = [];
  const fontByFile = new Map(), weightByFile = new Map(), buttonByFile = new Map();

  for (const f of scanned) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const rel = relative(absRepo, f);
    const bnExt = f.includes('.') ? f.slice(f.lastIndexOf('.')) : '';
    // A file EMITTED from the pack is the pack's output, not a hand-typed literal. The
    // contract: its first 400 characters say GENERATED and name the brandpack it was
    // built from (embody-app/tools/build-tokens.mjs writes exactly that header). Anything
    // else that carries the hex is scanned like any other source file.
    if (/GENERATED/.test(text.slice(0, 400)) && /brandpack/i.test(text.slice(0, 400))) { generated.push(rel); excluded.push(rel); continue; }

    // ---- FONT ----
    for (const h of findFontHits(text)) {
      font.push({ file: rel, line: h.line, kind: h.kind, literal: h.literal });
      fontByFile.set(rel, (fontByFile.get(rel) || 0) + 1);
    }
    // ---- WEIGHT ----
    for (const h of findHeadingWeightHits(text)) {
      weight.push({ file: rel, line: h.line, selector: h.selector, literal: h.literal });
      weightByFile.set(rel, (weightByFile.get(rel) || 0) + 1);
    }
    // ---- BUTTON ----
    for (const h of findButtonBackgroundHits(text)) {
      button.push({ file: rel, line: h.line, selector: h.selector, literal: h.literal });
      buttonByFile.set(rel, (buttonByFile.get(rel) || 0) + 1);
    }
    // ---- NOKIT / NOBRIEF: only meaningful for actual HTML entry points ----
    if (isHtmlEntryPoint(bnExt, text)) {
      if (!nokitSkipped && !text.includes(KIT_URL)) nokit.push({ file: rel, reason: `no reference to the kit URL (${KIT_URL})` });
      if ((bnExt === '.html' || bnExt === '.htm') && !BBE_BRIEF_META_RX.test(text)) nobrief.push({ file: rel });
    }

    const hits = extractLiterals(text);
    for (const h of hits) {
      const norm = normaliseColour(h.literal);
      // Ruled 2026-09-03 (Andrew): pure white and pure black are exempt. Every stylesheet
      // types them by hand and they were 433 of 1,230 estate hits; a gate that cries wolf
      // on a third of its hits gets ignored. Every other colour stays strict.
      if (norm === '#ffffff' || norm === '#000000') { neutralSkipped++; continue; }
      if (packColours.has(norm)) {
        const entry = { file: rel, line: h.line, literal: h.literal, packName: packColours.get(norm) };
        brand.push(entry);
        brandByFile.set(rel, (brandByFile.get(rel) || 0) + 1);
      } else if (pack || resolvedPackPath) {
        // Only classify as UNREGISTERED when a pack was given at all. With no pack,
        // the caller wants counts-only mode (handled by the CLI), and every literal
        // is unregistered by definition there too, but the CLI prints it differently.
        const entry = { file: rel, line: h.line, literal: h.literal };
        unregistered.push(entry);
        unregByFile.set(rel, (unregByFile.get(rel) || 0) + 1);
      } else {
        const entry = { file: rel, line: h.line, literal: h.literal };
        unregistered.push(entry);
        unregByFile.set(rel, (unregByFile.get(rel) || 0) + 1);
      }
    }
  }

  const brandUnique = new Set(brand.map((b) => normaliseColour(b.literal))).size;
  const unregisteredUnique = new Set(unregistered.map((u) => normaliseColour(u.literal))).size;

  return {
    repo: absRepo,
    pack: resolvedPackPath || null,
    packName,
    files: allFiles.length,
    scanned: scanned.length,
    excluded,
    excludePatterns: exclude,
    brand,
    unregistered,
    brandUnique,
    generated,
    neutralSkipped,
    unregisteredUnique,
    packColours: packColours.size,
    brandByFile: Object.fromEntries(brandByFile),
    unregByFile: Object.fromEntries(unregByFile),
    // Phase A step 4: five new WARN-by-default categories. Each is counted and printed;
    // none affects the exit code unless CLI --strict / a repo's bbe.config.json "strict"
    // array opts it in, or a --baseline file shows a regression. See file header.
    font,
    fontByFile: Object.fromEntries(fontByFile),
    weight,
    weightByFile: Object.fromEntries(weightByFile),
    button,
    buttonByFile: Object.fromEntries(buttonByFile),
    nokit,
    nokitSkipped,
    nobrief
  };
}

// ---------- selftest ----------
const FX_KIT_URL = 'https://cdn.example.test/fx/kit.css';
const FX_PACK = {
  meta: { slug: 'fx', name: 'fixture' },
  outputs: {
    web: {
      palette: { primary: { value: '#1c5e62' } },
      kit: { url: FX_KIT_URL, version: '1.0' }
    }
  },
  tokens: { color: { ink: { value: '#2E2E2D' } } }
};

// A clean HTML entry point: links the kit AND carries the brief meta, so NOKIT and
// NOBRIEF both start GREEN on the untouched fixture.
const FX_CLEAN_HTML = `<!doctype html>
<html>
<head>
  <meta name="bbe-brief" content="v1">
  <link rel="stylesheet" href="${FX_KIT_URL}">
</head>
<body><h1>fixture</h1></body>
</html>
`;

function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'brand-drift-fx-'));
  const w = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };
  w('repo/brand/x.brandpack.json', JSON.stringify(FX_PACK, null, 2));
  w('repo/site.css', `:root{--primary:var(--x);} .a{background:{{palette.primary}};}\n`);
  w('repo/index.html', FX_CLEAN_HTML);
  w('repo/dist/index.html', `<style>:root{--primary:#1c5e62;}</style>`); // excluded: dist
  w('repo/node_modules/x.js', `const c = "#1c5e62";`); // excluded: node_modules
  w('pack.json', JSON.stringify(FX_PACK, null, 2));
  return dir;
}

function selftest() {
  console.log('\n  brand-drift selftest\n');
  let bad = 0;
  const probe = (label, cond) => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
    if (!cond) bad++;
  };

  const dir = buildFixture();
  try {
    // Clean fixture: exit-equivalent check via scanRepo directly.
    const cleanResult = scanRepo({ repo: join(dir, 'repo'), packPath: join(dir, 'pack.json') });
    probe('clean fixture: zero BRAND hits (dist/ and node_modules/ excluded, {{...}} placeholder is clean)', cleanResult.brand.length === 0);
    probe('clean fixture: the pack file itself is excluded from the scan', !cleanResult.excluded.every((e) => !e.endsWith('.brandpack.json')) === false || cleanResult.excluded.some((e) => e.endsWith('.brandpack.json')));

    // Phase A step 4: clean fixture goes GREEN on every new category too. A detector
    // that has only ever returned clean has not been tested — this is the "clean" half
    // of that; the "plant one defect per category" half follows below.
    probe('clean fixture: zero FONT hits', cleanResult.font.length === 0);
    probe('clean fixture: zero WEIGHT hits', cleanResult.weight.length === 0);
    probe('clean fixture: zero BUTTON hits', cleanResult.button.length === 0);
    probe('clean fixture: zero NOKIT hits (index.html links the kit URL)', cleanResult.nokit.length === 0);
    probe('clean fixture: NOKIT was not skipped (fixture pack carries outputs.web.kit.url)', cleanResult.nokitSkipped === null);
    probe('clean fixture: zero NOBRIEF hits (index.html carries the bbe-brief meta)', cleanResult.nobrief.length === 0);

    // Plant defects.
    const w = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };
    w('repo/src/app.js', `export const peri = "--peri:#1C5E62;";\n`); // case differs from pack's #1c5e62
    w('repo/src/b.css', `.x{color:#1c5e62ff}\n`); // alpha ff, should normalise to brand hit
    w('repo/src/c.css', `.y{color:#2e2e2d}\n`); // matches tokens.color.ink
    w('repo/src/d.css', `.z{color:#777777}\n`); // unregistered, not brand
    w('repo/src/sha.js', `// build 8d8241b099c298e5\n`); // must NOT be treated as a colour
    w('repo/src/frag.js', `const u = "/x#1c5e62";\n`); // URL fragment: known limit, may or may not fire; documented, not asserted either way

    // One planted defect per new category (Phase A step 4).
    w('repo/src/stray-font.css', `.hero{font-family:'Poppins',sans-serif;}\n`); // FONT: hand-typed font-family outside the kit
    w('repo/src/heading.css', `h2{font-weight:800;letter-spacing:-.02em;}\n`); // WEIGHT: literal weight on h2
    w('repo/src/btn.css', `.btn{background:#ff0000;color:#fff;}\n`); // BUTTON: literal background on .btn
    w('repo/src/orphan.html', `<!doctype html>\n<html>\n<head><meta name="bbe-brief" content="v1"></head>\n<body>no kit link here</body>\n</html>\n`); // NOKIT: brief present, kit link missing
    w('repo/src/undocumented.html', `<!doctype html>\n<html>\n<head><link rel="stylesheet" href="${FX_KIT_URL}"></head>\n<body>no brief meta here</body>\n</html>\n`); // NOBRIEF: kit present, brief meta missing

    const r = scanRepo({ repo: join(dir, 'repo'), packPath: join(dir, 'pack.json') });

    const hitFiles = new Set(r.brand.map((b) => b.file));
    probe('src/app.js flagged BRAND (case-insensitive match against pack primary)', hitFiles.has(join('src', 'app.js')));
    probe('src/b.css flagged BRAND (ff alpha stripped before compare)', hitFiles.has(join('src', 'b.css')));
    probe('src/c.css flagged BRAND (matches tokens.color.ink)', hitFiles.has(join('src', 'c.css')));

    const unregFiles = new Set(r.unregistered.map((u) => u.file));
    probe('src/d.css is UNREGISTERED, not BRAND (#777777 owned by no pack colour)', unregFiles.has(join('src', 'd.css')) && !hitFiles.has(join('src', 'd.css')));

    const shaHit = [...r.brand, ...r.unregistered].some((e) => e.file === join('src', 'sha.js'));
    probe('a bare sha (8d8241b099c298e5, no #) is never matched as a colour', !shaHit);

    // Known limit, not a hard assertion: a "#hex" glued to the end of a URL string still
    // satisfies the word-boundary rule because "/" precedes the "#", which the regex
    // treats as a legitimate boundary (it is, for CSS). Documented in KNOWN LIMITS below.
    console.log('  note src/frag.js ("/x#1c5e62") is a KNOWN LIMIT: the lookbehind treats "/" as a valid boundary before "#", so a URL fragment can still register as a colour literal. See KNOWN LIMITS in this file\'s header comment.');

    // ---- Phase A step 4: each planted defect goes RED in its OWN category, and only that one ----
    const fontFiles = new Set(r.font.map((h) => h.file));
    probe('src/stray-font.css flagged FONT', fontFiles.has(join('src', 'stray-font.css')));
    probe('src/stray-font.css is NOT flagged WEIGHT or BUTTON (own category only)', !r.weight.some((h) => h.file === join('src', 'stray-font.css')) && !r.button.some((h) => h.file === join('src', 'stray-font.css')));

    const weightFiles = new Set(r.weight.map((h) => h.file));
    probe('src/heading.css flagged WEIGHT (literal font-weight:800 on h2)', weightFiles.has(join('src', 'heading.css')));
    probe('src/heading.css is NOT flagged FONT or BUTTON (own category only)', !r.font.some((h) => h.file === join('src', 'heading.css')) && !r.button.some((h) => h.file === join('src', 'heading.css')));

    const buttonFiles = new Set(r.button.map((h) => h.file));
    probe('src/btn.css flagged BUTTON (literal background on .btn)', buttonFiles.has(join('src', 'btn.css')));
    probe('src/btn.css is NOT flagged FONT or WEIGHT (own category only)', !r.font.some((h) => h.file === join('src', 'btn.css')) && !r.weight.some((h) => h.file === join('src', 'btn.css')));

    const nokitFiles = new Set(r.nokit.map((h) => h.file));
    probe('src/orphan.html flagged NOKIT (no kit URL reference)', nokitFiles.has(join('src', 'orphan.html')));
    probe('src/orphan.html is NOT flagged NOBRIEF (it carries the brief meta — own category only)', !r.nobrief.some((h) => h.file === join('src', 'orphan.html')));

    const nobriefFiles = new Set(r.nobrief.map((h) => h.file));
    probe('src/undocumented.html flagged NOBRIEF (no bbe-brief meta)', nobriefFiles.has(join('src', 'undocumented.html')));
    probe('src/undocumented.html is NOT flagged NOKIT (it links the kit — own category only)', !r.nokit.some((h) => h.file === join('src', 'undocumented.html')));

    // The pre-existing clean index.html and site.css must still read clean after the
    // defects landed elsewhere in the tree — a detector that goes red everywhere once
    // anything is wrong is not proving anything category-specific.
    probe('repo/index.html (untouched) still not flagged NOKIT or NOBRIEF', !r.nokit.some((h) => h.file === 'index.html') && !r.nobrief.some((h) => h.file === 'index.html'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n  ${bad === 0 ? 'selftest PASS' : `selftest FAIL, ${bad} problem(s)`}\n`);
  return bad;
}

// ---------- CLI ----------

// The five new categories, WARN by default. NOBRIEF is deliberately excluded from
// STRICTABLE — Phase B has not added the meta everywhere yet, so opting it into failing
// would red the whole estate on a check nobody has built the fix for. Asking for it via
// --strict or bbe.config.json is a printed note, not an error.
const NEW_CATEGORIES = ['FONT', 'WEIGHT', 'BUTTON', 'NOKIT', 'NOBRIEF'];
const STRICTABLE_CATEGORIES = ['FONT', 'WEIGHT', 'BUTTON', 'NOKIT'];

function categoryCounts(result) {
  return {
    FONT: result.font.length,
    WEIGHT: result.weight.length,
    BUTTON: result.button.length,
    NOKIT: result.nokitSkipped ? null : result.nokit.length, // null = skipped, not zero
    NOBRIEF: result.nobrief.length
  };
}

// Union CLI --strict with the repo's own bbe.config.json "strict" array (if the repo has
// one at its root — the same file bin/bbe-gate reads for pack/exclude/baseline).
function resolveStrictSet(repoArg, cliStrict) {
  const set = new Set();
  const notes = [];
  for (const c of cliStrict || []) {
    if (!NEW_CATEGORIES.includes(c)) { notes.push(`--strict: unknown category "${c}", ignored`); continue; }
    if (c === 'NOBRIEF') { notes.push('--strict NOBRIEF requested but NOBRIEF cannot be made strict yet (Phase B); ignored'); continue; }
    set.add(c);
  }
  const cfgPath = join(resolve(repoArg), 'bbe.config.json');
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      for (const c of (Array.isArray(cfg.strict) ? cfg.strict : [])) {
        if (!NEW_CATEGORIES.includes(c)) { notes.push(`bbe.config.json "strict": unknown category "${c}", ignored`); continue; }
        if (c === 'NOBRIEF') { notes.push('bbe.config.json "strict" names NOBRIEF but it cannot be made strict yet (Phase B); ignored'); continue; }
        set.add(c);
      }
    } catch (e) { notes.push(`bbe.config.json is not valid JSON, "strict" not read: ${e.message}`); }
  }
  return { strict: set, notes };
}

// --baseline <file>: a per-repo, per-category ratchet, separate from bbe.config.json's
// own single BRAND-only "baseline" number. Missing file: bootstrap (write today's counts,
// never a failure). Existing file: compare; any category ABOVE its recorded number is an
// exit-1 FAIL regardless of --strict. At or below: auto-lower to lock the improvement in,
// same one-way direction as bin/bbe-gate --write-baseline. Returns { breaches, wrote, notes }.
function applyCategoryBaseline(baselinePath, counts) {
  const notes = [];
  const breaches = [];
  let recorded = null;
  if (existsSync(baselinePath)) {
    try { recorded = JSON.parse(readFileSync(baselinePath, 'utf8')); }
    catch (e) { return { breaches: [], wrote: false, notes: [`--baseline file is not valid JSON, ignored: ${e.message}`] }; }
  }
  if (!recorded) {
    writeFileSync(baselinePath, JSON.stringify(counts, null, 2) + '\n');
    notes.push(`--baseline: no file yet, bootstrapped ${baselinePath} with today's counts (not a failure)`);
    return { breaches: [], wrote: true, notes };
  }
  const next = { ...recorded };
  let lowered = false;
  for (const cat of NEW_CATEGORIES) {
    const now = counts[cat];
    if (now === null || now === undefined) continue; // skipped category (e.g. NOKIT with no kit yet)
    const before = typeof recorded[cat] === 'number' ? recorded[cat] : null;
    if (before === null) { next[cat] = now; lowered = true; continue; } // new category added to an old baseline file
    if (now > before) { breaches.push({ category: cat, now, baseline: before }); }
    else if (now < before) { next[cat] = now; lowered = true; }
  }
  if (breaches.length === 0 && lowered) {
    writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
    notes.push(`--baseline: improvement locked in, ${baselinePath} lowered`);
    return { breaches: [], wrote: true, notes };
  }
  return { breaches, wrote: false, notes };
}

function printBrandHits(brand, cap = 60) {
  const shown = brand.slice(0, cap);
  for (const b of shown) console.log(`    ${b.file}:${b.line}  ${b.literal}  -> ${b.packName}`);
  if (brand.length > cap) console.log(`    ...and ${brand.length - cap} more`);
}

function printCategoryHits(label, hits, cap = 30) {
  console.log(`  ${label}: ${hits.length} hit(s)`);
  const shown = hits.slice(0, cap);
  for (const h of shown) {
    if (h.selector) console.log(`    ${h.file}:${h.line}  ${h.selector} { ... ${h.literal} ... }`);
    else if (h.reason) console.log(`    ${h.file}  — ${h.reason}`);
    else if (h.kind) console.log(`    ${h.file}:${h.line}  [${h.kind}]  ${h.literal}`);
    else console.log(`    ${h.file}`);
  }
  if (hits.length > cap) console.log(`    ...and ${hits.length - cap} more`);
}

function printUnregisteredTop(unregistered, topN = 15) {
  const counts = new Map();
  const example = new Map();
  for (const u of unregistered) {
    const norm = normaliseColour(u.literal);
    counts.set(norm, (counts.get(norm) || 0) + 1);
    if (!example.has(norm)) example.set(norm, `${u.file}:${u.line}`);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
  for (const [norm, count] of ranked) console.log(`    ${norm}  x${count}  e.g. ${example.get(norm)}`);
}

function runOne({ repoArg, packArg, outArg, strictArg, baselineArg }) {
  const packPath = packArg ? resolvePackPath(packArg) : null;
  const result = scanRepo({ repo: repoArg, pack: packArg, packPath });
  if (result.error) {
    console.error(`  ERROR: ${result.error}`);
    return { code: 2, result };
  }
  console.log('');
  console.log(`  brand-drift — ${result.repo}`);
  console.log(`  pack   ${result.pack || '(none — everything below is UNREGISTERED, counts only)'}${result.packName ? '  ' + result.packName : ''}`);
  console.log(`  files  ${result.files} total, ${result.scanned} scanned, ${result.excluded.length} excluded`);
  console.log(`  excluded by  ${result.excludePatterns.join(', ')}`);
  console.log('');
    if (result.generated && result.generated.length) console.log(`  generated from the pack, exempt: ${result.generated.join(', ')}`);
  if (result.brand.length) {
    console.log(`  BRAND (hardcoded, lock #1 violation): ${result.brand.length} hit(s), ${result.brandUnique} distinct value(s)`);
    printBrandHits(result.brand);
  } else if (result.pack) {
    console.log('  BRAND: none');
  }
  console.log('');
  console.log(`  UNREGISTERED (warn only): ${result.unregistered.length} hit(s), ${result.unregisteredUnique} distinct value(s)`);
  if (result.unregistered.length) printUnregisteredTop(result.unregistered);
  console.log('');
  if (result.scanned === 0) {
    console.log('  ZERO files scanned. This is a blind gate, not a clean one.');
    return { code: 2, result };
  }

  // ---- Phase A step 4: FONT / WEIGHT / BUTTON / NOKIT / NOBRIEF ----
  const { strict, notes: strictNotes } = resolveStrictSet(repoArg, strictArg);
  console.log(`  --- new categories (WARN by default; strict this run: ${strict.size ? [...strict].join(', ') : 'none'}) ---`);
  for (const n of strictNotes) console.log(`  note: ${n}`);
  printCategoryHits('FONT', result.font);
  printCategoryHits('WEIGHT', result.weight);
  printCategoryHits('BUTTON', result.button);
  if (result.nokitSkipped) console.log(`  NOKIT: skipped — ${result.nokitSkipped}`);
  else printCategoryHits('NOKIT', result.nokit);
  printCategoryHits('NOBRIEF (advisory until Phase B, never fails)', result.nobrief);
  console.log('');

  const counts = categoryCounts(result);
  let code = result.brand.length ? 1 : 0;
  const strictBreaches = [];
  for (const cat of strict) {
    if ((counts[cat] || 0) > 0) { strictBreaches.push(cat); code = 1; }
  }
  if (strictBreaches.length) console.log(`  STRICT FAIL: ${strictBreaches.join(', ')} has hits and is opted into failing.`);

  let ratchetBreaches = [];
  if (baselineArg) {
    const baselinePath = resolve(baselineArg);
    const { breaches, notes } = applyCategoryBaseline(baselinePath, counts);
    for (const n of notes) console.log(`  ${n}`);
    ratchetBreaches = breaches;
    if (breaches.length) {
      code = 1;
      for (const b of breaches) console.log(`  RATCHET BREACH: ${b.category} rose from baseline ${b.baseline} to ${b.now}.`);
    }
  }

  return { code, result, counts, strictBreaches, ratchetBreaches };
}

function runEstate(estatePath, outArg) {
  let list;
  try { list = JSON.parse(readFileSync(resolve(estatePath), 'utf8')); }
  catch (e) { console.error(`  ERROR: cannot read estate file ${estatePath}: ${e.message}`); return 2; }

  console.log('');
  console.log('  surface                repo                                        pack              scanned  BRAND  brand-uniq  unreg-uniq  FONT  WEIGHT  BUTTON  NOKIT  NOBRIEF  verdict');
  // Note: --estate never applies --strict or --baseline (that per-repo, per-category
  // gating is estate-status.mjs's job, Phase A step 4 Part 3 — see GATE-LINT-PLAN.md).
  // These columns are counts only here, same WARN-by-default posture as the CLI default.
  let worstCode = 0;
  const results = [];
  for (const row of list) {
    const { surface, repo, pack = null, exclude } = row;
    const absRepo = resolve(repo);
    if (!existsSync(absRepo)) {
      console.log(`  ${pad(surface, 22)}  ${pad(repo, 42)}  ${pad('-', 16)}  ${pad('-', 7)}  ${pad('-', 5)}  ${pad('-', 10)}  ${pad('-', 10)}  ${pad('-', 4)}  ${pad('-', 6)}  ${pad('-', 6)}  ${pad('-', 5)}  ${pad('-', 7)}  MISSING`);
      worstCode = 2;
      results.push({ surface, repo, error: 'MISSING' });
      continue;
    }
    const packPath = pack ? resolvePackPath(pack) : null;
    const r = scanRepo({ repo: absRepo, pack, packPath, ...(exclude ? { exclude: [...DEFAULT_EXCLUDE, ...exclude] } : {}) });
    if (r.error) {
      console.log(`  ${pad(surface, 22)}  ${pad(repo, 42)}  ${pad(pack || '-', 16)}  ERROR: ${r.error}`);
      worstCode = 2;
      results.push({ surface, repo, error: r.error });
      continue;
    }
    const verdict = !pack ? 'NO PACK' : (r.brand.length > 0 ? 'DRIFT' : 'CLEAN');
    if (verdict === 'DRIFT') worstCode = Math.max(worstCode, 1);
    const nokitCell = r.nokitSkipped ? 'n/a' : String(r.nokit.length);
    console.log(`  ${pad(surface, 22)}  ${pad(repo, 42)}  ${pad(pack || '-', 16)}  ${pad(String(r.scanned), 7)}  ${pad(String(r.brand.length), 5)}  ${pad(String(r.brandUnique), 10)}  ${pad(String(r.unregisteredUnique), 10)}  ${pad(String(r.font.length), 4)}  ${pad(String(r.weight.length), 6)}  ${pad(String(r.button.length), 6)}  ${pad(nokitCell, 5)}  ${pad(String(r.nobrief.length), 7)}  ${verdict}`);
    results.push({ surface, ...r });
  }
  console.log('');
  if (outArg) {
    writeFileSync(resolve(outArg), JSON.stringify(results, null, 2));
    console.log(`  full results written to ${resolve(outArg)}`);
  }
  return worstCode;
}

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

// ---------- main ----------
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : (argv[i + 1] || true); };

if (import.meta.url === `file://${process.argv[1]}`) {
  if (argv.includes('--selftest')) {
    process.exit(selftest() === 0 ? 0 : 2);
  } else if (flag('--estate')) {
    process.exit(runEstate(flag('--estate'), flag('--out')));
  } else if (flag('--repo')) {
    const strictFlag = flag('--strict');
    const strictArg = strictFlag && strictFlag !== true ? strictFlag.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : [];
    const baselineFlag = flag('--baseline');
    const baselineArg = baselineFlag && baselineFlag !== true ? baselineFlag : null;
    const { code } = runOne({
      repoArg: flag('--repo'),
      packArg: flag('--pack') && flag('--pack') !== true ? flag('--pack') : null,
      outArg: flag('--out'),
      strictArg,
      baselineArg
    });
    process.exit(code);
  } else {
    console.error('usage: brand-drift.mjs --repo <path> [--pack <slug|path>] [--strict CSV] [--baseline <file>] | --estate <estate.json> [--out <file>] | --selftest');
    process.exit(2);
  }
}
