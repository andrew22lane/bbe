# MIGRATE-GATE: move a repo off its vendored gate onto `bbe-gate`

Written 2026-09-08 for `@andrew22lane/bbe` v1.2.0. One repo at a time, one PR each,
about ten minutes of work. A runner can follow this literally.

## What is wrong with the thing being replaced

Sixteen repos each carry five files to run one check:

```
tools/brand-drift.mjs            the scanner
tools/brand-gate-check.mjs       the ratchet
tools/gate-parity.mjs            proves the scanner copy has not drifted
tools/brand-gate-baseline.json   the number
.github/workflows/brand-gate.yml the steps
```

Measured on 2026-09-08, at `origin/main`, by hashing the vendored scanners:

| Copy | sha256 (first 12) | Behaviour |
|---|---|---|
| `vault/core/engine/brand-drift.mjs` (canon) | `99464bfbc95d` | excludes dot-paths |
| `bbe` package | `99464bfbc95d` | identical to canon |
| `dh-capture` | `f5fd2ec520a0` | same behaviour, one revision back |
| `gab-site` | `088807b067e6` | **does not exclude dot-paths** — an untracked `.review/` dir once put 1,072 phantom hits on a row |

Three revisions of "the gate", live at once. `gate-parity.mjs` was supposed to catch
exactly this, and it cannot: in CI it prints "source not on this machine, mirror
trusted" and exits 0, because a runner cannot see the private vault.

Second failure, worse because it is silent. The vendored `brand-gate-check.mjs` calls
`scanRepo({ repo, packPath })` with **no exclude list**. The nightly `estate-status.mjs`
calls the same function with the exclude list from `estate.json`. So bex CI read **110**
brand hits while the nightly read **283** on the same unchanged tree, and both were
"the number". That was never two scanners. It was two exclude lists reaching one
scanner, one of them written down and the other one not.

v1.2.0 fixes both: one installed scanner, and the exclude list written down in the
repo, next to its baseline, in one file.

## The config file

`bbe.config.json`, at the repo root, committed:

```json
{
  "pack": "gabriella",
  "exclude": ["data"],
  "baseline": 4
}
```

| Key | Required | Means |
|---|---|---|
| `pack` | yes | slug. The gate reads `brand/<pack>.brandpack.json` in this repo. |
| `exclude` | no, defaults `[]` | Paths ADDED to the gate's defaults. Never replaces them. |
| `baseline` | yes | The ratchet. The gate fails only when the count RISES above it. |

Any other key (`note`, say) is ignored and preserved. A `note` explaining what the
remaining hits actually are is worth writing.

**The defaults `exclude` adds to**, so you never list these: `node_modules`, `.git`,
`.wrangler`, `dist`, `dist-*`, `blog-dist`, `_astro`, `vendor`, `static/assets/vendor`,
`.bak*`, `*.bak*`, `src.bak*`, any dot-path, plus `tools` (gate fixtures and token
plumbing quote colours as data, not as page paint). Also never scanned regardless:
`*.brandpack.json`, `*.min.js`, `*.min.css`, and any file whose first 400 characters
say `GENERATED` and name a brandpack.

**Additive is the same contract `vault/core/engine/estate.json` uses**, and that is the
point: a repo's `exclude` here should be the same list its `estate.json` row carries, so
the CI number and the nightly number are the same number.

## The workflow

Replace the whole of `.github/workflows/brand-gate.yml` with `templates/brand-gate.yml`
from this package:

```yaml
name: Brand gate (lock #1 — no hardcoded hex)

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  brand-gate:
    uses: andrew22lane/bbe/.github/workflows/bbe-gate.yml@v1.2.0
```

The reusable workflow checks out, sets up Node 20, installs (`npm ci` when there is a
lockfile, `npm install` when there is not), runs `npx bbe-gate --selftest`, then runs
`npx bbe-gate`. Pin the tag; bumping the gate is then one line and rolling it back is
the same line.

If the old workflow also ran things that are **not** the gate (`npm run build`,
`npm run tokens`, `wrangler deploy --dry-run`, `tools/pack-parity.mjs`), keep them as a
second job in the same file. The `uses:` job is the gate; that job is the repo's own.

## The recipe, per repo

Run it from a worktree, not the shared checkout: `git worktree add ~/dh-work/<repo>-gate main`.

**1. Read the old config.**

```bash
cat tools/brand-gate-baseline.json     # -> {"pack": "<slug>", "brand_count": <n>, "note": "..."}
```

**2. Record the OLD count, on this tree, before changing anything.** This is the number
the PR has to reproduce.

```bash
node tools/brand-gate-check.mjs | grep 'BRAND hits'
```

**3. Write `bbe.config.json`** at the repo root. `pack` = the old `pack`.
`baseline` = the old `brand_count`. `exclude` = `[]`.

> Deliberately `[]`, not the repo's `estate.json` excludes, even though those are the
> ones the nightly uses. A migration PR changes the plumbing and nothing else, so its
> count must land on the old count exactly. Reconciling a repo's `exclude` with its
> estate row is a SECOND PR, where the number moving is the whole point and somebody
> looks at it. Doing both at once buries a number change inside a refactor.

**4. Add the dependency** if `package.json` has no `@andrew22lane/bbe`:

```json
"dependencies": { "@andrew22lane/bbe": "github:andrew22lane/bbe#v1.2.0" }
```

If it already has one pinned older, bump it to `#v1.2.0`. The engine bytes are
byte-identical across v1.0.1, v1.1.0 and v1.2.0 (`git diff v1.0.1 v1.2.0 -- engine/` is
empty), so a bump changes no build output. **If the repo has a `package-lock.json`, run
`npm install` locally after the bump and commit the refreshed lockfile**, or CI's
`npm ci` fails on a lockfile that disagrees with `package.json`.

The repo is public, so this needs no registry, no `.npmrc` and no token, on this Mac or
in a runner or on Cloudflare's builder.

**5. Delete the five vendored files.**

```bash
git rm tools/brand-drift.mjs tools/brand-gate-check.mjs tools/gate-parity.mjs \
       tools/brand-gate-baseline.json
```

`.github/workflows/brand-gate.yml` is rewritten, not deleted. Keep
`tools/build-tokens.mjs` and `tools/pack-parity.mjs`; they are not the gate.

**6. Write the workflow** from `templates/brand-gate.yml`, re-adding any non-gate steps
as a second job.

**7. Measure the NEW count.**

```bash
npm install --no-audit --no-fund
npx bbe-gate | grep 'BRAND hits'
```

**8. Check the diff is only what it should be.**

```bash
git diff --stat main
```

Expect exactly: 4 deletions under `tools/`, `bbe.config.json` added,
`.github/workflows/brand-gate.yml` modified, `package.json` modified,
`package-lock.json` modified if one exists. Anything else, stop.

**9. PR it.** Never merge without CI green.

## Acceptance, all four or it does not ship

1. **Old count == new count.** Step 2 and step 7 print the same number. If they do not,
   the migration changed semantics: the cause is almost always the `tools` default
   exclude (the repo's `tools/` held hex the old gate counted) or the dot-path exclusion
   the older vendored copies lack. Say which in the PR body and lower the baseline with
   `npx bbe-gate --write-baseline` rather than editing the number by hand.
2. **CI green on the PR**, with the `brand-gate` job actually running (a `uses:` typo
   makes a workflow that never runs, which reads as "no failures").
3. **`git diff --stat` shows only the files in step 8.**
4. **The pack mirror is still there.** `brand/<slug>.brandpack.json` is untouched; the
   gate exits 2 without it, so a green run also proves it is present.

## Ratchet rules, unchanged

- The gate fails only when the count RISES above `baseline`.
- Lower it with `npx bbe-gate --write-baseline`, in the PR that cleans the hits.
- `--write-baseline` **refuses to raise**. A count that rose means a brand fact got
  typed into code; that is the bug, not the file.
- Never raise `baseline` by hand to make a red job go green.

## Useful flags

| Flag | Does |
|---|---|
| `npx bbe-gate --repo <dir>` | Gate a tree that is not the cwd |
| `npx bbe-gate --json` | Machine-readable result, including the exact exclude list used |
| `npx bbe-gate --write-baseline` | Lower the baseline to the count just measured |
| `npx bbe-gate --selftest` | Plant a defect in a fixture, assert the scanner goes RED |

## The sixteen repos, with their mapping

`pack` and `baseline` come straight from each repo's `tools/brand-gate-baseline.json` at
`origin/main` on 2026-09-08. `exclude` is `[]` for every migration PR, per step 3. The
"estate exclude" column is the list that repo's `estate.json` row carries, which is the
follow-up PR, not this one.

| Repo | `pack` | `baseline` | lockfile | estate exclude (follow-up) | non-gate steps to keep |
|---|---|---|---|---|---|
| `gab-site` | `gabriella` | 4 | yes | `data` | `npm run parity` |
| `dh-capture` | `design-hacker` | 0 | no | — | — |
| `bex-site` | `bex-co` | 110 | yes | — | check its other two workflows are untouched |
| `design-hacker-apex` | `design-hacker` | 0 | yes | — | — |
| `embody-app` | `embody-society` | 49 | yes | `src/reading`, `tools/es-audit` | — |
| `photographerceo-site` | `kelli` | 0 | no | — | — |
| `hh-library` | `heathers-heroes` | 0 | no | — | see the HELD note below |
| `hh-calendar` | `heathers-heroes` | 0 | no | — | — |
| `dh-library` | `design-hacker` | 5 | no | — | — |
| `bexco-partner-library` | `bex-co` | 0 | no | — | — |
| `proveit-domain` | `prove-it-network` | 0 | no | — | — |
| `bex-links` | `bex-co` | 8 | no | — | leave `deploy.yml` alone; it deploys on push to `main` |
| `dh-club` | `design-hacker` | 2 | no | — | — |
| `franchise-watchlist-site` | `franchise-watchlist` | 0 | no | — | — |
| `bbe-ask` | `bex-co` | 0 | yes | `src/theme.css.js`, `emails` | — |
| `bex-forms` | `bex-co` | 0 | no | `deployed` | — |

`vhc-site` and `kelli-engine` are not on this list: neither has a brand gate to migrate.
VHC gets one inside its r5 rebuild.

**Two repos where `origin/main` is not what is live** (see PLAN-bbe-one-system §6, relay
8391 and 8393): `bex-forms` and `hh-library`. A gate-migration PR touches no runtime file
and deploys nothing, so it is safe on both. Do not let a green gate be read as
permission to deploy either one.

**One repo that deploys on merge**: `bex-links` runs `deploy.yml` on a push to `main`, so
merging its gate PR ships. That merge is Andrew's click, not a worker's.
