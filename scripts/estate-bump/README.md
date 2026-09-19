# estate-bump: move every consumer onto a new bbe tag

Nobody gets a new gate until their pins move, and there are ~18 consumers. These
three scripts are the v1.7.0 rollout (2026-09-19, 18 repos in one pass) made
repeatable. Not shipped in the package; run from a checkout of this repo.

## The run

1. **Find the consumers and their pins.** Every repo under `~/dh-work` with a
   `bbe.config.json` or a `bbe-gate.yml@` line. The README's Consumers table is the
   last measured list. Note each repo's base branch: most are `main`, and
   `design-hacker-apex` takes work on `staging`, then gets a staging → main promote.
2. **`bump-one.sh <repo> <base> vX.Y.Z`** for each one (they can run in parallel).
   One RESULT line each: old pin, installed version, lockfile commit, gate exit code,
   hit counts, and what the script check read.
3. **Read every non-zero gate.** Exit 2 is almost always BLIND: an engine site with no
   `buildDir`, so a check read 0 pages. Fix it in the same PR: add `"buildDir": "dist"`,
   run the build in the worktree, and save the re-run gate output as
   `$LOGDIR/<repo>.regate.log`.
4. **Repos whose build imports `@andrew22lane/bbe/engine`** (`git grep -l
   '@andrew22lane/bbe/engine'`): build with the old and new engine into separate
   folders and diff, ignoring `?v=` cache busters and timestamps. Put the result in
   the PR. "Site unchanged" is a claim, and the diff is its proof.
5. **`pr-one.sh <repo> <base> vX.Y.Z [note.md]`** commits by path, pushes, opens the PR.
6. **`ci-check.sh repo:pr ...`** waits for CI and reads each gate LOG for the version
   that ran.
7. **Merge by deploy consequence.** A PR with a Cloudflare Pages / Workers Builds check,
   or a workflow that deploys on push, deploys on merge: that's Andrew's click.
   Everything else can merge once it's OPEN + CLEAN + green on its HEAD. Prove each
   merge with `git merge-base --is-ancestor <head> origin/<base>`.

## Traps met on the first run

- **`npm install -D` moves the dependency.** bump-one keeps it where it was.
- **A commit pushed after the PR merged goes nowhere.** Check `gh pr view --json state`
  before pushing a follow-up, and open a new PR if it's already merged.
- **A build's `OUT` can be repo-relative.** gab-site wrote an absolute scratch path
  inside the repo. Build into the repo's own ignored `dist-*` folders.
- **A promote carries whatever else is on staging.** Dry-run it first:
  `git merge-tree --write-tree origin/main origin/staging`, then
  `git diff --stat origin/main <tree>`.
