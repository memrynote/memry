#!/usr/bin/env bash
# Build + run the iOS app on a simulator.
#
#   pnpm dev:mobile                 # iPhone 17
#   pnpm dev:mobile "iPhone 17 Pro" # any available simulator
#
# Rebuilds the Rust core first: the committed xcframework goes stale whenever
# the UniFFI surface moves, and the Swift build then fails on a checksum symbol.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
device="${1:-${MEMRY_IOS_DEVICE:-iPhone 17}}"

"$repo_root/crates/memry-core/build-xcframework.sh"

cd "$repo_root/apps/ios"
# Default DerivedData on purpose: InjectionNext finds the build log there to
# learn how to recompile a saved file. A custom -derivedDataPath hides it.
xcodebuild -project Memry.xcodeproj -scheme Memry -configuration Debug \
  -destination "platform=iOS Simulator,name=$device" build

# Hot reload daemon. Menu bar icon: orange = app connected, green = recompiling.
if [ -d /Applications/InjectionNext.app ]; then
  open -a InjectionNext --args -projectPath "$repo_root/apps/ios"
fi

xcrun simctl boot "$device" 2>/dev/null || true
open "/Applications/Xcode.app/Contents/Applications/DeviceHub.app" 2>/dev/null ||
  open -a Simulator 2>/dev/null || true

app="$(xcodebuild -project Memry.xcodeproj -scheme Memry -configuration Debug \
  -destination "platform=iOS Simulator,name=$device" -showBuildSettings 2>/dev/null |
  awk '/ BUILT_PRODUCTS_DIR = /{print $3; exit}')/Memry.app"
bundle_id="$(defaults read "$app/Info.plist" CFBundleIdentifier)"
xcrun simctl install "$device" "$app"
# SIMCTL_CHILD_* passes through to the app: the scheme's env vars are Xcode-only.
SIMCTL_CHILD_INJECTION_PROJECT_ROOT="$repo_root/apps/ios" \
  xcrun simctl launch --console-pty "$device" "$bundle_id"
