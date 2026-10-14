#!/usr/bin/env bash
# Build + run the iOS app on a simulator.
#
#   pnpm dev:mobile             # iPhone 17 Pro
#   pnpm dev:mobile "iPhone Air" # any available simulator
#
# iPhone 17 Pro is Kaan's dev simulator. Agents build and test on
# iPhone 17 (see apps/ios/AGENTS.md) so their installs never kill this app.
#
# Rebuilds the Rust core first: the committed xcframework goes stale whenever
# the UniFFI surface moves, and the Swift build then fails on a checksum symbol.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
device="${1:-${MEMRY_IOS_DEVICE:-iPhone 17 Pro}}"

"$repo_root/crates/memry-core/build-xcframework.sh"

cd "$repo_root/apps/ios"
xcodebuild -project Memry.xcodeproj -scheme Memry -configuration Debug \
  -destination "platform=iOS Simulator,name=$device" build

xcrun simctl boot "$device" 2>/dev/null || true
open "/Applications/Xcode.app/Contents/Applications/DeviceHub.app" 2>/dev/null ||
  open -a Simulator 2>/dev/null || true

app="$(xcodebuild -project Memry.xcodeproj -scheme Memry -configuration Debug \
  -destination "platform=iOS Simulator,name=$device" -showBuildSettings 2>/dev/null |
  awk '/ BUILT_PRODUCTS_DIR = /{print $3; exit}')/Memry.app"
bundle_id="$(defaults read "$app/Info.plist" CFBundleIdentifier)"
xcrun simctl install "$device" "$app"
xcrun simctl launch --console-pty "$device" "$bundle_id"
