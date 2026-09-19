#!/usr/bin/env node
// script-parse.mjs — unit tests for tools/script-parse.mjs, plus one end-to-end
// run through bin/bbe-gate. Same shape as test/bg-video.mjs: build a throwaway
// fixture, call the function directly, assert on the return value.
//
//   node test/script-parse.mjs
//
// Case 1 is the exact line that killed every VHC lead form on 2026-09-18
// (andrew22lane/vhc-site b4f3b04, relay incident 11239). It stays first.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanScripts, inlineScripts } from '../tools/script-parse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const probe = (label, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'bbe-script-parse-'));
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

// The VHC form script, trimmed to the shape that mattered: a single-quoted string
// with "We'll" inside it, on line 8 of the page.
const VHC_BROKEN_LINE = `    if (timing === 'As soon as possible'){ lines.push('ASAP works. We'll reach out soon.'); }`;
const VHC_FIXED_LINE = `    if (timing === 'As soon as possible'){ lines.push("ASAP works. We'll reach out soon."); }`;
const vhcPage = (line) => `<!doctype html>
<html><head><title>Valley Home Construction</title></head>
<body>
<form id="start"><button>Start</button></form>
<script>
  function summary(timing){
    const lines = [];
${line}
    return lines;
  }
</script>
</body></html>
`;

console.log('\n  script-parse — tools/script-parse.mjs\n');

// ---------------------------------------------- 1. the VHC failure, exactly
{
  const fx = fixture();
  fx.write('index.html', vhcPage(VHC_BROKEN_LINE));
  const r = scanScripts(fx.dir);
  probe('1. VHC: apostrophe inside a single-quoted string is a hit', r.hits.length === 1, JSON.stringify(r.hits));
  probe('1. VHC: hit names the file', r.hits[0]?.file === 'index.html');
  probe('1. VHC: hit names the PAGE line of the error (8), not the script line', r.hits[0]?.line === 8, `line ${r.hits[0]?.line}`);
  probe('1. VHC: reason says it does not parse and why', /inline script does not parse: SyntaxError: /.test(r.hits[0]?.reason || ''), r.hits[0]?.reason);
  probe('1. VHC: coverage counted (1 page, 1 script)', r.pagesChecked === 1 && r.scriptsParsed === 1);

  fx.write('index.html', vhcPage(VHC_FIXED_LINE));
  const fixed = scanScripts(fx.dir);
  probe('1. VHC: the shipped fix (double quotes) passes', fixed.hits.length === 0 && fixed.scriptsParsed === 1, JSON.stringify(fixed.hits));
  rmSync(fx.dir, { recursive: true, force: true });
}

// ---------------------------------------------- 2. what is and is not a script
{
  const fx = fixture();
  fx.write('a.html', `<!doctype html><html><head>
<script src="/app.js"></script>
<script src="/x.js">this body is ignored by browsers when src is set '</script>
<script type="text/template"><div>{{ it's not code }}</div></script>
<script type="text/x-handlebars">{{#if}} ' {{/if}}</script>
<!-- <script>var dead = 'We'll';</script> -->
<script type="text/javascript">var ok = "We'll";</script>
</head><body></body></html>`);
  const r = scanScripts(fx.dir);
  probe('2. src scripts are not parsed', r.scriptsParsed === 1, `${r.scriptsParsed} parsed`);
  probe('2. text/template and text/x-handlebars are skipped and COUNTED', r.skipped['text/template'] === 1 && r.skipped['text/x-handlebars'] === 1, JSON.stringify(r.skipped));
  probe('2. a commented-out broken script is not read', r.hits.length === 0, JSON.stringify(r.hits));
  rmSync(fx.dir, { recursive: true, force: true });
}

// ---------------------------------------------- 3. JSON-LD is JSON.parsed
{
  const fx = fixture();
  fx.write('good.html', `<!doctype html><script type="application/ld+json">{"@type":"LocalBusiness","name":"Valley Home Construction"}</script>`);
  fx.write('bad.html', `<!doctype html>\n\n<script type="application/ld+json">{"@type":"LocalBusiness",}</script>`);
  fx.write('map.html', `<!doctype html><script type="importmap">{"imports":{"a":"/a.js"}}</script>`);
  const r = scanScripts(fx.dir);
  probe('3. JSON blocks are counted separately from scripts', r.jsonParsed === 3 && r.scriptsParsed === 0, `${r.jsonParsed} json, ${r.scriptsParsed} js`);
  probe('3. a trailing comma in JSON-LD is a hit', r.hits.length === 1 && r.hits[0].file === 'bad.html' && /application\/ld\+json.*not valid JSON/.test(r.hits[0].reason), JSON.stringify(r.hits));
  probe('3. JSON hit points at the block\'s line', r.hits[0]?.line === 3, `line ${r.hits[0]?.line}`);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ---------------------------------------------- 4. module scripts
{
  const fx = fixture();
  fx.write('m.html', `<!doctype html>
<script type="module">
import { a } from './a.js';
export const b = a;
</script>
<script type="module">
import { a } from './a.js';
const s = 'We'll';
</script>`);
  const r = scanScripts(fx.dir);
  probe('4. a valid module with import/export parses', r.scriptsParsed === 2 && r.hits.length === 1, JSON.stringify(r.hits));
  probe('4. the VHC mistake inside a module is a hit on the right page line (8)', r.hits[0]?.line === 8 && /module script does not parse/.test(r.hits[0]?.reason || ''), JSON.stringify(r.hits[0]));
  rmSync(fx.dir, { recursive: true, force: true });
}

// ---------------------------------------------- 5. browser semantics, not new Function's
{
  const fx = fixture();
  fx.write('r.html', `<!doctype html><script>\nif (x) return;\n</script>`);
  const r = scanScripts(fx.dir);
  probe('5. top-level return is a SyntaxError in a classic script (new Function would pass it)', r.hits.length === 1 && r.hits[0].line === 2, JSON.stringify(r.hits));
  const legacy = inlineScripts(`<script><!--\nvar a = 1;\n//--></script>`);
  fx.write('legacy.html', `<!doctype html><script><!--\nvar a = 1;\n//--></script>`);
  const r2 = scanScripts(fx.dir);
  probe('5. an old "<!-- ... //-->" wrapper inside a script is found and still parses', legacy.length === 1 && !r2.hits.some((h) => h.file === 'legacy.html'), JSON.stringify(r2.hits));
  rmSync(fx.dir, { recursive: true, force: true });
}

// ---------------------------------------------- 6. buildDir: built pages are read
{
  const fx = fixture();
  fx.write('src/index.html', vhcPage(VHC_FIXED_LINE));
  fx.write('dist/start/index.html', vhcPage(VHC_BROKEN_LINE));
  const r = scanScripts(fx.dir, { buildDir: 'dist' });
  probe('6. a broken BUILT page is a hit, reported by its dist/ path', r.hits.length === 1 && r.hits[0].file === 'dist/start/index.html', JSON.stringify(r.hits));
  probe('6. source and built pages both counted', r.pagesChecked === 2 && r.builtPagesChecked === 1, `${r.pagesChecked}/${r.builtPagesChecked}`);
  const noBuild = scanScripts(fx.dir, { buildDir: 'out' });
  probe('6. a named buildDir that was never built reads 0 built pages', noBuild.builtPagesChecked === 0 && noBuild.buildDirExists === false);
  rmSync(fx.dir, { recursive: true, force: true });
}

// ---------------------------------------------- 6b. source templates vs built output
{
  const fx = fixture();
  // bex-site portal-builder/template-v4.html, trimmed.
  const tpl = (extra) => `<!doctype html>\n<script>\nconst SNAPSHOT = {{SNAPSHOT_JSON}};\nconst PAGE = "{{PAGE}}";\n${extra}\n</script>`;
  fx.write('portal-builder/template-v4.html', tpl('const ok = 1;'));
  const r = scanScripts(fx.dir);
  probe('6b. a source template with {{SNAPSHOT_JSON}} parses, placeholder read as null', r.hits.length === 0 && r.placeholderScripts === 1, JSON.stringify(r.hits));
  fx.write('portal-builder/template-v4.html', tpl(`const msg = 'We'll';`));
  const r2 = scanScripts(fx.dir);
  probe('6b. ...and a real apostrophe bug in the same template is still a hit (line 5)', r2.hits.length === 1 && r2.hits[0].line === 5, JSON.stringify(r2.hits));
  rmSync(join(fx.dir, 'portal-builder'), { recursive: true, force: true });
  fx.write('dist/index.html', tpl('const ok = 1;'));
  const r3 = scanScripts(fx.dir, { buildDir: 'dist' });
  probe('6b. a {{placeholder}} left in BUILT output is a hit, never substituted', r3.hits.length === 1 && r3.placeholderScripts === 0, JSON.stringify(r3.hits));
  rmSync(fx.dir, { recursive: true, force: true });
}

// ---------------------------------------------- 7. end to end through bin/bbe-gate
{
  const fx = fixture();
  const pack = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'fixture.brandpack.json'), 'utf8'));
  fx.write('brand/fixture.brandpack.json', JSON.stringify(pack, null, 2));
  fx.write('bbe.config.json', JSON.stringify({ pack: 'fixture', exclude: [], baseline: 0, buildDir: 'dist' }, null, 2) + '\n');
  fx.write('dist/index.html', vhcPage(VHC_BROKEN_LINE));
  const gate = (args = []) => spawnSync(process.execPath, [join(ROOT, 'bin', 'bbe-gate'), ...args], { cwd: fx.dir, encoding: 'utf8' });

  const red = gate();
  probe('7. gate: the VHC page fails the build (exit 1)', red.status === 1, `exit ${red.status}`);
  probe('7. gate: prints SCRIPT: <file>:<line>', /SCRIPT: dist\/index\.html:8 inline script does not parse/.test(red.stdout), red.stdout.split('\n').filter((l) => /SCRIPT/.test(l)).join(' | '));
  probe('7. gate: prints coverage (pages + scripts parsed)', /scripts\s+every inline <script> parses.*\(1 pages, 1 of them in dist\/; 1 scripts \+ 0 JSON blocks parsed\)/.test(red.stdout));
  probe('7. gate: never prints PASS', !/^PASS$/m.test(red.stdout));

  const json = gate(['--json']);
  let parsed = null; try { parsed = JSON.parse(json.stdout); } catch {}
  probe('7. gate --json: scripts block carries the hit', !!parsed && parsed.ok === false && parsed.scripts.hits === 1 && parsed.scripts.violations[0].line === 8);

  fx.write('dist/index.html', vhcPage(VHC_FIXED_LINE));
  const green = gate();
  probe('7. gate: the fixed page passes', green.status === 0 && /SCRIPT hits: 0/.test(green.stdout) && /^PASS$/m.test(green.stdout), `exit ${green.status}`);

  rmSync(join(fx.dir, 'dist'), { recursive: true, force: true });
  mkdirSync(join(fx.dir, 'dist'));
  const blind = gate();
  probe('7. gate: a buildDir with no pages is BLIND, exit 2, never PASS', blind.status === 2 && /SCRIPT BLIND/.test(blind.stdout) && !/^PASS$/m.test(blind.stdout), `exit ${blind.status}`);

  fx.write('bbe.config.json', JSON.stringify({ pack: 'fixture', exclude: [], baseline: 0 }, null, 2) + '\n');
  const worker = gate();
  probe('7. gate: a repo with no pages and no buildDir (a worker) still passes', worker.status === 0, `exit ${worker.status}`);
  rmSync(fx.dir, { recursive: true, force: true });
}

console.log(`\n  ${failures ? `${failures} FAILED` : 'all passed'}\n`);
process.exit(failures ? 1 : 0);
