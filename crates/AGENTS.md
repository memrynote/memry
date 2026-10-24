# Rust core guide

This directory owns the Rust workspace. `memry-core` is the shared core under the iOS and desktop apps; `memry-desktop` holds desktop-only services and has no tauri dependency; `memry-ml` holds the native ML libraries (ONNX Runtime, whisper, Tesseract, images, pdfium; OCR and pdfium run in its `memry-ml-worker` sidecar process, so a hung native call is killed without taking the app down); `memrynote-cli` builds the user-facing `memrynote` binary; `memry-cli` builds `memry`, the dev tool; `uniffi-bindgen-swift` generates the Swift bindings. The Tauri bin crate `memry-tauri` lives in `apps/desktop-tauri/src-tauri` and is a member of this workspace. Crates that Steps 02 (#3519), 23 (#3540) and 35 (#3552) create are named here before they exist so the guide is true when they land.

## Ownership

- Everything that is not UI lives once, in `memry-core`: sync, crypto, CRDT through yrs, SQLite storage, auth, and domain rules. When a shell needs a decision the core does not expose, the core gains an API and the shell gains no logic.
- `memry-core/src/api/` is the UniFFI API the shells call. `memry-core/src/seams/` defines the traits each shell implements for platform capabilities, such as transport, secure store, reachability, notifications, background work, and code capture. A new seam needs a written reason.
- The core implements `docs/protocol/`, and `packages/contracts` is the schema source of truth. A Rust type that drifts from a contract is a bug in the Rust.
- The core owns markdown conversion in both directions, in `memry-core/src/markdown/`. Desktop and iOS carry markdown verbatim until they call the core. Until Step 05 (#3522) of the Tauri epic merges, the TypeScript converter in `apps/desktop/src/main/sync/blocknote-converter.ts` is the production converter and the oracle that generates the conversion vectors; after it merges, the Rust converter is the owner and the vectors keep it equal to the frozen TypeScript.
- Desktop is Rust on this core. The Electron app's TypeScript implementation stays as the vector oracle until the cutover step deletes it. The two implementations agree through conformance vectors, never by reading each other's code.

## Desktop crates

- `memry-desktop` and `memry-ml` never depend on `tauri`.
- `memry-tauri` adapters parse arguments, call one service method and map the error, with no domain decision inside a command.
- A blocking core call runs inside `spawn_blocking`.
- Desktop never uses `memry_core::api::runtime`.

## Conformance

- The vectors in `packages/contracts/test-vectors/` come out of the TypeScript production code paths (`packages/contracts/scripts/gen-protocol-vectors.ts`). `packages/contracts/src/__tests__/` verifies them on the TypeScript side, and `memry-core`'s tests, `memry-core/tests/*_vectors.rs` among them, reproduce them byte for byte. The `memry-core/src/api/*_conformance.rs` exports let the iOS conformance plan run the same vectors through the shell ([apps/ios](../apps/ios/AGENTS.md#tests)).
- A change to a covered format updates its `docs/protocol/` chapter and its vectors in the same change. Regenerate one class with `npx tsx packages/contracts/scripts/gen-protocol-vectors.ts <class>`, then confirm the rest with `pnpm --filter @memry/contracts vectors:check`. The primitive crypto vectors from `gen-crypto-vectors.ts` are frozen.
- A failing vector means the Rust diverged from the protocol. Fix the Rust, unless the chapter and the TypeScript changed on purpose in the same change.
- Byte compatibility reaches into dependencies. `flate2` builds against stock zlib because chapter 04 pins compressed frames to `pako.deflate`. Read the comments in `Cargo.toml` before changing a pinned dependency.

## Bindings

- After any change to the UniFFI API in `memry-core/src/api/` or `memry-core/src/seams/`, run `crates/memry-core/build-xcframework.sh` and commit the regenerated Swift in `packages/swift/MemryCore/Sources/MemryCore/Generated/`. The script also rebuilds `packages/swift/MemryCore/MemryCoreFFI.xcframework`, which is gitignored. `rust-ci.yml` regenerates the Swift and fails when it differs from the commit.
- `uniffi` is pinned with `=` because the bindgen and runtime versions must match exactly.
- Errors cross the FFI as typed variants that the shell renders. Keys never cross it as strings.

## Storage and keys

- The core's data and index databases migrate through `PRAGMA user_version` in `memry-core/src/storage/migrations.rs`, with independent counters. Migrations are hand-written and forward-only. A removed concept leaves its column in place, unread, so an older build can still open the file.
- The sync outbox and CRDT state reach SQLite before any acknowledgement reaches the shell, because the OS can kill a backgrounded app at any moment.
- Keys live only in the platform secure store, reached through the secure-store seam. They stay out of the database, logs, telemetry, and crash reports.

## Validation

Run these from `crates/`, where `rust-toolchain.toml` pins the toolchain CI uses:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p <touched crates>   # CI runs the full workspace
node ../scripts/check-line-ceilings.mjs
```

- `memry-cli` does not build on Windows: `crates/memry-cli/src/session.rs` imports `std::os::unix`. The `windows-2022` and `windows-11-arm` legs of `rust-ci.yml` run clippy with `--exclude memry-cli`, and `cargo test -p memry-cli` runs on the Ubuntu leg only.
- 600 lines per Rust source file in every crate, `apps/desktop-tauri/src-tauri` included. The repo-wide oxlint `max-lines` limit of 800 applies to `apps/desktop-tauri/src`.

- A file at its ceiling is split along an existing module boundary before it gains behavior.
- `memry` defaults to staging. Never point it at production, which holds only real users' vaults.
