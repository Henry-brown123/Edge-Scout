#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <path-to-plan-file>" >&2
  exit 1
fi

SRC="$1"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$REPO_ROOT/plan.html"

if [[ ! -f "$SRC" ]]; then
  echo "Error: '$SRC' not found" >&2
  exit 1
fi

cp "$SRC" "$DEST"

cd "$REPO_ROOT"
git add plan.html
git commit -m "Update project plan"
git push origin main

echo "plan.html updated and pushed to main"
