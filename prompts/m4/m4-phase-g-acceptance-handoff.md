# M4 Phase G - Acceptance + Handoff

Fresh session prompt. This is the M4 closure phase: final automated gate, manual
Keychain/auth smoke, staging or local auth smoke, final build, and M5 handoff notes.

---

## PROMPT START

You are implementing **Phase G of Milestone M4** for Memry's Electron to Tauri
migration. This phase executes plan Tasks 19-22 from
`docs/superpowers/plans/2026-04-26-m4-crypto-keychain-auth.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4`
**Branch:** `m4/crypto-keychain-auth`
**Plan:** `docs/superpowers/plans/2026-04-26-m4-crypto-keychain-auth.md`
**Previous phase:** `prompts/m4/m4-phase-f-renderer-parity.md`

Phase F routed the renderer to real M4 Rust commands and classified command parity. Phase
G does not add planned feature code. It verifies the full milestone, fixes only
verification issues, records handoff notes, and prepares the branch for PR/ship.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4
git rev-parse --abbrev-ref HEAD
grep -q "'auth_status'" apps/desktop-tauri/src/lib/ipc/invoke.ts
grep -q "'crypto_encrypt_item'" apps/desktop-tauri/src/lib/ipc/invoke.ts
grep -q 'crypto_encrypt' apps/desktop-tauri/scripts/command-parity-audit.ts
pnpm --filter @memry/desktop-tauri bindings:check
pnpm --filter @memry/desktop-tauri command:parity
pnpm --filter @memry/desktop-tauri typecheck
```

If any fails, STOP. Phase F must be complete first.

### Your Scope

Execute Tasks 19-22 in order:

- **Task 19:** Local automated verification.
  - Run the full Rust, bindings, capability, parity, port, typecheck, and test matrix.
  - Commit fixes only if the gate uncovers real issues.

- **Task 20:** Manual Keychain and auth smoke.
  - Run ignored real Keychain smoke.
  - Run local app auth smoke against local sync-server.
  - Run staging auth smoke if staging URL is available.

- **Task 21:** Final M4 acceptance checklist.
  - Verify wrong/correct password behavior, remember-device unlock, Keychain items,
    OTP/device registration, provider keys, linking, command ledger, and final build.

- **Task 22:** M5 handoff notes.
  - Record M5 unblockers in PR body or milestone ledger.
  - Commit docs only if a real handoff doc source changed.

### Methodology

1. Invoke `superpowers:using-superpowers` and `superpowers:verification-before-completion`.
2. Use `superpowers:systematic-debugging` for any failing command whose cause is not
   obvious.
3. Do not add new features in Phase G.
4. Do not edit source code unless a verification failure requires it.
5. If fixes are needed, make the smallest patch, rerun the failing check, then rerun the
   relevant full gate.
6. Use commit message `m4(test): fix auth crypto verification issues` only if fixes were
   needed.
7. Use commit message `m4(docs): record m5 auth handoff` only if docs changed.

### Automated Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4

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

### Manual Smoke

Real Keychain:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4/apps/desktop-tauri/src-tauri
MEMRY_TEST_REAL_KEYCHAIN=1 cargo test --features test-helpers --test keychain_memory_test -- --ignored
```

Local sync-server and Tauri:

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m4
pnpm --filter @memry/sync-server dev
SYNC_SERVER_URL=http://localhost:8787 pnpm --filter @memry/desktop-tauri dev
```

Manual checks:

- wrong password returns invalid password and creates no keychain master-key item.
- correct password unlocks and `auth_status` reports unlocked.
- sign out clears access/refresh tokens.
- provider key set/status/delete shows masked status and never raw key.
- OTP request/submit, device list, device rename/remove, and QR linking work against
  staging or local sync-server.

### Final Checklist

- Wrong password returns `AppError::InvalidPassword`; keychain untouched.
- Correct password caches master key in Keychain and auth state becomes unlocked.
- Restart auto-unlocks only when remember-device is set.
- Keychain Access.app shows items under `com.memry.vault` and `com.memry.device`.
- OTP plus device registration round-trips against staging or local sync-server.
- Argon2id params match Electron canonical values.
- Provider key set/status/delete round-trips without exposing raw key material.
- QR/recovery linking, SAS approval, device rename/remove, account info, sign-out, and
  recovery-key display match renderer expectations.
- Crypto command ledger has zero unclassified Electron crypto/auth/account channels.
- `pnpm --filter @memry/desktop-tauri build` succeeds.

### M5 Handoff Notes

Record these in the PR body or milestone ledger:

- `AuthRuntime` exposes unlocked vault key retrieval for CRDT/note encryption.
- `crypto_encrypt_item` / `crypto_decrypt_item` are available for M6 sync item
  encryption.
- provider key status commands exist for M8 AI provider UI.
- sync auth HTTP client is intentionally narrow; M6 owns retry/push/pull/websocket.
- real Tauri runtime e2e lane still starts in M5.

No Codex, Claude, Cursor, or AI-tool branding in PR text.

### When Done

Report:

```text
Phase G complete.
Tasks covered: 19, 20, 21, 22
Commits: <count> (<first hash>..<last hash>)
Automated verification: <all commands and result>
Manual verification: <local/staging smoke result>
Build: passed
M5 handoff: <recorded | not changed, reason>
Blockers: <none | list>
```

## PROMPT END
