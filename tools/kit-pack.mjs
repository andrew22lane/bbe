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
 * Where the kit CSS comes from (kitSource):
 *   "local"              kit.local, a file in this repo (the repo that builds the kit)
 *   "url"                no kit.local, so kit.url is fetched (Node fetch, 10s timeout, redirects
 *                        followed). 20 of 23 consumers link the CDN kit by kit.url only, and
 *                        before v1.8.1 they were all skipped (the v1.8.0 WARN printed on 8 PRs)
 *   "skipped: no kit"    neither is set
 * A failed fetch is a WARN, never a crash and never an exit-code change. BBE_KIT_PACK_OFFLINE=1
 * skips the fetch for air-gapped CI.
 *
 *   import { scanKitPack, scanKitPackAuto } from './kit-pack.mjs';
 *   const r = scanKitPack(repoRoot, config);            // sync, kit.local only
 *   const r = await scanKitPackAuto(repoRoot, config);  // kit.local, else fetch kit.url
 *   // { skipped, kitSource } or { kitNotInPack, paletteNotInKit, paletteSource, kitSource }
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

const FETCH_TIMEOUT_MS = 10_000;

// The comparison itself, on kit CSS text however it was obtained. Returns the report or a
// { skipped } with no kitSource (the caller stamps it).
function compareKitPack(kitText, repoRoot, config) {
  const packPath = path.join(repoRoot, 'brand', `${config.pack}.brandpack.json`);
  if (!existsSync(packPath)) return { skipped: 'no pack mirror' };

  const kit = hexesIn(kitText);
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

// Sync, local kit only. With no kit.local this is { skipped: 'no kit.local' } (kit.url is
// the async path, scanKitPackAuto).
export function scanKitPack(repoRoot, config) {
  const local = config && config.kit && config.kit.local;
  if (!local) return { skipped: 'no kit.local', kitSource: 'skipped: no kit' };
  const kitPath = path.join(repoRoot, local.replace(/^\.?\//, ''));
  if (!existsSync(kitPath)) return { skipped: `kit.local not found: ${local}`, kitSource: 'skipped: no kit' };
  const r = compareKitPack(readFileSync(kitPath, 'utf8'), repoRoot, config);
  return { ...r, kitSource: r.skipped ? 'skipped: no kit' : 'local' };
}

/**
 * kit.local if set, else fetch kit.url and compare the same way.
 *
 * Never throws and never rejects: a fetch failure comes back as
 * { skipped, fetchError, kitSource: 'skipped: fetch failed' } and the gate prints it as
 * `KIT-PACK: could not fetch kit.url (<reason>)`.
 *
 * @param {{timeoutMs?: number, offline?: boolean, fetchImpl?: typeof fetch}} opts
 *   `offline` defaults to BBE_KIT_PACK_OFFLINE=1. `timeoutMs` defaults to 10000.
 */
export async function scanKitPackAuto(repoRoot, config, opts = {}) {
  const kit = (config && config.kit) || {};
  if (kit.local) return scanKitPack(repoRoot, config);
  if (!kit.url) return { skipped: 'no kit.local', kitSource: 'skipped: no kit' };

  const offline = opts.offline ?? process.env.BBE_KIT_PACK_OFFLINE === '1';
  if (offline) return { skipped: 'BBE_KIT_PACK_OFFLINE=1', kitSource: 'skipped: offline' };
  // No pack mirror means there is nothing to compare against, so do not spend a fetch.
  if (!existsSync(path.join(repoRoot, 'brand', `${config.pack}.brandpack.json`))) {
    return { skipped: 'no pack mirror', kitSource: 'skipped: no kit' };
  }

  let css;
  try {
    const doFetch = opts.fetchImpl || fetch;
    const res = await doFetch(kit.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    css = await res.text();
  } catch (err) {
    const name = err && err.name;
    const reason = name === 'TimeoutError' || name === 'AbortError'
      ? 'timed out'
      : String(
          (err && err.cause && (err.cause.code || (err.cause.errors && err.cause.errors[0] && err.cause.errors[0].code) || err.cause.message)) ||
          (err && err.message) || err
        );
    return { skipped: `could not fetch kit.url (${reason})`, fetchError: reason, kitSource: 'skipped: fetch failed' };
  }
  const r = compareKitPack(css, repoRoot, config);
  return { ...r, kitSource: r.skipped ? 'skipped: no kit' : 'url' };
}
