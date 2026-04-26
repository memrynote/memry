# M4 Phase F - Renderer + Parity

Fresh session prompt. This phase routes the renderer to real M4 Rust commands and
tightens the command parity ledger.

---

## PROMPT START

You are implementing **Phase F of Milestone M4** for Memry's Electron to Tauri
migration. This phase executes plan Tasks 17-18 from
`docs/superpowers/plans/2026-04-26-m4-crypto-keychain-auth.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4`
**Branch:** `m4/crypto-keychain-auth`
**Plan:** `docs/superpowers/plans/2026-04-26-m4-crypto-keychain-auth.md`
**Previous phase:** `prompts/m4/m4-phase-e-command-bindings.md`

Phase E exposed all M4 Rust commands and regenerated bindings. Phase F updates the
renderer real-IPC allowlist, service result shapes, mock lane compatibility, and
command parity classifications.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4
git rev-parse --abbrev-ref HEAD
test -f apps/desktop-tauri/src-tauri/src/commands/auth.rs
test -f apps/desktop-tauri/src/generated/bindings.ts
grep -q 'auth_status' apps/desktop-tauri/src/generated/bindings.ts
grep -q 'crypto_encrypt_item' apps/desktop-tauri/src/generated/bindings.ts
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:test
pnpm --filter @memry/desktop-tauri bindings:check
```

If any fails, STOP. Phase E must be complete first.

### Your Scope

Execute Tasks 17-18 in order:

- **Task 17:** Update renderer real-IPC allowlist and service types.
  - Modify `src/lib/ipc/invoke.ts`.
  - Modify `src/services/auth-service.ts`.
  - Modify `src/services/device-service.ts`.
  - Modify `src/lib/ipc/mocks/auth.ts`.
  - Modify `src/lib/ipc/mocks/sync.ts`.

- **Task 18:** Tighten command parity ledger for M4.
  - Modify `scripts/command-parity-audit.ts`.
  - Graduate M4 deferrals that now have real handlers.
  - Add retired/replacement ledger for old Electron crypto command names.

### Methodology

1. Invoke `superpowers:using-superpowers`.
2. Read plan Tasks 17-18 fully before editing.
3. Prefer generated bindings for service result types.
4. Keep mocks only for the mock lane; do not delete mock-lane compatibility.
5. Run TS tests and parity before committing.
6. Commit once per task:
   - `m4(renderer): route auth crypto commands to rust`
   - `m4(audit): classify auth crypto command parity`

### Critical Gotchas

1. Add all M4 real command names from Phase E to `realCommands`.
2. `sync_auth_logout` result shape is `{ success: boolean; error?: string }`.
3. `sync_devices_get_devices` maps server `createdAt` and local `isCurrentDevice`.
4. If setup result needs `recoveryPhrase?: string[]` for UI compatibility, adapt in the
   service layer, not the command.
5. Mocks stay for Vite/WebKit mock e2e. Update names and return shapes only where they
   drift from real command expectations.
6. Remove or graduate M4 deferrals listed in plan Task 18.
7. Retired commands must fail parity if reintroduced as renderer literal invokes:
   `crypto_encrypt`, `crypto_decrypt`, `crypto_sign`, `crypto_verify`.
8. Do not modify Rust command behavior in Phase F unless a renderer type mismatch proves
   the command contract is wrong. If that happens, report before widening scope.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4

# Real command routing
grep -q "'auth_status'" apps/desktop-tauri/src/lib/ipc/invoke.ts
grep -q "'crypto_encrypt_item'" apps/desktop-tauri/src/lib/ipc/invoke.ts
grep -q "'sync_linking_generate_linking_qr'" apps/desktop-tauri/src/lib/ipc/invoke.ts
grep -q "'secrets_get_provider_key_status'" apps/desktop-tauri/src/lib/ipc/invoke.ts

# Retired command ledger
grep -q 'crypto_encrypt' apps/desktop-tauri/scripts/command-parity-audit.ts
grep -q 'crypto_decrypt' apps/desktop-tauri/scripts/command-parity-audit.ts
grep -q 'crypto_sign' apps/desktop-tauri/scripts/command-parity-audit.ts
grep -q 'crypto_verify' apps/desktop-tauri/scripts/command-parity-audit.ts

# TS and parity
pnpm --filter @memry/desktop-tauri typecheck
pnpm --filter @memry/desktop-tauri test -- src/lib/ipc/mocks/auth.test.ts src/lib/ipc/mocks/sync.test.ts
pnpm --filter @memry/desktop-tauri command:parity

# Carry-over
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/desktop-tauri cargo:test
pnpm --filter @memry/desktop-tauri bindings:check
```

### When Done

Report:

```text
Phase F complete.
Tasks covered: 17, 18
Commits: <count> (<first hash>..<last hash>)
Verification: typecheck, mock tests, command parity, cargo check/test, bindings check
Next: Phase G - prompts/m4/m4-phase-g-acceptance-handoff.md
Blockers: <none | list>
```

## PROMPT END
