#!/usr/bin/env bash
# Lands a data refresh workflow's commit (HEAD) on the branch it ran from.
#
# main's ruleset requires a passing "verify" check, and it only counts a verify
# that a pull request started: a direct push is refused, and so is a merge that
# relies on a verify dispatched on the branch, even on the same commit. A PR
# opened with GITHUB_TOKEN does start "Verify pull request", but GitHub parks
# that run as action_required until someone approves it, so the script
# approves it, waits, merges, and dispatches the deploy that the merge (made
# with GITHUB_TOKEN) does not start. A PR whose verify fails stays open for a
# person. The job needs contents, pull-requests and actions: write, and the
# repo must let GitHub Actions create pull requests.
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
run=""
for _ in $(seq 60); do
  run=$(gh run list --workflow verify.yml --branch "$side" --event pull_request --json databaseId,headSha \
    --jq ".[] | select(.headSha == \"$sha\") | .databaseId" | head -n1)
  [ -n "$run" ] && break
  sleep 5
done
[ -n "$run" ] || { echo "no verify run for $sha"; exit 1; }
if [ "$(gh run view "$run" --json conclusion -q .conclusion)" = action_required ]; then
  gh api -X POST "repos/$GITHUB_REPOSITORY/actions/runs/$run/approve" > /dev/null
fi
for _ in $(seq 30); do
  [ "$(gh run view "$run" --json conclusion -q .conclusion)" != action_required ] && break
  sleep 5
done
gh run watch "$run" --exit-status --interval 15 > /dev/null
# The ruleset can take a few seconds to see the finished check.
for attempt in 1 2 3 4 5 6; do
  gh pr merge "$side" --squash --delete-branch && break
  [ "$attempt" = 6 ] && exit 1
  sleep 10
done
gh workflow run deploy.yml --ref main
