# M6 Phase E - Crypto Batch + Device Keys

Fresh session prompt. This phase builds the sync-side encryption/signature pipeline and
device-key lookup needed before any record push or pull can be trusted.

---

## PROMPT START

You are implementing **Phase E of Milestone M6**. This phase executes Chunk 5 from
`docs/superpowers/plans/2026-04-27-m6-sync-engine.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
**Branch:** `m6/sync-engine`
**Plan:** `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
**Previous phase:** `prompts/m6/m6-phase-d-vector-clocks-field-merge.md`

Phase E uses M4 crypto/auth/device primitives for sync record encryption and signature
verification. It does not implement handlers or engine loops.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
git status --short --branch
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_vector_clock_test --test sync_field_merge_test
pnpm --filter @memry/desktop-tauri cargo:check
```

If any command fails, STOP and report.

### Your Scope

Execute Chunk 5 in order:

- **Step 1:** Write `sync_crypto_batch_test.rs`.
- **Step 2:** Implement current device key lookup.
- **Step 3:** Implement remote device public-key cache.
- **Step 4:** Implement batch encrypt/decrypt.
- **Step 5:** Run focused gate.

### Required Reads

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `apps/desktop-tauri/src-tauri/src/crypto/*`
- `apps/desktop-tauri/src-tauri/src/auth/*`
- `apps/desktop-tauri/src-tauri/src/db/sync_devices.rs`
- `apps/desktop-tauri/src-tauri/src/sync/session.rs`
- `apps/desktop-tauri/src-tauri/src/sync/client.rs`
- `packages/contracts/src/sync-api.ts`
- `docs/superpowers/plans/2026-04-27-m6-sync-engine.md` Chunk 5

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:test-driven-development`, and
   `superpowers:verification-before-completion`.
2. Write tests first and confirm RED:
   - encrypt push item produces encrypted key/data/nonces/signature/signerDeviceId.
   - decrypt verifies signature with signer device public key.
   - unknown signer device quarantines item without applying it.
   - signature failure emits the security-warning path.
   - key bytes are zeroized after use.
3. Read current device row from `sync_devices`.
4. Read signing key from keychain and vault key from `AuthRuntime`.
5. Return owned zeroizing bytes where possible.
6. Resolve remote signer keys from local `sync_devices.signing_public_key`; fallback to
   `GET /devices` through the existing M4 device client if missing.
7. Use existing M4 crypto primitives. Do not introduce a worker thread unless profiling
   proves encryption blocks runtime tests.
8. Never persist plaintext file keys, record keys, vault keys, signing keys, or payload
   plaintext outside the existing encrypted storage model.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6

pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_crypto_batch_test
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

Expected: PASS.

### When Done

Report:

```text
Phase E complete.
Plan chunk: 5
Commits: <count> (<first hash>..<last hash>)
Verification: sync_crypto_batch_test + clippy
Next: Phase F - prompts/m6/m6-phase-f-handler-registry.md
Blockers: <none | list>
```

## PROMPT END
