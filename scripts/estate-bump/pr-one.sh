#!/bin/zsh
# pr-one.sh <repo-dir-name> <base-branch> <vX.Y.Z> [extra-note.md]
#
# After bump-one.sh passed: commits the bump BY PATH in the worktree, pushes, opens
# the PR with that repo's own gate output in the body, prints "PR <repo> <url>".
# Put anything repo-specific (a buildDir added, an engine-diff proof) in extra-note.md.
set -u
dir=$1; base=$2; ver=$3; extra=${4:-}
LOGDIR=${LOGDIR:-/tmp/bbe-estate-bump}
wt=~/dh-work/$dir-bbe-${ver#v}
cd $wt || exit 1
slug=$(git remote get-url origin | sed 's|.*github.com[:/]||;s|\.git$||')
branch=$(git branch --show-current)
files=(${(f)"$(git diff --name-only)"})
from=$(git diff package.json | grep '^-.*bbe#v' | grep -o 'v[0-9.]*' | head -1)
log=$LOGDIR/$dir.gate.log
[ -f $LOGDIR/$dir.regate.log ] && log=$LOGDIR/$dir.regate.log
gate=$(grep -E '^  (scripts|kit check|BRAND hits|KIT hits|HEAD hits|BGVIDEO hits|SCRIPT hits)|^PASS|^FAIL' $log | sed 's/^  //')
printf 'Gate: bump bbe %s to %s\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n' "$from" "$ver" > $LOGDIR/$dir.msg.txt
git commit -q -F $LOGDIR/$dir.msg.txt -- $files || { echo "PR $dir COMMIT-FAIL"; exit 1; }
git push -q -u origin $branch 2>&1 | grep -v '^remote:'
{
  echo "Moves this repo's gate from bbe $from to $ver. What changed in $ver: andrew22lane/bbe CHANGELOG.md."
  echo
  echo "**Changed:** \`$(echo $files | sed 's/ /`, `/g')\`. Both pins (package + workflow \`uses:\`) move together."
  echo
  echo "**Gate $ver run locally on this branch:**"
  echo '```'; echo "$gate"; echo '```'
  [ -n "$extra" ] && [ -f "$extra" ] && { echo; cat "$extra"; }
  echo
  echo "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
} > $LOGDIR/$dir.body.md
url=$(gh pr create --repo $slug --base $base --head $branch --title "Gate: bbe $ver" --body-file $LOGDIR/$dir.body.md 2>&1 | tail -1)
echo "PR $dir $url"
