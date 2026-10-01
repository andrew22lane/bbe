#!/usr/bin/env node
// kit-pack.mjs: tests for tools/kit-pack.mjs, the WARN-tier kit-vs-pack colour check.
//
//   node test/kit-pack.mjs
//
// One fixture repo on the fixture pack, run through bbe-gate end to end:
//   1. control: the kit uses exactly the pack palette -> both lists empty, exit 0
//   2. plant a kit colour the pack does not have, drop a palette colour from the kit ->
//      both are reported, in text and in --json, and the exit code is the SAME as the control
//   3. no kit.local -> kitPack is { skipped: 'no kit.local' }, exit code unchanged
//   5. a pack with no outputs.web.palette: the palette side falls back to tokens.color,
//      then to every hex in the pack, and paletteSource says which
//   4. normalisation: #RGB, #RRGGBBAA and uppercase count as the same colour as 6-digit lowercase
//   6. v1.8.1, no kit.local but kit.url: the kit is fetched (a tiny node:http server on
//      127.0.0.1, so no network) and compared the same way. kitSource is "local", "url" or
//      "skipped: no kit". A failed fetch (404, refused, timeout) is a WARN line and the exit
//      code does not change. BBE_KIT_PACK_OFFLINE=1 skips the fetch.

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { scanKitPack, scanKitPackAuto, normaliseHex6, hexesIn } from '../tools/kit-pack.mjs';

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

console.log('\n  kit-pack.mjs: kit colours vs pack\n');

// 1. control
const control = repo(kitOf(PALETTE));
const c = gate(control, '--json');
const cj = JSON.parse(c.stdout);
probe('control: kit uses the whole palette -> nothing not in pack', same(cj.kitPack.kitNotInPack, []));
probe('control: kit uses the whole palette -> nothing not in kit', same(cj.kitPack.paletteNotInKit, []));
probe('control: gate exits 0', c.status === 0);
probe('control: kitSource is "local"', cj.kitPack.kitSource === 'local');

// 2. planted
const planted = repo(kitOf([...PALETTE.slice(0, 5), '#123456']));
const p = gate(planted, '--json');
const pj = JSON.parse(p.stdout);
probe('planted: the kit colour not in the pack is reported', same(pj.kitPack.kitNotInPack, ['#123456']));
probe('planted: the palette colour not in the kit is reported', same(pj.kitPack.paletteNotInKit, ['#2a3c36']));
probe('planted: --json records kitPack.paletteSource = outputs.web.palette', pj.kitPack.paletteSource === 'outputs.web.palette');
probe('planted: exit code is unchanged from the control (WARN only)', p.status === c.status && p.status === 0);
const pt = gate(planted);
probe('planted: text prints "KIT-PACK: 1 kit colours not in pack: #123456"',
  pt.stdout.includes('KIT-PACK: 1 kit colours not in pack: #123456'));
probe('planted: text prints "KIT-PACK: 1 palette colours not in kit (palette: outputs.web.palette): #2a3c36"',
  pt.stdout.includes('KIT-PACK: 1 palette colours not in kit (palette: outputs.web.palette): #2a3c36'));
probe('planted: text run still ends in PASS and exits 0', pt.status === 0 && /\nPASS\n/.test(pt.stdout));

// 3. no kit.local
const noKit = repo(kitOf(PALETTE), { withKit: false });
const n = gate(noKit, '--json');
probe('no kit.local, no kit.url: kitPack is skipped with kitSource "skipped: no kit"',
  same(JSON.parse(n.stdout).kitPack, { skipped: 'no kit.local', kitSource: 'skipped: no kit' }));
probe('no kit.local: exit code unchanged (0)', n.status === 0);

// 4. normalisation
probe('#FFF and #ffffff and #FFFFFFFF are one colour',
  same([...hexesIn('a{color:#FFF} b{color:#ffffff} c{color:#FFFFFFFF}')], ['#ffffff']));
probe('#RGBA drops the alpha: #f00a -> #ff0000', normaliseHex6('#f00a') === '#ff0000');
probe('an id selector like #fade-in is not a colour', hexesIn('#fade-in { top: 0 }').size === 0);
const norm = repo(kitOf(['#f4f1ea', '#E4DDCE', '#2f6f62', '#3d8a79', '#14231f', '#2A3C36CC']));
const normR = scanKitPack(norm, { pack: 'fixture', kit: { local: 'kit/fx-kit-v1.css' } });
probe('case and alpha differences do not create false misses',
  same(normR.kitNotInPack, []) && same(normR.paletteNotInKit, []));

// 5. palette fallback: a pack with no outputs.web.palette (6 of the 9 real packs)
const fb = repo(kitOf(['#123456']));
const fbPack = JSON.parse(readFileSync(join(fb, 'brand', 'fixture.brandpack.json'), 'utf8'));
delete fbPack.outputs.web.palette;   // tokens.color.brandOnly (#4A2E8F) is all that is left
writeFileSync(join(fb, 'brand', 'fixture.brandpack.json'), JSON.stringify(fbPack));
const fbr = scanKitPack(fb, { pack: 'fixture', kit: { local: 'kit/fx-kit-v1.css' } });
probe('no outputs.web.palette: falls back to tokens.color', fbr.paletteSource === 'tokens.color');
probe('no outputs.web.palette: the tokens.color colour the kit lacks is reported', same(fbr.paletteNotInKit, ['#4a2e8f']));
writeFileSync(join(fb, 'kit', 'fx-kit-v1.css'), kitOf(['#4A2E8F']));
probe('tokens.color fallback: a kit that uses it reports none missing',
  same(scanKitPack(fb, { pack: 'fixture', kit: { local: 'kit/fx-kit-v1.css' } }).paletteNotInKit, []));
delete fbPack.tokens;                // now only identity.themeColor and the kit block hold a hex
writeFileSync(join(fb, 'brand', 'fixture.brandpack.json'), JSON.stringify(fbPack));
const anyHex = scanKitPack(fb, { pack: 'fixture', kit: { local: 'kit/fx-kit-v1.css' } });
probe('no palette, no tokens.color: falls back to every hex in the pack', anyHex.paletteSource === 'any hex in pack');
probe('any-hex fallback reads identity.themeColor (#2f6f62) as a palette colour', anyHex.paletteNotInKit.includes('#2f6f62'));

// 6. kit.url, no kit.local: fetched from a local http server (no network needed)
const asyncGate = (dir, args = [], env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [GATE, '--repo', dir, ...args], { env: { ...process.env, ...env } });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.on('close', (status) => resolve({ status, stdout }));
});
function urlRepo(kitUrl) {
  const dir = repo('', { withKit: false });
  writeFileSync(join(dir, 'kit', 'fx-kit-v1.css'), '.fx { margin: 0 }\n');   // the repo has no kit of its own; keep the stub off reserved selectors
  writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><link rel="stylesheet" href="${kitUrl}"></head><body><p>hi</p></body></html>\n`);
  writeFileSync(join(dir, 'bbe.config.json'), JSON.stringify({ pack: 'fixture', baseline: 0, kit: { url: kitUrl } }));
  return dir;
}
let served = 0;
const server = createServer((req, res) => {
  if (req.url === '/hang.css') return;                      // never answers: the timeout case
  served++;
  if (req.url === '/redir.css') { res.writeHead(302, { location: '/kit.css' }); return res.end(); }
  if (req.url === '/kit.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end(kitOf([...PALETTE.slice(0, 5), '#123456'])); }
  res.writeHead(404); res.end('nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const u = await asyncGate(urlRepo(`${base}/kit.css`), ['--json']);
const uj = JSON.parse(u.stdout);
probe('kit.url: kitSource is "url"', uj.kitPack.kitSource === 'url');
probe('kit.url: the fetched kit colour not in the pack is reported', same(uj.kitPack.kitNotInPack, ['#123456']));
probe('kit.url: the palette colour the fetched kit lacks is reported', same(uj.kitPack.paletteNotInKit, ['#2a3c36']));
probe('kit.url: exit code is 0 (WARN only)', u.status === 0);
const ut = await asyncGate(urlRepo(`${base}/kit.css`));
probe('kit.url: text prints the same KIT-PACK line as the local path',
  ut.stdout.includes('KIT-PACK: 1 kit colours not in pack: #123456') && ut.stdout.includes('fetched from kit.url'));

const rd = await asyncGate(urlRepo(`${base}/redir.css`), ['--json']);
probe('kit.url: a 302 redirect is followed', JSON.parse(rd.stdout).kitPack.kitSource === 'url');

const nf = await asyncGate(urlRepo(`${base}/missing.css`), ['--json']);
const nfj = JSON.parse(nf.stdout);
probe('fetch 404: kitPack is skipped, kitSource "skipped: fetch failed", fetchError "HTTP 404"',
  nfj.kitPack.kitSource === 'skipped: fetch failed' && nfj.kitPack.fetchError === 'HTTP 404');
probe('fetch 404: exit code unchanged (0)', nf.status === 0);
const nft = await asyncGate(urlRepo(`${base}/missing.css`));
probe('fetch 404: text prints "KIT-PACK: could not fetch kit.url (HTTP 404)" and still PASSes',
  nft.stdout.includes('KIT-PACK: could not fetch kit.url (HTTP 404)') && /\nPASS\n/.test(nft.stdout));

const before = served;
const off = await asyncGate(urlRepo(`${base}/kit.css`), ['--json'], { BBE_KIT_PACK_OFFLINE: '1' });
probe('BBE_KIT_PACK_OFFLINE=1: no fetch is made', served === before);
probe('BBE_KIT_PACK_OFFLINE=1: kitPack is skipped, exit code unchanged',
  JSON.parse(off.stdout).kitPack.skipped === 'BBE_KIT_PACK_OFFLINE=1' && off.status === 0);

const hang = await scanKitPackAuto(urlRepo(`${base}/hang.css`), { pack: 'fixture', kit: { url: `${base}/hang.css` } }, { timeoutMs: 300 });
probe('timeout: a server that never answers gives "timed out", no crash', hang.fetchError === 'timed out' && hang.kitSource === 'skipped: fetch failed');

const closed = createServer(); await new Promise((r) => closed.listen(0, '127.0.0.1', r));
const deadUrl = `http://127.0.0.1:${closed.address().port}/kit.css`;
await new Promise((r) => closed.close(r));
const dead = await asyncGate(urlRepo(deadUrl));
probe('connection refused: WARN line names the reason, exit code 0',
  /KIT-PACK: could not fetch kit\.url \(.+\)/.test(dead.stdout) && dead.status === 0);

// kit.local wins when both are set, and the server is not asked.
const bothDir = repo(kitOf(PALETTE));
writeFileSync(join(bothDir, 'bbe.config.json'), JSON.stringify({ pack: 'fixture', baseline: 0, kit: { local: 'kit/fx-kit-v1.css', url: `${base}/kit.css` } }));
const beforeBoth = served;
const both = await scanKitPackAuto(bothDir, JSON.parse(readFileSync(join(bothDir, 'bbe.config.json'), 'utf8')));
probe('kit.local and kit.url both set: local wins, kitSource "local", no fetch', both.kitSource === 'local' && served === beforeBoth);
server.close();

console.log(failures ? `\n  KIT-PACK FAIL (${failures})\n` : '\n  KIT-PACK PASS\n');
process.exit(failures ? 1 : 0);
