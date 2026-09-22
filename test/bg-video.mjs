#!/usr/bin/env node
// bg-video.mjs — unit tests for engine/bg-video.mjs (the block) and
// tools/bg-video-check.mjs (the gate). Same shape as test/head-check.mjs:
// build a throwaway fixture, call the function directly, assert on the
// return value. The scaffold/CI wiring end to end lives in test/smoke.mjs.
//
//   node test/bg-video.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { bgVideo, bgVideoCSS, bgVideoScript } from '../engine/bg-video.mjs';
import { createEngine } from '../engine/lib.mjs';
import { scanBgVideo } from '../tools/bg-video-check.mjs';

let failures = 0;
const probe = (label, cond) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bbe-bg-video-'));
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

console.log('\n  bg-video — engine/bg-video.mjs\n');

// ------------------------------------------------------------ the HTML block
{
  const html = bgVideo({
    mp4: '/hero.mp4',
    webm: '/hero.webm',
    poster: '/hero-poster.jpg',
    content: '<h1>hi</h1>'
  });
  probe('block: has muted', /\bmuted\b/.test(html));
  probe('block: has playsinline', /\bplaysinline\b/.test(html));
  probe('block: has loop', /\bloop\b/.test(html));
  probe('block: has preload="none"', /preload="none"/.test(html));
  probe('block: video carries a poster', /<video[^>]*\bposter="\/hero-poster\.jpg"/.test(html));
  probe('block: never emits autoplay', !/\bautoplay\b/.test(html));
  probe('block: sources use data-src, not src', /<source[^>]*data-src="\/hero\.mp4"/.test(html) && !/<source[^>]*(?<!data-)src="\/hero\.mp4"/.test(html));
  probe('block: webm source present', /data-src="\/hero\.webm"/.test(html));
  probe('block: has a scrim element', /bg-video__scrim/.test(html));
  probe('block: has a content wrapper carrying the content', /bg-video__content">\s*<h1>hi<\/h1>/.test(html));
  probe('block: root class carries bg-video', /class="bg-video[\s"]/.test(html));
}

// ---------------------------------------------------------- mobileMp4 order
{
  const html = bgVideo({ mp4: '/hero.mp4', webm: '/hero.webm', mobileMp4: '/hero-m.mp4', poster: '/p.jpg' });
  const mIdx = html.indexOf('hero-m.mp4');
  const webmIdx = html.indexOf('hero.webm');
  const mp4Idx = html.indexOf('hero.mp4', mIdx + 1); // the non-mobile mp4, after the mobile one
  probe('block: mobileMp4 source comes first', mIdx > -1 && mIdx < webmIdx && webmIdx < mp4Idx);
}

// -------------------------------------------------------------------- scrim
{
  const withScrim = bgVideo({ mp4: '/h.mp4', poster: '/p.jpg', scrim: 'rgba(0,0,0,.7)' });
  probe('block: scrim inline style only when scrim passed', /--bgv-scrim:rgba\(0,0,0,\.7\)/.test(withScrim));
  const noScrim = bgVideo({ mp4: '/h.mp4', poster: '/p.jpg' });
  probe('block: no inline scrim style when scrim omitted', !/style="/.test(noScrim));
}

// --------------------------------------------------------------------- CSS
{
  const css = bgVideoCSS();
  probe('css: defines .bg-video', /\.bg-video\{/.test(css));
  probe('css: reduced-motion hides the video, not the poster', /prefers-reduced-motion: reduce[\s\S]*?\.bg-video__video\{display:none\}/.test(css));
  probe('css: mobile hides video unless data-mobile="video"', /max-width:767px[\s\S]*?:not\(\[data-mobile="video"\]\)/.test(css));
  probe('css: fade var has a default', /var\(--bgv-fade,\.6s\)/.test(css));
  probe('css: scrim var has a default', /var\(--bgv-scrim,rgba\(0,0,0,\.55\)\)/.test(css));
}

console.log('\n  bg-video — engine wiring (lib.mjs)\n');

// -------------------------------------------------------- createEngine wiring
{
  const engine = createEngine({
    SITE: 'https://example.test', BASE: '', BUILD: 'x',
    themeColor: '#000', ogSiteName: 'Test', ogDefault: '/og.jpg',
    cssHead: () => '<link rel="stylesheet" href="/kit.css">'
  });
  probe('engine exposes bgVideo', typeof engine.bgVideo === 'function');
  probe('engine exposes bgVideoCSS', typeof engine.bgVideoCSS === 'function');
  probe('engine exposes bgVideoScript', typeof engine.bgVideoScript === 'function');

  const withBlock = engine.page({
    title: 'Home', desc: 'd', canonical: 'https://example.test/', jsonld: [], active: 'home',
    body: engine.bgVideo({ mp4: '/h.mp4', poster: '/p.jpg' })
  });
  probe('page(): includes the script when the body uses .bg-video', withBlock.includes('__bgvLoaded'));

  const withoutBlock = engine.page({
    title: 'Home', desc: 'd', canonical: 'https://example.test/', jsonld: [], active: 'home',
    body: '<p>no video here</p>'
  });
  probe('page(): omits the script entirely when the body does not use .bg-video', !withoutBlock.includes('__bgvLoaded'));

  const bareWithBlock = engine.page({
    title: 'Home', desc: 'd', canonical: 'https://example.test/', jsonld: [],
    body: engine.bgVideo({ mp4: '/h.mp4', poster: '/p.jpg' }),
    shell: 'bare'
  });
  probe('page(): bare shell also gets the script when used', bareWithBlock.includes('__bgvLoaded'));

  const bareWithoutBlock = engine.page({
    title: 'Home', desc: 'd', canonical: 'https://example.test/', jsonld: [],
    body: '<p>plain</p>',
    shell: 'bare'
  });
  probe('page(): bare shell without the block stays byte-plain', !bareWithoutBlock.includes('__bgvLoaded'));
}

console.log('\n  bg-video — tools/bg-video-check.mjs (the gate)\n');

const COMPLIANT_PAGE = `<!doctype html><html><head></head><body>
<section class="bg-video hero">
<div class="bg-video__media">
<img class="bg-video__poster" src="/p.jpg" alt="">
<video class="bg-video__video" muted playsinline loop preload="none" poster="/p.jpg" aria-hidden="true" tabindex="-1">
<source data-src="/h.webm" type="video/webm">
<source data-src="/h.mp4" type="video/mp4">
</video>
</div>
<div class="bg-video__scrim"></div>
<div class="bg-video__content"><h1>Hi</h1></div>
</section>
</body></html>`;

// ------------------------------------------------------------------ skip: no buildDir
{
  const fx = fixture();
  fx.write('dist/index.html', COMPLIANT_PAGE);
  const r = scanBgVideo(fx.dir, {});
  probe('no buildDir -> skipped, not a failure', r.skipped === true && r.hits.length === 0);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------ skip: buildDir unbuilt
{
  const fx = fixture();
  fx.write('build.mjs', '// nothing built yet\n');
  const r = scanBgVideo(fx.dir, { buildDir: 'dist' });
  probe('buildDir set but not built -> skipped, not a failure', r.skipped === true && r.hits.length === 0);
  rmSync(fx.dir, { recursive: true, force: true });
}

// --------------------------------------------------------------- pass: one block
{
  const fx = fixture();
  fx.write('dist/index.html', COMPLIANT_PAGE);
  const r = scanBgVideo(fx.dir, { buildDir: 'dist' });
  probe('one compliant block -> zero hits', r.hits.length === 0);
  probe('one page checked', r.filesChecked === 1);
  rmSync(fx.dir, { recursive: true, force: true });
}

// --------------------------------------------------------- fail: two blocks
{
  const fx = fixture();
  const twoBlocks = COMPLIANT_PAGE.replace('</section>\n</body>', `</section>\n${COMPLIANT_PAGE.match(/<section[\s\S]*<\/section>/)[0]}\n</body>`);
  fx.write('dist/index.html', twoBlocks);
  const r = scanBgVideo(fx.dir, { buildDir: 'dist' });
  const hit = r.hits.find((h) => /more than one/.test(h.reason));
  probe('two .bg-video sections on one page -> a hit', !!hit);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------ fail: missing attrs
{
  const fx = fixture();
  const bad = COMPLIANT_PAGE.replace('muted playsinline loop preload="none" poster="/p.jpg"', 'loop');
  fx.write('dist/index.html', bad);
  const r = scanBgVideo(fx.dir, { buildDir: 'dist' });
  const hit = r.hits.find((h) => /missing/.test(h.reason) && /muted/.test(h.reason));
  probe('video missing muted/playsinline/poster -> a hit naming all three', !!hit && /playsinline/.test(hit.reason) && /poster=/.test(hit.reason));
  rmSync(fx.dir, { recursive: true, force: true });
}

// ------------------------------------------------------------- fail: no scrim
{
  const fx = fixture();
  const bad = COMPLIANT_PAGE.replace('<div class="bg-video__scrim"></div>', '');
  fx.write('dist/index.html', bad);
  const r = scanBgVideo(fx.dir, { buildDir: 'dist' });
  const hit = r.hits.find((h) => /scrim/.test(h.reason));
  probe('no bg-video__scrim -> a hit', !!hit);
  rmSync(fx.dir, { recursive: true, force: true });
}

// -------------------------------------------------------- a page with none
{
  const fx = fixture();
  fx.write('dist/index.html', '<!doctype html><html><head></head><body><p>no block here</p></body></html>');
  const r = scanBgVideo(fx.dir, { buildDir: 'dist' });
  probe('a page that never uses the block -> zero hits (not required)', r.hits.length === 0);
  probe('still counted as a checked page', r.filesChecked === 1);
  rmSync(fx.dir, { recursive: true, force: true });
}

console.log(`\n  ${failures === 0 ? 'bg-video PASS' : `bg-video FAIL, ${failures} problem(s)`}\n`);
process.exit(failures === 0 ? 0 : 1);
