#!/usr/bin/env node
/**
 * script-parse.mjs, proves every inline <script> on every page actually PARSES.
 *
 * WHY. On 2026-09-18 the VHC site (andrew22lane/vhc-site) was one click from its
 * domain flip with every lead form dead. A copy edit put an apostrophe ("We'll")
 * inside a single-quoted JS string on the homepage and /start/. The form script
 * threw a SyntaxError on load, so the Start button did nothing, and EVERY gate
 * passed: the brand ratchet, the kit, the head check, VHC's own launch gate. None
 * of them read JavaScript as JavaScript. Andrew caught it by clicking. VHC's
 * gate-check.mjs got a parse check that day (relay incident 11239); this is that
 * check moved into the shared gate, so a site gets it by installing the package
 * instead of by someone remembering to copy it.
 *
 *   import { scanScripts } from './script-parse.mjs';
 *   const { hits, pagesChecked, scriptsParsed, jsonParsed, skipped } = scanScripts(repoRoot, { buildDir });
 *
 * WHICH PAGES. Every `.html` file the gate can see: the source tree (under the same
 * exclude contract as every other scanner here), plus every `.html` page in
 * `buildDir` when the repo names one. A static site's source IS what ships; an
 * engine site's pages only exist after the build, which is what `buildDir` is for.
 * Pages rendered by a worker's `.js`/`.mjs` template literal are NOT read: the
 * script bodies there are half `${...}` interpolation and cannot be parsed until
 * they are rendered.
 *
 * WHAT COUNTS AS A SCRIPT. Each `<script>` element with no `src`, found after HTML
 * comments are blanked out (so a commented-out block is not read, and line numbers
 * do not move). By `type`:
 *
 *   - classic JS (no type, text/javascript, application/javascript and the other
 *     JavaScript MIME types): compiled with `new vm.Script`. Compile only, nothing
 *     runs. Stricter than `new Function` and the same as a browser: a top-level
 *     `return` or `await` in a classic script is a SyntaxError here, as it is there.
 *   - `module`: checked with `node --check --input-type=module` on stdin, because
 *     `vm.SourceTextModule` still needs an experimental flag. One child process per
 *     distinct module body, so a nav module repeated on 40 pages is checked once.
 *   - JSON (`application/ld+json`, `application/json`, `importmap`,
 *     `speculationrules`): `JSON.parse`. A broken JSON-LD block silently drops the
 *     page's rich result, the same "looks fine, is dead" failure.
 *   - anything else (`text/template`, `text/x-handlebars`, `text/plain`...): not
 *     code the browser runs, so it is skipped and COUNTED, never silently.
 *
 * SOURCE TEMPLATES. A source `.html` can be a template a script fills in later:
 * bex-site's portal-builder/template-v4.html carries `const SNAPSHOT =
 * {{SNAPSHOT_JSON}};`, which is not JavaScript until it is rendered. In a SOURCE
 * page, each `{{NAME}}` placeholder is read as `null` before parsing, so the rest of
 * that script is still checked (an apostrophe bug two lines down is still a hit),
 * and the number of scripts read this way is reported. In a BUILT page nothing is
 * substituted: a `{{NAME}}` left in shipped output is itself the bug.
 *
 * Every hit prints as `SCRIPT: <file>:<line> <reason>`, where the line is the line
 * in the page the error is on, not the line inside the script. Zero hits is the
 * only pass. There is no ratchet: a page with a script that does not parse is a
 * page with a dead feature, and there is no acceptable number of those.
 *
 * BLIND POSTURE. A repo with no `.html` page anywhere (a worker, a library) is
 * normal, and this check reports "0 pages" and passes. A repo that names a
 * `buildDir` which exists and holds ZERO pages is a gate pointed at nothing, and
 * bbe-gate fails that as blind (exit 2), the same way it fails a kit check that
 * read nothing.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { walkFiles, isExcludedPath, DEFAULT_EXCLUDE } from './brand-drift.mjs';
import { lineAt, builtFiles, normalizeBuildDir } from './kit-drift.mjs';

// The type values a browser executes as a classic script. From the HTML spec's
// "JavaScript MIME type essence match" list, plus the empty string.
const CLASSIC_TYPES = new Set([
  '', 'text/javascript', 'application/javascript', 'application/ecmascript',
  'application/x-ecmascript', 'application/x-javascript', 'text/ecmascript',
  'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2', 'text/javascript1.3',
  'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript'
]);
const JSON_TYPES = new Set(['application/ld+json', 'application/json', 'importmap', 'speculationrules']);

// Blank every HTML comment to spaces, keeping newlines, so offsets and line numbers
// in the result are the same as in the original page.
function blankComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
}

function attrValue(attrs, name) {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '');
}

function hasAttr(attrs, name) {
  return new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|$)`, 'i').test(attrs);
}

/**
 * Every inline script block in one page, with where its body starts.
 * @returns {{kind:'classic'|'module'|'json'|'other', type:string, body:string, bodyIndex:number}[]}
 */
export function inlineScripts(html) {
  const text = blankComments(html);
  const out = [];
  const RX = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = RX.exec(text)) !== null) {
    const attrs = m[1];
    if (hasAttr(attrs, 'src')) continue;
    const bodyIndex = m.index + m[0].indexOf('>') + 1;
    // Read the body from the ORIGINAL page, so a string that merely contains "<!--"
    // is parsed as written. The blanked copy is only for finding the elements.
    const body = html.slice(bodyIndex, bodyIndex + m[2].length);
    const type = (attrValue(attrs, 'type') ?? '').trim().toLowerCase().split(';')[0].trim();
    let kind = 'other';
    if (CLASSIC_TYPES.has(type)) kind = 'classic';
    else if (type === 'module') kind = 'module';
    else if (JSON_TYPES.has(type)) kind = 'json';
    out.push({ kind, type, body, bodyIndex });
  }
  return out;
}

// Line of the error inside a script body (1-based), from `node --check`'s stderr.
function moduleErrorLine(stderr) {
  const m = stderr.match(/\[stdin\]:(\d+)/);
  return m ? Number(m[1]) : 1;
}

// `{{SNAPSHOT_JSON}}`, `{{ page.title }}`: a mustache-style value placeholder.
const PLACEHOLDER_RX = /\{\{\s*[\w.$-]+\s*\}\}/g;

function firstLine(s) {
  return String(s).split('\n').find((l) => l.trim()) || String(s);
}

/**
 * Parse one script block. Returns null when it parses, or {line, reason} where
 * line is the PAGE line of the error.
 */
function parseBlock(block, rel, html, moduleCache) {
  const startLine = lineAt(html, block.bodyIndex);
  if (block.kind === 'classic') {
    try {
      // lineOffset is zero-based and counts lines BEFORE the body, so the stack's
      // "<file>:<line>" is the page line. columnOffset lines up the first line too.
      const lineStart = html.lastIndexOf('\n', block.bodyIndex - 1) + 1;
      new vm.Script(block.body, {
        filename: rel,
        lineOffset: startLine - 1,
        columnOffset: block.bodyIndex - lineStart
      });
      return null;
    } catch (err) {
      const at = String(err.stack || '').match(new RegExp(`${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`));
      return { line: at ? Number(at[1]) : startLine, reason: `inline script does not parse: ${err.name || 'SyntaxError'}: ${err.message}` };
    }
  }
  if (block.kind === 'module') {
    let res = moduleCache.get(block.body);
    if (!res) {
      const r = spawnSync(process.execPath, ['--check', '--input-type=module', '-'], { input: block.body, encoding: 'utf8' });
      res = r.status === 0 ? { ok: true } : { ok: false, line: moduleErrorLine(r.stderr || ''), msg: (r.stderr || '').split('\n').find((l) => /Error/.test(l)) || firstLine(r.stderr || 'node --check failed') };
      moduleCache.set(block.body, res);
    }
    if (res.ok) return null;
    return { line: startLine + res.line - 1, reason: `inline module script does not parse: ${res.msg.trim()}` };
  }
  if (block.kind === 'json') {
    if (!block.body.trim()) return { line: startLine, reason: `empty <script type="${block.type}"> block` };
    try { JSON.parse(block.body); return null; } catch (err) {
      return { line: startLine, reason: `<script type="${block.type}"> is not valid JSON: ${err.message}` };
    }
  }
  return null;
}

/**
 * Scan a repo's pages for inline scripts that do not parse.
 *
 * @param {string} repoRoot
 * @param {{buildDir?: string, exclude?: string[]}} opts  `exclude` is ADDITIVE to
 *   brand-drift's DEFAULT_EXCLUDE, same contract as every other scanner here.
 */
export function scanScripts(repoRoot, opts = {}) {
  const absRepo = resolve(repoRoot);
  const buildDir = opts.buildDir ? normalizeBuildDir(opts.buildDir) : null;
  const exclude = [...DEFAULT_EXCLUDE, ...(opts.exclude || []), ...(buildDir ? [buildDir] : [])];

  const pages = [];
  for (const abs of walkFiles(absRepo)) {
    if (extname(abs).toLowerCase() !== '.html') continue;
    const rel = relative(absRepo, abs);
    if (isExcludedPath(rel, exclude)) continue;
    pages.push({ abs, rel, built: false });
  }
  const buildDirExists = !!(buildDir && existsSync(resolve(absRepo, buildDir)));
  if (buildDirExists) {
    for (const p of builtFiles(absRepo, buildDir, [...DEFAULT_EXCLUDE, ...(opts.exclude || [])])) {
      if (extname(p.abs).toLowerCase() === '.html') pages.push({ ...p, built: true });
    }
  }

  const hits = [];
  const skipped = {};
  const moduleCache = new Map();
  let pagesChecked = 0, builtPagesChecked = 0, scriptsParsed = 0, jsonParsed = 0, placeholderScripts = 0;

  for (const { abs, rel, built } of pages) {
    let html;
    try { html = readFileSync(abs, 'utf8'); } catch { continue; }
    pagesChecked++;
    if (built) builtPagesChecked++;
    for (const block of inlineScripts(html)) {
      if (block.kind === 'other') { skipped[block.type] = (skipped[block.type] || 0) + 1; continue; }
      if (block.kind === 'json') jsonParsed++; else scriptsParsed++;
      if (!built && PLACEHOLDER_RX.test(block.body)) {
        placeholderScripts++;
        block.body = block.body.replace(PLACEHOLDER_RX, 'null');
      }
      PLACEHOLDER_RX.lastIndex = 0;
      const bad = parseBlock(block, rel, html, moduleCache);
      if (bad) hits.push({ file: rel, line: bad.line, reason: bad.reason });
    }
  }

  return { hits, pagesChecked, builtPagesChecked, scriptsParsed, jsonParsed, placeholderScripts, skipped, buildDir, buildDirExists };
}

// CLI: node tools/script-parse.mjs [repoDir] [--build-dir dist]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const bi = args.indexOf('--build-dir');
  const buildDir = bi > -1 ? args[bi + 1] : undefined;
  const repo = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--build-dir') || process.cwd();
  const r = scanScripts(repo, { buildDir });
  for (const h of r.hits) console.log(`SCRIPT: ${h.file}:${h.line} ${h.reason}`);
  console.log(`${r.pagesChecked} pages, ${r.scriptsParsed} scripts + ${r.jsonParsed} JSON blocks parsed, ${r.hits.length} hit(s)`);
  process.exit(r.hits.length ? 1 : 0);
}
