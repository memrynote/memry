# MemryNote Mobile (Expo / React Native) — Architecture & Delivery Plan

**Status:** Draft for review · **Date:** 2026-07-13 · **Updated:** 2026-07-14 (the six §19 open questions are now resolved — see the locked decisions D5–D10 in §0) · **Owner:** Kaan
**Target:** A full-featured Expo React Native app (iOS + Android from day one) that is a first-class E2E-encrypted sync peer with the desktop app, reaching feature parity on notes, journal, tasks, projects, calendar, inbox, home, search, tags, folders, and settings, with mobile in-app purchases.

This spec is grounded in a 17-agent research pass over the codebase and the 2026 Expo/RN/crypto/CRDT/editor/IAP ecosystem. Every codebase claim cites a repo-relative path. It is the design that feeds the implementation plan; it is deliberately exhaustive so engineering can execute without re-discovering the hard parts.

---

## 0. Strategic decisions (locked)

These were decided with Kaan up front; the rest of the plan follows from them.

| #   | Decision                         | Choice                                                                                                                                                                                                                      | Rationale                                                                                                                                                                                                                                     |
| --- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Payments**                     | **RevenueCat** (StoreKit 2 + Play Billing 8) feeding the existing D1 `sync_entitlements` as an _additional_ source; Paddle stays direct on web.                                                                             | Apple/Google mandate their billing for in-app digital sales; RC is the lowest-effort path to unified entitlements from a Cloudflare Worker.                                                                                                   |
| D2  | **Mobile editor**                | **BlockNote hosted in a WebView / Expo DOM component**, reusing the _same_ serializer + Yjs binding as desktop.                                                                                                             | Notes are canonical Obsidian-compatible markdown; corruption is unacceptable. Only running the same serializer code guarantees byte-identical round-trips.                                                                                    |
| D3  | **v1 scope / release**           | **Phased**: TestFlight + Play internal beta _early_ (auth + linking + sync + notes + inbox + tasks + journal), calendar/home/settings/IAP land while beta feedback flows; store launch at full parity of the main features. | Earliest real-device feedback on the two riskiest surfaces (crypto/sync + editor) without shipping a thin first impression.                                                                                                                   |
| D4  | **"phases" meaning**             | **Projects** (task-side project structure with per-project kanban statuses = "phases of work").                                                                                                                             | Confirmed by codebase: there is no product concept named "phases"; `projects` + `statuses` is the closest match (`packages/db-schema/src/schema/statuses.ts`).                                                                                |
| D5  | **First device on mobile**       | **Link-only v1** — QR-link to an existing signed-in device (scan-side only); no brand-new-account-on-phone in v1.                                                                                                           | Avoids first-run Argon2id (1–3 s) + 24-word-phrase backup UX; the linking path needs zero new client crypto beyond §6.                                                                                                                        |
| D6  | **Home / bookmarks / reminders** | **Synced** via three new sync item types (`home_page`, `bookmark`, `reminder`).                                                                                                                                             | Kaan chose cross-device consistency over the cheaper local-only path. Additive: `SYNC_ITEM_TYPES` enum + server `toSyncDomain` switch + **new desktop handlers** + mobile handlers; **server deploys before clients**. Also upgrades desktop. |
| D7  | **Version history**              | **Replicated on mobile, device-local** (not synced on the wire).                                                                                                                                                            | Matches desktop's local-snapshot posture; mobile builds its own on-device history.                                                                                                                                                            |
| D8  | **Settings-sync push**           | **Extend now** beyond `general.*` to also push `editor`/`tasks`/`calendar`/`keyboard`.                                                                                                                                      | Task/calendar defaults follow the user cross-device; inbound schema already tolerant → low-risk desktop emitter change.                                                                                                                       |
| D9  | **Minimum device spec**          | **iOS 16+ / Android 10+ / ~4 GB RAM.**                                                                                                                                                                                      | Safe floor for the immutable 64 MiB Argon2id allocation + Yjs-on-Hermes working set, while covering the majority of active devices.                                                                                                           |
| D10 | **iPad**                         | **Phone-only v1**; iPad split-view / hardware-keyboard / wide layouts deferred to a fast-follow.                                                                                                                            | Keeps v1 layout + QA scope tight.                                                                                                                                                                                                             |

---

## 1. Goals and non-goals

### Goals

- **Full CRUD** on all main features (notes, journal, tasks, projects, calendar, inbox, home, settings) and their sub-features.
- **Bidirectional E2E-encrypted sync** with desktop and other devices — a change on mobile appears on desktop and vice versa, byte-for-byte compatible on the wire.
- **Mobile IAP** — users can buy paid sync from the app (App Store / Play), feeding the same entitlement that Paddle feeds today.
- **Offline-first** — the app is fully usable offline; sync converges opportunistically.
- **iOS + Android from day one**, both New-Architecture, both dev-client builds.

### Non-goals (v1)

- No on-device **Obsidian file vault** (no user-visible folder of `.md` files). Mobile stores note content in SQLite + CRDT; the vault-file model stays desktop-only. Byte-fidelity still matters the moment mobile _writes_ markdown that syncs back to a desktop vault.
- No **Agent Chat** (Claude/Codex CLI subprocesses, localhost MCP server) — inherently desktop (`apps/desktop/src/main/agent/*`).
- No **local AI** (embeddings/semantic search, local Whisper) on mobile v1 — heavy model download UX; degrade to FTS5 search and OpenAI-API transcription.
- No **desktop-only chrome**: tabs/split-view/session restore, tray, global shortcuts, native menu, terminal command, launch-at-login, external-editor/reveal-in-Finder, web-clipper localhost server, import framework + 13 importers (desktop remains the import surface; results sync).
- No **second Google Calendar writer** on mobile v1 — mobile _reads_ Google events for free via synced `calendar_external_events`; desktop remains the provider bridge.

---

## 2. Recommended technology stack

Verified against official docs/npm/GitHub on 2026-07-13. Alternatives noted where the choice is a swap-in.

| Concern            | Choice                                                         | Package(s) / version                                                                                | Alternative / note                                                                                                                           |
| ------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework          | **Expo SDK 57** (RN 0.86, React 19.2), New-Architecture only   | `expo@^57`                                                                                          | Legacy arch is gone since SDK 55; every native dep must be Fabric/TurboModule-ready.                                                         |
| Dev workflow       | **Dev client from day one** (never Expo Go)                    | `expo-dev-client`                                                                                   | Core deps (SQLCipher, libsodium, IAP, Android push) are all outside Expo Go.                                                                 |
| Navigation         | **expo-router** (file-based)                                   | `expo-router` (SDK 57 line)                                                                         | Greenfield → no react-navigation-fork migration burden.                                                                                      |
| Local DB           | **op-sqlite** (JSI, synchronous) + **Drizzle**                 | `@op-engineering/op-sqlite@^17`, `drizzle-orm@^0.45.2`, `drizzle-kit`, `babel-plugin-inline-import` | `expo-sqlite` is the fallback; Drizzle abstracts the driver, so the plan works on either. Sync JSI matters for the CRDT update-log hot path. |
| At-rest encryption | **SQLCipher** (`sqlcipher: true` compile flag)                 | built into op-sqlite                                                                                | Phones are lost/stolen; "privacy is the product." Desktop uses plain SQLite — this is a mobile _upgrade_, not parity.                        |
| Full-text search   | **FTS5** (`fts5: true`), `porter unicode61`                    | op-sqlite flag                                                                                      | Desktop DDL ports verbatim (`apps/desktop/src/main/database/fts.ts`).                                                                        |
| Crypto primitives  | **react-native-libsodium** (JSI) + tiny noble shims            | `react-native-libsodium@^1.7`, `@noble/curves`, `bip39@^3.1`, `cborg@^4.5`                          | The only option giving byte-identical Argon2id/XChaCha/Ed25519. WASM libsodium does not load under Hermes.                                   |
| Key-at-rest        | **expo-secure-store** (Keychain / Keystore)                    | `expo-secure-store`                                                                                 | `react-native-keychain` only if finer biometric ACLs are needed.                                                                             |
| CRDT engine        | **Yjs** (pinned to desktop's minor)                            | `yjs@~13.6.29`, `y-protocols@^1.0.7`                                                                | Pure JS, runs on Hermes; persistence is custom (below).                                                                                      |
| CRDT persistence   | **Custom SQLite-backed `CrdtPersistence`**                     | ~100 LOC implementing the desktop 5-method interface                                                | No maintained RN Yjs adapter exists; y-op-sqlite/y-expo-sqlite are toys.                                                                     |
| Editor             | **BlockNote in a WebView** via Expo DOM component              | `@blocknote/*` pinned to desktop's minor, `'use dom'` (`@expo/dom-webview`)                         | Host-agnostic bundle so it can drop to raw `react-native-webview` (Joplin pattern).                                                          |
| Secrets/config KV  | **MMKV**                                                       | `react-native-mmkv`                                                                                 | Replaces desktop `store.ts` userData JSON.                                                                                                   |
| Background sync    | **expo-background-task** + **expo-task-manager** (best-effort) | `expo-background-task`, `expo-task-manager`                                                         | 15-min floor, opportunistic iOS; correctness never depends on it.                                                                            |
| Push (sync nudge)  | **expo-notifications** + Expo Push Service                     | `expo-notifications`                                                                                | Content-free pings only (E2E). Easy to call from the Hono Worker.                                                                            |
| QR scan (linking)  | **expo-camera** (`CameraView` barcode)                         | `expo-camera`                                                                                       | vision-camera only if photo/doc capture grows.                                                                                               |
| IAP                | **RevenueCat**                                                 | `react-native-purchases@^9`, `react-native-purchases-ui`                                            | v9 ships Play Billing 8 (mandatory by 2026-08-31) + StoreKit 2.                                                                              |
| i18n               | **i18next** stack (reuse `@memry/i18n`)                        | `i18next`, `react-i18next`, `i18next-icu`                                                           | Verify Hermes `Intl`; RTL via `I18nManager` instead of `document.dir`.                                                                       |
| Build/ship         | **EAS Build + Submit + Update**                                | `eas-cli`                                                                                           | Free tier for dev; Starter ($19) at internal distribution; not locked in (local builds possible).                                            |

**Minimum device spec (D9): iOS 16+ / Android 10+ / ~4 GB RAM.** Chosen so the immutable 64 MiB Argon2id allocation (§5) and the Yjs-on-Hermes working set (§8.2) are safe while still covering the large majority of active devices. It is a product/device-class decision, not a tunable — the crypto parameters cannot move without breaking cross-device compatibility, so the floor is set by hardware, and week-1 spike #1/#2 test the cheapest device in that band.

### Week-1 go/no-go spikes (must run before committing the timeline)

1. **libsodium byte-compat spike** — run the in-repo RFC fixtures (`apps/desktop/src/main/crypto/__fixtures__/`) on a real device via react-native-libsodium; prove Argon2id (t=3, m=64 MiB, **p=1**), XChaCha20-Poly1305, Ed25519, BLAKE2b-KDF contexts, and desktop↔mobile encrypt/decrypt/sign interop. This is the whole architecture's foundation.
2. **Yjs-on-Hermes perf spike** — load a real vault's CRDT state (exported from desktop y-leveldb) on a mid-range Android; measure `getYDoc` latency at update-log lengths 1/50/500 and resident memory at 10/50/200 loaded docs. This is the single biggest unmeasured unknown.
3. **BlockNote-in-WebView editor spike** — the exact desktop schema + serializer in an Expo DOM component; verify keyboard/IME focus (iOS `keyboardDisplayRequiresUserAction`, Android `.focus()`), and a markdown round-trip diff against the desktop golden suite. Nobody ships BlockNote-in-RN publicly — we are first.
4. **op-sqlite triple-flag spike** — SQLCipher + FTS5 + (optional) sqlite-vec in one build; each is documented alone, the combination is not.
5. **pnpm isolated-install spike** — add `apps/mobile` to the monorepo and confirm every native module builds under pnpm's isolated linker without forcing `nodeLinker: hoisted` (which would need re-testing the Electron install).

---

## 3. Monorepo integration & the extraction strategy

The single most important architectural fact from the audit: **the codebase is already ~60% of the way to a portable kernel.** 15 workspace packages exist under `packages/`; the CLI/app-core refactor already forced a first extraction pass (`@memry/sync-core`, `@memry/storage-*`, `@memry/domain-*`). The remaining heavy logic (sync engine, crypto, CRDT provider, markdown conversion) still lives in `apps/desktop/src/main` but is largely dependency-injected already.

### 3.1 Reuse matrix (what mobile imports vs. builds)

| Package / module                             | Verdict                             | Notes                                                                                                                                                                                          |
| -------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@memry/contracts`                           | **Reuse as-is**                     | zod-only. **Wire-format source of truth** (sync payloads, `CBOR_FIELD_ORDER`, crypto params, auth API). Mobile MUST import, never copy — copying breaks cross-device crypto/signature interop. |
| `@memry/db-schema`                           | **Reuse as-is**                     | Drizzle table defs; swap driver to `drizzle-orm/op-sqlite`. Own migration runner. FTS/vec are created outside Drizzle.                                                                         |
| `@memry/shared`                              | **Reuse as-is**                     | Zero deps. CriticMarkup parse/serialize, markdown micro-transforms, block/inline color helpers — all Hermes-safe.                                                                              |
| `@memry/domain-tasks`, `domain-inbox`        | **Reuse as-is**                     | Zero deps.                                                                                                                                                                                     |
| `@memry/domain-notes`                        | **Reuse as-is**                     | Via injected Drizzle DB.                                                                                                                                                                       |
| `@memry/storage-data`                        | **Reuse (1-line type fix)**         | Generalize `BetterSQLite3Database` → `BaseSQLiteDatabase`.                                                                                                                                     |
| `@memry/sync-core`                           | **Reuse as-is**                     | Adapter interfaces + registry + `RecordSyncController`, `incrementClock`, `withIncrementedClock`. The engine itself is not here yet.                                                           |
| `@memry/rpc`                                 | **Reuse as-is**                     | Optional on mobile (no IPC boundary); keeps method signatures identical.                                                                                                                       |
| `@memry/i18n`                                | **Reuse (renderer/shared/locales)** | Verify Hermes Intl/ICU; `./main` is desktop-only; RTL via `I18nManager`.                                                                                                                       |
| `@memry/storage-vault`                       | **Needs adapter**                   | `NoteContentStore` interface is the seam; add a mobile (SQLite/expo-file-system) impl. `journal-format.ts` is pure and reusable.                                                               |
| `@memry/app-core`                            | **Needs split**                     | Service factories → portable kernel; `database.ts`/`paths.ts`/direct `fs` → Node host.                                                                                                         |
| `@memry/importers`, `@memry/article-extract` | **Defer**                           | Node/DOM-bound; desktop stays the import surface.                                                                                                                                              |

### 3.2 New shared packages to extract (each keeps desktop green)

Extraction principle: **move files, re-export from old paths, tests move with the code, desktop consumes the new package first** — so the existing test suite (≈half the sync directory is tests) verifies each extraction before mobile exists.

1. **`@memry/crypto`** — move `apps/desktop/src/main/crypto/{encryption,keys,signatures,primitives,recovery,cbor,vault-key-state,crypto-errors,memory-lock}.ts`. Seams: `SodiumProvider` (desktop passes `libsodium-wrappers-sumo`, mobile passes `react-native-libsodium` + shims), `SecretStore` (from `keychain.ts`; keytar stays desktop). **Effort: S–M (~1–2 wk).** The libsodium spike gates this.
2. **`@memry/sync-engine`** (grow `sync-core` or new) — move the engine core: `engine/` coordinators, `queue.ts`, `retry.ts`, `vector-clock.ts`, `field-merge.ts`, `offline-clock.ts`, `apply-item.ts`, `sync-errors.ts`, `encrypt.ts`, `decrypt.ts`, `compress.ts`, `manifest-check.ts`, `local-mutations.ts`, `initial-seed.ts`, `token-manager.ts`, `device-keys.ts`, `device-registration.ts`, `auth-retry.ts`, `linking-service.ts`, vault-adoption/provisioning. Seams: `HttpClient` (replaces electron `net`), `WebSocketFactory`, `Logger`, `EmitEvents` (replaces BrowserWindow broadcast), `SecretStore`, `DeviceInfo`, `Telemetry`, `DrizzleDb` (already injected), optional `WorkerBridge` (already optional). **Effort: L (~3–6 wk)** — biggest chunk, but mechanical; the DI shape already exists in `apps/desktop/src/main/sync/engine/sync-context.ts` (`SyncEngineDeps`).
3. **`@memry/crdt-core`** — Yjs doc lifecycle, `crdt-encrypt.ts`, `crdt-compact-utils.ts`, `crdt-queue.ts`, `crdt-feed.ts`, `microtask-batch-broadcaster.ts`, snapshot push/pull glue. Seams: `YDocPersistence` (desktop: y-leveldb; mobile: SQLite blob log), `NoteContentSource` (desktop: vault hydration; mobile: none). `crdt-provider.ts` gets **split, not moved** (it's the most entangled file: y-leveldb + fs + electron + index-DB + markdown conversion). **Effort: M–L (~2–4 wk).**
4. **`@memry/markdown` / `@memry/editor-web`** — the preserving markdown⇄BlockNote conversion (`markdown-utils.ts` + `blocknote-converter.ts` wrappers + `packages/shared` helpers + `editor-schema.ts` + the 10 custom specs). Consumed by the desktop renderer, Electron main, **and the mobile WebView bundle** — this also kills the current renderer/main serializer duplication. **Effort: S** for `frontmatter.ts` parse extraction; **L** for the editor-web bundle (see §8).
5. **`@memry/platform`** — formalize `FileStore`, `KeyValueStore`, `SecretStore` interfaces with desktop impls; mobile impls live in `apps/mobile`. **Effort: S.**
6. **`@memry/app-kernel`** (app-core split) — `createMemryApp` variant taking opened DBs + adapters instead of opening better-sqlite3 itself. **Effort: M (~2–3 wk).**

**Total prep before mobile feature work: ~2–3 months of focused extraction.** De-risk in week 1: the libsodium spike (item 1) and the editor/serializer bundle (item 4).

### 3.3 Dependency-injection seams (the adapter interfaces mobile implements)

| Seam               | Desktop impl               | Mobile impl                                   |
| ------------------ | -------------------------- | --------------------------------------------- |
| `SodiumProvider`   | `libsodium-wrappers-sumo`  | `react-native-libsodium` + noble shims        |
| `SecretStore`      | keytar                     | expo-secure-store                             |
| `KeyValueStore`    | userData JSON (`store.ts`) | MMKV                                          |
| `FileStore`        | `fs`/`path`                | expo-file-system (attachments)                |
| `HttpClient`       | `electron.net.fetch`       | global `fetch`                                |
| `WebSocketFactory` | `ws` + pinned agent        | RN global `WebSocket` (verify custom headers) |
| `Logger`           | electron-log               | RN logger shim                                |
| `EmitEvents`       | BrowserWindow broadcast    | in-process EventEmitter                       |
| `DeviceInfo`       | `os` + electron `app`      | expo-device / expo-application                |
| `DrizzleDb`        | better-sqlite3             | op-sqlite                                     |
| `YDocPersistence`  | y-leveldb                  | SQLite update-log                             |
| `Telemetry`        | Cloudflare AE via main     | AE via fetch                                  |

---

## 4. High-level architecture

```
┌─────────────────────────── apps/mobile (Expo RN) ───────────────────────────┐
│  UI (expo-router screens, React Native)                                       │
│    Home · Notes · Journal · Tasks · Projects · Calendar · Inbox · Settings    │
│                              │                                                 │
│              in-process function calls (no IPC — one JS runtime)               │
│                              ▼                                                 │
│  App kernel (shared @memry/* packages) + mobile adapters                      │
│   ├─ @memry/app-kernel  (services: notes, tasks, calendar, inbox, settings)   │
│   ├─ @memry/sync-engine (record + CRDT sync, vector clocks, auth retry)       │
│   ├─ @memry/crypto      (libsodium via SodiumProvider)                        │
│   ├─ @memry/crdt-core   (Yjs docs, SQLite persistence, encrypt/queue)         │
│   ├─ @memry/db-schema   (Drizzle over op-sqlite, SQLCipher)                   │
│   └─ @memry/contracts   (zod wire schemas — shared with server & desktop)     │
│                              │                                                 │
│  WebView editor bundle  ◄── postMessage(yjs updates) ──►  RN owns Y.Docs      │
│   (BlockNote + custom schema + serializers, same code as desktop renderer)    │
└──────────────────────────────────────────────────────────────────────────────┘
                               │ HTTPS (E2E-encrypted payloads) + WSS (nudges)
                               ▼
        apps/sync-server (Cloudflare Workers + Hono) — D1 metadata + R2 blobs
                    server never sees plaintext; verifies Ed25519 only
```

Key inversion vs. desktop: on desktop the renderer and "main" logic are separated by an IPC boundary (`packages/contracts` typed channels). **On mobile, UI and kernel share one JS runtime** — the contract _types_ survive as function signatures; the IPC transport disappears. The `NotesClientAPI`-style interfaces (`packages/contracts/src/notes-api.ts`) remain the seam, so renderer hooks/services port with minimal change.

### 4.1 Source-of-truth on mobile (no file vault)

Desktop's canonical note body is a markdown file; DBs are caches. Mobile collapses this: **SQLite is canonical for everything**, and note/journal bodies are Y.Docs persisted as an update log. Folder hierarchy is modeled from `note_metadata.path` strings + `folder_configs` (no real filesystem). This removes the entire `vault/` layer, chokidar, and the file indexer from mobile scope. Costs: mobile-specific `note`/`journal`/`folder_config` sync handlers (DB-backed rewrites, since the desktop handlers are filesystem-first), and no on-device Obsidian interop (acceptable — that is a desktop feature).

---

## 5. E2E crypto parity (the foundation)

The sync server has **no libsodium dependency** — it verifies Ed25519 signatures via WebCrypto and validates envelope lengths, nothing more (`apps/sync-server/src/services/sync.ts`). So mobile must replicate the **entire client crypto surface** byte-for-byte. Any deviation → other devices quarantine mobile's items.

### 5.1 Key hierarchy (must reproduce exactly)

```
BIP-39 phrase (24 words, 256-bit) → mnemonicToSeed (PBKDF2-HMAC-SHA512 ×2048) → 64-byte seed
  └─ Argon2id v1.3(seed, salt16, ops=3, mem=64 MiB, p=1) → 32-byte MASTER KEY
       ├─ crypto_kdf_derive_from_key (BLAKE2b) ctx 'memryvlt' id 1 → VAULT KEY (32B)
       └─ ctx 'memrykve' id 4                                    → KEY VERIFIER (uploaded)
VAULT KEY → wraps random per-item FILE KEYs (XChaCha20-Poly1305)
DEVICE SIGNING KEY (Ed25519, random per device, NOT derived)
```

Sources: `apps/desktop/src/main/crypto/keys.ts:19-137`, `packages/contracts/src/crypto.ts:20-59`.

### 5.2 Byte-compat trap list (from the crypto audit)

- **Argon2id parallelism = 1** (libsodium-fixed). Many mobile Argon2 libs default to p=2/4 → different master key. This is _the_ trap.
- **One vault key per account, not per vault** — no vaultId in the derivation; vault separation is server-side namespacing only (`X-Memry-Vault-Id`, R2 prefixes).
- **BLAKE2b KDF, not HKDF** — `crypto_kdf_derive_from_key` with the exact 8-char contexts (`memryvlt`/`memrysgn`/`memryvrf`/`memrykve`/`memrylnk`/`memrymac`/`memrysas`).
- **Base64 = `sodium.base64_variants.ORIGINAL`** (standard alphabet, padded). react-native-libsodium defaults to URLSAFE_NO_PADDING — always pass ORIGINAL explicitly. The shared `@memry/crypto` extraction eliminates this whole bug class.
- **Canonical CBOR signing** — `cborg` `encode(new Map(...))` in `CBOR_FIELD_ORDER` (`packages/contracts/src/cbor-ordering.ts`); `undefined` fields omitted; `operation` defaults to `'update'` on verify. `SYNC_ITEM` order: `[id, type, operation, cryptoVersion, encryptedKey, keyNonce, encryptedData, dataNonce, deletedAt, metadata]` where `metadata = {clock?, fieldClocks?, stateVector?}`.
- **CRDT packed binary layout** (fixed offsets): `dataNonce(24) ‖ keyNonce(24) ‖ wrappedFileKey(48) ‖ signature(64) ‖ ciphertext`; ciphertext = XChaCha20-Poly1305(deflate(update), fileKey, **AAD = utf8(noteId)**); signature over `noteId ‖ header-sans-sig ‖ ciphertext`.
- **Compression framing** — 1 flag byte before encryption: `0x00` raw (<64 B or incompressible), `0x01` pako deflate. Applies to record payloads _and_ CRDT packets.
- **`cryptoVersion` = 1** — decrypt dispatches on it; unknown → hard "please update the app" error. This is the crypto compat lever.

### 5.3 RN crypto stack

`react-native-libsodium` (JSI, real upstream libsodium C) covers Argon2id, XChaCha20-Poly1305 (+AAD), Ed25519, `crypto_kdf_derive_from_key`, `crypto_auth`, `crypto_generichash`, `crypto_box_keypair`, `randombytes_buf`. Three tiny pure-TS shims cover the gaps: `crypto_scalarmult` → `@noble/curves` x25519 (linking is interactive; ms-scale is fine), `crypto_sign_ed25519_sk_to_pk` → `sk.subarray(32)` (libsodium sk is `seed‖pub`), and constant-time compare / zeroize. `bip39` and `cborg` port unchanged.

**Realistic timings:** native Argon2id at 64 MiB on a phone ≈ **1–3 s** (Standard Notes ships this class in production). It only runs at onboarding/recovery/linking → render the spinner a frame before invoking. Pure-JS Argon2id is disqualifying (≥5–20 s + GC pressure). 64 MiB allocation is safe on modern devices; the minimum-device-spec is now decided — **iOS 16+ / Android 10+ / ~4 GB RAM (D9)** — which fixes the cheapest Android to test against. The parameters are immutable, so this is a device-class floor, not a code knob.

**Verification:** the in-repo RFC fixtures (`argon2id-rfc9106.ts`, `ed25519-rfc8032.ts`, `xchacha20-rfc8439.ts`) + the `tests/sync-harness/` cross-runtime harness become the shared golden corpus, run on-device in CI (Maestro/Detox), plus desktop↔mobile golden interop tests (each encrypts, the other decrypts; same phrase+salt → same master key).

---

## 6. Auth, device linking & key distribution

The critical path: **how a phone obtains the vault master key without the user typing a 24-word phrase.** This is the QR device-linking flow, and it needs **zero server change** — the phone plays the exact role desktop's `linkViaQr`/`completeLinkingQr`/`finalizeLinking` play today. Platform enums already include `ios`/`android` (`packages/contracts/src/auth-api.ts:19`); the 50-device limit, token issuance, linking protocol, and vault adoption are all platform-agnostic.

### 6.1 Token taxonomy (EdDSA JWTs, issuer `memry-sync`)

| Token         | Lifetime                              | Stored (mobile)   |
| ------------- | ------------------------------------- | ----------------- |
| Setup token   | 5 min, single-use                     | expo-secure-store |
| Access token  | 15 min                                | expo-secure-store |
| Refresh token | 7 days, rotating (SHA-256 hash in D1) | expo-secure-store |

### 6.2 Fresh sign-in (OTP)

`POST /auth/otp/request` → email code → `POST /auth/otp/verify` → 5-min setup token → generate Ed25519 device keypair, sign `"{nonce}:{setupToken.jti}"`, `POST /auth/devices` with `platform: 'ios'|'android'` → `{deviceId, accessToken, refreshToken}`. If the account has no other device (fresh account), first-device setup generates the BIP-39 phrase + master key locally and `POST /auth/setup {kdfSalt, keyVerifier}`. **Decided (D5): mobile v1 links to an existing device (scan-side, §6.3) rather than being the first device** — simpler, and avoids the 1–3 s Argon2id + 24-word-phrase backup UX at first run. Brand-new-account-on-phone is a deferred fast-follow.

### 6.3 QR linking, scan side (the key-distribution path — v1 must-have)

Actors: **A** = existing signed-in device (shows QR), **B** = phone (scans), **S** = server. All linking crypto: X25519 ECDH → BLAKE2b-KDF channel keys → XChaCha20-Poly1305 + HMAC confirms. Session TTL 5 min.

```
A: POST /auth/linking/initiate → {sessionId, linkingSecret, expiresAt}; renders QR
B: expo-camera scans QR → X25519 keypair; shared = scalarmult(eB.priv, eA.pub)
   encKey/macKey/sasKey = KDF(shared, ctx memrylnk/memrymac/memrysas)
   POST /auth/linking/scan (unauth, IP-rate-limited) with HMAC proofs over canonical CBOR
   display 6-digit SAS = BLAKE2b-4(sasKey) mod 10^6
A: (WS notified) verifies confirm, displays same SAS; user compares codes
   masterKey = keychain.retrieve; encryptedMasterKey = XChaCha20(masterKey, encKey)
   POST /auth/linking/approve {encryptedMasterKey, keyConfirm, ...vault/provider transfers}
B: poll POST /auth/linking/complete → verify keyConfirm → decrypt masterKey
   adopt vault uuid, register device (skipSetup), store master key → sync activates → initial pull
```

Server only ever holds the master key **encrypted under the ECDH channel key**. Every proof is HMAC over canonical CBOR with pinned field order — byte-exact compat required.

### 6.4 Mobile-specific gotchas (from the audit)

- **Linking IP-match** — `/complete` must originate from the `/scan` IP (`apps/sync-server/src/services/linking.ts:339-345`). A phone hopping Wi-Fi→cellular mid-flow (5-min window) or carrier-grade NAT breaks this. **Server change to consider:** relax to a session-bound proof for mobile clients. (Known shared-IP rate-limit collision already noted in repo memory.)
- **Google OAuth on mobile** — the server only accepts 127.0.0.1 loopback or the web redirect (`apps/sync-server/src/routes/auth.ts:308-321`). **Recommend OTP-only at launch (zero server change), add an iOS/Android Google client + custom-scheme/App-Links redirect later.**
- **Token refresh on foreground** — the desktop timer model assumes a long-lived process. A backgrounded RN app wakes with an expired access token; refresh **eagerly on `AppState` → active**, single-flight, 60-s expiry margin, `withAuthRetry` (401 → refresh → retry once) on every call. If unused > 7 days the refresh token is dead → full re-auth (refresh tokens aren't extended while dormant).
- **Recovery-phrase re-link** as fallback: phrase → seed → Argon2id(server `kdfSalt`) → verifier compare → register.
- **Approve side (existing-device role)** — eventually the phone should be able to approve a _new laptop_ (QR generation, `/initiate`, `/approve`). Day-one mobile ships **scan-side only** (desktop is always the initiator today).

---

## 7. Sync protocol client

Three transports, all vault-scoped and E2E-encrypted: **record sync** (JSON per entity, 15 item types, vector clocks), **CRDT sync** (Yjs updates/snapshots for note/journal bodies), **attachment sync** (chunked binary). A per-user Durable Object WebSocket delivers change _nudges_; all data flows over HTTPS. WS is advisory — a 60-s periodic pull is the fallback.

### 7.1 What mobile must implement (protocol obligations)

1. **Record protocol** — `GET /sync/changes?limit=100[&cursor=N]` cursor pagination with concurrent prefetch; `POST /sync/pull {itemIds}` batch decrypt+verify; `POST /sync/push {items}` batches ≤100 with accepted/rejected handling (`SYNC_REPLAY_DETECTED` → treat as success; `STORAGE_QUOTA_EXCEEDED` → sticky error); cursor advance from `maxCursor` (so a device doesn't re-pull its own pushes); `deletedAt` tombstones; `PULL_APPLY_ORDER` dependency ranking; deferred FK-parent retries; `/sync/manifest` integrity check; signature-failure **quarantine** (3 strikes → permanent); corrupt-item re-fetch (1 h cooldown); crypto circuit-breaker (all-crypto-failure page → stop with "possible vault key mismatch").
2. **Vector-clock machinery** — doc clocks (`VectorClock = Record<deviceId, tick>`); **field clocks** for `task`/`project`/`calendar_event`/`agent_conversation` (`apps/desktop/src/main/sync/field-merge.ts`); `_offline` pseudo-device ticking + rebinding on recovery; delete-vs-edit skip rules (a remote delete is skipped if local clock is `after`/`concurrent`); merged push-back on conflict.
3. **CRDT client** — per-note update queue (flush every **1 s** or **50 updates**, per-note in-flight lock), snapshot push with `pendingSnapshotBytes` accounting, snapshot-baseline + incremental pull, and the **900 KB batch cap** (desktop silently _drops_ oversize batches — mobile should **split-or-snapshot** instead). Compaction can be deferred (desktop also compacts).
4. **All 15 record item-type handlers** re-targeted at op-sqlite (schemas in `packages/db-schema` are reusable). `note`/`journal`/`folder_config` handlers are **mobile rewrites** (desktop's are filesystem-first); the other 12 (task, project+embedded statuses, inbox, filter, settings, tag_definition, calendar_event/source/binding/external_event, agent_conversation/message) are extractable with a logger seam.
5. **Token lifecycle** (§6.4) and **WS client with custom headers** (`Authorization`, `X-App-Version`, `X-Memry-Vault-Id`; server rejects old `X-App-Version` with close code 4009, revocation 4004). RN `WebSocket` supports a headers option — **verify on both platforms**; the `ws` npm package is Node-only.
6. **Scheduler adaptation** — fullSync on app foreground, pull on WS message while active, background-task delta pull/push (best-effort), later content-free push nudges. The 24-h stale-cursor reset (offline > 24 h → reset cursor to 0) matters more on mobile.

### 7.2 Record envelope (wire shape — `packages/contracts/src/sync-api.ts`)

```
PushItem = { id, type, operation, encryptedKey, keyNonce, encryptedData, dataNonce,
             signature, signerDeviceId, clock?, stateVector?, deletedAt? }   // base64 ORIGINAL
```

Per item: random 32-B file key → `compress(JSON)` → XChaCha20-Poly1305 (24-B nonce, no AAD) → wrap file key with vault key. `clock` is **required for every record type except `settings`** — mobile must maintain note metadata clocks even though note _bodies_ ride CRDT. Sign detached Ed25519 over canonical CBOR.

### 7.3 Item handler catalog (what each type syncs)

| type                                     | canonical on mobile                            | merge                                                                              |
| ---------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| `note`                                   | SQLite `note_metadata` + Y.Doc body            | metadata field-applied, body via CRDT; DB-backed handler rewrite                   |
| `journal`                                | SQLite row keyed by date + Y.Doc               | record LWW by clock (journals are **not** CRDT on the wire); body via CRDT locally |
| `task`                                   | `tasks` (+ `task_tags`, `task_notes`)          | field-merge; tags/notes union on merge                                             |
| `project`                                | `projects` + embedded `statuses[]`             | field-merge; statuses reconciled by id; inbox project never deleted via sync       |
| `inbox`                                  | `inbox_items`                                  | doc-clock LWW                                                                      |
| `filter`                                 | `saved_filters`                                | doc-clock LWW                                                                      |
| `settings`                               | `synced_settings` singleton                    | per-field-path LWW (no envelope clock)                                             |
| `tag_definition`                         | `tag_definitions` (itemId = tag name)          | doc-clock LWW                                                                      |
| `folder_config`                          | `folder_configs` (icon only; views don't sync) | doc-clock LWW; DB-backed rewrite                                                   |
| `calendar_event`                         | `calendar_events`                              | field-merge                                                                        |
| `calendar_source/binding/external_event` | respective tables                              | doc-clock LWW                                                                      |
| `home_page`                              | home board layout table                        | doc-clock LWW; **new sync type (D6)**                                              |
| `bookmark`                               | bookmarks table                                | doc-clock LWW; **new sync type (D6)**                                              |
| `reminder`                               | reminders table                                | doc-clock LWW; **new sync type (D6)**; fires local notifications                   |
| `agent_conversation/message`             | (excluded on mobile v1)                        | —                                                                                  |

### 7.4 Local sync state a client must persist

`sync_state` KV (`lastCursor`, `lastSyncAt`, `syncPaused`, `initialSeedDone`, `quarantinedItems`); `sync_queue` (offline outbound, coalesced one row per `(itemId,type)`, dead-letter at 5 attempts, 7-day purge); `sync_devices` (peer signing-key cache); per-entity `clock`/`fieldClocks`/`syncedAt` columns; per-note Yjs update log.

---

## 8. Local data layer

### 8.1 Relational (op-sqlite + Drizzle + SQLCipher)

Reuse `packages/db-schema` table definitions verbatim; swap driver to `drizzle-orm/op-sqlite`. Keep desktop's **two-DB split** (data.db non-rebuildable, index.db rebuildable) — "delete and rebuild index.db" is a recovery affordance worth preserving. **Fresh mobile migration lineage** (do not replay desktop's 35 hand-written data-DB migrations, broken past 0021 for drizzle-kit): migration 0000 = full current schema snapshot, then `drizzle-kit generate` + `useMigrations` on startup, with `.sql` bundled via `babel-plugin-inline-import`. Column/table names stay identical for payload compatibility. Migrations are baked into the binary → schema changes need an app-store release (same as desktop's asar).

### 8.2 CRDT persistence (custom, ~100 LOC)

Implement the desktop 5-method `CrdtPersistence` interface (`apps/desktop/src/main/sync/crdt-provider.ts:72-78`) over a SQLite update-log table:

```sql
CREATE TABLE crdt_updates (doc_id TEXT, seq INTEGER, update BLOB, PRIMARY KEY (doc_id, seq));
```

`storeUpdate` = INSERT; `getYDoc` = SELECT ordered → `Y.applyUpdate` (or `mergeUpdates` then one apply); `flushDocument` = read all → `Y.mergeUpdates` → DELETE → INSERT merged as seq 0 (trigger at ~100–500 rows and on app background). This keeps update bytes byte-identical to what desktop produces/consumes → **no sync-protocol change**. Port the desktop doc-lifecycle core (load-on-open, inactive eviction, compaction) into `@memry/crdt-core`; window-broadcast becomes an in-process EventEmitter.

**Yjs-on-Hermes:** compatible today (UTF-8 TextDecoder landed in Hermes Dec 2025; lib0 has a pure-JS fallback; Yjs only uses `TextDecoder('utf-8')`). Add `react-native-get-random-values` as cheap CSPRNG insurance. Performance is the unknown — **spike #2** measures it. Mitigations, in order: aggressive flush-merge (cold open applies ~1 merged update), chunk applies through `InteractionManager`/idle, worklet offload only if measured.

### 8.3 Full-text search

FTS5 with the exact desktop DDL (`porter unicode61`, `fts_notes`/`fts_tasks`/`fts_inbox`) + bm25 + `fuzzysort` title fallback. On mobile there is no file indexer — FTS rows are populated from CRDT/sync state instead of the file watcher. Semantic search (`vec_notes` / sqlite-vec) is **deferred** — on-device embedding generation is a separate heavy question; ship FTS5-only search first.

### 8.4 SQLCipher key management

Generate a random 32-B DB key on first launch, store in expo-secure-store. **Do not** derive it from the vault passphrase (that would force passphrase entry before any local read and couple local storage to sync identity). One SQLCipher mechanism covers data rows, the CRDT log, and the FTS index (all in the same encrypted file).

---

## 9. Editor strategy (BlockNote in a WebView)

### 9.1 The two hard constraints

- **Constraint A — markdown round-trip identity.** Notes are canonical Obsidian-compatible markdown. Any editor that serializes with a _different_ pipeline than desktop rewrites files differently → silent diffs → sync churn at best, corruption of Obsidian-only syntax at worst. The only guarantee is running the _same code_ (same BlockNote minor + same `markdown-utils`/`packages/shared` helpers).
- **Constraint B — CRDT node-name compatibility.** The note body lives in the Y.Doc as a ProseMirror `XmlFragment` containing BlockNote's custom nodes (`wikiLink`, `hashTag`, `callout`, `taskBlock`, …). Fine-grained CRDT merge requires binding y-prosemirror to that _exact_ schema. A native editor cannot; the coarse escape hatch is desktop's own path: markdown → blocks → full-fragment replace (`apps/desktop/src/main/sync/crdt-feed.ts`), which loses keystroke merge but not data.

Both constraints are satisfied **only** by running BlockNote itself. Native editors (10tap = dormant single-maintainer + wrong TipTap schema; Lexical RN = officially not happening; live-markdown = plain-text source only) are rejected for the primary editor.

### 9.2 Design

1. **`@memry/editor-web`** — a React DOM app (Vite) importing `editor-schema.ts` + the 6 custom blocks (`codeBlock`, `file`, `callout`, `youtubeEmbed`, `bookmark`, `taskBlock`) + 4 custom inlines (`wikiLink`, `hashTag`, `linkMention`, `dateMention`) + `markdown-utils.ts` + `packages/shared` helpers. Consumed by the desktop renderer **and** the mobile bundle — this also de-duplicates the renderer/main serializer split. **Pin `@blocknote/*` to desktop's exact minor** (0.47.x today; v0.51 rewrote markdown conversion — drift = the two clients serialize the same fragment to different markdown). Upgrades released in lockstep, gated on round-trip diff tests.
2. **Hosting** — Expo DOM component (`'use dom'`, `@expo/dom-webview`) for free offline bundling + typed actions. Keep the bundle host-agnostic behind a thin transport interface so it can drop to raw `react-native-webview` if `@expo/dom-webview` bugs bite (known iOS blank-on-large-initial-props issue — **never pass note content as initial props; send it via message after mount**).
3. **Sync** — RN owns the Y.Docs (Yjs is pure JS); a `yjs-webview-provider` mirrors `apps/desktop/src/renderer/src/sync/yjs-ipc-provider.ts` over `postMessage` (base64 binary updates, origin tagging for loop prevention). `@blocknote/server-util` needs a DOM (jsdom) and **cannot run on Hermes** — markdown⇄blocks conversion runs _inside the WebView_ where a real DOM exists.
4. **Mobile chrome** — RN-side formatting toolbar above the keyboard (`InputAccessoryView` / sticky view), slash + side menus re-skinned as bottom sheets, caret-into-view via in-page `visualViewport` listeners.

### 9.3 Source-mode fallback (ship anyway)

A plain `TextInput` (upgrade path: `react-native-live-markdown` with a custom parser) editing raw markdown; saves go through markdown→blocks→full-fragment-replace (the `crdt-feed.ts` path). **Zero conversion risk**, ~2–3 wk, no WebView deps. Ship it as an Obsidian-style source mode _and_ as the escape hatch if the rich editor slips — it de-risks the entire mobile timeline. Task descriptions and inbox content are already plain-markdown columns (no Yjs) — a simple markdown `TextInput` is a legitimate v1 for those.

### 9.4 Editor effort

Shared bundle extraction 3–5 wk; Yjs webview provider + save pipeline 1.5–2.5 wk; mobile chrome 2–4 wk; IME/keyboard QA hardening (GBoard, iOS autocorrect, CJK) + upstream BlockNote mobile fixes 2–4 wk. **Total ~9–15 wk for the editor surface alone.** Risk buffer justified — we are first-movers on BlockNote-in-RN.

---

## 10. Feature parity matrix

Legend: **core** = must replicate · **adapt** = must exist, implementation differs · **defer** = post-v1 · **desktop-only** = skip.

### Notes & editor

| Feature                                                                                                    | Class        | Mobile notes                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| Note CRUD, rename, move, list (sort incl. manual `position`), emoji/`icon:*`                               | core         | DB-canonical; delete is permanent (no trash — match desktop)                                  |
| Local-only notes                                                                                           | adapt        | A desktop local-only note never arrives on mobile — state this in UX                          |
| Block editor (full custom schema)                                                                          | adapt        | §9 — WebView BlockNote                                                                        |
| Wiki links (`[[..]]` + alias + create-on-tap + preview)                                                    | core         | resolver ports; create-missing on tap                                                         |
| Hashtags `#tag`, `@` mentions, date mentions (+reminders)                                                  | core         | date pills → local notifications                                                              |
| Task blocks, callouts, bookmarks, YouTube, file/image, code blocks                                         | core         | live task block needs tasks feature                                                           |
| CriticMarkup review marks                                                                                  | adapt        | at minimum lossless passthrough (serialize inside markdown) or corrupt reviewed notes         |
| Foreign-syntax / byte preservation                                                                         | core         | **sync-safety invariant** — untouched round-trip of unknown Obsidian syntax                   |
| Backlinks + link index, note↔task links                                                                    | core         | maintain link index from sync state                                                           |
| Properties (9 typed: text/number/checkbox/date/select/multiselect/url/rating/status) + calendar visibility | core         | vault-wide `property_definitions`                                                             |
| Tags (case-preserving, NOCASE identity, colors, icons, rename/merge/delete, pin-to-tag)                    | core         |                                                                                               |
| Search (FTS5 notes/journals/tasks/inbox + bm25 + prefix + fuzzy + filters)                                 | core         | §8.3; semantic search deferred                                                                |
| Templates (gallery, apply full/body, folder default + inheritance)                                         | core         | rendered on create                                                                            |
| Folder tree + `.folder.md` icons                                                                           | core         | modeled from `path` strings + `folder_configs`                                                |
| Folder View (table/grid/list, filters, sorts, group-by, formulas, summaries)                               | defer→adapt  | views **don't sync yet** (desktop gap) — read-only first                                      |
| Version history (local snapshots)                                                                          | core (adapt) | **D7** — replicate the desktop local-snapshot mechanism; device-local, not synced on the wire |
| Export PDF/HTML, external editor, reveal-in-Finder, import framework                                       | desktop-only | share-sheet later                                                                             |

### Journal

Day/month/year views, activity heatmap (pure-TS helper reusable), streak, today's notes, tags/properties, backlinks, stats footer — **core (adapt)**, same editor decision as notes. Journals sync as **records keyed by date** (not CRDT on the wire) → concurrent phone+desktop edits resolve by clock (conscious tradeoff). AI connections panel — **defer**.

### Tasks & projects (lowest-friction port — pure SQLite, no vault, field clocks only)

Task CRUD (due date/time, description [plain-markdown column], priority, subtasks via `parentId`, **recurrence** `RepeatConfig`, tags, `sourceNoteId`), Today/All views, list/kanban (kanban on All tab), default-view setting, saved filters (synced as `filter`), NL quick-add (`!date`/`!!priority`/`#project`), task detail drawer, bulk actions, task reminders (the reminder **entity** now syncs per D6; each device still schedules its **own** local OS notification) — all **core**; reuse `@memry/domain-tasks` commands/queries over an op-sqlite repository. Projects = task containers with per-project kanban statuses (**this is "phases"**), embedded in the project sync payload — **core**. Recurrence expansion must behave identically or completed repeats fork. Kanban/subtask drag → gesture-handler + reanimated (the snap/clamp math ports directly).

### Calendar

Day/week/month/year views, `calendar_events` CRUD (recurrence, all-day, timezone), projection engine merging events+tasks+reminders+snoozed-inbox+external+notes, notes-on-calendar opt-in (default off), quick-create, drag/resize (math ports; interactions rebuilt with gesture-handler) — **core (adapt)**. The projection engine (`apps/desktop/src/main/calendar/projection.ts`) is Drizzle+date-math with no Electron imports — extract to a shared package. **Google Calendar writing = desktop-only v1**; mobile _reads_ Google events via synced `calendar_external_events` (provider OAuth tokens are per-device keychain, never synced).

### Inbox

9 item types, capture (text/link/image/pdf/voice via **share-sheet + quick-add widget** replacing the global-shortcut window), detail panel, conversion engine (→note/task/event/reminder with provenance + undo), snooze — **core (adapt)**. Voice: replace MediaRecorder/webm with **expo-audio (AAC/m4a)**; keep `VoiceMetadata.waveform` (≤120 RMS buckets) so desktop renders mobile recordings; transcription via **OpenAI API** (key → expo-secure-store), local Whisper deferred. Enrichment jobs (metadata scrape, thumbnails) run on-device or accept degraded metadata until desktop enriches (synced job/item state converges). **AI filing suggestions** (all-MiniLM + sqlite-vec) → degrade to folder-scoring + filing-history heuristics (pure SQL) on v1. Web-clipper localhost server — desktop-only.

### Home

7 widget types (`recently-edited`, `bookmarks`, `tasks`, `inbox`, `folder`, `calendar`, `journal`), widget filters/selectors (pure TS, reusable) — **core (adapt)**. The RGL grid is DOM-only → **mobile Home = single-column reorderable widget list** rendering the same `WidgetInstance[]` (interpret y-order, ignore x/w). Home boards are **device-local (not synced) today**; per **D6**, v1 adds a `home_page` sync item type (contracts `SYNC_ITEM_TYPES` + the server `toSyncDomain` switch + a new desktop handler + a mobile handler; **server deploys first**) so boards follow the user across devices. Bookmarks and reminders get the same treatment via the `bookmark` and `reminder` types.

### Settings

Settings storage = per-vault key/value `settings` table (JSON blob per group) — reuse `settings-schemas.ts`. Day-one mobile settings surface: **Account** (sign in/out, recovery phrase, device linking, devices, sync pause/resume, storage usage, **IAP purchase/restore** replacing the Paddle portal row), **Appearance** (theme light/white/dark/system, accent 8 presets + hex, font size), **Language** (32 locales + RTL), **Journal/Tasks/Calendar** defaults, **Features** toggles, **Privacy** (telemetry), **Sync** (enabled/autoSync). Defer/omit: startup, updates pane, tabs, editor width, shortcuts/global capture, command line, agent MCP, import, vault location, backup, AI model management.

**Settings-sync watch-out:** only `general.*` is _pushed_ today (theme/accent/font/language/createInSelectedFolder). Per-feature settings (tasks/calendar defaults) are **local per device** — a user configuring task defaults on desktop won't see them on mobile. The inbound schema already tolerates `editor/tasks/calendar/keyboard` groups, so per **D8** v1 **extends the desktop push emitter now** to cover them — task/calendar defaults follow the user cross-device (a desktop-side change that also improves desktop↔desktop).

### Previously-not-synced (now resolved per §0)

- **Home boards, bookmarks, reminders → now SYNCED (D6):** three new sync item types added first (registry pattern in `apps/desktop/src/main/sync/item-handlers/index.ts`; the `adding-sync-item-type` skill covers it), wired on **both desktop and mobile**, server deployed before clients.
- **Version history → REPLICATED but device-local (D7):** mobile ports the local-snapshot mechanism; it does not go on the wire.
- **Still local-only on both platforms:** note manual-ordering, templates, folder views (views don't sync on desktop yet either).

---

## 11. Payments & entitlements

**Principle: D1 `sync_entitlements` stays the single source of truth. RevenueCat is a store-receipt processor feeding it, exactly as Paddle webhooks do today. Paddle stays direct (not routed through RC).**

Why not RC-as-truth: (a) RC's Paddle integration can't represent the one-time **Believer** purchase (subscriptions only); (b) sync gating (`assertPaidSyncAccess`) would take a runtime dep on RC; (c) feeding Paddle into RC costs 1% MTR for zero enforcement benefit; (d) the D1 path is production-proven with idempotency + admin overrides.

Why RC at all: server-side receipt validation, App Store Server Notifications v2 + Play RTDN (which arrives via Google Cloud Pub/Sub — awkward from a Worker), Play Billing 8 / StoreKit 2 churn, one webhook format consumable from Hono. Free until $2.5k/mo store MTR, then 1%.

### 11.1 Server changes (additive, hand-written D1 migrations — Drizzle broken past 0021)

1. **New table `entitlement_grants`** `(id, user_id, source, plan, status, external_customer_id, external_subscription_id, external_transaction_id, expires_at, updated_at, raw_event_id)` — one row per `(user, source)`. Compute **effective entitlement** = highest-ranked active grant (believer > pro > plus; lifetime beats expiring; active beats past_due/paused) and upsert into the existing single-row `sync_entitlements` so **all current enforcement code keeps working unchanged**. This fixes the real bug: today's `ON CONFLICT(user_id)` upsert would let a store event **clobber a live Paddle subscription**.
2. **Refactor `applyPaddleWebhook`** to write a `source='paddle'` grant + recompute effective (behavior-preserving for Paddle-only users; test against `paddle-webhooks.test.ts`).
3. **New route `POST /webhooks/revenuecat`** beside `/webhooks/paddle`: verify RC HMAC signature (mirror `verifyPaddleWebhookSignature`), idempotency table `revenuecat_webhook_events`, map RC event → grant upsert → recompute. Set **RC `app_user_id` = Memry `userId`** (call `Purchases.logIn(userId)` post-auth).
4. **Extend `SyncEntitlementSource`** additively (`'app_store' | 'play_store'`) — verify `formatBillingStatus` doesn't switch exhaustively on source (old desktop clients tolerate unknown sources).
5. **Reconcile fallback** mirroring `POST /auth/billing/reconcile` (mobile posts RC `customerInfo`; server verifies against RC REST before granting) — covers webhook latency.
6. **`/auth/billing`** stays the one client-facing status endpoint (desktop + mobile); extend `BillingStatusResponse` additively with `source`/`managementUrl` (Paddle portal vs App Store/Play native subscription management deep links).

### 11.2 Store catalog & compliance

- `plus`/`pro` monthly+annual → auto-renewing subscriptions; `believer` → non-consumable (iOS) / one-time product (Play). RC handles non-subscriptions fine on the stores (the one-time limitation is Paddle-side only).
- Client: `react-native-purchases` v9+, `Purchases.logIn(userId)`, paywall, purchase, **restore** (App Review requirement), `/auth/billing` as truth (client state is cosmetic — sync gating is server-enforced).
- **Compliance:** unlocking web-purchased plans after login is compliant (Apple 3.1.3(b) / Play Payments policy) as long as there's no in-app steering outside permitted regions. Offering matching IAPs removes the residual reviewer-interpretation risk (MemryNote is a consumer app, not a reader app). The genuinely-useful free tier strengthens the "not a locked shell" position. **US-storefront Paddle link-out is a phase-2, feature-flagged, region-gated extra** — do not ship it to EU/RoW; monitor the pending SCOTUS Epic-v-Apple docket. **Play Billing Library 8 is mandatory by 2026-08-31** — RC v9 satisfies it.

---

## 12. Offline-first & background sync

- **Foreground-primary:** fullSync on app open/foreground (as desktop does on start), pull on WS `changes_available`/`crdt_updated` while active. Every local mutation enqueues into `sync_queue` and triggers a debounced push.
- **Background:** `expo-background-task` (iOS BGTaskScheduler / Android WorkManager) does a bounded delta pull/push and reschedules. **Best-effort freshness, not correctness** — 15-min floor, opportunistic iOS scheduling (~30 s runtime budget), killed-app = nothing until next launch, aggressive OEM battery managers on Android. Nothing in the CRDT/vector-clock model requires timely background execution — offline-first already tolerates staleness.
- **Push nudges (phase 2):** content-free "something changed, pull" pings from the Hono Worker via Expo Push Service (a plain HTTPS call — no firebase-admin needed in the Workers runtime). **Never plaintext note titles** (payloads transit Expo/FCM/APNs).
- The **24-h stale-cursor reset** (offline > 24 h → cursor to 0 for a full re-pull) matters more on mobile than desktop.

---

## 13. Theming, i18n, RTL, accessibility

- **Theming:** desktop uses CSS variables + next-themes classes — RN has neither. Extract light/white/dark token values from `apps/desktop/src/renderer/src/assets/base.css` into a **shared TS token map**; accent = one token (default `#f97316`). The custom-theme spec (base + hex overrides keyed by variable name) has an RN-friendly data model even though its apply mechanism is DOM-specific. Custom themes = **defer** (spec-only, unmerged; would be a 17th sync item type).
- **i18n:** reuse `@memry/i18n` (i18next + i18next-icu, pure JS) and all 32 locale JSONs. Needs a Hermes `Intl`/`intl-messageformat` coverage check, an RN language detector, and `I18nManager.forceRTL` replacing `document.dir` for `ar`/`he`.
- **RTL:** the Tailwind-logical-props discipline (`ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`) that desktop enforces has RN equivalents (RN flexbox is already `start`/`end` aware). New mobile UI follows the same rule.
- **A11y:** WCAG AA + reduced-motion (respect `AccessibilityInfo.isReduceMotionEnabled`) + RTL, per `PRODUCT.md`. Personality: calm, private, crafted.

---

## 14. Telemetry

Reuse the `trackTelemetry` surface/action enums (`packages/contracts/src/telemetry-api.ts`) for parity metrics; transport posts to the Cloudflare Analytics Engine pipeline via `fetch` (mobile has no main process). Telemetry is **opt-in** with a privacy-first default; the toggle lives in Settings → Privacy. Error logs flow to the existing Grafana/Loki pipeline (labels app/env/level).

---

## 15. Testing strategy

1. **Crypto golden vectors on-device** — run the in-repo RFC fixtures + `tests/sync-harness/` corpus in CI (Maestro/Detox) on real iOS + Android; **desktop↔mobile interop** (each encrypts/signs, the other decrypts/verifies; same phrase+salt → same master key).
2. **Sync protocol conformance** — a mobile client run against a local sync-server fixture: push/pull/manifest, quarantine, replay, cursor advance, field-merge, `_offline` rebinding, CRDT snapshot+incremental. Reuse the server's existing test harness.
3. **Editor round-trip diff** — the mobile WebView bundle must pass the desktop **byte-preservation golden suite** (`apps/desktop/src/main/vault/byte-preservation.golden.test.ts`); gate every `@blocknote/*` bump on it.
4. **Yjs interop** — apply desktop-exported updates on mobile and vice versa; verify fragment convergence for every custom node type.
5. **Migration parity** — the fresh mobile lineage's final schema must equal desktop's (column/table names identical) — a schema-diff test.
6. **E2E (Detox/Maestro)** — onboarding (OTP + QR link), create/edit/sync a note round-trip to a second device, task CRUD, IAP purchase/restore (sandbox), offline→online convergence.
7. **Unit** — Vitest for all extracted shared packages (they already have tests that move with the code).

---

## 16. EAS build, release & CI pipeline

- **Dev client from day one** (`npx expo run:ios|android` or EAS dev builds). Expo Go is unusable (SQLCipher, libsodium, IAP, Android push all outside it).
- **EAS Build + Submit + Update.** Free tier for early dev; Starter ($19/mo) once internal distribution starts; Production ($199) only near 50k EAS-Update MAU or when concurrency matters. EAS Update MAU only bills if OTA is used — ship without it initially. Not locked in (`eas build --local` / fastlane possible; expo-updates protocol is self-hostable).
- **pnpm monorepo** — first-class since SDK 54; `expo/metro-config` auto-detects. Consume shared packages via `workspace:*`. Keep the isolated (default) linker; the `hoisted` escape hatch is repo-wide, so if forced, re-test the Electron install (spike #5).
- **CI** — extend the existing GitHub Actions: typecheck/lint/test the new packages + `apps/mobile`; on-device crypto+E2E jobs; `eas build` on release branches; `eas submit` to TestFlight/Play internal for beta.
- **Version lockstep** — `@blocknote/*`, `yjs`, and `zod` pinned identically to desktop; a CI check fails the mobile build if they drift, and BlockNote bumps are gated on the round-trip diff suite.

---

## 17. Server-side changes required (summary)

| Change                                                                                   | Why                                                                      | Risk                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entitlement_grants` table + effective-entitlement compute + `POST /webhooks/revenuecat` | Multi-source entitlements (Paddle + App Store + Play) without clobbering | Additive migration; behavior-preserving for Paddle-only                                                                                                                                               |
| Extend `SyncEntitlementSource` + `BillingStatusResponse` additively                      | Mobile store sources + management URLs                                   | Old clients tolerate unknown source strings                                                                                                                                                           |
| Extend settings-sync **push** beyond `general.*` (D8 — now in scope)                     | Task/calendar defaults follow the user cross-device                      | Inbound schema already tolerant; low-risk                                                                                                                                                             |
| Add `home_page` / `bookmark` / `reminder` sync item types (D6)                           | Home/bookmarks/reminders follow the user cross-device                    | Additive: `SYNC_ITEM_TYPES` enum + exhaustive `toSyncDomain` switch (`apps/sync-server/src/services/sync-telemetry.ts`) + storage categorization + new desktop handlers; deploy server before clients |
| Relax linking `/complete` IP-match for mobile (consider)                                 | Wi-Fi→cellular hop / CGNAT breaks the 5-min window                       | Session-bound proof instead of IP                                                                                                                                                                     |
| Add iOS/Android Google OAuth client + redirect validation (phase 2)                      | Native Google sign-in                                                    | Server allowlist change; OTP-only ships zero-change                                                                                                                                                   |
| Push-nudge sender via Expo Push Service (phase 2)                                        | Background freshness                                                     | Content-free pings only                                                                                                                                                                               |
| Certificate-pin hashes for `sync.memrynote.com` (verify)                                 | Prod pins are placeholders today                                         | Confirm posture before pinning on mobile                                                                                                                                                              |

**No server change needed** for the core protocol: record + CRDT + attachment sync, auth/OTP, device registration, QR linking, and vault adoption are all already platform-agnostic and accept `ios`/`android`. The only additive server touches are the D6 item types and the D8 settings-push — both additive, server-deploys-first.

---

## 18. Phased roadmap

Aligns with D3 (beta-early, store at full parity). Durations assume one experienced RN dev; the extraction (§3.2) and mobile features overlap once seams exist. The D6 sync item types and the D8 settings-push are additive desktop+server changes that must ship server-first, before or alongside the mobile handlers — fold them into Phase 1 as server/desktop prep so the backend is ready when mobile first writes.

### Phase 0 — De-risk (weeks 1–2)

The five week-1 spikes (§2). **Gate:** crypto byte-compat proven, Yjs perf acceptable, BlockNote-in-WebView viable, op-sqlite triple-flag works, pnpm install clean. If the editor spike fails, fall back to source-mode-first (§9.3) and re-plan the editor as a fast-follow.

### Phase 1 — Extraction + skeleton (weeks 3–10)

Extract `@memry/crypto`, `@memry/sync-engine`, `@memry/crdt-core`, `@memry/platform`, `@memry/app-kernel` (each keeps desktop green, verified by the existing suite). Scaffold `apps/mobile` (expo-router, op-sqlite + Drizzle + SQLCipher, migration runner, MMKV, expo-secure-store). Implement crypto adapter + golden interop tests.

### Phase 2 — Auth + sync + read (weeks 8–16, overlaps Phase 1)

OTP sign-in, QR device-linking (scan side) + key distribution, token lifecycle. Full record + CRDT sync client. Read-only rendering of synced notes/journals/tasks/inbox. **→ First TestFlight / Play internal beta** (D3): a device links, pulls, and displays real synced data. Highest-signal early feedback on the two riskiest surfaces.

### Phase 3 — Write + editor + core features (weeks 14–26)

BlockNote WebView editor (+ source-mode fallback shipped first). Full CRUD on notes, journal, tasks, projects, inbox (capture via share-sheet + voice). Search (FTS5). Tags, folders, backlinks, templates, reminders (local notifications). Beta widens.

### Phase 4 — Calendar + home + settings + IAP (weeks 24–34)

Calendar (views + projection + event CRUD; Google read-only). Home (single-column widgets). Full settings surface. **RevenueCat IAP + server entitlement merge** (`entitlement_grants` + `/webhooks/revenuecat`). Theming + i18n + RTL + a11y pass.

### Phase 5 — Hardening + store launch (weeks 32–40)

IME/keyboard QA matrix, offline-convergence soak, background-sync tuning, App Review prep (restore, privacy nutrition labels, Play Billing 8), performance on low-end Android. **→ Store launch at full main-feature parity** (D3).

_(Weeks are indicative and overlap; the extraction is the critical path and can parallelize once seams land.)_

---

## 19. Risks & open questions

### Top risks (with mitigations)

1. **Argon2id byte-compat / low-RAM Android** — mitigated by the week-1 fixture spike; if a device class can't allocate 64 MiB, it becomes a minimum-device-spec decision (params are immutable).
2. **Yjs-on-Hermes performance** — the biggest unmeasured unknown; spike #2 gates it; mitigations are flush-merge + idle-chunking + (last resort) worklet offload.
3. **BlockNote-in-RN is first-of-its-kind** — mitigated by the source-mode fallback shipping first and the host-agnostic bundle (can drop to raw react-native-webview). Some Android IME fixes will be upstream BlockNote PRs.
4. **react-native-libsodium / op-sqlite bus factor** (small/solo maintainers) — both MIT/forkable; libsodium fallback is quick-crypto (Argon2id/Ed25519/X25519) + noble XChaCha; op-sqlite fallback is expo-sqlite (Drizzle abstracts the driver).
5. **Store compliance drift** (pending SCOTUS Epic-v-Apple, EU DMA fee flux, Play one-time fee ambiguity) — mitigated by IAP-everywhere + feature-flagged US-only link-out + re-verify at enrollment.
6. **Extraction destabilizing desktop** — mitigated by move-and-re-export + tests-move-with-code + desktop-consumes-first, verified by the existing suite.

### Resolved decisions (2026-07-14)

The six questions below were open at first draft; Kaan resolved them on 2026-07-14. They are now locked as D5–D10 in §0 and propagated through the relevant sections. Recorded here with the chosen answer and its consequence.

1. **Home boards, bookmarks, reminders on mobile → SYNCED (not local-only).** Invest in three new sync item types (`home_page`, `bookmark`, `reminder`) so they follow the user across devices. Consequence: additive work on `SYNC_ITEM_TYPES` (contracts), the exhaustive `toSyncDomain` telemetry switch on the server (§17), **new desktop handlers** (desktop keeps these local today), and mobile handlers — server deploys before clients. This is **D6**, and it also upgrades desktop cross-device behaviour, not only mobile.
2. **Version history on mobile → REPLICATED, device-local.** Port desktop's local-snapshot mechanism so mobile builds its own history; it stays **device-local (not synced on the wire)** — same posture as desktop. This is **D7**.
3. **Extend settings-sync push beyond `general.*` → YES, now.** Extend the desktop push emitter to also push `editor`/`tasks`/`calendar`/`keyboard` groups so per-feature defaults follow the user. The inbound schema already tolerates them; low-risk. This is **D8**.
4. **Minimum supported OS / device spec → iOS 16+ / Android 10+ / ~4 GB RAM.** A safe floor for the immutable 64 MiB Argon2id allocation and Yjs-on-Hermes working set, while still covering the large majority of active devices. This is **D9** and it settles the Argon2id/Yjs device-class question.
5. **First-device-on-mobile → LINK-ONLY v1.** Mobile v1 obtains the vault master key by QR-linking to an existing signed-in device (scan-side only); creating a brand-new account directly on the phone (which adds first-device Argon2id + 24-word-phrase UX) is deferred. This is **D5**.
6. **iPad → PHONE-ONLY v1.** Ship phone layouts first; iPad-optimized split-view / hardware-keyboard / wide layouts are a fast-follow. This is **D10**.

---

## Appendix A — Canonical-source-per-entity (mobile)

| Entity                                                      | Mobile canonical          | Wire                                                     | Syncs?                                            |
| ----------------------------------------------------------- | ------------------------- | -------------------------------------------------------- | ------------------------------------------------- |
| Note body                                                   | Y.Doc (SQLite update log) | `note` CRDT updates+snapshots + `NoteSyncPayload` record | Yes (unless local-only)                           |
| Note identity/metadata                                      | `note_metadata` row       | inside `note` payload                                    | Yes                                               |
| Journal entry                                               | SQLite row (date) + Y.Doc | `journal` record keyed by date                           | Yes (record, not CRDT wire)                       |
| Tasks / projects+statuses                                   | `tasks` / `projects`      | field-clock payloads                                     | Yes                                               |
| Inbox items                                                 | `inbox_items`             | `inbox` payload                                          | Yes                                               |
| Calendar events/sources/bindings/external                   | respective tables         | respective payloads                                      | Yes                                               |
| Tag definitions                                             | `tag_definitions`         | `tag_definition`                                         | Yes                                               |
| Folder config (icon)                                        | `folder_configs`          | `folder_config` (icon only)                              | Partial (views don't sync)                        |
| Saved filters                                               | `saved_filters`           | `filter`                                                 | Yes                                               |
| Settings (synced subset)                                    | `synced_settings`         | `settings` singleton                                     | Yes                                               |
| Home boards / bookmarks / reminders                         | SQLite                    | `home_page` / `bookmark` / `reminder` (new types, D6)    | Yes (new sync item types)                         |
| Version history / note positions / templates / folder views | SQLite                    | —                                                        | No (local-only; history replicated on-device, D7) |
| Agent chat                                                  | (excluded on mobile v1)   | —                                                        | —                                                 |

## Appendix B — Effort summary

| Workstream                                                                               | Effort                |
| ---------------------------------------------------------------------------------------- | --------------------- |
| Extraction: `@memry/crypto`                                                              | S–M (1–2 wk)          |
| Extraction: `@memry/sync-engine`                                                         | L (3–6 wk)            |
| Extraction: `@memry/crdt-core`                                                           | M–L (2–4 wk)          |
| Extraction: `@memry/editor-web` + markdown                                               | L (3–5 wk)            |
| Extraction: `@memry/platform` + `@memry/app-kernel`                                      | M (2–3 wk)            |
| Editor surface (WebView + provider + chrome + QA)                                        | 9–15 wk               |
| Sync client wiring + item handlers on mobile                                             | 4–6 wk                |
| Crypto adapter + linking + auth                                                          | 3–5 wk                |
| Local data layer (op-sqlite + migrations + Yjs persistence + FTS)                        | 3–5 wk                |
| Feature UIs (notes/journal/tasks/projects/calendar/inbox/home/settings)                  | large, parallelizable |
| Payments (RC client + server entitlement merge)                                          | 2–3 wk                |
| New sync item types (home_page/bookmark/reminder): contracts + server + desktop + mobile | M (2–3 wk)            |
| Version history replication (device-local)                                               | S–M (1–2 wk)          |
| Settings-sync push extension (desktop emitter)                                           | S (a few days)        |
| **Prep (extraction) before feature velocity**                                            | **~2–3 months**       |

---

_Research corpus: 17-agent parallel pass (2026-07-13) over the codebase + Expo/RN/crypto/CRDT/editor/IAP ecosystem. Every codebase claim above is anchored to a repo path; ecosystem claims were verified against official docs/npm/GitHub on the research date and carry the usual "re-verify at implementation time" caveat for fast-moving store policy and library maintenance status._
