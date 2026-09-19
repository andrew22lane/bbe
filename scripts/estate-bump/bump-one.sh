#!/bin/zsh
# bump-one.sh <repo-dir-name> <base-branch> <vX.Y.Z>
#
# Moves one consumer repo onto a new bbe tag and proves the gate passes, WITHOUT
# committing. Makes its own worktree at ~/dh-work/<repo>-bbe-<ver> off origin/<base>,
# moves BOTH pins (package.json + every workflow `uses: ...bbe-gate.yml@`), refreshes
# the lockfile to the tag's commit, runs the installed gate, prints one RESULT line.
#
# Keeps @andrew22lane/bbe wherever it already sits (dependencies vs devDependencies):
# `npm install -D` would move it, and a repo whose build imports the engine needs it
# in dependencies.
#
# Does NOT build. A repo with "buildDir" in bbe.config.json needs its build run
# before the gate means anything: run the workflow's build-command in the worktree,
# then `node node_modules/@andrew22lane/bbe/bin/bbe-gate` again.
set -u
dir=$1; base=$2; ver=$3
LOGDIR=${LOGDIR:-/tmp/bbe-estate-bump}; mkdir -p $LOGDIR
src=~/dh-work/$dir
wt=~/dh-work/$dir-bbe-${ver#v}
branch=chore/bbe-${ver#v}
cd $src || { echo "RESULT $dir NO-DIR"; exit 1; }
git fetch -q origin
if git ls-remote --exit-code --heads origin $branch >/dev/null 2>&1; then echo "RESULT $dir BRANCH-EXISTS"; exit 1; fi
[ -d $wt ] || git worktree add -q -b $branch $wt origin/$base || { echo "RESULT $dir WORKTREE-FAIL"; exit 1; }
cd $wt
from=$(grep -o 'bbe#v[0-9.]*' package.json | head -1)
sed -i '' -E "s|bbe#v[0-9.]+|bbe#$ver|" package.json
for wf in .github/workflows/*.yml(N); do sed -i '' -E "s|bbe-gate\.yml@v[0-9.]+|bbe-gate.yml@$ver|" $wf; done
dev=$(node -p "!!(require('./package.json').devDependencies||{})['@andrew22lane/bbe']")
flag=(); [ "$dev" = "true" ] && flag=(-D)
if [ -f package-lock.json ]; then
  npm install $flag "github:andrew22lane/bbe#$ver" --no-audit --no-fund >$LOGDIR/$dir.npm.log 2>&1
  sha=$(node -e "const l=require('./package-lock.json');console.log((l.packages['node_modules/@andrew22lane/bbe']||{}).resolved||'none')" | sed 's/.*#//' | cut -c1-7)
else
  npm install --no-package-lock --no-audit --no-fund >$LOGDIR/$dir.npm.log 2>&1
  sha=nolock
fi
inst=$(node -p "require('./node_modules/@andrew22lane/bbe/package.json').version" 2>/dev/null)
node node_modules/@andrew22lane/bbe/bin/bbe-gate > $LOGDIR/$dir.gate.log 2>&1
code=$?
scripts=$(grep -E '^  scripts ' $LOGDIR/$dir.gate.log | sed -E 's/.*\((.*)\)$/\1/')
hits=$(grep -E '^  (BRAND|KIT|HEAD|BGVIDEO|SCRIPT) hits' $LOGDIR/$dir.gate.log | sed -E 's/^  ([A-Z]+) hits: ([0-9]+).*/\1=\2/' | tr '\n' ' ')
files=$(git diff --name-only | tr '\n' ' ')
echo "RESULT $dir from=${from#bbe#} inst=$inst lock=$sha gate=$code | $hits| $scripts | changed: $files"
