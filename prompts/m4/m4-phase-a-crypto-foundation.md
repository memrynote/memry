# M4 Phase A - Crypto Foundation

Fresh session prompt. This phase lands the M4 crypto base: API subspike, dependencies,
`AppError` extensions, blob encryption, Argon2id/KDF compatibility, and Ed25519 helpers.

---

## PROMPT START

You are implementing **Phase A of Milestone M4** for Memry's Electron to Tauri
migration. This phase executes plan Tasks 1-5 from
`docs/superpowers/plans/2026-04-26-m4-crypto-keychain-auth.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4`
**Branch:** `m4/crypto-keychain-auth`
**Plan:** `docs/superpowers/plans/2026-04-26-m4-crypto-keychain-auth.md`
**Spec:** `docs/superpowers/specs/2026-04-24-electron-to-tauri-full-migration-design.md`
**Prompts README:** `prompts/m4/README.md`

M4 replaces the M1 mock auth/crypto surface with Rust-owned crypto primitives and
local auth plumbing. Phase A only builds crypto primitives and compile-time
dependencies. It does not implement auth state, Keychain storage, commands, or renderer
wiring.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4
git rev-parse --abbrev-ref HEAD                  # expect: m4/crypto-keychain-auth
git log --oneline -10                            # expect M3 vault/watch work on base
test -f apps/desktop-tauri/src-tauri/Cargo.toml
test -f apps/desktop-tauri/src-tauri/src/error.rs
test -f apps/desktop-tauri/src-tauri/src/lib.rs
test -d apps/desktop-tauri/src-tauri/src/vault   # M3 landed
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:test
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri command:parity
pnpm --filter @memry/sync-server test -- routes/auth.test.ts routes/linking.test.ts routes/devices.test.ts
```

If any command fails, STOP and report. Do not start M4 on an unverified M3 base.

### Your Scope

Execute Tasks 1-5 in order:

- **Task 1:** Run the M4 crypto/keychain subspike.
  - Check dryoc one-shot XChaCha20-Poly1305 AEAD availability.
  - Check `security-framework` viability on macOS.
  - Delete scratch probe files.
  - Record fallback decisions in your phase notes, not in source code unless required.

- **Task 2:** Add M4 dependencies and error variants.
  - Modify `apps/desktop-tauri/src-tauri/Cargo.toml`
  - Modify `apps/desktop-tauri/src-tauri/Cargo.lock`
  - Modify `apps/desktop-tauri/src-tauri/src/error.rs`
  - Add `AppError::Keychain`, `AppError::Auth`, `AppError::RateLimited`.
  - Add `From<reqwest::Error>` mapping to `AppError::Network`.

- **Task 3:** Implement encoding, nonce, and primitive crypto wrappers.
  - Create `src/crypto/{mod.rs,encoding.rs,nonces.rs,primitives.rs}`.
  - Wire `pub mod crypto;` in `src/lib.rs`.
  - Test: `tests/crypto_primitives_test.rs`.

- **Task 4:** Implement Argon2id/KDF compatibility.
  - Create `src/crypto/{kdf.rs,vectors.rs}`.
  - Test: `tests/crypto_kdf_test.rs`.

- **Task 5:** Implement Ed25519 sign/verify and device id derivation.
  - Create `src/crypto/sign_verify.rs`.
  - Test: `tests/crypto_sign_verify_test.rs`.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 1-5 fully before editing.
3. Task 1 is a spike. Keep it temporary and clean.
4. Task 2 is deps/error plumbing. Verify with `cargo:check`.
5. Tasks 3-5 are strict RED-GREEN:
   - Write the failing test from the plan.
   - Run the targeted `cargo test --features test-helpers --test <name>` and confirm RED.
   - Implement the minimum module API.
   - Re-run targeted test and confirm GREEN.
   - Run carry-over Rust tests before commit.
6. Commit once per task when source changed.

### Critical Gotchas

1. `dryoc` 0.7.2 may not expose one-shot XChaCha20-Poly1305 AEAD. If missing, use
   `chacha20poly1305::XChaCha20Poly1305` only for blob encrypt/decrypt and keep dryoc
   for Argon2id, KDF, Ed25519, and BLAKE2b.
2. `security-framework` is only validated in Phase A. The Keychain abstraction itself is
   Phase B.
3. Argon2id parameters must match Electron exactly: ops `3`, mem `67108864`, salt `16`,
   parallelism `1`.
4. `derive_master_key` must use `tokio::task::spawn_blocking`.
5. KDF context mapping must match the plan exactly: `memryvlt`, `memrysgn`, `memryvrf`,
   `memrykve`, `memrylnk`, `memrymac`, `memrysas`.
6. `device_id_from_public_key` is 16-byte BLAKE2b generic hash hex, not UUID.
7. Do not implement auth runtime, keychain storage, provider secrets, commands, bindings,
   or renderer changes in Phase A.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4

# Deps and errors
grep -q '^base64' apps/desktop-tauri/src-tauri/Cargo.toml
grep -q '^zeroize' apps/desktop-tauri/src-tauri/Cargo.toml
grep -q '^reqwest' apps/desktop-tauri/src-tauri/Cargo.toml
grep -Eq '^(security-framework|keyring)' apps/desktop-tauri/src-tauri/Cargo.toml
grep -q 'Keychain(String)' apps/desktop-tauri/src-tauri/src/error.rs
grep -q 'Auth(String)' apps/desktop-tauri/src-tauri/src/error.rs
grep -q 'RateLimited' apps/desktop-tauri/src-tauri/src/error.rs

# Files
test -f apps/desktop-tauri/src-tauri/src/crypto/mod.rs
test -f apps/desktop-tauri/src-tauri/src/crypto/primitives.rs
test -f apps/desktop-tauri/src-tauri/src/crypto/kdf.rs
test -f apps/desktop-tauri/src-tauri/src/crypto/sign_verify.rs
test -f apps/desktop-tauri/src-tauri/tests/crypto_primitives_test.rs
test -f apps/desktop-tauri/src-tauri/tests/crypto_kdf_test.rs
test -f apps/desktop-tauri/src-tauri/tests/crypto_sign_verify_test.rs

# Targeted tests
cd apps/desktop-tauri/src-tauri
cargo test --features test-helpers --test crypto_primitives_test
cargo test --features test-helpers --test crypto_kdf_test
cargo test --features test-helpers --test crypto_sign_verify_test

# Carry-over
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
pnpm --filter @memry/desktop-tauri cargo:test
```

### When Done

Report:

```text
Phase A complete.
Tasks covered: 1, 2, 3, 4, 5
Commits: <count> (<first hash>..<last hash>)
Verification: crypto_primitives_test, crypto_kdf_test, crypto_sign_verify_test, cargo check/clippy/test
Next: Phase B - prompts/m4/m4-phase-b-keychain-auth-runtime.md
Blockers: <none | list>
```

## PROMPT END
