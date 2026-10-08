#!/usr/bin/env bash
# Puts a pull request's receipts on the `receipts` branch, where the PR comment shows them from raw.githubusercontent.com
# (.github/workflows/receipts.yml):
#   receipts-publish.sh <pr> <sha> <dir>    pr-<pr>/ becomes <dir> under pr-<pr>/<sha>/ (older commits of the PR are dropped)
#   receipts-publish.sh <pr>                pr-<pr>/ is removed, when the PR is closed
#
# The branch is one orphan commit, rewritten on every change: the GIFs of closed PRs leave no history behind to bloat the
# repository. Two PRs publishing at once both read the branch; whoever pushes second finds it moved (--force-with-lease)
# and starts over from the new state.
# Needs GH_TOKEN (contents: write) and GITHUB_REPOSITORY.
set -euo pipefail
pr=$1
sha=${2:-}
src=${3:-}
[ -z "$src" ] || src=$(realpath "$src")
url="https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

for attempt in 1 2 3 4 5; do
  work=$(mktemp -d)
  if git clone -q --depth=1 --branch receipts "$url" "$work" 2>/dev/null; then
    old=$(git -C "$work" rev-parse HEAD)
  else
    git init -q "$work"
    old=''
  fi
  cd "$work"
  rm -rf "pr-$pr"
  if [ -n "$src" ]; then mkdir -p "pr-$pr/$sha" && cp -r "$src"/. "pr-$pr/$sha/"; fi
  cat > README.md <<'EOF'
Video receipts of the open pull requests, written by .github/workflows/receipts.yml on master.
One folder per pull request, removed when it closes. This branch is rewritten on every change: do not build on it.
EOF
  git checkout -q --orphan next
  git add -A
  git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit -q -m "Receipts of the open pull requests"
  if git push -q --force-with-lease="receipts:$old" "$url" next:receipts; then
    echo "receipts branch updated: pr-$pr"
    exit 0
  fi
  echo "receipts branch moved under us (attempt $attempt); starting over"
  cd / && rm -rf "$work"
  sleep $((attempt * 5))
done
exit 1
