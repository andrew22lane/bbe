#!/usr/bin/env node
/**
 * gate-lint.mjs - the one check that runs before a site engine build ships.
 *
 *   node gate-lint.mjs --brand bex            every check, bex+Co.
 *   node gate-lint.mjs --brand dh             every check, Design Hacker
 *   node gate-lint.mjs --brand bex --only TOKEN-DRIFT
 *   node gate-lint.mjs --selftest             plant every defect, assert each check goes RED
 *   node gate-lint.mjs --list                 print the check table and the resolved config
 *
 * Exit 0 clean. Exit 1 any FAIL. Exit 2 the lint could not run, or its selftest failed.
 *
 * Zero dependencies, Node stdlib only. Plan and reasoning: GATE-LINT-PLAN.md next door.
 *
 * FIVE of the seven checks DELEGATE to a gate that already exists. That is the point.
 * The canon (core/BRAND-BUILDER-ENGINE.md §8) counted 32 forked `*gate*.py` files in this
 * vault, copygate-v2.py in five places with five different hashes. A new check goes in here
 * only after the search for an existing gate that already does it comes back empty.
 *
 * WARN and FAIL are two tiers. A WARN prints and that is ALL it does; it never changes the
 * exit code. Copied from scripts/vault-lint.mjs for its reason: a gate that goes red on
 * routine work gets switched off, and then it protects nothing.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdtempSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { join, relative, dirname, basename, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { scanRepo } from './brand-drift.mjs';

const HOME = homedir();
let VAULT = process.env.VAULT || join(HOME, 'dh-work', 'dh-hub', 'vault');
const SCL = process.env.SCL || join(HOME, 'Documents', 'Claude', 'Projects', 'Design Hacker', 'Site-Control-Layer');

// ---------- brand config: a new brand is a new row, never new code ----------
const BRANDS = {
  bex: {
    label: 'bex+Co.',
    repo: process.env.REPO_BEX || join(HOME, 'dh-work', 'bex-site'),
    packSlug: 'bex-co',
    rules: join(VAULT, 'clients', 'bex', 'messaging-rules.json'),
    distGlob: /^dist/,
    scl: null,           // bex has no Site Desk recipes
    engineRole: 'source' // bex-site is the ruled HOME of engine/
  },
  dh: {
    label: 'Design Hacker',
    repo: process.env.REPO_DH || join(HOME, 'dh-work', 'design-hacker-apex'),
    packSlug: 'design-hacker',
    rules: join(VAULT, 'brands', 'design-hacker', 'messaging-rules.json'),
    distGlob: /^dist-l-/, // the full 153-page surface; dist-a-* is the 11-file apex home
    scl: SCL,
    engineRole: 'mirror'
  }
};

// Frozen copies of the real world. The selftest re-aims VAULT and BRANDS at a temp
// fixture, so the fixture builder must read the REAL paths, never the aimed ones.
const VAULT_REAL = VAULT;
const SCL_REAL = SCL;
const BRANDS_REAL = { bex: { ...BRANDS.bex }, dh: { ...BRANDS.dh } };

// ---------- helpers ----------
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function walkFiles(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === '.git' || name === 'node_modules') continue;
    const p = join(dir, name);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walkFiles(p, out); else out.push(p);
  }
  return out;
}

/** Run a command, never throw. Returns {code, out}. A tool that is missing is code -1. */
function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    return { code: 0, out };
  } catch (e) {
    if (e.code === 'ENOENT') return { code: -1, out: String(e.message) };
    return { code: typeof e.status === 'number' ? e.status : 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

/** Newest directory under `repo` whose name matches `rx`. Returns {path, mtime, files} or null. */
function newestDist(repo, rx) {
  let best = null;
  let entries; try { entries = readdirSync(repo); } catch { return null; }
  for (const name of entries) {
    if (!rx.test(name)) continue;
    const p = join(repo, name);
    let s; try { s = statSync(p); } catch { continue; }
    if (!s.isDirectory()) continue;
    if (!best || s.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: s.mtimeMs, mtime: s.mtime };
  }
  if (!best) return null;
  best.files = walkFiles(best.path).length;
  return best;
}

/** Strip CSS comments, then pull every `--name: value` out of every `:root{...}` block. */
export function rootTokens(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map();
  const rx = /:root\s*\{([^}]*)\}/g;
  let m;
  while ((m = rx.exec(clean)) !== null) {
    for (const decl of m[1].split(';')) {
      const d = decl.trim();
      if (!d.startsWith('--')) continue;
      const c = d.indexOf(':');
      if (c === -1) continue;
      out.set(d.slice(2, c).trim(), d.slice(c + 1).trim());
    }
  }
  return out;
}

/**
 * Visible text out of a built HTML page, ONE SENTENCE PER BLOCK.
 *
 * The gate splits sentences on `.!?` only, never on newlines. A page is full of block
 * elements that carry no terminating punctuation — stat tiles, nav links, table cells — so
 * flattening the whole page to spaces glues unrelated blocks into one enormous "sentence".
 * Measured on the DH apex build 2026-09-02: a "15+ Years in design" stat tile fused with a
 * blog card headline three elements away and fired a killed-line rule neither block broke.
 *
 * So block boundaries become sentence boundaries. Every block is trimmed, empties dropped,
 * and each one that does not already end in punctuation gets a period. Script, style,
 * noscript and svg go whole.
 */
const BLOCK = /<\/?(?:p|div|section|article|header|footer|nav|main|aside|ul|ol|li|h[1-6]|table|thead|tbody|tr|td|th|blockquote|figure|figcaption|form|label|button|dl|dt|dd|pre|br|hr)\b[^>]*>/gi;

export function visibleText(html) {
  const blocks = html
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(BLOCK, '\u0000')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#8217;|&rsquo;/g, "'").replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .split('\u0000');
  const out = [];
  for (const b of blocks) {
    const t = b.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    out.push(/[.!?:;]$/.test(t) ? t : t + '.');
  }
  return out.join('\n');
}


// ---------- the checks ----------
// Each returns { fail: [], warn: [], skip?: string, note?: [] }.
// A check NEVER fixes anything. Every finding prints the command that fixes it.

const CHECKS = {

  /** One engine, not two. Delegates to tools/engine-parity.mjs in the mirror repo. */
  'ENGINE-PARITY': (ctx) => {
    const fail = [], warn = [], note = [];
    const src = join(BRANDS.bex.repo, 'engine');
    const mirrorRepo = BRANDS.dh.repo;
    const tool = join(mirrorRepo, 'tools', 'engine-parity.mjs');
    if (!existsSync(tool)) return { fail: [`tools/engine-parity.mjs is not at ${tool}. The cross-repo engine check cannot run.`], warn };
    if (!existsSync(src)) return { fail: [`the engine SOURCE ${src} is not on this machine, so byte-identity cannot be proved. Check out the bex-site repo, or set REPO_BEX.`], warn };
    if (!existsSync(join(mirrorRepo, 'engine'))) return { fail: [`the engine MIRROR ${join(mirrorRepo, 'engine')} does not exist. This checkout predates the shared core; it is on an old ref.`], warn };

    const r = run('node', [tool], { cwd: mirrorRepo, env: { ...process.env, ENGINE_SRC: src } });
    // The tool passes when it cannot find the source. Correct in a cloud session, WRONG here:
    // both checkouts are on disk, so a "trusted" pass is a pass measured on nothing.
    if (/mirror trusted/.test(r.out)) {
      fail.push(`engine-parity reported "mirror trusted" while BOTH checkouts exist on disk. It measured nothing. Source: ${src}`);
      return { fail, warn };
    }
    note.push(`source ${src}`, `mirror ${join(mirrorRepo, 'engine')}`);
    if (r.code !== 0) fail.push(`engine/ differs between the two repos:\n${r.out.trim().split('\n').map((l) => '      ' + l).join('\n')}\n      fix: copy the SOURCE over the mirror, never the other way. bex-site is the ruled home.`);
    return { fail, warn, note };
  },

  /** The repo's pack mirror equals the vault canonical. Delegates to tools/pack-parity.mjs. */
  'PACK-PARITY': (ctx) => {
    const fail = [], warn = [], note = [];
    const tool = join(ctx.repo, 'tools', 'pack-parity.mjs');
    if (!existsSync(tool)) return { fail: [`tools/pack-parity.mjs is not at ${tool}.`], warn };
    if (!existsSync(ctx.packCanonical)) return { fail: [`the vault canonical pack ${ctx.packCanonical} is not on this machine, so parity cannot be proved.`], warn };
    if (!existsSync(ctx.packMirror)) return { fail: [`the repo pack mirror ${ctx.packMirror} does not exist.`], warn };

    const r = run('node', [tool], { cwd: ctx.repo, env: { ...process.env, PACK: ctx.cfg.packSlug, BRANDPACK_CANONICAL: ctx.packCanonical } });
    if (/mirror trusted/.test(r.out)) {
      fail.push(`pack-parity reported "mirror trusted" while the canonical exists at ${ctx.packCanonical}. It measured nothing.`);
      return { fail, warn };
    }
    note.push(`mirror ${relative(ctx.repo, ctx.packMirror)} vs vault canonical`);
    if (r.code !== 0) fail.push(`the pack mirror and the vault canonical disagree:\n${r.out.trim().split('\n').map((l) => '      ' + l).join('\n')}`);
    return { fail, warn, note };
  },

  /** Every page recipe parses and resolves. Delegates to Site-Control-Layer/validate-site.mjs. */
  'RECIPE-RESOLVES': (ctx) => {
    if (!ctx.cfg.scl) return { fail: [], warn: [], skip: 'this brand has no Site Desk recipes' };
    const tool = join(ctx.cfg.scl, 'validate-site.mjs');
    if (!existsSync(tool)) return { fail: [`validate-site.mjs is not at ${tool}.`], warn: [] };
    const r = run('node', [tool], { cwd: ctx.cfg.scl });
    if (r.code === 0) return { fail: [], warn: [], note: [`${ctx.cfg.scl}`] };
    return { fail: [`validate-site.mjs is red:\n${r.out.trim().split('\n').map((l) => '      ' + l).join('\n')}`], warn: [] };
  },

  /**
   * No locked section moved. validate-site.mjs already hashes locked sections and fails on
   * drift, so this check adds the assertion nothing makes: that a baseline EXISTS at all.
   * An empty lock-hashes.json makes the drift check structurally incapable of failing.
   */
  'SECTION-LOCKS': (ctx) => {
    if (!ctx.cfg.scl) return { fail: [], warn: [], skip: 'this brand has no Site Desk recipes' };
    const fail = [], warn = [], note = [];
    const rdir = join(ctx.cfg.scl, 'page-recipes');
    const hfile = join(ctx.cfg.scl, 'quality-checks', 'lock-hashes.json');
    if (!existsSync(rdir)) return { fail: [`page-recipes/ is not at ${rdir}.`], warn };

    let hashes = {};
    if (existsSync(hfile)) { try { hashes = JSON.parse(readFileSync(hfile, 'utf8')); } catch (e) { fail.push(`${hfile} is not valid JSON: ${e.message}`); } }
    else warn.push(`no lock-hash baseline at ${hfile}. validate-site.mjs writes one the first time it sees a locked section.`);

    let recipes = 0, sections = 0, locked = 0, unbaselined = [];
    for (const f of readdirSync(rdir)) {
      if (!f.endsWith('.json')) continue;
      const p = join(rdir, f);
      let j; try { j = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { fail.push(`${f} is not valid JSON: ${e.message}`); continue; }
      recipes++;
      for (const s of (j.sections || [])) {
        sections++;
        if (s.locked && s.locked.design === true) {
          locked++;
          if (!(s.id in hashes)) unbaselined.push(`${f}#${s.id}`);
        }
      }
    }
    note.push(`${recipes} recipe(s), ${sections} section(s), ${locked} with locked.design true, ${Object.keys(hashes).length} hashed baseline(s)`);
    if (unbaselined.length) {
      fail.push(`${unbaselined.length} locked section(s) have no baseline hash, so the drift check cannot fail on them:\n      ${unbaselined.join('\n      ')}\n      fix: run \`node validate-site.mjs\` in ${ctx.cfg.scl} once to write the baseline.`);
    }
    if (locked === 0) {
      warn.push(`no section is locked yet (${sections} section(s) across ${recipes} recipe(s), all locked.design false). The lock drift check has nothing to guard today.`);
    }
    return { fail, warn, note };
  }
};

/**
 * No rendered page ships a line the brand killed. Delegates to core/gates/messaging-gate.mjs,
 * the one word gate, which runs its own probes before it reports.
 *
 * The gate reads PROSE. A built page is HTML, and tag soup destroys the sentence boundaries
 * the gate's SUBJECT rule depends on, so a raw HTML scan would skip most of the page and
 * report clean. Visible text is extracted to a temp dir first, and the extracted character
 * count is printed so an empty extraction is visible instead of silent.
 */
CHECKS['KILLED-LINES'] = (ctx) => {
  const fail = [], warn = [], note = [];
  const gate = join(VAULT, 'core', 'gates', 'messaging-gate.mjs');
  if (!existsSync(gate)) return { fail: [`messaging-gate.mjs is not at ${gate}.`], warn };
  if (!existsSync(ctx.cfg.rules)) return { fail: [`the brand's messaging rules are not at ${ctx.cfg.rules}.`], warn };
  if (!ctx.dist) return { fail: [`no built output found in ${ctx.repo}. Run the build first; this lint never builds.`], warn };

  const pages = walkFiles(ctx.dist.path).filter((f) => f.endsWith('.html'));
  if (!pages.length) return { fail: [`${ctx.dist.path} holds no .html pages.`], warn };

  const tmp = mkdtempSync(join(tmpdir(), 'gate-lint-text-'));
  let chars = 0, written = 0;
  try {
    for (const p of pages) {
      const text = visibleText(readFileSync(p, 'utf8'));
      if (!text) continue;
      chars += text.length;
      const name = relative(ctx.dist.path, p).replace(/[\\/]/g, '__').replace(/\.html$/, '.txt');
      writeFileSync(join(tmp, name), text);
      written++;
    }
    note.push(`${pages.length} page(s), ${written} with text, ${chars.toLocaleString()} chars extracted`);
    if (!chars) {
      fail.push(`extracted ZERO characters of visible text from ${pages.length} page(s). The gate would have reported clean while measuring nothing.`);
      return { fail, warn, note };
    }

    const r = run('node', [gate, '--rules', ctx.cfg.rules, join(tmp, '*.txt')]);
    if (r.code === 2) {
      // Exit 2 is the gate saying its own probes failed. A clean result from a blind
      // detector is worth nothing, so this is a FAIL and never a pass.
      fail.push(`the messaging gate failed its own probes (exit 2). Its result is not trustworthy:\n${r.out.trim().split('\n').map((l) => '      ' + l).join('\n')}`);
    } else if (r.code !== 0) {
      fail.push(`killed lines on rendered pages:\n${r.out.trim().split('\n').map((l) => '      ' + l).join('\n')}`);
    }

    // The headline pass runs only where the brand ruled headline limits.
    let hasHeadlines = false;
    try { hasHeadlines = !!JSON.parse(readFileSync(ctx.cfg.rules, 'utf8')).headlines; } catch { /* reported above */ }
    if (hasHeadlines) {
      const h = run('node', [gate, '--rules', ctx.cfg.rules, '--headlines', join(tmp, '*.txt')]);
      if (h.code === 1) warn.push(`over-length headlines (the rules file measures markdown headings; extracted page text has none, so this is informational):\n${h.out.trim().split('\n').slice(0, 6).map((l) => '      ' + l).join('\n')}`);
    } else {
      note.push('no headline block in this brand rules file, headline pass skipped');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { fail, warn, note };
};

/**
 * TOKEN-DRIFT, the check nothing performed before this file existed.
 *
 * tools/drift.mjs compares three layers of the pack to EACH OTHER and never opens a built
 * file. So the pack could claim a colour the site had never shipped, and it did: the canon
 * records the pack's gold #b08b50 against the site's actual #9a6b2f.
 *
 *   1 named token mismatch  FAIL   the pack and the built :root disagree on --<name>
 *   2 dead pack token       FAIL   a palette value that appears nowhere in the build
 *   3 unowned rendered token WARN  a --<name> in the build with no palette leaf to own it
 */
CHECKS['TOKEN-DRIFT'] = (ctx) => {
  const fail = [], warn = [], note = [];
  if (!existsSync(ctx.packMirror)) return { fail: [`the brand pack is not at ${ctx.packMirror}.`], warn };
  if (!ctx.dist) return { fail: [`no built output found in ${ctx.repo}. Run the build first; this lint never builds.`], warn };

  let pack; try { pack = JSON.parse(readFileSync(ctx.packMirror, 'utf8')); }
  catch (e) { return { fail: [`${ctx.packMirror} is not valid JSON: ${e.message}`], warn }; }
  const palette = pack?.outputs?.web?.palette;
  if (!palette) return { fail: [`${basename(ctx.packMirror)} has no outputs.web.palette. The OUTPUT layer is missing for this brand; nothing to compare.`], warn };

  // Flatten palette leaves. A leaf is {value, ...}; a group is {700:{value},800:{value}}.
  const leaves = new Map(); // name -> value
  // Nested groups join with a HYPHEN, not a dot: the pack writes teal: { "800": {...} }
  // and the stylesheet writes --teal-800. Joining with a dot names a token that exists
  // nowhere, so all five teal stops fell through to the "nobody owns it" warning instead
  // of being compared. Measured on the bex build, 2026-09-02.
  const flatten = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_') || !v || typeof v !== 'object') continue;
      const name = prefix ? `${prefix}-${k}` : k;
      if (typeof v.value === 'string') leaves.set(name, v.value);
      else flatten(v, name);
    }
  };
  flatten(palette, '');

  // Rendered tokens. bex inlines a MINIFIED :root inside index.html; DH apex links an
  // UNMINIFIED assets/site.css whose :root carries a /* comment */ on most lines. A parser
  // that assumes one shape reports a confident clean on the other, so scan BOTH and strip
  // comments first.
  const built = walkFiles(ctx.dist.path).filter((f) => /\.(html|css)$/i.test(f));
  const rendered = new Map(); // name -> {value, file}
  let haystack = '';
  for (const f of built) {
    const src = readFileSync(f, 'utf8');
    haystack += src;
    for (const [k, v] of rootTokens(src)) if (!rendered.has(k)) rendered.set(k, { value: v, file: relative(ctx.dist.path, f) });
  }
  note.push(`${leaves.size} pack palette leaf/leaves, ${rendered.size} rendered :root custom propert(ies) across ${built.length} built file(s)`);

  if (rendered.size === 0) {
    fail.push(`found ZERO custom properties in ${built.length} built file(s) under ${ctx.dist.path}. The drift check would have reported clean on an empty set.`);
    return { fail, warn, note };
  }

  // The packs name their own known strays. Suppress those from the unowned WARN.
  const stayed = JSON.stringify(pack?.outputs?.web?.palette?._stayed ?? pack?.outputs?.web?.palette?.strays ?? '');

  for (const [name, value] of leaves) {
    const r = rendered.get(name);
    if (r) {
      if (r.value !== value) {
        if (r.value.toLowerCase() === value.toLowerCase()) warn.push(`--${name} differs only in letter case: pack "${value}", built "${r.value}" (${r.file}). The pack stores the exact literal the build substitutes back.`);
        else fail.push(`--${name} DRIFT: the pack says "${value}", the built site ships "${r.value}" (${r.file}).\n      fix: one of the two is wrong. The built site is the shipped truth; change the pack, or change the source and rebuild.`);
        continue;
      }
    }
    // Dead pack token: claimed by the pack, present nowhere in the build.
    if (!haystack.includes(value)) {
      fail.push(`palette "${name}" claims "${value}" and that literal appears NOWHERE in the built output. This is the #b08b50 bug: a pack colour the site has never shipped.`);
    }
  }

  // The palette owns COLOUR. Warning on --space-lg or --r-card would bury the real finding
  // under 60 lines of spacing tokens, and a report nobody reads protects nothing. A value is
  // a colour when it is a bare hex, rgb/rgba or hsl/hsla literal. A gradient or a var()
  // reference is a composition of colours, not a colour, and belongs to whatever it cites.
  const isColour = (v) => /^#[0-9a-f]{3,8}$/i.test(v) || /^(rgba?|hsla?)\([^)]*\)$/i.test(v);
  const unowned = [];
  for (const [name, r] of rendered) {
    if (leaves.has(name)) continue;
    if (stayed.includes(name)) continue;
    if (!isColour(r.value)) continue;
    unowned.push(`--${name} ("${r.value}", ${r.file})`);
  }
  if (unowned.length) {
    warn.push(`${unowned.length} rendered COLOUR token(s) no palette leaf owns:\n      ${unowned.slice(0, 20).join('\n      ')}`
      + (unowned.length > 20 ? `\n      ...and ${unowned.length - 20} more` : ''));
  }

  return { fail, warn, note };
};

/**
 * HARDCODED-BRAND, canon lock #1: "every value reads a token, no hardcoded hex."
 *
 * TOKEN-DRIFT compares the pack to the BUILD (a dist folder). This check compares the pack
 * to the SOURCE repo: every file the site is generated FROM, not just the output. A build
 * can look clean while the generator that made it still has a brand colour typed in by
 * hand, one edit away from drifting again the next time someone touches that file. Delegates
 * to brand-drift.mjs, which does the actual scanning; see that file for the classification
 * rules (BRAND vs UNREGISTERED) and the excluded-path list.
 */
CHECKS['HARDCODED-BRAND'] = (ctx) => {
  const fail = [], warn = [], note = [];
  if (!existsSync(ctx.packCanonical)) return { fail: [`the vault canonical pack ${ctx.packCanonical} is not on this machine, so hardcoded-brand cannot be proved against anything.`], warn };
  const r = scanRepo({ repo: ctx.repo, packPath: ctx.packCanonical });
  if (r.error) return { fail: [r.error], warn };

  note.push(`${r.scanned} file(s) scanned, ${r.excluded.length} excluded, ${r.packColours} pack colour(s) checked against`);

  if (r.scanned === 0) {
    fail.push(`ZERO files scanned under ${ctx.repo}. This is a blind gate, not a clean one.`);
    return { fail, warn, note };
  }

  if (r.brand.length) {
    const shown = r.brand.slice(0, 20);
    fail.push(`${r.brand.length} hardcoded brand colour literal(s) found (${r.brandUnique} distinct value(s)):\n`
      + shown.map((b) => `      ${b.file}:${b.line}  ${b.literal}  (${b.packName})`).join('\n')
      + (r.brand.length > shown.length ? `\n      ...and ${r.brand.length - shown.length} more` : '')
      + `\n      fix: read the value from the pack through the engine; the pack is the only file allowed to hold this literal.`);
  }

  if (r.unregistered.length) {
    const counts = new Map();
    for (const u of r.unregistered) counts.set(u.literal.toLowerCase(), (counts.get(u.literal.toLowerCase()) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([lit, n]) => `${lit} x${n}`).join(', ');
    warn.push(`${r.unregistered.length} unregistered colour literal(s), ${r.unregisteredUnique} distinct, no pack leaf owns them yet (top: ${top}). Could be plain utility greys, could be an unrecorded brand colour.`);
  }

  return { fail, warn, note };
};

const ORDER = ['ENGINE-PARITY', 'PACK-PARITY', 'RECIPE-RESOLVES', 'SECTION-LOCKS', 'KILLED-LINES', 'TOKEN-DRIFT', 'HARDCODED-BRAND'];

// ---------- context ----------
function context(brand) {
  const cfg = BRANDS[brand];
  if (!cfg) { console.error(`unknown brand "${brand}". Known: ${Object.keys(BRANDS).join(', ')}`); process.exit(2); }
  const repo = cfg.repo;
  const dist = process.env.DIST
    ? { path: resolve(process.env.DIST), mtime: existsSync(resolve(process.env.DIST)) ? statSync(resolve(process.env.DIST)).mtime : null, files: walkFiles(resolve(process.env.DIST)).length }
    : newestDist(repo, cfg.distGlob);
  return {
    brand, cfg, repo, dist,
    packMirror: join(repo, 'brand', `${cfg.packSlug}.brandpack.json`),
    packCanonical: join(VAULT, 'core', 'brand-packs', `${cfg.packSlug}.brandpack.json`)
  };
}

function lint(ctx, only) {
  const results = {};
  for (const name of ORDER) {
    if (only && name !== only) continue;
    let r;
    try { r = CHECKS[name](ctx); }
    catch (e) { r = { fail: [`the check threw: ${e.message}`], warn: [] }; }
    results[name] = { fail: r.fail || [], warn: r.warn || [], note: r.note || [], skip: r.skip || null };
  }
  return results;
}

function report(ctx, results) {
  console.log('');
  console.log(`  gate-lint — ${ctx.cfg.label} (--brand ${ctx.brand})`);
  console.log(`  repo  ${ctx.repo}`);
  console.log(`  pack  ${ctx.cfg.packSlug}`);
  console.log(`  built ${ctx.dist ? `${ctx.dist.path}  (${ctx.dist.files} files, ${ctx.dist.mtime ? ctx.dist.mtime.toISOString() : 'unknown mtime'})` : 'NONE FOUND — this lint never runs a build'}`);
  console.log('');
  let fails = 0, warns = 0;
  for (const [name, r] of Object.entries(results)) {
    if (r.skip) { console.log(`  SKIP ${name}  — ${r.skip}`); continue; }
    const tag = r.fail.length ? 'FAIL' : 'ok  ';
    console.log(`  ${tag} ${name}${r.note.length ? '  — ' + r.note.join('; ') : ''}`);
    for (const f of r.fail) console.log(`       ${f}`);
    for (const w of r.warn) console.log(`       warn: ${w}`);
    fails += r.fail.length; warns += r.warn.length;
  }
  console.log('');
  console.log(`  ${fails} failure(s), ${warns} warning(s). A warning never changes the exit code.`);
  console.log('');
  return fails;
}

// ---------- selftest: a gate must be shown to FAIL before it is trusted ----------
const FX_PACK = {
  meta: { slug: 'bex-co', name: 'fixture' },
  outputs: { web: { palette: { primary: { value: '#1c5e62' }, tone: { value: '#fff' } } } }
};
const FX_PAGE = '<!doctype html><html><head><style>:root{--primary:#1c5e62;--tone:#fff;}</style></head>'
  + '<body><h1>bex+Co.</h1><p>A bex+Co. salon is one shared workspace with a front desk.</p></body></html>';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gate-lint-fx-'));
  const w = (p, s) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s); };

  w('vault/core/gates/messaging-gate.mjs', readFileSync(join(VAULT_REAL, 'core', 'gates', 'messaging-gate.mjs'), 'utf8'));
  w('vault/clients/bex/messaging-rules.json', readFileSync(join(VAULT_REAL, 'clients', 'bex', 'messaging-rules.json'), 'utf8'));
  w('vault/core/brand-packs/bex-co.brandpack.json', JSON.stringify(FX_PACK, null, 2));
  w('mirror/brand/bex-co.brandpack.json', JSON.stringify(FX_PACK, null, 2));
  w('src/engine/lib.mjs', 'export const engine = 1;\n');
  w('mirror/engine/lib.mjs', 'export const engine = 1;\n');
  w('mirror/tools/engine-parity.mjs', readFileSync(join(BRANDS_REAL.dh.repo, 'tools', 'engine-parity.mjs'), 'utf8'));
  w('mirror/tools/pack-parity.mjs', readFileSync(join(BRANDS_REAL.dh.repo, 'tools', 'pack-parity.mjs'), 'utf8'));
  w('mirror/dist-l-fx/index.html', FX_PAGE);
  // HARDCODED-BRAND scans mirror/ (ctx.repo) against the vault canonical pack, so a clean
  // fixture needs a source-side file that stays clean (placeholder syntax, no literal) and
  // the pack's own mirror copy already sits under mirror/brand/, which is exempt because
  // .brandpack.json files are never scanned. dist-l-fx/ is exempt because it matches the
  // dist* exclusion.
  w('mirror/src/clean.css', `.a{color:var(--primary);}\n`);
  cpSync(SCL_REAL, join(dir, 'scl'), { recursive: true });
  return dir;
}

function aim(dir) {
  VAULT = join(dir, 'vault');
  BRANDS.bex.repo = join(dir, 'src');
  BRANDS.dh.repo = join(dir, 'mirror');
  BRANDS.dh.packSlug = 'bex-co';
  BRANDS.dh.rules = join(dir, 'vault', 'clients', 'bex', 'messaging-rules.json');
  BRANDS.dh.scl = join(dir, 'scl');
  return context('dh');
}

const DEFECTS = {
  'ENGINE-PARITY': (d) => writeFileSync(join(d, 'mirror/engine/lib.mjs'), 'export const engine = 2;\n'),
  'PACK-PARITY': (d) => {
    const p = JSON.parse(readFileSync(join(d, 'mirror/brand/bex-co.brandpack.json'), 'utf8'));
    p.outputs.web.palette.primary.value = '#000000';
    writeFileSync(join(d, 'mirror/brand/bex-co.brandpack.json'), JSON.stringify(p, null, 2));
  },
  'RECIPE-RESOLVES': (d) => {
    const f = join(d, 'scl/page-recipes/home.json');
    const j = JSON.parse(readFileSync(f, 'utf8'));
    delete j.sections[0].variant;
    writeFileSync(f, JSON.stringify(j, null, 2));
  },
  'SECTION-LOCKS': (d) => {
    const f = join(d, 'scl/page-recipes/home.json');
    const j = JSON.parse(readFileSync(f, 'utf8'));
    j.sections[0].locked.design = true;
    writeFileSync(f, JSON.stringify(j, null, 2));
    writeFileSync(join(d, 'scl/quality-checks/lock-hashes.json'), '{}');
  },
    // The banned word and the brand must sit in the SAME sentence: the gate's SUBJECT rule
  // skips any sentence the brand is not the subject of, and "bex+Co." ends a sentence,
  // so a defect written as "bex+Co. rooms start at..." splits into two and never fires.
  // This is the shape of the rules file's own `probes.bad`.
  'KILLED-LINES': (d) => writeFileSync(join(d, 'mirror/dist-l-fx/index.html'),
    FX_PAGE.replace('A bex+Co. salon is one shared workspace with a front desk.', 'You are leasing 20 rooms at a bex+Co. salon, and booth rental is what bex+Co. does.')),
  'TOKEN-DRIFT': (d) => writeFileSync(join(d, 'mirror/dist-l-fx/index.html'), FX_PAGE.replace('--primary:#1c5e62', '--primary:#1c5e63')),
  'HARDCODED-BRAND': (d) => writeFileSync(join(d, 'mirror/src/hard.css'), '.x{color:#1c5e62}\n')
};

function selftest() {
  console.log('\n  gate-lint selftest: a gate must be shown to FAIL before it is trusted.\n');
  let bad = 0;

  const clean = fixture();
  const base = lint(aim(clean));
  const baseFails = Object.entries(base).filter(([, r]) => r.fail.length);
  if (baseFails.length) {
    bad++;
    console.log('  FAIL the clean baseline fixture is not clean. Every RED below would be meaningless.');
    for (const [n, r] of baseFails) for (const f of r.fail) console.log(`       ${n}: ${f}`);
  } else {
    console.log('  ok   the clean baseline fixture passes every check');
  }
  rmSync(clean, { recursive: true, force: true });

  for (const name of ORDER) {
    const d = fixture();
    DEFECTS[name](d);
    const r = lint(aim(d), name)[name];
    const red = r.fail.length > 0;
    if (!red) bad++;
    console.log(`  ${red ? 'ok  ' : 'FAIL'} ${name} goes RED on its planted defect`);
    if (!red && r.skip) console.log(`       (it SKIPPED: ${r.skip})`);
    rmSync(d, { recursive: true, force: true });
  }

  console.log(`\n  ${bad === 0 ? 'selftest PASS' : `selftest FAIL, ${bad} problem(s)`}\n`);
  return bad;
}

// ---------- main ----------
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : (argv[i + 1] || true); };

if (argv.includes('--list')) {
  console.log('\n  checks:\n' + ORDER.map((c) => '    ' + c).join('\n'));
  for (const [b, c] of Object.entries(BRANDS)) {
    const ctx = context(b);
    console.log(`\n  --brand ${b}  (${c.label})`);
    console.log(`    repo   ${c.repo}${existsSync(c.repo) ? '' : '   MISSING'}`);
    console.log(`    pack   ${ctx.packMirror}${existsSync(ctx.packMirror) ? '' : '   MISSING'}`);
    console.log(`    rules  ${c.rules}${existsSync(c.rules) ? '' : '   MISSING'}`);
    console.log(`    built  ${ctx.dist ? `${ctx.dist.path} (${ctx.dist.files} files)` : 'NONE FOUND'}`);
    console.log(`    desk   ${c.scl || 'none'}`);
  }
  console.log('');
  process.exit(0);
}

if (argv.includes('--selftest')) process.exit(selftest() === 0 ? 0 : 2);

const brand = flag('--brand');
if (!brand || brand === true) {
  console.error('usage: gate-lint.mjs --brand <bex|dh> [--only CHECK] | --selftest | --list');
  process.exit(2);
}
const only = flag('--only');
if (only && only !== true && !ORDER.includes(only)) {
  console.error(`unknown check "${only}". Known: ${ORDER.join(', ')}`);
  process.exit(2);
}

// The lint proves itself before it reports on anything. Same law as messaging-gate.mjs:
// a detector that has not shown it can still catch a known violation does not get to say clean.
if (!process.env.GATE_LINT_SKIP_SELFTEST) {
  const savedVault = VAULT, savedBex = BRANDS.bex.repo, savedDh = { ...BRANDS.dh };
  const problems = selftest();
  VAULT = savedVault; BRANDS.bex.repo = savedBex; Object.assign(BRANDS.dh, savedDh);
  if (problems) { console.log('  The lint failed its own probes. Not reporting a result.\n'); process.exit(2); }
}

const ctx = context(brand);
process.exit(report(ctx, lint(ctx, only && only !== true ? only : null)) === 0 ? 0 : 1);
