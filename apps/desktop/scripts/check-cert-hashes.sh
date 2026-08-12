#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# No CI escape hatch: placeholder pins now warn instead of failing, so the check
# is safe to run everywhere and is only useful where releases are actually built.
# APP_ROOT is passed through so the check resolves .env.<MEMRY_ENV> from the app
# directory regardless of the caller's cwd — that file is what a packaged build
# stages as app-config, so it names the host the shipped app actually dials.
node --experimental-strip-types --experimental-transform-types \
  "$APP_ROOT/scripts/check-cert-hashes.ts" "$APP_ROOT"
