# Memry Mobile (Expo) — Decision Record

Date: 2026-08-22
Status: agreed, not started
Owner: Kaan (solo)

Outcome of a design interview. Every entry below is a decision, not a suggestion.
Nothing here has been implemented.

---

## 1. Scope

**Vault parity, not feature parity.** Every one of the 12 synced item types
(`note, journal, task, project, canvas, bookmark, inbox, attachment, template,
filter, reminder, settings`) is reachable on mobile. Desktop-only tooling is not
ported.

Explicitly out of v1:

| Feature | Reason |
|---|---|
| Agent Chat | CLI spawn + localhost MCP impossible on iOS |
| Importers | read local app databases; impossible in the iOS sandbox |
| Semantic search | `sqlite-vec` and `@huggingface/transformers` unavailable |
| Canvas editing | Excalidraw is DOM-bound; read-only view only |

FTS search stays. Canvas is read-only.

## 2. Platform and timeline

- iOS first. Android 4–8 weeks after, same codebase, serialized QA.
- Solo. ~26 weeks including In-App Purchase.

## 3. Repository

- `apps/mobile` lives in this monorepo.
- `@memry/app-core` is split: pure domain vs. the 12 files that touch node
  builtins. `storage-vault` has 1 such file. The other 11 shared packages are
  already clean.
- `scripts/check-architecture-boundaries.js` gains a rule: nothing reachable
  from `apps/mobile` may import a node builtin or `electron`.
- Mobile is initially excluded from root `typecheck` / `test` filters and runs
  its own `mobile-ci.yml`. This exclusion is temporary and must be removed once
  `@memry/sync-client` extraction lands.

## 4. UI and editor

- Native React Native UI for navigation, lists, tasks, calendar, search.
- Note body only is a WebView hosting BlockNote, so `@memry/editor-schema`
  stays the single source of truth.
- Y.Doc lives on the **React Native side**, mirroring how the Electron main
  process owns docs today. The WebView gets a bridge provider analogous to the
  IPC provider.
- The RN↔WebView bridge is string-only: Y updates are base64-framed and must be
  batched on **both** ends. Not an optimization — a launch requirement.

Rejected: WebView-owned Y.Doc with IndexedDB persistence. iOS can evict
WKWebView storage under pressure, silently losing unsynced writes.

## 5. Local storage

- **No files for notes.** SQLite is the store; a SQLite-backed
  `NoteContentStore` implements the existing interface.
- Note bodies are stored as **raw markdown including frontmatter**, byte-identical
  to desktop, so `app-core`'s parsing works unchanged.
- **Attachment bytes are sandbox files**, not SQLite blobs — size limits, memory,
  and `NSFileProtection`.

## 6. Native stack

Three native dependencies, all verified in Phase 0 before anything else:

- **crypto** — `libsodium-wrappers-sumo` is WASM and will not run under Hermes.
  A JSI binding must cover: XChaCha20-Poly1305, Argon2id, Ed25519,
  `crypto_kdf_derive_from_key`, `crypto_generichash`, `crypto_auth`,
  `crypto_scalarmult`, `crypto_box_keypair`.
  Argon2id parameters are 64 MiB / ops 3 (`packages/contracts/src/crypto.ts:28`)
  — acceptable on iOS.
- **SQLite** — `expo-sqlite` or `op-sqlite`. No `sqlite-vec`.
- **Yjs persistence** — `y-leveldb` is replaced by a SQLite-backed adapter.

Byte parity with desktop crypto vectors is non-negotiable. Without it, existing
vaults do not open on mobile.

## 7. Sync

- Extract `@memry/sync-client`. 217 of 227 sync files are already free of
  `electron`; the 10 that are not go behind a platform adapter:
  `http-client`, `certificate-pinning`, `crdt-persistence`, `crdt-store-path`,
  `attachments`, `vault-directory`, `device-registration`, `crdt-provider`,
  `crdt-preflight`, `runtime`.
- Extraction happens **before** mobile code and must leave desktop green.
- Background sync: foreground + `BGAppRefreshTask`. Silent push (APNs) is v2 —
  the server has no push infrastructure today.
- Reminders use local notifications scheduled from already-synced data.
- First sync on a new device: metadata + last 30 days of bodies, remaining
  bodies on demand. Attachments stay lazy, Wi-Fi-only by default.
- Certificate pinning is **not** shipped on mobile. A bad pin cannot be fixed
  faster than App Store review, which would cut every mobile user off from sync.
  Separately: production pins in `certificate-pins.ts` are still
  `PLACEHOLDER_...`, so desktop pinning is not enforced either. Tracked as its
  own issue.
- The outbox is persisted in SQLite. An in-memory outbox loses writes when iOS
  kills the app in the background.

## 8. Keys

- `expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
- No Face ID gate in v1 — it adds lockout failure modes. Optional toggle later.
- Both password and recovery-phrase entry paths at onboarding.

## 9. Billing

- In-App Purchase ships in v1.
- The entitlement row gains `source: 'paddle' | 'apple'`; sync is enabled if
  either is active; on conflict the later expiry wins. Additive migration.
- Requires Apple App Store Server Notifications V2: JWS verification,
  `originalTransactionId` → account mapping, sandbox/production separation.
- **Double subscription is a real case**: a user can pay Paddle on the web and
  Apple on the phone. Memry cannot cancel the Apple side. v1 must detect and
  surface this, or it returns as refund requests.

## 10. Protecting production vaults

The server has no client version gate today, and mobile writes into the same
sync as existing desktop users.

Ship in Phase 2, not at the end:

- `x-memry-client: ios/<version>` on every request.
- Server-side minimum-version table; below it, the client cannot write.
- A per-device / per-platform **write kill switch** that drops iOS to read-only
  with one config change.
- Mark mobile-originated writes server-side so an incident can be traced and
  rolled back.

Estimated 3–4 days. Also a safety net desktop does not have today.

## 11. Release train

Each gate must be green before the next phase starts.

| Phase | Weeks | Work | Gate |
|---|---|---|---|
| 0 | 1–2 | Spike: fetch and decrypt one note on device | Byte parity with desktop crypto vectors |
| 1 | 3–6 | `@memry/sync-client` extraction | Desktop tests green, behaviour unchanged |
| 2 | 7–10 | Shell: auth, keys, SQLite, sync engine, read-only note list, client version gate + kill switch | Desktop write visible on phone in <5s |
| 3 | 11–15 | Editor WebView + CRDT bridge + batching | Offline write and conflict pass; <50ms keystroke latency on a 50KB note |
| 4 | 16–19 | tasks, journal, calendar, inbox, bookmarks, FTS, canvas read-only, reminders | All 12 sync types readable |
| 5 | 20–22 | IAP, entitlement merge, paywall, double-subscription UI, privacy/export declarations | Sandbox purchase enables sync |
| 6 | 23–25 | App Store prep, TestFlight | Review-ready build |
| 7 | 26 | Submission + buffer | — |

If the schedule slips, the tail of Phase 4 (canvas read-only, reminders) is cut
first. Phases 0 and 1 are not skippable.

## 12. App Store compliance

All four in v1; the declarations are done in Phase 5, not Phase 6.

- `ITSAppUsesNonExemptEncryption` export compliance declaration.
- `PrivacyInfo.xcprivacy` privacy manifest and required-reason API declarations.
- App Privacy labels. Telemetry exists — "we collect nothing" would be a false
  declaration. State accurately that collected data is not identity-linked.
- In-app account deletion. `apps/sync-server/src/services/account-deletion.ts`
  already exists; only UI is missing.

## 13. Beta

- TestFlight, internal ring of 5–10 people, on their **real** vaults.
- Opens only after the Phase 3 gate, and only once the Phase 2 kill switch is live.
- No open beta before the write path has been exercised. A mobile write bug
  corrupts the same user's desktop vault.

---

## Open risks

1. RN libsodium binding may not cover the full primitive set. Phase 0 gate.
2. Metro under pnpm with `shamefullyHoist: true` and raw `./src/*.ts` workspace
   exports. Phase 0.
3. RN↔WebView bridge throughput while typing. Phase 0/3.
4. Apple review outcome for the double-subscription flow.
5. Production certificate pins are placeholders — pre-existing, separate issue