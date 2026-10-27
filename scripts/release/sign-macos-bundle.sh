#!/bin/sh
# Signs a Tauri .app inside-out with the hardened runtime, then the bundle itself.
# Usage: sign-macos-bundle.sh <app> <identity> <entitlements> [keychain]
# Order by path class: named sidecars and the pdfium dylib under Contents/Resources first, then
# every other Mach-O file and framework, then the main binary, then the bundle. The script signs
# whatever Mach-O files the bundle holds; the sidecars come from Steps 25, 29 and 35.
set -eu

app="${1:?usage: sign-macos-bundle.sh <app> <identity> <entitlements> [keychain]}"
identity="${2:?identity}"
entitlements="${3:?entitlements}"
keychain="${4:-}"

[ -d "$app" ] || { echo "not a bundle: $app" >&2; exit 1; }

sign() {
  if [ -n "$keychain" ]; then
    codesign --force --timestamp --options runtime --entitlements "$entitlements" \
      --keychain "$keychain" --sign "$identity" "$1"
  else
    codesign --force --timestamp --options runtime --entitlements "$entitlements" \
      --sign "$identity" "$1"
  fi
}

main_bin="$app/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
signed="$(mktemp)"
trap 'rm -f "$signed"' EXIT

sign_once() {
  [ -e "$1" ] || return 0
  grep -qxF "$1" "$signed" && return 0
  sign "$1"
  printf '%s\n' "$1" >> "$signed"
}

for named in \
  "$app/Contents/MacOS/memry-ml-worker" \
  "$app/Contents/MacOS/memrynote-cli" \
  "$app/Contents/MacOS/memry-eventkit"; do
  sign_once "$named"
done
for dylib in "$app"/Contents/Resources/*pdfium*.dylib; do
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

sign_once "$main_bin"
sign "$app"
codesign --verify --strict --verbose=2 "$app"
