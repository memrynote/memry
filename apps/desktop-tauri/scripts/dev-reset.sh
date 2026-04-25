#!/usr/bin/env bash
set -euo pipefail

# Wipe memry app data for the selected device profile (or all profiles).
#
# Usage:
#   ./scripts/dev-reset.sh           # resets default profile
#   ./scripts/dev-reset.sh A         # resets profile A
#   ./scripts/dev-reset.sh --all     # resets every memry-* profile

BASE="$HOME/Library/Application Support/com.memry.memry"

if [[ "${1:-}" == "--all" ]]; then
  echo "Wiping $BASE"
  rm -rf "$BASE"
  exit 0
fi

DEVICE="${1:-default}"
TARGET="$BASE/memry-$DEVICE"
echo "Wiping $TARGET"
rm -rf "$TARGET"
echo "Done. Next app launch will re-apply migrations."
