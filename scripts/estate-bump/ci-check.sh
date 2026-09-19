#!/bin/zsh
# ci-check.sh <repo:pr> [<repo:pr> ...]      (repo = GitHub name under andrew22lane)
#
# Waits for every PR's checks to finish, then reads each brand-gate run's LOG and
# prints the gate version that actually ran and what the script check read. A green
# check alone doesn't prove the new gate ran: a stale pin runs the old one and
# passes too. `0 pages` on a site (as opposed to a worker) means buildDir is missing.
prs=("$@")
for i in $(seq 1 90); do
  pend=0; for p in $prs; do gh pr checks ${p##*:} --repo andrew22lane/${p%%:*} 2>&1 | grep -q -E "pending|no checks" && pend=$((pend+1)); done
  [ $pend -eq 0 ] && break; sleep 20
done
for p in $prs; do r=${p%%:*}; n=${p##*:}
  line=$(gh pr checks $n --repo andrew22lane/$r 2>&1 | grep -i 'brand-gate' | head -1)
  st=$(echo "$line" | awk -F'\t' '{print $2}'); run=$(echo "$line" | grep -o 'runs/[0-9]*' | cut -d/ -f2)
  log=$(gh run view $run --repo andrew22lane/$r --log 2>/dev/null)
  ver=$(echo "$log" | grep -o 'bbe [0-9.]* bbe-gate' | head -1)
  sc=$(echo "$log" | grep -o 'scripts      every inline.*' | head -1 | sed -E 's/.*\((.*)\)$/\1/')
  other=$(gh pr checks $n --repo andrew22lane/$r 2>&1 | grep -v -i brand-gate | awk -F'\t' '{print $1"="$2}' | tr '\n' ' ')
  echo "$r#$n gate=$st [$ver] ($sc) other: $other"
done
