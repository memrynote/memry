#!/usr/bin/env bash
# Desktop Tauri CI gate's rule for the sharded e2e specs: e2e-gate.sh <e2e-build result> <e2e result>.
# A failed or cancelled job fails, and so does a built app whose shards did not all pass: e2e skips
# itself after a failed build, so `skipped` there would read as a pass and drop every spec.
# scripts/ci-tier.test.mjs runs it.
set -euo pipefail
build=$1
specs=$2
case " $build $specs " in *" failure "*|*" cancelled "*) echo "::error::e2e-build $build, e2e $specs"; exit 1 ;; esac
if [ "$build" = success ] && [ "$specs" != success ]; then echo "::error::e2e-build passed but the e2e specs result was $specs"; exit 1; fi
echo "e2e-build $build, e2e $specs"
