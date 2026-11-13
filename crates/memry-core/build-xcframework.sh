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
#
# The core always builds with the `semantic` feature here, which links ONNX
# Runtime: Microsoft's onnxruntime-c pod archive, pinned by onnxruntime.lock,
# downloaded and verified once into ~/Library/Caches/memry/onnxruntime/<sha256>/.
# The cache sits outside target/ because rust-cache keeps only target/ and the
# registry; CI caches the directory keyed on the lock file.
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

lock_value() { sed -n "s/^$1=//p" "$crate_dir/onnxruntime.lock"; }
ort_url="$(lock_value url)"
ort_sha="$(lock_value sha256)"
ort_size="$(lock_value size)"
ort_cache="$HOME/Library/Caches/memry/onnxruntime"
ort_dir="$ort_cache/$ort_sha"
if [[ ! -d "$ort_dir" ]]; then
  mkdir -p "$ort_cache"
  fetch="$(mktemp -d "$ort_cache/.fetch.XXXXXX")"
  trap 'rm -rf "$fetch"' EXIT
  curl --fail --location --silent --show-error --retry 3 -o "$fetch/archive.zip" "$ort_url"
  got_size="$(stat -f %z "$fetch/archive.zip")"
  got_sha="$(shasum -a 256 "$fetch/archive.zip" | cut -d ' ' -f 1)"
  if [[ "$got_size" != "$ort_size" || "$got_sha" != "$ort_sha" ]]; then
    echo "error: $ort_url is $got_size bytes with sha256 $got_sha; onnxruntime.lock pins $ort_size and $ort_sha" >&2
    exit 1
  fi
  unzip -q "$fetch/archive.zip" -d "$fetch/unpacked"
  # rename(2) is atomic and refuses an existing non-empty directory, so when a
  # parallel build in another worktree lands first, this copy is discarded.
  perl -e 'rename $ARGV[0], $ARGV[1]' "$fetch/unpacked" "$ort_dir"
  rm -rf "$fetch"
  trap - EXIT
fi
ort_xcfwk="$ort_dir/onnxruntime.xcframework"
if [[ ! -d "$ort_xcfwk" ]]; then
  echo "error: $ort_xcfwk is missing; delete $ort_dir and rerun" >&2
  exit 1
fi
ort_sim="$ort_xcfwk/ios-arm64_x86_64-simulator/onnxruntime.framework/onnxruntime"
ort_thin="$workspace_dir/target/onnxruntime/$ort_sha"
for arch in arm64 x86_64; do
  thin="$ort_thin/$arch-sim/libonnxruntime.a"
  if [[ ! -f "$thin" ]]; then
    mkdir -p "$(dirname "$thin")"
    lipo -thin "$arch" "$ort_sim" -output "$thin.tmp"
    mv "$thin.tmp" "$thin"
  fi
done

rm -rf "$staging"
for target in "${targets[@]}"; do
  rustup target add "$target" >/dev/null
  case "$target" in
    aarch64-apple-ios)
      ort_env=(ORT_IOS_XCFWK_PATH="$ort_xcfwk")
      ort_lib="$ort_xcfwk/ios-arm64/onnxruntime.framework/onnxruntime" ;;
    aarch64-apple-ios-sim)
      ort_env=(ORT_IOS_XCFWK_PATH="$ort_xcfwk")
      ort_lib="$ort_thin/arm64-sim/libonnxruntime.a" ;;
    x86_64-apple-ios)
      # ort-sys finds the xcframework only for the arm64 triples.
      ort_env=(ORT_LIB_PATH="$ort_thin/x86_64-sim")
      ort_lib="$ort_thin/x86_64-sim/libonnxruntime.a" ;;
  esac
  env "${ort_env[@]}" cargo build -p memry-core --target "$target" --profile "$cargo_profile" --features semantic
  # Merged into a copy: merging into cargo's own output would add ONNX Runtime
  # a second time whenever cargo has nothing to rebuild.
  mkdir -p "$staging/$target"
  libtool -static -no_warning_for_no_symbols -o "$staging/$target/libmemry_core.a" \
    "$workspace_dir/target/$target/$profile/libmemry_core.a" "$ort_lib"
done

# One bindgen run over any one built library: the metadata is identical across
# slices, and running it once keeps the generated Swift from depending on which
# architecture happened to build last.
rm -rf "$generated_dir"
mkdir -p "$generated_dir"
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
  "$staging/aarch64-apple-ios-sim/libmemry_core.a" \
  "$staging/x86_64-apple-ios/libmemry_core.a" \
  -output "$sim_fat"

rm -rf "$xcframework"
xcodebuild -create-xcframework \
  -library "$staging/aarch64-apple-ios/libmemry_core.a" -headers "$headers" \
  -library "$sim_fat" -headers "$headers" \
  -output "$xcframework"

echo "built $xcframework"
echo "generated Swift → ${generated_dir#"$repo_root"/}"
