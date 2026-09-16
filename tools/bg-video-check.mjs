#!/usr/bin/env node
/**
 * bg-video-check.mjs — proves Andrew's 2026-09-16 ruling: ONE ambient
 * background video per page, hero only, muted, playing behind a poster and a
 * scrim, never bare.
 *
 * Unlike kit-drift.mjs and head-check.mjs, this check has NOTHING to say
 * about a repo that has not built yet, and nothing to say about a repo that
 * never uses the block at all. An engine site's `.bg-video` markup, same as
 * its `<head>`, only exists after `build.mjs` runs, so this check reads
 * `bbe.config.json`'s `buildDir` and ONLY `buildDir` — there is no "read the
 * source instead" fallback the way head-check and kit-drift have, because a
 * hand-written source template quoting `bg-video` classes inside a JS string
 * is not itself a page. When `buildDir` is unset, or set but not built yet,
 * this check is SKIPPED and passes, printing why — the opposite posture from
 * head/kit's "zero pages read is a blind gate, fail it": a site that has no
 * background-video block at all is a perfectly normal site, not a partial
 * rollout of a rule it opted into.
 *
 *   import { scanBgVideo } from './bg-video-check.mjs';
 *   const { hits, filesChecked, skipped } = scanBgVideo(repoRoot, { buildDir });
 *
 * THREE CHECKS, per built `.html` page:
 *
 * (a) AT MOST ONE per page. More than one `class="bg-video` (or a class list
 *     that contains it, e.g. `class="bg-video hero"`) on the same page is a
 *     hit — the whole point of "hero only" is there is exactly one ambient
 *     loop competing for attention, never a page stacking loops in section
 *     after section.
 *
 * (b) EVERY `<video>` INSIDE `.bg-video` CARRIES `muted`, `playsinline`, AND
 *     a `poster=` attribute. Missing any one of the three is a hit — a video
 *     without `muted` cannot autoplay in any browser that matters, one
 *     without `playsinline` fullscreens itself on iOS the instant it plays,
 *     and one without a poster shows nothing (or a black frame) until the
 *     script upgrades it, on a slow connection or with JS off.
 *
 * (c) EVERY `.bg-video` HAS A SCRIM. No `bg-video__scrim` element inside a
 *     `.bg-video` section is a hit — the recipe is text over the clip, never
 *     the clip alone, and the scrim is what keeps it low-contrast enough to
 *     read over.
 *
 * Every hit prints as `BGVIDEO: <file>:<line> <reason>`. Zero hits is the
 * only pass. There is no ratchet: like the kit and head checks, a partial
 * rollout of this rule is exactly the bug it exists to catch.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { isExcludedPath, DEFAULT_EXCLUDE } from './brand-drift.mjs';
import { lineAt, builtFiles, normalizeBuildDir } from './kit-drift.mjs';

// Every `class="..."` (or class='...') attribute value that contains
// "bg-video" as a whole class token, text-wide, in document order. Reads the
// class LIST, not just the literal string "bg-video", so `class="bg-video
// hero"` and `class="hero bg-video"` both count, and `class="bg-video-thing"`
// (a different class that merely starts with the same letters) does not.
function findBgVideoSections(text) {
  const hits = [];
  const CLASS_RX = /class=(["'])([^"']*)\1/gi;
  let m;
  while ((m = CLASS_RX.exec(text)) !== null) {
    const tokens = m[2].split(/\s+/);
    if (tokens.includes('bg-video')) hits.push({ index: m.index });
  }
  return hits;
}

// Every `<video ...>` open tag whose nearest preceding bg-video class match is
// "this one" is overkill to prove structurally without a real parser, and this
// scanner deliberately stays a text scanner like its siblings. In practice a
// site built from engine/bg-video.mjs's own bgVideo() nests exactly one
// `<video class="bg-video__video">` per `.bg-video` section, so this reads
// every `<video ...>` tag in the file and every `.bg-video__scrim` occurrence,
// and reports counts against the page as a whole — precise enough to catch a
// hand-rolled page that dropped an attribute or the scrim, without pretending
// to resolve nesting text scanners cannot see.
function findVideoTags(text) {
  const tags = [];
  const VIDEO_RX = /<video\b[^>]*>/gi;
  let m;
  while ((m = VIDEO_RX.exec(text)) !== null) tags.push({ index: m.index, tag: m[0] });
  return tags;
}

function hasAttr(tagText, name) {
  // Bare boolean attribute (muted, playsinline) or name="value" / name='value'.
  const bareRx = new RegExp(`[\\s"']${name}(?=[\\s>/]|$)`, 'i');
  return bareRx.test(` ${tagText}`);
}

function hasPoster(tagText) {
  return /\bposter=["'][^"']+["']/i.test(tagText);
}

/**
 * Scan a repo's BUILT pages for background-video violations.
 *
 * @param {string} repoRoot
 * @param {{buildDir?: string, exclude?: string[]}} opts  `buildDir` is the
 *   same repo-relative key bbe.config.json already carries for the kit/head
 *   checks (e.g. "dist"). `exclude` is ADDITIVE to brand-drift's
 *   DEFAULT_EXCLUDE, same contract as every other scanner here.
 */
export function scanBgVideo(repoRoot, opts = {}) {
  if (!opts.buildDir) {
    return { hits: [], filesChecked: 0, skipped: true, skipReason: 'no buildDir' };
  }
  const absRepo = resolve(repoRoot);
  const buildDir = normalizeBuildDir(opts.buildDir);
  const absBuilt = resolve(absRepo, buildDir);
  // A named buildDir that has never been built is not this check's business to
  // fail — bbe-gate's own "buildDir does not exist" die() covers that for a repo
  // with a "kit" object; a repo with none isn't blocked from building at all, so
  // this just skips rather than blind-failing on the missing directory.
  if (!existsSync(absBuilt)) {
    return { hits: [], filesChecked: 0, skipped: true, skipReason: `buildDir ${buildDir}/ does not exist yet — build first` };
  }
  const pages = builtFiles(absRepo, buildDir, [...DEFAULT_EXCLUDE, ...(opts.exclude || [])]);
  const hits = [];
  let filesChecked = 0;

  for (const { abs, rel } of pages) {
    if (extname(abs).toLowerCase() !== '.html') continue;
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    filesChecked++;

    const sections = findBgVideoSections(text);
    if (sections.length > 1) {
      hits.push({
        file: rel,
        line: lineAt(text, sections[1].index),
        reason: `more than one .bg-video on one page (${sections.length} found)`
      });
    }
    if (sections.length === 0) continue;

    const scrimCount = (text.match(/bg-video__scrim/g) || []).length;
    if (scrimCount === 0) {
      hits.push({ file: rel, line: lineAt(text, sections[0].index), reason: 'no bg-video__scrim on the page' });
    }

    const videos = findVideoTags(text);
    if (videos.length === 0) {
      hits.push({ file: rel, line: lineAt(text, sections[0].index), reason: '.bg-video with no <video> element' });
    }
    for (const v of videos) {
      const missing = [];
      if (!hasAttr(v.tag, 'muted')) missing.push('muted');
      if (!hasAttr(v.tag, 'playsinline')) missing.push('playsinline');
      if (!hasPoster(v.tag)) missing.push('poster=');
      if (missing.length) {
        hits.push({ file: rel, line: lineAt(text, v.index), reason: `<video> missing ${missing.join(', ')}` });
      }
    }
  }

  return { hits, filesChecked, skipped: false, skipReason: null };
}
