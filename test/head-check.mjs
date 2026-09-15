#!/usr/bin/env node
// head-check.mjs — unit tests for tools/head-check.mjs, the 2026-09-15 rule:
// "same favicon should be used for all pages created, and a default branded
// share image must be auto set up for all pages made."
//
//   node test/head-check.mjs
//
// Cases (a)-(g), the exact set asked for on 2026-09-15:
//   a. no favicon/ogImage keys -> passes (skip: zero hits, zero files checked)
//   b. keys set, compliant page -> pass
//   c. missing rel=icon -> fail
//   d. wrong favicon href -> fail
//   e. missing og:image -> fail
//   f. page-specific og:image different from kit.ogImage -> PASS
//   g. favicon inside a JS template string (worker-rendered page) -> detected as present
//
// Same shape as kit-check.mjs: build a throwaway fixture repo, call the
// scanner directly, assert on its return value. The gate's own CLI wiring
// (bin/bbe-gate reading bbe.config.json's kit.favicon/kit.ogImage, printing
// "head check ..." and "HEAD: ..." lines) is covered end to end in
// test/smoke.mjs's headEndToEndCheck(), the same split kit-drift.mjs and
// kit-check.mjs use.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { scanHead } from '../tools/head-check.mjs';

let failures = 0;
const probe = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bbe-head-check-'));
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

const FAVICON = 'https://cdn.brandbuilderengine.com/designhacker/brand/identity-2026/favicon/favicon.svg';
const OG_IMAGE = 'https://cdn.brandbuilderengine.com/designhacker/brand/kit/dh-og-default.jpg';

const COMPLIANT_HEAD = `<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<meta property="og:image" content="${OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">`;

console.log('\n  head-check.mjs — head-check\n');

// ------------------------------------------------------------------ case a
{
  const fx = fixture();
  fx.write('index.html', `<!doctype html><html><head>\n${COMPLIANT_HEAD}\n</head><body></body></html>`);
  const noKeys = scanHead(fx.dir, { url: 'https://cdn.example.test/fixture-kit-v1.css' }, {});
  probe('case a: no favicon/ogImage keys -> zero hits (skip, not a scan)', noKeys.hits.length === 0);
  probe('case a: no favicon/ogImage keys -> zero files checked', noKeys.filesChecked === 0);
  const noKit = scanHead(fx.dir, null, {});
  probe('case a: no "kit" object at all -> same skip', noKit.hits.length === 0 && noKit.filesChecked === 0);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case b
{
  const fx = fixture();
  fx.write('index.html', `<!doctype html><html><head>\n${COMPLIANT_HEAD}\n</head><body></body></html>`);
  const r = scanHead(fx.dir, { favicon: FAVICON, ogImage: OG_IMAGE }, {});
  probe('case b: keys set, compliant page -> zero hits', r.hits.length === 0);
  probe('case b: one page checked', r.filesChecked === 1);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case c
{
  const fx = fixture();
  fx.write('index.html', `<!doctype html><html><head>
<meta property="og:image" content="${OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">
</head><body></body></html>`);
  const r = scanHead(fx.dir, { favicon: FAVICON, ogImage: OG_IMAGE }, {});
  const hit = r.hits.find((h) => h.reason === 'missing rel=icon');
  probe('case c: missing rel=icon -> a hit', !!hit);
  probe('case c: flagged on index.html', hit && hit.file === 'index.html');
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case d
{
  const fx = fixture();
  fx.write('index.html', `<!doctype html><html><head>
<link rel="icon" type="image/svg+xml" href="https://cdn.brandbuilderengine.com/some-other-brand/favicon.svg">
<meta property="og:image" content="${OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">
</head><body></body></html>`);
  const r = scanHead(fx.dir, { favicon: FAVICON, ogImage: OG_IMAGE }, {});
  const hit = r.hits.find((h) => /!= kit\.favicon/.test(h.reason));
  probe('case d: wrong favicon href -> a hit', !!hit);
  probe('case d: reason names the found href', hit && hit.reason.includes('some-other-brand'));
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case e
{
  const fx = fixture();
  fx.write('index.html', `<!doctype html><html><head>
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<meta name="twitter:card" content="summary_large_image">
</head><body></body></html>`);
  const r = scanHead(fx.dir, { favicon: FAVICON, ogImage: OG_IMAGE }, {});
  const hit = r.hits.find((h) => h.reason === 'missing og:image');
  probe('case e: missing og:image -> a hit', !!hit);
  probe('case e: favicon (present + correct) does not also fail', !r.hits.some((h) => /favicon|rel=icon/.test(h.reason)));
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case f
// A page-specific share image — a blog post's own card, say — is allowed to
// override the brand default. The VALUE is never compared to kit.ogImage,
// only its presence, so a different (but non-empty) og:image passes clean.
{
  const fx = fixture();
  const PAGE_OG_IMAGE = 'https://cdn.brandbuilderengine.com/designhacker/blog/some-post/card.jpg';
  fx.write('post.html', `<!doctype html><html><head>
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<meta property="og:image" content="${PAGE_OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">
</head><body></body></html>`);
  const r = scanHead(fx.dir, { favicon: FAVICON, ogImage: OG_IMAGE }, {});
  probe('case f: page-specific og:image, different from kit.ogImage -> zero hits (PASS)', r.hits.length === 0);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ case g
// The real shape bbe-new-surface's workerIndex() scaffold writes: the favicon
// href is a bare `${HEAD_FAVICON}` template expression inside a backtick PAGE
// literal, resolved via that same-file constant's own single-quoted string
// assignment — the identical pattern kit-check.mjs's case 9 proves for the
// kit stylesheet link, exercised here for the favicon link instead.
{
  const fx = fixture();
  fx.write('index.js', `const HEAD_FAVICON = '${FAVICON}';
const HEAD_OG_IMAGE = '${OG_IMAGE}';
function page(){
return \`<!doctype html><html><head>
<link rel="icon" type="image/svg+xml" href="\${HEAD_FAVICON}">
<meta property="og:image" content="\${HEAD_OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">
</head><body></body></html>\`;
}
`);
  const r = scanHead(fx.dir, { favicon: FAVICON, ogImage: OG_IMAGE }, {});
  probe('case g: favicon inside a JS template string, resolved via same-file var -> detected as present, zero hits', r.hits.length === 0);
  probe('case g: the .js page was actually checked (carries <head>/</head>)', r.filesChecked === 1);
  rmSync(fx.dir, { recursive: true, force: true });
}

console.log(`\n  ${failures === 0 ? 'head-check PASS' : `head-check FAIL, ${failures} problem(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
