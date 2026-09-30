#!/usr/bin/env bash
# Lands a data refresh workflow's commit (HEAD) on the branch it ran from.
#
# main's ruleset requires a passing "verify" check, and in practice that only
# lets commits in through a merged pull request: a direct push is refused even
# when the commit already carries a passing verify. A pull request opened with
# GITHUB_TOKEN starts no workflows, but a dispatch is the one event
# GITHUB_TOKEN may start, so verify.yml is dispatched on the PR's branch, and
# the PR is merged once it passes. The merge starts no deploy either, so the
# deploy is dispatched too. A PR whose verify fails stays open for a person.
# The job needs contents, pull-requests and actions: write, and the repo must
# let GitHub Actions create pull requests.
set -euo pipefail

target="$GITHUB_REF_NAME"
git pull --rebase origin "$target"
if [ "$target" != main ]; then
  git push origin "HEAD:$target"
  exit 0
fi

side="bot/data-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
sha=$(git rev-parse HEAD)
git push origin "HEAD:refs/heads/$side"
gh pr create --base main --head "$side" --title "$(git log -1 --format=%s)" \
  --body "From $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
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
# The ruleset can take a few seconds to see the finished check.
for attempt in 1 2 3 4 5 6; do
  gh pr merge "$side" --squash --delete-branch && break
  [ "$attempt" = 6 ] && exit 1
  sleep 10
done
gh workflow run deploy.yml --ref main
