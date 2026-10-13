#!/usr/bin/env bash
# Build + install + launch the iOS app on a connected physical device.
#
#   pnpm dev:mobile:device                  # pick from connected devices
#   MEMRY_IOS_TEAM=ABCDE12345 pnpm dev:mobile:device
#
# Debug build, so it talks to staging (SyncEnvironment.swift). Signing uses
# the team set in Xcode unless MEMRY_IOS_TEAM overrides it.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
json="$(mktemp)"
trap 'rm -f "$json"' EXIT

xcrun devicectl list devices --json-output "$json" >/dev/null
devices=()
while IFS= read -r line; do devices+=("$line"); done < <(
  node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).result.devices
      .filter(x => x.hardwareProperties?.platform === "iOS" && x.hardwareProperties?.reality === "physical");
    for (const x of d) console.log(`${x.hardwareProperties.udid}\t${x.deviceProperties.name} (${x.connectionProperties.tunnelState ?? "?"})`);
  ' "$json"
)
if [ ${#devices[@]} -eq 0 ]; then
  echo "No physical iOS device found. Connect it and enable Developer Mode." >&2
  exit 1
fi

echo "Select device:"
select choice in "${devices[@]}"; do [ -n "${choice:-}" ] && break; done
udid="${choice%%$'\t'*}"

"$repo_root/crates/memry-core/build-xcframework.sh"

cd "$repo_root/apps/ios"
derived="$repo_root/apps/ios/build/device"
team_args=()
[ -n "${MEMRY_IOS_TEAM:-}" ] && team_args=(DEVELOPMENT_TEAM="$MEMRY_IOS_TEAM")

xcodebuild -project Memry.xcodeproj -scheme Memry -configuration Debug \
  -destination "id=$udid" -derivedDataPath "$derived" \
  -allowProvisioningUpdates ${team_args[@]+"${team_args[@]}"} build

app="$derived/Build/Products/Debug-iphoneos/Memry.app"
bundle_id="$(defaults read "$app/Info.plist" CFBundleIdentifier)"
xcrun devicectl device install app --device "$udid" "$app"
xcrun devicectl device process launch --device "$udid" "$bundle_id"
