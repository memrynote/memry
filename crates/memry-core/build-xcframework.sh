#!/usr/bin/env bash
# Build MemryCoreFFI.xcframework and the checked-in Swift bindings.
#
#   crates/memry-core/build-xcframework.sh [--release]
#
# Outputs:
#   packages/swift/MemryCore/MemryCoreFFI.xcframework
#   packages/swift/MemryCore/Sources/MemryCore/Generated/*.swift
#
# Both are committed. `rust-ci.yml` reruns the generator and diffs the Generated
# directory, so a change to the UniFFI surface that skips this script fails the
# build rather than leaving Swift talking to yesterday's ABI (the `ipc:check`
# discipline, Constitution II).
set -euo pipefail

crate_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_dir="$(dirname "$crate_dir")"
repo_root="$(dirname "$workspace_dir")"

# Named, not an array: under `set -u` bash 3.2 -- which is what macOS ships and
# what CI runs -- expanding an EMPTY array is an unbound-variable error.
cargo_profile="dev"
profile="debug"
if [[ "${1:-}" == "--release" ]]; then
  cargo_profile="release"
  profile="release"
fi

# The C header slices are compiled against this floor; if it disagrees with the
# Xcode project's deployment target the linker warns per object file.
export IPHONEOS_DEPLOYMENT_TARGET=26.0

# uniffi's bindgen shells out to `cargo metadata`, which resolves from the
# CURRENT directory and ignores --manifest-path. Run the whole script from the
# workspace root so it finds crates/Cargo.toml however it was invoked.
cd "$workspace_dir"

targets=(aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios)

swift_pkg="$repo_root/packages/swift/MemryCore"
generated_dir="$swift_pkg/Sources/MemryCore/Generated"
xcframework="$swift_pkg/MemryCoreFFI.xcframework"
staging="$workspace_dir/target/xcframework-staging"

for target in "${targets[@]}"; do
  rustup target add "$target" >/dev/null
  cargo build -p memry-core --target "$target" --profile "$cargo_profile"
done

# One bindgen run over any one built library: the metadata is identical across
# slices, and running it once keeps the generated Swift from depending on which
# architecture happened to build last.
rm -rf "$staging" "$generated_dir"
mkdir -p "$staging" "$generated_dir"
cargo run -p uniffi-bindgen-swift -- \
  generate \
  --library "$workspace_dir/target/aarch64-apple-ios/$profile/libmemry_core.a" \
  --language swift \
  --out-dir "$staging/bindings"

# uniffi emits `<module>.modulemap`; an XCFramework headers directory is only
# picked up when the file is named `module.modulemap` (research R1).
headers="$staging/Headers"
mkdir -p "$headers"
mv "$staging"/bindings/*.h "$headers/"
cat "$staging"/bindings/*.modulemap > "$headers/module.modulemap"
rm -f "$staging"/bindings/*.modulemap
mv "$staging"/bindings/*.swift "$generated_dir/"

# Device slice stays alone; the two simulator slices are lipo'd into one, because
# an XCFramework rejects two libraries with the same platform + variant.
sim_fat="$staging/ios-simulator/libmemry_core.a"
mkdir -p "$(dirname "$sim_fat")"
lipo -create \
  "$workspace_dir/target/aarch64-apple-ios-sim/$profile/libmemry_core.a" \
  "$workspace_dir/target/x86_64-apple-ios/$profile/libmemry_core.a" \
  -output "$sim_fat"

rm -rf "$xcframework"
xcodebuild -create-xcframework \
  -library "$workspace_dir/target/aarch64-apple-ios/$profile/libmemry_core.a" -headers "$headers" \
  -library "$sim_fat" -headers "$headers" \
  -output "$xcframework"

echo "built $xcframework"
echo "generated Swift → ${generated_dir#"$repo_root"/}"
