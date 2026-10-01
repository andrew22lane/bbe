#!/usr/bin/env node
/**
 * gate-exclude.mjs — the ONE exclude list the hex ratchet scans with.
 *
 *   import { effectiveExclude } from '@andrew22lane/bbe/tools/gate-exclude.mjs';
 *   const exclude = effectiveExclude({ repoRoot, config });
 *   scanRepo({ repo: repoRoot, packPath, exclude });
 *
 * WHY THIS FILE EXISTS. bbe-gate used to build its exclude list inline. The nightly
 * estate job in dh-hub imports scanRepo and DEFAULT_EXCLUDE and built its own list,
 * `[...DEFAULT_EXCLUDE, ...config.exclude]`, so it missed `tools`, the kit file and
 * buildDir. CI read 0 hits and the nightly read 154 on the same trees, and 7 of 18
 * surfaces showed a false RATCHET BREACH for 19 days. TQ-101 names the class: two
 * exclude lists reaching one scanner. Now there is one function, and both callers
 * use it, so CI and the nightly cannot disagree.
 *
 * The list, in order:
 *   1. brand-drift's DEFAULT_EXCLUDE
 *   2. EXTRA_EXCLUDE (`tools`: gate fixtures and token plumbing quote colours as test data)
 *   3. config.exclude, additive, never replacing
 *   4. config.kit.local, the kit file itself (the one place raw hex may live)
 *   5. config.buildDir, build output that carries the pack's colours back out
 */

import path from 'node:path';
import { DEFAULT_EXCLUDE } from './brand-drift.mjs';
import { normalizeBuildDir } from './kit-drift.mjs';

// Excluded on top of brand-drift's defaults, for every repo on this gate.
export const EXTRA_EXCLUDE = ['tools'];

// The kit file path, as the exclude matcher wants it: no leading "./" or "/".
export function kitLocalExclude(config) {
  return (config && config.kit && config.kit.local)
    ? [config.kit.local.replace(/^\.?\//, '')]
    : [];
}

// buildDir is build OUTPUT: it carries the pack's colors the engine wrote back into CSS.
// Kept out of the hex ratchet so a buildDir the defaults do not already skip ("public",
// "out") never counts the pack against itself. The kit and head scans read it on purpose.
// It must be a directory inside the repo. bbe-gate dies on
// one that is not; here an invalid value adds nothing, so a caller that only wants the
// list never throws.
export function buildDirExclude({ repoRoot, config }) {
  if (!config || config.buildDir == null) return [];
  const raw = typeof config.buildDir === 'string' ? normalizeBuildDir(config.buildDir) : '';
  const root = path.resolve(repoRoot);
  const inside = raw && raw !== '.' && !path.isAbsolute(raw)
    && path.resolve(root, raw).startsWith(root + path.sep);
  return inside ? [raw] : [];
}

/**
 * @param {{ repoRoot: string, config: object }} args  `config` is the parsed bbe.config.json
 * @returns {string[]} the full exclude list for scanRepo()
 */
export function effectiveExclude({ repoRoot, config }) {
  const cfg = config || {};
  return [
    ...DEFAULT_EXCLUDE,
    ...EXTRA_EXCLUDE,
    ...(cfg.exclude || []),
    ...kitLocalExclude(cfg),
    ...buildDirExclude({ repoRoot, config: cfg })
  ];
}
