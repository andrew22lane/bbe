# Changelog

All notable changes to `@andrew22lane/bbe`. Tags are the source of truth; this file explains
what changed and why, in plain terms, for a consumer deciding whether to bump.

## v1.4.0 — the head check (one favicon, one default share image)

Andrew, 2026-09-15: "same favicon should be used for all pages created, and a default
branded share image must be auto set up for all pages made." The kit check
(v1.3.0) proved every surface links ONE stylesheet and defines none of its own reserved
tokens. It said nothing about the two tags every page ships in its `<head>` by hand: the
favicon, and the `og:image`/`twitter:card` pair a link unfurls with when it is pasted
anywhere. This closes that gap the same way — a gate check plus a scaffold that wires it
in on day one, rather than a rule that has to be remembered per page.

- **`bbe.config.json`'s `kit` object gains two more optional keys**: `"favicon"` and
  `"ogImage"`, both absolute URLs. Each is independently opt-in, exactly like `kit`
  itself — a repo with neither key set behaves exactly as it did on v1.3.1, and a brand
  can wire in one before the other. There is no migration: nothing breaks for a consumer
  that does not touch this.
- **`bbe-gate` gains a head check**, `tools/head-check.mjs`, run right after the kit
  check with the same no-ratchet posture: one hit fails the build, every time. When
  `kit.favicon` is set, every page the kit check already treats as a page (any `.html`
  file, or a `.mjs`/`.js`/`.cjs` file that assembles a whole page) must carry a
  `<link rel="icon" ...>` whose href resolves to EXACTLY `kit.favicon` — missing it, or
  pointing somewhere else, is one hit. When `kit.ogImage` is set, every page must carry a
  `<meta property="og:image" content="...">` with ANY non-empty value — a page-specific
  share image (a blog post's own card) is allowed to override the brand default, so the
  VALUE is never compared to `kit.ogImage`, only its presence — plus a
  `<meta name="twitter:card" content="...">` alongside it, because Twitter/X ignores
  `og:image` without one. Prints as `head check   favicon <url> · og:image (N files
  checked)`, and each hit as `HEAD: <file>:<line> <reason>`. Two keys absent (or no
  `kit` object at all) prints a one-line skip warning, same style as the kit check's,
  never a FAIL.
- **`buildDir`: the kit and head checks now read built pages.** Found while verifying
  the head check: on a site from `bbe new-surface --kind site`, built with
  `npm run build`, `bbe-gate` printed `head check ... (0 files checked)` and PASS. An
  engine site's pages only exist in `dist/`, which the gate never read. New optional
  top-level key `"buildDir": "dist"`. When set, the head check reads every `.html` page
  there, the kit check runs its link-first half there (the reserved-token half stays on
  source), the directory is kept out of the source walks and the hex ratchet so nothing
  counts twice, and a missing directory exits 2 with "build first". The reusable workflow
  runs `npm run build` before the gate when `buildDir` is set (new `build-command`
  input). `bbe new-surface --kind site` writes `"buildDir": "dist"`. **A check that reads zero
  pages now exits 2**, head and kit alike: it prints `KIT BLIND` / `read ZERO pages` and
  fails. Measured across every consumer on `main` the day this landed, one repo is
  affected by the kit half (`proveit-domain`, an engine site with no source page), and
  its fix is one `buildDir` line.
- **Href/content resolution reuses kit-drift.mjs's own escaping logic**, exported for
  this: `isPageFile` (what counts as a page, so the two scanners can never disagree),
  `resolveTemplateVar` (a bare `${identifier}` href resolved via that identifier's own
  same-file string assignment) and `lineAt`. A worker-rendered page whose favicon href is
  a template variable — the exact shape `bbe new-surface` itself now scaffolds — is
  detected the same way v1.3.1 already detects a template-variable kit link.
- **`bbe new-surface` wires it in on day one.** The pack's `outputs.web.kit.favicon` /
  `.ogImage` (or `--favicon <url>` / `--og-image <url>`, the escape hatch for a pack not
  yet updated) get written into the scaffolded `bbe.config.json`'s `kit` object AND into
  every generated page head: a site build's `extraHead` slot (so the shared,
  byte-frozen `engine/lib.mjs` stays untouched) and a worker's inline `<head>` template.
  Tags emitted: `<link rel="icon" type="image/svg+xml" href="{favicon}">`,
  `<meta property="og:image" content="{ogImage}">` with `og:image:width`/`:height` set
  to `1200`/`630`, `<meta name="twitter:card" content="summary_large_image">`, and
  `<meta name="twitter:image" content="{ogImage}">`. Neither flag present, neither key
  on the pack: the scaffold writes exactly what v1.3.1 wrote, nothing new to fail the
  head check because there is nothing to check.
- Tests: `test/head-check.mjs` (new, 14 cases a-g, the same throwaway-fixture-repo style
  as `test/kit-check.mjs`) and a `headEndToEndCheck()` block in `test/smoke.mjs` proving
  `bin/bbe-gate` wires `scanHead` in correctly — reads `kit.favicon`/`kit.ogImage`,
  prints the report lines, fails the build on a real hit. `npm test` now runs
  `test/kit-check.mjs`, `test/head-check.mjs` and `test/smoke.mjs`, all green.

## v1.3.1 — kit link detection through escaped hrefs and template variables

Reported by two bex-site workers wiring wave-2 surfaces onto the ONE kit on 2026-09-13: the
v1.3.0 link-first check read `<link rel="stylesheet" href="...">` from HTML and from CSS/JS
strings, but missed three real shapes, so `next-step.mjs`, `leads-worker/src/render.js` and
`pages.mjs` all read as a KIT hit ("missing kit link") while they actually link the kit first.

- **Escaped quotes.** A plain JS string built with concatenation carries `\"` where an HTML
  file or a backtick template literal carries a bare `"`. `next-step.mjs`'s real head is one
  such string; the old regex required `rel=` to be followed immediately by a bare quote
  character, so it silently matched nothing in the whole file. The link and href regexes now
  tolerate one optional literal backslash in front of either quote character.
- **A `${var}` href resolved via its own same-file string assignment.** A page that self-hosts
  the kit (leads-worker: CSP is `default-src 'self'`, so the CDN URL never appears in the file)
  writes `href="${KIT_PATH}"` where `export const KIT_PATH = '/_kit/bex-kit-v1.css'` sits
  elsewhere in the same file, single-quoted. A bare `${identifier}` href is now resolved by
  finding that identifier's own string assignment (single- or double-quoted) in the same file
  and comparing its BASENAME against `kit.url`'s and `kit.local`'s. A variable built from OTHER
  variables (not one plain string) is not resolved — it still falls through to the existing
  embedded-URL-string check, unchanged.
- **A `.mjs`/`.js` file is only a page when it assembles one.** The old rule treated any
  `.mjs`/`.js` file containing a `<link rel="stylesheet">` substring ANYWHERE as a page needing
  its own kit-first link. `pages.mjs`'s `leafletHead()` helper returns exactly one such link —
  Leaflet's own vendor CSS, a fragment with no head of its own, the real page head being
  assembled elsewhere — and was read as "the page" that missed the kit. A `.mjs`/`.js`/`.cjs`
  file now counts as a page only when it carries BOTH `<head` and `</head>`; a `.html` file is
  still always a page.
- **What still cannot be seen, on purpose:** a template variable assembled from OTHER
  variables (e.g. `` `${BASE}${KIT_LOCAL_HREF}?v=${BUILD}` ``) is not resolved into a single
  string, so it still relies on the kit URL or local path appearing literally elsewhere in the
  file. That is an existing, separate blind spot (unrelated files already pass through it by
  accident) and is out of scope for this fix.
- Tests: five new fixture cases in `test/kit-check.mjs` (escaped double quotes; a single-quoted
  variable feeding a template-literal href; a `${KIT}` variable resolved by same-file basename
  match; the kit linked but not FIRST, still a hit; no kit reference at all, still a hit).
  `npm test` runs `test/kit-check.mjs` (now 15 cases) and `test/smoke.mjs`, both green.

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
