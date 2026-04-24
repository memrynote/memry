# Electron → Tauri Full Migration — Design Spec

## Metadata

| Field | Value |
|-------|-------|
| Date | 2026-04-24 |
| Status | M1 implemented on 2026-04-25; plan revised for M2+ |
| Author | Kaan (via brainstorming with Claude Code) |
| Parent initiative | Memry: Electron → Tauri migration (pre-production, no users) |
| Prerequisite | Spike 0 — Tauri Risk Discovery (2026-04-23 to 2026-04-24) complete with three 🟢 verdicts |
| Estimated duration | Original total: 20-23 sprints; remaining after M1: ~18-21 sprints (~4.5-5.5 months solo) across M2-M10 |
| Target platform | macOS only for v1 (Windows/Linux post-v1) |

## TL;DR

Memry's Electron desktop app is being migrated to Tauri 2.x as a complete
greenfield rewrite. `apps/desktop-tauri/` now exists in-repo with M1 shipped:
full renderer port, mock IPC seam, Electron freeze guard, mock-lane WebKit e2e
coverage, and a passing unsigned macOS app bundle. The existing
`apps/desktop/` (Electron) is frozen and will be deleted at cutover. All node
infrastructure in the existing main process is rewritten in Rust — no sidecar,
no partial preservation. `packages/*` still exist today, but the extraction
work can no longer wait until the very end; it must happen incrementally per
milestone with final deletion at M10.

The migration is executed as 10 sequential horizontal milestones (M1–M10),
building the backend layer by layer (skeleton → DB → vault → crypto → notes →
sync → search → other features → packaging → cutover). M1 is done. Each
remaining milestone has explicit acceptance gates enforced before the next
begins.

The **renderer UI was ported 1:1 in M1** — `apps/desktop/src/renderer/src/`
(941 files at time of port) is now mirrored in `apps/desktop-tauri/src/` with
Tauri-specific wrappers, tests, and mock fixtures on top. Visual parity is now
tracked through checked-in M1 baseline frames under
`docs/spikes/tauri-risk-discovery/benchmarks/m1-parity/`. Subsequent
milestones (M2–M8) progressively replace mock `invoke` returns with real Rust
command implementations; the UI surface should stay largely stable after M1.

## Implementation Status (2026-04-25)

**Verified in-repo**

- `apps/desktop-tauri/` scaffold exists with working `src/` + `src-tauri/`.
- Electron freeze is active: `apps/desktop/README.md` carries the FROZEN banner
  and `.github/workflows/electron-freeze.yml` guards `apps/desktop/**`.
- Renderer port is complete enough to navigate every primary route on mock
  data. `apps/desktop/src/renderer/src/` has 941 files; `apps/desktop-tauri/src/`
  now has 991 files including Tauri IPC wrappers and tests.
- `pnpm --filter @memry/desktop-tauri port:audit` returns zero non-test
  Electron references.
- Verification passed on 2026-04-25:
  `typecheck`, `test`, `test:e2e`, `cargo:check`, `cargo:clippy -- -D warnings`,
  `bindings:check`, `capability:check`, and `build`.
- Current verification snapshot:
  164 Vitest files / 3569 tests passing, 34 Playwright WebKit smoke + visual
  baseline tests passing, and release bundle emitted at
  `apps/desktop-tauri/src-tauri/target/release/bundle/macos/Memry.app`.

**M1 carry-forward gaps / corrections**

- The original M1 text said the Spike 0 artifacts would be deleted. That is no
  longer correct. `docs/spikes/tauri-risk-discovery/` is now baseline evidence
  and should be retained until final cutover, likely permanently.
- Visual parity evidence is currently: checked-in Tauri baseline PNGs plus
  manual side-by-side Electron review. There is no automated paired
  Electron-vs-Tauri screenshot diff in-repo.
- The current e2e lane runs WebKit against the Vite dev server with mock IPC.
  That is correct for M1, but it is not sufficient once real Rust commands land.
  A real Tauri-runtime e2e lane must start by M5, not M10.
- Current audit (2026-04-25) shows 142 `@memry/*` occurrences across
  `apps/desktop-tauri/src`, `tsconfig.json`, and `vite.config.ts` including
  path aliases, type-only imports, and runtime helpers. Package extraction
  needs to become rolling work in M2-M8; leaving it all for M10 is too risky.
- `apps/desktop-tauri/src/lib/logger.ts` still imports
  `electron-log/renderer`, and the M1 port audit does not currently scan for
  `electron-log`. This is not a product blocker, but it is a planning gap:
  M2 must replace the logger with a Tauri-safe implementation and harden the
  audit patterns.
- Non-blocking M1 cleanup still exists in warnings:
  React setState-during-render warning in notes-tree tests,
  Radix dialog accessibility warnings, CSS `::highlight(...)` parser warnings,
  and a large production JS chunk warning. These are not migration blockers,
  but they should not be deferred all the way to cutover.

Key architectural decisions derived from Spike 0:

1. **Rust is sole owner of state** — DB, keychain, vault FS, Y.Docs all live in
   `src-tauri/`. Renderer is view-only, communicates via typed invoke commands.
2. **yrs authoritative CRDT in Rust** with shadow Y.Doc in renderer for
   y-prosemirror/BlockNote binding (Spike S2 Prototype B).
3. **rusqlite + custom Tauri commands** for DB — no plugin-sql (Spike S3
   Option A).
4. **Drizzle dropped** — hand-written SQL migrations under
   `src-tauri/migrations/*.sql`.
5. **AI SDK UI runs in renderer, HTTPS runs in Rust proxy.** Vercel AI SDK +
   `@blocknote/xl-ai` stay in the webview for UX continuity. A custom fetch
   adapter routes every outbound LLM HTTPS call through a Rust
   `ai_http_fetch_stream` command; Rust holds the keychain-backed provider
   key. Renderer never sees raw credentials, so an XSS in the webview cannot
   exfiltrate an OpenAI/Anthropic key.
6. **Binary IPC discipline** — payloads >8KB use `Response::new(Vec<u8>)` or
   `Channel<u8>` to bypass default JSON-array serialization (S3 observation #4).

## 1. Context

### Why now

Spike 0 completed 2026-04-24 with three 🟢 verdicts:

- **S1 BlockNote + WKWebView:** typing p95 = 13ms (3.8× under threshold).
  Turkish diacritics preserved. No data loss in any test.
- **S2 Yjs placement:** yrs 0.21.3 byte-compatible with Yjs 13.6.29 — concurrent
  merge converges identically across libraries. Shadow Y.Doc pattern validated
  in real Tauri runtime.
- **S3 DB placement:** Option A (rusqlite + custom commands) is the only
  configuration with complete end-to-end bench. Read-path 1.5× faster than
  plugin-sql. Hot paths equivalent.

With the foundational risks proven, the migration can proceed as a full
rewrite without guessing on architectural decisions.

### What's fixed (non-negotiable)

Confirmed in brainstorming session 2026-04-24:

1. **Full Rust rewrite.** All main process TypeScript is rewritten in Rust.
   No Node sidecar, no hybrid preservation of AI SDK, sync engine, or crypto
   in TS.
2. **Electron frozen from M1.** No new commits to `apps/desktop/` during
   migration. Deleted at M10 cutover.
3. **Greenfield repository structure.** `apps/desktop-tauri/` is the new
   workspace. `packages/*` deleted along with Electron at M10 — TypeScript-only
   bits are inlined into the new app.
4. **macOS only for v1.** Windows and Linux deferred post-v1; WebKit2GTK
   (Linux) is untested territory requiring a separate spike.
5. **AI SDK renderer-side, secrets Rust-side.** Vercel AI SDK (`@ai-sdk/*`,
   `@blocknote/xl-ai`) stays in the browser. Renderer may submit a provider key
   once for storage, but it never retrieves raw provider keys. Rust stores keys
   in the OS keychain, exposes only masked/status values, and performs provider
   HTTPS calls through `ai_http_fetch_stream`.
6. **Horizontal milestone sequencing.** Backend layers are built bottom-up
   (DB → vault → crypto → notes → sync → search → features) rather than
   feature-by-feature vertical slices.

### What's out of scope

- Windows support (post-v1).
- Linux support (post-v1, requires WebKit2GTK spike).
- Biometric unlock (Touch ID — M4 stub, real implementation post-v1).
- Mobile (Tauri Mobile support pre-alpha).
- Plugin SDK / extensibility (post-v1).
- Backward-compat with Electron vault format. Pre-production, nuke OK.
- Electron → Tauri data migration script. Users (just Kaan) reset vault at
  cutover.

## 2. High-level Architecture

### Two-world model

```
┌──────────────────────────────────────────────────────────┐
│                    apps/desktop-tauri                     │
│                                                            │
│  ┌──────────────────────┐    ┌─────────────────────────┐ │
│  │  src/ (TypeScript)   │    │  src-tauri/ (Rust)      │ │
│  │  — Webview/Renderer  │◄──►│  — Native backend       │ │
│  │                      │IPC │                         │ │
│  │  • React 19          │    │  • tauri 2.x            │ │
│  │  • BlockNote 0.47    │    │  • rusqlite + sqlite    │ │
│  │  • Tanstack Query    │    │  • yrs (CRDT)           │ │
│  │  • Yjs (shadow)      │    │  • dryoc (libsodium)    │ │
│  │  • Zod schemas       │    │  • tokio + reqwest      │ │
│  │  • @ai-sdk/*         │    │  • notify (FS watcher)  │ │
│  │  • libsodium-wrappers│    │  • security-framework   │ │
│  └──────────────────────┘    └─────────────────────────┘ │
└──────────────────────────────────────────────────────────┘

                        External
┌──────────────────────┐       ┌──────────────────────┐
│  apps/sync-server/   │       │  AI providers        │
│  (Cloudflare, TS)    │◄──────│  (OpenAI, Anthropic) │
│  UNCHANGED           │       │  HTTPS from renderer │
└──────────────────────┘       └──────────────────────┘
```

### Rust backend responsibilities

- Sole owner of all user state (DB, keychain, vault FS, Y.Docs).
- DB migrations, CRUD commands, transactions.
- Crypto primitives (XChaCha20-Poly1305 encrypt/decrypt, Ed25519 sign/verify,
  Argon2id KDF).
- OS keychain integration via `security-framework` (macOS).
- CRDT: yrs `Doc` owner, Yjs v1 wire-format snapshot + update persistence.
- Vault: file I/O via tokio::fs, `notify` FS watcher, `.md` read/write,
  frontmatter parse (serde_yaml).
- Sync engine: HTTP push/pull via reqwest, WebSocket via tokio-tungstenite,
  queue, retry with exponential backoff, field-level vector-clock merge.
- Search: rusqlite FTS5 + sqlite-vec extension (bundled .dylib).
- Thumbnail generation (`image` crate), PDF text extraction (`pdf-extract`),
  URL metadata extraction (reqwest + `scraper`).
- Auto-updater (tauri-plugin-updater), deep link handling.

### Renderer responsibilities

- Pure UI — React component tree.
- BlockNote editor with y-prosemirror binding to shadow Y.Doc (Spike S2
  pattern).
- State: Tanstack Query (server cache) + minimal local state. No persistent
  state in renderer.
- All backend access via `invoke(commandName, args)` or `listen(eventName, cb)`.
- Vercel AI SDK + `@blocknote/xl-ai` UI stay in renderer (streaming SSE UX,
  tool-calling, multi-provider ergonomics preserved). However, **raw LLM
  provider API keys never enter the renderer process.** AI SDK is instantiated
  with a **custom fetch adapter** that forwards every outbound request to a
  Rust command `ai_http_fetch_stream` via Tauri IPC. Rust reads the real key
  from the OS keychain, performs the HTTPS call, streams the response back
  through a Tauri `Channel<u8>`. The renderer reconstructs a `Response` whose
  `ReadableStream` is fed by the channel so the AI SDK behaves identically
  to a native `fetch`. Result: renderer holds no credential material, keychain
  is the sole source of truth, and the browser-side integration remains intact.
- Page reload = full reset. Webview reload behaves like fresh launch.

### IPC boundary discipline

1. **Unidirectional state flow.** State lives in Rust. Renderer reads via
   invoke; writes go through Rust commands. Tanstack Query invalidates local
   cache on successful mutation.
2. **Event emission.** Rust emits events for asynchronous updates (sync
   progress, file watcher events, CRDT updates from remote); renderer listens.
3. **Binary payloads.** Any payload >8KB uses `tauri::ipc::Response::new(Vec<u8>)`
   (one-shot) or `Channel<u8>` (streaming). Default JSON invoke is reserved
   for small metadata.
4. **Command naming.** `module_action[_qualifier]` snake_case:
   `notes_create`, `notes_list_by_folder`, `sync_push_now`,
   `crypto_derive_vault_key`.
5. **Type generation.** Rust structs annotated with `#[derive(specta::Type)]`;
   `tauri-specta` generates TypeScript types into `src/generated/bindings.ts`.
   Zod schemas in `src/lib/schemas/` remain manual for runtime validation.

### CRDT ownership

- Y.Doc authoritative in Rust via `yrs` crate, keyed by note ID behind a
  `Mutex<HashMap<NoteId, Doc>>`.
- Renderer holds a shadow Y.Doc (Yjs JS library) solely for y-prosemirror /
  BlockNote binding.
- Update flow:
  1. User edits → y-prosemirror → shadow Y.Doc `update` event (origin
     `undefined`)
  2. Renderer calls `invoke('crdt_apply_update', {noteId, bytes})`
  3. Rust yrs applies update → emits `crdt-update` Tauri event
  4. Renderer `listen('crdt-update', ...)` calls `Y.applyUpdate(bytes, 'rust')`
  5. Shadow Y.Doc `update` event fires with origin `'rust'` → handler short-
     circuits, no invoke back
- Loop prevention: Yjs' natural idempotence filters echo bytes at the event
  level (S2 observation #9). Origin-tag guard is defense-in-depth.

### Authentication flow

- Vault unlock: user enters password in renderer → `invoke('auth_unlock',
  {password})` → Rust derives master key via Argon2id in
  `tokio::task::spawn_blocking` → writes to keychain → caches in-memory
  `SecretBox<Key>` → returns AuthState::Unlocked
- Device registration: Ed25519 keypair generated in Rust, private key to
  keychain, public key registered with `apps/sync-server`
- OTP + email: Rust command invokes sync-server API; response posted back
- OAuth (Google Calendar): browser → `memry://oauth-callback` deep link →
  Rust handler → token exchange via sync-server relay
- Biometric unlock (Touch ID): stub in M4, real implementation post-v1

## 3. Monorepo + Directory Layout

### Repo root changes

```
memry/
├── apps/
│   ├── desktop/              ← FROZEN at M1, deleted at M10
│   ├── desktop-tauri/        ← NEW — this project
│   └── sync-server/          ← UNCHANGED (Cloudflare Workers, TS)
├── packages/                 ← FROZEN, deleted at M10
├── docs/                     ← this spec + future plans live here
│   └── spikes/               ← tauri-risk-discovery retained as benchmark evidence + M1 parity baselines
├── pnpm-workspace.yaml       ← updated: desktop-tauri added to apps/*
└── package.json
```

### `apps/desktop-tauri/` layout

```
apps/desktop-tauri/
├── package.json
├── tsconfig.json
├── vite.config.ts                  ← port 1420 (Tauri convention)
├── index.html
│
├── src/                            ← RENDERER (TypeScript)
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/                 ← shadcn + custom UI
│   ├── features/                   ← feature directories
│   │   └── notes/
│   │       ├── NoteEditor.tsx
│   │       ├── NoteList.tsx
│   │       ├── useNotes.ts         ← Tanstack Query hooks
│   │       └── schemas.ts          ← Zod validation
│   ├── lib/
│   │   ├── ipc/
│   │   │   ├── invoke.ts           ← typed wrapper
│   │   │   ├── events.ts           ← typed listen helpers
│   │   │   └── channel.ts          ← Channel<u8> helpers
│   │   ├── schemas/                ← shared Zod schemas
│   │   ├── ai/                     ← Vercel AI SDK wiring
│   │   │   ├── provider.ts
│   │   │   └── stream.ts
│   │   ├── crdt/
│   │   │   ├── yjs-tauri-provider.ts
│   │   │   └── origin-tags.ts
│   │   ├── errors.ts
│   │   └── logger.ts
│   ├── hooks/
│   ├── pages/
│   ├── contexts/
│   ├── generated/
│   │   └── bindings.ts             ← tauri-specta output, committed
│   └── styles/
│
├── src-tauri/                      ← BACKEND (Rust)
│   ├── Cargo.toml
│   ├── Cargo.lock
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   └── default.json
│   ├── icons/
│   ├── migrations/                 ← hand-written SQL
│   │   ├── 0000_initial.sql
│   │   ├── …
│   │   └── 0028_….sql              ← 29 data DB migrations ported from Electron
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── app_state.rs            ← AppState { db, crypto, crdt, vault, sync }
│       ├── error.rs                ← AppError enum + From impls
│       ├── logging.rs              ← tracing setup
│       │
│       ├── commands/               ← thin #[tauri::command] layer
│       │   ├── mod.rs              ← register_all(builder)
│       │   ├── notes.rs
│       │   ├── tasks.rs
│       │   ├── calendar.rs
│       │   ├── inbox.rs
│       │   ├── journal.rs
│       │   ├── tags.rs
│       │   ├── templates.rs
│       │   ├── bookmarks.rs
│       │   ├── folders.rs
│       │   ├── search.rs
│       │   ├── vault.rs
│       │   ├── auth.rs
│       │   ├── crypto.rs
│       │   ├── crdt.rs
│       │   ├── sync.rs
│       │   ├── settings.rs
│       │   └── devtools.rs         ← dev-only: reset_db, reseed, dump_state
│       │
│       ├── db/                     ← rusqlite layer
│       │   ├── mod.rs              ← Arc<Mutex<Connection>> for data.db
│       │   ├── migrations.rs
│       │   ├── notes.rs
│       │   ├── tasks.rs
│       │   ├── projects.rs
│       │   ├── calendar.rs
│       │   ├── inbox.rs
│       │   ├── journal.rs
│       │   ├── folders.rs
│       │   ├── tags.rs
│       │   ├── bookmarks.rs
│       │   ├── templates.rs
│       │   ├── embeddings.rs
│       │   ├── sync_queue.rs
│       │   ├── crdt_updates.rs
│       │   ├── crdt_snapshots.rs
│       │   ├── device.rs
│       │   └── settings.rs
│       │
│       ├── crypto/
│       │   ├── mod.rs
│       │   ├── primitives.rs       ← dryoc wrappers
│       │   ├── keychain.rs         ← security-framework
│       │   ├── vault_keys.rs
│       │   ├── nonces.rs
│       │   └── sign_verify.rs
│       │
│       ├── crdt/
│       │   ├── mod.rs
│       │   ├── apply.rs
│       │   ├── snapshot.rs
│       │   ├── compaction.rs
│       │   └── wire.rs
│       │
│       ├── vault/
│       │   ├── mod.rs
│       │   ├── fs.rs
│       │   ├── watcher.rs          ← notify crate
│       │   ├── frontmatter.rs
│       │   ├── notes_io.rs
│       │   └── preferences.rs
│       │
│       ├── sync/
│       │   ├── mod.rs              ← SyncRuntime
│       │   ├── engine.rs
│       │   ├── http.rs             ← reqwest + cert pinning
│       │   ├── ws.rs               ← tokio-tungstenite
│       │   ├── queue.rs
│       │   ├── retry.rs
│       │   ├── handlers/           ← 13 per-type handlers
│       │   │   ├── mod.rs
│       │   │   ├── notes.rs
│       │   │   ├── tasks.rs
│       │   │   ├── projects.rs
│       │   │   ├── calendar.rs
│       │   │   ├── inbox.rs
│       │   │   ├── journal.rs
│       │   │   ├── folders.rs
│       │   │   ├── tags.rs
│       │   │   ├── bookmarks.rs
│       │   │   ├── templates.rs
│       │   │   ├── filters.rs
│       │   │   ├── settings.rs
│       │   │   └── reminders.rs
│       │   ├── field_merge.rs
│       │   ├── crdt_updates.rs
│       │   ├── crypto_batch.rs
│       │   └── network.rs
│       │
│       ├── search/
│       │   ├── mod.rs
│       │   ├── fts.rs
│       │   ├── vector.rs           ← sqlite-vec
│       │   └── extensions.rs
│       │
│       ├── index_db/               ← rebuildable index.db (M7)
│       │   ├── mod.rs
│       │   └── migrations.rs
│       │
│       ├── ai_bridge/
│       │   └── mod.rs              ← ai_http_fetch_stream, masked key status
│       │
│       ├── updater/
│       │   └── mod.rs
│       │
│       ├── deep_links/
│       │   └── mod.rs
│       │
│       └── utils/
│           ├── clock.rs
│           ├── paths.rs
│           └── nanoid.rs
│
├── tests/                          ← Vitest unit tests
│   ├── components/
│   └── hooks/
│
├── e2e/                            ← Playwright WebKit
│   ├── playwright.config.ts
│   └── specs/
│       ├── notes.spec.ts
│       ├── sync.spec.ts
│       └── …
│
├── scripts/
│   ├── generate-bindings.ts
│   ├── check-bindings.ts
│   ├── dev-reset.sh
│   └── bundle-sqlite-vec.sh        ← preinstall hook
│
└── README.md
```

### Rust crate structure

**Single crate, nested modules** (not a Cargo workspace split).

Rationale: ~50–80 commands and ~13 domain modules are manageable in one crate.
Cargo already performs module-level incremental compilation. Workspace split
does not improve organization that cannot be achieved with module boundaries.
Extracting to separate crates later is mechanical if needed.

### Type generation

`tauri-specta` wraps specta and auto-generates TypeScript bindings from
command signatures and struct derives:

```
Rust #[derive(specta::Type)] struct Note { … }
Rust #[tauri::command] async fn notes_create(…)
     ↓
cargo run --bin generate_bindings
     ↓
src/generated/bindings.ts (Note type + Commands invoke map)
     ↓
Renderer: import type { Note, Commands } from '@/generated/bindings'
```

**CI gate:** `pnpm bindings:check` runs generator + `git diff --exit-code`.
Drift fails build.

**Zod schemas remain separate.** Specta generates TS types, not Zod schemas.
Runtime validation for untrusted inputs (form data, event payloads) uses
hand-written Zod schemas in `src/lib/schemas/`.

### Electron freeze discipline

- Add FROZEN banner to `apps/desktop/README.md` at M1.
- CI adds path-restricted workflow that **fails any PR touching
  `apps/desktop/**` unless the PR carries the label
  `migration/m10-cutover`** or the label `migration/emergency-fix`. Both
  labels are protected (only Kaan can apply them via branch protection /
  CODEOWNERS). This makes the freeze both strict and escape-hatched:
  - Normal PRs → guard fails, protects Electron from accidental drift
  - The single M10 cutover PR → Kaan applies `migration/m10-cutover`, guard
    passes, `git rm -rf apps/desktop/` proceeds
  - A rare emergency Electron hot-fix (unlikely given pre-production
    status) → Kaan applies `migration/emergency-fix`, guard passes, PR
    merges with explicit intent
- The freeze workflow itself deletes the guard as part of the M10 cutover
  PR (one final commit removes `.github/workflows/electron-freeze.yml`
  since Electron no longer exists post-cutover).

### Renderer UI port strategy

The renderer UI is ported 1:1 with zero visual diff. No CSS rewrite, no
component redesign, no theme changes. Opening `pnpm dev` in
`apps/desktop-tauri/` at the end of M1 should produce a window visually
indistinguishable from the Electron app.

**What transfers verbatim from `apps/desktop/src/renderer/src/**`:**

- All React components (~942 `.tsx`/`.ts` files) — directory structure
  preserved exactly (`components/`, `features/`, `pages/`, `hooks/`,
  `contexts/`, `lib/`, `services/`, `data/`).
- Tailwind v4 config + theme tokens + all custom CSS layers.
- shadcn components and radix-ui primitives.
- Fonts: all 7 `@fontsource-variable/*` packages pinned to identical
  versions (crimson-pro, dm-sans, geist, inter, jetbrains-mono,
  playfair-display, space-grotesk) plus `@fontsource/gelasio`.
- Assets: icons, images, illustrations.
- BlockNote editor configuration (extensions, shortcuts, slash menu
  registrations).
- Sigma graph config + force-atlas2 layout params.
- `react-day-picker`, `react-pdf`, `react-player`, `react-tweet` integrations.
- All renderer-side hooks, contexts, utility modules that are Node-free.

**What changes at the IPC boundary only:**

- `window.api.*` call sites rewritten behind
  `src/lib/ipc/forwarder.ts` (`createInvokeForwarder` /
  `subscribeEvent`), which in turn targets `src/lib/ipc/invoke.ts` and
  `src/lib/ipc/events.ts`.
- `ipcRenderer.on(...)` listeners rewritten to Tauri `listen(eventName,
  callback)` via the same forwarder seam.
- Command names mapped from Electron channel convention
  (`notes:create` / `notes:list-by-folder`) to Tauri snake_case
  (`notes_create` / `notes_list_by_folder`).
- Error unwrap swaps from `extractErrorMessage(err, fallback)` (existing
  helper) to the new `AppError`-aware equivalent in Section 5.2.

**What gets deleted (Electron-specific):**

- `src/preload/` entirely — no preload concept in Tauri.
- `src/renderer/src/lib/**` modules that wrap Electron-specific APIs
  (`window.api`, `ipcRenderer`).
- Type declarations for `window.api` / preload globals.

**Mock IPC layer during M1:**

At M1, every `invoke('command_name', args)` call in the ported renderer
returns hand-crafted mock data via a stub implementation in
`src/lib/ipc/invoke.ts`. The app is fully navigable with fake notes, tasks,
calendar events, inbox items. Each subsequent milestone replaces mock returns
with real backend calls as Rust commands come online. In implementation, the
swap seam is per-domain: services call `createInvokeForwarder('<domain>')`,
and `src/lib/ipc/invoke.ts` decides whether a command stays on mock or routes
to Rust via the `realCommands` allowlist. M2–M8 should preserve that pattern
to avoid churn in the UI layer.

## 4. Milestones

Each milestone is a distinct branch + PR. Acceptance gates must pass before
the next milestone begins.

**Mock swap model for M2–M8:** Once M1 completes, every renderer feature
already has a mock `invoke` response feeding it. Subsequent milestones
produce real Rust commands and swap the mock out — they do not touch UI
code beyond swapping the import. For example, M5 ships real
`notes_create` / `notes_list_by_folder` commands and updates
`src/lib/ipc/invoke.ts` to route those two commands through Tauri while
other commands keep returning mocks. This discipline keeps visual regressions
bounded and makes each milestone's acceptance gate verifiable by side-by-side
comparison with the Electron baseline.

**Rolling package extraction model for M2–M8:** M1 still depends on shared
`@memry/*` modules in 142 current occurrences (including aliases and type-only
imports). Waiting until M10 to inline all of that creates a large hidden
cutover risk. Each milestone must rehome the contracts, types, and runtime
helpers touched by that domain into `apps/desktop-tauri/src/` or
`apps/sync-server/src/` as part of the feature work. M10 becomes the final
zero-import sweep and deletion proof, not the first extraction pass.

**Carry-forward ledger required for every M2+ PR:** Each milestone PR body must
record four counts:

1. `@memry/*` occurrences in `apps/desktop-tauri/src`,
   `apps/desktop-tauri/tsconfig.json`, `apps/desktop-tauri/vite.config.ts`,
   and `apps/sync-server/src`.
2. Non-test Electron residue count from `pnpm --filter @memry/desktop-tauri
   port:audit`.
3. Known non-blocking warning count and whether any touched domain still emits
   one of the M1 warnings.
4. Runtime e2e lane status: not started, harness exists, or domain covered.

### M1 — Tauri Skeleton + Full Renderer Port

**Status:** Implemented 2026-04-25.

**Scope:** Boot Tauri 2, port the entire renderer UI (~942 `.tsx`/`.ts` files
plus Tailwind config, fonts, and assets) from
`apps/desktop/src/renderer/src/` into `apps/desktop-tauri/src/`, and wire a
mock IPC layer so every page is navigable with fake data. The result is
visual parity with the Electron app — opening the Tauri dev build looks
identical to the Electron dev build.

**Deliverables:**

- Scaffold derived from `pnpm create tauri-app` template + Spike 0
  configuration patterns.
- `apps/desktop-tauri/{src,src-tauri,tests,e2e,scripts}/` directory tree.
- Rust dependencies declared in `Cargo.toml` (tauri 2, rusqlite, yrs, dryoc,
  tokio, tracing, specta, tauri-specta) — declared for compile-time validation
  but not yet invoked from any command; fully wired in later milestones.
- **Full renderer port** (see Section 3 "Renderer UI port strategy"):
  - Every `.tsx`/`.ts` under `apps/desktop/src/renderer/src/` copied into
    the equivalent location under `apps/desktop-tauri/src/`.
  - Tailwind v4 config + theme tokens migrated.
  - All font packages (`@fontsource-variable/*`, `@fontsource/gelasio`)
    installed at identical pinned versions.
  - Assets (icons, images) copied verbatim.
  - `src/preload/` and Electron-only wrapper modules deleted.
  - All `window.api.*` call sites mechanically rewritten onto the
    Tauri command/event seam (`createInvokeForwarder`, `subscribeEvent`,
    `invoke`, `listen`).
  - All `ipcRenderer.on` listeners rewritten to Tauri events.
- **Mock IPC layer** in `src/lib/ipc/invoke.ts`: returns hand-crafted fixture
  data keyed by command name. Fixtures are static TypeScript modules under
  `src/lib/ipc/mocks/` (notes, tasks, calendar, inbox, folders, tags, etc.)
  large enough to exercise each page's rendering (10+ items per collection).
- `src/lib/ipc/forwarder.ts` compatibility seam that keeps renderer service
  APIs stable while converting method calls into Tauri command/event names.
- `scripts/port-audit.ts` to enforce zero non-test Electron references in the
  ported renderer.
- Vitest suite and Playwright WebKit mock-lane smoke/parity suite committed
  directly in `apps/desktop-tauri/` rather than deferred to a later milestone.
- Checked-in M1 parity baselines under
  `docs/spikes/tauri-risk-discovery/benchmarks/m1-parity/`.
- BlockNote editor boots against mock local Y.Doc in renderer (real CRDT in
  M5); typing updates in-memory state only.
- `tauri.conf.json` with valid capability layout (initially empty beyond
  core defaults).
- `scripts/generate-bindings.ts` skeleton, `pnpm bindings:check` wired to CI
  (output empty at M1 since no `#[tauri::command]` functions exist yet).
- `apps/desktop/README.md` gets FROZEN banner; CI path-guard added.
- Spike 0 artifacts retained under `docs/spikes/tauri-risk-discovery/` as
  living benchmark evidence.

**Acceptance gate:**

- `pnpm dev` opens a window visually indistinguishable from Electron's
  renderer on macOS: sidebar, tab bar, typography, colors, spacing,
  animations, theme tokens, keyboard-shortcut hints, command palette — all
  match.
- Every route navigable without broken pages: notes list, note editor,
  tasks, calendar, inbox, journal, graph, settings, templates, bookmarks,
  folders.
- Theme toggle (light/dark), command palette, keyboard shortcuts render
  correctly (they don't need to perform real actions in M1).
- BlockNote editor boots, accepts typing, slash menu opens; typing p95
  < 50ms (S1 threshold).
- Checked-in Tauri baseline PNGs exist for the primary routes/states; manual
  side-by-side Electron review remains the parity check.
- `pnpm build` produces unsigned release `.app`; the built app opens to the
  same UI as dev mode (validates asset bundling — Risk #22).
- `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm cargo:check`,
  `pnpm cargo:clippy -- -D warnings`, `pnpm bindings:check`,
  `pnpm capability:check`, and `pnpm build` clean.
- `pnpm test:e2e` currently means the mock-lane Vite/WebKit suite; 34 specs
  pass as of 2026-04-25.
- No product-code changes in `apps/desktop/`; only the freeze README banner
  and freeze CI workflow are allowed M1 edits.
- Capability sanity check passes: every plugin listed in `tauri.conf.json`
  has matching grants in `capabilities/default.json`.

**Remaining cleanup explicitly not counted as M1 blockers:**

- Remove the remaining test/build warnings before the touched domains harden:
  notes-tree React render warning, missing dialog descriptions, CSS highlight
  parser warnings, and large JS chunk warnings.
- Start replacing `@memry/*` imports in the domains touched by M2 onward;
  do not let package extraction wait until the end.

**Risks:**

- Tauri 2.x scaffold evolution (addressed in Spike 0).
- `window.api` call site count — ~56 IPC modules translate to ~500+ call
  sites in the renderer. Mechanical via codemod but high-volume; budget for
  a cleanup day to catch edge cases.
- Mock fixture volume — needs enough data for each page to feel real;
  undersized fixtures cause later visual regressions vs Electron.
- M1 shipped a strong mock-lane test harness, but real Tauri runtime
  regressions are still invisible until M5 introduces a runtime e2e lane.

**Effort:** L (~2 sprint)

### M2 — DB + Schemas + Migrations

**Scope:** rusqlite integration for canonical `data.db`, exact Electron data
schema parity, settings KV, dev seed utilities, first package-extraction slice,
and cleanup of M1 platform residue.

M2 owns **data DB only**. Search/index concerns stay out of `data.db`; M7
creates the separate rebuildable `index.db` for FTS/vector/search cache.

**Deliverables:**

- `src-tauri/src/db/mod.rs` with a single `Arc<Mutex<Connection>>` owner and
  `init_db()`. Do not add a connection pool in M2 unless a measured contention
  problem exists; SQLite write serialization and transaction clarity matter
  more at this phase.
- `src-tauri/migrations/0000_*.sql` through `0028_*.sql` or an equivalent
  zero/one-based naming scheme that maps one-to-one to the 29 Electron data
  migrations. No net-new `0029` migration unless schema diff proves a real
  missing final-schema change.
- `src-tauri/src/db/migrations.rs` — scanner + applier with `schema_migrations`
  table.
- Per-table modules with `#[derive(specta::Type, serde::Serialize, Deserialize)]`
  structs only for tables that exist in `data.db` after the 29 migrations.
  File-backed aggregates (`Note`, `JournalEntry`, `Folder`, `Template`) emerge
  in M3/M5/M8; index/search-only types (`Embedding`) emerge in M7; CRDT tables
  emerge in M5.
- Settings KV commands: `settings_get`, `settings_set`, `settings_list`.
- `scripts/dev-reset.sh` — wipes app data and re-runs migrations.
- Required schema-diff script comparing final Electron `data.db` schema to the
  Tauri `data.db` schema.
- First specta export filling `src/generated/bindings.ts` with domain types.
- Replace `electron-log/renderer` with a Tauri-safe renderer logger and extend
  `port:audit` to catch `electron-log`, `from 'electron'`, `electron/`, and
  `@electron` imports in non-test code.
- Rehome the settings-domain contracts/defaults touched by real
  `settings_*` commands into `apps/desktop-tauri/src/`, or document why a
  specific import remains. Record before/after `@memry/*` occurrence counts.

**Acceptance gate:**

- Cold start applies all migrations without error.
- Migration runner idempotent across restarts.
- Electron-vs-Tauri schema diff is clean or contains only explicitly documented
  intentional differences.
- Renderer round-trips `settings_get`/`settings_set` with correct specta types.
- Rust tests: ≥20 smoke tests across tables (CRUD roundtrips).
- Bench: 1000-note list query p50 < 20ms (S3 baseline).
- `pnpm bindings:check` shows no drift.
- `pnpm --filter @memry/desktop-tauri port:audit` catches the expanded Electron
  pattern set and exits 0.

**Risks:** Drizzle migrations 0001–0019 may have implicit semantics missed in
manual port — mitigated by dumping schema from Electron DB and diffing. The
current M2 implementation plan still mentions `r2d2_sqlite`; patch that plan
before execution so it matches the single-connection decision above.

**Effort:** M (~1.5 sprint)

### M3 — Vault FS + File Watcher

**Scope:** `.md` read/write, frontmatter parse, notify watcher, vault
preferences.

**Deliverables:**

- `src-tauri/src/vault/fs.rs` — async read/write with atomic write (temp +
  rename) pattern.
- `frontmatter.rs` — YAML parse via serde_yaml with property validation.
- `watcher.rs` — notify crate with 150ms debounce, emits `vault-changed`
  events.
- `notes_io.rs` — high-level operations (`read_note_from_disk`,
  `write_note_to_disk`).
- `preferences.rs` — vault-root JSON config.
- Commands: `vault_open`, `vault_close`, `vault_get_current`,
  `vault_list_notes`, `vault_read_note`, `vault_write_note`.
- Event: `vault-changed` with `{path, kind}` payload.
- Path normalization helpers that reject vault escape (`..`), symlink escape,
  hidden app-internal folders, and unsupported filenames before any read/write.
- Drag/drop path-resolution spike for Tauri/WebKit so file import, PDF import,
  and attachment flows do not depend on Electron-only `File.path`.

**Acceptance gate:**

- `vault_open` scans 100-note test vault in <500ms.
- External file edits emit watcher events to renderer.
- Frontmatter roundtrips Turkish characters, multiline YAML, date fields
  without loss.
- Atomic write survives mid-write crash simulation.
- Path traversal and symlink-escape tests fail closed.
- Tauri drag/drop path resolution has a working manual smoke or a documented
  fallback command before file-import features land in M8.
- Renderer integration smoke: open/create/delete reflects in UI.
- `cargo test --package vault` passes.

**Risks:**

- macOS FSEvents rename detection has edge cases; notify v6 offers fallback.
- Sandboxed apps affect vault path access; Tauri default is non-sandboxed and
  plan assumes that.

**Effort:** M (~1 sprint)

### M4 — Crypto + Keychain + Auth

**Scope:** XChaCha20-Poly1305, Ed25519, Argon2id, macOS keychain, auth state
machine, OTP, device registration.

**Deliverables:**

- `src-tauri/src/crypto/primitives.rs` — dryoc wrappers (`encrypt_blob`,
  `decrypt_blob`, `sign`, `verify`, `derive_vault_key`).
- `nonces.rs` — 24-byte random nonce helper.
- `sign_verify.rs` — Ed25519 keypair, sign/verify, constant-time compare.
- `keychain.rs` — security-framework wrapper (`set_item`, `get_item`,
  `delete_item`) under service `com.memry.vault` and `com.memry.device`.
- `vault_keys.rs` — password → Argon2id → master key → keychain cache →
  in-memory SecretBox.
- Commands: `auth_unlock`, `auth_lock`, `auth_status`, `auth_register_device`,
  `auth_request_otp`, `auth_submit_otp`, `auth_enable_biometric` (stub).
- Secret storage commands used by later features:
  `secrets_set_provider_key`, `secrets_get_provider_key_status`,
  `secrets_delete_provider_key`. These return only status/masked metadata to
  the renderer; no command returns raw provider keys.
- `AuthState` enum: Locked, Unlocking, Unlocked, Error.
- OAuth relay via sync-server (redirect to `memry://oauth-callback` — deep
  link infra in M9).
- PII-safe tracing helper for email, note title, provider key, token, and URL
  redaction before logs leave the command boundary.
- ≥40 tests across crypto primitives.

**Acceptance gate:**

- Wrong password → `AuthError::InvalidPassword`, keychain untouched.
- Correct password → keychain caches master key, AuthState Unlocked.
- Restart auto-unlocks if "remember device" is set.
- macOS Keychain Access.app shows items under correct service identifier.
- OTP + device registration round-trips against sync-server staging.
- Argon2id params match Electron spec for portability (iterations/memory/
  parallelism canonical values).
- Provider key set/status/delete round-trips through keychain without exposing
  raw key material to renderer logs, return values, or generated bindings.

**Pre-flight subspike:** 1-day subspike at start of M4 to validate
security-framework API on current macOS version. Fallback to `keyring-rs` if
blocking issues surface.

**Risks:**

- security-framework API changes between macOS versions.
- dryoc vs sodiumoxide choice: dryoc selected for pure-Rust constant-time
  guarantees and active maintenance.
- Argon2id on main thread blocks UI — use `tokio::task::spawn_blocking`.

**Effort:** L (~2 sprint)

### M5 — Notes CRUD + BlockNote + CRDT

**Scope:** Full notes end-to-end with yrs authoritative CRDT (Spike S2
Prototype B), renderer shadow Y.Doc, BlockNote binding.

**Deliverables:**

- `src-tauri/src/crdt/mod.rs` — DocStore (`Mutex<HashMap<NoteId, Doc>>`).
- `crdt/apply.rs` — decode v1 update + apply.
- `crdt/snapshot.rs` — encode_state_as_update_v1 on demand.
- `crdt/compaction.rs` — periodic snapshot after N updates, old updates
  dropped.
- DB tables for `crdt_updates` + `crdt_snapshots`.
- Commands: `crdt_apply_update` (Channel<u8> streaming),
  `crdt_get_snapshot` (Response<Vec<u8>>), `crdt_get_state_vector`,
  `notes_create`, `notes_get`, `notes_update`, `notes_delete`,
  `notes_list_by_folder`.
- Dev-only runtime test commands behind a debug/test capability:
  `devtools_reset_db`, `devtools_seed_vault`, `devtools_open_test_vault`.
  These are required for the first real Tauri-runtime e2e lane and must not be
  exposed in production capabilities.
- Renderer `lib/crdt/yjs-tauri-provider.ts` — shadow Y.Doc setup with origin
  tag loop guard.
- BlockNote editor integration via y-prosemirror.
- MD → Yjs conversion helper (journal compat prep).

**Acceptance gate:**

- 500-char paragraph typing: renderer p95 < 15ms.
- Concurrent edit across `MEMRY_DEVICE=A` + `B` converges byte-identical
  (S2 Test 5d reproduced in runtime).
- Restart persistence: note content survives app close/reopen.
- Undo/redo 10-op chain correct (S1 Test 9).
- Slash menu, table, code block, link insertion work.
- Snapshot compaction: 100 updates → snapshot written, old updates removed,
  replay correct.
- ≥15 Rust tests across crdt + db::crdt_updates.
- Tauri-runtime e2e: 5 core scenarios (typing, manual clipboard paste,
  slash menu, undo/redo, concurrent edit). The existing M1 Vite/WebKit
  smoke lane remains for fast mock-lane regression checks.
- Runtime lane proves real invoke/event/capability behavior with the debug
  reset/seed commands above. Mock-lane tests alone no longer satisfy the gate.

**Risks:**

- S2 deferred: BlockNote nested blocks and overlapping marks tested in M5
  for the first time. Upstream yrs issue possible; trip-wire applies.
- IPC loop edge cases under real Tauri runtime.

**Effort:** L (~2.5 sprint)

### M6 — Sync Engine

**Scope:** HTTP push/pull, WebSocket, queue, retry, per-type handlers,
field-level vector-clock merge, CRDT sync endpoint.

**Deliverables:**

- `sync/engine.rs` — tokio task with pull → apply → push → listen loop.
- `http.rs` — reqwest with cert pinning (via `rustls::ClientConfig` custom
  verifier).
- `ws.rs` — tokio-tungstenite with exponential backoff reconnect.
- `queue.rs` — sync_queue table CRUD, per-item dedup.
- `retry.rs` — backoff policy.
- `handlers/` — 13 per-type handlers implementing `SyncItemHandler` trait:
  notes, tasks, projects, calendar, inbox, journal, folders, tags, bookmarks,
  templates, filters, settings, reminders.
- `field_merge.rs` — per-field vector clock merge (Phase 8 pattern from
  MEMORY.md).
- `crdt_updates.rs` (sync side) — `/sync/crdt/updates` endpoint integration
  with separate CrdtUpdateQueue.
- `crypto_batch.rs` — batch encrypt/decrypt on queue flush.
- Commands: `sync_start`, `sync_stop`, `sync_push_now`, `sync_pull_now`,
  `sync_status`, `sync_reset_cursor`.
- Events: `sync-progress`, `sync-error`, `sync-completed`.
- Critical ordering from MEMORY.md: engine.start (pull) → seed_existing_crdt
  (fire-and-forget) → per-batch push_snapshot_for_note → POST /sync/push.
- Sync-server contract extraction: rehome the sync/auth/blob contract modules
  touched by the Rust client into `apps/sync-server/src/` or a clearly named
  app-local contracts directory. Keep the Rust request/response structs aligned
  with those schemas through explicit parity tests.

**Acceptance gate:**

- 2-device round-trip: note edit propagates < 3s via WebSocket notification.
- Field-level concurrent task edits on different fields both preserved.
- WS drop: auto-reconnect <5s, queue drain.
- Offline edit → app restart → reconnect drains queue exactly once.
- Sign-out/sign-in preserves CRDT (MEMORY.md bug fix verified).
- Cert pinning fails closed with modified cert.
- Protocol parity tests cover sync push/pull/auth/blob payload shapes against
  the sync-server schemas.
- ≥50 Rust tests.
- Staging environment live round-trip smoke.

**Risks:**

- Cert pinning crate selection — custom rustls verifier requires 1-day
  subspike early in M6.
- WebSocket reliability under Tauri runtime — 24-hour stress test
  (wifi toggle loop) in acceptance.

**Effort:** XL (~3.5 sprint)

### M7 — Search + Embeddings

**Scope:** Rebuildable `index.db` for FTS5, sqlite-vec extension bundling,
vector kNN, and hybrid search. `data.db` remains canonical user state.

**Deliverables:**

- `src-tauri/src/index_db/mod.rs` with separate path resolution, migrations,
  and reset/rebuild lifecycle from `data.db`.
- `search/fts.rs` — FTS5 rebuild and query helpers.
- `search/vector.rs` — sqlite-vec extension load, `vec0` virtual table, kNN.
- `search/extensions.rs` — `.dylib` path resolution (bundled in
  `.app/Contents/Resources/`).
- `scripts/bundle-sqlite-vec.sh` — preinstall hook downloading
  sqlite-vec 0.1.7-alpha.2 `.dylib`.
- `tauri.conf.json` `bundle.resources` entry.
- Index DB init loads extension via `conn.load_extension()`.
- Commands: `search_fts`, `search_vector`, `search_hybrid`.
- Embeddings generated renderer-side via `@huggingface/transformers` (WASM,
  unchanged) → `invoke('embeddings_store', …)`.

**Acceptance gate:**

- sqlite-vec `.dylib` present for macOS arm64 (+ x86_64 if universal binary).
- Extension loads without error; `vec0` table creation succeeds.
- Deleting `index.db` and launching the app rebuilds search state from
  canonical `data.db` + vault files without data loss.
- FTS query on 1000-note Turkish corpus: p95 < 50ms.
- Vector kNN 10k embeddings 128-dim: p95 < 100ms in release build (with vec0).
- Hybrid search top-3 relevance sanity check across 10 manual queries.
- ≥15 Rust tests.

**Risks:**

- sqlite-vec alpha binary availability — if missing for macOS, self-build
  from upstream Makefile.
- Naive-scan fallback (S3 proven) if extension infeasible — trip-wire 3.

**Effort:** M (~1 sprint)

### M8 — Remaining Features

**Scope:** All remaining features. Sub-milestones can run in parallel since
foundation from M1–M7 is in place.

Dependency ordering inside M8 is still strict where features share native
plumbing:

- Deep links must land before Google Calendar OAuth is accepted.
- M4 keychain secret status/set/delete commands must land before AI provider
  settings or inline completions are accepted.
- M3 drag/drop path resolution must land before file import, PDF import, and
  attachment flows are accepted.
- Vault/CRDT note foundations must land before journal/templates/folder default
  template behavior is accepted.

**Sub-milestones (each 1–3 days):**

- **M8.1** Tasks + Projects — CRUD commands, field-level merge (infra ready in
  M6), UI port.
- **M8.2** Journal — date-based notes, CRDT Y.Doc, collision merge (MEMORY.md
  Phase 7).
- **M8.3** Tags + Saved Filters.
- **M8.4** Folders + Folder Configs.
- **M8.5** Templates.
- **M8.6** Inbox — CRUD + batch; voice model stays in renderer WASM.
- **M8.7** Inbox snooze scheduler — Rust tokio task, minute-tick on reminders
  table.
- **M8.8** Bookmarks + URL metadata — reqwest + scraper custom, ~80% feature
  parity with metascraper.
- **M8.9** Calendar — Google OAuth via sync-server relay, events, sources,
  bindings. Requires the deep-link handler from M8.17 or an earlier split of
  that work.
- **M8.10** Calendar sync scheduler — Rust tokio task.
- **M8.11** Graph view — sigma + graphology renderer-side; Rust provides
  `graph_build_nodes`, `graph_build_edges` commands.
- **M8.12** AI inline completions — Vercel AI SDK + `@blocknote/xl-ai` with
  custom fetch adapter wired to a new Rust command `ai_http_fetch_stream`
  that reads the provider key from keychain, performs the HTTPS call with
  `reqwest`, and streams response bytes back through `Channel<u8>`. Renderer
  never holds a raw API key. Covers OpenAI + Anthropic providers at minimum.
- **M8.13** PDF handling — pdfjs-dist renderer + Rust pdf-extract for
  server-side text extraction. Requires M3 drag/drop/path-resolution behavior
  before file import is marked complete.
- **M8.14** Thumbnails — Rust image crate, write-time generation, Channel<u8>
  binary return.
- **M8.15** Reminders — merged into snooze infrastructure.
- **M8.16** Settings UI + global capture shortcut
  (tauri-plugin-global-shortcut).
- **M8.17** Deep links — `memry://` URL handler wiring.

**Acceptance gate per sub-milestone:**

- UI parity with Electron screenshot.
- CRUD smoke tests pass.
- ≥1 Playwright e2e covering core flow.
- ≥5 Rust tests where backend logic exists.
- Touched `@memry/*` contracts/types/helpers are rehomed locally or explicitly
  counted in the carry-forward ledger.

**Risks:**

- `@blocknote/xl-ai` + renderer-only AI SDK documented coverage —
  1-day POC at start of M8.12; fallback is custom AI UI (scope expansion).
- Metascraper parity ~80% — remaining edge cases deferred post-v1.

**Effort:** XL (~3 sprint parallel, ~5 sprint serial)

### M9 — Updater + Packaging + Code Signing

**Scope:** tauri-plugin-updater, signed `.app`, GitHub Releases, DMG, deep
links plumbing, global shortcut.

**Deliverables:**

- tauri-plugin-updater config + ed25519 signing keypair.
- GitHub Release asset workflow with `latest.json` manifest.
- Apple Developer ID signing + notarization flow.
- `.app` → `.dmg` packaging.
- Automatic update check on startup (with user opt-out setting).
- `memry://` deep link handler finalized (registered in `tauri.conf.json`
  `osxUrlSchemes`).
- Global shortcut registered (⌥Space default).

**Acceptance gate:**

- Release build signed + notarized; Apple notary accepts.
- First-run from DMG passes Gatekeeper.
- Mock newer version triggers updater UI → apply → restart with new version.
- Google OAuth callback round-trips via `memry://oauth-callback`.
- Global shortcut opens quick capture window.

**Risks:**

- Apple notarization latency (~15-30 min per build) — batched in CI.
- Kaan's Apple Developer Program account active (verify at M1 — see risk
  5.6 #4).

**Effort:** M (~1 sprint)

### M10 — Package Extraction + E2E Port + Electron Cleanup

**Scope:** Finish the remaining `@memry/*` extraction work, prove both `apps/`
packages build without `packages/`, complete any runtime e2e coverage not
already started in M5-M8, dogfood, then delete Electron + packages.

Ordering inside M10 is strict: **extraction → dry-run build → E2E port →
dogfood → deletion**. No step runs ahead of the one before it.

**Sub-steps:**

- **M10.1 Extraction audit** — Run `rg '@memry/'` over
  `apps/desktop-tauri/src`, `apps/desktop-tauri/tsconfig.json`,
  `apps/desktop-tauri/vite.config.ts`, and `apps/sync-server/src` to produce
  the complete list of remaining cross-package imports/aliases. Categorize
  each as either (a) type-only (can be inlined as a local `types.ts`),
  (b) runtime utility (inline into the consuming app), or (c) shared contract
  between desktop-tauri and sync-server (must survive as an app-local module or
  a kept package). M10 should be a final sweep; if a domain first appears here,
  that domain missed its M2-M8 extraction gate.
- **M10.2 Rehome into `apps/desktop-tauri/src/`** — Inline each remaining
  `@memry/*` import used by the Tauri renderer. Update tsconfig path aliases
  to remove `@memry/*` entries. Run `pnpm --filter @memry/desktop-tauri
  typecheck` after every module rehomed.
- **M10.3 Rehome into `apps/sync-server/src/`** — Same exercise for the
  Cloudflare Worker. Every `@memry/*` import becomes a local module.
- **M10.4 Packages dry-run** — On a throwaway branch, run
  `git rm -rf packages/` and confirm both commands exit 0:
  `pnpm --filter @memry/desktop-tauri build` and
  `pnpm --filter @memry/sync-server build`. If either fails, restore and
  return to M10.1 to catch the missed import. Do NOT commit the dry-run
  branch.
- **M10.5 E2E completion** — The M1 mock-lane Playwright suite already exists,
  and the real runtime lane must have started in M5. Complete any remaining
  behavioral coverage against the real Tauri runtime: port missing
  `apps/desktop/e2e/**/*.spec.ts` coverage, keep critical-path journeys on the
  runtime harness, and preserve the fast M1 mock-lane for parity/smoke checks.
  Coverage: onboarding, note CRUD, 2-device sync, calendar event, inbox snooze,
  search, settings.
- **M10.6 Dogfood** — 1-week Kaan dogfood period on a real vault. Bug
  backlog collected; blockers fixed before proceeding.
- **M10.7 Cutover** — Real deletion: `git rm -rf apps/desktop/ packages/`.
  This is the ONE PR allowed to touch `apps/desktop/**` (see freeze-guard
  bypass label in Section 5.x). Clean `pnpm-workspace.yaml`. Rewrite project
  `CLAUDE.md` with Tauri instructions. Release tag `v2.0.0`. Archive the
  last Electron binary under a separate v1.x release for emergency rollback.

**Acceptance gate:**

- M10.1-M10.4 done: `grep -r '@memry/' apps/` returns zero matches.
- `pnpm --filter @memry/desktop-tauri build` and
  `pnpm --filter @memry/sync-server build` both succeed on a branch with
  `packages/` deleted.
- Runtime-lane Tauri e2e critical paths pass, and the fast mock-lane suite
  stays green.
- 1-week dogfood without regression.
- Bundle size <80MB (Electron ~150MB baseline; Tauri target <60MB).
- Cold start <2s (Electron ~4s baseline; Tauri target <1.5s).
- `apps/desktop/` and `packages/` deleted; CI green.

**Risks:**

- A `@memry/*` import hides behind dynamic `import()` or string-interpolated
  path and escapes grep. Mitigation: M10.4 dry-run catches it at build time.
- `apps/sync-server` relies on a type that has drifted away from the shared
  source. Mitigation: M10.3 typecheck surfaces it; inline the current
  server-side shape.
- Playwright WebKit clipboard gap — manual QA covers it (S1 finding).
- Dogfood may surface CRDT/sync edge cases — bug backlog + hot-fix sprint.

**Effort:** L→XL (~2.5-3 sprint; extraction + dry-run adds ~0.5-1 sprint
over the original M10 scope).

### Milestone dependency graph

```
M1 ──┬─ M2 ──┬─ M3 ─────────┐
     │       │               │
     │       └─ M4 ─────┬───┤
     │                  │    │
     └──────────────────┼────┴─ M5 ── M6 ── M7 ── M8(parallel) ── M9 ── M10
```

M3 and M4 can run in parallel (different worktrees). Sub-milestones under M8
run in parallel.

### Effort summary

| Milestone | Size | Sprint estimate |
|-----------|------|-----------------|
| M1 | L | 2 |
| M2 | M | 1.5 |
| M3 | M | 1 |
| M4 | L | 2 |
| M5 | L | 2.5 |
| M6 | XL | 3.5 |
| M7 | M | 1 |
| M8 (parallel) | XL | 3 (parallel) / 5 (serial) |
| M9 | M | 1 |
| M10 | L-XL | 2.5-3 |
| **Total** | | **~22-23 sprint (~5.5-6 months) serial** or **~20-21 sprint (~5-5.5 months) with M8 parallel** |

## 5. Cross-cutting Conventions

### 5.1 IPC command conventions

**Naming:** `module_action[_qualifier]` snake_case.

**Command signature pattern:**

```rust
#[tauri::command]
#[specta::specta]
pub async fn notes_create(
    state: tauri::State<'_, AppState>,
    input: NoteCreateInput,
) -> Result<Note, AppError> {
    state.db.notes.create(input).await
}
```

Rules:

- Every command gets both `#[specta::specta]` and `#[tauri::command]`.
- Single input struct per command (no loose args) — rename safety + renderer
  ergonomics.
- Return `Result<T, AppError>` — single error enum across all commands.
- `async` by default; blocking work goes through `tokio::task::spawn_blocking`.
- State injected via `tauri::State<'_, AppState>`.

**Renderer invocation via typed wrapper:**

```typescript
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import type { Commands } from '@/generated/bindings'

export function invoke<K extends keyof Commands>(
  cmd: K,
  args: Commands[K]['input']
): Promise<Commands[K]['output']> {
  return tauriInvoke(cmd, args)
}
```

Compile-time type safety + rename-safe refactoring.

**Event naming:** kebab-case (`sync-progress`, `vault-changed`, `crdt-update`).
Payloads typed via specta-generated EventPayloads map.

### 5.2 Error handling

**Single `AppError` enum in Rust:**

```rust
#[derive(Debug, thiserror::Error, serde::Serialize, specta::Type)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    Database(String),
    Crypto(String),
    VaultLocked,
    InvalidPassword,
    NotFound(String),
    Network(String),
    Conflict(String),
    Validation(String),
    Internal(String),
}
```

With `From` impls for common underlying error types (rusqlite, reqwest,
serde_json, dryoc, io).

Rules:

- No `unwrap()` / `expect()` in command paths (allowed only in
  app_state init fatal-bug scenarios).
- Panic handler converts panics to tracing error + graceful app quit.
- Dev builds log full context via tracing; production emits AppError message
  only.

**Renderer `extractErrorMessage` helper** maps AppError variants to
user-friendly UI strings. UI never renders raw error text.

### 5.3 Logging

**Rust backend — tracing with JSON structured logs:**

```rust
use tracing::{info, warn, error};
use tracing_subscriber::{fmt, EnvFilter};

pub fn init_logging() {
    let file_appender = rolling::daily("~/Library/Logs/memry", "memry.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
    fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(non_blocking)
        .json()
        .init();
}
```

- Structured fields preferred: `info!(target: "memry::sync", note_id = %id, "pushing")`.
- Production default: `RUST_LOG=memry=info,tauri=warn`.
- Log location: `~/Library/Logs/memry/memry.log` (daily rotation, 7-day
  retention).

**Renderer — scope-prefixed logger:**

```typescript
class Logger {
  constructor(private scope: string) {}
  info(msg: string, ctx?: Record<string, unknown>) { /* … */ }
  error(msg: string, err?: unknown) { /* … */ }
}
export function createLogger(scope: string): Logger { … }
```

- `console.log` direct use is forbidden.
- Critical errors forwarded to Rust via `invoke('logging_forward', …)` for
  unified log stream in production.

### 5.4 Type generation

See Section 3 ("Type generation"). Rust-origin TS types via tauri-specta,
Zod schemas hand-written.

### 5.5 Testing strategy

| Layer | Tool | Scope |
|-------|------|-------|
| Rust unit | `cargo test` | db, crypto, crdt, sync, vault, search logic |
| Rust integration | `cargo test --test *` | End-to-end SQLite + migrations |
| TS unit | Vitest | Utilities, hooks, schema validation |
| TS component | Vitest + Testing Library | React render + event |
| E2E (fast lane) | Playwright WebKit | Vite + mock IPC smoke/parity checks |
| E2E (runtime lane) | Playwright + Tauri runtime harness | Real invoke/event/capability journeys starting in M5 |

Rust test pattern uses in-memory SQLite with migrations applied.

Coverage targets:

- Rust: crypto, sync engine, crdt critical paths ≥80%.
- TS: pure utilities ≥80%, components ≥60% behavior-focused.
- E2E: 20+ critical user journeys.

Playwright notes from Spike 0 and M1:

- BlockNote selector: `.bn-editor`.
- Clipboard API limitation: manual test checklist; not automated.
- DataTransfer synthesis broken; use `page.setInputFiles` workaround.
- In M1, e2e runs against Vite because every command is still mocked.
- By M5, add a real Tauri-runtime lane with `devtools_reset_db` + creates test
  vault + unlocks before-hook parity. Runtime-lane tests must verify real
  invoke, event, binary IPC, and capability behavior; mock-lane visual tests do
  not cover those risks.

### 5.6 Dev workflow

**Device profiles** (Electron MEMRY_DEVICE pattern ported):

```bash
MEMRY_DEVICE=A pnpm dev  # app data path: memry-A
MEMRY_DEVICE=B pnpm dev  # memry-B
```

Rust main.rs reads env var and segregates `app_data_dir`.

**Migration ergonomics:**

- `src-tauri/migrations/####_name.sql` — manual creation (Drizzle gone).
- `scripts/new-migration.ts` helper: `pnpm migration:new "add_xyz"` creates
  timestamped skeleton.
- Schema diff script compares Electron DB against Tauri DB for parity
  verification.
- M2 owns `data.db`; M7 owns rebuildable `index.db`. Do not mix FTS/vector
  tables into the canonical data DB.
- M2 uses a single `Arc<Mutex<rusqlite::Connection>>` unless benchmarked
  contention proves a pool is needed. If that decision changes, update this
  spec and the M2 plan in the same PR.

**Hot reload:**

- Renderer via Vite HMR (instant).
- Rust via Tauri 2 dev auto-restart on file change.

### 5.7 Security conventions

- `capabilities/default.json` explicit grants per plugin. S3 observation
  #11: silent denial looks like hang. M1 acceptance test enforces
  plugin-list ↔ grants cross-check.
- `tauri.conf.json` `security.csp` stays **deliberately narrow** from M1
  onward: `default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:;
  connect-src 'self' ipc: https://ipc.localhost http://localhost:1420`.
  No third-party host needs to be whitelisted because **the renderer makes
  zero outbound HTTPS calls** — every network request (LLM providers, sync
  server, attachment uploads) originates from Rust. AI traffic goes through
  `ai_http_fetch_stream` (D5); sync traffic goes through the sync engine in
  Rust (`sync/http.rs` + `sync/ws.rs`). Any future feature that needs a
  third-party host adds a new Rust command, not a CSP entry. Keeping CSP
  closed is a defense-in-depth for renderer-side XSS risk.
- Secrets (API keys, device keypair, master vault key) in OS keychain.
- Dev-only `.env` not bundled in production.
- Input validation: `impl NoteCreateInput::validate()` for domain rules;
  Zod schemas pre-submit in renderer.

### 5.8 Performance conventions

- Binary IPC boundary at 8KB: larger payloads use `Response::new(Vec<u8>)`
  or `Channel<u8>`. Code review enforces this.
- Prepared statement cache kept in Rust state; transactions explicit via
  `conn.transaction(…)`.
- WebKit's ms-rounding prevents sub-ms timing in renderer (S3 observation
  #3); micro-benchmarks return Rust-side timings via dedicated commands.

### 5.9 Code style

- Rust: `rustfmt.toml` default, `clippy -- -D warnings` CI required, private
  by default, `pub(crate)` encouraged over broad `pub`.
- TypeScript: Prettier (single quotes, no semicolons, 100 char, no trailing
  commas), ESLint flat config, named exports, explicit return types on
  exports.

## 6. Risks + Open Questions

### 6.1 Spike 0 carried forward

| # | Risk | Milestone | Mitigation |
|---|------|-----------|------------|
| 1 | Playwright WebKit clipboard API unsupported | M5, M10 | Manual QA checklist |
| 2 | Playwright DataTransfer synthesis broken | M5, M10 | `setInputFiles` workaround |
| 3 | Tauri capability silent denial = hang | M1 + plugin adds | Capability sanity check script |
| 4 | Default invoke Vec<u8> JSON overhead | M5, M6, M8 | Section 5.8 discipline |
| 5 | WebKit performance.now() ms-rounding | All benches | Rust-side timing commands |
| 6 | `pnpm install --ignore-workspace` ergonomics | M1 | Proper workspace integration from start |
| 7 | Rust debug build slow vector ops | M7 bench | Release build mandatory |
| 8 | S2 deferred: BlockNote nested blocks + marks | M5 | M5 acceptance gate explicit |
| 9 | S2 deferred: CRDT compaction 100k ops perf | M5 | Synthetic stress test in M5 |
| 10 | plugin-sql rejected — option A sticky | All | No fallback to plugin-sql |

### 6.2 Migration-specific risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| 11 | security-framework API on current macOS | M | H | M4 pre-spike (1 day); keyring-rs fallback |
| 12 | tokio-tungstenite reliability under Tauri | M | M | M6 24-hour stress test |
| 13 | tauri-plugin-updater ergonomics | L | M | M9 subspike (1 day) |
| 14 | Apple Developer ID signing setup | L | M | Account verified at M1; config at M9 |
| 15 | @blocknote/xl-ai + Vercel AI SDK custom-fetch adapter streaming through Rust proxy (Channel<u8>) | M | M | M8.12 starts with 1-day POC: verify AI SDK accepts custom fetch, streaming ReadableStream reconstruction from Tauri channel works with SSE; fallback = direct-HTTPS design with CSP widening + key reconsidered |
| 16 | sqlite-vec alpha binary availability | M | H | Self-build fallback; naive-scan fallback |
| 17 | specta/tauri-specta generic type corner cases | M | M | M2 stress test (20+ structs) |
| 18 | Rust compile time in large codebase | H | M | sccache in M1; incremental discipline |
| 19 | Metascraper parity ~80% | H | L | Post-v1 enhancement for missing cases |
| 20 | @huggingface/transformers WASM in WKWebView | M | M | M8.6 smoke test |
| 21 | macOS deep link registration | L | M | M9 default Tauri pattern |
| 22 | Tauri bundled asset serving in prod | L | H | M1 acceptance: prod build BlockNote render |
| 23 | Argon2id blocking main thread | M | M | `tokio::task::spawn_blocking` in M4 |

### 6.3 Open questions

| # | Question | Decision point | Default |
|---|----------|---------------|---------|
| Q1 | turbo.json for Tauri pipeline? | M1 | Independent scripts, no turbo |
| Q2 | Workspace membership | M1 | apps/* glob auto-includes |
| Q3 | specta vs tauri-specta | M2 | **tauri-specta** |
| Q4 | Migration rollback files | M2 | Single `####_name.sql` (no down) |
| Q5 | Drizzle → SQL extraction script | M2 | 1-day manual dump + transform |
| Q6 | dryoc vs sodiumoxide vs libsodium-rs | M4 | **dryoc** |
| Q7 | Keychain service identifier | M4 | `com.memry.vault` + `com.memry.device` |
| Q8 | AI API key storage | M8.12 | Keychain (user-wide) |
| Q9 | Google OAuth flow | M8.9 | Browser + deep link |
| Q10 | Thumbnail generation timing | M8.14 | Write-time |
| Q11 | Tracing PII sanitize policy | M4+ | Helper fn sanitizes email/title |
| Q12 | Electron dev vault → Tauri migration | M5 dogfood | **Reset** (pre-production) |
| Q13 | CI cargo cache strategy | M1 | Swatinem/rust-cache@v2 |
| Q14 | Release versioning | M9 | v2.0.0-alpha.N during dev |

### 6.4 Trip-wires

**Trip-wire 1:** M4 keychain flow unstable after 2 days → full `keyring-rs`
switch, +3 day buffer.

**Trip-wire 2:** M5 BlockNote CRDT mark/nested corruption → pause, upstream yrs
issue, 1-week wait; fallback to S2 Prototype A (renderer-authoritative Y.Doc,
yrs persistence-only).

**Trip-wire 3:** M7 sqlite-vec unavailable + self-build fails → naive-scan
fallback (S3 proven for <50k vectors).

**Trip-wire 4:** M10 dogfood reveals critical sync data-loss → release freeze,
hot-fix sprint, Electron binary emergency release active via archived v1.x tag.

Trip-wires produce local fallback + timeline extension; they do not abort the
migration.

### 6.5 Assumptions

- Kaan is solo (or 1–2 engineers) — plan is single-threaded; parallel team
  shrinks M8 significantly.
- Zero users (pre-production) — no data migration, no BC constraints.
- `apps/sync-server/` stays stable; Tauri uses the same HTTP/WS protocol.
- Apple Developer Program account active (verify at M1).
- OpenAI/Anthropic API keys provided by Kaan manually; no key provisioning
  feature.

## 7. Decisions Log

All decisions below were confirmed in the brainstorming session 2026-04-24.

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Full Rust rewrite; no Node sidecar | User intent: "as if Node/Electron was never written" |
| D2 | Electron frozen at M1, deleted at M10 | No resources spent on dual maintenance; pre-production |
| D3 | macOS only for v1 | Spike 0 only validated WKWebView; Win/Linux post-v1 |
| D4 | Greenfield `apps/desktop-tauri/`; `packages/*` deleted at M10 | Clean monorepo; TS-only bits inlined |
| D5 | AI SDK UI renderer-side, HTTPS proxied through Rust (Vercel AI SDK custom fetch → `ai_http_fetch_stream` → keychain-backed key) | Preserve `@blocknote/xl-ai` integration + streaming UX AND keep LLM credentials out of the renderer trust boundary |
| D6 | Horizontal milestone sequencing (M1–M10 layer-by-layer) | Features share infrastructure; vertical slices are mostly foundation |
| D7 | Rust single crate with nested modules | Workspace split overkill at this scale |
| D8 | rusqlite + custom Tauri commands (not plugin-sql) | S3 Option A proven; plugin-sql had unresolvable FTS5 hang |
| D9 | yrs authoritative in Rust + shadow Y.Doc in renderer | S2 Prototype B byte-compatibility proven |
| D10 | Drizzle dropped; hand-written SQL migrations | Already partially hand-written from 0020+; eliminates tooling dependency |
| D11 | tauri-specta for TS type generation; Zod hand-written | Compile-time types + runtime validation separated by concern |
| D12 | Binary IPC >8KB boundary using Response<Vec<u8>> / Channel<u8> | S3 observation #4: default JSON overhead measurable |
| D13 | dryoc for crypto primitives | Pure Rust, constant-time, active maintenance |
| D14 | security-framework for macOS keychain | Native API; keyring-rs fallback |
| D15 | Single AppError enum (not per-domain enums) | Simpler renderer switch logic; type explicit via serde tag |

## 8. References

- Spike 0 findings: `docs/spikes/tauri-risk-discovery/findings.md`
  - S1: `s1-blocknote-webview.md`
  - S2: `s2-yjs-placement.md`
  - S3: `s3-db-placement.md`
- Spike 0 design: `docs/superpowers/specs/2026-04-23-spike-0-tauri-risk-discovery-design.md`
- Project CLAUDE.md: `CLAUDE.md`
- MEMORY.md (project context): `~/.claude/projects/…/memory/MEMORY.md`
- Tauri 2 docs: https://v2.tauri.app/
- yrs crate: https://docs.rs/yrs/0.21.3/yrs/
- rusqlite: https://github.com/rusqlite/rusqlite
- dryoc: https://github.com/brndnmtthws/dryoc
- security-framework: https://docs.rs/security-framework/
- tauri-specta: https://github.com/oscartbeaumont/tauri-specta
- sqlite-vec: https://github.com/asg017/sqlite-vec

## 9. Next step

M1 is done. Next executable plan is M2
(`docs/superpowers/plans/2026-04-25-m2-db-schemas-migrations.md`) with the
carry-forward constraints above: start incremental package extraction
immediately, patch the M2 plan to match the single-connection `data.db`
decision, make schema diff required, remove the ambiguous net-new `0029`
migration unless proven necessary, and define the first real Tauri-runtime e2e
lane no later than M5.
Subsequent milestones get their own
plan/execute cycles — a single monolithic plan for all 10 milestones is too
large to remain coherent.
