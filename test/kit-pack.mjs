#!/usr/bin/env node
// kit-pack.mjs — tests for tools/kit-pack.mjs, the WARN-tier kit-vs-pack colour check.
//
//   node test/kit-pack.mjs
//
// One fixture repo on the fixture pack, run through bbe-gate end to end:
//   1. control: the kit uses exactly the pack palette -> both lists empty, exit 0
//   2. plant a kit colour the pack does not have, drop a palette colour from the kit ->
//      both are reported, in text and in --json, and the exit code is the SAME as the control
//   3. no kit.local -> kitPack is { skipped: 'no kit.local' }, exit code unchanged
//   4. normalisation: #RGB, #RRGGBBAA and uppercase count as the same colour as 6-digit lowercase

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scanKitPack, normaliseHex6, hexesIn } from '../tools/kit-pack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, '..', 'bin', 'bbe-gate');
let failures = 0;
const probe = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The fixture pack's outputs.web.palette, six colours.
const PALETTE = ['#F4F1EA', '#E4DDCE', '#2F6F62', '#3D8A79', '#14231F', '#2A3C36'];

function repo(kitCss, { withKit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bbe-kit-pack-'));
  mkdirSync(join(dir, 'brand'), { recursive: true });
  mkdirSync(join(dir, 'kit'), { recursive: true });
  copyFileSync(join(HERE, 'fixtures', 'fixture.brandpack.json'), join(dir, 'brand', 'fixture.brandpack.json'));
  // Without kit.local the kit file is not exempt from the hex ratchet, so it carries no hex.
  writeFileSync(join(dir, 'kit', 'fx-kit-v1.css'), withKit ? kitCss : 'body { margin: 0 }\n');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="kit/fx-kit-v1.css"></head><body><p>hi</p></body></html>\n');
  const cfg = { pack: 'fixture', baseline: 0 };
  if (withKit) cfg.kit = { local: 'kit/fx-kit-v1.css' };
  writeFileSync(join(dir, 'bbe.config.json'), JSON.stringify(cfg));
  return dir;
}
const kitOf = (hexes) => `:root {\n${hexes.map((h, i) => `  --c${i}: ${h};`).join('\n')}\n}\n`;
const gate = (dir, ...args) => spawnSync(process.execPath, [GATE, '--repo', dir, ...args], { encoding: 'utf8' });

console.log('\n  kit-pack.mjs — kit colours vs pack\n');

// 1. control
const control = repo(kitOf(PALETTE));
const c = gate(control, '--json');
const cj = JSON.parse(c.stdout);
probe('control: kit uses the whole palette -> nothing not in pack', same(cj.kitPack.kitNotInPack, []));
probe('control: kit uses the whole palette -> nothing not in kit', same(cj.kitPack.paletteNotInKit, []));
probe('control: gate exits 0', c.status === 0);

// 2. planted
const planted = repo(kitOf([...PALETTE.slice(0, 5), '#123456']));
const p = gate(planted, '--json');
const pj = JSON.parse(p.stdout);
probe('planted: the kit colour not in the pack is reported', same(pj.kitPack.kitNotInPack, ['#123456']));
probe('planted: the palette colour not in the kit is reported', same(pj.kitPack.paletteNotInKit, ['#2a3c36']));
probe('planted: exit code is unchanged from the control (WARN only)', p.status === c.status && p.status === 0);
const pt = gate(planted);
probe('planted: text prints "KIT-PACK: 1 kit colours not in pack: #123456"',
  pt.stdout.includes('KIT-PACK: 1 kit colours not in pack: #123456'));
probe('planted: text prints "KIT-PACK: 1 palette colours not in kit: #2a3c36"',
  pt.stdout.includes('KIT-PACK: 1 palette colours not in kit: #2a3c36'));
probe('planted: text run still ends in PASS and exits 0', pt.status === 0 && /\nPASS\n/.test(pt.stdout));

// 3. no kit.local
const noKit = repo(kitOf(PALETTE), { withKit: false });
const n = gate(noKit, '--json');
probe('no kit.local: kitPack is { skipped: "no kit.local" }', same(JSON.parse(n.stdout).kitPack, { skipped: 'no kit.local' }));
probe('no kit.local: exit code unchanged (0)', n.status === 0);

// 4. normalisation
probe('#FFF and #ffffff and #FFFFFFFF are one colour',
  same([...hexesIn('a{color:#FFF} b{color:#ffffff} c{color:#FFFFFFFF}')], ['#ffffff']));
probe('#RGBA drops the alpha: #f00a -> #ff0000', normaliseHex6('#f00a') === '#ff0000');
probe('an id selector like #fade-in is not a colour', hexesIn('#fade-in { top: 0 }').size === 0);
const norm = repo(kitOf(['#f4f1ea', '#E4DDCE', '#2f6f62', '#3d8a79', '#14231f', '#2A3C36CC']));
probe('case and alpha differences do not create false misses',
  same(scanKitPack(norm, { pack: 'fixture', kit: { local: 'kit/fx-kit-v1.css' } }), { kitNotInPack: [], paletteNotInKit: [] }));

console.log(failures ? `\n  KIT-PACK FAIL (${failures})\n` : '\n  KIT-PACK PASS\n');
process.exit(failures ? 1 : 0);
