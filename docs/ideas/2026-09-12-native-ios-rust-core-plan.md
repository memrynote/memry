# Decision record: native iOS over a shared Rust core

Date: 2026-09-12. Owner: Kaan. Status: accepted.

Supersedes `docs/ideas/2026-08-22-mobile-expo-plan.md` for all new mobile work.
`apps/mobile` (React Native / Expo) is frozen as of this date: no new commits,
kept in-tree as a reference implementation of the platform adapters, the
WebView bridge host, and the editor bundle build.

## Decision

1. Mobile is rewritten native. iOS first (`apps/ios`, SwiftUI, iOS 26+), Android
   later (`apps/android`, Jetpack Compose) over the same core.
2. Everything that is not UI lives once, in a Rust crate (`crates/memry-core`)
   exposed to Swift and Kotlin through UniFFI: sync engine, outbox, vector
   clocks and field merge, crypto (libsodium), CRDT (yrs), SQLite storage,
   HTTP/WebSocket client logic over a shell-provided transport, auth and token lifecycle, domain logic for notes,
   folders, tags, properties, templates, tasks, journal, reminders, search.
3. The note body editor stays a WebView-hosted BlockNote bundle. The Rust core
   owns the Y.Doc; the WebView holds a replica and persists nothing. The bridge
   protocol is `packages/contracts/src/webview-bridge.ts` v1, unchanged. The
   bundle is the existing `apps/mobile/editor-web` build output.
4. The desktop app does not change for this work. The sync server changes
   only additively: an Apple identity provider for Sign in with Apple (App
   Review 4.8) and any spec-driven tests. The protocol gains a written
   specification and composite conformance vectors before any Rust is
   written.

## Why native, why now

The current architecture was analysed on 2026-09-12 (five read-only explorer
passes over `apps/desktop`, `packages/*`, `apps/sync-server`, `apps/mobile`).
Findings that drove the decision:

- The server is language-agnostic: ~60 HTTP endpoints plus one WebSocket,
  JSON/CBOR over ciphertext. It never sees plaintext.
- Crypto is a spec with committed vectors. Argon2id, XChaCha20-Poly1305,
  Ed25519, BLAKE2b KDF, all libsodium. `packages/contracts/test-vectors/
  crypto-vectors.json` covers primitives and the vault-unlock flow; mobile's JSI
  binding passes 33/33. swift-sodium and Rust `libsodium-sys` wrap the same C.
- Wire formats are byte-exact and documented in code: record envelope with
  canonical CBOR signature (server verifies), packed CRDT update (160-byte
  header, offsets in `packages/sync-client/src/pull/record-decrypt.ts`), MPAK
  pack container, 1-byte compression flag.
- Yjs update bytes are wire-compatible with `yrs`, the Rust implementation.
  The transport layer never inspects them.
- The local database is not part of the protocol. Desktop has ~40 tables,
  the RN app has 9. A native client chooses its own schema.
- The ten platform seams in `packages/sync-client/src/adapters/index.ts` are
  already the list of what a shell must provide.
- The production safety kit is client-agnostic: `x-memry-client` header,
  server minimum version, per-platform write kill switch
  (`403 PLATFORM_WRITES_DISABLED`, `426 CLIENT_UPGRADE_REQUIRED`).

The single hard constraint is the note body. The Y.Doc fragment named
`prosemirror` has the layout y-prosemirror gives a BlockNote document: 14
default blocks, 6 Memry blocks, 8 inline types, plus five out-of-band
encodings. y-prosemirror deletes any node its schema cannot build, and that
deletion replicates to every device. A native editor with a schema gap is
therefore data loss, not a rendering bug. Markdown⇄Y.Doc conversion exists
only under jsdom in the desktop main process. This is why the editor stays a
WebView (option A) rather than a native editor (option B) or a Memry-owned
block model with a migration (option C). C remains a future option; A does
not foreclose it.

## Why Rust for the core

- yrs is Rust. Using it natively removes the CRDT from the FFI boundary.
- One implementation of the protocol for both platforms. The RN app already
  showed the cost of re-deriving logic by hand: it wrote `createdAt` as a
  number where the payload schema said string, every phone edit failed
  `safeParse` on desktop and was skipped without retry, and the union type is
  now permanent because the rows are on disk and on the server.
- UniFFI generates the Swift and Kotlin surface from one definition.
- Kotlin Multiplatform was considered and rejected: yrs on iOS would need C
  interop through yffi, and the crypto story is weaker.

This adds a third language to the repo. Accepted.

## What is reused from the repo

| Reused as-is | Reused as specification | Rewritten |
| --- | --- | --- |
| Sync server | `packages/contracts/*` Zod schemas | Sync engine (`main/sync`, `sync-client`) |
| Editor bundle (`apps/mobile/editor-web`) | `crypto-vectors.json` + new composite vectors | Crypto (`main/crypto`) |
| Bridge protocol (`webview-bridge.ts`) | `sync-client/src/{vector-clock,field-merge}.ts` | Storage (`main/database`, `db-schema`) |
| Design system (`DESIGN.md`, tokens) | Markdown grammar in `packages/shared` and `editor-schema/blocks/markdown.ts` | Domain logic (`main/vault`, `main/tasks`, `main/notes`, `main/journal`) |
| | `specs/001-mobile-app/contracts/platform-adapters.md` (the ten seams) | Renderer-resident logic: folder-view expression engine, task grouping, quick-add and natural-date parsers, graph builder |

## Out of scope on mobile, with reasons

- Agent Chat: spawns Claude/Codex CLIs and runs a localhost MCP server.
  Impossible in the iOS sandbox.
- Importers: read other apps' local databases through jsdom. Sandbox-forbidden.
- Semantic search and voice transcription: sqlite-vec plus
  `@huggingface/transformers`. Would need CoreML; deferred.
- Canvas: Excalidraw is DOM-bound. Absent in feature 002, including
  read-only viewing; a viewer is a candidate for feature 003.
- Certificate pinning: a bad pin cannot be fixed faster than App Store review.

## Known risks

- WebView editor plus native keyboard toolbar. WKWebView manages its own input
  accessory view. The RN app's toolbar work is the reference; expect effort.
- Schema lockstep. Any desktop editor-schema change must ship in the bundle
  the native app embeds, gated by a hash check like `editor:check`.
- Field-merge has undocumented heuristics (`clockTotal` sum comparison,
  `_offline` pseudo-device tie-break). They must be specified, not inferred.
- Composite envelope formats (signed record, packed CRDT update, MPAK) have
  no committed vectors today. Adding them is prerequisite work.
- Journals: `CRDT_SYNC_ITEM_TYPES` lists only `note`, but the pull coordinator
  routes journals into the CRDT feed. The protocol spec must state which.

## Sequencing

1. Amend the constitution (this decision invalidates principle I and the
   Mobile Platform Constraints as written for RN).
2. Spec `002-native-foundation-ios`: foundation (protocol spec, vectors, Rust
   core) plus the iOS shell.
3. Protocol specification and composite vectors land in the TS repo first,
   verified by the desktop test suite.
4. Rust core proves itself as a headless CLI against staging before any
   SwiftUI exists: login, pull, decrypt, merge, push, round-trip with desktop.
5. iOS shell over the core. Android after iOS ships.
