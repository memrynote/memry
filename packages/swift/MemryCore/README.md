# MemryCore (Swift package)

Wraps the Rust core as a consumable artifact for `apps/ios`.

- `MemryCoreFFI.xcframework` — built by `crates/memry-core/build-xcframework.sh`.
- `Sources/MemryCore/Generated/` — UniFFI-generated Swift, committed.
  `rust-ci.yml` regenerates and diffs it; edit the Rust, not the Swift.

Rebuild after any change to the UniFFI surface:

```sh
crates/memry-core/build-xcframework.sh --release
```
