#!/usr/bin/env node
// Emits a tokens.generated.js from a brand pack's outputs.web.
// The pack holds the VALUES and the LINE ORDER (which custom properties share a
// physical source line, in what sequence); this script holds the fixed CSS SHAPE
// (comments, the @media wrapper, indentation depths, the one blank line) because
// that shape is the consumer's own token architecture, not brand data. Run it any
// time the vault pack changes: `npm run tokens`.
//
// Usage:
//   bbe-tokens --pack brand/<slug>.brandpack.json --out src/tokens.generated.js
//
// Both flags resolve against the CURRENT WORKING DIRECTORY, never against this
// file, so the same copy inside node_modules serves every consumer. With no flags
// it discovers exactly one brand/*.brandpack.json under cwd and writes
// src/tokens.generated.js, which is what every consumer already uses.
//
// PACK SHAPE: this reads outputs.web.{palette,dark,lines,scalars,scalarLines,
// darkScalars,darkScalarLines} -- the shape embody-society's pack carries. Two
// other build-tokens variants exist in the estate and are NOT unified here
// because they read different pack shapes and emit different files:
//   hh-calendar   reads named leaves (tokens.color.systemA_*, outputs.web.palette
//                 .purpleMid, outputs.web.palette.legacySystemA.*) and emits a
//                 flat six-key object. No CSS block, no light/dark.
//   dh-library    reads tokens.color.{primary,deep,accent,sand,ink} plus
//                 outputs.web.palette.paper (the two disagree in that pack on
//                 purpose) and emits a flat six-key object.
// Unifying those means changing their output bytes, so they migrate in their own
// pass with their own byte-identity proof. This file is the embody shape.
import fs from 'fs';
import path from 'path';

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function discoverPack() {
  const dir = path.resolve('brand');
  if (!fs.existsSync(dir)) return null;
  const hits = fs.readdirSync(dir).filter((f) => f.endsWith('.brandpack.json'));
  if (hits.length !== 1) return null;
  return path.join('brand', hits[0]);
}

const PACK_REL = argOf('--pack') || discoverPack();
if (!PACK_REL) {
  console.error('FAIL: pass --pack <path to a .brandpack.json>; no single brand/*.brandpack.json found under ' + process.cwd());
  process.exit(1);
}
const OUT_REL = argOf('--out') || path.join('src', 'tokens.generated.js');
const PACK_PATH = path.resolve(PACK_REL);
const OUT_PATH = path.resolve(OUT_REL);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(PACK_PATH)) fail(`pack not found at ${PACK_PATH}`);
const pack = JSON.parse(fs.readFileSync(PACK_PATH, 'utf8'));
const web = pack?.outputs?.web;
if (!web) fail('pack has no outputs.web -- copy the vault pack down first (see tools/pack-parity.mjs)');

const { palette, dark, lines, scalars, scalarLines, darkScalars, darkScalarLines } = web;
for (const key of ['palette', 'dark', 'lines', 'scalars', 'scalarLines', 'darkScalars', 'darkScalarLines']) {
  if (!web[key]) fail(`outputs.web.${key} is missing`);
}

// Build a cssVar -> value lookup for a palette-shaped object (keyed by camelCase name).
function paletteLookup(obj) {
  const m = {};
  for (const [k, leaf] of Object.entries(obj)) {
    if (!leaf?.cssVar || leaf.value === undefined) fail(`palette entry "${k}" is missing cssVar or value`);
    m[k] = { cssVar: leaf.cssVar, value: leaf.value };
  }
  return m;
}

// Build a cssVar -> value lookup for a scalars-shaped array (keyed by cssVar already).
function scalarLookup(arr) {
  const m = {};
  for (const { cssVar, value } of arr) {
    if (!cssVar || value === undefined) fail(`scalar entry is missing cssVar or value: ${JSON.stringify({ cssVar, value })}`);
    m[cssVar] = value;
  }
  return m;
}

function renderPaletteLine(keys, lookup, indent) {
  const parts = keys.map((k) => {
    const entry = lookup[k];
    if (!entry) fail(`no palette value for key "${k}" named in lines`);
    return `${entry.cssVar}:${entry.value}`;
  });
  return `${indent}${parts.join('; ')};\n`;
}

function renderScalarLine(cssVars, lookup, indent) {
  const parts = cssVars.map((v) => {
    if (!(v in lookup)) fail(`no scalar value for "${v}" named in scalarLines`);
    return `${v}:${lookup[v]}`;
  });
  return `${indent}${parts.join('; ')};\n`;
}

const lightLookup = paletteLookup(palette);
const darkLookup = paletteLookup(dark);
const scalarMap = scalarLookup(scalars);
const darkScalarMap = scalarLookup(darkScalars);

// ---- :root{} (light) ----
let lightColour = '';
for (const lineKeys of lines.light) lightColour += renderPaletteLine(lineKeys, lightLookup, '  ');

// scalarLines[0] is the glow line, which sits directly under the colour block
// with NO blank line; every scalar group after it follows one blank line.
let lightScalars = '';
scalarLines.forEach((group, i) => {
  lightScalars += renderScalarLine(group, scalarMap, '  ');
  if (i === 0) lightScalars += '\n';
});

const rootLight = `:root{\n${lightColour}${lightScalars}}\n`;

// ---- dark block body, shared by the @media block and the explicit block ----
function renderDarkBody(indent) {
  let body = '';
  for (const lineKeys of lines.dark) body += renderPaletteLine(lineKeys, darkLookup, indent);
  for (const group of darkScalarLines) body += renderScalarLine(group, darkScalarMap, indent);
  return body;
}

const mediaBlock =
  `/* system preference, unless the reader has explicitly chosen light */\n` +
  `@media (prefers-color-scheme: dark){\n` +
  `  :root:not([data-theme="light"]){\n` +
  renderDarkBody('    ') +
  `  }\n` +
  `}\n`;

const explicitDarkBlock =
  `/* explicit choice always wins, in both directions */\n` +
  `:root[data-theme="dark"]{\n` +
  renderDarkBody('  ') +
  `}\n`;

const TOKENS_CSS = `\n${rootLight}${mediaBlock}${explicitDarkBlock}`;

// Flat name -> value maps for direct JS interpolation (light/dark), built from
// the same palette objects the CSS block above renders from. Keys match the
// pack's own camelCase names (e.g. TOKENS.light.periDeep).
function flatValues(obj) {
  const m = {};
  for (const [k, leaf] of Object.entries(obj)) m[k] = leaf.value;
  return m;
}
const tokensLight = flatValues(palette);
const tokensDark = flatValues(dark);

// pack.tokens.color is the BRAND layer -- a handful of its colours (clay,
// boneSoft, faint) never made it into outputs.web's shipped CSS vars. They are
// still pack-owned values, so expose them under TOKENS.brand rather than
// leaving call sites with a literal the gate can't trace to the pack.
const brandColor = pack?.tokens?.color || {};
const tokensBrand = {};
for (const [k, leaf] of Object.entries(brandColor)) {
  if (leaf?.value !== undefined) tokensBrand[k] = leaf.value;
}

const TOKENS_JSON = JSON.stringify({ light: tokensLight, dark: tokensDark, brand: tokensBrand }, null, 2);

const header = `// GENERATED by tools/build-tokens.mjs from ${PACK_REL} outputs.web.
// Do not edit. Edit the vault pack, copy it down, run npm run tokens.
export const TOKENS_CSS = \`${TOKENS_CSS}\`;

// Flat name -> hex map for direct JS/template interpolation, e.g. TOKENS.light.periDeep.
// TOKENS.brand holds pack.tokens.color values that outputs.web does not carry as CSS vars.
export const TOKENS = ${TOKENS_JSON};
`;

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, header);
console.log(`wrote ${OUT_PATH} (${header.length} bytes)`);
