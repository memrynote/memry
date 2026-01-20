# Tasks: Sync Engine & End-to-End Encryption

**Input**: Design documents from `/specs/001-sync-e2ee-2/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Tests are NOT included by default. Add them if explicitly requested.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Electron App**: `src/main/`, `src/renderer/`, `src/shared/`, `src/preload/`
- **Sync Server**: `sync-server/src/`
- **Tests**: `tests/unit/`, `tests/integration/`, `tests/e2e/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, dependencies, and basic structure

- [ ] T001 Install crypto dependencies (libsodium-wrappers, sodium-native, keytar, bip39) via pnpm
- [ ] T002 Install CRDT dependencies (yjs, y-protocols, y-leveldb, level) via pnpm
- [ ] T003 [P] Create sync-server Cloudflare Workers project in sync-server/
- [ ] T004 [P] Create directory structure src/main/crypto/ for crypto module
- [ ] T005 [P] Create directory structure src/main/sync/ for sync engine module
- [ ] T006 [P] Create directory structure src/renderer/src/components/sync/ for sync UI
- [ ] T007 [P] Create directory structure src/shared/contracts/ for shared type contracts
- [ ] T008 Configure Cloudflare D1 database binding in sync-server/wrangler.toml
- [ ] T009 Configure Cloudflare R2 bucket binding in sync-server/wrangler.toml
- [ ] T010 Add sync-related environment variables to .env.development
- [ ] T011 [P] Create shared TypeScript types in src/shared/contracts/sync-api.ts
- [ ] T011a [P] Add signature field to SyncItem type for Ed25519 signatures in src/shared/contracts/sync-api.ts
- [ ] T012 [P] Create shared crypto types in src/shared/contracts/crypto.ts
- [ ] T013 [P] Create IPC channel types in src/shared/contracts/ipc-sync.ts
- [ ] T013a Install cborg dependency for canonical CBOR encoding via pnpm
- [ ] T013b [P] Create .env.staging template with sync server URLs
- [ ] T013c [P] Create .env.production template with sync server URLs
- [ ] T013d [P] Add OAuth client ID/secret placeholders to environment templates

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Database Schema

- [ ] T014 Create D1 users table schema (kdf_salt, key_verifier) in sync-server/schema/d1.sql
- [ ] T014a Create D1 otp_codes table schema (email, code_hash, expires_at, attempts, used, created_at) in sync-server/schema/d1.sql
- [ ] T015 Create D1 devices table schema (name, platform, os_version, app_version, last_sync_at, auth_public_key required) in sync-server/schema/d1.sql
- [ ] T016 Create D1 linking_sessions table schema (new_device_confirm, key_confirm) in sync-server/schema/d1.sql
- [ ] T017 Create D1 sync_items table schema in sync-server/schema/d1.sql
- [ ] T017a Add server_cursor (monotonic integer) and signer_device_id/signature fields to D1 sync_items table in sync-server/schema/d1.sql
- [ ] T017b Create D1 device_sync_state table (device_id, last_cursor_seen) in sync-server/schema/d1.sql
- [ ] T018 Add sync-related tables (devices, sync_queue, sync_state, sync_history) to src/shared/db/schema/data-schema.ts
- [ ] T019 Run drizzle migrations for local sync tables

### Crypto Module Foundation

- [ ] T020 [P] Implement HKDF key derivation with context strings in src/main/crypto/keys.ts
- [ ] T020a [P] Implement canonical CBOR encoder helper in src/main/crypto/cbor.ts (cborg)
- [ ] T021 [P] Implement BIP39 recovery phrase generation in src/main/crypto/recovery.ts
- [ ] T022 [P] Implement BIP39 recovery phrase validation in src/main/crypto/recovery.ts
- [ ] T023 Implement Argon2id master key derivation in src/main/crypto/keys.ts
- [ ] T024 [P] Implement XChaCha20-Poly1305 encryption in src/main/crypto/encryption.ts
- [ ] T024c [P] Implement per-item file key generation (32-byte random) in src/main/crypto/keys.ts
- [ ] T024d [P] Implement file key wrapping (encrypt file key with vault key) and unwrapping in src/main/crypto/encryption.ts
- [ ] T025 [P] Implement XChaCha20-Poly1305 decryption in src/main/crypto/encryption.ts
- [ ] T026 [P] Implement Ed25519 signing over canonical CBOR in src/main/crypto/signatures.ts
- [ ] T027 [P] Implement Ed25519 signature verification over canonical CBOR in src/main/crypto/signatures.ts
- [ ] T028 Implement keychain storage with keytar in src/main/crypto/keychain.ts
- [ ] T028a Implement device signing keypair generation + storage in src/main/crypto/keys.ts and src/main/crypto/keychain.ts
- [ ] T028b Implement device signing public key retrieval for registration in src/main/crypto/keys.ts
- [ ] T029 Create crypto module index exports in src/main/crypto/index.ts

### Server Foundation

- [ ] T030 Set up Hono.js app entry point in sync-server/src/index.ts
- [ ] T031 [P] Implement JWT validation middleware in sync-server/src/middleware/auth.ts
- [ ] T032 [P] Implement rate limiting middleware in sync-server/src/middleware/rate-limit.ts
- [ ] T033 Create base error handling in sync-server/src/lib/errors.ts
- [ ] T033a [P] Implement canonical CBOR encoder helper in sync-server/src/lib/cbor.ts (cborg)
- [ ] T034 [P] Set up Resend email service in sync-server/src/services/email.ts
- [ ] T034a Implement OTP cleanup job (delete expired codes) in sync-server/src/services/otp.ts or sync-server/src/services/cleanup.ts

### IPC Foundation

- [ ] T035 Register sync IPC handlers entry point in src/main/ipc/sync-handlers.ts
- [ ] T036 [P] Register crypto IPC handlers entry point in src/main/ipc/crypto-handlers.ts
- [ ] T036a [P] Implement encrypt-item IPC handler in src/main/ipc/crypto-handlers.ts
- [ ] T036b [P] Implement decrypt-item IPC handler in src/main/ipc/crypto-handlers.ts
- [ ] T036c [P] Implement verify-signature IPC handler in src/main/ipc/crypto-handlers.ts
- [ ] T037 Update src/main/ipc/index.ts to register sync and crypto handlers
- [ ] T038 Expose sync API methods in src/preload/index.ts
- [ ] T039 Update preload types in src/preload/index.d.ts for sync/crypto APIs

### Vector Clock Foundation

- [ ] T040 Implement vector clock data structure in src/main/sync/vector-clock.ts
- [ ] T041 Implement vector clock operations (increment, merge, compare) in src/main/sync/vector-clock.ts
- [ ] T041a Define HKDF context string constants ("memry-vault-key-v1", "memry-signing-key-v1", "memry-verify-key-v1") in src/main/crypto/keys.ts
- [ ] T041b Define Argon2id parameter constants (memory: 65536KB, iterations: 3, parallelism: 4) in src/main/crypto/keys.ts
- [ ] T041c Implement rate limit state persistence in D1 table in sync-server/schema/d1.sql
- [ ] T041d Create typed error codes enum (AUTH_*, SYNC_*, CRYPTO_*) in sync-server/src/lib/errors.ts
- [ ] T041e Implement memry:// deep link protocol handler for OAuth callbacks in src/main/index.ts
- [ ] T041f Create canonical CBOR field ordering documentation in src/main/crypto/cbor.ts
- [ ] T041g Define sync cursor types and signature metadata in src/shared/contracts/sync-api.ts

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - First Device Setup (Priority: P1) 🎯 MVP

**Goal**: New users can create accounts via OAuth or passwordless email OTP, receive a recovery phrase, and have encryption keys securely stored

**Independent Test**: Create a new account via email OTP, confirm recovery phrase, verify master key is stored in OS keychain and local data is encrypted

### Server Implementation for US1

- [ ] T042 [P] [US1] Implement request-otp endpoint (sends 6-digit code via email) in sync-server/src/routes/auth.ts
- [ ] T043 [P] [US1] Implement verify-otp endpoint (validates code, returns JWT) in sync-server/src/routes/auth.ts
- [ ] T044 [P] [US1] Implement OTP generation service (6 digits, cryptographically random) in sync-server/src/services/otp.ts
- [ ] T044a [P] [US1] Implement OTP storage with SHA-256 hashing in sync-server/src/services/otp.ts
- [ ] T044b [P] [US1] Implement OTP rate limiting (max 3 requests per 10 min per email) in sync-server/src/middleware/rate-limit.ts
- [ ] T044c [P] [US1] Implement OTP attempt tracking (max 5 failed attempts per code) in sync-server/src/services/otp.ts
- [ ] T047 [P] [US1] Create OTP email template in sync-server/src/emails/otp-code.tsx
- [ ] T047a [P] [US1] Implement resend-otp endpoint (reuses rate limiting) in sync-server/src/routes/auth.ts
- [ ] T048 [US1] Implement OAuth initiation endpoint for Google/Apple/GitHub in sync-server/src/routes/auth.ts
- [ ] T049 [US1] Implement OAuth callback handler in sync-server/src/routes/auth.ts
- [ ] T050 [US1] Implement device registration endpoint in sync-server/src/routes/auth.ts
- [ ] T050a [US1] Require device signing public key + metadata on registration and persist in devices table in sync-server/src/routes/auth.ts
- [ ] T051 [US1] Implement first device setup endpoint (stores kdf_salt, key_verifier) in sync-server/src/routes/auth.ts
- [ ] T052 [US1] Implement JWT token issuance service in sync-server/src/services/auth.ts
- [ ] T053 [US1] Implement user service (create, get, update) in sync-server/src/services/user.ts

### Client Implementation for US1

- [ ] T054 [US1] Implement IPC handler for request-otp in src/main/ipc/sync-handlers.ts
- [ ] T055 [US1] Implement IPC handler for verify-otp in src/main/ipc/sync-handlers.ts
- [ ] T056 [US1] Implement IPC handler for resend-otp in src/main/ipc/sync-handlers.ts
- [ ] T056a [P] [US1] Implement OTP code auto-paste from clipboard detection in src/main/ipc/sync-handlers.ts
- [ ] T057 [US1] Implement IPC handler for OAuth first device setup in src/main/ipc/sync-handlers.ts
- [ ] T058 [US1] Implement master key derivation from recovery phrase and key verifier generation in src/main/crypto/keys.ts
- [ ] T059 [US1] Implement vault key derivation via HKDF in src/main/crypto/keys.ts
- [ ] T060 [US1] Implement signing/verify key derivation via HKDF in src/main/crypto/keys.ts
- [ ] T060a [US1] Store derived Ed25519 signing keypair in OS keychain in src/main/crypto/keychain.ts
- [ ] T061 [US1] Store master key in OS keychain in src/main/crypto/keychain.ts
- [ ] T061a [US1] Generate and store device signing keypair during first device setup in src/main/crypto/keys.ts
- [ ] T062 [US1] Implement recovery phrase confirmation IPC handler in src/main/ipc/sync-handlers.ts

### UI Components for US1

- [ ] T063 [P] [US1] Create AuthProvider context in src/renderer/src/contexts/auth-context.tsx
- [ ] T064 [P] [US1] Create email entry form component in src/renderer/src/components/sync/email-entry-form.tsx
- [ ] T065 [P] [US1] Create OTP code input component (6-digit boxes) in src/renderer/src/components/sync/otp-input.tsx
- [ ] T065a [P] [US1] Implement OTP countdown timer (resend available after 60s) in src/renderer/src/components/sync/otp-input.tsx
- [ ] T065b [US1] Implement OTP verification screen in src/renderer/src/components/sync/otp-verification.tsx
- [ ] T066 [P] [US1] Create OAuth buttons component in src/renderer/src/components/sync/oauth-buttons.tsx
- [ ] T067 [US1] Create recovery phrase display component in src/renderer/src/components/sync/recovery-phrase-display.tsx
- [ ] T068 [US1] Create recovery phrase confirmation component in src/renderer/src/components/sync/recovery-phrase-confirm.tsx
- [ ] T069 [US1] Create first device setup wizard page in src/renderer/src/pages/settings/setup-wizard.tsx
- [ ] T069a [US1] Wire AuthProvider into renderer root in src/renderer/src/main.tsx
- [ ] T069b [US1] Wire setup wizard entry point into Settings UI in src/renderer/src/pages/settings.tsx
- [ ] T069c [US1] Bind email/OTP/OAuth/recovery components to auth service + IPC in src/renderer/src/pages/settings/setup-wizard.tsx

### Services for US1

- [ ] T070 [US1] Create auth service for renderer in src/renderer/src/services/auth-service.ts
- [ ] T071 [US1] Create useAuth hook in src/renderer/src/hooks/use-auth.ts
- [ ] T072 [US1] Implement PKCE code_verifier and code_challenge generation in src/main/ipc/sync-handlers.ts
- [ ] T073 [US1] Implement automatic access token refresh with retry logic in src/main/ipc/sync-handlers.ts
- [ ] T073a [US1] Emit auth:session-expired event when token refresh fails in src/main/ipc/sync-handlers.ts
- [ ] T073b [US1] Store OAuth tokens separately from master key in keychain in src/main/crypto/keychain.ts
- [ ] T073c [US1] Implement refresh-token IPC call from renderer in src/renderer/src/services/auth-service.ts
- [ ] T073d [US1] Ensure renderer does not refresh tokens directly (delegate to main IPC only) in src/renderer/src/services/auth-service.ts

**Checkpoint**: User Story 1 complete - users can create accounts and set up encryption

---

## Phase 4: User Story 2 - Cross-Device Sync (Priority: P1) 🎯 MVP

**Goal**: Users with multiple devices see their notes, tasks, and attachments sync automatically

**Independent Test**: Create content on Device A, verify it appears on Device B within expected timeframes, test offline queueing

### Sync Engine Core for US2

- [ ] T074 [US2] Implement sync queue manager in src/main/sync/queue.ts
- [ ] T075 [US2] Implement sync queue persistence to SQLite in src/main/sync/queue.ts
- [ ] T076 [US2] Implement sync engine class in src/main/sync/engine.ts
- [ ] T077 [US2] Implement WebSocket connection manager in src/main/sync/websocket.ts
- [ ] T078 [US2] Implement network status monitoring in src/main/sync/network.ts
- [ ] T079 [US2] Implement retry logic with exponential backoff in src/main/sync/retry.ts
- [ ] T080 [US2] Implement item encryption before sync (generate file key, wrap with vault key, encrypt data, create EncryptedItem with encryptedKey/keyNonce/encryptedData/dataNonce) in src/main/sync/engine.ts
- [ ] T080a [US2] Sign items with device Ed25519 key over canonical CBOR and attach signer_device_id metadata before sync push in src/main/sync/engine.ts
- [ ] T081 [US2] Implement item decryption after sync in src/main/sync/engine.ts

### Server Sync Endpoints for US2

- [ ] T082 [P] [US2] Implement sync status endpoint in sync-server/src/routes/sync.ts
- [ ] T083 [P] [US2] Implement sync manifest endpoint in sync-server/src/routes/sync.ts
- [ ] T084 [US2] Implement sync changes endpoint using server_cursor (monotonic) in sync-server/src/routes/sync.ts
- [ ] T085 [US2] Implement sync push endpoint in sync-server/src/routes/sync.ts
- [ ] T086 [US2] Implement sync pull endpoint in sync-server/src/routes/sync.ts
- [ ] T087 [US2] Implement single item get endpoint in sync-server/src/routes/sync.ts
- [ ] T088 [US2] Implement item delete endpoint in sync-server/src/routes/sync.ts
- [ ] T089 [US2] Implement sync service with D1/R2 integration in sync-server/src/services/sync.ts
- [ ] T089a [US2] Persist server_cursor and device last_cursor_seen in sync-server/src/services/sync.ts
- [ ] T089b [US2] Validate signer_device_id + signature metadata on sync push in sync-server/src/services/sync.ts

### WebSocket/Durable Objects for US2

- [ ] T090 [US2] Create UserSyncState Durable Object in sync-server/src/durable-objects/user-state.ts
- [ ] T091 [US2] Implement WebSocket upgrade handling in UserSyncState
- [ ] T092 [US2] Implement broadcast to connected devices in UserSyncState
- [ ] T093 [US2] Configure Durable Object binding in sync-server/wrangler.toml

### Client Sync IPC for US2

- [ ] T094 [US2] Implement get sync status IPC handler in src/main/ipc/sync-handlers.ts
- [ ] T095 [US2] Implement trigger sync IPC handler in src/main/ipc/sync-handlers.ts
- [ ] T096 [US2] Implement get queue size IPC handler in src/main/ipc/sync-handlers.ts
- [ ] T097 [US2] Implement pause/resume sync IPC handlers in src/main/ipc/sync-handlers.ts
- [ ] T097a [US2] Include server_cursor in client sync state and persist last_cursor_seen in src/main/sync/engine.ts

### Sync Events for US2

- [ ] T098 [US2] Implement sync status changed event broadcasting in src/main/sync/engine.ts
- [ ] T098a [US2] Update device last_sync_at timestamp on successful sync in src/main/sync/engine.ts
- [ ] T099 [US2] Implement item synced event broadcasting in src/main/sync/engine.ts
- [ ] T100 [US2] Set up IPC event listeners in renderer for sync events in src/renderer/src/contexts/sync-context.tsx
- [ ] T100a [US2] Wire SyncContext provider into renderer root in src/renderer/src/main.tsx

### Task Sync Integration for US2

- [ ] T101 [US2] Add clock JSON column to tasks table for vector clock storage in src/shared/db/schema/data-schema.ts
- [ ] T102 [US2] Implement task sync handlers (create, update, delete) in src/main/ipc/tasks-handlers.ts
- [ ] T103 [US2] Update TasksProvider to subscribe to sync events in src/renderer/src/contexts/tasks/

### Additional Sync Integrations for US2

- [ ] T103a [US2] Add clock JSON column to inbox_items table in src/shared/db/schema/data-schema.ts
- [ ] T103b [US2] Implement inbox item sync handlers in src/main/ipc/sync-handlers.ts
- [ ] T103c [US2] Add clock JSON column to saved_filters table in src/shared/db/schema/data-schema.ts
- [ ] T103d [US2] Implement saved filter sync handlers in src/main/ipc/sync-handlers.ts
- [ ] T103e [US2] Implement synced settings structure in src/shared/contracts/sync-api.ts
- [ ] T103f [US2] Implement settings sync with field-level vector clocks in src/main/sync/engine.ts
- [ ] T103g [US2] Create settings sync IPC handlers in src/main/ipc/sync-handlers.ts
- [ ] T103h [US2] Verify Ed25519 signature before decryption on every sync pull in src/main/sync/engine.ts
- [ ] T103i [US2] Implement server clock skew detection (warn if >5 min difference) in src/main/sync/engine.ts
- [ ] T103j [US2] Emit sync:conflict-detected event when vector clocks diverge in src/main/sync/engine.ts
- [ ] T103k [US2] Emit sync:queue-cleared event when pending queue becomes empty in src/main/sync/queue.ts
- [ ] T103l [US2] Handle partial batch sync failure (some items succeed, some fail) in src/main/sync/engine.ts
- [ ] T103m [US2] Implement sync item batching (max 100 items per request) in src/main/sync/engine.ts
- [ ] T103n [US2] Update device last_sync_at on successful sync in sync-server/src/services/device.ts

**Checkpoint**: User Story 2 complete - notes and tasks sync automatically across devices

---

## Phase 5: User Story 3 - Device Linking via QR Code (Priority: P1)

**Goal**: Existing users can securely link new devices by scanning a QR code

**Independent Test**: Generate QR on existing device, scan on new device, approve link, verify data syncs to new device

### Server Linking Endpoints for US3

- [ ] T104 [US3] Implement linking session initiation endpoint in sync-server/src/routes/auth.ts
- [ ] T105 [US3] Implement QR scan endpoint (accept new_device_confirm) in sync-server/src/routes/auth.ts
- [ ] T106 [US3] Implement linking approval endpoint (verify new_device_confirm, return key_confirm) in sync-server/src/routes/auth.ts
- [ ] T107 [US3] Implement linking completion endpoint (return encrypted key + key_confirm) in sync-server/src/routes/auth.ts
- [ ] T108 [US3] Create LinkingSession Durable Object in sync-server/src/durable-objects/linking-session.ts

### Client Linking for US3

- [ ] T109 [US3] Implement X25519 key pair generation in src/main/crypto/keys.ts
- [ ] T110 [US3] Implement ECDH shared secret computation and HKDF enc/mac keys in src/main/crypto/keys.ts
- [ ] T110a [US3] Implement linking HMAC proofs using canonical CBOR (new_device_confirm, key_confirm) in src/main/crypto/keys.ts
- [ ] T111 [US3] Implement master key encryption with enc_key in src/main/crypto/encryption.ts
- [ ] T112 [US3] Implement generate linking QR IPC handler in src/main/ipc/sync-handlers.ts
- [ ] T113 [US3] Implement link via QR IPC handler in src/main/ipc/sync-handlers.ts
- [ ] T114 [US3] Implement approve linking IPC handler in src/main/ipc/sync-handlers.ts

### UI Components for US3

- [ ] T115 [P] [US3] Create QR code display component in src/renderer/src/components/sync/qr-linking.tsx
- [ ] T116 [P] [US3] Create QR code scanner component in src/renderer/src/components/sync/qr-scanner.tsx
- [ ] T117 [US3] Create linking approval dialog in src/renderer/src/components/sync/linking-approval-dialog.tsx
- [ ] T118 [US3] Create waiting for approval screen in src/renderer/src/components/sync/linking-pending.tsx
- [ ] T119 [US3] Implement 5-minute expiration timer display and expired QR error dialog in src/renderer/src/components/sync/qr-linking.tsx
- [ ] T119a [US3] Wire QR linking flow into Settings/Setup UI and bind IPC calls in src/renderer/src/pages/settings.tsx and src/renderer/src/pages/settings/setup-wizard.tsx

### Linking Events for US3

- [ ] T120 [US3] Implement linking request event in src/main/sync/websocket.ts
- [ ] T121 [US3] Implement linking approved event in src/main/sync/websocket.ts
- [ ] T121a [US3] Implement HMAC key derivation from ECDH shared secret via HKDF in src/main/crypto/keys.ts
- [ ] T121b [US3] Document HMAC proof CBOR field ordering for new_device_confirm in src/main/crypto/keys.ts

**Checkpoint**: User Story 3 complete - users can link devices via QR code

---

## Phase 6: User Story 4 - Device Linking via Recovery Phrase (Priority: P2)

**Goal**: Users who lost all devices can restore access using their recovery phrase

**Independent Test**: Enter valid 24-word recovery phrase on new device, verify account restored and data syncs

### Server Recovery for US4

- [ ] T122 [US4] Implement recovery data fetch endpoint in sync-server/src/routes/auth.ts

### Client Recovery for US4

- [ ] T123 [US4] Implement recovery phrase to master key derivation in src/main/crypto/recovery.ts
- [ ] T124 [US4] Implement key_verifier validation in src/main/crypto/recovery.ts
- [ ] T125 [US4] Implement link via recovery phrase IPC handler in src/main/ipc/sync-handlers.ts

### UI Components for US4

- [ ] T126 [P] [US4] Create recovery phrase input component in src/renderer/src/components/sync/recovery-input.tsx
- [ ] T127 [US4] Create recovery in progress screen in src/renderer/src/components/sync/recovery-progress.tsx
- [ ] T128 [US4] Add recovery phrase option to login flow in src/renderer/src/pages/settings/setup-wizard.tsx
- [ ] T128a [US4] Wire recovery flow UI to recovery IPC handler in src/renderer/src/pages/settings/setup-wizard.tsx

**Checkpoint**: User Story 4 complete - users can recover accounts with recovery phrase

---

## Phase 7: User Story 5 - Automatic Conflict Resolution for Notes (Priority: P1)

**Goal**: Users editing notes on multiple devices have changes merge automatically without conflicts

**Independent Test**: Edit same note on two offline devices, bring online, verify all changes merged

### CRDT Implementation for US5

- [ ] T129 [US5] Create main-process Yjs host in src/main/sync/crdt-provider.ts (authoritative doc, encryption before network)
- [ ] T129a [US5] Define Yjs IPC channel types (sync/update/awareness) in src/shared/contracts/ipc-sync.ts and specs/001-sync-e2ee-2/contracts/ipc.yaml
- [ ] T129b [US5] Implement main IPC bridge to apply Yjs updates from renderer and broadcast to all windows in src/main/sync/crdt-provider.ts and src/main/ipc/sync-handlers.ts
- [ ] T129c [US5] Implement renderer Yjs IPC provider for BlockNote collaboration in src/renderer/src/sync/yjs-ipc-provider.ts
- [ ] T129d [US5] Implement initial sync handshake (state vector exchange) between renderer and main in src/renderer/src/sync/yjs-ipc-provider.ts
- [ ] T129e [US5] Keep awareness local-only (do not send to server) in src/renderer/src/sync/yjs-ipc-provider.ts
- [ ] T130 [US5] Implement Yjs document creation per note in src/main/sync/crdt-provider.ts
- [ ] T131 [US5] Implement Yjs state vector tracking in src/main/sync/crdt-provider.ts
- [ ] T132 [US5] Implement incremental update encryption in src/main/sync/crdt-provider.ts
- [ ] T133 [US5] Implement snapshot compaction in src/main/sync/crdt-provider.ts
- [ ] T134 [US5] Integrate y-leveldb for local Yjs persistence in src/main/sync/crdt-provider.ts

### Server CRDT Endpoints for US5

- [ ] T135 [P] [US5] Implement note update push endpoint in sync-server/src/routes/sync.ts
- [ ] T136 [P] [US5] Implement note updates get endpoint in sync-server/src/routes/sync.ts
- [ ] T137 [US5] Implement note snapshot push endpoint in sync-server/src/routes/sync.ts
- [ ] T138 [US5] Implement note snapshot get endpoint in sync-server/src/routes/sync.ts

### Notes Integration for US5

- [ ] T139 [US5] Update notes file operations to trigger CRDT sync in src/main/vault/notes.ts
- [ ] T140 [US5] Integrate Yjs with BlockNote collaboration extension using IPC provider in src/renderer/src/components/note/content-area/

**Checkpoint**: User Story 5 complete - note edits merge automatically via CRDT

---

## Phase 7.5: File System Sync Integration (Priority: P1)

**Goal**: Ensure markdown files for notes and journals are bidirectionally synchronized with CRDT state

**Prerequisites**: Phase 7 (User Story 5 CRDT Implementation) must be complete

**Independent Test**: Edit note on Device A, verify .md file appears on Device B. Edit .md file externally, verify change syncs. Create journal entry, verify it syncs.

### CRDT → File Write-Back for US5

- [ ] T140a [US5] Implement Yjs-to-markdown conversion (BlockNote JSON → MD) in src/main/sync/crdt-provider.ts
- [ ] T140b [US5] Write markdown file when receiving CRDT updates from other devices in src/main/vault/notes.ts
- [ ] T140c [US5] Handle new note creation on sync (create .md file with frontmatter if doesn't exist)
- [ ] T140d [US5] Handle note deletion on sync (remove .md file or move to trash folder)
- [ ] T140e [US5] Preserve frontmatter (id, tags, properties) during CRDT → file write-back

### Journal Sync for US5

- [ ] T140f [US5] Register journal entries for Yjs sync (same pattern as notes) in src/main/sync/crdt-provider.ts
- [ ] T140g [US5] Implement journal folder structure sync (journal/YYYY/MM/DD.md) in src/main/vault/journal.ts
- [ ] T140h [US5] Add journal entry to sync manifest in sync-server/src/services/sync.ts
- [ ] T140i [US5] Handle journal date-based file naming during sync creation

### External File Edit Integration for US5

- [ ] T140j [US5] Integrate file watcher with sync engine in src/main/vault/watcher.ts
- [ ] T140k [US5] Detect external file changes during active sync session
- [ ] T140l [US5] Convert external markdown edits to Yjs operations (MD → BlockNote JSON → Yjs)
- [ ] T140m [US5] Implement merge strategy: CRDT merge for content, file wins for frontmatter metadata
- [ ] T140n [US5] Add conflict detection for simultaneous external edit + incoming sync
- [ ] T140o [US5] Implement debounce for rapid external file changes (500ms)

### Incremental Index Rebuild for US2

- [ ] T140p [US2] Trigger incremental index update as each note syncs in src/main/sync/engine.ts
- [ ] T140q [US2] Update FTS index for synced note in src/main/database/fts.ts
- [ ] T140r [US2] Update note_cache, note_tags, note_links tables during sync in src/main/vault/indexer.ts
- [ ] T140s [US2] Show "Indexing notes..." progress during initial sync in src/renderer/src/components/sync/initial-sync-progress.tsx
- [ ] T140t [US5] Configure Yjs collaboration extension for BlockNote/TipTap integration in src/renderer/src/components/note/content-area/
- [ ] T140u [US5] Implement Yjs garbage collection for documents exceeding 1MB in src/main/sync/crdt-provider.ts
- [ ] T140v [US5] Compress Yjs snapshots before encryption using pako/fflate in src/main/sync/crdt-provider.ts

**Checkpoint**: File sync integration complete - notes and journals sync bidirectionally with file system

---

## Phase 8: User Story 6 - Task Sync with Field-Level Merge (Priority: P2)

**Goal**: Task changes sync with intelligent field-level merging

**Independent Test**: Change different fields of same task on two devices, verify all field changes preserved

### Task Sync for US6

- [ ] T141 [US6] Implement per-field vector clocks for tasks in src/main/sync/vector-clock.ts
- [ ] T142 [US6] Implement field-level LWW merge logic in src/main/sync/task-merge.ts
- [ ] T143 [US6] Update task create handler to initialize vector clock in src/main/ipc/tasks-handlers.ts
- [ ] T144 [US6] Update task update handler to increment field clocks in src/main/ipc/tasks-handlers.ts
- [ ] T145 [US6] Implement conflict detection for concurrent edits in src/main/sync/task-merge.ts

### Server Task Sync for US6

- [ ] T146 [US6] Store task vector clocks in sync_items.clock column in sync-server/src/services/sync.ts
- [ ] T147 [US6] Implement server-side conflict response in sync-server/src/routes/sync.ts

### Project Sync for US6

- [ ] T147a [US6] Implement ProjectVectorClock interface (same as TaskVectorClock) in src/shared/sync/project-clock.ts
- [ ] T147b [US6] Implement project field-level merge logic in src/main/sync/project-merge.ts
- [ ] T147c [US6] Add clock JSON column to projects table in src/shared/db/schema/data-schema.ts
- [ ] T147d [US6] Implement project sync handlers (create, update, delete) in src/main/ipc/tasks-handlers.ts
- [ ] T147e [US6] Server-side project sync handlers (store/retrieve encrypted projects) in sync-server/src/services/sync.ts

**Checkpoint**: User Story 6 complete - task and project changes merge at field level

---

## Phase 9: User Story 7 - Binary File Attachments (Priority: P2)

**Goal**: Users can attach files to notes with chunked upload/download and deduplication

**Independent Test**: Attach 50MB file, verify upload progress, download on another device with progress

### Chunked Upload for US7

- [ ] T148 [US7] Implement file chunking (8MB chunks) in src/main/sync/attachments.ts
- [ ] T149 [US7] Implement chunk hash calculation for deduplication in src/main/sync/attachments.ts
- [ ] T150 [US7] Implement chunk encryption in src/main/sync/attachments.ts
- [ ] T151 [US7] Implement upload session management in src/main/sync/attachments.ts
- [ ] T152 [US7] Implement resumable upload tracking in src/main/sync/attachments.ts

### Thumbnail Generation for US7

- [ ] T152a [US7] Implement image thumbnail generation (sharp/canvas) in src/main/sync/attachments.ts
- [ ] T152b [US7] Implement PDF thumbnail generation (first page) in src/main/sync/attachments.ts
- [ ] T152c [US7] Implement video thumbnail extraction (ffmpeg) in src/main/sync/attachments.ts

### Server Blob Endpoints for US7

- [ ] T153 [P] [US7] Implement upload session initiation in sync-server/src/routes/blob.ts
- [ ] T154 [P] [US7] Implement chunk upload endpoint in sync-server/src/routes/blob.ts
- [ ] T155 [US7] Implement upload completion endpoint in sync-server/src/routes/blob.ts
- [ ] T156 [US7] Implement chunk existence check (dedup) in sync-server/src/routes/blob.ts
- [ ] T157 [US7] Implement chunk download endpoint in sync-server/src/routes/blob.ts
- [ ] T158 [US7] Implement attachment manifest endpoints in sync-server/src/routes/blob.ts

### Attachment IPC for US7

- [ ] T159 [US7] Implement upload attachment IPC handler in src/main/ipc/sync-handlers.ts
- [ ] T160 [US7] Implement get upload progress IPC handler in src/main/ipc/sync-handlers.ts
- [ ] T161 [US7] Implement download attachment IPC handler in src/main/ipc/sync-handlers.ts
- [ ] T162 [US7] Implement get download progress IPC handler in src/main/ipc/sync-handlers.ts

### UI Components for US7

- [ ] T163 [P] [US7] Create upload progress component in src/renderer/src/components/sync/upload-progress.tsx
- [ ] T164 [P] [US7] Create download progress component in src/renderer/src/components/sync/download-progress.tsx

### Streaming Playback for US7

- [ ] T164a [P] [US7] Create video player component with streaming support in src/renderer/src/components/sync/video-player.tsx
- [ ] T164b [US7] Implement chunk-based video streaming in src/main/sync/attachments.ts
- [ ] T164c [US7] Add Range header support for partial content delivery in src/main/sync/attachments.ts
- [ ] T164d [US7] Wire upload/download progress UI into attachment flow in src/renderer/src/components/note/content-area/file-block.tsx

**Checkpoint**: User Story 7 complete - attachments sync with progress and deduplication

---

## Phase 10: User Story 8 - Sync Status Visibility (Priority: P2)

**Goal**: Users see clear sync status indicators showing sync state

**Independent Test**: Observe status indicator during idle, syncing, offline, and error states

### UI Components for US8

- [ ] T165 [US8] Create SyncContext provider in src/renderer/src/contexts/sync-context.tsx
- [ ] T166 [US8] Create sync status indicator component in src/renderer/src/components/sync/sync-status.tsx
- [ ] T166a [US8] Bind SyncStatus to useSync data and IPC-triggered actions in src/renderer/src/components/sync/sync-status.tsx
- [ ] T167 [US8] Implement "Synced" state with last sync time display
- [ ] T168 [US8] Implement "Syncing..." state with item count
- [ ] T169 [US8] Implement "Offline" state with pending changes count
- [ ] T170 [US8] Implement error state with retry button
- [ ] T171 [US8] Add sync status to app header/status bar in src/renderer/src/App.tsx

### Sync Hook for US8

- [ ] T172 [US8] Create useSync hook in src/renderer/src/hooks/use-sync.ts

**Checkpoint**: User Story 8 complete - sync status visible to users

---

## Phase 11: User Story 9 - Sync Activity History (Priority: P2)

**Goal**: Users can view chronological history of sync operations

**Independent Test**: Make changes, view sync history, verify entries match operations

### History Storage for US9

- [ ] T173 [US9] Implement sync history logging in src/main/sync/engine.ts
- [ ] T174 [US9] Implement get history IPC handler in src/main/ipc/sync-handlers.ts

### UI Components for US9

- [ ] T175 [US9] Create sync history panel in src/renderer/src/components/sync/sync-history.tsx
- [ ] T176 [US9] Display timestamp, item count, direction for each entry
- [ ] T177 [US9] Display error details for failed syncs
- [ ] T178 [US9] Add date/type filtering to history view
- [ ] T179 [US9] Add sync history to Settings > Sync page in src/renderer/src/pages/settings/sync-settings.tsx
- [ ] T179a [US9] Bind sync history panel to IPC data source in src/renderer/src/components/sync/sync-history.tsx

**Checkpoint**: User Story 9 complete - sync history visible

---

## Phase 12: User Story 10 - Manual Force Sync (Priority: P2)

**Goal**: Users can manually trigger immediate sync

**Independent Test**: Make changes, click "Sync Now", verify immediate sync

### Manual Sync for US10

- [ ] T180 [US10] Add "Sync Now" button to sync status menu in src/renderer/src/components/sync/sync-status.tsx
- [ ] T181 [US10] Queue manual sync request when sync already in progress (merge with current operation)
- [ ] T182 [US10] Handle manual sync when offline (show message)
- [ ] T182a [US10] Wire "Sync Now" button to trigger-sync IPC in src/renderer/src/components/sync/sync-status.tsx

**Checkpoint**: User Story 10 complete - users can force manual sync

---

## Phase 13: User Story 11 - Local-Only Content (Priority: P2)

**Goal**: Users can mark notes as "local-only" to exclude from sync

**Independent Test**: Mark note as local-only, verify it doesn't appear on other devices

### Local-Only for US11

- [ ] T183 [US11] Add localOnly column to notes cache schema in src/shared/db/schema/index-schema.ts
- [ ] T184 [US11] Add local-only property to note frontmatter in src/main/vault/frontmatter.ts
- [ ] T185 [US11] Filter local-only items from sync queue in src/main/sync/queue.ts
- [ ] T186 [US11] Implement set local-only IPC handler in src/main/ipc/notes-handlers.ts

### UI Components for US11

- [ ] T187 [US11] Add "Local Only" toggle to note settings in src/renderer/src/components/note/info-section/
- [ ] T188 [US11] Show local-only indicator on note in notes tree
- [ ] T189 [US11] Show local-only count in sync status
- [ ] T189a [US11] Wire local-only toggle to IPC + update note state in src/renderer/src/components/note/info-section/

**Checkpoint**: User Story 11 complete - notes can be marked local-only

---

## Phase 14: User Story 12 - Non-Blocking Background Sync (Priority: P2)

**Goal**: Sync operations run in background without blocking UI

**Independent Test**: Start large sync, verify editing remains smooth

### Background Sync for US12

- [ ] T190 [US12] Implement worker thread for sync operations in src/main/sync/worker.ts
- [ ] T191 [US12] Implement batched sync to avoid blocking main thread
- [ ] T192 [US12] Implement concurrent edit handling with incoming sync updates
- [ ] T193 [US12] Ensure CRDT merges don't disrupt cursor position in editor (write integration test to verify)

### Initial Sync Progress for US12

- [ ] T194 [US12] Implement initial sync progress events in src/main/sync/engine.ts
- [ ] T195 [US12] Create initial sync progress UI in src/renderer/src/components/sync/initial-sync-progress.tsx

**Checkpoint**: User Story 12 complete - sync runs in background

---

## Phase 15: User Story 13 - Device Management (Priority: P2)

**Goal**: Users can view and manage linked devices

**Independent Test**: View device list, remove a device, verify it can't access account

### Device Management for US13

- [ ] T196 [US13] Implement get devices IPC handler in src/main/ipc/sync-handlers.ts
- [ ] T197 [US13] Implement remove device IPC handler in src/main/ipc/sync-handlers.ts
- [ ] T198 [US13] Implement rename device IPC handler in src/main/ipc/sync-handlers.ts

### Server Device Endpoints for US13

- [ ] T199 [US13] Implement devices list endpoint in sync-server/src/routes/devices.ts
- [ ] T200 [US13] Implement device removal endpoint in sync-server/src/routes/devices.ts
- [ ] T201 [US13] Implement device update endpoint in sync-server/src/routes/devices.ts
- [ ] T202 [US13] Revoke sync access on device removal in sync-server/src/services/device.ts

### UI Components for US13

- [ ] T203 [US13] Create device list component in src/renderer/src/components/sync/device-list.tsx
- [ ] T204 [US13] Display device name, type, platform, last sync time
- [ ] T205 [US13] Add remove device confirmation dialog
- [ ] T206 [US13] Add rename device dialog
- [ ] T207 [US13] Highlight current device in list
- [ ] T208 [US13] Add devices section to Settings > Sync page
- [ ] T208a [US13] Bind device list/rename/remove UI to IPC handlers in src/renderer/src/components/sync/device-list.tsx

**Checkpoint**: User Story 13 complete - users can manage devices

---

## Phase 16: User Story 14 - Key Rotation (Priority: P3)

**Goal**: Security-conscious users can rotate encryption keys

**Independent Test**: Initiate key rotation, verify new recovery phrase, all data accessible

### Key Rotation for US14

- [ ] T209 [US14] Implement key rotation initiation IPC handler in src/main/ipc/crypto-handlers.ts
- [ ] T210 [US14] Implement file key re-encryption (not content) in src/main/crypto/rotation.ts
- [ ] T210a [US14] Track crypto_version in sync_items during key rotation in src/main/crypto/rotation.ts
- [ ] T210b [US14] Implement sync pause during key rotation window in src/main/sync/engine.ts
- [ ] T211 [US14] Implement rotation progress tracking in src/main/crypto/rotation.ts
- [ ] T212 [US14] Implement get rotation progress IPC handler in src/main/ipc/crypto-handlers.ts
- [ ] T212a [US14] Rewrap attachment keys and CRDT snapshot keys during rotation in src/main/crypto/rotation.ts
- [ ] T212b [US14] Add crypto key version metadata to encrypted payloads in src/main/crypto/encryption.ts

### UI Components for US14

- [ ] T213 [US14] Create key rotation wizard in src/renderer/src/components/sync/key-rotation-wizard.tsx
- [ ] T214 [US14] Display rotation progress (items re-encrypted)
- [ ] T215 [US14] Display new recovery phrase on completion

**Checkpoint**: User Story 14 complete - key rotation available

---

## Phase 17: User Story 15 - Note Sharing (Priority: P3) [FUTURE]

**Goal**: Users can share notes with collaborators while maintaining E2EE

**Note**: This is a future feature building on CRDT foundation. Tasks are placeholders.

- [ ] T216 [US15] Design sharing key exchange protocol
- [ ] T217 [US15] Implement per-note sharing keys
- [ ] T218 [US15] Implement invitation system
- [ ] T219 [US15] Implement real-time presence (cursors)

**Checkpoint**: User Story 15 complete - note sharing available

---

## Phase 18: User Story 16-18 - Mobile/Selective Sync (Priority: P3) [FUTURE]

**Goal**: Mobile users can control sync for limited storage and metered connections

**Note**: These are mobile-focused features. Tasks are placeholders for when mobile apps are built.

- [ ] T220 [US16] Design selective sync mode options
- [ ] T221 [US16] Implement on-demand content download
- [ ] T222 [US17] Implement data usage tracking
- [ ] T223 [US18] Implement metered connection detection
- [ ] T224 [US18] Implement WiFi-only sync mode

**Checkpoint**: Mobile sync features complete

---

## Phase 19: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

### Multi-Window Handling

- [ ] T225 [P] Implement single-writer pattern for sync in multi-window scenario in src/main/sync/engine.ts
- [ ] T226 Broadcast sync status to all windows via IPC

### Graceful Shutdown

- [ ] T227 Update graceful shutdown to close sync connections in src/main/index.ts
- [ ] T228 Persist pending sync queue on shutdown

### Error Handling

- [ ] T229 [P] Implement comprehensive error handling for network failures
- [ ] T230 [P] Implement error handling for crypto failures
- [ ] T231 Handle session expiry event and prompt re-authentication

### Tombstone Cleanup

- [ ] T232 Implement tombstone retention policy (90 days) in sync-server/src/services/cleanup.ts
- [ ] T233 Create scheduled cleanup job in sync-server/

### Performance

- [ ] T234 [P] Profile and optimize sync for 10,000+ items (target: <5min initial sync, <100ms per-item)
- [ ] T235 [P] Optimize Yjs document size management (compact docs >1MB to <500KB via snapshot)

### Run Quickstart Validation

- [ ] T236 Validate implementation against quickstart.md test scenarios

### Edge Case Handling

- [ ] T237 Implement app version compatibility check on sync connect in src/main/sync/websocket.ts
- [ ] T238 Implement corrupt data detection and recovery (re-fetch from server) in src/main/sync/engine.ts
- [ ] T239 Handle device removal with unsynced local changes (warn user, offer export) in src/main/sync/engine.ts
- [ ] T240 Implement storage quota exceeded error handling with user notification in src/main/sync/engine.ts
- [ ] T240a Implement server-side storage quota validation before accepting uploads (return 413 when quota exceeded) in sync-server/src/routes/sync.ts and sync-server/src/routes/blob.ts
- [ ] T241 Handle concurrent device linking attempts (reject second, show error) in sync-server/src/routes/auth.ts
- [ ] T242 Implement extended offline mode with sync resumption on reconnect in src/main/sync/engine.ts
- [ ] T243 Handle network disconnect during attachment upload (auto-resume) in src/main/sync/attachments.ts
- [ ] T244 Normalize timestamps to UTC for cross-timezone consistency in src/main/sync/engine.ts

### Crypto Version Handling

- [ ] T245 Implement multi-version crypto decryption for forward compatibility in src/main/crypto/encryption.ts
- [ ] T245a Implement TLS certificate pinning for sync-server domain in src/main/sync/websocket.ts
- [ ] T245b Configure Content-Security-Policy headers for renderer in src/main/index.ts
- [ ] T245c Add ARIA labels and keyboard navigation to all sync UI components
- [ ] T245d Create user-friendly error message strings for all error codes in src/renderer/src/lib/error-messages.ts

---

## Phase 20: Deployment & Operations

**Purpose**: Production deployment and operational readiness

### Infrastructure Setup

- [ ] T246 Create wrangler.toml production configuration with environment bindings
- [ ] T247 Create GitHub Actions workflow for sync-server CI/CD deployment
- [ ] T248 Configure Cloudflare secrets for OAuth credentials and JWT signing key
- [ ] T249 Create D1 production database and run initial schema migrations
- [ ] T250 Create R2 production bucket with 90-day lifecycle rules for tombstones

### Production Configuration

- [ ] T251 Configure custom domain and SSL for sync-server API
- [ ] T252 Set up Cloudflare Analytics and Workers logging
- [ ] T253 Create operational runbook for common issues (auth failures, sync stuck, etc.)

### Monitoring & Health

- [ ] T254 [P] Implement health check endpoint GET /health in sync-server/src/routes/health.ts
- [ ] T255 [P] Add Sentry or similar error tracking integration to sync-server

**Checkpoint**: Production deployment ready

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2 → P3)
- **Polish (Final Phase)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational - No dependencies on other stories
- **User Story 2 (P1)**: Can start after Foundational - Depends on US1 for auth (can parallel with late US1)
- **User Story 3 (P1)**: Depends on US1 (needs existing device) - Can parallel with US2
- **User Story 4 (P2)**: Depends on US1 crypto setup - Can parallel with US2/US3
- **User Story 5 (P1)**: Can start after Foundational - Integrates with US2
- **User Story 6 (P2)**: Depends on US2 sync engine
- **User Story 7 (P2)**: Depends on US2 sync engine
- **User Story 8-13 (P2)**: All depend on US2 sync engine, can run in parallel
- **User Story 14-18 (P3)**: All depend on earlier stories, can run in parallel

### Within Each User Story

- Server endpoints before client IPC handlers
- Core implementation before UI components
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- All Foundational tasks marked [P] can run in parallel (within Phase 2)
- Once Foundational phase completes, P1 user stories can start
- Within each story, tasks marked [P] can run in parallel
- Different P2 stories can be worked on in parallel by different team members

---

## Parallel Example: User Story 1 (First Device Setup)

```bash
# Launch server endpoints in parallel:
Task: "Implement request-otp endpoint in sync-server/src/routes/auth.ts"
Task: "Implement verify-otp endpoint in sync-server/src/routes/auth.ts"
Task: "Implement OTP generation service in sync-server/src/services/otp.ts"
Task: "Implement OTP rate limiting in sync-server/src/middleware/rate-limit.ts"

# Launch UI components in parallel:
Task: "Create email entry form component in src/renderer/src/components/sync/email-entry-form.tsx"
Task: "Create OTP input component in src/renderer/src/components/sync/otp-input.tsx"
Task: "Create OAuth buttons component in src/renderer/src/components/sync/oauth-buttons.tsx"
```

---

## Implementation Strategy

### MVP First (User Stories 1, 2, 5 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1 (First Device Setup)
4. Complete Phase 4: User Story 2 (Cross-Device Sync)
5. Complete Phase 7: User Story 5 (Note CRDT Merge)
6. **STOP and VALIDATE**: Test end-to-end sync flow
7. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy/Demo (account creation works!)
3. Add User Story 2 + 5 → Test independently → Deploy/Demo (sync works!)
4. Add User Story 3 → Test independently → Deploy/Demo (QR linking works!)
5. Add User Stories 6-13 (P2) → Each adds value incrementally
6. Add User Stories 14-18 (P3) → Advanced features

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1 (Auth/Setup)
   - Developer B: User Story 2 (Sync Engine)
   - Developer C: User Story 5 (CRDT)
3. After P1 stories complete:
   - Developer A: User Story 3 + 4 (Device Linking)
   - Developer B: User Story 6 + 7 (Task Sync + Attachments)
   - Developer C: User Story 8-13 (UI Features)

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
- Server and client tasks for same feature can often run in parallel
- Total tasks: ~327 (updated after token refresh architecture decision)

---

## Architecture Decisions & Clarifications

### Sync Protocol: Server Cursor with Vector Clock Authority

The sync protocol uses a server-assigned, monotonic `server_cursor` for change feeds, while **vector clocks remain authoritative for conflict resolution**. Clients request changes using the last seen cursor and advance it as batches are applied.

**Rationale**: A server cursor avoids clock skew and missed updates, while vector clocks still determine causality and merge behavior.

### Signing Keys: Device-Level for Sync Items

Sync item signatures use **device-level** Ed25519 keys, and each item includes `signer_device_id` + signature metadata. The devices table stores the required device public key for verification. User-level derived keys can still exist for other cryptographic needs, but **sync item signing is device-scoped**.

**Key storage**:
- Master key → OS keychain (T061)
- Derived user signing keypair → OS keychain (T060a)
- Device signing keypair → OS keychain (T028a/T061a)
- Device public key → devices table (T015/T050a)

### Token Refresh Ownership

**Decision**: Token refresh is owned by the **main process** (Option 1).

**Rationale**:
- Single-threaded token management eliminates race conditions in multi-window scenarios
- Atomic refresh operations ensure consistent token state
- Consistent token state across all renderer windows
- Renderer simply calls IPC to request refresh, main process handles it atomically

**Implementation**:
- T073: Refresh logic implemented in `src/main/ipc/sync-handlers.ts` (main process)
- T073c: Renderer calls IPC to request refresh via `src/renderer/src/services/auth-service.ts`
- T073a: Main process emits `auth:session-expired` event when refresh fails
- T073b: OAuth tokens stored in keychain by main process

### OTP Codes Table

The `otp_codes` table schema is defined in data-model.md but was missing from the task list. Added as T014a with fields: `email`, `code_hash`, `expires_at`, `attempts`, `used`, `created_at`.
