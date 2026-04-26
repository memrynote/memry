# M4 Phase B - Keychain + Auth Runtime

Fresh session prompt. This phase lands the Keychain abstraction, `AuthRuntime`, and
local vault key setup/unlock.

---

## PROMPT START

You are implementing **Phase B of Milestone M4** for Memry's Electron to Tauri
migration. This phase executes plan Tasks 6-8 from
`docs/superpowers/plans/2026-04-26-m4-crypto-keychain-auth.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4`
**Branch:** `m4/crypto-keychain-auth`
**Plan:** `docs/superpowers/plans/2026-04-26-m4-crypto-keychain-auth.md`
**Previous phase:** `prompts/m4/m4-phase-a-crypto-foundation.md`

Phase A added crypto primitives, KDF compatibility, signing helpers, deps, and M4
error variants. Phase B adds secret storage and local auth state. It does not add HTTP
auth flows, Tauri commands, renderer wiring, or generated bindings.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4
git rev-parse --abbrev-ref HEAD                  # expect: m4/crypto-keychain-auth
test -f apps/desktop-tauri/src-tauri/src/crypto/primitives.rs
test -f apps/desktop-tauri/src-tauri/src/crypto/kdf.rs
test -f apps/desktop-tauri/src-tauri/src/crypto/sign_verify.rs
grep -q 'Keychain(String)' apps/desktop-tauri/src-tauri/src/error.rs
grep -q 'Auth(String)' apps/desktop-tauri/src-tauri/src/error.rs
cd apps/desktop-tauri/src-tauri
cargo test --features test-helpers --test crypto_primitives_test
cargo test --features test-helpers --test crypto_kdf_test
cargo test --features test-helpers --test crypto_sign_verify_test
cd -
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:test
```

If any fails, STOP. Phase A must be complete first.

### Your Scope

Execute Tasks 6-8 in order:

- **Task 6:** Implement Keychain abstraction with memory test backend.
  - Create `src/keychain/{mod.rs,service.rs,macos.rs,memory.rs}`.
  - Wire `pub mod keychain;` in `src/lib.rs`.
  - Test: `tests/keychain_memory_test.rs`.
  - Add ignored real Keychain smoke guarded by `MEMRY_TEST_REAL_KEYCHAIN=1`.

- **Task 7:** Add `AuthRuntime` to `AppState`.
  - Create `src/auth/{mod.rs,state.rs,types.rs}`.
  - Modify `src/app_state.rs` and `src/lib.rs`.
  - Test: `tests/auth_state_test.rs`.

- **Task 8:** Implement vault key derivation and remember-device unlock.
  - Create `src/auth/vault_keys.rs`.
  - Modify `src/db/settings.rs` only if needed for bool helpers.
  - Test: `tests/auth_vault_keys_test.rs`.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 6-8 fully before editing.
3. Use one RED-GREEN cycle per task.
4. Commit once per task:
   - `m4(keychain): add macos-backed secret store`
   - `m4(auth): add auth runtime state`
   - `m4(auth): add vault key unlock flow`

### Critical Gotchas

1. `KeychainStore` trait is sync and returns cloned bytes. Do not expose references to
   stored secret material.
2. `SERVICE_VAULT` is `com.memry.vault`; `SERVICE_DEVICE` is `com.memry.device`.
3. macOS backend maps not-found to `Ok(None)`, not an error.
4. The real Keychain smoke is ignored by default and must clean up after itself.
5. `AuthRuntime::lock` must zeroize and drop in-memory master/vault keys.
6. Auth errors and state messages must be redacted.
7. Password unlock compares verifier with constant-time equality.
8. Wrong password must not write `SERVICE_VAULT/master-key`.
9. `remember_device = false` leaves state locked after restart.
10. Do not implement OTP, device registration, provider secrets, commands, or renderer
    changes in Phase B.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4

# Files
test -f apps/desktop-tauri/src-tauri/src/keychain/service.rs
test -f apps/desktop-tauri/src-tauri/src/keychain/macos.rs
test -f apps/desktop-tauri/src-tauri/src/keychain/memory.rs
test -f apps/desktop-tauri/src-tauri/src/auth/state.rs
test -f apps/desktop-tauri/src-tauri/src/auth/types.rs
test -f apps/desktop-tauri/src-tauri/src/auth/vault_keys.rs
test -f apps/desktop-tauri/src-tauri/tests/keychain_memory_test.rs
test -f apps/desktop-tauri/src-tauri/tests/auth_state_test.rs
test -f apps/desktop-tauri/src-tauri/tests/auth_vault_keys_test.rs

# Targeted tests
cd apps/desktop-tauri/src-tauri
cargo test --features test-helpers --test keychain_memory_test
cargo test --features test-helpers --test auth_state_test
cargo test --features test-helpers --test auth_vault_keys_test

# Optional manual Keychain smoke
MEMRY_TEST_REAL_KEYCHAIN=1 cargo test --features test-helpers --test keychain_memory_test -- --ignored

# Carry-over
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
pnpm --filter @memry/desktop-tauri cargo:test
```

### When Done

Report:

```text
Phase B complete.
Tasks covered: 6, 7, 8
Commits: <count> (<first hash>..<last hash>)
Verification: keychain_memory_test, auth_state_test, auth_vault_keys_test, cargo check/clippy/test
Real Keychain smoke: <passed | skipped with reason>
Next: Phase C - prompts/m4/m4-phase-c-secrets-redaction-http.md
Blockers: <none | list>
```

## PROMPT END
