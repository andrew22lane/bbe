#!/usr/bin/env node
/**
 * kit-pack.mjs: does the kit file use the pack's colours, and does it use all of them?
 *
 * The pack says what the brand's colours are. The kit file (kit.local) is where they get
 * painted. Nothing compared the two, so a kit could carry 20 colours the pack never heard
 * of (measured 2026-09-30: heathers-heroes) and nobody saw it. Two lists:
 *
 *   kitNotInPack     a hex in the kit that appears nowhere in brand/<pack>.brandpack.json
 *   paletteNotInKit  a palette colour the kit never uses. The palette is outputs.web.palette,
 *                   else tokens.color, else every hex in the pack (paletteSource says which)
 *
 * WARN tier. This never changes the exit code. A gate that goes red on routine work gets
 * switched off, so this one reports and stays out of the way.
 *
 * Every colour is normalised to lowercase 6-digit hex. #rgb is expanded, and an alpha
 * byte (#rgba, #rrggbbaa) is dropped, so #FFF8 and #ffffff are the same colour here.
 *
 *   import { scanKitPack } from './kit-pack.mjs';
 *   const r = scanKitPack(repoRoot, config);
 *   // { skipped: 'no kit.local' } or { kitNotInPack, paletteNotInKit, paletteSource }
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Same boundary as brand-drift: not glued onto a word, path or URL run. The trailing
// lookahead stops "#fade-in" or "#abcdefg" from reading as a colour.
const HEX_RX = /(?<![\w/.-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g;
const EXACT_HEX_RX = /^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})$/;

export function normaliseHex6(hex) {
  let body = hex.slice(1).toLowerCase();
  if (body.length <= 4) body = body.split('').map((c) => c + c).join('');
  return '#' + body.slice(0, 6);
}

export function hexesIn(text) {
  const out = new Set();
  for (const m of text.matchAll(HEX_RX)) out.add(normaliseHex6(m[0]));
  return out;
}

// Every hex string anywhere under outputs.web.palette (flat values, { value } leaves, and
// nested groups). Keys starting "_" and "evidence" are notes, not colours.
function paletteHexes(node, out = new Set()) {
  if (typeof node === 'string') {
    if (EXACT_HEX_RX.test(node.trim())) out.add(normaliseHex6(node.trim()));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('_') || k === 'evidence') continue;
    paletteHexes(v, out);
  }
  return out;
}

export function scanKitPack(repoRoot, config) {
  const local = config && config.kit && config.kit.local;
  if (!local) return { skipped: 'no kit.local' };
  const kitPath = path.join(repoRoot, local.replace(/^\.?\//, ''));
  if (!existsSync(kitPath)) return { skipped: `kit.local not found: ${local}` };
  const packPath = path.join(repoRoot, 'brand', `${config.pack}.brandpack.json`);
  if (!existsSync(packPath)) return { skipped: 'no pack mirror' };

  const kit = hexesIn(readFileSync(kitPath, 'utf8'));
  const packText = readFileSync(packPath, 'utf8');
  const packAll = hexesIn(packText);
  // Only 3 of the 9 real packs carry outputs.web.palette, so fall back: tokens.color,
  // then every hex anywhere in the pack. A source that holds no colour is skipped.
  let palette = new Set();
  let paletteSource = null;
  try {
    const pack = JSON.parse(packText);
    for (const [name, node] of [['outputs.web.palette', pack?.outputs?.web?.palette], ['tokens.color', pack?.tokens?.color]]) {
      const found = paletteHexes(node);
      if (found.size) { palette = found; paletteSource = name; break; }
    }
  } catch { return { skipped: 'pack is not valid JSON' }; }
  if (!paletteSource) { palette = packAll; paletteSource = 'any hex in pack'; }

  return {
    kitNotInPack: [...kit].filter((h) => !packAll.has(h)).sort(),
    paletteNotInKit: [...palette].filter((h) => !kit.has(h)).sort(),
    paletteSource
  };
}
