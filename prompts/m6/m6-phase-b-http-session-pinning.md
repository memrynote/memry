# M6 Phase B - HTTP Client, Token Session + Cert Pinning

Fresh session prompt. This phase builds the authenticated Rust HTTP layer that all
later sync, CRDT, and blob work uses.

---

## PROMPT START

You are implementing **Phase B of Milestone M6**. This phase executes Chunk 2 from
`docs/superpowers/plans/2026-04-27-m6-sync-engine.md`.

### Context

**Worktree:** `/Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6`
**Branch:** `m6/sync-engine`
**Plan:** `docs/superpowers/plans/2026-04-27-m6-sync-engine.md`
**Previous phase:** `prompts/m6/m6-phase-a-contract-ledger.md`

Phase B implements `SyncSession`, `SyncHttpClient`, and certificate pinning. It does
not implement queue, handlers, engine loops, commands, or renderer routing.

### Prerequisite Verification

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6
git status --short --branch
test -f apps/desktop-tauri/src-tauri/src/sync/http.rs
test -f apps/desktop-tauri/src-tauri/src/sync/mod.rs
pnpm --filter @memry/desktop-tauri cargo:check
pnpm --filter @memry/sync-server test -- src/routes/sync.test.ts src/routes/blob.test.ts src/services/crdt.test.ts
```

If Phase A left `command:parity` failing because M6 commands do not exist yet, record
that and continue. If any other command fails, STOP and report.

### Your Scope

Execute Chunk 2 in order:

- **Step 1:** Write `sync_http_contract_test.rs` against `httpmock`.
- **Step 2:** Write `sync_pinning_test.rs`.
- **Step 3:** Implement `SyncSession`.
- **Step 4:** Implement `SyncHttpClient`.
- **Step 5:** Implement and document the cert pinning spike result.
- **Step 6:** Run focused Rust tests and clippy.

### Required Reads

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `apps/desktop-tauri/src-tauri/src/sync/http.rs`
- `apps/desktop-tauri/src-tauri/src/auth/*`
- `apps/desktop-tauri/src-tauri/src/crypto/*`
- `apps/desktop-tauri/src-tauri/src/error.rs`
- `apps/desktop-tauri/src-tauri/Cargo.toml`
- `packages/contracts/src/sync-api.ts`
- `apps/sync-server/src/routes/sync.ts`
- `apps/sync-server/src/routes/auth.ts` if refresh route behavior is unclear

### Methodology

1. Invoke `superpowers:using-superpowers`, `superpowers:test-driven-development`, and
   `superpowers:verification-before-completion`.
2. Add tests first and confirm RED:
   - GET `/sync/records/status` includes bearer token and parses status.
   - 401 refreshes once through `/auth/refresh`, stores new access/refresh tokens,
     and retries the original request.
   - N concurrent 401s trigger exactly one refresh round trip.
   - refresh failure clears tokens, emits `auth-session-expired`, and enters sticky
     fail-fast mode until re-authentication.
   - 429 returns `RateLimited(retry_after)`.
   - non-2xx errors never log response body bytes.
   - `SYNC_SERVER_URL` remains per-call configurable for tests.
   - matching SPKI hash accepts, mismatched hash returns `certificate_pin_failed`,
     and pin failure is not retryable.
3. Implement `SyncSession` around M4 keychain entries: `KEYCHAIN_ACCESS_TOKEN` and
   `KEYCHAIN_REFRESH_TOKEN` under `SERVICE_VAULT`.
4. Coalesce concurrent refresh with a `tokio::sync::Mutex<RefreshState>` or equivalent
   single-flight mechanism.
5. Implement `SyncHttpClient` methods only: `get_json`, `post_json`, `put_bytes`,
   `get_bytes`, `delete`, and test-only `*_with_base` variants.
6. Keep `SYNC_SERVER_URL` lazy/per-call for tests. Do not capture it at module import.
7. If reqwest/rustls needs feature changes for pinning, make the smallest Cargo change
   and record the choice for the PR ledger.
8. Never log token bytes, encrypted payload bodies, or raw error response bodies.

### Acceptance Criteria

```bash
cd /Users/h4yfans/sideproject/memry-worktrees/spike-tauri-m6

pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_http_contract_test
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_pinning_test
pnpm --filter @memry/desktop-tauri cargo:test -- --test sync_http_contract_test --test sync_pinning_test
pnpm --filter @memry/desktop-tauri cargo:clippy -- -D warnings
```

Expected: PASS.

### When Done

Report:

```text
Phase B complete.
Plan chunk: 2
Commits: <count> (<first hash>..<last hash>)
Cert pinning choice: <implementation/dependency note>
Verification: sync_http_contract_test + sync_pinning_test + clippy
Next: Phase C - prompts/m6/m6-phase-c-queue-retry-state-history.md
Blockers: <none | list>
```

## PROMPT END
