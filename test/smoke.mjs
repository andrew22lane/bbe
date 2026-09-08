#!/usr/bin/env node
// smoke.mjs — scaffold both kinds of surface from the fixture pack, install this
// package into each one, build it, and assert the gate reports ZERO brand hits.
//
//   node test/smoke.mjs            both kinds
//   node test/smoke.mjs --keep     leave the temp dirs behind to poke at
//
// WHY THIS TEST AND NOT A UNIT TEST. `bbe new-surface` has exactly one promise:
// a repo it writes starts at zero drift and stays buildable. The only honest way
// to check that promise is to run the thing end to end and read the gate's own
// number, so that is what this does. It runs in CI on every PR, against a fixture
// pack, because CI cannot see the private vault the real packs live in.
//
// The worker lane deliberately stops at `wrangler deploy --dry-run` when wrangler
// is installed and skips it when it is not, so this test never needs a Cloudflare
// account and never deploys anything.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FIXTURES = path.join(HERE, 'fixtures');
const KEEP = process.argv.includes('--keep');

let failures = 0;
const log = (...a) => console.log(...a);

function run(cmd, args, cwd, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' } });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && !allowFail) {
    log(`    ! ${cmd} ${args.join(' ')} exited ${r.status}`);
    log(out.split('\n').map((l) => `      ${l}`).join('\n'));
  }
  return { status: r.status, out };
}

function check(name, ok, detail = '') {
  log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
}

function lane(kind) {
  log('');
  log(`--- ${kind} ---`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bbe-smoke-${kind}-`));
  const name = `smoke-${kind}`;

  const scaffold = run(process.execPath, [
    path.join(ROOT, 'bin', 'bbe-new-surface'),
    '--pack', 'fixture',
    '--kind', kind,
    '--name', name,
    '--dir', dir,
    '--packs-dir', FIXTURES,
    '--engine', `file:${ROOT}`
  ], ROOT);
  if (!check('scaffolds', scaffold.status === 0)) return dir;

  // Idempotence: a second run into the same dir writes nothing and still exits 0.
  const again = run(process.execPath, [
    path.join(ROOT, 'bin', 'bbe-new-surface'),
    '--pack', 'fixture', '--kind', kind, '--name', name, '--dir', dir,
    '--packs-dir', FIXTURES, '--engine', `file:${ROOT}`
  ], ROOT);
  check('is idempotent', again.status === 0 && /already current|unchanged 1[0-9]/.test(again.out), 'second run wrote nothing');

  const install = run('npm', ['install', '--no-audit', '--no-fund'], dir);
  if (!check('npm install', install.status === 0)) return dir;

  if (kind === 'site') {
    const build = run('npm', ['run', 'build'], dir);
    if (!check('npm run build', build.status === 0)) return dir;
    const html = path.join(dir, 'dist', 'index.html');
    check('wrote dist/index.html', fs.existsSync(html));
    if (fs.existsSync(html)) {
      const s = fs.readFileSync(html, 'utf8');
      check('page carries the pack name', s.includes('Fixture Brand'));
      check('page carries the measured starter roles', s.includes('--bbe-starter-ground:var(--bbe-field)') && s.includes('--bbe-starter-ink:var(--bbe-shadow-deep)'));
      check('no starter role references itself', !/--bbe-([a-z-]+):var\(--bbe-\1\)/.test(s));
      check('nested palette group flattened', s.includes('--bbe-shadow-deep:'));
    }
    // Determinism: two trees, byte-identical.
    run(process.execPath, ['build.mjs'], dir); // warm, OUT defaults to dist
    const a = run('sh', ['-c', 'OUT=dist-a node build.mjs'], dir);
    const b = run('sh', ['-c', 'OUT=dist-b node build.mjs'], dir);
    if (a.status === 0 && b.status === 0) {
      const v = run(process.execPath, [path.join(ROOT, 'tools', 'verify-byte-identity.mjs'), 'dist-a', 'dist-b'], dir);
      check('two builds are byte-identical', v.status === 0 && /IDENTICAL/.test(v.out));
    } else {
      check('two builds are byte-identical', false, 'a build failed');
    }
  } else {
    const tokens = run('npm', ['run', 'tokens'], dir);
    if (!check('npm run tokens', tokens.status === 0)) return dir;
    const gen = path.join(dir, 'src', 'tokens.generated.js');
    check('wrote src/tokens.generated.js', fs.existsSync(gen));
    if (fs.existsSync(gen)) {
      const s = fs.readFileSync(gen, 'utf8');
      check('generated file declares itself GENERATED from a brandpack', /GENERATED/.test(s.slice(0, 400)) && /brandpack/i.test(s.slice(0, 400)));
      check('carries the measured starter roles', s.includes('--bbe-starter-ground:var(--bbe-field)') && s.includes('--bbe-starter-ink:var(--bbe-shadow-deep)'));
      check('no starter role references itself', !/--bbe-([a-z-]+):var\(--bbe-\1\)/.test(s));
      check('exposes the BRAND-layer colour', s.includes('brandOnly'));
      check('exposes the brand name', /"name": "Fixture Brand"/.test(s));
    }
    const hasWrangler = fs.existsSync(path.join(dir, 'node_modules', 'wrangler'));
    if (hasWrangler) {
      const dry = run('npx', ['wrangler', 'deploy', '--dry-run'], dir);
      check('wrangler deploy --dry-run', dry.status === 0);
    } else {
      log('  skip wrangler deploy --dry-run — wrangler not installed in this lane');
    }
  }

  const gate = run(process.execPath, [path.join(ROOT, 'bin', 'bbe-gate')], dir);
  const m = /BRAND hits: (\d+)/.exec(gate.out);
  check('bbe-gate passes', gate.status === 0, gate.out.trim().split('\n').slice(-1)[0]);
  check('bbe-gate reports zero BRAND hits', !!m && m[1] === '0', m ? `${m[1]} hits` : 'no count in output');

  return dir;
}

log(`bbe new-surface smoke test — @andrew22lane/bbe ${JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version}`);

log('');
log('--- the scanner selftest ---');
const st = run(process.execPath, [path.join(ROOT, 'bin', 'bbe-gate'), '--selftest'], ROOT);
check('bbe-gate --selftest', st.status === 0);

log('');
log('--- refusals ---');
const busy = fs.mkdtempSync(path.join(os.tmpdir(), 'bbe-smoke-busy-'));
fs.writeFileSync(path.join(busy, 'somebody-elses-file.txt'), 'do not clobber me\n');
const refused = run(process.execPath, [
  path.join(ROOT, 'bin', 'bbe-new-surface'),
  '--pack', 'fixture', '--kind', 'site', '--name', 'busy', '--dir', busy, '--packs-dir', FIXTURES
], ROOT, { allowFail: true });
check('refuses a non-empty directory', refused.status === 1 && /is not empty/.test(refused.out));
check('and did not write into it', fs.readdirSync(busy).length === 1);
fs.rmSync(busy, { recursive: true, force: true });

const noPack = run(process.execPath, [
  path.join(ROOT, 'bin', 'bbe-new-surface'),
  '--pack', 'no-such-brand', '--kind', 'site', '--name', 'x',
  '--dir', path.join(os.tmpdir(), 'bbe-smoke-nopack'), '--packs-dir', FIXTURES
], ROOT, { allowFail: true });
check('refuses an unknown pack, and lists what it has', noPack.status === 2 && /carries: fixture/.test(noPack.out));

const badKind = run(process.execPath, [
  path.join(ROOT, 'bin', 'bbe-new-surface'),
  '--pack', 'fixture', '--kind', 'lambda', '--name', 'x', '--packs-dir', FIXTURES
], ROOT, { allowFail: true });
check('refuses an unknown --kind', badKind.status === 1 && /must be site or worker/.test(badKind.out));

const dirs = [lane('site'), lane('worker')];

if (!KEEP) for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
else log(`\nkept: ${dirs.join(' ')}`);

log('');
if (failures) {
  log(`SMOKE FAIL — ${failures} check${failures === 1 ? '' : 's'} failed`);
  process.exit(1);
}
log('SMOKE PASS');
process.exit(0);
