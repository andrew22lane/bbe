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
  check('bbe-gate read bbe.config.json, not a legacy baseline file', /config\s+bbe\.config\.json/.test(gate.out));
  check('the scaffold wrote no tools/brand-gate-baseline.json', !fs.existsSync(path.join(dir, 'tools', 'brand-gate-baseline.json')));
  check('the scaffold vendored no gate code', !fs.existsSync(path.join(dir, 'tools', 'brand-drift.mjs')) && !fs.existsSync(path.join(dir, 'tools', 'gate-parity.mjs')));

  const wf = path.join(dir, '.github', 'workflows', 'brand-gate.yml');
  check('the workflow calls the reusable gate, pinned', fs.existsSync(wf)
    && new RegExp(`uses: andrew22lane/bbe/\\.github/workflows/bbe-gate\\.yml@v${PKG_VERSION.replace(/\./g, '\\.')}`).test(fs.readFileSync(wf, 'utf8')));

  gateConfigChecks(dir);

  return dir;
}

const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// ---------------------------------------------------------------- the gate's config
// bbe.config.json is the ONE file that configures the gate. These assert the contract
// a migrating repo is told to rely on in docs/MIGRATE-GATE.md: the ratchet fails on a
// rise, --write-baseline only lowers, "exclude" is additive, and a repo still carrying
// the old tools/brand-gate-baseline.json keeps gating instead of going dark.
function gateConfigChecks(dir) {
  const cfgPath = path.join(dir, 'bbe.config.json');
  const original = fs.readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(original);
  check('bbe.config.json holds pack, exclude and baseline', cfg.pack === 'fixture' && Array.isArray(cfg.exclude) && cfg.baseline === 0);

  // A planted brand hex must go RED against a baseline of 0.
  const packColour = JSON.parse(fs.readFileSync(path.join(dir, 'brand', 'fixture.brandpack.json'), 'utf8'));
  const firstHex = JSON.stringify(packColour).match(/#[0-9a-fA-F]{6}/)[0];
  fs.mkdirSync(path.join(dir, 'scratch'), { recursive: true });
  const planted = path.join(dir, 'scratch', 'planted.css');
  fs.writeFileSync(planted, `.planted{color:${firstHex}}\n`);
  const red = run(process.execPath, [path.join(ROOT, 'bin', 'bbe-gate')], dir, { allowFail: true });
  check('a planted brand hex fails the ratchet', red.status === 1 && /count rose from 0 to 1/.test(red.out));

  // --write-baseline refuses to raise.
  const refuse = run(process.execPath, [path.join(ROOT, 'bin', 'bbe-gate'), '--write-baseline'], dir, { allowFail: true });
  check('--write-baseline refuses to raise the baseline', refuse.status === 1 && /refusing to RAISE/.test(refuse.out));
  check('and left bbe.config.json alone', fs.readFileSync(cfgPath, 'utf8') === original);

  // "exclude" is additive: name the planted file's directory and the hit disappears,
  // while every default exclusion is still in force.
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, exclude: ['scratch'] }, null, 2) + '\n');
  const excluded = run(process.execPath, [path.join(ROOT, 'bin', 'bbe-gate')], dir);
  check('"exclude" is additive to the defaults', excluded.status === 0 && /BRAND hits: 0/.test(excluded.out));
  check('and the gate is not blind', !/scanned {6}0 of/.test(excluded.out));

  // Back to a clean tree for the rest.
  fs.rmSync(path.join(dir, 'scratch'), { recursive: true, force: true });

  // --write-baseline lowers.
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, baseline: 7 }, null, 2) + '\n');
  const lower = run(process.execPath, [path.join(ROOT, 'bin', 'bbe-gate'), '--write-baseline'], dir);
  check('--write-baseline lowers the baseline', lower.status === 0 && JSON.parse(fs.readFileSync(cfgPath, 'utf8')).baseline === 0);

  // --json is machine-readable and agrees with the human output.
  fs.writeFileSync(cfgPath, original);
  const j = run(process.execPath, [path.join(ROOT, 'bin', 'bbe-gate'), '--json'], dir);
  let parsed = null;
  try { parsed = JSON.parse(j.out); } catch {}
  check('--json parses and reports the same zero', !!parsed && parsed.ok === true && parsed.brand === 0 && parsed.pack === 'fixture');
  check('--json names the excludes it used', !!parsed && parsed.exclude.includes('tools') && parsed.exclude.includes('node_modules'));

  // Legacy fallback: a repo that has not migrated still gates instead of going dark.
  fs.rmSync(cfgPath);
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools', 'brand-gate-baseline.json'), JSON.stringify({ pack: 'fixture', brand_count: 0 }, null, 2));
  const legacy = run(process.execPath, [path.join(ROOT, 'bin', 'bbe-gate')], dir);
  check('a pre-v1.2.0 repo still gates off tools/brand-gate-baseline.json', legacy.status === 0 && /legacy/.test(legacy.out) && /BRAND hits: 0/.test(legacy.out));
  fs.rmSync(path.join(dir, 'tools', 'brand-gate-baseline.json'));

  // No config at all is a hard stop, never a silent pass.
  const noCfg = run(process.execPath, [path.join(ROOT, 'bin', 'bbe-gate')], dir, { allowFail: true });
  check('no config at all exits 2, never a silent pass', noCfg.status === 2 && /no bbe\.config\.json/.test(noCfg.out));
  fs.writeFileSync(cfgPath, original);
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
