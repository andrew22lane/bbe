#!/usr/bin/env node
// gate-exclude.mjs: unit tests for tools/gate-exclude.mjs, the ONE exclude list.
//
//   node test/gate-exclude.mjs
//
// Why: the nightly estate job and bbe-gate each built their own exclude list, and on the
// same trees CI read 0 hits while the nightly read 154 (7 of 18 surfaces falsely in
// RATCHET BREACH for 19 days, TQ-101). Both now call effectiveExclude().
//
//   1. a config with exclude, kit.local and buildDir: every piece present, in the old order
//   2. a config with none of them: DEFAULT_EXCLUDE + tools, nothing else
//   3. kit.local spelled "./kit/x.css" and "/kit/x.css" both lose the leading "./" or "/"
//   4. an invalid buildDir adds nothing and does not throw (bbe-gate itself exits 2 on it)
//   5. bbe-gate --json reports exactly effectiveExclude()'s list (the gate uses this function)

import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DEFAULT_EXCLUDE } from '../tools/brand-drift.mjs';
import { effectiveExclude, EXTRA_EXCLUDE } from '../tools/gate-exclude.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const probe = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('\n  gate-exclude.mjs: effectiveExclude\n');

const repoRoot = mkdtempSync(join(tmpdir(), 'bbe-gate-exclude-'));

// 1. everything set. The expected list is the inline expression bbe-gate used before v1.8.0.
const full = { exclude: ['data', 'legacy/old'], kit: { local: './kit/x-kit-v1.css' }, buildDir: './dist-site/' };
const oldInline = [...DEFAULT_EXCLUDE, 'tools', 'data', 'legacy/old', 'kit/x-kit-v1.css', 'dist-site'];
const got = effectiveExclude({ repoRoot, config: full });
probe('EXTRA_EXCLUDE is exactly ["tools"]', same(EXTRA_EXCLUDE, ['tools']));
probe('all four pieces present: tools, config.exclude, kit.local, buildDir',
  ['tools', 'data', 'legacy/old', 'kit/x-kit-v1.css', 'dist-site'].every((e) => got.includes(e)));
probe('order matches the old inline list', same(got, oldInline));
probe('config.exclude is additive: DEFAULT_EXCLUDE is still the head of the list',
  same(got.slice(0, DEFAULT_EXCLUDE.length), DEFAULT_EXCLUDE));

// 2. nothing set
probe('no exclude, no kit, no buildDir: DEFAULT + tools, nothing else',
  same(effectiveExclude({ repoRoot, config: { pack: 'x', baseline: 0 } }), [...DEFAULT_EXCLUDE, 'tools']));
probe('a null config does not throw and gives DEFAULT + tools',
  same(effectiveExclude({ repoRoot, config: null }), [...DEFAULT_EXCLUDE, 'tools']));

// 3. kit.local spellings
probe('kit.local "/kit/x.css" loses the leading slash',
  effectiveExclude({ repoRoot, config: { kit: { local: '/kit/x.css' } } }).at(-1) === 'kit/x.css');
probe('a kit with only a url adds nothing',
  same(effectiveExclude({ repoRoot, config: { kit: { url: 'https://example.test/k.css' } } }), [...DEFAULT_EXCLUDE, 'tools']));

// 4. buildDir that is not inside the repo
for (const bad of ['..', '../out', '.', '/abs/dist', 42]) {
  let list = null;
  try { list = effectiveExclude({ repoRoot, config: { buildDir: bad } }); } catch { /* fall through */ }
  probe(`invalid buildDir ${JSON.stringify(bad)} adds nothing and does not throw`,
    list !== null && same(list, [...DEFAULT_EXCLUDE, 'tools']));
}

// 5. the gate reports the same list
const dir = mkdtempSync(join(tmpdir(), 'bbe-gate-exclude-e2e-'));
mkdirSync(join(dir, 'brand'), { recursive: true });
mkdirSync(join(dir, 'src'), { recursive: true });
mkdirSync(join(dir, 'kit'), { recursive: true });
mkdirSync(join(dir, 'dist'), { recursive: true });
copyFileSync(join(HERE, 'fixtures', 'fixture.brandpack.json'), join(dir, 'brand', 'fixture.brandpack.json'));
writeFileSync(join(dir, 'src', 'a.css'), '.a { margin: 0 }\n');
writeFileSync(join(dir, 'kit', 'fx-kit.css'), ':root { --x: #2F6F62 }\n');
writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html><link rel="stylesheet" href="../kit/fx-kit.css">\n');
const cfg = { pack: 'fixture', baseline: 0, exclude: ['data'], buildDir: 'dist', kit: { local: './kit/fx-kit.css' } };
writeFileSync(join(dir, 'bbe.config.json'), JSON.stringify(cfg));
const r = spawnSync(process.execPath, [join(HERE, '..', 'bin', 'bbe-gate'), '--repo', dir, '--json'], { encoding: 'utf8' });
let json = null;
try { json = JSON.parse(r.stdout); } catch { /* json stays null */ }
probe('bbe-gate --json runs on a config with exclude, kit.local and buildDir', json !== null);
probe('bbe-gate --json "exclude" equals effectiveExclude() for the same repo and config',
  json !== null && same(json.exclude, effectiveExclude({ repoRoot: dir, config: cfg })));

console.log(failures ? `\n  GATE-EXCLUDE FAIL (${failures})\n` : '\n  GATE-EXCLUDE PASS\n');
process.exit(failures ? 1 : 0);
