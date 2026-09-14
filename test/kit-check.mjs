#!/usr/bin/env node
// kit-check.mjs — unit tests for tools/kit-drift.mjs, the ONE-SYSTEM-LAW check.
//
//   node test/kit-check.mjs
//
// Cases 1-6, matching the ones asked for on 2026-09-10:
//   1. kit linked + clean surface css -> zero hits
//   2. a local `.btn` -> fails, with the right line
//   3. the kit link missing entirely -> fails
//   4. a `--foo-`-prefixed token -> passes (not reserved)
//   5. `local` (the repo that BUILDS the kit) -> works, kit file itself exempt
//   6. no kit config at all -> skip, zero hits, zero files checked (the gate's own
//      one-line warning is asserted end to end in test/smoke.mjs, since printing it
//      is bin/bbe-gate's job, not scanKit's)
//
// Cases 7-11, added 2026-09-13 (v1.3.1) after two bex-site workers found the
// link-first check blind to escaped quotes and template variables — fixtures
// copy the real shapes from next-step.mjs and leads-worker/src/render.js:
//   7. escaped double quotes in a plain JS string -> passes (kit linked first)
//   8. single-quoted variable feeding a `${...}` href in a template literal -> passes
//   9. `${KIT}` template variable resolved via a same-file string constant -> passes
//  10. the kit linked, but NOT first -> still a hit
//  11. no kit reference at all -> still a hit
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
  const r = scanKit(fx.dir, { local: 'kit/fixture-kit-v1.css' }, {});
  probe('case 5: local accepted as the link target, kit file itself exempt -> zero hits', r.hits.length === 0);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case 6
{
  const fx = fixture();
  fx.write('index.html', `<!doctype html><html><head>
<link rel="stylesheet" href="/surface.css">
</head><body></body></html>`);
  fx.write('surface.css', `.hero{padding:2rem}\n.btn{background:#fff}\n:root{--primary:#1c5e62}\n`);
  const noConfig = scanKit(fx.dir, null, {});
  probe('case 6a: no kit config -> zero hits (skip, not a scan)', noConfig.hits.length === 0);
  probe('case 6a: no kit config -> zero files checked', noConfig.filesChecked === 0);
  const emptyKit = scanKit(fx.dir, {}, {});
  probe('case 6b: an empty kit object (no url, no local) behaves the same as null', emptyKit.hits.length === 0 && emptyKit.filesChecked === 0);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case 7
// next-step.mjs's real shape: one plain double-quoted JS string, built with
// concatenation, carrying `\"` throughout instead of a bare `"`. The old
// LINK_RX required `rel=` to be followed immediately by a bare quote char, so
// it silently matched nothing here.
{
  const fx = fixture();
  fx.write('next-step.mjs', `const TEMPLATE = "<!doctype html><html lang=\\"en\\"><head>\\n` +
    `<link rel=\\"stylesheet\\" href=\\"${KIT_URL}\\"/><link rel=\\"stylesheet\\" href=\\"/assets/site.css\\"/>\\n` +
    `</head><body></body></html>";\n`);
  const r = scanKit(fx.dir, { url: KIT_URL }, {});
  probe('case 7: escaped double quotes, kit linked first -> zero hits', r.hits.length === 0);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case 8
// A backtick template literal whose href is itself a `${var}` reference, and
// that variable is defined with SINGLE quotes elsewhere in the file — the
// same shape as leads-worker/src/render.js's `export const KIT_PATH =
// '/_kit/bex-kit-v1.css'` feeding `href="${KIT_PATH}"`.
{
  const fx = fixture();
  fx.write('render.js', `export const KIT_PATH = '/_kit/fixture-kit-v1.css';\n` +
    `function head(){\n` +
    `return \`<html><head><link rel="stylesheet" href="\${KIT_PATH}"></head></html>\`;\n` +
    `}\n`);
  const r = scanKit(fx.dir, { url: KIT_URL }, {});
  probe('case 8: single-quoted var feeding a template-literal href -> zero hits', r.hits.length === 0);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case 9
// Same as case 8, named separately per the ask: a bare `${KIT}` template
// variable resolved via its own same-file string assignment, basename-matched
// against kit.local (no CDN url in this file at all — a self-hosted surface).
{
  const fx = fixture();
  fx.write('worker.js', `const KIT = '/_kit/fixture-kit-v1.css';\n` +
    `function page(){\n` +
    `return \`<html><head><link rel='stylesheet' href='\${KIT}'></head></html>\`;\n` +
    `}\n`);
  const r = scanKit(fx.dir, { local: 'kit/fixture-kit-v1.css' }, {});
  probe('case 9: ${KIT} resolved by same-file basename match -> zero hits', r.hits.length === 0);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case 10
// The kit is linked, and resolvable, but NOT first — a real miss, and the
// escaped-quote / template-variable handling must not paper over it.
{
  const fx = fixture();
  fx.write('render.js', `export const KIT_PATH = '/_kit/fixture-kit-v1.css';\n` +
    `function head(){\n` +
    `return \`<html><head><link rel="stylesheet" href="/surface.css"><link rel="stylesheet" href="\${KIT_PATH}"></head></html>\`;\n` +
    `}\n`);
  const r = scanKit(fx.dir, { local: 'kit/fixture-kit-v1.css' }, {});
  const hit = r.hits.find((h) => /not linked FIRST/.test(h.reason));
  probe('case 10: kit resolvable but not first -> still a hit', !!hit);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case 11
// No kit reference anywhere in the file — no literal, no resolvable
// template variable. Still a miss.
{
  const fx = fixture();
  fx.write('page.mjs', `function head(){\n` +
    `return \`<html><head><link rel="stylesheet" href="/surface.css"></head></html>\`;\n` +
    `}\n`);
  const r = scanKit(fx.dir, { url: KIT_URL }, {});
  const hit = r.hits.find((h) => h.file === 'page.mjs');
  probe('case 11: no kit reference at all -> still a hit', !!hit);
  rmSync(fx.dir, { recursive: true, force: true });
}

console.log(`\n  ${failures === 0 ? 'kit-check PASS' : `kit-check FAIL, ${failures} problem(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
