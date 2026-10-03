#!/usr/bin/env bash
# Usage: scripts/push-data-commit.sh <message> <path>...
#
# Commits the given data files as github-actions[bot] if they changed and
# pushes to the branch the workflow ran from, writing changed=true|false to
# $GITHUB_OUTPUT. The checkout must use the DATA_DEPLOY_KEY deploy key: main's
# ruleset requires a pull request's verify check, which only a bypass actor
# like that key gets around, and a push over the key, unlike one made with
# GITHUB_TOKEN, starts deploy.yml and both E2E workflows.
set -euo pipefail

message="$1"
shift

if git diff --quiet -- "$@"; then
  echo "$message: nothing changed"
  echo "changed=false" >> "$GITHUB_OUTPUT"
  exit 0
fi
git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
git add -- "$@"
git commit -m "$message"
for attempt in 1 2 3; do
  git pull --rebase origin "$GITHUB_REF_NAME" && git push origin "HEAD:$GITHUB_REF_NAME" && break
  [ "$attempt" = 3 ] && exit 1
  sleep 15
done
echo "changed=true" >> "$GITHUB_OUTPUT"
