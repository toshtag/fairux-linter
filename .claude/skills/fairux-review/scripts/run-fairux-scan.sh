#!/usr/bin/env bash
# Thin wrapper: run the deterministic FairUX linter on a static HTML file.
# The CLI is the source of truth for detection; this script just builds it if needed and runs it.
#
# Usage:  run-fairux-scan.sh <path-to-html> [json|markdown|sarif]
#   format defaults to json (the documented public-API report).
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: run-fairux-scan.sh <path-to-html> [json|markdown|sarif]" >&2
  exit 2
fi

target="$1"
format="${2:-json}"

# Resolve the repo root from this script's location (.claude/skills/fairux-review/scripts/).
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../../.." && pwd)"
cli="$repo_root/apps/cli/dist/index.js"

# Build the CLI on first use (or if dist is missing).
if [ ! -f "$cli" ]; then
  echo "fairux: building CLI (first run)…" >&2
  (cd "$repo_root" && pnpm --filter @fairux/cli build >&2)
fi

exec node "$cli" scan "$target" --format "$format"
