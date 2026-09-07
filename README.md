# @andrew22lane/bbe

The Brand Builder Engine, as one installable package. Private. Internal.

Before this repo existed, `engine/lib.mjs` lived in `bex-site` and was byte-copied
by hand into `design-hacker-apex` and `gab-site`. A parity script existed and
nothing ran it, so the copies forked on 2026-09-03 and again on 2026-09-06. This
repo is the fix: one home, one version number, and consumers that install instead
of copy.

## What's in it

| Path | What it is |
|---|---|
| `engine/lib.mjs` | The shared static-site engine core. The `<head>` skeleton, the page wrapper, escape and clamp helpers, URL building, breadcrumbs, the reveal and crumb scripts, the two brand-blind JSON-LD builders. Holds zero brand facts. |
| `tools/gate-lint.mjs` | The gate. Seven checks; five delegate to a gate that already exists. `bbe-gate` on the CLI. |
| `tools/brand-drift.mjs` | The scanner `gate-lint` calls. Counts hardcoded brand facts in a repo against a pack. |
| `tools/build-tokens.mjs` | Generates `src/tokens.generated.js` from a brand pack's `outputs.web`. `bbe-tokens` on the CLI. |
| `tools/verify-byte-identity.mjs` | Walks two build trees, sha256s every file, exits 1 on any difference. The proof every migration ships with. |

Brand packs still live in the vault (`dh-hub/vault/core/brand-packs/`). Phase 2
moves them in here so a brand change becomes a versioned release.

## Why the scope is `@andrew22lane` and not `@designhacker`

GitHub Packages requires an npm package's scope to be the account or organization
that owns the repository. `@designhacker/bbe` was attempted first, from this repo,
on tag `v1.0.0`, and GitHub refused it:

```
npm error 403 Forbidden - PUT https://npm.pkg.github.com/@designhacker%2fbbe
npm error 403 Permission permission_denied: The requested installation does not exist.
```

There is no `designhacker` GitHub organization. The two that exist are
`brand-builder-bot` and `brandbuilderpros`. So the published name is
`@andrew22lane/bbe` from `v1.0.1` on. Changing it later means creating a
`designhacker` org, transferring this repo into it, publishing under the new
scope, and bumping one line plus one `.npmrc` line in each consumer. That is
Andrew's call, not a blocker.

## Install

```
npm install @andrew22lane/bbe@1.0.1
```

Every consumer commits an `.npmrc` (see below) and pins an exact version. No
carets. A range would let a build pick up an engine change nobody diffed.

```js
import { createEngine } from '@andrew22lane/bbe/engine';
```

## How to change the engine

The rule that governed the old single copy still governs this package, and it is
the whole reason this repo exists: **nothing lands in `engine/` unless every
consumer emits the exact same bytes after it lands, or the change to those bytes
was the point and is shown in the PR.** So: edit `engine/lib.mjs` on a branch
here. Then, for each consumer, build its site from `main` and build it again
against your branch with the SAME pinned `BUILD_ID` and `BUILD_TIME`, and run
`node tools/verify-byte-identity.mjs <before> <after>`. Paste the result. A
diff you did not intend is a bug in your change, not noise in the tool.

Then bump `version` in `package.json`, merge, and push a tag matching it
(`v1.0.1`). The Action publishes to GitHub Packages using the workflow's own
`GITHUB_TOKEN`; there is no PAT and no repository secret in this repo. If a
publish fails, fix it and tag one patch higher. Never force-move a tag that has
been pushed. Consumers then change one line each: the pinned version in their
`package.json`. Nobody copies a file, and a rollback is that same one line.

## How to add a consumer

A new surface needs four things and none of them is a copy of this repo. One,
`npm install @andrew22lane/bbe@<exact version>` and an `.npmrc` in the repo root
holding `@andrew22lane:registry=https://npm.pkg.github.com` and
`//npm.pkg.github.com/:_authToken=${NPM_TOKEN}` — the token comes from the build
environment, never from the file. Two, `import { createEngine } from
'@andrew22lane/bbe/engine'` in its build script, and no `engine/` folder of its
own; if it already has one, delete it in the same PR that adds the dependency,
along with any `tools/engine-parity.mjs`, which now has nothing to guard. Three,
its brand pack, which stays in the vault in this phase and is mirrored into
`brand/` with `tools/pack-parity.mjs` still guarding that mirror. Four, the gate
in CI, running `bbe-gate` with a ratchet baseline equal to the repo's count on
the day it lands, so the number can fall and never rise.

The first build after wiring it up is not "done" until you have run
`verify-byte-identity` between the output the surface shipped before and the
output it ships now. For a brand-new surface with no before, the proof is the
gate and a rendered page in a real browser.

## Consumers

| Repo | Status |
|---|---|
| `gab-site` | PR [#2](https://github.com/andrew22lane/gab-site/pull/2) open to `main`, 2026-09-07 |
| `design-hacker-apex` | PR [#11](https://github.com/andrew22lane/design-hacker-apex/pull/11) open to `staging`, 2026-09-07 |
| `bex-site` | pending, after its `staging` → `main` merge lands |

Each consumer's Cloudflare Pages project needs `NPM_TOKEN` set before its next
build, and this package needs those repos added under its own Actions access
list before any CI job in them runs `npm install`.
