#!/bin/sh
# Signs a Tauri .app inside-out with the hardened runtime, then the bundle itself.
# Usage: sign-macos-bundle.sh <app> <identity> <entitlements> [keychain]
# Order by path class: named sidecars and the pdfium dylib under Contents/Resources/pdfium first, then
# every other Mach-O file and framework, then the main binary, then the bundle. The script signs
# whatever Mach-O files the bundle holds; the sidecars come from Steps 25, 29 and 35.
# Only the main binary and the bundle carry the app's entitlements (camera, microphone, calendars,
# network). Nested code gets none: memry-ml-worker runs pdfium and Tesseract on untrusted PDFs and
# images, so it must not hold the app's device and personal-information grants. The one exception
# is the EventKit helper (Step 29), which gets calendars only.
set -eu

app="${1:?usage: sign-macos-bundle.sh <app> <identity> <entitlements> [keychain]}"
identity="${2:?identity}"
entitlements="${3:?entitlements}"
keychain="${4:-}"

[ -d "$app" ] || { echo "not a bundle: $app" >&2; exit 1; }

# The EventKit helper only reads calendars, so it gets that one entitlement, not the app's.
eventkit_entitlements="$(cd "$(dirname "$0")/../.." && pwd)/apps/desktop-tauri/eventkit/entitlements.plist"
[ -f "$eventkit_entitlements" ] || { echo "missing $eventkit_entitlements" >&2; exit 1; }

# Every executable and dylib the manifest lists for macOS must be in the bundle. A missing helper
# (the release config dropped it) fails here, not as a quietly unsigned or absent file.
manifest="$(cd "$(dirname "$0")" && pwd)/payload-manifest.json"
# shellcheck disable=SC2016 # the script is JavaScript, not shell
required="$(node -e '
const { platforms: { macos } } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
for (const name of macos.executables) console.log(`${macos.binDir}/${name}`)
for (const file of macos.resources) if (file.endsWith(".dylib")) console.log(`${macos.resourceDir}/${file}`)
' "$manifest")"
for rel in $required; do
  [ -e "$app/$rel" ] || { echo "missing $app/$rel (listed in payload-manifest.json)" >&2; exit 1; }
done

# sign <path> [codesign options]
sign() {
  target="$1"
  shift
  if [ -n "$keychain" ]; then set -- "$@" --keychain "$keychain"; fi
  codesign --force --timestamp --options runtime "$@" --sign "$identity" "$target"
}

main_bin="$app/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
signed="$(mktemp)"
trap 'rm -f "$signed"' EXIT

sign_once() {
  [ -e "$1" ] || return 0
  grep -qxF "$1" "$signed" && return 0
  sign "$@"
  printf '%s\n' "$1" >> "$signed"
}

for named in \
  "$app/Contents/MacOS/memry-ml-worker" \
  "$app/Contents/MacOS/memrynote-cli"; do
  sign_once "$named"
done
sign_once "$app/Contents/MacOS/memry-eventkit" --entitlements "$eventkit_entitlements"
for dylib in "$app"/Contents/Resources/pdfium/*.dylib; do
  sign_once "$dylib"
done

# Frameworks and every other Mach-O file, deepest paths first.
find "$app/Contents" -type f ! -path "$main_bin" | while IFS= read -r file; do
  case "$(file -b "$file")" in
    *Mach-O*) printf '%s\n' "$file" ;;
  esac
done | awk '{ print gsub("/", "/"), $0 }' | sort -rn | cut -d' ' -f2- | while IFS= read -r file; do
  sign_once "$file"
done

for framework in $(find "$app/Contents/Frameworks" -maxdepth 1 -name '*.framework' 2>/dev/null | sort); do
  sign_once "$framework"
done

sign "$main_bin" --entitlements "$entitlements"
sign "$app" --entitlements "$entitlements"
codesign --verify --strict --verbose=2 "$app"
