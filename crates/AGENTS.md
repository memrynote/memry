# Rust core guide

This directory owns the Rust workspace. `memry-core` is the shared core under the iOS app. `memry-cli` builds `memry`, a headless client that drives the core against a real sync server. `uniffi-bindgen-swift` generates the Swift bindings. `.specify/memory/constitution.md` states the full principles for the core and the native shells; read it before changing what the core owns or exposes.

## Ownership

- Everything that is not UI lives once, in `memry-core`: sync, crypto, CRDT through yrs, SQLite storage, auth, and domain rules. When a shell needs a decision the core does not expose, the core gains an API and the shell gains no logic.
- `memry-core/src/api/` is the UniFFI API the shells call. `memry-core/src/seams/` defines the traits each shell implements for platform capabilities, such as transport, secure store, reachability, notifications, background work, and code capture. A new seam needs a written reason.
- The core implements `docs/protocol/`, and `packages/contracts` is the schema source of truth. A Rust type that drifts from a contract is a bug in the Rust.
- The core never serialises a note body to markdown. It parses markdown only in `memry-core/src/crdt/markdown_seed/`, for the two writes in section 12.1.0 of `docs/protocol/12-note-body-format.md`, and carries markdown verbatim everywhere else. Desktop owns the conversion.
- Desktop stays TypeScript, so the protocol has two implementations. They agree through conformance vectors, never by reading each other's code.

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
cargo clippy --all-targets -- -D warnings
cargo test -p memry-core
node ../scripts/check-line-ceilings.mjs   # 600 lines per Rust source file
```

- A file at its ceiling is split along an existing module boundary before it gains behavior.
- `memry` defaults to staging. Never point it at production, which holds only real users' vaults.
