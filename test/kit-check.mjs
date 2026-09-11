#!/usr/bin/env node
// kit-check.mjs — unit tests for tools/kit-drift.mjs, the ONE-SYSTEM-LAW check.
//
//   node test/kit-check.mjs
//
// Five cases, matching the ones asked for on 2026-09-10:
//   1. kit linked + clean surface css -> zero hits
//   2. a local `.btn` -> fails, with the right line
//   3. the kit link missing entirely -> fails
//   4. a `--foo-`-prefixed token -> passes (not reserved)
//   5. `kitLocal` (the repo that BUILDS the kit) -> works, kit file itself exempt
//
// Same shape as brand-drift.mjs's own selftest: build a throwaway fixture repo,
// call the scanner directly, assert on its return value. No CLI, no gate — that
// end-to-end path is what test/smoke.mjs covers.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { scanKit } from '../tools/kit-drift.mjs';

let failures = 0;
const probe = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bbe-kit-check-'));
  return {
    dir,
    write(rel, content) {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
      return p;
    }
  };
}

const KIT_URL = 'https://cdn.brandbuilderengine.com/fixture/kit/fixture-kit-v1.css';

console.log('\n  kit-drift.mjs — kit-check\n');

// ------------------------------------------------------------------ case 1
{
  const fx = fixture();
  fx.write('index.html', `<!doctype html><html><head>
<link rel="stylesheet" href="${KIT_URL}">
<link rel="stylesheet" href="/surface.css">
</head><body></body></html>`);
  fx.write('surface.css', `/* Surface-specific rules only. */
.hero{padding:2rem}
.hero-cta{color:var(--bbe-fixture-accent)}
`);
  const r = scanKit(fx.dir, { url: KIT_URL }, {});
  probe('case 1: kit linked first + clean surface css -> zero hits', r.hits.length === 0);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case 2
{
  const fx = fixture();
  fx.write('index.html', `<!doctype html><html><head>
<link rel="stylesheet" href="${KIT_URL}">
</head><body></body></html>`);
  fx.write('surface.css', `.hero{padding:2rem}
.btn{background:#fff;border-radius:.4rem}
`);
  const r = scanKit(fx.dir, { url: KIT_URL }, {});
  const hit = r.hits.find((h) => h.reason.includes('.btn'));
  probe('case 2: a local .btn is flagged', !!hit);
  probe('case 2: flagged on the right line (line 2 of surface.css)', hit && hit.file === 'surface.css' && hit.line === 2);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case 3
{
  const fx = fixture();
  fx.write('index.html', `<!doctype html><html><head>
<link rel="stylesheet" href="/surface.css">
</head><body></body></html>`);
  fx.write('surface.css', `.hero{padding:2rem}\n`);
  const r = scanKit(fx.dir, { url: KIT_URL }, {});
  const hit = r.hits.find((h) => h.file === 'index.html');
  probe('case 3: missing kit link is flagged on index.html', !!hit);
  probe('case 3: reason names the miss', hit && /does not link the kit|kit not linked/.test(hit.reason));
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case 4
{
  const fx = fixture();
  fx.write('index.html', `<!doctype html><html><head>
<link rel="stylesheet" href="${KIT_URL}">
</head><body></body></html>`);
  fx.write('surface.css', `:root{--foo-primary:#1c5e62;--foo-accent:#e2b400}
.foo-hero{color:var(--foo-primary)}
`);
  const r = scanKit(fx.dir, { url: KIT_URL }, {});
  probe('case 4: --foo-primary (prefixed, not reserved) passes clean', r.hits.length === 0);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case 5
{
  const fx = fixture();
  // The repo that BUILDS the kit: its own pages reference it by a local path,
  // and the kit source file itself is exempt from the reserved-token check —
  // it IS the kit, so it is allowed to define --primary, .btn, @font-face.
  fx.write('kit/fixture-kit-v1.css', `:root{--primary:#1c5e62;--ink:#2e2e2d}
@font-face{font-family:Foo;src:url(foo.woff2)}
.btn{padding:.6rem 1rem;border-radius:.4rem}
`);
  fx.write('index.html', `<!doctype html><html><head>
<link rel="stylesheet" href="/kit/fixture-kit-v1.css">
</head><body></body></html>`);
  fx.write('surface.css', `.hero{padding:2rem}\n`);
  const r = scanKit(fx.dir, { kitLocal: 'kit/fixture-kit-v1.css' }, {});
  probe('case 5: kitLocal accepted as the link target, kit file itself exempt -> zero hits', r.hits.length === 0);
  rmSync(fx.dir, { recursive: true, force: true });
}

console.log(`\n  ${failures === 0 ? 'kit-check PASS' : `kit-check FAIL, ${failures} problem(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
