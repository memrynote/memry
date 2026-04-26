# M4 Phase C - Secrets + Redaction + HTTP

Fresh session prompt. This phase adds provider-secret storage, PII-safe redaction, and
the narrow sync auth HTTP client.

---

## PROMPT START

You are implementing **Phase C of Milestone M4** for Memry's Electron to Tauri
migration. This phase executes plan Tasks 9-11 from
`docs/superpowers/plans/2026-04-26-m4-crypto-keychain-auth.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4`
**Branch:** `m4/crypto-keychain-auth`
**Plan:** `docs/superpowers/plans/2026-04-26-m4-crypto-keychain-auth.md`
**Previous phase:** `prompts/m4/m4-phase-b-keychain-auth-runtime.md`

Phase B added Keychain storage, auth runtime, and vault key setup/unlock. Phase C adds
provider key status storage, redaction helpers, and a tiny HTTP wrapper for auth/device
routes. It does not implement setup flows, linking flows, Tauri commands, or renderer
wiring.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4
git rev-parse --abbrev-ref HEAD
test -f apps/desktop-tauri/src-tauri/src/keychain/service.rs
test -f apps/desktop-tauri/src-tauri/src/auth/state.rs
test -f apps/desktop-tauri/src-tauri/src/auth/vault_keys.rs
cd apps/desktop-tauri/src-tauri
cargo test --features test-helpers --test keychain_memory_test
cargo test --features test-helpers --test auth_state_test
cargo test --features test-helpers --test auth_vault_keys_test
cd -
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:test
```

If any fails, STOP. Phase B must be complete first.

### Your Scope

Execute Tasks 9-11 in order:

- **Task 9:** Implement provider secret storage internals.
  - Create `src/auth/secrets.rs`.
  - Test: `tests/auth_secrets_test.rs`.
  - Store raw keys only in Keychain, metadata as separate JSON.

- **Task 10:** Add PII-safe redaction helper.
  - Create `src/auth/redaction.rs`.
  - Test: `tests/auth_redaction_test.rs`.
  - Use helpers in M4 error/log paths before emitting fields.

- **Task 11:** Add narrow sync HTTP client.
  - Create `src/sync/{mod.rs,http.rs,auth_client.rs}`.
  - Wire `pub mod sync;` in `src/lib.rs`.
  - Test: `tests/sync_auth_client_test.rs`.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:test-driven-development`.
2. Read plan Tasks 9-11 fully before editing.
3. Use one RED-GREEN cycle per task.
4. Commit once per task:
   - `m4(secrets): add provider key status storage`
   - `m4(security): add pii redaction helpers`
   - `m4(sync): add auth http client`

### Critical Gotchas

1. Provider allowlist is exactly `openai`, `anthropic`, `openrouter`, `google`.
2. Raw provider keys never appear in returned status structs, debug strings, DB rows, logs,
   or generated bindings.
3. Provider metadata account key is `provider-key-meta:<provider>`.
4. Redaction must cover email, provider keys, bearer tokens, URL query params, and note
   titles per tests.
5. `SYNC_SERVER_URL` is resolved per call, not at module import/init time.
6. Debug default is `http://localhost:8787`; production requires env/config.
7. 429 maps to `AppError::RateLimited`.
8. Non-2xx maps to `AppError::Network` with redacted body.
9. No retry engine in M4. M6 owns retry orchestration.
10. HTTP route wrappers are only auth/devices/linking/token refresh paths from the plan.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4

# Files
test -f apps/desktop-tauri/src-tauri/src/auth/secrets.rs
test -f apps/desktop-tauri/src-tauri/src/auth/redaction.rs
test -f apps/desktop-tauri/src-tauri/src/sync/http.rs
test -f apps/desktop-tauri/src-tauri/src/sync/auth_client.rs
test -f apps/desktop-tauri/src-tauri/tests/auth_secrets_test.rs
test -f apps/desktop-tauri/src-tauri/tests/auth_redaction_test.rs
test -f apps/desktop-tauri/src-tauri/tests/sync_auth_client_test.rs

# Targeted tests
cd apps/desktop-tauri/src-tauri
cargo test --features test-helpers --test auth_secrets_test
cargo test --features test-helpers --test auth_redaction_test
cargo test --features test-helpers --test sync_auth_client_test

# Carry-over
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:clippy
pnpm --filter @memry/desktop-tauri cargo:test
```

### When Done

Report:

```text
Phase C complete.
Tasks covered: 9, 10, 11
Commits: <count> (<first hash>..<last hash>)
Verification: auth_secrets_test, auth_redaction_test, sync_auth_client_test, cargo check/clippy/test
Next: Phase D - prompts/m4/m4-phase-d-device-account-linking.md
Blockers: <none | list>
```

## PROMPT END
