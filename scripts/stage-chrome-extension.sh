#!/usr/bin/env bash
# Copies only extension/ to a temp path with no Python/venv files, for Chrome "Load unpacked".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="${TMPDIR:-/tmp}/feed-blocker-chrome-extension"
rm -rf "$STAGE"
cp -R "$ROOT/extension" "$STAGE"
echo ""
echo "Chrome → Extensions → Developer mode → Load unpacked → select this folder:"
echo "  $STAGE"
echo ""
if [[ "$(uname -s)" == "Darwin" ]]; then
  open "$STAGE"
fi
