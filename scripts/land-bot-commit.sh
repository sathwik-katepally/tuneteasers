#!/usr/bin/env bash
# Lands a data refresh workflow's commit (HEAD) on the branch it ran from.
#
# main requires a passing "verify" check on the pushed commit, and a push made
# with GITHUB_TOKEN starts no workflows, so the commit could never carry one.
# A dispatch is the one event GITHUB_TOKEN may start: the commit goes to a side
# branch, verify.yml is dispatched there, and the same commit is pushed to main
# once it passes. That push starts no deploy either, so the deploy is
# dispatched too. The job needs contents: write and actions: write.
set -euo pipefail

target="$GITHUB_REF_NAME"
git pull --rebase origin "$target"
if [ "$target" != main ]; then
  git push origin "HEAD:$target"
  exit 0
fi

side="bot/data-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
trap 'git push -q origin --delete "$side" || true' EXIT

# main can move while verify runs (a long snips night), which rejects the push;
# rebase and verify again.
for attempt in 1 2 3; do
  sha=$(git rev-parse HEAD)
  git push -f origin "HEAD:refs/heads/$side"
  gh workflow run verify.yml --ref "$side"
  run=""
  for _ in $(seq 60); do
    run=$(gh run list --workflow verify.yml --branch "$side" --event workflow_dispatch --json databaseId,headSha \
      --jq ".[] | select(.headSha == \"$sha\") | .databaseId" | head -n1)
    [ -n "$run" ] && break
    sleep 5
  done
  [ -n "$run" ] || { echo "verify run for $sha never showed up"; exit 1; }
  gh run watch "$run" --exit-status --interval 15 > /dev/null
  if git push origin "HEAD:main"; then
    gh workflow run deploy.yml --ref main
    exit 0
  fi
  echo "main moved during verify (attempt $attempt), rebasing"
  git pull --rebase origin main
done
exit 1
