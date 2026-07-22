#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# No CI escape hatch: placeholder pins now warn instead of failing, so the check
# is safe to run everywhere and is only useful where releases are actually built.
node --experimental-strip-types --experimental-transform-types \
  "$APP_ROOT/scripts/check-cert-hashes.ts"
