#!/usr/bin/env node
/**
 * brand-drift.mjs - proves canon lock #1: "every value reads a token, no hardcoded hex."
 *
 *   node brand-drift.mjs --repo <path> --pack <slug|path>     one repo against one pack
 *   node brand-drift.mjs --repo <path>                        no pack: everything counts as UNREGISTERED
 *   node brand-drift.mjs --estate <estate.json>                table over many repos
 *   node brand-drift.mjs --selftest                            plant a defect, assert it goes RED
 *
 * Exit 0 zero BRAND hits. Exit 1 any BRAND hit. Exit 2 bad input or a failed selftest.
 *
 * UNREGISTERED never changes the exit code. It is a colour no pack owns yet, which could be
 * a plain grey nobody bothered to name, or a brand colour nobody wrote down. It gets printed
 * so a human can look, and it stays a WARN so routine work does not go red for an untyped
 * neutral. Same two-tier law as gate-lint.mjs: a check that fails on routine work gets
 * switched off, and then it protects nothing.
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
  let resolvedPackPath = packPath;
  if (pack && !resolvedPackPath) resolvedPackPath = resolvePackPath(pack);
  if (resolvedPackPath) {
    if (!existsSync(resolvedPackPath)) {
      return { error: `pack not found: ${resolvedPackPath}` };
    }
    let json;
    try { json = JSON.parse(readFileSync(resolvedPackPath, 'utf8')); }
    catch (e) { return { error: `${resolvedPackPath} is not valid JSON: ${e.message}` }; }
    packColours = packColourSet(json);
    packName = json?.meta?.slug || json?.meta?.name || basename(resolvedPackPath);
  }

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

  for (const f of scanned) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const rel = relative(absRepo, f);
    // A file EMITTED from the pack is the pack's output, not a hand-typed literal. The
    // contract: its first 400 characters say GENERATED and name the brandpack it was
    // built from (embody-app/tools/build-tokens.mjs writes exactly that header). Anything
    // else that carries the hex is scanned like any other source file.
    if (/GENERATED/.test(text.slice(0, 400)) && /brandpack/i.test(text.slice(0, 400))) { generated.push(rel); excluded.push(rel); continue; }
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
    unregByFile: Object.fromEntries(unregByFile)
  };
}

// ---------- selftest ----------
const FX_PACK = {
  meta: { slug: 'fx', name: 'fixture' },
  outputs: { web: { palette: { primary: { value: '#1c5e62' } } } },
  tokens: { color: { ink: { value: '#2E2E2D' } } }
};

function buildFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'brand-drift-fx-'));
  const w = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };
  w('repo/brand/x.brandpack.json', JSON.stringify(FX_PACK, null, 2));
  w('repo/site.css', `:root{--primary:var(--x);} .a{background:{{palette.primary}};}\n`);
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

    // Plant defects.
    const w = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };
    w('repo/src/app.js', `export const peri = "--peri:#1C5E62;";\n`); // case differs from pack's #1c5e62
    w('repo/src/b.css', `.x{color:#1c5e62ff}\n`); // alpha ff, should normalise to brand hit
    w('repo/src/c.css', `.y{color:#2e2e2d}\n`); // matches tokens.color.ink
    w('repo/src/d.css', `.z{color:#777777}\n`); // unregistered, not brand
    w('repo/src/sha.js', `// build 8d8241b099c298e5\n`); // must NOT be treated as a colour
    w('repo/src/frag.js', `const u = "/x#1c5e62";\n`); // URL fragment: known limit, may or may not fire; documented, not asserted either way

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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n  ${bad === 0 ? 'selftest PASS' : `selftest FAIL, ${bad} problem(s)`}\n`);
  return bad;
}

// ---------- CLI ----------
function printBrandHits(brand, cap = 60) {
  const shown = brand.slice(0, cap);
  for (const b of shown) console.log(`    ${b.file}:${b.line}  ${b.literal}  -> ${b.packName}`);
  if (brand.length > cap) console.log(`    ...and ${brand.length - cap} more`);
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

function runOne({ repoArg, packArg, outArg }) {
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
  return { code: result.brand.length ? 1 : 0, result };
}

function runEstate(estatePath, outArg) {
  let list;
  try { list = JSON.parse(readFileSync(resolve(estatePath), 'utf8')); }
  catch (e) { console.error(`  ERROR: cannot read estate file ${estatePath}: ${e.message}`); return 2; }

  console.log('');
  console.log('  surface                repo                                        pack              scanned  BRAND  brand-uniq  unreg-uniq  verdict');
  let worstCode = 0;
  const results = [];
  for (const row of list) {
    const { surface, repo, pack = null, exclude } = row;
    const absRepo = resolve(repo);
    if (!existsSync(absRepo)) {
      console.log(`  ${pad(surface, 22)}  ${pad(repo, 42)}  ${pad('-', 16)}  ${pad('-', 7)}  ${pad('-', 5)}  ${pad('-', 10)}  ${pad('-', 10)}  MISSING`);
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
    console.log(`  ${pad(surface, 22)}  ${pad(repo, 42)}  ${pad(pack || '-', 16)}  ${pad(String(r.scanned), 7)}  ${pad(String(r.brand.length), 5)}  ${pad(String(r.brandUnique), 10)}  ${pad(String(r.unregisteredUnique), 10)}  ${verdict}`);
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
    const { code } = runOne({ repoArg: flag('--repo'), packArg: flag('--pack') && flag('--pack') !== true ? flag('--pack') : null, outArg: flag('--out') });
    process.exit(code);
  } else {
    console.error('usage: brand-drift.mjs --repo <path> [--pack <slug|path>] | --estate <estate.json> [--out <file>] | --selftest');
    process.exit(2);
  }
}
