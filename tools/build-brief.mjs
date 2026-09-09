#!/usr/bin/env node
// build-brief.mjs — `bbe brief <brand>`. Phase A step 2 of the every-pixel-wired plan
// (dh-hub vault/artifacts/2026-09-09/PLAN-every-pixel-wired-2026-09-09.md §6b).
//
// Andrew's spec, verbatim: "whenever AI starts to get into something, it should have
// like a protocol, like, boom, boom, boom, boom. It goes and activates... okay, I'm up
// to speed, I'm ready to start designing. I know exactly where everything is... no
// wasted time or going back."
//
// This reads ONE brand pack plus a fixed set of vault/project paths and writes ONE
// markdown file: the brand as it is RIGHT NOW. Every section is built from a file that
// actually exists. Where a source is missing, the section prints ABSENT with the exact
// path or pack key it checked — never invented, never silently skipped, never a crash.
// A pack on an old schema (bex-co, 1.0) degrades honestly: most of §3/§4 read ABSENT,
// and a banner at the top says the pack has not migrated to schema 1.1.
//
// Usage:
//   bbe brief <brand> [--vault <path>] [--out <dir>] [--stdout] [--json]
//
//   <brand>       a brand-pack slug: <vault>/core/brand-packs/<slug>.brandpack.json
//   --vault       defaults to $VAULT or ~/dh-work/dh-hub/vault
//   --out         defaults to <vault>/artifacts/<YYYY-MM-DD>/
//   --stdout      print the markdown to stdout; do NOT write a file
//   --json        emit the same data as JSON to stdout; do NOT write a file
//                 (--json wins over --stdout when both are given; JSON always prints)
//
// Default (no --stdout, no --json): writes <out>/BRIEF-<brand>-<YYYY-MM-DD>.md and
// prints a short confirmation line.
//
// Exit codes: 0 built (even with ABSENT sections — that is the honest product, not a
// failure) · 2 the brand pack itself could not be found or parsed · 3 bad arguments.
//
// House rules this file follows (paid for elsewhere in this repo):
//   - never `git add -A` / never guess a path: every read is wrapped, every miss is a
//     labelled ABSENT line, nothing is invented to fill a gap.
//   - pure Node ESM, zero dependencies, matching validate-pack.mjs / build-tokens.mjs.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------- small utilities

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
function hasFlag(flag) { return process.argv.includes(flag); }

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function todayISODate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function readFileSafe(absPath) {
  try {
    if (!fs.existsSync(absPath)) return { ok: false, error: 'does not exist', path: absPath };
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { ok: false, error: 'not a file', path: absPath };
    return { ok: true, text: fs.readFileSync(absPath, 'utf8'), path: absPath };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), path: absPath };
  }
}

function readJsonSafe(absPath) {
  const r = readFileSafe(absPath);
  if (!r.ok) return r;
  try {
    return { ok: true, data: JSON.parse(r.text), path: absPath };
  } catch (e) {
    return { ok: false, error: `parse error: ${String(e && e.message || e)}`, path: absPath, parseFailure: true };
  }
}

function sha256File(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

function sha256String(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// Dotted-path getter that also records exactly which segment went missing, so an
// ABSENT line can name the precise key a builder would have looked for.
function get(obj, dotPath) {
  const parts = dotPath.split('.');
  let cur = obj;
  let walked = [];
  for (const p of parts) {
    walked.push(p);
    if (cur == null || typeof cur !== 'object' || !(p in cur)) {
      return { found: false, checkedPath: dotPath, missingAt: walked.join('.') };
    }
    cur = cur[p];
  }
  if (cur === undefined) return { found: false, checkedPath: dotPath, missingAt: dotPath };
  return { found: true, value: cur };
}

function absentLine(label, checkedPath) {
  return `ABSENT — ${label} (checked \`${checkedPath}\`)`;
}

// Pack-declared paths (e.g. outputs.web.messaging.rules) are written REPO-root-
// relative, i.e. they carry a leading "vault/" segment — see the plan's own
// "Verified facts", which give paths as "vault/brands/design-hacker/...". This
// tool's own `vault` variable already points AT that vault/ directory, so joining
// a declared path onto it verbatim double-nests to ".../vault/vault/...". Strip
// one leading "vault/" (or "vault\\" on Windows-style separators, belt and
// braces) before resolving on disk.
function stripLeadingVaultSegment(p) {
  return p.replace(/^vault[\\/]/, '');
}

function runGit(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, error: (r.stderr || '').trim() || `git exited ${r.status}` };
  return { ok: true, out: (r.stdout || '').trim() };
}

// Recursively collect every {path, value} pair whose OWN key is "law", ends with
// "Law", or is exactly "rule" (not "rules" / "rulesSha256" — those are file
// pointers, not law text, and are covered in the Messaging section instead).
function collectLawStrings(obj, prefix) {
  const hits = [];
  function walk(o, p) {
    if (o == null || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      o.forEach((v, i) => walk(v, `${p}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(o)) {
      const here = `${p}.${k}`;
      const isLaw = /law$/i.test(k) || k === 'rule';
      if (isLaw && typeof v === 'string') hits.push({ path: here, value: v });
      else if (typeof v === 'object') walk(v, here);
    }
  }
  walk(obj, prefix);
  return hits;
}

function mdTable(headers, rows) {
  const out = [];
  out.push(`| ${headers.join(' | ')} |`);
  out.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const r of rows) out.push(`| ${r.map((c) => String(c ?? '').replace(/\|/g, '\\|')).join(' | ')} |`);
  return out.join('\n');
}

function truncate(s, n) {
  if (typeof s !== 'string') s = JSON.stringify(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------------------------------------------------------------- brand resolution

// Known mappings, named explicitly rather than guessed. A slug not in this table
// falls back to the two conventional locations, in order: brands/<slug>/, then
// clients/<slug>/. If neither exists on disk, every section that depends on the
// brand vault dir (rulings, CURRENT.md, messaging-by-convention) reports ABSENT.
const BRAND_VAULT_DIRS = {
  'design-hacker': 'brands/design-hacker',
  'bex-co': 'clients/bex'
};

function resolveBrandDir(vault, slug) {
  const known = BRAND_VAULT_DIRS[slug];
  if (known && fs.existsSync(path.join(vault, known))) {
    return { dir: known, how: `named mapping (BRAND_VAULT_DIRS["${slug}"])` };
  }
  const candidates = [`brands/${slug}`, `clients/${slug}`];
  for (const c of candidates) {
    if (fs.existsSync(path.join(vault, c))) return { dir: c, how: `fallback search (${c})` };
  }
  return { dir: null, how: null, checked: [known, ...candidates].filter(Boolean) };
}

// ---------------------------------------------------------------- pack resolution

function listAvailablePacks(vault) {
  const dir = path.join(vault, 'core', 'brand-packs');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.brandpack.json'))
      .map((f) => f.replace(/\.brandpack\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

function resolvePack(vault, slug) {
  const packPath = path.join(vault, 'core', 'brand-packs', `${slug}.brandpack.json`);
  const r = readJsonSafe(packPath);
  return { packPath, ...r };
}

// ---------------------------------------------------------------- schema check

// schema "1.1" or higher carries outputs.web.type/button/radius/motion/dark/fontLoad/
// kit/origins/locked/conflicts. Below that, only the pre-2.1.0 leaves exist
// (palette, fonts, identity, site, tracking) and the brief must say so up front
// rather than let eleven ABSENT lines speak for themselves.
function schemaEnforces11(schema) {
  return String(schema ?? '1.0').localeCompare('1.1', undefined, { numeric: true }) >= 0;
}

// ==================================================================
// SECTION BUILDERS
// Each returns { md: string[], data: object, absences: string[] }.
// ==================================================================

// ---- 1. Version line ----------------------------------------------------
function buildVersionLine(ctx) {
  const { brand, pack, packSha12, generatedAt } = ctx;
  const web = ctx.web;
  const packVersion = pack?.meta?.packVersion ?? 'UNKNOWN';
  const schema = pack?.meta?.schema ?? 'UNKNOWN';
  const kit = get(web, 'kit');
  const absences = [];
  let kitPart;
  if (kit.found) {
    kitPart = `kit ${kit.value.url || 'ABSENT url'} v${kit.value.version || 'ABSENT version'}`;
  } else {
    absences.push(absentLine('kit URL + version', 'outputs.web.kit'));
    kitPart = 'kit ABSENT (outputs.web.kit not present — pack not on schema 1.1)';
  }
  const line = `**${brand}** · pack v${packVersion} (schema ${schema}, sha256 \`${packSha12}\`) · ${kitPart} · brief generated ${generatedAt}`;
  return {
    md: [line],
    data: { brand, packVersion, schema, packSha12, kit: kit.found ? kit.value : null, generatedAt },
    absences
  };
}

// ---- 2. Identity ----------------------------------------------------
function buildIdentity(ctx) {
  const web = ctx.web;
  const md = [];
  const absences = [];
  const data = {};

  const identity = get(web, 'identity');
  if (!identity.found) {
    md.push(absentLine('outputs.web.identity', 'outputs.web.identity'));
    absences.push('identity block entirely');
    return { md, data, absences };
  }
  const idv = identity.value;
  md.push(`**${idv.name || ctx.brand}**${idv.tagline ? ` — ${idv.tagline}` : ''}`);
  if (idv.email) md.push(`- Email: ${idv.email}`);
  if (idv.phone) md.push(`- Phone: ${idv.phone}`);
  if (idv.locationLine) md.push(`- Location: ${idv.locationLine}`);

  const marks = get(idv, 'marks');
  if (!marks.found) {
    // identity.marks lives under the already-resolved identity object, so the
    // fully-qualified pack path for the ABSENT line is spelled out by hand.
    md.push('');
    md.push(absentLine('marks (logo/lockup CDN paths)', 'outputs.web.identity.marks'));
    absences.push('identity.marks (no lockups declared — pre-2.1.0 pack)');
  } else {
    const m = marks.value;
    md.push('');
    md.push('**Marks**');
    if (m.defaults) {
      md.push(`- Nav default: \`${m.defaults.nav}\`${m.defaults.navHeight ? ` (${m.defaults.navHeight})` : ''}`);
      md.push(`- Footer default: \`${m.defaults.footer}\`${m.defaults.footerHeight ? ` (${m.defaults.footerHeight})` : ''}`);
    } else {
      md.push(absentLine('marks.defaults (nav/footer picks)', 'outputs.web.identity.marks.defaults'));
      absences.push('identity.marks.defaults');
    }
    md.push(`- Favicon: ${m.favicon || absentLine('favicon', 'outputs.web.identity.marks.favicon')}`);
    md.push(`- Base CDN path: \`${m.base || 'ABSENT'}\``);
    const lockupCount = m.lockups ? Object.keys(m.lockups).length : 0;
    md.push(`- Lockups on the CDN: ${lockupCount}${m.verified ? ` (${m.verified})` : ''}`);
    if (m.formats) md.push(`- Formats: ${Object.entries(m.formats).map(([k, v]) => `**${k}** ${v}`).join('; ')}`);
    if (m.fills) md.push(`- Fills: ${Object.entries(m.fills).map(([k, v]) => `${k} \`${v}\``).join(', ')}`);
    data.marks = m;
  }

  // Fonts: the spec source is outputs.web.fontLoad (the ONE font request, per
  // ruling 51's law on this pack). Fall back to reporting the legacy
  // outputs.web.fonts block honestly, labelled as legacy, never substituted in
  // as if it were the same thing.
  const fontLoad = get(web, 'fontLoad');
  md.push('');
  md.push('**Fonts**');
  if (fontLoad.found) {
    const f = fontLoad.value;
    md.push(`- Loading URL: \`${f.url}\``);
    if (Array.isArray(f.families)) {
      md.push(mdTable(['family', 'weights', 'role'], f.families.map((x) => [x.name, (x.weights || []).join('/'), x.role || ''])));
    }
    data.fontLoad = f;
  } else {
    md.push(absentLine('fontLoad (the one font request)', 'outputs.web.fontLoad'));
    absences.push('fontLoad');
    const legacyFonts = get(web, 'fonts');
    if (legacyFonts.found && legacyFonts.value && (legacyFonts.value.sans || legacyFonts.value.serif)) {
      const lf = legacyFonts.value;
      md.push(`- Legacy \`outputs.web.fonts\` block found (not the same contract as fontLoad, no loading URL declared): ` +
        `sans=${lf.sans?.family || '?'}, serif=${lf.serif?.family || '?'}.`);
      data.legacyFonts = { sans: lf.sans?.family, serif: lf.serif?.family };
    } else {
      md.push('- No legacy `outputs.web.fonts` block either.');
    }
  }
  return { md, data, absences };
}

// ---- 3. The system (type, button, radius, motion, dark) ----------------------------------------------------
function buildSystem(ctx) {
  const web = ctx.web;
  const md = [];
  const absences = [];
  const data = {};

  // type
  const type = get(web, 'type');
  if (type.found) {
    const t = type.value;
    md.push('**Type**');
    if (t.families) {
      const rows = Object.entries(t.families).map(([role, f]) => [role, f.value, f.note || '']);
      md.push(mdTable(['role', 'value', 'note'], rows));
    }
    if (t.weights) md.push(`- Weights: ${Object.entries(t.weights).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    if (t.scale) {
      md.push('');
      md.push(mdTable(['scale', 'value', 'role'], Object.entries(t.scale).map(([k, v]) => [k, v.value, v.role || ''])));
    }
    if (t.tracking) md.push(`- Tracking: ${Object.entries(t.tracking).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    data.type = t;
  } else {
    md.push(absentLine('type (families/weights/scale/tracking)', 'outputs.web.type'));
    absences.push('type');
  }

  // button
  const button = get(web, 'button');
  md.push('');
  if (button.found) {
    const b = button.value;
    md.push('**Button**');
    if (b.geometry) {
      md.push(`- Radius ${b.geometry.radius}, padding ${b.geometry.padding}, font ${b.geometry.font}`);
    }
    if (b.variants) md.push(`- Variants: ${Object.keys(b.variants).join(', ')}`);
    if (b.states) md.push(`- States: ${Object.keys(b.states).join(', ')}`);
    data.button = { geometry: b.geometry, variants: b.variants ? Object.keys(b.variants) : [], states: b.states ? Object.keys(b.states) : [] };
  } else {
    md.push(absentLine('button spec', 'outputs.web.button'));
    absences.push('button');
  }

  // radius
  const radius = get(web, 'radius');
  md.push('');
  if (radius.found) {
    const r = radius.value;
    md.push('**Radius**');
    if (r.scale) md.push(`- Scale: ${Object.entries(r.scale).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
    if (r.buttonDefault) md.push(`- Button default: ${r.buttonDefault}`);
    data.radius = r.scale;
  } else {
    md.push(absentLine('radius scale', 'outputs.web.radius'));
    absences.push('radius');
  }

  // motion
  const motion = get(web, 'motion');
  md.push('');
  if (motion.found) {
    const m = motion.value;
    md.push('**Motion**');
    if (m.easing) md.push(`- Easings: ${Object.entries(m.easing).map(([k, v]) => `${k} \`${v.value}\` (${v.role})`).join(' · ')}`);
    if (m.revealLaw) md.push(`- Reveal law: ${m.revealLaw}`);
    if (m.noScrollFade) md.push(`- ${m.noScrollFade}`);
    data.motion = { easing: m.easing, revealLaw: m.revealLaw };
  } else {
    md.push(absentLine('motion easings', 'outputs.web.motion'));
    absences.push('motion');
  }

  // dark
  const dark = get(web, 'dark');
  md.push('');
  if (dark.found) {
    const d = dark.value;
    md.push('**Dark ladder**');
    md.push(`- Mechanism: ${d.mechanism}${d.mechanismDetail ? ` — ${truncate(d.mechanismDetail, 220)}` : ''}`);
    if (d.ladder) md.push(mdTable(['step', 'value', 'role'], Object.entries(d.ladder).map(([k, v]) => [k, v.value, v.role || ''])));
    if (d.accent) md.push(`- Accent (both themes): ${d.accent}`);
    data.dark = { mechanism: d.mechanism, ladder: d.ladder, accent: d.accent };
  } else {
    md.push(absentLine('dark ladder', 'outputs.web.dark'));
    absences.push('dark');
  }

  return { md, data, absences };
}

// ---- 4. The law ----------------------------------------------------
function buildLaw(ctx) {
  const web = ctx.web;
  const pack = ctx.pack;
  const md = [];
  const absences = [];
  const data = {};

  const laws = collectLawStrings(web, 'outputs.web');
  md.push('**Law and rule strings, verbatim, found in `outputs.web.*`**');
  if (laws.length) {
    for (const l of laws) md.push(`- \`${l.path}\`: ${l.value}`);
    data.laws = laws;
  } else {
    md.push(absentLine('any law/rule string', 'outputs.web.* (recursive scan for keys "law", "*Law", "rule")'));
    absences.push('law strings');
  }

  md.push('');
  // NOTE: capabilities is a FLAT dict whose keys are themselves dotted strings
  // ("voice.bannedPatterns"), not a nested object — get()'s dotted-path walk
  // would misread it as capabilities.voice.bannedPatterns and always miss. Bracket
  // access on the literal key is correct here.
  const bannedCap = (pack?.capabilities || {})['voice.bannedPatterns'];
  md.push('**Banned patterns** (`capabilities["voice.bannedPatterns"].value`)');
  if (bannedCap && Array.isArray(bannedCap.value)) {
    for (const p of bannedCap.value) md.push(`- ${p}`);
    data.bannedPatterns = bannedCap.value;
  } else {
    md.push(absentLine('voice.bannedPatterns.value', 'capabilities["voice.bannedPatterns"].value'));
    absences.push('bannedPatterns');
  }

  md.push('');
  md.push('**Conflicts — UNRULED, loud on purpose.** Nobody has ruled these; the kit\'s live value is what ships today, not a decision.');
  const conflicts = get(web, 'conflicts');
  if (conflicts.found) {
    for (const [name, c] of Object.entries(conflicts.value)) {
      if (name === '_why') continue;
      md.push('');
      // `resolved` says which value SHIPS today. `state` says whether anyone CHOSE it.
      // They were indistinguishable until pack 2.2.1, so a working default read as a ruling.
      // A pack with no `state` predates the field: badge it UNKNOWN rather than guessing RULED.
      const state = c.state || (c.ruledBy ? 'RULED' : 'UNKNOWN');
      const badge = state === 'RULED'
        ? `**RULED** by ${c.ruledBy || 'unknown'}${c.ruledAt ? ` on ${c.ruledAt}` : ''}`
        : state === 'OPEN'
          ? '**OPEN — nobody has ruled this**'
          : '_state not declared (pack predates the field)_';
      md.push(`- **${name}** — ${badge} · ships today: \`${c.resolved || 'unresolved'}\``);
      for (const [k, v] of Object.entries(c)) {
        if (k === 'resolved') continue;
        md.push(`  - ${k}: ${truncate(v, 300)}`);
      }
    }
    data.conflicts = conflicts.value;
  } else {
    md.push(absentLine('conflicts', 'outputs.web.conflicts'));
    absences.push('conflicts');
  }

  return { md, data, absences };
}

// ---- 5. Messaging ----------------------------------------------------
function buildMessaging(ctx) {
  const web = ctx.web;
  const vault = ctx.vault;
  const brandDir = ctx.brandDirInfo.dir;
  const md = [];
  const absences = [];
  const data = {};

  let rulesRelPath = null;
  let how = null;
  const declared = get(web, 'messaging.rules');
  if (declared.found) {
    rulesRelPath = stripLeadingVaultSegment(declared.value);
    how = 'declared in outputs.web.messaging.rules';
  } else if (brandDir) {
    const guess = path.join(brandDir, 'messaging-rules.json');
    if (fs.existsSync(path.join(vault, guess))) {
      rulesRelPath = guess;
      how = `not declared in the pack (outputs.web.messaging absent) — found by convention at ${guess}`;
    }
  }

  if (!rulesRelPath) {
    md.push(absentLine('messaging rules file', 'outputs.web.messaging.rules, and no <brandDir>/messaging-rules.json found by convention'));
    absences.push('messaging.rules');
  } else {
    const absRules = path.join(vault, rulesRelPath);
    const measuredSha = sha256File(absRules);
    md.push(`**Rules file:** \`vault/${rulesRelPath}\` (${how})`);
    if (measuredSha) {
      md.push(`- sha256 (measured now): \`${measuredSha}\``);
      const declaredSha = get(web, 'messaging.rulesSha256');
      if (declaredSha.found) {
        const match = declaredSha.value === measuredSha;
        md.push(`- sha256 declared in pack: \`${declaredSha.value}\` — ${match ? 'MATCHES' : '**MISMATCH — the pack sha is stale, re-measure the pack**'}`);
      }
      data.rulesSha256 = measuredSha;
    } else {
      md.push(absentLine('rules file bytes (could not hash)', absRules));
      absences.push('messaging.rules file unreadable');
    }
    data.rulesPath = rulesRelPath;
  }

  md.push('');
  const gate = get(web, 'messaging.gate');
  if (gate.found) {
    md.push(`**Gate command:** \`${gate.value}\``);
    data.gate = gate.value;
  } else if (rulesRelPath) {
    const guessGate = `node vault/core/gates/messaging-gate.mjs --rules vault/${rulesRelPath} '<glob>'`;
    md.push(`- Gate command not declared in the pack; the standard shape (per house convention) would be: \`${guessGate}\``);
    absences.push('messaging.gate (not declared; showing the standard shape, not asserting it exists)');
  } else {
    md.push(absentLine('gate command', 'outputs.web.messaging.gate'));
  }

  // Legacy python gate: brand-neutral check, not hardcoded to any one brand.
  if (brandDir) {
    const legacyGate = path.join(brandDir, 'check-messaging.py');
    if (fs.existsSync(path.join(vault, legacyGate))) {
      md.push(`- **Legacy gate also present:** \`${legacyGate}\` (hardcoded python gate, older than the JSON rules file — run both until this brand retires it)`);
      data.legacyGate = legacyGate;
    }
  }

  return { md, data, absences };
}

// ---- 6. Rulings, last 30 days ----------------------------------------------------
function findRulingFiles(vault, brandDir) {
  const absDir = path.join(vault, brandDir);
  let entries;
  try {
    entries = fs.readdirSync(absDir, { recursive: true });
  } catch {
    return [];
  }
  return entries
    .filter((rel) => /ruling/i.test(path.basename(rel)))
    .map((rel) => path.join(brandDir, rel).split(path.sep).join('/'))
    .filter((rel) => {
      try { return fs.statSync(path.join(vault, rel)).isFile(); } catch { return false; }
    });
}

function buildRulings(ctx) {
  const vault = ctx.vault;
  const brandDir = ctx.brandDirInfo.dir;
  const md = [];
  const absences = [];
  const data = { entries: [] };

  if (!brandDir) {
    md.push(absentLine('brand vault directory (cannot scan for rulings)', ctx.brandDirInfo.checked?.join(', ') || 'brands/<slug>, clients/<slug>'));
    absences.push('rulings — no brand dir');
    return { md, data, absences };
  }

  const files = findRulingFiles(vault, brandDir);
  if (!files.length) {
    md.push(absentLine(`*ruling*/*RULING* files under ${brandDir}`, `${brandDir}/**`));
    absences.push('rulings — none found');
    return { md, data, absences };
  }

  const now = Date.now();
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const dated = [];
  for (const rel of files) {
    const g = runGit(['log', '-1', '--format=%cI', '--', rel], vault);
    if (!g.ok || !g.out) {
      dated.push({ rel, date: null, note: 'no commit history found (untracked, or outside this git repo)' });
      continue;
    }
    const t = Date.parse(g.out);
    dated.push({ rel, date: g.out, ageMs: now - t });
  }
  const within30 = dated.filter((d) => d.date && d.ageMs <= THIRTY_DAYS).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const noHistory = dated.filter((d) => !d.date);
  const older = dated.filter((d) => d.date && d.ageMs > THIRTY_DAYS);

  md.push(`Scanned ${files.length} ruling file(s) under \`${brandDir}/\`. ${within30.length} committed in the last 30 days. **Read these before you build.**`);
  md.push('');
  if (within30.length) {
    md.push(mdTable(['date', 'path'], within30.map((d) => [d.date.slice(0, 10), `\`${d.rel}\``])));
  } else {
    md.push('_None within 30 days._');
  }
  if (older.length) {
    md.push('');
    md.push(`<details><summary>${older.length} older ruling file(s), not shown above</summary>\n\n` +
      older.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).map((d) => `- ${d.date.slice(0, 10)} — \`${d.rel}\``).join('\n') +
      '\n\n</details>');
  }
  if (noHistory.length) {
    md.push('');
    md.push(`_${noHistory.length} file(s) with no git history found: ${noHistory.map((d) => `\`${d.rel}\` (${d.note})`).join('; ')}_`);
    absences.push(`${noHistory.length} ruling file(s) with no git log`);
  }
  data.entries = dated;
  return { md, data, absences };
}

// ---- 7. Current state ----------------------------------------------------
function buildCurrentState(ctx) {
  const vault = ctx.vault;
  const brandDir = ctx.brandDirInfo.dir;
  const md = [];
  const absences = [];
  const data = {};

  if (!brandDir) {
    md.push(absentLine('brand vault directory (cannot look for CURRENT.md)', 'brands/<slug>, clients/<slug>'));
    absences.push('CURRENT.md — no brand dir');
    return { md, data, absences };
  }
  const rel = `${brandDir}/CURRENT.md`;
  const r = readFileSafe(path.join(vault, rel));
  if (!r.ok) {
    md.push(absentLine(`CURRENT.md at the brand level`, rel));
    md.push(`_(this brand tracks state elsewhere — check the card's Open Threads for this brand instead)_`);
    absences.push('CURRENT.md');
    return { md, data, absences };
  }
  const lines = r.text.split('\n').slice(0, 40);
  md.push(`**\`${rel}\`** — first ${lines.length} lines:`);
  md.push('');
  md.push('```markdown');
  md.push(...lines);
  md.push('```');
  data.path = rel;
  data.firstLines = lines;
  return { md, data, absences };
}

// ---- 8. What is live ----------------------------------------------------
function buildWhatIsLive(ctx) {
  const web = ctx.web;
  const vault = ctx.vault;
  const brand = ctx.brand;
  const md = [];
  const absences = [];
  const data = {};

  const origins = get(web, 'origins');
  if (origins.found) {
    const surfaces = origins.value.surfaces || [];
    md.push(`**\`outputs.web.origins\`**, measured ${origins.value.measuredAt || 'unknown date'}:`);
    md.push('');
    md.push(mdTable(['surface', 'url', 'status', 'repo'], surfaces.map((s) => [s.name, s.url || '(none)', s.status || '', s.repo || ''])));
    data.origins = surfaces;
    return { md, data, absences };
  }

  md.push(absentLine('outputs.web.origins', 'outputs.web.origins'));
  absences.push('origins');
  md.push('');
  md.push('Falling back to `vault/core/engine/estate.json` (repo paths + pack only — it carries NO url field):');
  const estatePath = path.join(vault, 'core', 'engine', 'estate.json');
  const estate = readJsonSafe(estatePath);
  if (!estate.ok) {
    md.push(absentLine('estate.json', 'core/engine/estate.json'));
    absences.push('estate.json');
    return { md, data, absences };
  }
  const rows = (estate.data || []).filter((r) => r.pack === brand);
  if (!rows.length) {
    md.push(`_No estate.json rows carry \`"pack": "${brand}"\`._`);
    absences.push('estate.json rows for this brand');
  } else {
    md.push(mdTable(['surface', 'repo', 'github'], rows.map((r) => [r.surface, r.repo, r.github || ''])));
    data.estateRows = rows;
  }
  return { md, data, absences };
}

// ---- 9. Media ----------------------------------------------------
function buildMedia(ctx) {
  const vault = ctx.vault;
  const brand = ctx.brand;
  const md = [];
  const absences = [];
  const data = {};

  const rel = `core/media/${brand}.manifest.json`;
  const r = readJsonSafe(path.join(vault, rel));
  if (!r.ok) {
    md.push(absentLine('media manifest', rel));
    absences.push('media manifest');
    return { md, data, absences };
  }
  const sets = r.data.sets || {};
  md.push(`**\`${rel}\`** — generated ${r.data.generatedAt || 'unknown'}, CDN project \`${r.data.cdnProject || '?'}\`:`);
  md.push('');
  md.push(mdTable(['set', 'kind', 'count', 'status', 'note'],
    Object.entries(sets).map(([name, s]) => [name, s.kind, s.count, s.status + (s.supersededBy ? ` → ${s.supersededBy}` : ''), s.note ? truncate(s.note, 80) : ''])));
  data.sets = sets;
  return { md, data, absences };
}

// ---- 10. Locked sections ----------------------------------------------------
// NOT in the vault repo — the project card folder, an absolute path outside any
// git worktree this tool otherwise touches. Not brand-scoped: the Site Control
// Layer today holds recipes for the DH site only, so the same table renders for
// every brand brief until other brands get their own recipes.
const SITE_CONTROL_RECIPES_DIR = '/Users/andrewlane/Documents/Claude/Projects/Design Hacker/Site-Control-Layer/page-recipes';

function sectionsFromRecipe(doc) {
  // Handles both shapes seen in the estate: a list of {id, locked:{...}} objects,
  // and a dict keyed by section id whose value carries `locked`.
  const out = [];
  const secs = doc && doc.sections;
  if (Array.isArray(secs)) {
    for (const s of secs) out.push({ id: s.id, locked: s.locked });
  } else if (secs && typeof secs === 'object') {
    for (const [id, v] of Object.entries(secs)) out.push({ id, locked: v && v.locked });
  }
  return out;
}

function buildLockedSections() {
  const md = [];
  const absences = [];
  const data = { files: 0, sections: 0, locked: [] };

  let files;
  try {
    files = fs.readdirSync(SITE_CONTROL_RECIPES_DIR).filter((f) => f.endsWith('.json'));
  } catch (e) {
    md.push(absentLine('Site-Control-Layer/page-recipes directory', SITE_CONTROL_RECIPES_DIR));
    absences.push('page-recipes dir');
    return { md, data, absences };
  }

  let totalSections = 0;
  const locked = [];
  const parseFailures = [];
  for (const f of files.sort()) {
    const abs = path.join(SITE_CONTROL_RECIPES_DIR, f);
    const r = readJsonSafe(abs);
    if (!r.ok) { parseFailures.push({ file: f, error: r.error }); continue; }
    const secs = sectionsFromRecipe(r.data);
    totalSections += secs.length;
    for (const s of secs) {
      if (s.locked && s.locked.design === true) locked.push({ file: f, id: s.id });
    }
  }

  md.push(`**${files.length} recipe file(s)**, \`${SITE_CONTROL_RECIPES_DIR}\`: ${totalSections} section(s) total, **${locked.length} of ${totalSections} locked**.`);
  if (locked.length) {
    md.push('');
    md.push(mdTable(['file', 'section id'], locked.map((l) => [l.file, l.id])));
  } else {
    md.push('_No section carries `locked.design === true` today — every section is open to design changes._');
  }
  if (parseFailures.length) {
    md.push('');
    md.push(`_${parseFailures.length} recipe file(s) failed to parse and were skipped: ${parseFailures.map((p) => `${p.file} (${p.error})`).join('; ')}_`);
    absences.push('some recipe files failed to parse');
  }
  data.files = files.length;
  data.sections = totalSections;
  data.locked = locked;
  return { md, data, absences };
}

// ---- 11. The meta tag ----------------------------------------------------
function buildMetaTag(ctx) {
  const packVersion = ctx.pack?.meta?.packVersion ?? 'UNKNOWN';
  const tag = `<meta name="bbe-brief" content="${ctx.brand}@${packVersion}">`;
  return {
    md: ['A page built from this brief must carry this tag, ready to copy:', '', '```html', tag, '```'],
    data: { tag },
    absences: []
  };
}

// ==================================================================
// ASSEMBLY
// ==================================================================

const SECTIONS = [
  { n: 2, title: 'Identity', fn: buildIdentity },
  { n: 3, title: 'The system', fn: buildSystem },
  { n: 4, title: 'The law', fn: buildLaw },
  { n: 5, title: 'Messaging', fn: buildMessaging },
  { n: 6, title: 'Rulings, last 30 days', fn: buildRulings },
  { n: 7, title: 'Current state', fn: buildCurrentState },
  { n: 8, title: 'What is live', fn: buildWhatIsLive },
  { n: 9, title: 'Media', fn: buildMedia },
  { n: 10, title: 'Locked sections', fn: (ctx) => buildLockedSections() },
  { n: 11, title: 'The meta tag', fn: buildMetaTag }
];

function assembleBrief(ctx) {
  const versionSection = buildVersionLine(ctx);
  const md = [];
  const jsonOut = { brand: ctx.brand, generatedAt: ctx.generatedAt };
  const allAbsences = [...versionSection.absences];

  // Line 1, deliberately: it must survive truncation on its own.
  md.push(versionSection.md[0]);
  md.push('');
  jsonOut.version = versionSection.data;

  if (!schemaEnforces11(ctx.pack?.meta?.schema)) {
    md.push(`> **⚠ NOT MIGRATED TO SCHEMA 1.1.** This pack is schema ${ctx.pack?.meta?.schema ?? '1.0'}. It carries only the pre-2.1.0 leaves ` +
      `(palette, fonts, identity, site, tracking). Most of the system layer below (type, button, radius, motion, dark, the kit URL, ` +
      `origins, locked sections, conflicts) is UNKNOWN, not zero — nobody has extracted it into the pack yet. Treat every ABSENT below ` +
      `as "not yet measured," never as "does not exist."`);
    md.push('');
    jsonOut.schemaWarning = `pack is schema ${ctx.pack?.meta?.schema ?? '1.0'}, not migrated to 1.1`;
  }

  md.push(`# Brief: ${ctx.brand}`);
  md.push('');
  md.push(`Brand vault dir: \`${ctx.brandDirInfo.dir || 'NOT FOUND'}\`${ctx.brandDirInfo.dir ? ` (${ctx.brandDirInfo.how})` : ''}`);
  md.push('');

  for (const s of SECTIONS) {
    md.push(`## ${s.n}. ${s.title}`);
    md.push('');
    const built = s.fn(ctx);
    md.push(...built.md);
    md.push('');
    jsonOut[s.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')] = built.data;
    allAbsences.push(...built.absences.map((a) => `§${s.n} ${s.title}: ${a}`));
  }

  md.push('---');
  md.push(`_${allAbsences.length} ABSENT item(s) this run: ${allAbsences.length ? allAbsences.join(' · ') : 'none'}_`);
  jsonOut.absences = allAbsences;

  return { markdown: md.join('\n') + '\n', json: jsonOut, absences: allAbsences };
}

// ==================================================================
// CLI
// ==================================================================

function usage() {
  console.log('Usage: bbe brief <brand> [--vault <path>] [--out <dir>] [--stdout] [--json]');
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { usage(); process.exit(argv.length ? 0 : 3); }

  // First token not starting with "--" and not itself a flag's value is the brand.
  // Flags here are all either boolean (--stdout, --json) or take exactly one value
  // (--vault, --out), so a simple scan is enough.
  let brand = null;
  const valueFlags = new Set(['--vault', '--out']);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (valueFlags.has(t)) { i++; continue; }
    if (t.startsWith('--')) continue;
    brand = t;
    break;
  }
  if (!brand) { console.error('FAIL: no <brand> slug given.'); usage(); process.exit(3); }

  const vault = path.resolve(expandHome(argOf('--vault') || process.env.VAULT || '~/dh-work/dh-hub/vault'));
  if (!fs.existsSync(vault)) {
    console.error(`FAIL: vault not found at ${vault}`);
    process.exit(2);
  }

  const { packPath, ok, data: pack, error, parseFailure } = resolvePack(vault, brand);
  if (!ok) {
    if (parseFailure) {
      console.error(`FAIL: brand pack exists but does not parse as JSON: ${packPath}`);
      console.error(`      ${error}`);
    } else {
      console.error(`FAIL: no brand pack at ${packPath}`);
      const avail = listAvailablePacks(vault);
      console.error(`      vault carries: ${avail.length ? avail.join(', ') : '(none found)'}`);
    }
    process.exit(2);
  }

  const packSha = sha256File(packPath);
  const brandDirInfo = resolveBrandDir(vault, brand);
  const ctx = {
    brand,
    vault,
    pack,
    packPath,
    packSha,
    packSha12: (packSha || '').slice(0, 12),
    web: (pack && pack.outputs && pack.outputs.web) || {},
    brandDirInfo,
    generatedAt: new Date().toISOString()
  };

  const brief = assembleBrief(ctx);

  const wantJson = hasFlag('--json');
  const wantStdout = hasFlag('--stdout');

  if (wantJson) {
    console.log(JSON.stringify(brief.json, null, 2));
    process.exit(0);
  }
  if (wantStdout) {
    process.stdout.write(brief.markdown);
    process.exit(0);
  }

  const outDir = path.resolve(expandHome(argOf('--out') || path.join(vault, 'artifacts', todayISODate())));
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `BRIEF-${brand}-${todayISODate()}.md`);
  fs.writeFileSync(outFile, brief.markdown, 'utf8');
  console.log(`Wrote ${outFile}`);
  console.log(brief.markdown.split('\n')[0]);
  console.log(`${brief.absences.length} ABSENT item(s).`);
  process.exit(0);
}

main();
