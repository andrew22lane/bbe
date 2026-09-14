# Changelog

All notable changes to `@andrew22lane/bbe`. Tags are the source of truth; this file explains
what changed and why, in plain terms, for a consumer deciding whether to bump.

## v1.3.0 — the kit-aware gate

Enforces `vault/core/ONE-SYSTEM-LAW.md`: every brand runs on exactly ONE kit file, linked
first by every surface, and no surface defines its own color tokens, fonts, buttons or nav.
Written after eight bex surfaces each hand-typed their own button and passed the old gate,
with two primary teals live on the estate at once — the hex ratchet proved "no raw hex
outside the pack" and said nothing about whether two surfaces looked alike.

- **`bbe.config.json` gains an optional `kit` object**: `{ "url": "...", "local": "...",
  "reserved": [...] }`. `url` is the CDN kit URL every consumer links. `local` is for the
  one repo per brand that BUILDS the kit file — its own pages link it by a local/relative
  path instead of the CDN URL, and `local` is accepted as an equivalent link target.
- **The kit file itself (`kit.local`) is EXEMPT from the hex ratchet automatically.** A
  consumer no longer adds `"kit"` (or the kit's own path) to `exclude` by hand to get the
  same effect — `bbe-gate` does it from `kit.local` the moment the field is set. Every one
  of the seven 2026-09-13 kit mints needed the manual exclude before this fix; none will
  need it going forward.
- **Every built page must link the kit FIRST.** Any `.html` file, or `.mjs`/`.js`/`.css`
  file that renders one, is read for its stylesheet references in document order; the kit
  (`url` or `local`) must be the first `<link rel="stylesheet">` or `@import`. A page with
  no kit reference at all is also a miss.
- **No reserved token outside the kit.** A `:root` block, `@font-face`, or a bare `.btn`,
  `.btn-primary`, `.btn-ghost`, `.nav`, `body`, or `h1`–`h4` rule declared anywhere but the
  kit file itself is a KIT hit. Override the list with `kit.reserved`.
- **No ratchet on KIT hits.** Unlike the hex baseline, which only fails on a RISE, one KIT
  hit fails the build, every time. `KIT hits: N` prints on its own line, human and `--json`.
- **No `kit` object in the config at all: skipped, with a one-line warning**, so a brand
  that has no kit yet keeps passing instead of going dark. `--json` carries the same fact
  as `kit.checked: false`.
- Fixed a field-name bug in the branch this shipped from: the scanner and the gate's own
  validation read `kitLocal`, but every kit mint on 2026-09-13 wrote the field as `local` —
  the exemption and the local-link recognition would have silently never matched a single
  one of them. Renamed throughout to `local` before this ever reached a consumer.
- Tests: `test/kit-check.mjs` (unit, six cases against `tools/kit-drift.mjs` directly) and
  a new end-to-end block in `test/smoke.mjs` proving `bin/bbe-gate` wires the config field,
  the automatic exemption, and the skip warning together. `npm test` runs both.

## v1.2.0 — one config file, one installed scanner

`bbe.config.json` replaces `tools/brand-gate-baseline.json` (still honoured when absent, so
an unmigrated repo keeps gating). `exclude` is additive to the scanner's own defaults, the
same contract `estate.json` already used. See `docs/MIGRATE-GATE.md`.

## v1.1.0 / v1.0.1 / v1.0.0

The package's first shape: `engine/lib.mjs` installed instead of byte-copied, `bbe
new-surface` scaffolding a clean repo, the brand-drift hex gate, and the reusable
`bbe-gate.yml` workflow every consumer calls instead of vendoring.
