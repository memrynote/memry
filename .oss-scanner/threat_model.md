# Threat model

## What this project does

Memry is a local-first, end-to-end encrypted notes, journal, and tasks app. Each device keeps its data in SQLite plus vault files and syncs through a Cloudflare Worker (`apps/sync-server`) that stores only ciphertext (metadata in D1, encrypted payloads in R2). Crypto is libsodium: XChaCha20-Poly1305, Ed25519 signatures, Argon2id. The desktop app (Electron, TypeScript, `apps/desktop`) is the reference implementation; the iOS app is a SwiftUI shell over the Rust core (`crates/memry-core`). The wire format is specified in `docs/protocol/`, with conformance vectors in `packages/contracts/test-vectors/`.

## Security goals (the invariants that matter)

- **Zero knowledge.** The server never sees plaintext note content or key material. Anything that lets the server, or anyone who compromises it, recover plaintext or keys is critical.
- **Tenant isolation.** Every D1/R2 access is scoped to the authenticated user and vault. Reading, writing, or deleting another user's items, blobs, devices, or linking sessions is critical.
- **Authenticity.** Sync records and delete attestations are signed by an enrolled device (Ed25519) and verified before apply. Revoked devices must be rejected.
- **Local isolation.** The renderer reaches the vault and OS only through the preload API. The local HTTP servers (extension capture, MCP agent tools) need both an origin check and a bearer token.

## Where untrusted input enters

- **Sync server HTTP/WebSocket** (`apps/sync-server/src/routes/`, `durable-objects/`, `middleware/`): unauthenticated routes in `auth.ts` (OTP, OAuth, recovery, refresh) and `linking.ts` (`/scan`, `/complete`), authenticated sync, blob, device, and billing routes, and payment webhooks (`webhooks.ts`). Assume an attacker holds a valid account and wants other users' data.
- **Payloads from other devices or a malicious server**: envelope/CBOR/pack/compression/Yjs decoding in `packages/sync-client/src/pull/`, `apps/desktop/src/main/crypto/`, `apps/desktop/src/main/sync/`, and `crates/memry-core/src/{protocol,sync,crdt,crypto}/`. Treat the server as untrusted here: a malicious server must not be able to make a client accept forged, replayed, or cross-vault records, crash it, or exhaust its memory.
- **Device linking and recovery**: `docs/protocol/01-identity-and-keys.md`, `03-device-linking.md`, `apps/desktop/src/main/crypto/`, `crates/memry-core/src/crypto/`.
- **Electron shell**: IPC handlers (`apps/desktop/src/main/ipc/`, `src/preload/`), custom protocols (`memry-html`, `memry-file`), CSP, window-open handler, HTML attachment embedding (`main/vault/html-embed-protocol.ts`), and `memry://` deep links (`main/deeplink-utils.ts`). Note content is attacker-controlled when a note was imported, clipped, or shared.
- **Local servers**: extension capture server (`apps/desktop/src/main/capture/`, port 7849) and MCP agent server (`apps/desktop/src/main/agent/mcp/`). A malicious web page in the user's browser is the attacker.
- **Importers and extraction**: `packages/*-import`, `packages/importers`, `apps/desktop/src/main/import/`, `packages/article-extract`. Input files and web pages are untrusted.
- **Vault files on disk** (`packages/storage-vault`): files synced by third-party tools may be crafted; path traversal out of the vault matters.

## Components that matter most / least

- Most: sync server auth, linking, and tenant scoping; client-side decrypt/verify/apply in TS and Rust; key derivation, wrapping, and recovery; Electron IPC and protocol handlers; the local capture/MCP servers.
- Less: importers (still in scope for path traversal, script injection into notes, and memory blowups), CLI (`apps/cli`, `crates/memry-cli`).
- Out of scope: `apps/landing`, `apps/docs`, `apps/marketing-emails`, `marketing/`, `release-notes/`, `specs/`, the SwiftUI UI under `apps/ios`, `crates/uniffi-bindgen-swift`, and test fixtures.

## How to exercise it

The image has dependencies installed and the Rust core built. Everything runs offline.

- Sync server: `pnpm --filter @memry/sync-server test` (Vitest with an in-memory D1 in `apps/sync-server/src/__tests__/d1-sqlite.ts`; blob route harness in `src/__mocks__/`).
- Rust core: `cd crates && cargo test -p memry-core`; `tests/*_vectors.rs` replay the protocol vectors.
- CLI and app core: `pnpm test:cli`.
- Shared packages: `pnpm --filter @memry/desktop test:shared`.
- Electron itself is not launched in this image; reason about IPC and protocol handlers from source.

## How we rate severity

- Critical: server or a third party recovers plaintext or keys; cross-tenant read/write/delete; auth or linking bypass that enrolls an attacker device; RCE in the desktop main process (including XSS that reaches privileged IPC or Node); forged record or delete accepted by a client.
- High: renderer XSS from note, import, or clip content without IPC escalation; capture/MCP server reachable from a web page without the token; path traversal out of the vault; replay or rollback of synced records; revoked device still able to sync.
- Medium: client crash or unbounded memory from a crafted sync payload or import file; information leaks of routing metadata beyond what the protocol already exposes.
- Low: hardening gaps without a demonstrated exploit.
- Volumetric DoS, social engineering, attacks needing an unlocked device, and bugs in third-party dependencies are out of scope (see `SECURITY.md`); report dependency bugs only when Memry's usage makes them exploitable.

## Reports and patches

Include a reproducer that runs against the in-image tests where possible (a Vitest case for the sync server, a `cargo test` for the Rust core). Patches should fix the owning module, keep the wire format compatible with older clients (`docs/protocol/`), and include a regression test.
