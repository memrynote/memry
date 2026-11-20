#!/bin/sh
# Builds, signs, notarizes and staples MemryNote-<version>-<arch>.dmg in the current directory from
# a signed, stapled app. The dmg holds the app and an Applications symlink.
# Usage: make-dmg.sh <app> <arm64|x64> <version> <identity> [keychain]
# Notarizes with the `memry-notary` keychain profile, looked up in <keychain> when given.
set -eu

usage='usage: make-dmg.sh <app> <arm64|x64> <version> <identity> [keychain]'
app="${1:?$usage}"
arch="${2:?$usage}"
version="${3:?$usage}"
identity="${4:?$usage}"
keychain="${5:-}"

[ -d "$app" ] || { echo "not a bundle: $app" >&2; exit 1; }
case "$arch" in arm64 | x64) ;; *) echo "$usage" >&2; exit 2 ;; esac

dmg="$PWD/MemryNote-$version-$arch.dmg"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/$(basename "$app")"
ln -s /Applications "$stage/Applications"

hdiutil create -volname MemryNote -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$dmg"
if [ -n "$keychain" ]; then
  codesign --force --timestamp --keychain "$keychain" --sign "$identity" "$dmg"
  xcrun notarytool submit "$dmg" --wait --keychain-profile memry-notary --keychain "$keychain"
else
  codesign --force --timestamp --sign "$identity" "$dmg"
  xcrun notarytool submit "$dmg" --wait --keychain-profile memry-notary
fi
# Stapling fails when notarization was not accepted, so a rejected dmg stops here.
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
echo "$dmg"
