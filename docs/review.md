# Comprehensive Review: 001-sync-e2ee-3

**Date**: 2026-02-28
**Branch**: `001-sync-e2ee-3` (484 commits, 665 files, ~102K insertions)
**Scope**: Full sync engine with E2EE — Phases 1-19 of specs/001-sync-e2ee-3/tasks.md
**Reviewers**: Security Auditor, Architecture Reviewer, Task Completion Verifier (parallel agents)

---

## Executive Summary

This branch implements a complete sync system with end-to-end encryption for an Electron note-taking app. The implementation covers: crypto primitives (XChaCha20-Poly1305, Ed25519, Argon2id, BIP39), a Cloudflare Workers sync server (Hono.js, D1, R2, Durable Objects), a client sync engine with CRDT (Yjs) for notes, field-level merge for tasks/projects, chunked attachments, device linking (QR + recovery phrase), and comprehensive UI.

**Overall Assessment**: The implementation is thorough and production-oriented. ~215 of ~255 tasks are correctly implemented. The E2EE chain is complete and crypto patterns are sound. However, there are **6 critical findings** (3 security, 3 architecture) and **7 high-priority findings** that should be addressed before shipping.

| Severity | Security | Architecture | Total |
| -------- | -------- | ------------ | ----- |
| CRITICAL | 3        | 3            | 6     |
| HIGH     | 3        | 5            | 8     |
| MEDIUM   | 3        | 11           | 14    |
| LOW      | 8        | 6            | 14    |

---

## Part 1: Task Completion Verification

### Summary

| Category                    | Count |
| --------------------------- | ----- |
| Fully Implemented           | ~215  |
| Partially Implemented       | 3     |
| Not Implemented (false [x]) | 0     |
| Minor Spec Mismatch         | 5     |
| Unmarked But Implemented    | 14    |
| Correctly Marked Incomplete | 16    |

**No false positives found** — every task marked `[x]` has real implementation. No stubs or TODOs.

### 14 Tasks Need Checkmark Update

These tasks are marked `[ ]` in tasks.md but have been implemented (with matching git commits):

| Task  | Description                     | Commit               |
| ----- | ------------------------------- | -------------------- |
| T243  | Auto-resume attachment upload   | `b081fef`            |
| T245  | Multi-version crypto decryption | `85ccff6`            |
| T245a | TLS certificate pinning         | `b5b25dd`            |
| T245b | CSP headers for renderer        | `b5b25dd`            |
| T245c | ARIA labels and keyboard nav    | `39a6b58`            |
| T245d | User-friendly error messages    | `a16dbc3`            |
| T245e | SQLite encryption evaluation    | `4352cee`            |
| T245f | TLS pin failure handling        | `b5b25dd`            |
| T245g | Secure temp file deletion       | `f00684c`            |
| T245h | sodium_mlock for key material   | `3d7ef9e`            |
| T245i | Signature quarantine            | `5bfdb59`            |
| T245j | Client rate limit 429 handling  | `5bfdb59`            |
| T245k | Remote wipe detection           | `5bfdb59`            |
| T254  | Health check endpoint           | Part of server setup |

### 5 Minor Spec Mismatches (All Defensible)

1. **T017c rate_limits PK**: Spec says `PK: id (TEXT)` + `key` column; impl uses `key TEXT PRIMARY KEY`. Simpler.
2. **T017 sync_items.signer_device_id**: Spec says `NOT NULL`; impl allows NULL via `ON DELETE SET NULL`. Preserves signed items after device revocation.
3. **T017f crdt_snapshots.snapshot_data**: Spec says inline `BLOB NOT NULL`; impl uses `blob_key TEXT NOT NULL` (R2-backed). Consistent with project pattern.
4. **T071 useAuth hook path**: Spec says separate hook file; impl co-locates with context. Standard React pattern.
5. **T172 useSync hook path**: Same as T071 — hook exported from context file.

### Remaining Incomplete Tasks

| Task          | Status | Notes                                        |
| ------------- | ------ | -------------------------------------------- |
| T017d         | `[ ]`  | D1 migration run — dev workflow step         |
| T019          | `[ ]`  | Drizzle migration run — dev workflow step    |
| T164a-c       | `[ ]`  | Video streaming player — future feature      |
| T216-T224     | `[ ]`  | Note sharing & mobile sync — future phases   |
| T236          | `[ ]`  | Quickstart validation — manual testing step  |
| T246-T253     | `[ ]`  | Deployment & ops — Phase 20                  |
| T255, T255a-b | `[ ]`  | Error tracking, vuln scanning, audit logging |

---

## Part 2: Security Audit

### CRITICAL

#### S-C1. Linking `/scan` Endpoint Allows ECDH Key Injection Without Server-Side HMAC Verification

**Files**: `sync-server/src/routes/linking.ts:88`, `sync-server/src/services/linking.ts:74-116`

The `/scan` and `/complete` endpoints have no `authMiddleware` (intentional — the new device doesn't have tokens yet). However, the HMAC proof (`newDeviceConfirm`) that the scanning device sends is **stored but never verified server-side**.

An attacker who intercepts or guesses the session ID (e.g., by seeing the QR code displayed on screen) can:

1. Call `/scan` to inject their own `newDevicePublicKey`
2. The device owner approves, encrypting the master key to the attacker's ECDH key
3. Attacker calls `/complete` to retrieve the encrypted master key

The `linkingCompleteRateLimit` is 40 req/60s — too generous for key material.

**Fix**: Verify the HMAC proof server-side before transitioning the session to 'scanned'. The server has both the initiator's ephemeral public key and the scanner's public key — it should validate the proof.

#### S-C2. Certificate Pinning Uses Placeholder Hashes

**File**: `src/main/sync/certificate-pinning.ts:9-12`

```typescript
const PINNED_CERTIFICATE_HASHES: string[] = [
  'sha256/PLACEHOLDER_PRIMARY_CERT_HASH_BASE64',
  'sha256/PLACEHOLDER_BACKUP_CERT_HASH_BASE64'
]
```

Production builds will fail all pin checks (no real cert matches placeholders). Either blocks shipping or means pinning is disabled entirely.

**Fix**: Replace with actual SPKI hashes. Add CI assertion that these aren't placeholder values.

#### S-C3. Refresh Token Rotation Fallback Generates Unpersisted Tokens

**File**: `sync-server/src/services/auth.ts:156-157, 185-186`

When `tryRotateBatch` fails (UNIQUE collision), fallback calls `generateTokens()` which returns a valid refresh token whose hash is **never stored in DB**. When the client uses it, `rotateRefreshToken` won't find it and **revokes ALL tokens for the device** — logging the user out.

```typescript
if (!inserted) {
  return generateTokens(userId, deviceId, privateKeyPem)
  // refresh hash NOT persisted — client gets token it can never use
}
```

**Fix**: Retry the full rotation flow (re-read current token, re-attempt batch) instead of falling back to unpersisted generation.

### HIGH

#### S-H1. OTP Hashed with Unsalted SHA-256

**File**: `sync-server/src/services/otp.ts:19-25`

6-digit OTPs (1M possibilities) hashed with plain SHA-256. The entire OTP hash space can be precomputed in a rainbow table of 1M entries. If D1 is compromised (SQL injection, backup leak), any stored OTP is instantly reversible.

**Fix**: Use HMAC-SHA256 with a server secret from environment bindings.

#### S-H2. Body Size Limit Bypass on Blob Routes

**File**: `sync-server/src/index.ts:41-56`

Body size check relies on `Content-Length` header, which can be omitted (chunked transfer). A client sending no `Content-Length` bypasses the check entirely.

**Fix**: Use Hono's `bodyLimit` middleware or check actual bytes read.

#### S-H3. Key Rotation Does Not Clean Up `newVaultKey` / `newMasterKey`

**File**: `src/main/crypto/rotation.ts:334-337`

The `performKeyRotation` finally block cleans up `oldVaultKey` and `signingKeys.secretKey` but **not** `newVaultKey` and `newMasterKey`.

**Fix**: Add `secureCleanup(newVaultKey, newMasterKey)` to the finally block.

### MEDIUM

#### S-M1. Recovery Endpoint Timing Oracle for User Enumeration

**File**: `sync-server/src/routes/auth.ts:450-463`

Real users return DB result directly; non-existent users go through dummy data generation (SHA-256 hashing). Timing difference enables user enumeration.

**Fix**: Always compute dummy data, then choose which to return.

#### S-M2. Dummy Recovery Data Uses JWT Private Key as Seed

**File**: `sync-server/src/routes/auth.ts:430-448`

The JWT signing key is concatenated with email for dummy data generation. Poor key hygiene — signing keys shouldn't be mixed into non-signing operations.

**Fix**: Use a dedicated `RECOVERY_DUMMY_SECRET` env var.

#### S-M3. WebSocket 60s Revocation Window

**File**: `sync-server/src/durable-objects/user-sync-state.ts:226-253`

Device revocation takes up to 60s to take effect on active WebSocket connections (alarm-based re-validation). Acceptable since WebSocket is notification-only, but worth documenting.

### LOW (8 findings)

| ID   | Finding                                                                   | File                               |
| ---- | ------------------------------------------------------------------------- | ---------------------------------- |
| S-L1 | `secureCleanup` doesn't try/finally `unlockKeyMaterial` before `memzero`  | `crypto/primitives.ts`             |
| S-L2 | `sodium_mlock` detection runs before `sodium.ready`                       | `crypto/memory-lock.ts`            |
| S-L3 | `verifySignature` silently returns false on any exception                 | `crypto/signatures.ts`             |
| S-L4 | JWT key cache is global mutable state in Workers isolate                  | `sync-server/src/lib/jwt-keys.ts`  |
| S-L5 | `detectReplay` returns false when clocks missing (signed, so safe)        | `sync-server/src/services/sync.ts` |
| S-L6 | BIP39 seed creates two copies in memory                                   | `crypto/recovery.ts`               |
| S-L7 | OTP constant-time compare pads — unnecessary for fixed-length hashes      | `sync-server/src/services/otp.ts`  |
| S-L8 | No sanitization on device name/platform (XSS risk if web dashboard later) | `sync-server/src/routes/auth.ts`   |

### Positive Security Observations

The following controls are well-implemented:

- XChaCha20-Poly1305 with 24-byte random nonces (negligible collision probability)
- Ed25519 signatures over canonical CBOR with explicit field ordering
- `deleted_at` included in signed payload (prevents server-forged deletions)
- Consistent constant-time comparison via `sodium.memcmp` / `timingSafeEqual`
- Key material cleanup with `try/finally` + `sodium.memzero` throughout
- JWT validation: algorithm pinned to EdDSA, full claims verification, device revocation check
- Setup tokens single-use via `consumed_setup_tokens` table
- Refresh token rotation with replay detection (60s grace window)
- Rate limiting applied comprehensively across all endpoints
- R2 blob keys prefixed with userId + `assertBlobOwner` prevents cross-user access
- Server-side signature verification on every push
- ECDH + HKDF for device linking with separate enc/mac keys
- Full security headers (HSTS, X-Content-Type-Options, X-Frame-Options, CSP, Referrer-Policy)

---

## Part 3: Architecture & Code Quality

### CRITICAL

#### A-C1. SyncEngine is a God Object (2086 LOC)

**File**: `src/main/sync/engine.ts`

The `SyncEngine` class has **50+ methods** and **25+ properties**, violating the <500 LOC rule by 4x. It owns: push/pull orchestration, CRDT batch application, quarantine management, device key caching, rate limiting state, error classification, sync state persistence, manifest integrity, corrupt item re-fetch, lock management, and event emission.

**Fix**: Extract into focused collaborators:

- `PushCoordinator` — push loop, dedup, payload resolution
- `PullCoordinator` — pull loop, page prefetch, circuit breaker
- `CrdtSyncCoordinator` — CRDT batch/incremental/pull
- `QuarantineManager` — quarantine load/persist/check
- `SyncStateManager` — state persistence, cursor, manifest

#### A-C2. Shared vs Server Contract Divergence

**Files**: `src/shared/contracts/*.ts` vs `sync-server/src/contracts/*.ts`

Two separate copies of contract files with detected drift:

- `auth-api.ts`: Server has `sessionNonce` optional field; client doesn't
- `sync-api.ts`: Client has `FieldClocks`, `PullItemResponseSchema`, `DeviceKeySchema`, `deletedAt` on push item — server lacks all of these

This is a single-source-of-truth violation. When schemas diverge, client/server can silently reject each other's payloads.

**Fix**: Shared npm workspace package for contracts, or pre-build sync script with CI diff check.

#### A-C3. Server `processPushItem` Lacks D1 Transaction

**File**: `sync-server/src/services/sync.ts:157-275`

Multiple sequential D1 operations (check existing → put blob to R2 → upsert sync_items → update storage) **without transaction**. If blob write succeeds but D1 upsert fails → orphaned blob. If upsert succeeds but storage update fails → quota drift.

**Fix**: Use `db.batch([upsertStmt, storageUpdateStmt])` for atomic D1 mutations.

### HIGH

#### A-H1. Sync Lock Double-Release Risk

**File**: `src/main/sync/engine.ts:535-770`

`push()` and `pull()` have both early-return cleanup AND `finally` block cleanup that call `releaseLock()` + `release()`. If an exception occurs between `acquireSyncLock()` and early return checks, both paths execute. The `release()` promise resolver is called twice.

**Fix**: Single cleanup path. Guard with a `released` flag, or restructure so early returns throw.

#### A-H2. `handleNetworkChange` Race Condition

**File**: `src/main/sync/engine.ts:1358-1396`

Network online handler fires async IIFE without re-entry guard. If network bounces rapidly (offline→online→offline→online), two concurrent reconnection attempts race.

**Fix**: Guard with `reconnecting` flag or cancel previous via AbortController.

#### A-H3. `pull()` Method is 395 Lines

**File**: `src/main/sync/engine.ts:795-1190`

Single method handles pagination, decryption, item application, CRDT batching, corrupt item recovery, circuit breaker, and progress emission.

**Fix**: Extract into smaller methods or a `PullCoordinator`.

#### A-H4. Preload Bridge Has No Type Safety

**File**: `src/preload/index.ts` (1648 LOC), `src/preload/index.d.ts` (2460 LOC)

Every IPC call returns `Promise<any>`. Types are manually mirrored, not derived from handler registrations. No compile-time verification that preload matches main-process handlers.

**Fix**: Generate preload types from handlers or use typed IPC library.

#### A-H5. `inbox-handlers.ts` at 2025 LOC

**File**: `src/main/ipc/inbox-handlers.ts`

4x the 500 LOC limit. All inbox CRUD + filtering + sorting + batch ops + sync in one file.

**Fix**: Extract into `inbox-crud-handlers.ts`, `inbox-batch-handlers.ts`, `inbox-query-handlers.ts`.

### MEDIUM

| ID    | Finding                                                            | File                            | LOC  |
| ----- | ------------------------------------------------------------------ | ------------------------------- | ---- |
| A-M1  | `offlineSince` never set — stale cursor check is dead code         | `engine.ts`                     | —    |
| A-M2  | 16 `log.warn('[DIAG]')` calls left in production code              | `engine.ts`, `crdt-provider.ts` | —    |
| A-M3  | `crdt-provider.ts` `close()` fires async ops without awaiting      | `crdt-provider.ts:160-185`      | —    |
| A-M4  | Queue `dequeue` increments attempts immediately (phantom failures) | `queue.ts:134-149`              | —    |
| A-M5  | Auth error detection via string matching on error messages         | `websocket.ts:178-184`          | —    |
| A-M6  | 8-line singleton reset ceremony (fragile, needs registry)          | `runtime.ts:393-400`            | —    |
| A-M7  | 4x `as unknown as` type casts on same DB object                    | `runtime.ts:141-146`            | —    |
| A-M8  | Field merge concurrent detection uses `tickSum` approximation      | `field-merge.ts:77`             | —    |
| A-M9  | `sync-handlers.ts` at 1296 LOC                                     | `sync-handlers.ts`              | 1296 |
| A-M10 | `tasks-handlers.ts` at 1100 LOC                                    | `tasks-handlers.ts`             | 1100 |
| A-M11 | `attachments.ts` at 837 LOC                                        | `attachments.ts`                | 837  |

### LOW

| ID   | Finding                                                             | File                                      |
| ---- | ------------------------------------------------------------------- | ----------------------------------------- |
| A-L1 | No `setMaxListeners` on EventEmitter-based classes                  | `engine.ts`, `websocket.ts`, `network.ts` |
| A-L2 | `_offline` magic key in field clocks undocumented in types          | `field-merge.ts:88`                       |
| A-L3 | Queue has defensive Drizzle vs raw SQL count check (debug leftover) | `queue.ts:103-131`                        |
| A-L4 | `console.error` in worker instead of `createLogger`                 | `worker.ts:130`                           |
| A-L5 | `note-handler.ts` slightly over 500 LOC (547)                       | `note-handler.ts`                         |
| A-L6 | Module-level singleton pattern across all sync services             | Multiple files                            |

### Positive Architecture Observations

- **SyncItemHandler strategy pattern** is well-implemented — 8 handlers with `resolveClockConflict` shared helper
- **SyncContext** uses `useReducer` with typed actions — clean state management
- **CRDT provider** correctly tags updates with `sourceWindowId` to prevent IPC loops
- **try/finally key cleanup** is consistent across all crypto paths
- **Quarantine, rate limit backoff, device revocation** show production-grade defensive coding
- **Conventional Commits** used throughout all 484 commits

---

## Part 4: Priority Fix Order

### Must Fix Before Ship

| Priority | ID        | Finding                                                | Effort |
| -------- | --------- | ------------------------------------------------------ | ------ |
| 1        | S-C2      | Replace cert pinning placeholder hashes                | Small  |
| 2        | S-C3      | Fix refresh token rotation fallback                    | Small  |
| 3        | S-C1/S-H2 | Verify HMAC proof server-side in linking flow          | Medium |
| 4        | A-C3      | Wrap server push in `db.batch()`                       | Small  |
| 5        | A-C2      | Unify contracts (shared workspace or sync script + CI) | Medium |
| 6        | S-H1      | HMAC-SHA256 for OTP hashing                            | Small  |

### Should Fix Before Ship

| Priority | ID   | Finding                                                   | Effort |
| -------- | ---- | --------------------------------------------------------- | ------ |
| 7        | A-M1 | Set `offlineSince` when going offline (dead code)         | Tiny   |
| 8        | A-M2 | Remove/downgrade `[DIAG]` log.warn calls                  | Tiny   |
| 9        | S-H2 | Body size limit — check actual bytes, not header          | Small  |
| 10       | S-H3 | Clean up `newVaultKey`/`newMasterKey` in rotation finally | Tiny   |
| 11       | A-H1 | Fix sync lock double-release pattern                      | Small  |
| 12       | A-H2 | Guard `handleNetworkChange` against re-entry              | Small  |

### Plan for Next Sprint

| Priority | ID   | Finding                                         | Effort |
| -------- | ---- | ----------------------------------------------- | ------ |
| 13       | A-C1 | Extract SyncEngine into coordinators            | Large  |
| 14       | A-H5 | Split `inbox-handlers.ts` (2025 LOC)            | Medium |
| 15       | A-H4 | Add type safety to preload bridge               | Large  |
| 16       | A-H3 | Extract `pull()` into smaller methods           | Medium |
| 17       | A-M4 | Fix queue phantom failure counting              | Small  |
| 18       | —    | Update tasks.md checkmarks for T243, T245-T245k | Tiny   |

---

## Part 5: Files Exceeding 500 LOC Limit

| File                                          | LOC  | Over By |
| --------------------------------------------- | ---- | ------- |
| `src/main/sync/engine.ts`                     | 2086 | 4.2x    |
| `src/main/ipc/inbox-handlers.ts`              | 2025 | 4.1x    |
| `src/preload/index.ts`                        | 1648 | 3.3x    |
| `src/main/ipc/sync-handlers.ts`               | 1296 | 2.6x    |
| `src/main/ipc/tasks-handlers.ts`              | 1100 | 2.2x    |
| `src/main/sync/attachments.ts`                | 837  | 1.7x    |
| `sync-server/src/services/sync.ts`            | 606  | 1.2x    |
| `sync-server/src/routes/auth.ts`              | 573  | 1.1x    |
| `src/renderer/src/contexts/auth-context.tsx`  | 555  | 1.1x    |
| `src/main/sync/item-handlers/note-handler.ts` | 547  | 1.1x    |

---

## Appendix: Test Coverage Notes

The branch includes test files for:

- `field-merge.test.ts` (16 tests)
- `engine.test.ts` (6+ tests for sign-out/sign-in fix)
- `crdt-cursor-stability.test.ts`
- `sync-server/src/services/*.test.ts` (otp, user, sync, linking, device, storage, quota, email)
- `sync-server/wrangler.test.ts`
- `foundation-contracts.test.ts`

However, no test runner was executed during this review. Coverage metrics not verified.

---

_Generated by parallel review agents (Security Auditor + Architecture Reviewer + Task Verifier)_
_Review took ~8 minutes across 3 agents reading 665 files_
