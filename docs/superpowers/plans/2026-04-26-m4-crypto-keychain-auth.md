# M4 - Crypto + Keychain + Auth Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development if subagents are available, or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the M1 mock auth/crypto/account/device-linking surface with real Rust-owned crypto primitives, macOS Keychain storage, local auth state, provider-secret status commands, and sync-server auth/device/linking commands needed before M5 notes and M6 sync.

**Architecture:** Rust owns secret material and auth state. `crypto/` exposes small, tested primitive wrappers; `auth/` owns in-memory unlock state, key derivation, keychain-backed tokens, and account/device flows; `sync/http.rs` provides a narrow JSON HTTP client for auth/linking only, not the full M6 sync engine. Renderer changes stay limited to command-name parity, generated bindings, and the real-IPC allowlist.

**Tech Stack:** Tauri 2, Rust 1.95, dryoc 0.7.x, security-framework on macOS with `keyring-rs` fallback if the pre-flight spike fails, zeroize, base64, reqwest, rusqlite, specta/tauri-specta, Vitest, cargo tests.

**Parent spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md` section "M4 - Crypto + Keychain + Auth"

**Predecessor plan:** `docs/superpowers/plans/2026-04-26-m3-vault-fs-and-watcher.md` must be merged before M4 starts.

---

## Pre-flight Checks

- [ ] M3 branch merged or rebased: `git log --oneline -10` shows the M3 vault/watch work.
- [ ] Current branch is not a random worktree name. If needed: `git branch -m m4-crypto-keychain-auth`.
- [ ] Baseline green:

```bash
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:test
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri command:parity
```

Expected: all exit 0. If M3 left generated bindings out of date, fix that first in a separate M3 cleanup commit before starting M4.

- [ ] Confirm sync-server can run locally for auth smoke:

```bash
pnpm --filter @memry/sync-server test -- routes/auth.test.ts routes/linking.test.ts routes/devices.test.ts
```

Expected: route tests pass. M4 client tests can rely on these route contracts.

---

## M4 Decisions And Assumptions

- Use `SYNC_SERVER_URL`, matching Electron. In debug builds default to `http://localhost:8787`; production requires the env/config value.
- Keychain service identifiers from the spec:
  - `com.memry.vault`: master key, key verifier metadata, access/refresh/setup tokens, provider API keys, recovery phrase.
  - `com.memry.device`: device signing secret key and device identity.
- Provider key commands never return raw provider keys. Status returns `{ configured, provider, label?, last4?, updatedAt? }`.
- Current repo observation: pinned `dryoc` 0.7.2 has Argon2id, Ed25519, generic hash, kdf, and secretstream, but local registry search did not show a one-shot `crypto_aead_xchacha20poly1305_ietf_*` API. Task 1 must validate this. If dryoc still lacks one-shot AEAD, use RustCrypto `chacha20poly1305::XChaCha20Poly1305` only for `encrypt_blob` / `decrypt_blob`, and keep dryoc for Argon2id, Ed25519, BLAKE2b generichash, and kdf compatibility.
- Tauri command names are snake_case. Electron channels map as:
  - `crypto:encrypt-item` -> `crypto_encrypt_item`
  - `crypto:decrypt-item` -> `crypto_decrypt_item`
  - `crypto:verify-signature` -> `crypto_verify_signature`
  - `crypto:rotate-keys` -> `crypto_rotate_keys`
  - `auth:request-otp` -> `sync_auth_request_otp`
  - `sync:generate-linking-qr` -> `sync_linking_generate_linking_qr`
- Do not implement full sync push/pull in M4. Only auth, devices, linking, and token refresh HTTP paths land here.
- Biometric unlock remains a stub: `auth_enable_biometric` returns `{ ok: false, reason: "not-implemented-post-v1" }`.

---

## File Structure

Files created or modified in M4:

```text
apps/desktop-tauri/
|-- src-tauri/
|   |-- Cargo.toml
|   |-- Cargo.lock
|   |-- src/
|   |   |-- app_state.rs
|   |   |-- error.rs
|   |   |-- lib.rs
|   |   |-- bin/generate_bindings.rs
|   |   |-- crypto/
|   |   |   |-- mod.rs
|   |   |   |-- encoding.rs
|   |   |   |-- nonces.rs
|   |   |   |-- primitives.rs
|   |   |   |-- sign_verify.rs
|   |   |   |-- kdf.rs
|   |   |   `-- vectors.rs
|   |   |-- keychain/
|   |   |   |-- mod.rs
|   |   |   |-- service.rs
|   |   |   |-- macos.rs
|   |   |   `-- memory.rs
|   |   |-- auth/
|   |   |   |-- mod.rs
|   |   |   |-- state.rs
|   |   |   |-- vault_keys.rs
|   |   |   |-- device.rs
|   |   |   |-- account.rs
|   |   |   |-- linking.rs
|   |   |   |-- secrets.rs
|   |   |   |-- redaction.rs
|   |   |   `-- types.rs
|   |   |-- sync/
|   |   |   |-- mod.rs
|   |   |   |-- http.rs
|   |   |   `-- auth_client.rs
|   |   |-- db/
|   |   |   |-- mod.rs
|   |   |   |-- settings.rs
|   |   |   `-- sync_devices.rs
|   |   `-- commands/
|   |       |-- mod.rs
|   |       |-- auth.rs
|   |       |-- account.rs
|   |       |-- crypto.rs
|   |       |-- devices.rs
|   |       |-- linking.rs
|   |       `-- secrets.rs
|   `-- tests/
|       |-- crypto_primitives_test.rs
|       |-- crypto_kdf_test.rs
|       |-- crypto_sign_verify_test.rs
|       |-- keychain_memory_test.rs
|       |-- auth_state_test.rs
|       |-- auth_vault_keys_test.rs
|       |-- auth_device_test.rs
|       |-- auth_secrets_test.rs
|       |-- auth_redaction_test.rs
|       |-- sync_auth_client_test.rs
|       `-- commands_auth_test.rs
|-- src/
|   |-- generated/bindings.ts
|   |-- lib/ipc/invoke.ts
|   |-- lib/ipc/mocks/auth.ts
|   |-- lib/ipc/mocks/sync.ts
|   |-- services/auth-service.ts
|   `-- services/device-service.ts
`-- scripts/
    `-- command-parity-audit.ts
```

---

## Chunk 1: Crypto And Keychain Foundation

### Task 1: Run the M4 crypto/keychain subspike

**Files:**
- Temporary only: `apps/desktop-tauri/src-tauri/src/bin/m4_crypto_probe.rs` if needed
- Modify later only after the decision: `apps/desktop-tauri/src-tauri/Cargo.toml`

- [ ] **Step 1.1: Validate dryoc one-shot AEAD coverage**

Run:

```bash
rg -n "aead|xchacha20poly1305|crypto_aead" ~/.cargo/registry/src -g '*.rs' | rg '/dryoc-0\.7'
```

Expected: if no one-shot AEAD API appears, record fallback in this plan execution notes and use `chacha20poly1305` for M4 `encrypt_blob` / `decrypt_blob`.

- [ ] **Step 1.2: Validate security-framework API on this macOS**

Add a throwaway probe or use a tiny cargo snippet to set/get/delete item:

```bash
cd apps/desktop-tauri/src-tauri
cargo search security-framework --limit 1
```

Expected: crate resolves. If direct API is blocked for more than 2 focused hours, switch to `keyring` crate per spec trip-wire.

- [ ] **Step 1.3: Delete throwaway probe**

Run:

```bash
git status --short
```

Expected: no scratch file remains unless it is promoted into Task 3+.

- [ ] **Step 1.4: Commit**

No commit if no source files changed. If Cargo deps were briefly added and reverted, ensure `git status --short` is clean.

### Task 2: Add M4 dependencies and error variants

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/Cargo.toml`
- Modify: `apps/desktop-tauri/src-tauri/Cargo.lock`
- Modify: `apps/desktop-tauri/src-tauri/src/error.rs`

- [ ] **Step 2.1: Add dependencies**

Edit `Cargo.toml`:

```toml
# Crypto + auth + keychain (M4)
base64 = "0.22"
hex = "0.4"
zeroize = { version = "1.8", features = ["derive"] }
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
security-framework = "3"

# Add only if Task 1 confirms dryoc lacks one-shot XChaCha20-Poly1305 AEAD.
chacha20poly1305 = { version = "0.10", features = ["std"] }
```

Under the existing `[dev-dependencies]` table, add:

```toml
httpmock = "0.7"
```

If `security-framework` fails the subspike, replace it with:

```toml
keyring = { version = "3", features = ["apple-native"] }
```

- [ ] **Step 2.2: Extend `AppError`**

Add variants after existing crypto/auth variants:

```rust
#[error("keychain error: {0}")]
Keychain(String),
#[error("auth error: {0}")]
Auth(String),
#[error("rate limited: retry after {0:?} seconds")]
RateLimited(Option<u64>),
```

Add `From<reqwest::Error>` mapping to `AppError::Network`.

- [ ] **Step 2.3: Verify deps**

Run:

```bash
pnpm --filter @memry/desktop-tauri cargo:check
```

Expected: compile succeeds.

- [ ] **Step 2.4: Commit**

```bash
git add apps/desktop-tauri/src-tauri/Cargo.toml apps/desktop-tauri/src-tauri/Cargo.lock apps/desktop-tauri/src-tauri/src/error.rs
git commit -m "m4(deps): add crypto keychain auth dependencies"
```

### Task 3: Implement encoding, nonce, and primitive crypto wrappers

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/crypto/mod.rs`
- Create: `apps/desktop-tauri/src-tauri/src/crypto/encoding.rs`
- Create: `apps/desktop-tauri/src-tauri/src/crypto/nonces.rs`
- Create: `apps/desktop-tauri/src-tauri/src/crypto/primitives.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/crypto_primitives_test.rs`

- [ ] **Step 3.1: Write failing primitive tests**

Cover:
- `generate_nonce()` returns 24 bytes and differs across calls.
- `encrypt_blob` returns ciphertext plus 24-byte nonce.
- `decrypt_blob` round-trips plaintext with associated data.
- wrong associated data returns `AppError::Crypto`.
- wrong key length returns `AppError::Crypto`.
- known JS/libsodium fixture from `apps/desktop/src/main/crypto/encryption.test.ts` decrypts correctly if a fixture exists.

Run:

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test crypto_primitives_test
```

Expected: fail because `crate::crypto` does not exist.

- [ ] **Step 3.2: Add module API**

Target API:

```rust
pub const KEY_LENGTH: usize = 32;
pub const NONCE_LENGTH: usize = 24;
pub const TAG_LENGTH: usize = 16;

pub struct EncryptedBlob {
    pub ciphertext: Vec<u8>,
    pub nonce: [u8; NONCE_LENGTH],
}

pub fn generate_nonce() -> [u8; NONCE_LENGTH];
pub fn encrypt_blob(
    plaintext: &[u8],
    key: &[u8],
    associated_data: Option<&[u8]>,
) -> AppResult<EncryptedBlob>;
pub fn decrypt_blob(
    ciphertext: &[u8],
    nonce: &[u8],
    key: &[u8],
    associated_data: Option<&[u8]>,
) -> AppResult<Vec<u8>>;
```

- [ ] **Step 3.3: Implement minimal wrappers**

Use dryoc if Task 1 found one-shot AEAD. Otherwise use `chacha20poly1305::{XChaCha20Poly1305, XNonce}` for this file only.

- [ ] **Step 3.4: Verify**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test crypto_primitives_test
```

Expected: all tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/crypto apps/desktop-tauri/src-tauri/src/lib.rs apps/desktop-tauri/src-tauri/tests/crypto_primitives_test.rs
git commit -m "m4(crypto): add nonce and xchacha blob primitives"
```

### Task 4: Implement Argon2id/kdf compatibility

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/crypto/kdf.rs`
- Create: `apps/desktop-tauri/src-tauri/src/crypto/vectors.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/crypto_kdf_test.rs`

- [ ] **Step 4.1: Write failing kdf tests**

Cover:
- Argon2id output length 32.
- params match Electron: `opsLimit = 3`, `memLimit = 67108864`, `saltLength = 16`, `parallelism = 1`.
- `derive_key(master, "memry-vault-key-v1", 32)` matches Electron `crypto_kdf_derive_from_key` context mapping `memryvlt`, id `1`.
- unknown context errors.
- `generate_key_verifier(master)` derives context `memrykve`, id `4`, and base64 encodes 32 bytes.

Run:

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test crypto_kdf_test
```

Expected: fail.

- [ ] **Step 4.2: Implement constants and mappings**

Use this mapping from Electron `apps/desktop/src/main/crypto/keys.ts`:

```rust
pub const ARGON2_OPS_LIMIT: u64 = 3;
pub const ARGON2_MEM_LIMIT: usize = 67_108_864;
pub const ARGON2_SALT_LENGTH: usize = 16;

pub const KDF_CONTEXTS: &[(&str, u64, &str)] = &[
    ("memry-vault-key-v1", 1, "memryvlt"),
    ("memry-signing-key-v1", 2, "memrysgn"),
    ("memry-verify-key-v1", 3, "memryvrf"),
    ("memry-key-verifier-v1", 4, "memrykve"),
    ("memry-linking-enc-v1", 5, "memrylnk"),
    ("memry-linking-mac-v1", 6, "memrymac"),
    ("memry-linking-sas-v1", 7, "memrysas"),
];
```

- [ ] **Step 4.3: Keep Argon2 off async runtime**

Expose async helper:

```rust
pub async fn derive_master_key(seed: Vec<u8>, salt: [u8; 16]) -> AppResult<MasterKeyMaterial>;
```

Implementation must call `tokio::task::spawn_blocking`.

- [ ] **Step 4.4: Verify**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test crypto_kdf_test
pnpm --filter @memry/desktop-tauri cargo:clippy
```

Expected: tests and clippy pass.

- [ ] **Step 4.5: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/crypto apps/desktop-tauri/src-tauri/tests/crypto_kdf_test.rs
git commit -m "m4(crypto): add argon2id and kdf compatibility"
```

### Task 5: Implement Ed25519 sign/verify and device id derivation

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/crypto/sign_verify.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/crypto_sign_verify_test.rs`

- [ ] **Step 5.1: Write failing sign/verify tests**

Cover:
- generated keypair has public key 32 bytes and secret key 64 bytes.
- detached signature is 64 bytes.
- verify succeeds for original message.
- verify fails for tampered message or wrong public key.
- deterministic seed vector from `apps/desktop/src/main/crypto/__fixtures__/ed25519-rfc8032.ts` if fixture is usable.
- `device_id_from_public_key` is 16-byte BLAKE2b generic hash hex, matching Electron `crypto_generichash(16, publicKey, null)`.

- [ ] **Step 5.2: Implement wrappers**

Use dryoc classic APIs:

```rust
dryoc::classic::crypto_sign::{
    crypto_sign_keypair,
    crypto_sign_detached,
    crypto_sign_verify_detached,
};
dryoc::classic::crypto_generichash::crypto_generichash;
```

- [ ] **Step 5.3: Verify**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test crypto_sign_verify_test
```

Expected: pass.

- [ ] **Step 5.4: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/crypto/sign_verify.rs apps/desktop-tauri/src-tauri/tests/crypto_sign_verify_test.rs
git commit -m "m4(crypto): add ed25519 signing helpers"
```

### Task 6: Implement keychain abstraction with memory test backend

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/keychain/mod.rs`
- Create: `apps/desktop-tauri/src-tauri/src/keychain/service.rs`
- Create: `apps/desktop-tauri/src-tauri/src/keychain/macos.rs`
- Create: `apps/desktop-tauri/src-tauri/src/keychain/memory.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/keychain_memory_test.rs`

- [ ] **Step 6.1: Write failing tests against memory backend**

Cover:
- set/get/delete round-trip.
- overwriting an item updates bytes.
- deleted item returns `None`.
- service/account are required.
- stored bytes are cloned, not exposed by reference.

- [ ] **Step 6.2: Define trait and service constants**

```rust
pub const SERVICE_VAULT: &str = "com.memry.vault";
pub const SERVICE_DEVICE: &str = "com.memry.device";

pub trait KeychainStore: Send + Sync {
    fn set_item(&self, service: &str, account: &str, value: &[u8]) -> AppResult<()>;
    fn get_item(&self, service: &str, account: &str) -> AppResult<Option<Vec<u8>>>;
    fn delete_item(&self, service: &str, account: &str) -> AppResult<()>;
}
```

- [ ] **Step 6.3: Implement macOS backend**

`macos.rs` uses `security-framework` APIs for generic password items. It must delete before set if update semantics are awkward. It must map "not found" to `Ok(None)`, not an error.

- [ ] **Step 6.4: Add ignored real keychain smoke**

In the same test file, add:

```rust
#[test]
#[ignore = "writes to macOS Keychain; run with MEMRY_TEST_REAL_KEYCHAIN=1"]
fn real_keychain_round_trip() { ... }
```

Run manually during M4:

```bash
cd apps/desktop-tauri/src-tauri && MEMRY_TEST_REAL_KEYCHAIN=1 cargo test --features test-helpers --test keychain_memory_test -- --ignored
```

Expected: item appears under `com.memry.vault` in Keychain Access.app during the test and is deleted after.

- [ ] **Step 6.5: Verify**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test keychain_memory_test
```

Expected: non-ignored tests pass.

- [ ] **Step 6.6: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/keychain apps/desktop-tauri/src-tauri/src/lib.rs apps/desktop-tauri/src-tauri/tests/keychain_memory_test.rs
git commit -m "m4(keychain): add macos-backed secret store"
```

---

## Chunk 2: Auth Runtime And Local Secrets

### Task 7: Add `AuthRuntime` to `AppState`

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/auth/mod.rs`
- Create: `apps/desktop-tauri/src-tauri/src/auth/state.rs`
- Create: `apps/desktop-tauri/src-tauri/src/auth/types.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/app_state.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/auth_state_test.rs`

- [ ] **Step 7.1: Write failing state tests**

Cover:
- default state is `Locked`.
- `begin_unlock` transitions to `Unlocking`.
- `finish_unlock` stores current device/account metadata and transitions to `Unlocked`.
- `lock` zeroizes and drops in-memory master/vault keys.
- `fail_unlock` transitions to `Error` with redacted message.

- [ ] **Step 7.2: Implement types**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum AuthStateKind {
    Locked,
    Unlocking,
    Unlocked,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub state: AuthStateKind,
    pub device_id: Option<String>,
    pub email: Option<String>,
    pub has_biometric: bool,
    pub remember_device: bool,
}
```

Use `zeroize::Zeroizing<Vec<u8>>` for in-memory master/vault keys.

- [ ] **Step 7.3: Wire state**

`AppState` becomes:

```rust
pub struct AppState {
    pub db: Db,
    pub vault: Arc<VaultRuntime>,
    pub auth: Arc<AuthRuntime>,
}
```

`init_app_state()` builds real macOS keychain in production and memory keychain under `#[cfg(test)]` helpers.

- [ ] **Step 7.4: Verify**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test auth_state_test
```

Expected: pass.

- [ ] **Step 7.5: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/auth apps/desktop-tauri/src-tauri/src/app_state.rs apps/desktop-tauri/src-tauri/src/lib.rs apps/desktop-tauri/src-tauri/tests/auth_state_test.rs
git commit -m "m4(auth): add auth runtime state"
```

### Task 8: Implement vault key derivation and remember-device unlock

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/auth/vault_keys.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/db/settings.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/auth_vault_keys_test.rs`

- [ ] **Step 8.1: Write failing tests**

Cover:
- first setup stores `auth.kdfSalt`, `auth.keyVerifier`, and `auth.rememberDevice`.
- wrong password returns `AppError::InvalidPassword`.
- wrong password does not write keychain master key.
- correct password writes `SERVICE_VAULT/master-key`.
- remember-device true allows boot-time unlock from keychain.
- remember-device false leaves state locked after restart.

- [ ] **Step 8.2: Add settings helpers**

Add helpers to `db/settings.rs` only if needed:

```rust
pub fn get_bool(db: &Db, key: &str) -> AppResult<bool>;
pub fn set_bool(db: &Db, key: &str, value: bool) -> AppResult<()>;
```

- [ ] **Step 8.3: Implement vault key manager**

Public API:

```rust
pub async fn setup_local_vault_key(
    state: &AppState,
    password: String,
    remember_device: bool,
) -> AppResult<()>;

pub async fn unlock_with_password(
    state: &AppState,
    password: String,
    remember_device: bool,
) -> AppResult<AuthStatus>;

pub fn try_unlock_from_keychain(state: &AppState) -> AppResult<Option<AuthStatus>>;
```

Use `spawn_blocking` for Argon2id. Compare key verifier using constant-time equality.

- [ ] **Step 8.4: Verify**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test auth_vault_keys_test
```

Expected: pass.

- [ ] **Step 8.5: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/auth/vault_keys.rs apps/desktop-tauri/src-tauri/src/db/settings.rs apps/desktop-tauri/src-tauri/tests/auth_vault_keys_test.rs
git commit -m "m4(auth): add vault key unlock flow"
```

### Task 9: Implement provider secret storage commands internals

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/auth/secrets.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/auth_secrets_test.rs`

- [ ] **Step 9.1: Write failing tests**

Cover:
- set provider key stores in keychain under `SERVICE_VAULT`, account `provider-key:<provider>`.
- status returns configured true plus masked metadata only.
- delete removes key and metadata.
- raw key never appears in returned status debug string.
- provider names are allowlisted: `openai`, `anthropic`, `openrouter`, `google`.

- [ ] **Step 9.2: Implement internals**

Status type:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKeyStatus {
    pub provider: String,
    pub configured: bool,
    pub label: Option<String>,
    pub last4: Option<String>,
    pub updated_at: Option<String>,
}
```

Store metadata separately as `provider-key-meta:<provider>` JSON. Never store raw key in DB.

- [ ] **Step 9.3: Verify**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test auth_secrets_test
```

Expected: pass.

- [ ] **Step 9.4: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/auth/secrets.rs apps/desktop-tauri/src-tauri/tests/auth_secrets_test.rs
git commit -m "m4(secrets): add provider key status storage"
```

### Task 10: Add PII-safe redaction helper

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/auth/redaction.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/auth_redaction_test.rs`

- [ ] **Step 10.1: Write failing tests**

Cover:
- email redacts to `k***@domain`.
- provider keys redact to `<redacted:provider-key>`.
- bearer tokens redact to `<redacted:token>`.
- URLs redact query params.
- note titles redact to `<redacted:title>`.

- [ ] **Step 10.2: Implement helper**

API:

```rust
pub fn redact_email(input: &str) -> String;
pub fn redact_url(input: &str) -> String;
pub fn redact_secret(input: &str) -> &'static str;
pub fn sanitize_log_field(kind: RedactionKind, value: &str) -> String;
```

Use this in M4 command error/log paths before emitting tracing fields.

- [ ] **Step 10.3: Verify**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test auth_redaction_test
```

Expected: pass.

- [ ] **Step 10.4: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/auth/redaction.rs apps/desktop-tauri/src-tauri/tests/auth_redaction_test.rs
git commit -m "m4(security): add pii redaction helpers"
```

---

## Chunk 3: Sync Auth, Device, And Linking Backend

### Task 11: Add narrow sync HTTP client

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/sync/mod.rs`
- Create: `apps/desktop-tauri/src-tauri/src/sync/http.rs`
- Create: `apps/desktop-tauri/src-tauri/src/sync/auth_client.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/sync_auth_client_test.rs`

- [ ] **Step 11.1: Write failing HTTP client tests**

Use `httpmock` to cover:
- `post_json` sends JSON and bearer token.
- 429 maps to `AppError::RateLimited`.
- non-2xx maps to `AppError::Network` with redacted body.
- `SYNC_SERVER_URL` is resolved per call, not module import time.
- debug default is `http://localhost:8787`.

- [ ] **Step 11.2: Implement client**

Keep API tiny:

```rust
pub async fn post_json<TReq, TResp>(path: &str, body: &TReq, token: Option<&str>) -> AppResult<TResp>
where
    TReq: Serialize + ?Sized,
    TResp: DeserializeOwned;

pub async fn get_json<TResp>(path: &str, token: Option<&str>) -> AppResult<TResp>
where
    TResp: DeserializeOwned;
```

No retry engine in M4. M6 owns retry orchestration.

- [ ] **Step 11.3: Implement auth client route wrappers**

Paths:
- `POST /auth/otp/request`
- `POST /auth/otp/verify`
- `POST /auth/otp/resend`
- `GET /auth/oauth/google?redirect_uri=...`
- `POST /auth/oauth/google/callback`
- `POST /auth/devices`
- `GET /auth/recovery-info`
- `POST /auth/refresh`
- `GET /devices`
- `DELETE /devices/:id`
- `PATCH /devices/:id`
- `POST /auth/linking/initiate`
- `POST /auth/linking/scan`
- `GET /auth/linking/session/:sessionId`
- `POST /auth/linking/approve`
- `POST /auth/linking/complete`

- [ ] **Step 11.4: Verify**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test sync_auth_client_test
```

Expected: pass.

- [ ] **Step 11.5: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/sync apps/desktop-tauri/src-tauri/src/lib.rs apps/desktop-tauri/src-tauri/tests/sync_auth_client_test.rs
git commit -m "m4(sync): add auth http client"
```

### Task 12: Implement device identity and account storage

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/auth/device.rs`
- Create: `apps/desktop-tauri/src-tauri/src/auth/account.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/db/sync_devices.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/auth_device_test.rs`

- [ ] **Step 12.1: Write failing tests**

Cover:
- get-or-create signing key creates keychain item under `SERVICE_DEVICE/device-signing-key`.
- existing signing key is reused.
- device id derives from public key.
- account email/user id persist in settings keys.
- current device row upserts into `sync_devices`.
- sign-out deletes access/refresh/setup tokens but leaves local vault data.

- [ ] **Step 12.2: Implement device API**

```rust
pub fn get_or_create_device_signing_key(state: &AppState) -> AppResult<DeviceSigningKeyPair>;
pub fn sign_device_challenge(secret_key: &[u8], challenge: &str) -> AppResult<String>;
pub fn upsert_current_device(state: &AppState, device: CurrentDeviceRecord) -> AppResult<()>;
```

- [ ] **Step 12.3: Implement account API**

Settings keys:
- `account.userId`
- `account.email`
- `account.authProvider`
- `account.recoveryConfirmed`

- [ ] **Step 12.4: Verify**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test auth_device_test
```

Expected: pass.

- [ ] **Step 12.5: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/auth/device.rs apps/desktop-tauri/src-tauri/src/auth/account.rs apps/desktop-tauri/src-tauri/src/db/sync_devices.rs apps/desktop-tauri/src-tauri/tests/auth_device_test.rs
git commit -m "m4(auth): add device identity storage"
```

### Task 13: Implement auth, setup, refresh, and sign-out flows

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/auth/account.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/auth/vault_keys.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/commands_auth_test.rs`

- [ ] **Step 13.1: Write failing flow tests with mocked HTTP**

Cover:
- OTP request returns `success: true` and expiry.
- OTP verify stores setup token and returns `needsSetup`.
- setup new account derives local master key/recovery phrase, registers device, stores access/refresh tokens, upserts current device, and returns recovery phrase.
- refresh token rotates tokens.
- logout clears auth tokens and transitions local auth to locked.
- account recovery key returns current recovery phrase only when unlocked.

- [ ] **Step 13.2: Implement recovery phrase generation**

Minimum M4 implementation:
- Generate 32 random bytes.
- Encode as a recovery string with stable base64url or existing Electron phrase format if reusable.
- Store encrypted or keychain-backed under `SERVICE_VAULT/recovery-phrase`.
- Return phrase only during setup and `account_get_recovery_key`.

Do not invent a polished mnemonic system in M4 unless Electron already has one ready to port.

- [ ] **Step 13.3: Implement setup flow**

`sync_setup_setup_new_account`:
1. Require setup token from OTP/OAuth.
2. Create local master key material.
3. Store verifier metadata.
4. Create or load device signing keypair.
5. Register device through `/auth/devices`.
6. Store access/refresh tokens in keychain.
7. Set auth state unlocked.

- [ ] **Step 13.4: Verify**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test commands_auth_test
```

Expected: pass.

- [ ] **Step 13.5: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/auth apps/desktop-tauri/src-tauri/tests/commands_auth_test.rs
git commit -m "m4(auth): implement otp setup and refresh flows"
```

### Task 14: Implement linking crypto and device commands

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/auth/linking.rs`
- Test: extend `apps/desktop-tauri/src-tauri/tests/auth_device_test.rs`

- [ ] **Step 14.1: Write failing linking tests**

Cover:
- generate linking QR calls `/auth/linking/initiate` with ephemeral public key.
- QR payload contains `sessionId`, `linkingSecret`, and initiator ephemeral public key.
- link via QR validates payload and calls `/auth/linking/scan`.
- approve linking encrypts master key for new device and calls `/auth/linking/approve`.
- complete linking decrypts master key, stores it, and emits final device id.
- SAS code is six digits and stable for the shared secret.
- recovery linking returns a device id or clear error.

- [ ] **Step 14.2: Implement minimal linking state**

Store pending linking sessions in memory only:

```rust
Mutex<HashMap<String, PendingLinkingSession>>
```

This is acceptable in M4 because QR sessions are short-lived and server is authoritative.

- [ ] **Step 14.3: Implement X25519/shared-secret helpers**

Use dryoc if available. If dryoc API friction is high, use RustCrypto `x25519-dalek` only for linking and document the deviation in the PR. Keep public/secret key lengths at 32 bytes.

- [ ] **Step 14.4: Verify**

```bash
cd apps/desktop-tauri/src-tauri && cargo test --features test-helpers --test auth_device_test
```

Expected: pass.

- [ ] **Step 14.5: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/auth/linking.rs apps/desktop-tauri/src-tauri/tests/auth_device_test.rs
git commit -m "m4(auth): add device linking flows"
```

---

## Chunk 4: Tauri Commands, Bindings, Renderer Swap

### Task 15: Add Tauri command modules

**Files:**
- Create: `apps/desktop-tauri/src-tauri/src/commands/auth.rs`
- Create: `apps/desktop-tauri/src-tauri/src/commands/account.rs`
- Create: `apps/desktop-tauri/src-tauri/src/commands/crypto.rs`
- Create: `apps/desktop-tauri/src-tauri/src/commands/devices.rs`
- Create: `apps/desktop-tauri/src-tauri/src/commands/linking.rs`
- Create: `apps/desktop-tauri/src-tauri/src/commands/secrets.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/commands/mod.rs`
- Modify: `apps/desktop-tauri/src-tauri/src/lib.rs`
- Test: `apps/desktop-tauri/src-tauri/tests/commands_auth_test.rs`

- [ ] **Step 15.1: Write command-level tests**

Use `AppState` with memory DB/keychain to cover:
- `auth_status`
- `auth_unlock`
- `auth_lock`
- `auth_enable_biometric`
- `secrets_set_provider_key`
- `secrets_get_provider_key_status`
- `secrets_delete_provider_key`
- `account_get_info`
- `account_sign_out`
- `account_get_recovery_key`

- [ ] **Step 15.2: Implement command signatures**

Every command gets both attributes:

```rust
#[tauri::command]
#[specta::specta]
pub async fn auth_status(
    state: tauri::State<'_, AppState>,
) -> Result<AuthStatus, AppError> { ... }
```

Single input struct per command except zero-arg commands.

- [ ] **Step 15.3: Register command surface**

Add to `generate_handler![]`:

```rust
commands::auth::auth_status,
commands::auth::auth_unlock,
commands::auth::auth_lock,
commands::auth::auth_register_device,
commands::auth::auth_request_otp,
commands::auth::auth_submit_otp,
commands::auth::auth_enable_biometric,
commands::auth::sync_auth_request_otp,
commands::auth::sync_auth_verify_otp,
commands::auth::sync_auth_resend_otp,
commands::auth::sync_auth_init_o_auth,
commands::auth::sync_auth_refresh_token,
commands::auth::sync_auth_logout,
commands::auth::sync_setup_setup_first_device,
commands::auth::sync_setup_setup_new_account,
commands::auth::sync_setup_confirm_recovery_phrase,
commands::auth::sync_setup_get_recovery_phrase,
commands::account::account_get_info,
commands::account::account_sign_out,
commands::account::account_get_recovery_key,
commands::devices::sync_devices_get_devices,
commands::devices::sync_devices_remove_device,
commands::devices::sync_devices_rename_device,
commands::linking::sync_linking_generate_linking_qr,
commands::linking::sync_linking_link_via_qr,
commands::linking::sync_linking_complete_linking_qr,
commands::linking::sync_linking_link_via_recovery,
commands::linking::sync_linking_approve_linking,
commands::linking::sync_linking_get_linking_sas,
commands::crypto::crypto_encrypt_item,
commands::crypto::crypto_decrypt_item,
commands::crypto::crypto_verify_signature,
commands::crypto::crypto_rotate_keys,
commands::crypto::crypto_get_rotation_progress,
commands::secrets::secrets_set_provider_key,
commands::secrets::secrets_get_provider_key_status,
commands::secrets::secrets_delete_provider_key,
```

- [ ] **Step 15.4: Verify**

```bash
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:test
```

Expected: pass.

- [ ] **Step 15.5: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/commands apps/desktop-tauri/src-tauri/src/lib.rs apps/desktop-tauri/src-tauri/tests/commands_auth_test.rs
git commit -m "m4(commands): expose auth crypto device commands"
```

### Task 16: Generate bindings and register specta types

**Files:**
- Modify: `apps/desktop-tauri/src-tauri/src/bin/generate_bindings.rs`
- Modify: `apps/desktop-tauri/src/generated/bindings.ts`

- [ ] **Step 16.1: Register all M4 commands and types**

Add all Task 15 commands to `collect_commands![]`.

Register types from:
- `auth::types::*`
- `auth::secrets::ProviderKeyStatus`
- `commands::*` input/result structs
- `crypto` command input/result structs

If M3 commands are missing from bindings in the current branch, add them too before M4 commands. Do not leave real Rust commands unbound.

- [ ] **Step 16.2: Generate**

```bash
pnpm --filter @memry/desktop-tauri bindings:generate
pnpm --filter @memry/desktop-tauri bindings:check
```

Expected: generated file is stable after first generation; check exits 0.

- [ ] **Step 16.3: Commit**

```bash
git add apps/desktop-tauri/src-tauri/src/bin/generate_bindings.rs apps/desktop-tauri/src/generated/bindings.ts
git commit -m "m4(bindings): generate auth crypto command types"
```

### Task 17: Update renderer real-IPC allowlist and service types

**Files:**
- Modify: `apps/desktop-tauri/src/lib/ipc/invoke.ts`
- Modify: `apps/desktop-tauri/src/services/auth-service.ts`
- Modify: `apps/desktop-tauri/src/services/device-service.ts`
- Modify: `apps/desktop-tauri/src/lib/ipc/mocks/auth.ts`
- Modify: `apps/desktop-tauri/src/lib/ipc/mocks/sync.ts`

- [ ] **Step 17.1: Add real command names**

Add all M4 command names from Task 15 to `realCommands`.

- [ ] **Step 17.2: Align service result types**

Use generated bindings where practical. At minimum:
- `sync_auth_logout` result shape is `{ success: boolean; error?: string }`.
- `sync_devices_get_devices` maps server `createdAt` and local `isCurrentDevice`.
- setup result includes `recoveryPhrase?: string[]` only if UI expects array; otherwise adapt in service, not command.

- [ ] **Step 17.3: Keep mocks for mock lane**

Mocks stay for Vite/WebKit mock e2e. Update only names/return shapes that drifted from real commands.

- [ ] **Step 17.4: Verify**

```bash
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri test -- src/lib/ipc/mocks/auth.test.ts src/lib/ipc/mocks/sync.test.ts
```

Expected: pass.

- [ ] **Step 17.5: Commit**

```bash
git add apps/desktop-tauri/src/lib/ipc/invoke.ts apps/desktop-tauri/src/services/auth-service.ts apps/desktop-tauri/src/services/device-service.ts apps/desktop-tauri/src/lib/ipc/mocks/auth.ts apps/desktop-tauri/src/lib/ipc/mocks/sync.ts
git commit -m "m4(renderer): route auth crypto commands to rust"
```

### Task 18: Tighten command parity ledger for M4

**Files:**
- Modify: `apps/desktop-tauri/scripts/command-parity-audit.ts`

- [ ] **Step 18.1: Remove M4 deferrals that now have real handlers**

Remove or graduate:
- `account_get_recovery_key`
- `crypto_rotate_keys`
- `sync_auth_logout`
- `sync_linking_approve_linking`
- `sync_linking_complete_linking_qr`
- `sync_linking_generate_linking_qr`
- `sync_linking_get_linking_sas`
- `sync_linking_link_via_qr`
- `sync_linking_link_via_recovery`
- `sync_setup_get_recovery_phrase`

Add required-real assertions for every M4 command with a renderer callsite.

- [ ] **Step 18.2: Add retired/replacement ledger**

Record Electron crypto/auth/account channels that do not have live renderer snake_case calls:
- `crypto_encrypt` retired in favor of `crypto_encrypt_item`.
- `crypto_decrypt` retired in favor of `crypto_decrypt_item`.
- `crypto_sign` retired in favor of internal Rust signing plus `crypto_verify_signature` where needed.
- `crypto_verify` retired in favor of `crypto_verify_signature`.

The audit should fail if a retired command reappears as a renderer literal invoke.

- [ ] **Step 18.3: Verify**

```bash
pnpm --filter @memry/desktop-tauri command:parity
```

Expected: zero errors. Warnings allowed only for non-M4 domains already deferred to M5+.

- [ ] **Step 18.4: Commit**

```bash
git add apps/desktop-tauri/scripts/command-parity-audit.ts
git commit -m "m4(audit): classify auth crypto command parity"
```

---

## Chunk 5: Acceptance Verification

### Task 19: Local automated verification

**Files:** none expected

- [ ] **Step 19.1: Run Rust suite**

```bash
pnpm --filter @memry/desktop-tauri cargo:fmt
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
pnpm --filter @memry/desktop-tauri cargo:test
```

Expected: all pass.

- [ ] **Step 19.2: Run TS and audits**

```bash
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri command:parity
pnpm --filter @memry/desktop-tauri port:audit
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri test
```

Expected: all pass.

- [ ] **Step 19.3: Commit if fixes were needed**

```bash
git status --short
git add <changed-files>
git commit -m "m4(test): fix auth crypto verification issues"
```

Only commit if Step 19 required fixes.

### Task 20: Manual Keychain and auth smoke

**Files:** none expected

- [ ] **Step 20.1: Run real Keychain smoke**

```bash
cd apps/desktop-tauri/src-tauri
MEMRY_TEST_REAL_KEYCHAIN=1 cargo test --features test-helpers --test keychain_memory_test -- --ignored
```

Expected: pass. Keychain Access.app briefly shows items under `com.memry.vault` and `com.memry.device`; test cleanup removes them.

- [ ] **Step 20.2: Run local app auth smoke**

Start sync-server in another terminal if required:

```bash
pnpm --filter @memry/sync-server dev
```

Start Tauri:

```bash
SYNC_SERVER_URL=http://localhost:8787 pnpm --filter @memry/desktop-tauri dev
```

Manual checks:
- wrong password returns invalid password and creates no keychain master-key item.
- correct password unlocks and `auth_status` reports `Unlocked`.
- sign out clears access/refresh tokens.
- provider key set/status/delete shows masked status and never raw key.

- [ ] **Step 20.3: Staging auth smoke**

With staging URL configured:

```bash
SYNC_SERVER_URL=<staging-url> pnpm --filter @memry/desktop-tauri dev
```

Manual checks:
- OTP request reaches email.
- OTP submit registers or resumes account.
- device list loads.
- device rename/remove works for non-current device.
- QR linking reaches waiting/approval state.

If staging is unavailable, run the same journey against local sync-server and document the gap in the PR.

### Task 21: Final M4 acceptance checklist

- [ ] Wrong password returns `AppError::InvalidPassword`; keychain untouched.
- [ ] Correct password caches master key in keychain and auth state becomes unlocked.
- [ ] Restart auto-unlocks only when remember-device is set.
- [ ] Keychain Access.app shows items under `com.memry.vault` and `com.memry.device`.
- [ ] OTP + device registration round-trip against staging or local sync-server.
- [ ] Argon2id params match Electron canonical values.
- [ ] Provider key set/status/delete round-trips without exposing raw key material.
- [ ] QR/recovery linking, SAS approval, device rename/remove, account info, sign-out, and recovery-key display match renderer expectations.
- [ ] Crypto command ledger has zero unclassified Electron crypto/auth/account channels.
- [ ] `pnpm --filter @memry/desktop-tauri build` succeeds.

Run final build:

```bash
pnpm --filter @memry/desktop-tauri build
```

Expected: unsigned macOS bundle builds.

### Task 22: M5 handoff notes

**Files:**
- Modify if missing: PR body or milestone ledger, not source code

- [ ] Document these M5 unblockers:
  - `AuthRuntime` exposes unlocked vault key retrieval for CRDT/note encryption.
  - `crypto_encrypt_item` / `crypto_decrypt_item` are available for M6 sync item encryption.
  - provider key status commands exist for M8 AI provider UI.
  - sync auth HTTP client is intentionally narrow; M6 owns retry/push/pull/websocket.
  - real Tauri runtime e2e lane still starts in M5.

- [ ] Final commit if docs changed:

```bash
git add <handoff-doc-or-pr-body-source>
git commit -m "m4(docs): record m5 auth handoff"
```

---

## Verification Command Summary

```bash
pnpm --filter @memry/desktop-tauri cargo:fmt
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
pnpm --filter @memry/desktop-tauri cargo:test
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri capability:check
pnpm --filter @memry/desktop-tauri command:parity
pnpm --filter @memry/desktop-tauri port:audit
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri test
pnpm --filter @memry/desktop-tauri build
```

Expected: all pass before M4 is considered complete.

## Implementation Notes

- Keep M4 scoped. Do not build M6 sync orchestration, M8 AI streaming, or M9 deep-link runtime here.
- Prefer command aliases over renderer rewrites when preserving current UI callsites.
- Every returned error crossing IPC must be redacted.
- Raw provider keys, access tokens, refresh tokens, setup tokens, master key, vault key, and device secret key must never appear in generated bindings, logs, returned structs, or DB rows.
- If crypto API availability forces a crate deviation from the spec, write it in the PR and update the migration spec immediately.
