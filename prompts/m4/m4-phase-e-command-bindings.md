# M4 Phase E - Commands + Bindings

Fresh session prompt. This phase exposes the Rust auth/crypto/device/linking surface as
Tauri commands and regenerates Specta TypeScript bindings.

---

## PROMPT START

You are implementing **Phase E of Milestone M4** for Memry's Electron to Tauri
migration. This phase executes plan Tasks 15-16 from
`docs/superpowers/plans/2026-04-26-m4-crypto-keychain-auth.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4`
**Branch:** `m4/crypto-keychain-auth`
**Plan:** `docs/superpowers/plans/2026-04-26-m4-crypto-keychain-auth.md`
**Previous phase:** `prompts/m4/m4-phase-d-device-account-linking.md`

Phase D implemented the auth/device/linking internals. Phase E creates the command
modules, registers the command surface, and regenerates generated bindings. Renderer
real-IPC routing is Phase F.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4
git rev-parse --abbrev-ref HEAD
test -f apps/desktop-tauri/src-tauri/src/auth/device.rs
test -f apps/desktop-tauri/src-tauri/src/auth/account.rs
test -f apps/desktop-tauri/src-tauri/src/auth/linking.rs
cd apps/desktop-tauri/src-tauri
cargo test --features test-helpers --test auth_device_test
cargo test --features test-helpers --test commands_auth_test
cd -
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:test
```

If any fails, STOP. Phase D must be complete first.

### Your Scope

Execute Tasks 15-16 in order:

- **Task 15:** Add Tauri command modules.
  - Create `src/commands/{auth.rs,account.rs,crypto.rs,devices.rs,linking.rs,secrets.rs}`.
  - Modify `src/commands/mod.rs` and `src/lib.rs`.
  - Test command-level behavior in `tests/commands_auth_test.rs`.
  - Register all M4 commands in `generate_handler![]`.

- **Task 16:** Generate bindings and register Specta types.
  - Modify `src/bin/generate_bindings.rs`.
  - Regenerate `apps/desktop-tauri/src/generated/bindings.ts`.

### Required Command Surface

Register the command names from plan Task 15, including:

```text
auth_status
auth_unlock
auth_lock
auth_register_device
auth_request_otp
auth_submit_otp
auth_enable_biometric
sync_auth_request_otp
sync_auth_verify_otp
sync_auth_resend_otp
sync_auth_init_o_auth
sync_auth_refresh_token
sync_auth_logout
sync_setup_setup_first_device
sync_setup_setup_new_account
sync_setup_confirm_recovery_phrase
sync_setup_get_recovery_phrase
account_get_info
account_sign_out
account_get_recovery_key
sync_devices_get_devices
sync_devices_remove_device
sync_devices_rename_device
sync_linking_generate_linking_qr
sync_linking_link_via_qr
sync_linking_complete_linking_qr
sync_linking_link_via_recovery
sync_linking_approve_linking
sync_linking_get_linking_sas
crypto_encrypt_item
crypto_decrypt_item
crypto_verify_signature
crypto_rotate_keys
crypto_get_rotation_progress
secrets_set_provider_key
secrets_get_provider_key_status
secrets_delete_provider_key
```

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 15-16 fully before editing.
3. Task 15: command tests first, then command wrappers, then register command surface.
4. Task 16: update generator, run generate, run check.
5. Commit once per task:
   - `m4(commands): expose auth crypto device commands`
   - `m4(bindings): generate auth crypto command types`

### Critical Gotchas

1. Every command has both `#[tauri::command]` and `#[specta::specta]`.
2. Use a single input struct per command except zero-arg commands.
3. Commands return `Result<T, AppError>` and redact any IPC-crossing error.
4. `auth_enable_biometric` remains a stub returning `{ ok: false, reason:
   "not-implemented-post-v1" }`.
5. Generated bindings must not expose raw provider keys, tokens, master keys, vault keys,
   recovery phrase internals, or device secret keys.
6. `generate_handler![]`, `collect_commands![]`, and renderer command names must stay in
   sync. Phase F routes renderer calls, but Phase E should make bindings complete.
7. If M3 commands are missing from bindings on this branch, add them before M4 commands.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4

# Files
test -f apps/desktop-tauri/src-tauri/src/commands/auth.rs
test -f apps/desktop-tauri/src-tauri/src/commands/account.rs
test -f apps/desktop-tauri/src-tauri/src/commands/crypto.rs
test -f apps/desktop-tauri/src-tauri/src/commands/devices.rs
test -f apps/desktop-tauri/src-tauri/src/commands/linking.rs
test -f apps/desktop-tauri/src-tauri/src/commands/secrets.rs

# Command names in Rust and bindings
grep -q 'auth_status' apps/desktop-tauri/src-tauri/src/lib.rs
grep -q 'crypto_encrypt_item' apps/desktop-tauri/src-tauri/src/lib.rs
grep -q 'sync_linking_generate_linking_qr' apps/desktop-tauri/src-tauri/src/lib.rs
grep -q 'secrets_get_provider_key_status' apps/desktop-tauri/src/generated/bindings.ts

# Targeted and full Rust
cd apps/desktop-tauri/src-tauri
cargo test --features test-helpers --test commands_auth_test
cd -
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:test

# Bindings
pnpm --filter @memry/desktop-tauri bindings:generate
pnpm --filter @memry/desktop-tauri bindings:check
```

### When Done

Report:

```text
Phase E complete.
Tasks covered: 15, 16
Commits: <count> (<first hash>..<last hash>)
Verification: commands_auth_test, cargo check/test, bindings generate/check
Next: Phase F - prompts/m4/m4-phase-f-renderer-parity.md
Blockers: <none | list>
```

## PROMPT END
