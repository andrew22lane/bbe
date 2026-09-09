#!/usr/bin/env node
// bbe kit — THE EMITTER. Pack in, brand stylesheet out.
//
// THE LAW (same split as tools/build-tokens.mjs, ruling 63):
//   the PACK holds the VALUES   — every colour, family, weight, size, tracking,
//                                 radius, easing, duration, shadow, geometry.
//                                 A ruling is a pack edit.
//   the EMITTER holds the SHAPE — selectors, module order, structure, comments,
//                                 indentation, line grouping. That shape is the
//                                 shared BBE component vocabulary, not brand data.
//
// So this file is BRAND-BLIND. It contains no brand name, no hex, no font name,
// no slug. It reads roles ("pageGround", "accentPrimary") and asks the pack what
// they resolve to. Point it at another pack and it emits that brand's kit.
//
// THE KIT IS OUTPUT. Hand-editing a published kit breaks the wire: the next
// emit silently reverts it and the surface that inherited the hand edit drifts.
//
// Usage:
//   bbe kit <slug|path-to-pack> [--out <dir>] [--vault <path>]
//                               [--verify <css>] [--computed] [--selftest]
//                               [--scheme light|dark|system]
//
//   <slug>        resolved to <vault>/core/brand-packs/<slug>.brandpack.json
//   --vault       vault root. Default $BBE_VAULT, else ./vault, else a walk up
//                 from cwd looking for core/brand-packs.
//   --out         output directory. Default ./dist/kit
//   --verify      normalized-diff the emitted stylesheet against a reference CSS
//                 (level 1). Exit 1 on any difference.
//   --computed    also run the level-2 computed-style comparison in headless
//                 Chrome. Implies --verify. Needs puppeteer.
//   --selftest    plant a defect in the pack in memory, emit, and assert the
//                 verifier goes RED. A verifier that has only ever returned
//                 green has not been tested.
//   --gaps        print every value the emitter wanted from the pack and did not
//                 find, with the exact key to add. Always printed on --verify.
//   --scheme      override outputs.web.dark.defaultScheme (ruling 66) for this
//                 run: light, dark or system. Exists so the two halves of the
//                 proof can each be run on demand — `--scheme light` reproduces
//                 the live kit, `--scheme system` adds the two dark blocks to
//                 that exact file and nothing else.
//
// Emits into --out:
//   <slug>-kit.css        the whole stylesheet
//   fonts.html            the <head> snippet that loads the brand's fonts
//   tokens.generated.css  just the :root{} custom-property block

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------- args

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : null;
}
const has = (flag) => process.argv.includes(flag);

// On the CLI a refusal should stop the run. Inside the selftest a refusal IS the
// result being measured, so it has to be catchable — otherwise the only way to
// test that the emitter refuses a bad pack is to watch it kill the process.
let FAIL_THROWS = false;
class PackRefused extends Error {}
function fail(msg) {
  if (FAIL_THROWS) throw new PackRefused(msg);
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function catchingFailures(fn) {
  const prev = FAIL_THROWS;
  FAIL_THROWS = true;
  try { return { ok: true, value: fn() }; }
  catch (e) { if (e instanceof PackRefused) return { ok: false, why: e.message }; throw e; }
  finally { FAIL_THROWS = prev; }
}

// ---------------------------------------------------------------- pack resolution

function findVault(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'core', 'brand-packs'))) return dir;
    if (fs.existsSync(path.join(dir, 'vault', 'core', 'brand-packs'))) return path.join(dir, 'vault');
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function resolvePack(target, vaultFlag) {
  if (!target) return null;
  if (target.endsWith('.json')) {
    const p = path.resolve(target);
    return fs.existsSync(p) ? p : null;
  }
  const vault = vaultFlag
    ? path.resolve(vaultFlag)
    : process.env.BBE_VAULT
      ? path.resolve(process.env.BBE_VAULT)
      : findVault(process.cwd());
  if (!vault) return null;
  const p = path.join(vault, 'core', 'brand-packs', `${target}.brandpack.json`);
  return fs.existsSync(p) ? p : null;
}

// ---------------------------------------------------------------- the model
//
// Every read of the pack goes through `need` or `opt`, so the gap report at the
// bottom is generated, not maintained by hand.

function dig(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function makeModel(pack) {
  const web = pack?.outputs?.web;
  if (!web) fail('pack has no outputs.web');
  const caps = pack.capabilities || {};
  const gaps = [];

  // a value the emitter cannot invent. Absent = stop.
  const need = (dotted, what) => {
    const v = dig(web, dotted);
    if (v === undefined || v === null) fail(`pack is missing outputs.web.${dotted} (${what})`);
    return v;
  };
  const needCap = (cap, dotted, what) => {
    const root = caps[cap]?.value;
    const v = dotted ? dig(root, dotted) : root;
    if (v === undefined || v === null) fail(`pack is missing capabilities["${cap}"].value${dotted ? '.' + dotted : ''} (${what})`);
    return v;
  };
  // a value the emitter has a structural default for. Absent = fall back, record it.
  const opt = (dotted, fallback, what) => {
    const v = dig(web, dotted);
    if (v === undefined || v === null) {
      gaps.push({ key: `outputs.web.${dotted}`, want: what, using: String(fallback) });
      return fallback;
    }
    return v;
  };

  // ---- colour: roles, never names -------------------------------------------
  const palette = needCap('color.palette', null, 'the token palette');
  const roles = needCap('color.semanticRoles', null, 'role -> cssVar mapping');
  const ladder = need('dark.ladder', 'the dark surface ladder');
  const onInk = need('dark.onInkText', 'on-ink text alphas');
  const modes = needCap('surface.modes', null, 'light/ink surface modes');
  const inkClass = modes.ink?.className || opt('dark.className', 'on-ink', 'the ink surface class name');

  // role -> "var(--x)". The emitter never writes a colour literal.
  const R = (role) => {
    const v = roles[role];
    if (!v) fail(`pack capabilities["color.semanticRoles"].value has no "${role}"`);
    return `var(${v})`;
  };
  const L = (rung) => {
    const v = ladder[rung]?.cssVar;
    if (!v) fail(`pack outputs.web.dark.ladder has no "${rung}"`);
    return `var(${v})`;
  };
  const OI = (k) => {
    const v = onInk[k]?.cssVar;
    if (!v) fail(`pack outputs.web.dark.onInkText has no "${k}"`);
    return `var(${v})`;
  };

  // ---- type ------------------------------------------------------------------
  const fams = need('type.families', 'the type families');
  const weights = need('type.weights', 'the weight ladder');
  const scale = need('type.scale', 'the type scale');
  const track = need('type.tracking', 'the tracking table');
  const lh = need('type.lineHeight', 'the line-height table');
  const wrap = need('type.wrapRules', 'the wrap rules');
  const F = (k) => {
    const v = fams[k]?.cssVar;
    if (!v) fail(`pack outputs.web.type.families has no "${k}"`);
    return `var(${v})`;
  };
  const S = (k) => {
    const e = scale[k];
    if (!e) fail(`pack outputs.web.type.scale has no "${k}"`);
    return e.cssVar ? `var(${e.cssVar})` : e.value;
  };
  const W = (k) => {
    const v = weights[k];
    if (v === undefined) fail(`pack outputs.web.type.weights has no "${k}"`);
    return String(v);
  };

  // ---- the rest --------------------------------------------------------------
  const radius = need('radius', 'the radius scale');
  const RAD = (k) => {
    const v = radius.cssVars?.[k];
    return v ? `var(${v})` : radius.scale?.[k];
  };
  const motion = need('motion', 'the motion table');
  const E = (k) => {
    const v = motion.easing?.[k]?.cssVar;
    if (!v) fail(`pack outputs.web.motion.easing has no "${k}"`);
    return `var(${v})`;
  };
  const D = (k) => {
    const v = motion.durations?.[k];
    if (v === undefined) fail(`pack outputs.web.motion.durations has no "${k}"`);
    return v;
  };
  const shadow = need('shadow', 'the elevation table');
  const button = need('button', 'the button spec');
  const container = need('components.container', 'the container rule');
  const order = need('components.order', 'the component module order');
  const space = caps['space.scale']?.value || {};
  const SP = (k, fallback, what) => {
    if (space[k] === undefined || space[k] === null) {
      gaps.push({ key: `capabilities["space.scale"].value.${k}`, want: what, using: String(fallback) });
      return fallback;
    }
    return space[k];
  };

  // the raw hex behind a role, so a module can build an alpha of it without ever
  // writing a colour of its own
  const HEX = (role) => {
    const cssVar = roles[role];
    const key = Object.keys(palette).find((k) => palette[k].cssVar === cssVar);
    if (!key) fail(`pack has no palette entry for the ${role} role (${cssVar})`);
    return palette[key].value;
  };

  return {
    pack, web, caps, gaps, palette, roles, ladder, onInk, inkClass,
    // Ruling 68 names three jobs where the accent is TYPE: an eyebrow, the <b>
    // word in a headline, an accent stroke on ink. A module registers the
    // selector as it emits it, so the split pass never has to pattern-match a
    // class name and the list cannot drift from the CSS.
    accentType: [],
    R, L, OI, F, S, W, RAD, E, D, SP, HEX,
    fams, weights, scale, track, lh, wrap, radius, motion, shadow, button,
    container, order, space,
    kit: need('kit', 'the kit header and version'),
    fontLoad: need('fontLoad', 'the font-loading declaration'),
    identity: web.identity || {},
    opt, need
  };
}

// ---------------------------------------------------------------- :root tokens
//
// LINE GROUPING is emitter shape. The pack may override the palette grouping with
// outputs.web.kit.paletteLines (an array of arrays of palette keys); with no such
// hint the emitter chunks the palette in pack order.

const PALETTE_CHUNK = 4;

function rgbOf(hex) {
  const h = String(hex).trim().replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
// ".14" not "0.14" — the alpha literal the packs and the kits both write.
const alphaLit = (a) => String(a).replace(/^0\./, '.');
const rgbaOf = (hex, a) => {
  const rgb = rgbOf(hex);
  return rgb ? `rgba(${rgb.join(',')},${alphaLit(a)})` : null;
};

// The on-light meta text colour. Some packs state it; this one does not. Rather
// than invent a number, derive it as the body-text colour at the meta alpha the
// pack ALREADY states for its on-ink twin — and prove the rule first against the
// three members of the same family the pack does carry. If the proof fails the
// emitter stops instead of guessing.
function resolveMetaLight(m) {
  const explicit = m.web.light?.onLightText?.meta?.value ?? m.web.onLightText?.meta?.value ?? null;
  if (explicit) return { value: explicit, derived: false };

  const bodyHex = m.palette[Object.keys(m.palette).find((k) => `--${k}` === m.roles.bodyText || m.palette[k].cssVar === m.roles.bodyText)]?.value;
  const groundHex = m.palette[Object.keys(m.palette).find((k) => m.palette[k].cssVar === m.roles.pageGround)]?.value;
  const statedHair = m.shadow.hairline?.light?.value;
  const statedHairL = m.shadow.hairline?.ink?.value;
  const statedBodyL = m.onInk.body?.value;
  const statedMetaL = m.onInk.meta?.value;
  if (!bodyHex || !groundHex || !statedHair || !statedHairL || !statedBodyL || !statedMetaL) {
    fail('cannot resolve the on-light meta colour: pack states neither a value nor the alpha family it belongs to');
  }
  // the alpha of each stated member, read back off its own literal
  const alphaOf = (lit) => (String(lit).match(/,\s*(\.?\d*\.?\d+)\)\s*$/) || [])[1];
  const aHair = alphaOf(statedHair);
  const aMeta = alphaOf(statedMetaL);
  const proofs = [
    ['hairlineLight', statedHair, rgbaOf(bodyHex, aHair)],
    ['hairlineInk', statedHairL, rgbaOf(groundHex, alphaOf(statedHairL))],
    ['onInk body', statedBodyL, rgbaOf(groundHex, alphaOf(statedBodyL))],
    ['onInk meta', statedMetaL, rgbaOf(groundHex, aMeta)]
  ];
  const broken = proofs.filter(([, stated, derived]) => stated !== derived);
  if (broken.length) {
    fail(
      'cannot derive the on-light meta colour: this pack does not build its translucent text roles as ' +
        'base-colour-at-alpha, so the derivation is not safe here. Add the value to the pack. Mismatches: ' +
        broken.map(([n, s, d]) => `${n} stated ${s} but the rule gives ${d}`).join('; ')
    );
  }
  return { value: rgbaOf(bodyHex, aMeta), derived: true, rule: `bodyText at the stated meta alpha ${aMeta}` };
}

// A :root source LINE, as structure: the declarations that share the line, plus
// the comment that trails it. Built once and rendered three ways — the light
// block, and (for a non-light scheme) the two dark bodies, which reuse this same
// grouping so a dark block reads in the same order as the block it overrides.
function tokenLines(m) {
  const lines = [];
  const line = (decls, comment) => lines.push({ decls, comment: comment || null });

  // --- palette ---------------------------------------------------------------
  const keys = Object.keys(m.palette);
  let groups = m.kit.paletteLines;
  if (!Array.isArray(groups)) {
    m.gaps.push({
      key: 'outputs.web.kit.paletteLines',
      want: 'which palette tokens share a source line, as an array of arrays of palette keys',
      using: `chunks of ${PALETTE_CHUNK} in pack order`
    });
    groups = [];
    for (let i = 0; i < keys.length; i += PALETTE_CHUNK) groups.push(keys.slice(i, i + PALETTE_CHUNK));
  }
  for (const g of groups) line(g.map((k) => [m.palette[k].cssVar, m.palette[k].value]));

  // --- type scale: fluid sizes, then fixed, then the container ---------------
  const scaled = Object.entries(m.scale).filter(([, e]) => e.cssVar);
  const fluid = scaled.filter(([, e]) => /clamp\(/.test(e.value));
  const fixed = scaled.filter(([, e]) => !/clamp\(/.test(e.value));
  if (fluid.length) line(fluid.map(([, e]) => [e.cssVar, e.value]));
  line([...fixed.map(([, e]) => [e.cssVar, e.value]), [m.container.cssVar, m.container.value]]);

  // --- families: one per line, each carrying the pack's own note -------------
  for (const [, f] of Object.entries(m.fams)) line([[f.cssVar, f.value]], f.note);

  // --- the translucent text family ------------------------------------------
  const meta = resolveMetaLight(m);
  if (meta.derived) {
    m.gaps.push({
      key: 'outputs.web.onLightText.meta (read from outputs.web.light.onLightText or outputs.web.onLightText)',
      want: `the value for the metaText role ${m.roles.metaText}; the pack names the role but states no value`,
      using: `${meta.value}, derived from ${meta.rule} after proving the rule on the pack's other three members`
    });
  }
  line([
    [m.shadow.hairline.light.cssVar, m.shadow.hairline.light.value],
    [m.shadow.hairline.ink.cssVar, m.shadow.hairline.ink.value]
  ]);
  line([
    [m.onInk.body.cssVar, m.onInk.body.value],
    [m.roles.metaText, meta.value],
    [m.onInk.meta.cssVar, m.onInk.meta.value]
  ]);

  // --- easing, radius, elevation --------------------------------------------
  line(Object.values(m.motion.easing).map((e) => [e.cssVar, e.value]));
  line(Object.entries(m.radius.cssVars).map(([k, v]) => [v, m.radius.scale[k]]));
  line([[m.shadow.md.cssVar, m.shadow.md.value]]);
  line([[m.shadow.glow.cssVar, m.shadow.glow.value]]);

  return lines;
}

function renderLines(lines, indent = '') {
  return lines
    .map((l) => indent + l.decls.map(([v, val]) => `${v}:${val}`).join(';') + ';' + (l.comment ? `   /* ${l.comment} */` : ''))
    .join('\n');
}

// ---------------------------------------------------------------- the scheme
//
// RULING 66 (Andrew, 2026-09-09): "yes set to 'system' for dark/light. but good
// to have option for all sites to be 1 of three by default: light/dark/system".
// So the colour scheme is a brand-blind pack value with exactly three settings,
// read from outputs.web.dark.defaultScheme and overridable with --scheme.
//
//   light   the :root light block alone. No @media, no [data-theme] block.
//           This is what the emitter shipped before ruling 66 and it must stay
//           byte-for-byte that, which is what the SCHEME DELTA proof shows.
//   dark    the dark values IN :root, with [data-theme="light"] restoring light.
//   system  three blocks: :root light, then the @media block, then the explicit
//           [data-theme="dark"] block so a reader's own choice wins either way.
//
// THE SHAPE OF THOSE BLOCKS IS COPIED FROM tools/build-tokens.mjs, which already
// emits exactly this for embody-society (see its `mediaBlock` and
// `explicitDarkBlock`), down to the two comment lines. Reusing a structure that
// already ships beats inventing a second one that has to be argued about.

export const SCHEMES = ['light', 'dark', 'system'];
const DEFAULT_SCHEME = 'light';

export function resolveScheme(m, override) {
  const stated = m.web.dark?.defaultScheme;
  // An illegal value in the pack is a broken pack, whether or not this run
  // overrides it. Refusing only when it is USED would let it sit there until the
  // day someone drops the flag.
  if (stated !== undefined && stated !== null && !SCHEMES.includes(stated)) {
    fail(`outputs.web.dark.defaultScheme is "${stated}"; ruling 66 allows exactly ${SCHEMES.join(', ')}`);
  }
  // A brand can RULE a scheme its kit cannot safely carry yet. outputs.web.dark.emitBlocked
  // says the emission is unsafe, never that the ruling is in doubt: DH ruled "system" on
  // 2026-09-09 and the same day the proof showed --paper is a foreground on 15 declarations,
  // so flipping it inverts them. Blocking in CODE, not in a doc, because a doc does not stop a
  // build. --scheme light still works, so the safe half is never blocked.
  const blocked = m.web.dark?.emitBlocked === true;
  const wanted = override || stated;
  if (blocked && wanted && wanted !== 'light') {
    fail(
      `outputs.web.dark.emitBlocked is true, so this brand cannot emit "${wanted}" yet.\n` +
      `       ${m.web.dark?.emitBlockedWhy || '(no reason stated in the pack)'}\n` +
      `       BLOCKER: ${m.web.dark?.emitBlocker?.what || 'see outputs.web.dark.emitBlocker'}\n` +
      `       Emit --scheme light until it is ruled, or clear emitBlocked once it is fixed.`
    );
  }

  if (override) {
    if (!SCHEMES.includes(override)) fail(`--scheme must be one of ${SCHEMES.join(', ')} — got "${override}"`);
    return { scheme: override, source: `--scheme (pack says ${stated || 'nothing'})` };
  }
  if (stated === undefined || stated === null) {
    m.gaps.push({
      key: 'outputs.web.dark.defaultScheme',
      want: `which of ${SCHEMES.join('/')} this brand ships by default (ruling 66)`,
      using: DEFAULT_SCHEME
    });
    return { scheme: DEFAULT_SCHEME, source: 'the emitter default, pack states none' };
  }
  return { scheme: stated, source: 'outputs.web.dark.defaultScheme' };
}

// outputs.web.dark.remap, as cssVar -> { light, dark, from, role }. Keys that do
// not name a custom property (_why, unchanged) are not remap entries.
export function schemeRemap(m) {
  const remap = m.web.dark?.remap;
  if (!remap || typeof remap !== 'object') {
    fail('a non-light scheme needs outputs.web.dark.remap — which light token takes which value when the scheme goes dark');
  }
  const map = new Map();
  for (const [k, v] of Object.entries(remap)) {
    if (!k.startsWith('--') || !v || typeof v !== 'object') continue;
    if (v.light === undefined || v.dark === undefined) {
      fail(`outputs.web.dark.remap["${k}"] states no light/dark pair`);
    }
    map.set(k, { light: String(v.light), dark: String(v.dark), from: v.from || null, role: v.role || null });
  }
  if (!map.size) fail('outputs.web.dark.remap names no tokens to remap');
  return map;
}

// THE REMAP INVENTS NO COLOURS — and that is checkable, not a promise. Every
// entry names the token it takes its dark value FROM, so the emitter proves the
// dark value equals what the light :root already ships for that token, and the
// light value equals what the light :root already ships for the token itself.
// A wrong number in the remap stops the run instead of shipping a colour nobody
// ruled on. This is also what the selftest's planted remap defect trips.
export function proveRemap(m, lines, remap) {
  const shipped = new Map();
  for (const l of lines) for (const [v, val] of l.decls) shipped.set(v, val);
  const rows = [];
  for (const [cssVar, e] of remap) {
    const ownLight = shipped.get(cssVar);
    const srcLight = e.from ? shipped.get(e.from) : undefined;
    const lightOk = ownLight !== undefined && ownLight === e.light;
    const darkOk = e.from ? srcLight !== undefined && srcLight === e.dark : null;
    rows.push({
      token: cssVar,
      light: e.light,
      dark: e.dark,
      from: e.from || '(none stated)',
      lightOk,
      darkOk,
      note: !lightOk
        ? `the light :root ships ${ownLight === undefined ? 'no such token' : ownLight}`
        : darkOk === false
          ? `${e.from} ships ${srcLight === undefined ? 'nothing' : srcLight}, not ${e.dark}`
          : darkOk === null
            ? 'no "from" stated, so the dark value is unproven'
            : 'ok'
    });
  }
  for (const r of rows) {
    if (r.darkOk === null) {
      m.gaps.push({
        key: `outputs.web.dark.remap["${r.token}"].from`,
        want: 'which light token this dark value came from, so the emitter can prove it invents no colour',
        using: `${r.dark}, taken on trust`
      });
    }
  }
  const bad = rows.filter((r) => !r.lightOk || r.darkOk === false);
  return { rows, ok: bad.length === 0, bad };
}

// The dark body: the light line grouping, filtered to the remapped tokens, with
// each one carrying its other value. Comments are dropped — a note explaining a
// light value does not describe its dark twin.
function remapLines(lines, remap, side) {
  const out = [];
  for (const l of lines) {
    const decls = l.decls.filter(([v]) => remap.has(v)).map(([v]) => [v, remap.get(v)[side]]);
    if (decls.length) out.push({ decls, comment: null });
  }
  return out;
}

// Same wording as build-tokens.mjs, deliberately.
const MEDIA_NOTE = '/* system preference, unless the reader has explicitly chosen light */';
const EXPLICIT_NOTE = '/* explicit choice always wins, in both directions */';

function emitTokens(m, lines, scheme, remap) {
  const body = scheme === 'dark' ? remapOnto(lines, remap, 'dark') : lines;
  return `:root{\n${renderLines(body)}\n}`;
}

// scheme "dark": the dark values go IN :root, in place, so the light grouping,
// the comments and every untouched token survive exactly as they are.
function remapOnto(lines, remap, side) {
  return lines.map((l) => ({
    comment: l.comment,
    decls: l.decls.map(([v, val]) => (remap.has(v) ? [v, remap.get(v)[side]] : [v, val]))
  }));
}

// The blocks that follow :root. Empty for "light" — that is the whole point of
// the split proof: nothing is added, so nothing can have changed.
//
// RULING 69 rides in here rather than in :root. The foreground token and every
// declaration that takes it are emitted INSIDE these blocks, scoped to the same
// root selector as the token block they accompany. Two consequences, both
// deliberate: the light emission is untouched, so half 1 of the proof does not
// move; and a scoped override always outranks the component rule it corrects, so
// order in the file never matters.
const SCOPE_DARK_IMPLICIT = ':root:not([data-theme="light"])';
const SCOPE_DARK_EXPLICIT = ':root[data-theme="dark"]';

function onDarkLine(plan, indent) {
  return `${indent}${plan.token}:${plan.value};   /* ruling 69: the foreground on any dark surface. It does NOT flip. */`;
}

// THE OVERRIDES ARE SCOPED WITH :where(), AND THEY SHIP LAST. Both halves of that
// are load-bearing and the browser taught me the first one:
//
//   A plain `:root[data-theme="dark"] .btn .circ` adds (0,2,0) of specificity, so
//   it stops LOSING to `.btn.paper .circ`, which is the whole reason the paper
//   button's plum disc exists. Level 2 caught it immediately — the paper disc
//   measured white. `:where(...)` contributes ZERO specificity, so every override
//   keeps exactly the rank its own rule had and the cascade is untouched.
//
//   With no specificity to win on, ORDER is the only lever left, so the overrides
//   are emitted after every component rule, in the source order of the rules they
//   override. Same rank, later in the file: the override wins over its own rule
//   and over nothing else.
const scopeWhere = (scope) => `:where(${scope})`;

function overrideRules(plan, scope, indent) {
  const grouped = new Map();
  for (const o of [...plan.overrides].sort((a, b) => a.srcIndex - b.srcIndex)) {
    if (!grouped.has(o.selector)) grouped.set(o.selector, []);
    grouped.get(o.selector).push(o);
  }
  const out = [];
  for (const [selector, list] of grouped) {
    const sel = selList(selector).map((s) => `${scopeWhere(scope)} ${s}`).join(',');
    out.push(`${indent}${sel}{${list.map((o) => `${o.prop}:${o.to}`).join(';')}}`);
  }
  return out;
}

const SPLIT_NOTE = "/* RULING 69 — the split. --on-dark carries the foreground job; an arrow's colour follows its DISC, never the page. */";
const SPLIT_NOTE_2 = '/* :where() so every override keeps the specificity its own rule had, and last so it wins on order alone */';

// The token blocks, which sit at the top with :root.
function emitSchemeBlocks(lines, scheme, remap, plan) {
  if (scheme === 'light') return [];
  const tokenTail = (indent) => (plan ? [onDarkLine(plan, indent)] : []);
  if (scheme === 'dark') {
    const out = ['', EXPLICIT_NOTE, ':root[data-theme="light"]{', renderLines(remapLines(lines, remap, 'light'), '  '), '}'];
    if (plan) out.push(`${SCOPE_DARK_IMPLICIT}{`, ...tokenTail('  '), '}');
    return out;
  }
  return [
    '',
    MEDIA_NOTE,
    '@media (prefers-color-scheme: dark){',
    `  ${SCOPE_DARK_IMPLICIT}{`,
    renderLines(remapLines(lines, remap, 'dark'), '    '),
    ...tokenTail('    '),
    '  }',
    '}',
    EXPLICIT_NOTE,
    `${SCOPE_DARK_EXPLICIT}{`,
    renderLines(remapLines(lines, remap, 'dark'), '  '),
    ...tokenTail('  '),
    '}'
  ];
}

// The component overrides, which ship at the very end of the file.
function emitSplitBlocks(scheme, plan) {
  if (scheme === 'light' || !plan || !plan.overrides.length) return [];
  const out = ['', SPLIT_NOTE, SPLIT_NOTE_2];
  if (scheme === 'dark') {
    out.push(...overrideRules(plan, SCOPE_DARK_IMPLICIT, ''));
    return out;
  }
  out.push(
    '@media (prefers-color-scheme: dark){',
    ...overrideRules(plan, SCOPE_DARK_IMPLICIT, '  '),
    '}',
    ...overrideRules(plan, SCOPE_DARK_EXPLICIT, '')
  );
  return out;
}

// ---------------------------------------------------------------- THE SPLIT (ruling 69)
//
// RULING 69 (Andrew, 2026-09-09): the page-ground token does TWO jobs. It is the
// page ground AND the foreground on every dark surface. Flipping it for dark
// inverts every foreground declaration at once, which is exactly what the dark
// Level 2 caught before this shipped: 34 of 86 pairs failing AA, all one cause.
//
// The jobs are split by JOB, read off the emitted CSS itself rather than off a
// hand-kept list of selectors that would go stale the first time a module moves:
//
//   FOREGROUND  a `color`, a `stroke`, or a component's own foreground custom
//               property whose value is EXACTLY the page-ground token. In a dark
//               scheme these take outputs.web.dark.split.foreground.token, which
//               does not flip.
//   GROUND      a background or a border painted with the same token. It keeps
//               the token and flips with it. The page ground, the paper button's
//               own surface and the ring around an overlapping face are all
//               grounds, and all of them are meant to go dark.
//
// AND THEN THE DISC/ARROW LAW, which is the part that is not obvious:
//
//   AN ARROW'S COLOUR FOLLOWS ITS DISC, NEVER THE PAGE.
//
// Andrew caught this by eye on the first fix: every arrow had been sent to the
// foreground token because the PAGE was dark, so the arrow sitting on a disc
// that had KEPT its light value came out white on white. A disc is not a page.
// So a disc painted with the page-ground token keeps the light value too, and
// then each arrow is MEASURED against its own disc in the dark scheme and moved
// only when it does not clear 3:1 there. That reproduces all three ruled pairs
// without the emitter naming any of them:
//
//   plum pill      disc keeps light      arrow stays the accent   6.7:1
//   ghost on ink   disc keeps light      arrow stays the ink      19.7:1
//   paper button   disc is the accent    arrow MOVES              2.2:1 -> 6.7:1
//
// plus a fourth the ruling did not name: the ghost button off ink, whose disc is
// painted with the body-text token and so flips on its own. Its arrow flips with
// it and needs no override at all. The law gets that right by measuring.
//
// Every override is emitted INSIDE the scheme blocks, scoped to the same root
// selector as the token block it accompanies. Nothing lands in the light
// emission, which is why half 1 of the proof does not move.

const CONTRAST_MIN = 3; // a disc/arrow pair is a graphic, so WCAG asks 3, not 4.5

const RGBof = (v) => {
  const s = String(v).trim();
  const mm = s.match(/rgba?\(([^)]+)\)/);
  if (mm) { const p = mm[1].split(',').map(Number); return [p[0], p[1], p[2]]; }
  return rgbOf(s);
};
const LUMof = (rgb) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
export function contrastOf(a, b) {
  const A = RGBof(a), B = RGBof(b);
  if (!A || !B || A.some(isNaN) || B.some(isNaN)) return null;
  const L1 = LUMof(A), L2 = LUMof(B);
  return Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100;
}

// value -> literal, on either side of the scheme. `extra` carries tokens that
// exist only in the dark blocks, so the foreground token resolves there too.
function makeResolver(lines, remap, extra = {}) {
  const light = new Map(Object.entries(extra));
  for (const l of lines) for (const [v, val] of l.decls) light.set(v, val);
  return (value, side) => {
    let v = String(value).trim();
    for (let i = 0; i < 12; i++) {
      const mm = v.match(/^var\(\s*(--[\w-]+)\s*\)$/);
      if (!mm) break;
      const name = mm[1];
      const flipped = side === 'dark' && remap && remap.has(name) ? remap.get(name).dark : null;
      const next = flipped !== null ? flipped : (light.has(name) ? light.get(name) : null);
      if (next === null) return null;
      v = String(next).trim();
    }
    return v;
  };
}

// Top-level rules only. @media and @keyframes bodies are handed back untouched
// so the caller can assert nothing colour-bearing is hiding inside one.
export function scanRules(css) {
  const rules = [], at = [];
  let i = 0, buf = '';
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      const prelude = buf.replace(/\/\*[\s\S]*?\*\//g, '').trim();
      let depth = 1, j = i + 1;
      while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
      const body = css.slice(i + 1, j - 1);
      if (/^@/.test(prelude)) at.push({ prelude, body });
      else if (prelude) rules.push({ selector: prelude, body, decls: splitDecls(body) });
      buf = ''; i = j; continue;
    }
    buf += ch; i++;
  }
  return { rules, at };
}

function splitDecls(body) {
  const src = body.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let buf = '', depth = 0;
  for (const ch of src) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ';' && depth === 0) { if (buf.trim()) out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out
    .map((d) => { const i = d.indexOf(':'); return i < 0 ? null : { prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() }; })
    .filter((d) => d && d.prop);
}

const FG_PROPS = new Set(['color', 'stroke']);
const selList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

// The plan: which emitted declaration takes which token once the scheme goes
// dark. Pure analysis — it writes nothing. `arrowsFollowThePage` is the defect
// the selftest plants: the mistake Andrew caught, every arrow sent to the
// foreground token because the PAGE is dark, ignoring its own disc.
export function planSplit(m, componentCss, lines, remap, opts = {}) {
  const split = m.web.dark?.split;
  if (!split || !split.foreground || !split.foreground.token) {
    m.gaps.push({
      key: 'outputs.web.dark.split.foreground',
      want: 'ruling 69: the token that carries the foreground-on-a-dark-surface job and does NOT flip',
      using: 'no split — the page-ground token keeps both jobs and inverts every foreground in dark'
    });
    return null;
  }
  const GROUND = m.roles.pageGround;
  const OD = split.foreground.token;
  const ODval = split.foreground.value;
  if (!ODval) fail(`outputs.web.dark.split.foreground names ${OD} but states no value for it`);
  if (remap && remap.has(OD)) {
    fail(`outputs.web.dark.remap flips ${OD}, but ruling 69 says the foreground token does NOT flip`);
  }
  const groundVar = `var(${GROUND})`;
  const odVar = `var(${OD})`;
  const resolve = makeResolver(lines, remap, { [OD]: ODval });
  const { rules, at } = scanRules(componentCss);

  // A colour-bearing use of the ground token inside a media block would never be
  // seen by this pass. Nothing puts one there today; say so out loud if one appears.
  const hiding = at.filter((a) => new RegExp(`(color|stroke)\\s*:\\s*var\\(\\s*${GROUND}\\s*\\)`).test(a.body));
  if (hiding.length) {
    fail(`a foreground use of ${GROUND} is inside ${hiding[0].prelude}; the split pass reads top-level rules only`);
  }

  // ---- the arrows, and the disc each one sits on ---------------------------
  const byFirstSel = new Map();
  for (const r of rules) for (const s of selList(r.selector)) if (!byFirstSel.has(s)) byFirstSel.set(s, r);
  // A DISC is the rule one level up from an arrow that actually PAINTS a ground.
  // An <svg> whose parent rule paints nothing is not on a disc at all — it is a
  // glyph sitting on whatever the page gives it, and the foreground pass owns it.
  const bgOf = (rule) => rule && rule.decls.find((d) => d.prop === 'background' || d.prop === 'background-color');
  const discOf = (arrowSel) => {
    const base = arrowSel.replace(/\s+svg$/, '');
    for (const cand of [base, base.replace(/:hover/g, '')]) {
      const rule = byFirstSel.get(cand);
      if (rule && bgOf(rule)) return { sel: cand, rule };
    }
    return null;
  };
  const arrowRules = rules.filter((r) =>
    selList(r.selector).every((s) => /\ssvg$/.test(s)) && r.decls.some((d) => d.prop === 'stroke'));

  // A disc is a background painted with the ground token underneath an arrow. It
  // is NOT a page, so it keeps the light value.
  const discSels = new Set();
  for (const a of arrowRules) for (const s of selList(a.selector)) { const d = discOf(s); if (d) discSels.add(d.sel); }

  const overrides = [];
  const grounds = [];
  const idxOf = new Map(rules.map((r, i) => [r.selector, i]));
  const push = (rule, prop, to, kind, why) => overrides.push({ selector: rule.selector, prop, from: groundVar, to, kind, why, srcIndex: idxOf.get(rule.selector) ?? 0 });

  // ---- 1. the discs -------------------------------------------------------
  const discMoved = new Set();
  for (const sel of discSels) {
    const r = byFirstSel.get(sel);
    const bg = bgOf(r);
    if (bg.value.trim() === groundVar) {
      push(r, bg.prop, odVar, 'disc', 'a disc is not a page: it keeps its light value so its arrow still reads');
      discMoved.add(sel);
    }
  }
  const discDarkOf = (sel) => {
    const bg = bgOf(byFirstSel.get(sel));
    if (!bg) return null;
    return discMoved.has(sel) ? ODval : resolve(bg.value, 'dark');
  };

  // ---- 2. every other foreground use of the ground token -------------------
  //
  // Runs before the arrows on purpose: an arrow drawn with `currentColor` takes
  // its disc's text colour, and that colour has to have moved already before the
  // law can measure the pair.
  const arrowOwned = new Set();
  for (const a of arrowRules) {
    if (selList(a.selector).some((s) => discOf(s))) arrowOwned.add(`${a.selector}|stroke`);
  }
  for (const r of rules) {
    for (const d of r.decls) {
      if (d.value.trim() !== groundVar) continue;
      const isFg = FG_PROPS.has(d.prop) || d.prop.startsWith('--');
      if (!isFg) continue;
      if (arrowOwned.has(`${r.selector}|${d.prop}`)) continue;
      push(r, d.prop, odVar,
        d.prop.startsWith('--') ? 'foreground var' : 'foreground',
        d.prop.startsWith('--') ? "a component's own foreground custom property" : 'foreground on a dark surface');
    }
  }

  // ---- 3. the arrows, measured against their own disc ----------------------
  const discArrow = [];
  for (const a of arrowRules) {
    for (const s of selList(a.selector)) {
      const stroke = a.decls.find((d) => d.prop === 'stroke');
      const d = discOf(s);
      if (!d) continue;
      arrowOwned.add(`${a.selector}|stroke`);
      const onGradient = /:hover/.test(s);
      const discDark = onGradient ? null : discDarkOf(d.sel);
      // `currentColor` on a glyph is the disc's own text colour, which the
      // foreground pass may already have moved. Resolve it there rather than
      // reporting an unmeasurable pair.
      const inherited = d.rule.decls.find((x) => x.prop === 'color');
      const strokeValue = /^currentColor$/i.test(stroke.value.trim()) && inherited
        ? (overrides.find((o) => o.selector === d.rule.selector && o.prop === 'color') || {}).to || inherited.value
        : stroke.value;
      const asWritten = resolve(strokeValue, 'dark');
      const ratio = discDark && asWritten ? contrastOf(asWritten, discDark) : null;
      let to = null, why;
      if (opts.arrowsFollowThePage) {
        to = stroke.value.trim() === odVar ? null : odVar;
        why = 'PLANTED DEFECT: the arrow follows the page, not its disc';
      } else if (onGradient) {
        // The disc under a hovered arrow is the accent gradient, not a flat
        // colour. No number is guessed here: the arrow takes the foreground
        // token because every stop of that gradient is a dark accent.
        to = stroke.value.trim() === groundVar ? odVar : null;
        why = 'on the accent gradient, not a flat disc — no ratio measured';
      } else if (ratio !== null && ratio < CONTRAST_MIN) {
        const cand = [[ODval, contrastOf(ODval, discDark)], [resolve(groundVar, 'dark'), contrastOf(resolve(groundVar, 'dark'), discDark)]]
          .sort((x, y) => y[1] - x[1])[0];
        to = cand[0] === ODval ? odVar : groundVar;
        why = `${ratio}:1 on its own disc in dark, under ${CONTRAST_MIN}`;
      } else {
        why = ratio === null ? 'disc colour not resolvable' : `${ratio}:1 on its own disc in dark, clears ${CONTRAST_MIN}`;
      }
      // One rule, one override, however many selectors share it. A selector list
      // is one declaration in the file and has to stay one.
      if (to && to !== stroke.value.trim() && !overrides.some((o) => o.selector === a.selector && o.prop === 'stroke')) {
        overrides.push({ selector: a.selector, prop: 'stroke', from: stroke.value.trim(), to, kind: 'arrow', why, srcIndex: idxOf.get(a.selector) ?? 0 });
      }
      const finalArrow = to ? (to === odVar ? ODval : resolve(to, 'dark')) : asWritten;
      discArrow.push({
        name: d.sel,
        discSel: d.sel,
        arrowSel: s,
        discLight: resolve(bgOf(byFirstSel.get(d.sel)).value, 'light'),
        discDark: discDark,
        arrowDark: finalArrow,
        ratio: discDark && finalArrow ? contrastOf(finalArrow, discDark) : null,
        moved: !!to,
        onGradient,
        why
      });
    }
  }

  // ---- 4. THE GROUND JOB — everything left, recorded and NOT moved ---------
  //
  // The page, the paper button's own surface, and the ring around an overlapping
  // face. A border painted with the ground token is a ground too. All of them are
  // meant to go dark, so they keep the token and flip with it.
  const moved = new Set(overrides.map((o) => `${o.selector}|${o.prop}`));
  for (const r of rules) {
    for (const d of r.decls) {
      if (!new RegExp(`var\\(\\s*${GROUND}\\s*\\)`).test(d.value)) continue;
      if (moved.has(`${r.selector}|${d.prop}`)) continue;
      grounds.push({ selector: r.selector, prop: d.prop });
    }
  }

  // ---- 4. ruling 68: accent TYPE on a dark ground --------------------------
  //
  // "I say we go with metal." Measured on ink: the accent is 2.95:1, which fails.
  // This does NOT touch the button, which stays the accent in both themes
  // (ruling 65) — the button carries the accent as a BACKGROUND, and only `color`
  // declarations on the selectors the modules registered as accent TYPE move.
  const accentVar = `var(${m.roles.accentPrimary})`;
  const metaOnInk = m.OI('meta');
  const accentRows = [];
  for (const sel of m.accentType || []) {
    const r = byFirstSel.get(selList(sel)[0]);
    if (!r) fail(`a module registered "${sel}" as accent type and the emitter shipped no such rule`);
    const d = r.decls.find((x) => x.prop === 'color' && x.value.trim() === accentVar);
    if (!d) continue;
    overrides.push({ selector: r.selector, prop: 'color', from: accentVar, to: metaOnInk, kind: 'accent type', why: 'ruling 68: accent TYPE on a dark ground is the on-ink meta, not the accent', srcIndex: idxOf.get(r.selector) ?? 0 });
    accentRows.push({ selector: r.selector, was: resolve(accentVar, 'dark'), now: resolve(metaOnInk, 'dark') });
  }

  return { token: OD, value: ODval, groundVar, odVar, overrides, discArrow, grounds, accentRows, resolve };
}

// ---------------------------------------------------------------- modules
//
// One function per entry in outputs.web.components.order. Each returns
// { css, tail? } — `tail` is responsive CSS that ships at the end of the file.
//
// Inside a module, a literal is only ever STRUCTURE (display, position, the box
// model's plumbing). Anything a brand would want to change goes through
// m.opt('components.<module>.<field>', …), which emits the fallback today and
// prints the exact pack key to add. That is the gap report at the bottom.

const MODULES = {};

MODULES.base = (m) => {
  const o = m.opt;
  const modes = m.caps['surface.modes'].value;
  // ruling 68: the two accent-TYPE jobs in the base module. The button is not
  // here on purpose — it carries the accent as a background and ruling 65 keeps
  // it the accent in both themes.
  m.accentType.push('h1 b,h2 b', '.eyebrow');
  const css = [
    '*{box-sizing:border-box}',
    'html{-webkit-text-size-adjust:100%;overflow-x:hidden}',
    `body{margin:0;font:${m.W('body')} ${m.S('body')}/${m.lh.body} ${m.F('sans')};background:${m.R('pageGround')};color:${m.R('bodyText')};overflow-x:hidden;-webkit-font-smoothing:antialiased}`,
    'img{max-width:100%;display:block}',
    'a{text-decoration:none;color:inherit}',
    `p{margin:0;${m.wrap.paragraphs}}ul{margin:0;padding:0;list-style:none}`,
    `h1,h2,h3{margin:0;font-family:${m.F('display')};font-weight:${m.W('headline')};letter-spacing:${m.track.headline};line-height:${m.lh.headline};${m.wrap.headings}}`,
    `h1 b,h2 b{font-weight:inherit;color:${m.R('accentPrimary')}}`,
    `h1{font-size:${m.S('mega')}}h2{font-size:${m.S('loud')}}h3{font-size:${m.S('title')};letter-spacing:${m.track.h3};line-height:${m.lh.h3}}`,
    `.wrap{${m.container.rule}}`,
    `.mono{font-family:${m.F('sans')};font-weight:${m.W('label')};font-size:${m.S('label')};letter-spacing:${m.track.label};text-transform:uppercase}`,
    `.eyebrow{font-family:${m.F('sans')};font-weight:${m.W('label')};font-size:${m.S('label')};letter-spacing:${m.track.eyebrow};text-transform:uppercase;color:${m.R('accentPrimary')}}`,
    `.${m.inkClass} .eyebrow{color:${m.OI('meta')}}`,
    `.lead{font-size:${m.S('lead')};line-height:${m.lh.lead};color:${m.R('metaText')};max-width:${m.wrap.leadMeasure}}`,
    `.${m.inkClass} .lead{color:${m.OI('body')}}`,
    `.${m.inkClass}{background:var(${modes.ink.ground});color:var(${modes.ink.text})}`
  ];
  return { css: css.join('\n') };
};

MODULES.nav = (m) => {
  const o = m.opt;
  const marks = m.identity.marks?.defaults || {};
  const navBtn = m.button.variants?.nav || {};
  const logoH = marks.navHeight || o('identity.marks.defaults.navHeight', '27px', 'the nav lockup height');
  const linkSize = o('components.nav.linkSize', '15px', 'the nav link font-size');
  return {
    css: [
      `.top{position:absolute;left:0;right:0;top:0;z-index:${o('components.nav.zIndex', 40, 'the nav stacking level')};padding:${m.SP('navPadY', '26px', 'the nav vertical padding')} 0}`,
      `.nav{display:flex;align-items:center;gap:${o('components.nav.gap', '34px', 'the gap between the lockup and the link row')}}`,
      `.nav .logo .lk,.nav .logo img{height:${logoH};width:auto;display:block}`,
      `.nav ul{display:flex;gap:${o('components.nav.linkGap', '28px', 'the gap between nav links')};margin-left:auto}`,
      `.nav ul a{font-size:${linkSize};font-weight:${m.W('navLink')};color:${m.R('bodyText')};transition:color ${m.D('colorHover')}}`,
      `.${m.inkClass} .nav ul a{color:${m.OI('body')}}`,
      `.nav ul a:hover{color:${m.R('accentPrimary')}}.${m.inkClass} .nav ul a:hover{color:${m.R('pageGround')}}`,
      `.nav .btn{padding:${navBtn.padding};font-size:${navBtn.fontSize};flex:none}`,
      `.nav .btn .circ{width:${navBtn.circle};height:${navBtn.circle}}`
    ].join('\n'),
    tail: [
      `@media(max-width:${m.bp(760)}){.nav ul{display:none}.nav{gap:${o('components.nav.gapNarrow', '16px', 'the nav gap once the links are hidden')}}.nav .btn{margin-left:auto}}`,
      `@media(max-width:${m.bp(560)}){.nav .btn{padding:${o('components.nav.btnPaddingNarrow', '10px 10px 10px 16px', 'the nav button padding on a phone')};font-size:${o('components.nav.btnSizeNarrow', '14px', 'the nav button font-size on a phone')}}.nav .btn .circ{width:${o('components.nav.btnCircNarrow', '26px', 'the nav button circle on a phone')};height:${o('components.nav.btnCircNarrow', '26px', 'the nav button circle on a phone')}}.nav .logo .lk,.nav .logo img{height:${o('components.nav.logoNarrow', '22px', 'the nav lockup height on a phone')}}}`
    ].join('\n')
  };
};

MODULES.button = (m) => {
  const o = m.opt;
  const b = m.button;
  const g = b.geometry;
  const rawStates = b.states;
  // `paper` and `ghost` are the shared BBE variant classes, so those keys are
  // vocabulary. The DEFAULT variant has no class, and this pack keys it by a
  // colour name, which no other brand can reuse. Resolve it by role instead.
  const VARIANT_CLASSES = new Set(['paper', 'ghost', 'sm', 'wide', 'b1-legacy']);
  const primaryKey = ['primary', 'default', 'base'].find((k) => rawStates[k]) ||
    Object.keys(rawStates).find((k) => !VARIANT_CLASSES.has(k));
  if (!primaryKey) fail('outputs.web.button.states has no state for the default button variant');
  if (primaryKey !== 'primary') {
    m.gaps.push({
      key: 'outputs.web.button.states.primary',
      want: `the default button variant keyed by its ROLE; this pack keys it "${primaryKey}", a colour name no other brand can reuse`,
      using: `outputs.web.button.states.${primaryKey}`
    });
  }
  const st = { ...rawStates, primary: rawStates[primaryKey] };
  // Pack 2.3.0 split hover.arrow into arrowColor + arrowTravel, which is what this
  // emitter asked for. Prefer the real fields; fall back to parsing the old prose so a
  // brand pack still on the single `arrow` string keeps emitting. If NEITHER shape is
  // present, stop rather than invent half a hover.
  let arrowColor = st.primary.hover.arrowColor;
  let arrowTravel = st.primary.hover.arrowTravel;
  if (!arrowColor || !arrowTravel) {
    const hoverArrow = String(st.primary.hover.arrow || '');
    arrowColor = arrowColor || (hoverArrow.match(/var\(--[\w-]+\)/) || [])[0];
    arrowTravel = arrowTravel || (hoverArrow.match(/translateX\([^)]*\)/) || [])[0];
    if (!arrowColor || !arrowTravel) {
      fail('outputs.web.button.states.<primary>.hover needs arrowColor and arrowTravel (or a legacy .arrow string carrying both)');
    }
    o(`button.states.${primaryKey}.hover.arrowColor`, arrowColor, 'the hover arrow colour as its own field, parsed out of the legacy .arrow prose');
    o(`button.states.${primaryKey}.hover.arrowTravel`, arrowTravel, 'the hover arrow travel as its own field, parsed out of the legacy .arrow prose');
  }

  const circTr = `transform ${m.D('buttonLift')} ${m.E('eo')},box-shadow ${m.D('buttonLift')} ${m.E('eo')}`;
  const arrowTr = `stroke ${o('components.button.arrowStrokeDuration', '.3s', 'how long the arrow stroke colour takes')},transform ${m.D('buttonLift')} ${m.E('eo')}`;
  const sm = b.variants.sm;

  return {
    css: [
      `.btn{position:relative;isolation:isolate;clip-path:${g.clip};display:inline-flex;align-items:center;gap:${g.gap};`,
      `background:${st.primary.rest.background};color:${st.primary.rest.color};border:0;border-radius:${g.radius};padding:${g.padding};`,
      `font:${g.font};letter-spacing:${g.letterSpacing};white-space:nowrap;cursor:pointer;`,
      `transition:${b.transition}}`,
      `.btn::before{content:"";position:absolute;inset:0;z-index:-1;background:${st.primary.hover.sweep};transform:${st.primary.hover.sweepFrom};transition:${b.sweepTransition}}`,
      `.btn:hover::before{transform:${st.primary.hover.sweepTo}}`,
      `.btn .circ{position:relative;width:${g.circle.size};height:${g.circle.size};border-radius:${g.circle.radius};background:${st.primary.rest.circle};display:grid;place-items:center;flex:none;clip-path:${g.circle.clip};isolation:isolate;transition:${circTr}}`,
      `.btn .circ::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:${g.circle.radius};background:${st.paper.hover.circleGradient};opacity:0;transition:opacity ${m.D('buttonLift')} ${m.E('eo')}}`,
      `.btn .circ svg{width:${g.arrow.size};height:${g.arrow.size};stroke:${st.primary.rest.arrow};fill:none;stroke-width:${g.arrow.strokeWidth};stroke-linecap:${g.arrow.linecap};stroke-linejoin:${g.arrow.linejoin};transition:${arrowTr}}`,
      `.btn:hover{transform:${st.primary.hover.lift};box-shadow:${st.primary.hover.shadow}}`,
      `.btn:hover .circ svg{stroke:${arrowColor};transform:${arrowTravel}}`,
      `.btn:active{transform:${b.active}}`,
      `.btn:focus-visible{${b.focus}}`,
      `.btn.paper,.btn.ghost{background:${st.paper.rest.background};color:${st.paper.rest.color}}`,
      `.btn.paper{box-shadow:${st.paper.rest.edge}}`,
      `.${m.inkClass} .btn.paper{${st.paper.rest.onInk}}`,
      '.btn.paper::before,.btn.ghost::before{display:none}',
      `.btn.paper .circ{background:${st.paper.rest.circle}}.btn.paper .circ svg{stroke:${st.paper.rest.arrow}}`,
      `.btn.paper:hover{box-shadow:${st.paper.hover.shadow}}`,
      `.${m.inkClass} .btn.paper:hover{box-shadow:${st.paper.hover.shadowOnInk}}`,
      '.btn.paper:hover .circ::before,.btn.ghost:hover .circ::before{opacity:1}',
      `.btn.paper:hover .circ,.btn.ghost:hover .circ{box-shadow:${st.paper.hover.circleGlow}}`,
      `.btn.paper:hover .circ svg,.btn.ghost:hover .circ svg{stroke:${st.paper.hover.arrow}}`,
      `.btn.ghost{background:${st.ghost.rest.background};box-shadow:${st.ghost.rest.edge}}`,
      `.${m.inkClass} .btn.ghost{color:${st.ghost.rest.onInk.color};box-shadow:${st.ghost.rest.onInk.edge}}`,
      `.btn.ghost .circ{background:${st.ghost.rest.circle}}.btn.ghost .circ svg{stroke:${st.ghost.rest.arrow}}`,
      `.${m.inkClass} .btn.ghost .circ{background:${st.ghost.rest.circleOnInk}}.${m.inkClass} .btn.ghost .circ svg{stroke:${st.ghost.rest.arrowOnInk}}`,
      `.${m.inkClass} .btn.ghost:hover .circ svg{stroke:${st.ghost.hover.arrowOnInk}}`,
      `.btn.ghost:hover{box-shadow:${st.ghost.hover.shadow}}`,
      `.${m.inkClass} .btn.ghost:hover{box-shadow:${st.ghost.hover.shadowOnInk}}`,
      `.btn.wide{width:${b.variants.wide.width};justify-content:${b.variants.wide.justify}}`,
      `.btn.sm{padding:${sm.padding};font-size:${sm.fontSize}}.btn.sm .circ{width:${sm.circle};height:${sm.circle}}`,
      `.acts{display:flex;flex-wrap:wrap;align-items:center;gap:${o('components.button.actsGap', '14px 18px', 'the row and column gap of an action row')}}`,
      `.fine{font-family:${m.F('sans')};font-weight:${m.W('label')};font-size:${m.S('label')};letter-spacing:${m.track.label};text-transform:uppercase;color:${m.R('metaText')}}`,
      `.${m.inkClass} .fine{color:${m.OI('meta')}}`
    ].join('\n')
  };
};

MODULES.card = (m) => {
  const o = m.opt;
  const lift = m.D('cardLift');
  const ico = o('components.card.iconSize', '52px', 'the card icon disc diameter');
  return {
    css: [
      `.card{position:relative;display:flex;flex-direction:column;gap:${o('components.card.gap', '14px', 'the vertical gap between card children')};padding:${m.SP('cardPad', '30px', 'the card padding')};border-radius:${m.RAD('lg')};`,
      `background:${m.L('card')};color:${m.R('pageGround')};box-shadow:inset 0 0 0 1px ${m.R('hairlineInk')};overflow:hidden;`,
      `transition:transform ${lift} ${m.E('eo')},box-shadow ${lift} ${m.E('eo')}}`,
      `.card::before{content:"";position:absolute;inset:0;background:var(${m.shadow.glow.cssVar});opacity:${o('components.card.glowOpacity', '.55', 'the resting opacity of the corner glow')};transition:opacity ${lift};pointer-events:none}`,
      `.card:hover{transform:${o('components.card.hoverLift', 'translateY(-4px)', 'how far a card lifts on hover')};box-shadow:${m.shadow.cardHover}}`,
      '.card:hover::before{opacity:1}',
      `.card .ico{width:${ico};height:${ico};border-radius:50%;display:grid;place-items:center;background:${m.R('accentPrimary')};color:${m.R('pageGround')};box-shadow:${m.shadow.iconRing}}`,
      `.card .ico svg{width:${o('components.card.iconGlyph', '22px', 'the glyph inside the card icon disc')};height:${o('components.card.iconGlyph', '22px', 'the glyph inside the card icon disc')};stroke:currentColor;fill:none;stroke-width:${o('components.card.iconStroke', '1.8', 'the card icon stroke width')};stroke-linecap:round;stroke-linejoin:round}`,
      `.card h3{margin-top:${o('components.card.headingOffset', '6px', 'the space above a card heading')}}`,
      `.card p{color:${m.OI('meta')};font-size:${o('components.card.bodySize', '16px', 'card body size')};line-height:${o('components.card.bodyLine', '1.5', 'card body line-height')}}`,
      `.card .go{margin-top:auto;display:inline-flex;align-items:center;gap:${o('components.card.goGap', '10px', 'the gap between the go label and its arrow')};font-weight:${m.W('go')};font-size:${o('components.card.goSize', '15px', 'the go link size')};color:${m.R('pageGround')}}`,
      `.card .go svg{width:${o('components.card.goGlyph', '16px', 'the go arrow size')};height:${o('components.card.goGlyph', '16px', 'the go arrow size')};stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;transition:transform ${o('components.card.goDuration', '.3s', 'how long the go arrow takes to travel')} ${m.E('eo')}}`,
      `.card:hover .go svg{transform:${o('components.card.goTravel', 'translateX(4px)', 'how far the go arrow travels')}}`,
      `.card.paper{background:${m.R('cardGround')};color:${m.R('bodyText')};box-shadow:inset 0 0 0 1px ${m.R('hairlineLight')}}`,
      `.card.paper p{color:${m.R('metaText')}}.card.paper .go{color:${m.R('bodyText')}}`,
      `.cards{display:grid;grid-template-columns:repeat(${o('components.card.columns', 4, 'how many cards sit in a row')},1fr);gap:${m.SP('cardGap', '20px', 'the gap between cards')}}`,
      `@media(max-width:${m.bp(1100)}){.cards{grid-template-columns:repeat(${o('components.card.columnsMid', 2, 'cards per row on a tablet')},1fr)}}`,
      `@media(max-width:${m.bp(600)}){.cards{grid-template-columns:1fr}}`
    ].join('\n')
  };
};

MODULES.stat = (m) => {
  const o = m.opt;
  return {
    css: [
      `.stat{padding:${m.SP('statPad', '28px 30px', 'the stat tile padding')};border-radius:${m.RAD('lg')};background:${m.L('card')};box-shadow:inset 0 0 0 1px ${m.R('hairlineInk')}}`,
      `.stat b{display:block;font:${m.W('statNumber')} ${o('type.scale.stat.value', 'clamp(2.4rem,4vw,3.6rem)', 'the stat number size; type.scale has no entry for it')}/${m.lh.statNumber} ${m.F('display')};letter-spacing:${m.track.statNumber};color:${m.R('pageGround')}}`,
      `.stat span{display:block;margin-top:${o('components.stat.labelOffset', '8px', 'the space above a stat label')};font-size:${o('components.stat.labelSize', '14px', 'the stat label size')};color:${m.OI('meta')}}`
    ].join('\n')
  };
};

MODULES.faces = (m) => {
  const o = m.opt;
  const asp = m.caps['imagery.aspectRules']?.value || {};
  const face = o('components.faces.size', '44px', 'the diameter of a face in the overlap row');
  const lap = o('components.faces.overlap', '14px', 'how far each face overlaps the one before it');
  const by = o('components.faces.bySize', '48px', 'the diameter of the byline portrait');
  return {
    css: [
      `.faces{display:flex;padding-left:${lap}}`,
      `.faces img{width:${face};height:${face};border-radius:50%;object-fit:cover;margin-left:-${lap};border:${o('components.faces.ring', '2px', 'the ring around a face')} solid ${m.R('pageGround')};background:${m.R('altGround')}}`,
      `.${m.inkClass} .faces img{border-color:${m.L('dk')}}`,
      `.by{display:flex;align-items:center;gap:${o('components.faces.byGap', '14px', 'the gap between the byline portrait and its text')};font-size:${o('components.faces.bySizeText', '15px', 'the byline text size')};line-height:${o('components.faces.byLine', '1.45', 'the byline line-height')};color:${m.R('metaText')}}`,
      `.${m.inkClass} .by{color:${m.OI('meta')}}`,
      `.by img{width:${by};height:${by};border-radius:50%;object-fit:cover;object-position:${o('components.faces.byCrop', '50% 22%', 'where a byline portrait is cropped')};flex:none;border:1px solid ${m.R('accentPrimary')}}`,
      `.by b{font-weight:${o('type.weights.strong', 600, 'the weight of an emphasised name in running text')};color:${m.R('bodyText')}}.${m.inkClass} .by b{color:${m.R('pageGround')}}`
    ].join('\n'),
    tailInto: { 560: `.faces img{width:${o('components.faces.sizeNarrow', '36px', 'the face diameter on a phone')};height:${o('components.faces.sizeNarrow', '36px', 'the face diameter on a phone')}}` }
  };
};

MODULES.roadmap = (m) => {
  const o = m.opt;
  // The two tile fills on an ink ground are the page-ground colour at a low
  // alpha. The ALPHA is an emitter default until the pack carries it; the COLOUR
  // is always the pack's, so this stays brand-blind.
  const tileInk = rgbaOf(m.HEX('pageGround'), o('components.roadmap.tileOnInkAlpha', '.05', 'the alpha of the tile fill on an ink ground'));
  const tileInkHover = rgbaOf(m.HEX('pageGround'), o('components.roadmap.tileOnInkHoverAlpha', '.11', 'the alpha of the tile hover fill on an ink ground'));
  const kf = (m.motion.keyframes || []).reduce((a, k) => ((a[k.name] = k), a), {});
  const K = (name) => {
    if (!kf[name]) fail(`pack outputs.web.motion.keyframes has no "${name}"`);
    return `@keyframes ${name}{${kf[name].body}}`;
  };
  const names = (m.motion.keyframes || []).map((k) => k.name);
  const [outName, inName] = [names[0], names[1]];
  // ruling 68: the widget's greeting eyebrow. The kit already swaps it for the
  // on-ink meta under [data-contrast="dark"]; on a page that is itself dark it
  // needs the same swap, which is what "make it the rule" means.
  m.accentType.push('.rm .greet .eyebrow');
  return {
    css: [
      `.rm{position:relative;font-family:${m.F('sans')};--rmfg:${m.R('bodyText')};--rmmeta:${m.R('metaText')};--rmhair:${m.R('hairlineLight')};--rmtile:${m.R('cardGround')};--rmtileh:${m.R('altGround')}}`,
      `.rm[data-contrast="dark"],.rm[data-contrast="bare"]{--rmfg:${m.R('pageGround')};--rmmeta:${m.OI('meta')};--rmhair:${m.R('hairlineInk')};--rmtile:${tileInk};--rmtileh:${tileInkHover}}`,
      '.rm .scr{display:none}.rm .scr.on{display:block}',
      `.rm .scr.on.leave{animation:${outName} ${m.D('screenOut')} ${m.E('e')} forwards}.rm .scr.on.enter{animation:${inName} ${m.D('screenIn')} ${m.E('e')} both}`,
      `${K(outName)}${K(inName)}  /* ${kf[outName].why} */`,
      `.rm .step{display:flex;align-items:center;gap:${o('components.roadmap.stepGap', '12px', 'the gap inside the step row')};font-family:${m.F('sans')};font-weight:${m.W('label')};font-size:${o('components.roadmap.stepSize', '12px', 'the step label size')};letter-spacing:${m.track.label};text-transform:uppercase;color:var(--rmmeta)}`,
      `.rm .foot{display:flex;align-items:center;justify-content:space-between;gap:${o('components.roadmap.footGap', '16px', 'the gap in the widget footer row')};margin-top:${o('components.roadmap.footOffset', '18px', 'the space above the widget footer row')}}`,
      `.rm .step .bars{display:flex;gap:${o('components.roadmap.barGap', '5px', 'the gap between progress bars')}}.rm .step .bars i{display:block;width:${o('components.roadmap.barWidth', '26px', 'a progress bar width')};height:${o('components.roadmap.barHeight', '2px', 'a progress bar height')};background:var(--rmhair);border-radius:2px}`,
      `.rm .step .bars i.done{background:${m.R('accentPrimary')}}.rm .step .bars i.live{background:${m.R('accentHot')}}`,
      `.rm .q{margin-top:${o('components.roadmap.questionOffset', '14px', 'the space above the question')};font-family:${m.F('display')};font-weight:${m.W('headline')};font-size:${o('components.roadmap.questionSize', 'clamp(1.5rem,2.1vw,2rem)', 'the question size')};line-height:${o('components.roadmap.questionLine', '1.08', 'the question line-height')};letter-spacing:${m.track.headline};color:var(--rmfg)}`,
      `.rm .tiles{display:grid;grid-template-columns:1fr 1fr;gap:${m.SP('tileGap', '10px', 'the gap between answer tiles')};margin-top:${o('components.roadmap.tilesOffset', '22px', 'the space above the tile grid')}}`,
      `.rm .tile{display:flex;align-items:center;gap:${o('components.roadmap.stepGap', '12px', 'the gap inside the step row')};text-align:left;min-height:${o('components.roadmap.tileHeight', '56px', 'the minimum tile height')};padding:${o('components.roadmap.tilePad', '12px 16px', 'the tile padding')};border-radius:${m.RAD('base')};background:var(--rmtile);border:1px solid var(--rmhair);`,
      `color:var(--rmfg);font:${m.W('label')} ${o('components.roadmap.tileSize', '15px', 'the tile label size')}/${o('components.roadmap.tileLine', '1.25', 'the tile line-height')} ${m.F('sans')};cursor:pointer;transition:border-color ${m.D('colorHover')},background ${m.D('colorHover')},transform ${m.D('colorHover')} ${m.E('e')}}`,
      `.rm .tile .x{width:${o('components.roadmap.dotSize', '16px', 'the tile selection dot')};height:${o('components.roadmap.dotSize', '16px', 'the tile selection dot')};flex:none;border-radius:50%;border:${o('components.roadmap.dotRing', '1.5px', 'the tile dot ring')} solid currentColor;opacity:.5;transition:all ${m.D('colorHover')}}`,
      `.rm .tile:hover{border-color:${m.R('accentPrimary')};background:var(--rmtileh);transform:${o('components.roadmap.tileLift', 'translateY(-1px)', 'how far a tile lifts on hover')}}`,
      `.rm .tile.picked{border-color:${m.R('accentPrimary')};background:var(--rmtileh)}`,
      `.rm .tile.picked .x{opacity:1;background:${m.R('accentPrimary')};border-color:${m.R('accentPrimary')};box-shadow:inset 0 0 0 3px var(--rmtile)}`,
      `.rm .back{margin-top:0;background:none;border:0;padding:0;font-family:${m.F('sans')};font-weight:${m.W('label')};font-size:${o('components.roadmap.backSize', '11.5px', 'the back-link size')};letter-spacing:${m.track.label};text-transform:uppercase;color:var(--rmmeta);cursor:pointer}`,
      `.rm .back:hover{color:${m.R('accentPrimary')}}`,
      `.rm input{width:100%;min-height:${o('components.roadmap.inputHeight', '54px', 'the input height')};padding:0 ${o('components.roadmap.inputPadX', '16px', 'the input side padding')};border-radius:${m.RAD('base')};border:1px solid var(--rmhair);background:var(--rmtile);color:var(--rmfg);font:${m.W('label')} ${o('components.roadmap.inputSize', '16px', 'the input font size')} ${m.F('sans')}}`,
      `.rm input:focus{outline:2px solid ${m.R('accentPrimary')};outline-offset:1px}`,
      `.rm .done .q{font-size:${o('components.roadmap.doneQuestionSize', 'clamp(1.8rem,2.6vw,2.4rem)', 'the question size on the done screen')}}`,
      `.rm .done .sum{margin-top:${o('components.roadmap.sumOffset', '16px', 'the space above the summary')};font-size:${o('components.roadmap.sumSize', '16px', 'the summary size')};line-height:${m.lh.lead};color:var(--rmmeta)}.rm .done .sum b{color:var(--rmfg);font-weight:${o('type.weights.strong', 600, 'the weight of an emphasised name in running text')}}`,
      `.rm .done .first{margin-top:${o('components.roadmap.footOffset', '18px', 'the space above the widget footer row')};padding:${o('components.roadmap.firstPad', '16px 18px', 'the padding of the first-step callout')};border-left:2px solid ${m.R('accentPrimary')};color:var(--rmfg);font-size:${o('components.roadmap.sumSize', '16px', 'the summary size')};line-height:${o('components.card.bodyLine', '1.5', 'card body line-height')}}`,
      `.rm .done .first .lab{display:block;font-family:${m.F('sans')};font-weight:${m.W('label')};font-size:${o('components.roadmap.labSize', '11px', 'the callout label size')};letter-spacing:${m.track.eyebrow};text-transform:uppercase;color:var(--rmmeta);margin-bottom:6px}`,
      `.rm .done .btn,.rm .greet .btn{margin-top:${o('components.roadmap.tilesOffset', '22px', 'the space above the tile grid')}}`,
      `.rm .greet .eyebrow{color:${m.R('accentPrimary')}}.rm[data-contrast="dark"] .greet .eyebrow,.rm[data-contrast="bare"] .greet .eyebrow{color:${m.OI('meta')}}`,
      `.rm .greet h2{margin-top:${o('components.roadmap.questionOffset', '14px', 'the space above the question')};font-size:${o('components.roadmap.greetSize', 'clamp(2rem,3.2vw,3rem)', 'the greeting headline size')};color:var(--rmfg)}`,
      `.rm .greet .line{margin-top:${o('components.roadmap.questionOffset', '14px', 'the space above the question')};font-size:${o('components.roadmap.lineSize', '17px', 'the greeting line size')};line-height:${o('components.card.bodyLine', '1.5', 'card body line-height')};color:var(--rmmeta);max-width:${o('components.roadmap.measure', '34ch', 'the greeting measure')}}`,
      `.rm .greet .fine{margin-top:${o('components.roadmap.fineOffset', '12px', 'the space above the fine print')};text-align:center;color:var(--rmmeta)}`,
      `.rm .proof{color:var(--rmmeta)}.rm .greet .faces{margin-top:${o('components.roadmap.footOffset', '18px', 'the space above the widget footer row')}}`
    ].join('\n'),
    tailInto: { 560: '.rm .tiles{grid-template-columns:1fr}' }
  };
};

MODULES.footer = (m) => {
  const o = m.opt;
  const marks = m.identity.marks?.defaults || {};
  return {
    css: [
      `.foot{background:${m.R('deepestInk')};color:${m.R('pageGround')};padding:${m.SP('footPad', '72px 0 28px', 'the footer padding')}}`,
      `.foot .cols{display:grid;grid-template-columns:${o('components.footer.columns', '1.6fr 1fr 1fr 1fr', 'the footer column template')};gap:${o('components.footer.gap', '40px', 'the gap between footer columns')}}`,
      `.foot .lk{height:${marks.footerHeight || o('identity.marks.defaults.footerHeight', '24px', 'the footer lockup height')};width:auto;display:block}`,
      `.foot .tag{margin-top:${o('components.footer.tagOffset', '18px', 'the space above the footer tagline')};max-width:${o('components.roadmap.measure', '34ch', 'the greeting measure')};color:${m.OI('meta')};font-size:${o('components.footer.linkSize', '15px', 'the footer link and tagline size')};line-height:${m.lh.lead}}`,
      `.foot h4{margin:0 0 ${o('components.footer.headingOffset', '14px', 'the space under a footer column heading')};font:${m.W('label')} ${m.S('label')}/1 ${m.F('sans')};letter-spacing:${m.track.label};text-transform:uppercase;color:${m.OI('meta')}}`,
      `.foot li{margin:0 0 ${o('components.footer.itemGap', '10px', 'the gap between footer links')}}.foot li a{font-size:${o('components.footer.linkSize', '15px', 'the footer link and tagline size')};color:${m.OI('body')};transition:color ${m.D('colorHover')}}.foot li a:hover{color:${m.R('pageGround')}}`,
      `.foot .bar{margin-top:${o('components.footer.barOffset', '56px', 'the space above the footer legal bar')};padding-top:${o('components.footer.barPad', '22px', 'the space under the footer rule')};border-top:1px solid ${m.R('hairlineInk')};display:flex;justify-content:space-between;gap:${o('components.footer.barGap', '20px', 'the gap in the footer legal bar')};flex-wrap:wrap;font-size:${o('components.footer.barSize', '13px', 'the footer legal bar size')};color:${m.OI('meta')}}`,
      `@media(max-width:${m.bp(860)}){.foot .cols{grid-template-columns:1fr 1fr}}@media(max-width:${m.bp(520)}){.foot .cols{grid-template-columns:1fr}}`
    ].join('\n')
  };
};

MODULES.wall = (m) => {
  const o = m.opt;
  const asp = m.caps['imagery.aspectRules']?.value || {};
  const wallAsp = asp.wall || o('imagery.aspectRules.wall', '4/5', 'the portrait aspect ratio in the wall');
  return {
    css: [
      `.wall{display:grid;grid-template-columns:repeat(auto-fill,minmax(${o('components.wall.min', '88px', 'the narrowest a wall portrait gets before the grid reflows')},1fr));gap:${o('components.wall.gap', '8px', 'the gap between wall portraits')}}`,
      `.wall img{width:100%;aspect-ratio:${wallAsp};object-fit:cover;border-radius:${m.RAD('sm')};display:block}`,
      `.stars{display:inline-flex;gap:${o('components.wall.starGap', '3px', 'the gap between stars')};color:${m.R('accentHot')}}.stars svg{width:${o('components.wall.starSize', '16px', 'a star glyph')};height:${o('components.wall.starSize', '16px', 'a star glyph')};fill:currentColor}`
    ].join('\n')
  };
};

MODULES.marquee = (m) => {
  const o = m.opt;
  const asp = m.caps['imagery.aspectRules']?.value || {};
  const kf = (m.motion.keyframes || []).find((k) => /marq/i.test(k.name));
  if (!kf) fail('pack outputs.web.motion.keyframes has no marquee keyframe');
  const fade = o('components.marquee.fade', '8%', 'where the edge fade lands');
  const fadeEnd = `${100 - parseFloat(fade)}%`;
  // #000 in a mask means fully opaque, not a colour. It is not brand data.
  const mask = `linear-gradient(90deg,transparent,#000 ${fade},#000 ${fadeEnd},transparent)`;
  return {
    css: [
      `.marq{overflow:hidden;-webkit-mask-image:${mask};mask-image:${mask}}`,
      `.marq .track{display:flex;gap:${m.SP('tileGap', '10px', 'the gap between answer tiles')};width:max-content;animation:${kf.name} ${m.D('marquee')} linear infinite}`,
      '.marq.rev .track{animation-direction:reverse}',
      `.marq img{width:${o('components.marquee.width', '96px', 'a marquee portrait width')};aspect-ratio:${asp.marquee || '4/5'};object-fit:cover;border-radius:${m.RAD('sm')};flex:none}`,
      `@keyframes ${kf.name}{${kf.body}}`
    ].join('\n'),
    tailInto: { 560: `.marq img{width:${m.opt('components.marquee.widthNarrow', '72px', 'a marquee portrait width on a phone')}}` }
  };
};

MODULES.motion = (m) => {
  const o = m.opt;
  const rise = m.D('rise');
  return {
    css: [
      `.js .rise{opacity:0;transform:${o('components.motion.riseFrom', 'translateY(22px)', 'how far a reveal travels')};transition:opacity ${rise} ${m.E('eo')},transform ${rise} ${m.E('eo')}}`,
      '.js .rise.in{opacity:1;transform:none}',
      m.motion.reducedMotion
    ].join('\n')
  };
};

// ---------------------------------------------------------------- assembly

const SECTION_TITLE = {
  nav: 'nav',
  button: 'THE BUTTON',
  card: 'THE CARD',
  stat: 'the counter tile',
  faces: 'faces, creator line',
  roadmap: 'THE ROADMAP WIDGET (.rm)',
  footer: 'THE FOOTER',
  wall: 'faces wall',
  marquee: 'the faces marquee',
  motion: 'motion law: default lit, reveals only behind html.js, reduced motion collapses'
};

// A module's section comment: the emitter's own title, plus the pack's reason for
// the module where the pack carries one. The per-RULE annotations the hand-written
// kit carries ("ruling 58: 700, was 600" beside a single declaration) have nowhere
// to live in the pack today — see the gap report.
function sectionComment(m, name) {
  const title = SECTION_TITLE[name] || name;
  const why = m.web[name]?._why || m.web.components?.[name]?.note || null;
  return why ? `${title} · ${why}` : title;
}

export function emitKit(pack, opts = {}) {
  const m = makeModel(pack);
  m.bp = (px) => {
    const list = m.web.components?.breakpoints;
    if (Array.isArray(list) && !list.includes(px)) {
      m.gaps.push({ key: 'outputs.web.components.breakpoints', want: `${px}px, used by a module`, using: 'the emitter default' });
    }
    return `${px}px`;
  };

  const head = [
    `/* ${m.kit.header}`,
    `   ${m.kit.headerLine2}`,
    `   ${m.kit.headerLine3} */`
  ].join('\n');

  m.gaps.push({
    key: 'outputs.web.components.<module>.annotations',
    want: 'the per-declaration ruling notes the hand-written kit carries beside single rules',
    using: 'the module title plus the pack _why, so those annotations are dropped'
  });
  if (m.fontLoad.method !== '@import') {
    m.gaps.push({ key: 'outputs.web.fontLoad.method', want: 'only "@import" is emitted into the kit today', using: m.fontLoad.method });
  }
  // CSS requires @import BEFORE any rule. Emitted first, always.
  const importLine = `@import url("${m.fontLoad.url}");`;

  // ---- the colour scheme (ruling 66) ----------------------------------------
  // The :root lines are built ONCE, as structure. "light" renders them and stops
  // there, so a light emission is byte-for-byte what this emitter shipped before
  // ruling 66. "dark" and "system" render the same lines again, filtered to the
  // remapped tokens — which is why the delta can only ever be an insertion.
  const lines = tokenLines(m);
  const { scheme, source: schemeSource } = resolveScheme(m, opts.scheme);
  let remap = null;
  let remapProof = null;
  if (scheme !== 'light') {
    remap = schemeRemap(m);
    remapProof = proveRemap(m, lines, remap);
    if (!remapProof.ok) {
      fail(
        'outputs.web.dark.remap does not match the light :root this emitter ships, so a dark block would ' +
          'introduce a colour nobody ruled on:\n' +
          remapProof.bad.map((r) => `  ${r.token}: ${r.note}`).join('\n')
      );
    }
  }

  const tokens = emitTokens(m, lines, scheme, remap);

  // THE MODULES RUN FIRST NOW. Ruling 69 is decided by reading the emitted
  // component CSS — which declaration does which job — so the component rules
  // have to exist before the scheme blocks can be written.
  const modParts = [];
  const tails = [];
  const tailInto = {};

  for (const name of m.order) {
    const mod = MODULES[name];
    if (!mod) fail(`outputs.web.components.order names "${name}" and this emitter has no module for it`);
    const r = mod(m);
    if (name !== 'base') modParts.push('', `/* ---------- ${sectionComment(m, name)} ---------- */`);
    modParts.push(r.css);
    if (r.tail) tails.push(r.tail);
    for (const [bp, css] of Object.entries(r.tailInto || {})) {
      (tailInto[bp] = tailInto[bp] || []).push(css);
    }
  }

  for (const [bp, list] of Object.entries(tailInto).sort((a, b) => Number(b[0]) - Number(a[0]))) {
    tails.push(`@media(max-width:${bp}px){${list.join('')}}`);
  }

  const componentCss = [...modParts, ...tails].join('\n');
  const plan = scheme === 'light' ? null : planSplit(m, componentCss, lines, remap, opts);
  const schemeBlocks = emitSchemeBlocks(lines, scheme, remap, plan);
  const splitBlocks = emitSplitBlocks(scheme, plan);

  const parts = [head, importLine, '', tokens, ...schemeBlocks, ...modParts];
  if (tails.length) parts.push('', ...tails);
  parts.push(...splitBlocks);

  const css = parts.join('\n') + '\n';
  const fontsHtml = emitFontsHtml(m);
  // tokens.generated.css is the token layer on its own, so it carries the scheme
  // too — a consumer that takes tokens without components still flips correctly.
  // It carries the ruling 69 token and NOT the component overrides: those are
  // component rules, and this file is the token layer.
  const tokensCss = [tokens, ...schemeBlocks].join('\n') + '\n';
  return {
    css, tokensCss, fontsHtml, model: m, gaps: m.gaps,
    scheme, schemeSource, remap, remapProof, lines, plan, componentCss
  };
}

function emitFontsHtml(m) {
  const fams = (m.fontLoad.families || [])
    .map((f) => `  <!-- ${f.name} ${(f.weights || []).join('/')}${f.role ? ' — ' + f.role : ''} -->`)
    .join('\n');
  return [
    '<!-- Emitted by `bbe kit`. The ONE font request for this brand.',
    '     A surface that declares its own @import or <link> to a font provider is a gate failure. -->',
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    fams,
    `<link rel="stylesheet" href="${m.fontLoad.url}">`,
    ''
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- LEVEL 1
// Normalized text diff. Both files go through the SAME normalizer: strip
// comments, collapse whitespace, split into rules, sort the declarations inside
// each block, sort selectors inside each selector list, key @media rules by
// their query so blocks written in different places merge. Then diff.
//
// Two passes are reported. RAW compares the declarations as written. RESOLVED
// first substitutes every var(--x) for its :root value, recursively, in BOTH
// files — so `font-size:var(--mt)` and `font-size:12px` are recognised as the
// same declaration when the kit's own :root says --mt:12px. Spelling differences
// show up in RAW; only RESOLVED differences can change a pixel.

export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function splitTop(text, sep) {
  const out = [];
  let buf = '', depth = 0, q = null;
  for (const ch of text) {
    if (q) { buf += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; buf += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}

const ws = (s) => String(s).replace(/\s+/g, ' ').trim();

function normDecls(body) {
  return splitTop(body, ';')
    .map((d) => ws(d))
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(':');
      if (i < 0) return d;
      return `${d.slice(0, i).trim().toLowerCase()}:${ws(d.slice(i + 1))}`;
    });
}

const normSelector = (sel) =>
  splitTop(sel, ',').map((s) => ws(s)).filter(Boolean).sort().join(',');

const normQuery = (q) => ws(q).replace(/\s*([(),:])\s*/g, '$1').toLowerCase();

export function parseCss(css, media = '', acc = { rules: new Map(), at: [] }) {
  const src = stripComments(css);
  let buf = '', i = 0, q = null, paren = 0;
  while (i < src.length) {
    const ch = src[i];
    if (q) { buf += ch; if (ch === q) q = null; i++; continue; }
    if (ch === '"' || ch === "'") { q = ch; buf += ch; i++; continue; }
    if (ch === '(') paren++;
    if (ch === ')') paren--;
    if (ch === ';' && paren === 0) {
      const s = ws(buf);
      if (s) acc.at.push(s.replace(/\s+/g, ''));
      buf = ''; i++; continue;
    }
    if (ch === '{' && paren === 0) {
      const prelude = ws(buf);
      // find the matching close brace
      let depth = 1, j = i + 1, qq = null;
      while (j < src.length && depth > 0) {
        const c = src[j];
        if (qq) { if (c === qq) qq = null; j++; continue; }
        if (c === '"' || c === "'") { qq = c; j++; continue; }
        if (c === '{') depth++;
        if (c === '}') depth--;
        j++;
      }
      const body = src.slice(i + 1, j - 1);
      if (/^@media/i.test(prelude)) {
        parseCss(body, normQuery(prelude), acc);
      } else if (/^@/.test(prelude)) {
        // @keyframes and friends: compare as one opaque, order-insensitive blob
        const frames = splitTop(body, '}')
          .map((f) => ws(f).replace(/\s/g, ''))
          .filter(Boolean)
          .sort();
        acc.at.push(`${normQuery(prelude)}{${frames.join('}')}}`);
      } else {
        const key = `${media}|${normSelector(prelude)}`;
        const prev = acc.rules.get(key) || [];
        acc.rules.set(key, prev.concat(normDecls(body)));
      }
      buf = ''; i = j; continue;
    }
    buf += ch;
    i++;
  }
  return acc;
}

// build --x -> value from every :root block, then resolve var() recursively
function customProps(acc) {
  const map = new Map();
  for (const [key, decls] of acc.rules) {
    if (!/\|:root$/.test(key)) continue;
    for (const d of decls) {
      const i = d.indexOf(':');
      const name = d.slice(0, i).trim();
      if (name.startsWith('--')) map.set(name, d.slice(i + 1).trim());
    }
  }
  return map;
}

function resolveVars(value, map, depth = 0) {
  if (depth > 12) return value;
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,[^()]*)?\)/g, (whole, name) =>
    map.has(name) ? resolveVars(map.get(name), map, depth + 1) : whole
  );
}

export function resolved(acc) {
  const map = customProps(acc);
  const out = new Map();
  for (const [key, decls] of acc.rules) {
    out.set(key, decls.map((d) => {
      const i = d.indexOf(':');
      const name = d.slice(0, i);
      if (name.startsWith('--')) return `${name}:${resolveVars(d.slice(i + 1), map)}`;
      return `${name}:${resolveVars(d.slice(i + 1), map)}`;
    }));
  }
  return out;
}

function diffMaps(aMap, bMap) {
  const missing = [], extra = [], changed = [];
  for (const [key, decls] of aMap) {
    if (!bMap.has(key)) { missing.push(key); continue; }
    const A = [...decls].sort(), B = [...bMap.get(key)].sort();
    const aSet = new Set(A), bSet = new Set(B);
    const onlyA = A.filter((d) => !bSet.has(d));
    const onlyB = B.filter((d) => !aSet.has(d));
    if (onlyA.length || onlyB.length) {
      const byProp = new Map();
      for (const d of onlyA) byProp.set(d.slice(0, d.indexOf(':')), { target: d.slice(d.indexOf(':') + 1), emitted: '(absent)' });
      for (const d of onlyB) {
        const p = d.slice(0, d.indexOf(':'));
        const e = byProp.get(p) || { target: '(absent)', emitted: '' };
        e.emitted = d.slice(d.indexOf(':') + 1);
        byProp.set(p, e);
      }
      for (const [prop, v] of byProp) changed.push({ key, prop, ...v });
    }
  }
  for (const key of bMap.keys()) if (!aMap.has(key)) extra.push(key);
  return { missing, extra, changed };
}

function table(rows, cols) {
  if (!rows.length) return '  (none)';
  const widths = cols.map((c) => Math.max(c.head.length, ...rows.map((r) => String(r[c.key] ?? '').length)));
  const line = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  return [
    line(cols.map((c) => c.head)),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map((r) => line(cols.map((c) => r[c.key] ?? '')))
  ].join('\n');
}

const pretty = (key) => {
  const [media, sel] = key.split('|');
  return media ? `${media} ${sel}` : sel;
};

export function verifyLevel1(emittedCss, targetCss) {
  const A = parseCss(targetCss);
  const B = parseCss(emittedCss);
  const raw = diffMaps(A.rules, B.rules);
  const res = diffMaps(resolved(A), resolved(B));

  const atA = new Set(A.at), atB = new Set(B.at);
  const atMissing = [...atA].filter((x) => !atB.has(x));
  const atExtra = [...atB].filter((x) => !atA.has(x));

  const report = [];
  const section = (title, body) => report.push(`\n${title}\n${body}`);

  report.push('LEVEL 1 — normalized text diff');
  report.push(`  target : ${A.rules.size} rules, ${A.at.length} at-statements`);
  report.push(`  emitted: ${B.rules.size} rules, ${B.at.length} at-statements`);

  section('  SELECTORS in the target, absent from the output',
    table(raw.missing.map((k) => ({ sel: pretty(k) })), [{ head: 'selector', key: 'sel' }]));
  section('  SELECTORS in the output, absent from the target',
    table(raw.extra.map((k) => ({ sel: pretty(k) })), [{ head: 'selector', key: 'sel' }]));
  section('  AT-STATEMENTS that differ',
    table([...atMissing.map((x) => ({ side: 'target only', v: x })), ...atExtra.map((x) => ({ side: 'output only', v: x }))],
      [{ head: 'side', key: 'side' }, { head: 'statement', key: 'v' }]));
  section('  DECLARATIONS that differ (RAW — as written)',
    table(raw.changed.map((c) => ({ sel: pretty(c.key), prop: c.prop, t: c.target, e: c.emitted })),
      [{ head: 'selector', key: 'sel' }, { head: 'property', key: 'prop' }, { head: 'target', key: 't' }, { head: 'emitted', key: 'e' }]));
  section('  DECLARATIONS that differ (RESOLVED — var() substituted in both)',
    table(res.changed.map((c) => ({ sel: pretty(c.key), prop: c.prop, t: c.target, e: c.emitted })),
      [{ head: 'selector', key: 'sel' }, { head: 'property', key: 'prop' }, { head: 'target', key: 't' }, { head: 'emitted', key: 'e' }]));

  const rawClean = !raw.missing.length && !raw.extra.length && !raw.changed.length && !atMissing.length && !atExtra.length;
  const resClean = !res.missing.length && !res.extra.length && !res.changed.length && !atMissing.length && !atExtra.length;
  report.push(`\n  RAW DIFF     : ${rawClean ? 'EMPTY' : `${raw.missing.length} missing selectors, ${raw.extra.length} extra selectors, ${raw.changed.length} changed declarations, ${atMissing.length + atExtra.length} at-statement differences`}`);
  report.push(`  RESOLVED DIFF: ${resClean ? 'EMPTY' : `${res.missing.length} missing selectors, ${res.extra.length} extra selectors, ${res.changed.length} changed declarations`}`);
  return { ok: resClean, rawClean, resClean, raw, res, atMissing, atExtra, report: report.join('\n') };
}

// ---------------------------------------------------------------- SCHEME DELTA
//
// THE PROOF STAYS SPLIT. A proof that changes two things at once proves neither.
//
//   half 1  the LIGHT emission still reproduces the live kit — level 1 above,
//           run on the light emission whatever --scheme says. Unchanged.
//   half 2  this table: the non-light emission against that same light emission,
//           line by line, showing that the whole difference is the new blocks.
//
// For "system" the difference must be a pure INSERTION: nothing removed, nothing
// changed, and every added line of content inside one of the two new blocks. For
// "dark" the dark values go in :root by design, so changed lines are expected —
// but every one of them must be a remapped token and nothing else.

function lcs(a, b) {
  const n = a.length, mLen = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(mLen + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = mLen - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < mLen) {
    if (a[i] === b[j]) { ops.push({ op: 'same', a: i, b: j, text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ op: 'del', a: i, b: null, text: a[i] }); i++; }
    else { ops.push({ op: 'add', a: null, b: j, text: b[j] }); j++; }
  }
  while (i < n) { ops.push({ op: 'del', a: i, b: null, text: a[i] }); i++; }
  while (j < mLen) { ops.push({ op: 'add', a: null, b: j, text: b[j] }); j++; }
  return ops;
}

// Which named block each line of the emitted file sits in. A block opens on its
// comment line and closes when brace depth comes back to zero.
function blockMap(lines) {
  const OPENERS = [
    [MEDIA_NOTE, '@media (prefers-color-scheme: dark)'],
    [EXPLICIT_NOTE, ':root[data-theme=…]'],
    [SPLIT_NOTE, 'the ruling 69 override run']
  ];
  const map = new Array(lines.length).fill(null);
  let cur = null, depth = 0, opened = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (!cur) {
      const hit = OPENERS.find(([note]) => t === note);
      if (hit) { cur = hit[1]; depth = 0; opened = false; map[i] = cur; continue; }
      // Ruling 69's scoped overrides. Each is a complete rule whose selector
      // starts with a scheme root scope, so it belongs to the scheme block by
      // construction — it cannot apply in the light render at all. The comment
      // that heads the run is mapped without opening anything, because it has no
      // braces and would otherwise swallow the rest of the file.
      if (t.trim() === SPLIT_NOTE_2) { map[i] = 'the ruling 69 override run'; continue; }
      if (/^(?::where\(:root|@media \(prefers-color-scheme: dark\)\{$)/.test(t)) { cur = 'the ruling 69 override run'; depth = 0; opened = false; map[i] = cur; }
      else if (/^:root(?::not\(\[data-theme=|\[data-theme=)/.test(t)) { cur = ':root[data-theme=…]'; depth = 0; opened = false; map[i] = cur; }
      else if (/^:root\{/.test(t)) { cur = ':root'; depth = 0; opened = false; map[i] = cur; }
      else continue;
    } else {
      map[i] = cur;
    }
    for (const ch of t) {
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') depth--;
    }
    if (opened && depth <= 0) { cur = null; }
  }
  return map;
}

export function proveSchemeDelta(lightCss, schemeCss, scheme, remap) {
  const A = lightCss.split('\n');
  const B = schemeCss.split('\n');
  const ops = lcs(A, B);
  const map = blockMap(B);
  const newBlocks = ['@media (prefers-color-scheme: dark)', ':root[data-theme=…]', 'the ruling 69 override run'];

  const added = ops.filter((o) => o.op === 'add').map((o) => ({ ...o, block: map[o.b] }));
  const removed = ops.filter((o) => o.op === 'del');

  // A "change" is a removal and an addition that are the same :root line carrying
  // different values. Pair them up so a remapped :root line is not reported as
  // one line vanishing and an unrelated one appearing.
  const remapped = remap ? [...remap.keys()] : [];
  const isRootTokenLine = (t) => /^--/.test(t.trim());
  const changed = [];
  for (const d of removed) {
    const cand = added.find((x) => x.block === ':root' && isRootTokenLine(x.text) && !x.paired &&
      x.text.split(';')[0].split(':')[0] === d.text.split(';')[0].split(':')[0]);
    if (cand) { cand.paired = true; d.paired = true; changed.push({ from: d.text, to: cand.text, line: cand.b + 1 }); }
  }
  const trueRemoved = removed.filter((d) => !d.paired);
  const trueAdded = added.filter((x) => !x.paired);

  const blank = trueAdded.filter((x) => x.text.trim() === '');
  const inNew = trueAdded.filter((x) => x.text.trim() !== '' && newBlocks.includes(x.block));
  const outside = trueAdded.filter((x) => x.text.trim() !== '' && !newBlocks.includes(x.block));

  // every changed line must be a :root line whose changed tokens are ALL remapped
  const badChange = changed.filter((c) => {
    const names = (s) => s.trim().split(';').filter(Boolean).map((d) => d.split(':')[0].trim());
    const from = names(c.from.replace(/\/\*[\s\S]*?\*\//g, ''));
    const to = names(c.to.replace(/\/\*[\s\S]*?\*\//g, ''));
    if (from.join('|') !== to.join('|')) return true;
    const moved = c.from.split(';').filter(Boolean).filter((d, i) => d !== c.to.split(';')[i]);
    return moved.some((d) => !remapped.includes(d.split(':')[0].trim()));
  });

  const ok = scheme === 'system'
    ? trueRemoved.length === 0 && changed.length === 0 && outside.length === 0
    : trueRemoved.length === 0 && outside.length === 0 && badChange.length === 0;

  const perBlock = {};
  for (const x of inNew) perBlock[x.block] = (perBlock[x.block] || 0) + 1;

  const rows = [
    ['lines, light emission', String(A.length)],
    [`lines, ${scheme} emission`, String(B.length)],
    ['lines REMOVED from the light emission', String(trueRemoved.length)],
    ['lines CHANGED in the light emission', String(changed.length) + (scheme === 'dark' ? ` (expected: the dark values go in :root; ${badChange.length} carry a token that is not in the remap)` : '')],
    ['lines ADDED, blank separators', String(blank.length)],
    ['lines ADDED, content, inside a new block', String(inNew.length)],
    ...newBlocks.filter((b) => perBlock[b]).map((b) => [`    ${b}`, String(perBlock[b])]),
    ['lines ADDED, content, OUTSIDE both new blocks', String(outside.length)]
  ];

  const w1 = Math.max(...rows.map((r) => r[0].length));
  const out = [`SCHEME DELTA — "${scheme}" against "light", line by line`];
  out.push('  Half 1 of the proof (level 1 above) is run on the LIGHT emission and is untouched by this.');
  out.push('  Half 2 is this: what the scheme adds to that exact file, and nothing else.');
  out.push('');
  for (const [k, v] of rows) out.push('  ' + k.padEnd(w1) + '  ' + v);

  if (changed.length) {
    out.push('', '  CHANGED lines');
    out.push('  ' + 'line'.padEnd(6) + '  ' + 'light'.padEnd(58) + '  ' + scheme);
    out.push('  ' + '-'.repeat(6) + '  ' + '-'.repeat(58) + '  ' + '-'.repeat(58));
    for (const c of changed) out.push('  ' + String(c.line).padEnd(6) + '  ' + c.from.slice(0, 58).padEnd(58) + '  ' + c.to.slice(0, 58));
  }
  if (trueRemoved.length) {
    out.push('', '  REMOVED lines (there must be none)');
    for (const d of trueRemoved) out.push('    ' + d.text);
  }

  out.push('', '  EVERY ADDED LINE, and the block it lands in');
  out.push('  ' + 'line'.padEnd(6) + '  ' + 'block'.padEnd(36) + '  text');
  out.push('  ' + '-'.repeat(6) + '  ' + '-'.repeat(36) + '  ' + '-'.repeat(64));
  for (const x of trueAdded) {
    const blk = x.text.trim() === '' ? '(blank separator)' : (x.block || 'OUTSIDE ANY NEW BLOCK');
    out.push('  ' + String(x.b + 1).padEnd(6) + '  ' + blk.padEnd(36) + '  ' + (x.text.length > 64 ? x.text.slice(0, 63) + '…' : x.text));
  }

  out.push('', `  SCHEME DELTA: ${ok
    ? (scheme === 'system'
      ? 'PASS — nothing removed, nothing changed, every added line of content inside the two new blocks'
      : 'PASS — nothing removed, every changed line a remapped token, every added line inside the new block')
    : 'FAIL — the scheme moved something it had no business moving'}`);
  return { ok, added: trueAdded, removed: trueRemoved, changed, outside, report: out.join('\n') };
}

// The remap table, printed so the "invents no colours" claim is readable rather
// than asserted. Every dark value is checked against the token it says it came
// from, in the light :root this same run emitted.
export function remapReport(proof) {
  if (!proof) return 'SCHEME REMAP: not applicable — scheme is "light", no token is remapped.';
  const cols = [['token', 'token', 10], ['light', 'light', 24], ['dark', 'dark', 24], ['from', 'from', 10], ['proof', 'note', 30]];
  const out = ['SCHEME REMAP — every dark value checked against the light token it says it came from'];
  out.push('  ' + cols.map(([h, , w]) => h.padEnd(w)).join('  '));
  out.push('  ' + cols.map(([, , w]) => '-'.repeat(w)).join('  '));
  for (const r of proof.rows) {
    const verdict = r.lightOk && r.darkOk === true ? 'both sides check out' : r.note;
    out.push('  ' + [r.token.padEnd(10), r.light.padEnd(24), r.dark.padEnd(24), String(r.from).padEnd(10), verdict.padEnd(30)].join('  '));
  }
  out.push(`  ${proof.ok ? 'PASS — the remap introduces no colour the light kit does not already ship.' : 'FAIL'}`);
  return out.join('\n');
}

// ---------------------------------------------------------------- the split, reported
//
// The claim "--paper did two jobs and now two tokens do one each" is only worth
// anything if you can see WHICH declaration took which job. So both halves are
// printed: every declaration that moved, and every one that deliberately did not.

export function splitReport(plan) {
  if (!plan) return 'THE SPLIT (ruling 69): not applicable — this scheme emits no dark blocks.';
  const out = [`THE SPLIT (ruling 69) — ${plan.groundVar} did two jobs; ${plan.odVar} now carries the foreground one`];
  const kinds = ['foreground', 'foreground var', 'disc', 'arrow', 'accent type'];
  const rows = [];
  for (const k of kinds) {
    for (const o of plan.overrides.filter((x) => x.kind === k)) {
      rows.push([k, o.selector, o.prop, o.from, o.to, o.why]);
    }
  }
  out.push('');
  out.push(`  ${plan.overrides.length} declaration(s) take a different token in dark. Nothing outside this list moves.`);
  out.push(col2(['job', 'selector', 'property', 'light', 'dark', 'why'], [14, 42, 10, 16, 16, 52], rows));
  const g = new Map();
  for (const x of plan.grounds) g.set(`${x.selector}|${x.prop}`, x);
  out.push('', `  THE GROUND JOB — ${g.size} declaration(s) keep ${plan.groundVar} and flip with it`);
  out.push(col2(['selector', 'property'], [42, 18], [...g.values()].map((x) => [x.selector, x.prop])));
  return out.join('\n');
}

// The law, measured in Node off the emitted values. Level 2 measures the same
// three pairs again in a real browser; two independent instruments, on purpose.
export function proveDiscArrowLaw(plan) {
  if (!plan) return { ok: true, rows: [], report: 'THE DISC/ARROW LAW: not applicable — no dark blocks in this scheme.' };
  const rows = plan.discArrow;
  // A pair that cannot be resolved is not a pass. An instrument that reports
  // "no number" and is counted green is how a blind spot ships.
  const bad = rows.filter((r) => !r.onGradient && (r.ratio === null || r.ratio < CONTRAST_MIN));
  const out = ["THE DISC/ARROW LAW — an arrow's colour follows its DISC, never the page"];
  out.push('');
  out.push(col2(['disc', 'arrow', 'disc in dark', 'arrow in dark', 'ratio', 'verdict'], [30, 34, 14, 14, 7, 46],
    rows.map((r) => [
      r.discSel,
      r.arrowSel,
      r.discDark || '(gradient)',
      r.arrowDark || '?',
      r.ratio === null ? '—' : `${r.ratio}:1`,
      r.onGradient ? 'on the accent gradient, not measured'
        : r.ratio === null ? 'NOT MEASURABLE — neither colour resolved'
          : r.ratio < CONTRAST_MIN ? `FAIL, under ${CONTRAST_MIN}`
            : `clears ${CONTRAST_MIN}${r.moved ? ', arrow moved' : ', arrow held'}`
    ])));
  out.push('', `  DISC/ARROW: ${bad.length === 0
    ? `PASS — every measured pair differs and clears ${CONTRAST_MIN}:1 in dark`
    : `FAIL — ${bad.length} pair(s) under ${CONTRAST_MIN}:1: ${bad.map((r) => `${r.arrowSel} ${r.ratio}:1`).join('; ')}`}`);
  return { ok: bad.length === 0, rows, bad, report: out.join('\n') };
}

function col2(heads, widths, rows) {
  const cut = (s, w) => (String(s ?? '').length > w ? String(s).slice(0, w - 1) + '…' : String(s ?? ''));
  if (!rows.length) return '  (none)';
  const lines = ['  ' + heads.map((h, i) => h.padEnd(widths[i])).join('  ')];
  lines.push('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push('  ' + r.map((c, i) => cut(c, widths[i]).padEnd(widths[i])).join('  '));
  return lines.join('\n');
}

// ---------------------------------------------------------------- gaps report

function gapReport(gaps) {
  if (!gaps.length) return 'PACK GAPS: none. Every value came out of the pack.';
  const seen = new Set();
  const rows = gaps.filter((g) => (seen.has(g.key) ? false : (seen.add(g.key), true)));
  const w1 = Math.max(...rows.map((r) => r.key.length));
  const w2 = Math.max(...rows.map((r) => String(r.using).length), 20);
  return [
    `PACK GAPS: ${rows.length} values the emitter wanted from the pack and did not find.`,
    'Each one is a structural default in the emitter today. Add the key and the pack owns it.',
    '',
    '  ' + 'pack key'.padEnd(w1) + '  ' + 'emitter is using'.padEnd(w2) + '  what it is',
    '  ' + '-'.repeat(w1) + '  ' + '-'.repeat(w2) + '  ' + '-'.repeat(40),
    ...rows.map((r) => '  ' + r.key.padEnd(w1) + '  ' + String(r.using).padEnd(w2) + '  ' + r.want)
  ].join('\n');
}

// ---------------------------------------------------------------- selftest
//
// Plant one defect in the pack in memory, emit, and require the verifier to go
// RED on exactly that. A verifier that has only ever returned green has not been
// tested.

const DEFECTS = [
  {
    name: 'a palette hex (accentPrimary -> #123456)',
    apply: (p) => {
      const pal = p.capabilities['color.palette'].value;
      const key = Object.keys(pal).find((k) => pal[k].cssVar === p.capabilities['color.semanticRoles'].value.accentPrimary);
      pal[key].value = '#123456'; // a synthetic defect value, deliberately not any brand's
    },
    expect: /:root/
  },
  {
    name: 'the headline weight (700 -> 400)',
    apply: (p) => { p.outputs.web.type.weights.headline = 400; },
    expect: /h1|h2|h3/
  },
  {
    name: 'the button padding',
    apply: (p) => { p.outputs.web.button.geometry.padding = '1px 2px 3px 4px'; },
    expect: /\.btn/
  },
  {
    name: 'the font-loading URL',
    apply: (p) => { p.outputs.web.fontLoad.url = 'https://fonts.googleapis.com/css2?family=Comic+Neue&display=swap'; },
    expect: /import/i
  },
  {
    name: 'a motion duration (marquee 48s -> 3s)',
    apply: (p) => { p.outputs.web.motion.durations.marquee = '3s'; },
    expect: /marq/
  }
];

function runSelftest(packPath, targetCss) {
  const clean = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  // The reference kit has no dark blocks, so this half of the proof is measured
  // on the LIGHT emission — the same file level 1 measures. Keeping the halves
  // split is the whole point.
  const base = verifyLevel1(emitKit(clean, { scheme: 'light' }).css, targetCss);
  const lines = ['SELFTEST — plant a defect, require the verifier to go RED', ''];
  lines.push(`  control (undamaged pack): RESOLVED DIFF ${base.resClean ? 'EMPTY -> GREEN' : 'NOT EMPTY -> the control itself is red, selftest is meaningless'}`);
  let pass = base.resClean;
  for (const d of DEFECTS) {
    const damaged = JSON.parse(fs.readFileSync(packPath, 'utf8'));
    d.apply(damaged);
    const v = verifyLevel1(emitKit(damaged, { scheme: 'light' }).css, targetCss);
    const hits = [...v.res.changed.map((c) => c.key), ...v.res.missing, ...v.res.extra, ...v.atMissing, ...v.atExtra];
    const wentRed = !v.resClean;
    const rightPlace = hits.some((h) => d.expect.test(h));
    const ok = wentRed && rightPlace;
    if (!ok) pass = false;
    lines.push(`  ${ok ? 'RED   ' : 'FAILED'}  ${d.name.padEnd(46)} ${wentRed ? `${v.res.changed.length + v.res.missing.length + v.res.extra.length + v.atMissing.length + v.atExtra.length} difference(s)` : 'verifier stayed GREEN — it is blind here'}${wentRed && !rightPlace ? ' but not where expected' : ''}`);
  }
  lines.push('', `  SELFTEST: ${pass ? 'PASS — green on a clean pack, red on every planted defect' : 'FAIL'}`);
  return { pass, report: lines.join('\n') };
}


// ---- the scheme half of the selftest (ruling 66) ----------------------------
//
// Three shape assertions, one per legal value, then defects. The shape
// assertions matter because the scheme blocks live OUTSIDE the reference kit —
// level 1 compares against a file that has no dark blocks at all, so it can
// never say a word about them. Without these the dark work would be untested.

const rootBlock = (css) => (css.match(/^:root\{\n([\s\S]*?)\n\}/m) || [, ''])[1];
const namedBlock = (css, head) => {
  const i = css.indexOf(head);
  if (i < 0) return null;
  return css.slice(i, css.indexOf('\n}', i) + 2);
};

const SCHEME_ASSERTS = [
  {
    scheme: 'light',
    name: 'light emits NO prefers-color-scheme and NO [data-theme] block',
    check: (css) => (/prefers-color-scheme/.test(css) ? 'a @media block is present' :
      /\[data-theme/.test(css) ? 'a [data-theme] block is present' : null)
  },
  {
    scheme: 'system',
    name: 'system emits both new blocks, @media FIRST so the explicit choice wins',
    check: (css) => {
      const a = css.indexOf('@media (prefers-color-scheme: dark){\n  :root:not([data-theme="light"]){');
      const b = css.indexOf(':root[data-theme="dark"]{');
      if (a < 0) return 'no @media (prefers-color-scheme: dark){ :root:not([data-theme="light"]) } block';
      if (b < 0) return 'no :root[data-theme="dark"] block';
      if (b < a) return 'the explicit block is emitted before the @media block, so it cannot win';
      return null;
    }
  },
  {
    scheme: 'system',
    name: 'system leaves the light values in :root untouched',
    check: (css, ctx) => (rootBlock(css) === rootBlock(ctx.lightCss) ? null : 'the :root block moved')
  },
  {
    scheme: 'dark',
    name: 'dark puts the DARK values in :root, and restores light under [data-theme="light"]',
    check: (css, ctx) => {
      const root = rootBlock(css);
      const restore = namedBlock(css, ':root[data-theme="light"]{');
      if (!restore) return 'no :root[data-theme="light"] block to restore light';
      for (const [token, e] of ctx.remap) {
        if (!root.includes(`${token}:${e.dark}`)) return `:root does not carry ${token}:${e.dark}`;
        if (root.includes(`${token}:${e.light};`)) return `:root still carries the light value for ${token}`;
        if (!restore.includes(`${token}:${e.light}`)) return `[data-theme="light"] does not restore ${token}:${e.light}`;
      }
      return null;
    }
  }
];

// A defect in the remap must stop the emit. The remap is the one place a colour
// nobody ruled on could enter the kit, so "it emitted something" is a failure.
// Brand-blind, like everything else here: a defect picks its token by POSITION
// in the pack's own remap, never by name, so the same selftest runs on any pack.
// #123456 is a synthetic value, deliberately not any brand's.
const SYNTHETIC = '#123456';
const remapKeys = (p) => Object.keys(p.outputs.web.dark.remap).filter((k) => k.startsWith('--'));

const SCHEME_DEFECTS = [
  (p) => {
    const t = remapKeys(p)[0];
    p.outputs.web.dark.remap[t].dark = SYNTHETIC;
    return { name: `a remap DARK value (${t} dark -> ${SYNTHETIC})`, expect: new RegExp(t) };
  },
  (p) => {
    const t = remapKeys(p)[1];
    p.outputs.web.dark.remap[t].light = SYNTHETIC;
    return { name: `a remap LIGHT value (${t} light -> ${SYNTHETIC})`, expect: new RegExp(t) };
  },
  (p) => {
    const from = remapKeys(p)[0];
    p.outputs.web.dark.remap['--nope'] = { light: SYNTHETIC, dark: SYNTHETIC, from };
    return { name: 'a remap entry naming a token the kit does not ship (--nope)', expect: /--nope/ };
  },
  (p) => {
    p.outputs.web.dark.defaultScheme = 'auto';
    return { name: 'an illegal defaultScheme ("auto")', expect: /defaultScheme|auto/ };
  }
];

function runSchemeSelftest(packPath) {
  const lines = ['SELFTEST — the colour scheme (ruling 66)', ''];
  let pass = true;
  const read = () => JSON.parse(fs.readFileSync(packPath, 'utf8'));

  const lightCss = emitKit(read(), { scheme: 'light' }).css;
  const built = {};
  for (const s of SCHEMES) built[s] = emitKit(read(), { scheme: s });
  const remap = built.system.remap;

  lines.push('  SHAPE — what each legal value emits');
  for (const a of SCHEME_ASSERTS) {
    const why = a.check(built[a.scheme].css, { lightCss, remap });
    if (why) pass = false;
    lines.push(`  ${why ? 'FAILED' : 'PASS  '}  ${a.scheme.padEnd(7)} ${a.name}${why ? `  <- ${why}` : ''}`);
  }

  lines.push('', '  DEFECTS — plant one, require the emitter to REFUSE rather than emit');
  for (const plant of SCHEME_DEFECTS) {
    const damaged = read();
    const d = plant(damaged);
    const r = catchingFailures(() => emitKit(damaged, { scheme: 'system' }));
    const refused = !r.ok;
    const rightPlace = refused && d.expect.test(r.why);
    if (!refused || !rightPlace) pass = false;
    lines.push(`  ${refused && rightPlace ? 'RED   ' : 'FAILED'}  ${d.name.padEnd(56)} ${refused ? (rightPlace ? 'refused, naming the right key' : `refused but for another reason: ${r.why.split('\n')[0]}`) : 'EMITTED ANYWAY — the guard is blind here'}`);
  }

  // The delta prover itself has to be tested, not just consulted. Mangle a line
  // OUTSIDE the new blocks in a system emission and require the prover to catch
  // it — otherwise "SCHEME DELTA: PASS" only ever means the prover ran.
  lines.push('', '  THE DELTA PROVER — mangle a line outside the new blocks, require FAIL');
  const clean = proveSchemeDelta(lightCss, built.system.css, 'system', remap);
  lines.push(`  ${clean.ok ? 'PASS  ' : 'FAILED'}  control: the real system emission is a pure insertion`);
  if (!clean.ok) pass = false;
  const mangles = [
    ['a body rule edited', (c) => c.replace('body{margin:0', 'body{margin:1px')],
    ['a line deleted', (c) => c.split('\n').filter((l) => !/^img\{/.test(l)).join('\n')],
    ['a rule appended outside both blocks', (c) => c + '.sneaked{color:red}\n']
  ];
  for (const [name, f] of mangles) {
    const r = proveSchemeDelta(lightCss, f(built.system.css), 'system', remap);
    if (r.ok) pass = false;
    lines.push(`  ${r.ok ? 'FAILED' : 'RED   '}  ${name.padEnd(40)} ${r.ok ? 'the prover stayed GREEN — it is blind here' : `${r.removed.length} removed, ${r.changed.length} changed, ${r.outside.length} added outside`}`);
  }

  // RULING 69's own probe. The verifier for the disc/arrow law has to be shown
  // going RED, or "DISC/ARROW: PASS" only means the check ran. The defect planted
  // is the exact mistake Andrew caught by eye: every arrow sent to the foreground
  // token because the PAGE is dark, ignoring the disc it actually sits on.
  lines.push('', '  THE DISC/ARROW LAW — plant an arrow that follows its PAGE, require RED');
  const control = proveDiscArrowLaw(built.system.plan);
  lines.push(`  ${control.ok ? 'PASS  ' : 'FAILED'}  control: every arrow follows its own disc  ${control.rows.filter((r) => r.ratio !== null).map((r) => `${r.arrowSel.replace(/ svg$/, '')} ${r.ratio}:1`).join(' · ')}`);
  if (!control.ok) pass = false;
  const planted = proveDiscArrowLaw(emitKit(read(), { scheme: 'system', arrowsFollowThePage: true }).plan);
  lines.push(`  ${planted.ok ? 'FAILED' : 'RED   '}  planted: arrows follow the page  ${planted.ok
    ? 'the law verifier stayed GREEN — it is blind here'
    : `${planted.bad.length} pair(s) collapse: ${planted.bad.map((r) => `${r.arrowSel} ${r.ratio}:1`).join('; ')}`}`);
  if (planted.ok) pass = false;
  // and the mangled emission has to reach the CSS, so the delta prover sees it too
  const plantedCss = emitKit(read(), { scheme: 'system', arrowsFollowThePage: true }).css;
  const plantedDiffers = plantedCss !== built.system.css;
  lines.push(`  ${plantedDiffers ? 'RED   ' : 'FAILED'}  planted: the defect actually reaches the emitted CSS  ${plantedDiffers ? 'the two emissions differ' : 'the planted defect emitted the SAME file — the probe proves nothing'}`);
  if (!plantedDiffers) pass = false;

  lines.push('', `  SCHEME SELFTEST: ${pass ? 'PASS — each value emits the shape ruling 66 asks for, every planted defect was refused, and the disc/arrow law goes red on a page-following arrow' : 'FAIL'}`);
  return { pass, report: lines.join('\n') };
}

// ---------------------------------------------------------------- main

function main() {
  const target = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  if (!target || has('--help') || has('-h')) {
    console.log(`bbe kit <slug|path-to-pack> [--out <dir>] [--vault <path>] [--verify <css>] [--no-computed] [--selftest] [--scheme light|dark|system]

Emits <slug>-kit.css, fonts.html and tokens.generated.css from a brand pack.
The pack holds the values; this emitter holds the shape. The kit is OUTPUT:
hand-editing a published kit breaks the wire.`);
    process.exit(has('--help') || has('-h') ? 0 : 1);
  }

  const packPath = resolvePack(target, argOf('--vault'));
  if (!packPath) fail(`no pack for "${target}". Pass a path to a .brandpack.json, or --vault <vault root> so <vault>/core/brand-packs/${target}.brandpack.json resolves.`);
  const slug = path.basename(packPath).replace(/\.brandpack\.json$/, '');
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));

  const outDir = path.resolve(argOf('--out') || path.join('dist', 'kit'));
  const built = emitKit(pack, { scheme: argOf('--scheme') });
  fs.mkdirSync(outDir, { recursive: true });
  const files = {
    [`${slug}-kit.css`]: built.css,
    'fonts.html': built.fontsHtml,
    'tokens.generated.css': built.tokensCss
  };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(outDir, name), body);

  console.log(`bbe kit ${slug}`);
  console.log(`  pack   ${packPath}`);
  console.log(`  out    ${outDir}`);
  console.log(`  scheme ${built.scheme}   (from ${built.schemeSource})`);
  for (const [name, body] of Object.entries(files)) {
    console.log(`         ${name.padEnd(22)} ${String(body.split('\n').length - 1).padStart(4)} lines  ${String(Buffer.byteLength(body)).padStart(6)} bytes`);
  }

  const verifyPath = argOf('--verify');
  // Both levels are the acceptance test, so --verify runs both. --no-computed
  // drops to the text diff alone (no browser, e.g. in a hook).
  const wantComputed = (has('--computed') || !!verifyPath) && !has('--no-computed');
  const wantSelftest = has('--selftest');
  let bad = false;

  if (verifyPath || wantComputed || wantSelftest) {
    if (!verifyPath) fail('--computed and --selftest both need --verify <reference css>');
    const targetCss = fs.readFileSync(path.resolve(verifyPath), 'utf8');

    // HALF 1 of the proof. Level 1 always measures the LIGHT emission against the
    // reference, whatever --scheme says, so the reproduction proof never moves.
    const light = built.scheme === 'light' ? built : emitKit(pack, { scheme: 'light' });
    console.log('\n' + '='.repeat(78));
    console.log(`(level 1 measures the LIGHT emission. Emitted scheme: ${built.scheme}.)`);
    const v = verifyLevel1(light.css, targetCss);
    console.log(v.report);
    if (!v.ok) bad = true;

    // HALF 2. What the scheme added to that exact file, and nothing else.
    if (built.scheme !== 'light') {
      console.log('\n' + '='.repeat(78));
      console.log(remapReport(built.remapProof));
      console.log('\n' + '='.repeat(78));
      console.log(splitReport(built.plan));
      console.log('\n' + '='.repeat(78));
      const law = proveDiscArrowLaw(built.plan);
      console.log(law.report);
      if (!law.ok) bad = true;
      console.log('\n' + '='.repeat(78));
      const d = proveSchemeDelta(light.css, built.css, built.scheme, built.remap);
      console.log(d.report);
      if (!d.ok) bad = true;
    }

    console.log('\n' + '='.repeat(78));
    console.log(gapReport(built.gaps));

    if (wantSelftest) {
      console.log('\n' + '='.repeat(78));
      const st = runSelftest(packPath, targetCss);
      console.log(st.report);
      if (!st.pass) bad = true;

      console.log('\n' + '='.repeat(78));
      const ss = runSchemeSelftest(packPath);
      console.log(ss.report);
      if (!ss.pass) bad = true;
    }

    if (wantComputed) {
      console.log('\n' + '='.repeat(78));
      return import('./kit-verify-computed.mjs')
        .then((mod) => mod.run({
          // Level 2's comparison against the reference measures the LIGHT
          // emission, exactly as level 1 does, so the reproduction proof does
          // not move when --scheme does. The effective-scheme file goes in
          // separately and is what the dark half drives.
          emittedCss: light.css,
          targetCss,
          schemeCss: built.scheme === 'light' ? null : built.css,
          model: built.model,
          scheme: built.scheme,
          remap: built.remap ? Object.fromEntries(built.remap) : null,
          // Ruling 69's pairs, handed to the browser so the law is measured a
          // second time by a second instrument. Hover pairs are left out: their
          // disc is a gradient, and the harness does not hover in the dark run.
          discArrow: built.plan
            ? [...new Map(built.plan.discArrow.filter((r) => !r.onGradient)
              .map((r) => [r.discSel, { name: r.discSel.replace(/ \.circ$| \.ico$/, '') || r.discSel, discSel: r.discSel }])).values()]
            : []
        }))
        .then((r) => {
          console.log(r.report);
          process.exit(bad || !r.ok ? 1 : 0);
        })
        .catch((e) => {
          console.error('LEVEL 2 FAILED TO RUN: ' + (e && e.message ? e.message : e));
          process.exit(1);
        });
    }
  } else {
    console.log('\n' + gapReport(built.gaps));
  }
  process.exit(bad ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
