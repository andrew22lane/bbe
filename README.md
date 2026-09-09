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
| `tools/contrast-scan.mjs` | `bbe contrast`. Renders a page in BOTH colour schemes in a real browser and finds light/dark colour failures: WCAG contrast, and the half-wired detector. Its in-page half is `tools/contrast-page.js`. |
| `tools/verify-byte-identity.mjs` | Walks two build trees, sha256s every file, exits 1 on any difference. The proof every migration ships with. |
| `bin/bbe-new-surface` | The scaffold. Writes a new site or worker that reads a brand pack for every colour and has the gate in CI at a baseline of zero. `bbe new-surface` on the CLI. |
| `bin/bbe-gate` | The repo gate a consumer runs in CI: the drift scan plus the ratchet against its own `bbe.config.json`. Installed, never copied. `bbe-gate` on the CLI. |
| `bin/bbe` | The subcommand front door, so `npx @andrew22lane/bbe <thing>` works. Pure delegation. |
| `tools/starter-tokens.mjs` | The two things a brand-blind starter page needs: one custom property per palette colour, named from the pack's own key, and two measured placeholder roles. |
| `test/smoke.mjs` | Scaffolds both kinds from `test/fixtures/fixture.brandpack.json`, builds them, and asserts the gate reads zero. Runs in CI on every PR. |

Brand packs still live in the vault (`dh-hub/vault/core/brand-packs/`). Phase 2
moves them in here so a brand change becomes a versioned release.

## `bbe contrast`

```
bbe contrast <url|file|glob> [--scheme light|dark|both] [--viewport 1440x1000]
                             [--json <out>] [--fail-on contrast|halfwired|both|none]
```

A grep cannot find these. The failure is a token that flips in one scheme and
not the other, so the defect only exists in the computed cascade, in one
scheme. The only instrument that can see it is a real engine rendering the page
twice. Puppeteer, both schemes, computed styles.

**Check A, contrast.** WCAG 2.1 ratio, per scheme. 4.5:1 for normal text, 3:1
for large text and for graphical objects. Text AND svg `stroke`/`fill`, because
the near-invisible arrows on the Club are a stroke and a text-only checker walks
straight past them.

**Check B, half-wired.** The same element compared across the two schemes. If
the foreground moved and the background did not, or the reverse, a token got a
dark value and its partner did not. It fires even when the contrast survives,
which is what makes it a gate rather than a spot check.

Findings are grouped **by root cause**. One bad rule that hits 2,472 nodes reads
as one finding naming the rule, the token and the count. Multi-page runs add a
rollup that collapses the same cause across pages and ranks by element count.

Exit code is 0 unless `--fail-on` names a category that produced findings, so it
can run before anyone has fixed anything.

### What it knows it cannot see

- A `background-image` or gradient anywhere in the background stack is reported
  UNKNOWN, never averaged into a number that might pass.
- `<use>` sprite references are counted and reported as unmeasured. The ink is
  drawn by the referenced symbol, in another document, unreachable from
  `querySelectorAll`. Measuring the `<use>` element's own initial black
  reported the Club's glyph covers as failing when they are fine.
- Rule attribution is best-effort cascade: highest specificity, then last in
  document order, inline style first, state selectors (`:hover`) only as a last
  resort because nothing is hovered in a headless render.

### Self-test

```
node test/contrast.mjs
```

Plants a half-wired token whose contrast survives, a genuine low-contrast pair
that is correctly wired, an svg stroke that vanishes in dark inside an
`@import`-ed sheet, a correctly-wired control, a `<use>` sprite and a
screen-reader-only label, then asserts each lands in its own category and the
three clean ones stay clean. A detector that has only ever returned clean has
not been tested.

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
npm install @andrew22lane/bbe@1.2.0
```

That is the GitHub Packages form and it needs a token. What every consumer in the
estate actually ships is the **git tag** form, which needs no registry, no `.npmrc`
and no secret anywhere:

```json
"dependencies": { "@andrew22lane/bbe": "github:andrew22lane/bbe#v1.2.0" }
```

Either way, pin an EXACT version. No carets, no ranges, no branch names. A range
lets a build pick up an engine change nobody diffed, which is the failure this
package exists to end.

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
(`v1.2.0`). The Action publishes to GitHub Packages using the workflow's own
`GITHUB_TOKEN`; there is no PAT and no repository secret in this repo. If a
publish fails, fix it and tag one patch higher. Never force-move a tag that has
been pushed. Consumers then change one line each: the pinned version in their
`package.json`. Nobody copies a file, and a rollback is that same one line.

## New surface

One command. It is the answer to why the estate drifted in the first place.

```
npx @andrew22lane/bbe new-surface --pack <slug> --kind site|worker --name <repo-name>
```

Every surface that drifted drifted for the same reason: a new repo was hand-built by
somebody typing CSS. Twenty-one surfaces, twenty-one chances to type a hex, and the
drift report on 2026-09-07 read 406 hits across `origin/main`. The gate always
arrived after the mess, because nothing was enforced at the moment a repo was born.
This is that enforcement. A repo the scaffold writes starts at **zero** and has the
gate in its own CI on its first commit, so there is no cleanup pass to schedule.

```
npx @andrew22lane/bbe new-surface --pack gabriella       --kind site   --name gab-notes
npx @andrew22lane/bbe new-surface --pack heathers-heroes --kind worker --name hh-thing
```

| Flag | What it does |
|---|---|
| `--pack <slug>` | The pack, by slug. Nine live in the vault today. |
| `--kind site\|worker` | A static site on the engine, or a Cloudflare Worker. |
| `--name <repo-name>` | The repo name, and for a worker the `wrangler.toml` name. |
| `--dir <path>` | Where to write it. Default `~/dh-work/<name>`. |
| `--pack-file <path>` | Read the pack from this exact file, instead of a packs dir. |
| `--packs-dir <path>` | Where to look for `<slug>.brandpack.json`. Default `$BBE_PACKS_DIR`, then `~/dh-work/dh-hub/vault/core/brand-packs`. |
| `--engine <spec>` | The dependency spec to pin. Default `github:andrew22lane/bbe#v<this version>`. |
| `--force` | Write into a non-empty directory this tool did not create. |

**It does not ship the packs.** A pack is compiled from live sources and lives in the
vault; this reads the one you name and MIRRORS it into the new repo's `brand/`, with a
`tools/pack-parity.mjs` guarding the mirror the same way every other consumer does.
It does not create a GitHub repo, does not push, and does not deploy. It writes files,
prints the next three commands, and stops.

It is idempotent: run it twice into the same directory and the second run writes
nothing and says so. It refuses a non-empty directory it did not create.

### What a site gets

```
build.mjs      structure and routes. imports createEngine + resolvePack from the package.
site.css       structure. every colour is var(--bbe-*).
brand/         the pack mirror.
bbe.config.json  pack, excludes, and the gate's ratchet baseline at 0
tools/         pack-parity.mjs
.github/       brand-gate.yml — eight lines, calls the reusable gate, plus this repo's own build job
```

### What a worker gets

```
src/index.js             one page. colours come from src/tokens.generated.js.
src/tokens.generated.js  GENERATED from the pack by npm run tokens. not committed.
tools/build-tokens.mjs   a shim: invokes the PACKAGE's build-tokens against brand/<slug>.brandpack.json
wrangler.toml            name, entry, pinned compatibility_date, no custom domain
brand/ tools/ .github/   same as a site
```

### The gate the scaffold wires

`bbe-gate`, from the package, not a vendored copy of it. Before this, a repo on the
gate carried three files to run one check: a byte-copy of `brand-drift.mjs`, its own
`brand-gate-check.mjs`, and a `gate-parity.mjs` whose entire job was proving the copy
had not drifted. `npx bbe-gate` is that check installed, so the parity file has
nothing left to guard and does not exist in a scaffolded repo.

The ratchet contract is deliberately unchanged: the job fails only when the BRAND
count RISES above the `baseline` in `bbe.config.json`. A scaffolded repo starts at 0, so
it should never need lowering, and needing a raise means a brand fact got typed into
code, which is the bug. On top of `brand-drift`'s own exclusions (`node_modules`,
`dist`, dot-paths, `*.brandpack.json`, and any file whose first 400 characters say
GENERATED and name its brandpack) `bbe-gate` also excludes `tools`, which holds the
token plumbing rather than page paint.

### One config file, and why it has an `exclude` list

`bbe.config.json` at the repo root is the whole configuration:

```json
{ "pack": "gabriella", "exclude": ["data"], "baseline": 4 }
```

The baseline used to live in a second file that nothing else read. Two files to
configure one check is one file too many, so it folded in. A repo still carrying the
old `tools/brand-gate-baseline.json` keeps gating off it, with a note, so nothing goes
dark mid-migration.

`exclude` is ADDITIVE to the defaults, the same contract `vault/core/engine/estate.json`
already uses, and it exists because of a real bug: bex CI read 110 brand hits while the
nightly estate report read 283 on the same unchanged tree. That was never two scanners.
It was two exclude lists reaching one scanner, one of them written down in estate.json
and the other one not written down anywhere. Now the repo declares its own list out
loud, next to its baseline, and a repo's `exclude` should be the same list its
estate.json row carries.

### The reusable workflow

The gate's CI steps live in `.github/workflows/bbe-gate.yml` in this repo, behind
`workflow_call`. A consumer's whole workflow is the eight lines in
`templates/brand-gate.yml`:

```yaml
jobs:
  brand-gate:
    uses: andrew22lane/bbe/.github/workflows/bbe-gate.yml@v1.2.0
```

It checks out, sets up Node, installs (`npm ci` with a lockfile, `npm install`
without), runs `bbe-gate --selftest`, then runs `bbe-gate`. Migrating an existing repo:
`docs/MIGRATE-GATE.md`.

### The placeholder roles, and why they are named the way they are

A scaffolded page needs a background and a text colour on day one, and it cannot
mention `wine` or `cream`, because the moment it does it holds a brand fact. So the
generator emits one custom property per palette colour, named from the pack's own key
(`--bbe-wine`, `--bbe-shadow-deep`), plus two aliases it MEASURES: the lightest colour
in the pack becomes `--bbe-starter-ground` and the darkest becomes `--bbe-starter-ink`,
by relative luminance. Nothing is invented; every number is the pack's.

They are not called `--bbe-ground` and `--bbe-ink`. They were, for about ten minutes,
and gabriella's pack has a palette key literally named `ink`, so the block emitted
`--bbe-ink:var(--bbe-ink)`. A custom property that references itself is invalid at
computed-value time: the browser drops it, `color` falls back to the initial value, and
nothing complains — not the build, not the gate, not a byte-identity check. Same shape
of silent defect as the radius string that shipped a square corner on gab-site. The
aliases now live in their own namespace and a collision with a pack key throws.

Those two are placeholders and every scaffolded README says so. A real page points at
the pack's named properties once the brand has ruled its roles.

### build-tokens now has two modes, decided by the pack

The **embody shape** (`palette` + `dark` + `lines` + `scalars` + `scalarLines` +
`darkScalars` + `darkScalarLines`) emits the full light/dark block exactly as it did in
1.0.1; its output bytes are frozen and proven identical. Every other pack in the vault
carries `outputs.web.palette` and none of the rest, and gets the **starter shape**
above. A pack carrying only SOME of the seven fails loudly rather than being guessed at.

### Testing it

`node test/smoke.mjs` scaffolds both kinds from an invented fixture pack, installs this
checkout into each, builds, and asserts the gate reads zero. It runs in CI on every pull
request. The fixture is the only pack this repo ships and it belongs to no client.

## How to add a consumer

**For a brand-new surface, use `bbe new-surface` above; it does all of this.** What
follows is the same four things by hand, which is what an EXISTING repo being migrated
onto the package needs.

A new surface needs four things and none of them is a copy of this repo. One, the
dependency pinned to an exact tag, `"@andrew22lane/bbe": "github:andrew22lane/bbe#v<tag>"`
— the repo is public, so this needs no registry, no `.npmrc` and no token, on this Mac
or in a runner or on Cloudflare's builder. Two, `import { createEngine } from
'@andrew22lane/bbe/engine'` in its build script, and no `engine/` folder of its
own; if it already has one, delete it in the same PR that adds the dependency,
along with any `tools/engine-parity.mjs`, which now has nothing to guard. Three,
its brand pack, which stays in the vault in this phase and is mirrored into
`brand/` with `tools/pack-parity.mjs` still guarding that mirror. Four, the gate
in CI, which is `bbe.config.json` plus the eight-line workflow from
`templates/brand-gate.yml`, with a ratchet baseline equal to the repo's count on
the day it lands, so the number can fall and never rise. `docs/MIGRATE-GATE.md`
is the exact recipe.

The first build after wiring it up is not "done" until you have run
`verify-byte-identity` between the output the surface shipped before and the
output it ships now. For a brand-new surface with no before, the proof is the
gate and a rendered page in a real browser.

## Consumers

| Repo | Status |
|---|---|
| `gab-site` | on `v1.0.1`, merged to `main` 2026-09-07. No engine mirror. |
| `design-hacker-apex` | on `v1.0.1`, merged to `staging` 2026-09-07. No engine mirror. |
| `bex-site` | pending. Its `engine/lib.mjs` IS the source of `v1.0.1`; it migrates after its `staging` → `main` merge lands. |

Nobody is bumped by a release here. A consumer moves when somebody changes its one
pinned line and proves the output, and never as a side effect of a tag being pushed.
