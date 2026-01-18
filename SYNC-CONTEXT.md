# E2EE Sync Implementation Context

> **Purpose**: Persistent context for Claude sessions. Update after each session.
> **Last Updated**: 2026-01-15
> **Current Phase**: Phase 3 (US1 Complete) → Phase 4 Ready to Start

---

## Quick Status

| Phase | Name                          | Status         | Tasks                                         |
| ----- | ----------------------------- | -------------- | --------------------------------------------- |
| 1     | Setup                         | ✅ Complete    | 13/13                                         |
| 2     | Foundational                  | ✅ Complete    | 28/28                                         |
| 3     | US1 - First Device Setup      | ✅ Complete    | 32/32 (Server: 17/17, Client: 9/9, UI: 14/14) |
| 4     | US2 - Cross-Device Sync       | 🔲 Not Started | 0/30                                          |
| 5     | US3 - QR Device Linking       | 🔲 Not Started | 0/18                                          |
| 6     | US4 - Recovery Phrase Linking | 🔲 Not Started | 0/7                                           |
| 7     | US5 - Note CRDT Merge         | 🔲 Not Started | 0/12                                          |
| 8-19  | US6-18 + Polish               | 🔲 Not Started | 0/132                                         |

**Total Progress**: 81/272 tasks (30%)

---

## Completed Components (DO NOT RE-IMPLEMENT)

### Crypto Module (`src/main/crypto/`) - 100% Complete

All files fully implemented with comprehensive tests:

- `keys.ts` - HKDF, Argon2id, Ed25519 key derivation
- `encryption.ts` - XChaCha20-Poly1305 AEAD, file key wrapping
- `signatures.ts` - Ed25519 over canonical CBOR
- `recovery.ts` - BIP39 24-word phrase generation/validation
- `keychain.ts` - OS keychain via keytar
- `cbor.ts` - Canonical CBOR encoding (RFC 8949)
- `index.ts` - Central exports

**Tests**: 6 test files in `tests/unit/crypto/`

### Vector Clock (`src/main/sync/vector-clock.ts`) - 100% Complete

- create, increment, merge, compare operations
- Serialization/deserialization
- Causality detection (isAncestor, isConcurrent, dominates)

### Shared Contracts (`src/shared/contracts/`) - 100% Complete

- `crypto.ts` - Encryption types, key hierarchy, linking types
- `sync-api.ts` - Sync status, queue items, device types
- `ipc-sync.ts` - All IPC channels and event types

### Database Schema (`src/shared/db/schema/`) - 100% Complete

- `sync.ts` - localDevices, syncQueue, syncState, syncHistory tables
- Migrations generated and applied

### Sync Server Auth (`sync-server/`) - US1 Server Complete

- Hono.js app entry point with error handling
- JWT auth middleware with token creation/verification
- Rate limiting middleware structure
- **Routes** (`src/routes/auth.ts`):
  - Email signup/verification/login
  - Forgot/reset/change password
  - OAuth initiation and callback (Google, Apple, GitHub)
  - Device registration
  - First device setup (kdf_salt, key_verifier)
- **Services**:
  - `user.ts` - User CRUD operations
  - `password.ts` - Argon2id hashing, password validation
  - `auth.ts` - JWT token generation
  - `device.ts` - Device management
  - `email.ts` - Email templates via Resend

---

## Architecture Reference

### Key Derivation Hierarchy

```
BIP39 Recovery Phrase (24 words)
    ↓ Argon2id (64MB, 3 iter) + kdf_salt
Master Key (32 bytes)
    ├─ HKDF "memry-vault-key-v1" → Vault Key (wraps file keys)
    ├─ HKDF "memry-signing-key-v1" → Ed25519 Signing Key
    └─ HKDF "memry-verify-key-v1" → Key Verifier (HMAC)
```

### Sync Protocol

```
Client                          Server
   │                               │
   ├──[Push encrypted items]──────►│
   │◄─────[Ack + conflicts]────────┤
   │                               │
   ├──[Pull since timestamp]──────►│
   │◄─────[Encrypted items]────────┤
   │                               │
   │◄─────[WebSocket events]───────┤ (real-time)
```

### Critical Files Map

```
Implementation:
├── src/main/crypto/          # ✅ Complete
├── src/main/sync/
│   ├── vector-clock.ts       # ✅ Complete
│   ├── api-client.ts         # ✅ HTTP client for sync server
│   └── index.ts              # ✅ Module exports
├── src/main/ipc/
│   ├── crypto-handlers.ts    # ✅ 80% (some TODOs)
│   └── sync-handlers.ts      # ✅ US1 Client complete
├── src/shared/contracts/     # ✅ Complete
└── sync-server/              # ✅ US1 Server complete
    ├── src/routes/auth.ts    # ✅ All auth endpoints
    └── src/services/         # ✅ user, password, auth, device, email

Specs (read-only reference):
└── specs/001-sync-e2ee/
    ├── spec.md               # Full specification
    ├── plan.md               # Implementation plan
    ├── tasks.md              # Task tracking
    ├── data-model.md         # Entity schemas
    └── contracts/            # API contracts (YAML)
```

---

## Current Focus

### Completed: Phase 3 (US1 - First Device Setup)

**User Story 1 is 100% complete!** All 32 tasks done:

#### Server Implementation (T042-T053) ✅

- Email signup/verification/login endpoints
- Forgot/reset/change password endpoints
- OAuth initiation and callback (Google, Apple, GitHub)
- Device registration and first device setup
- Password, User, Auth, Device services

#### Client Implementation (T054-T062) ✅

- API client for sync server
- All IPC handlers for auth flows
- Password validation, OAuth with PKCE
- First device setup with keychain

#### UI Implementation (T063-T073) ✅

- `auth-service.ts` - Renderer API wrapper
- `use-auth.ts` - TanStack Query hooks
- `auth-context.tsx` - AuthProvider context
- `password-strength.tsx` - Strength indicator
- `signup-form.tsx`, `login-form.tsx` - Auth forms
- `oauth-buttons.tsx` - Google/Apple/GitHub OAuth
- `forgot-password-form.tsx`, `reset-password-form.tsx`
- `recovery-phrase-display.tsx`, `recovery-phrase-confirm.tsx`
- `verification-pending.tsx` - Email verification screen
- `change-password-dialog.tsx` - Password change dialog
- `setup-wizard.tsx` - Multi-step setup wizard

### Next: Phase 4 (US2 - Cross-Device Sync)

**Ready to start** - No blocking dependencies

Key tasks:

- T074-T081: Sync Engine Core (queue, WebSocket, retry logic)
- T082-T089: Server Sync Endpoints (push/pull/manifest)
- T090-T093: Durable Objects for WebSocket
- T094-T100: Client IPC and events
- T101-T103: Task sync integration

---

## Session History

### 2026-01-15 - Phase 3 UI Implementation Complete (US1 Done!)

- Implemented all 14 UI tasks for US1 (T063-T073):
  - `auth-service.ts` - Service wrapper for window.api.sync/crypto
  - `use-auth.ts` - TanStack Query hooks for auth operations
  - `auth-context.tsx` - AuthProvider context with full state management
  - `password-strength.tsx` - Visual strength indicator with checks
  - `signup-form.tsx` - Email/password signup with device name
  - `login-form.tsx` - Login form with forgot password link
  - `oauth-buttons.tsx` - Google/Apple/GitHub OAuth buttons
  - `forgot-password-form.tsx` - Password reset request
  - `reset-password-form.tsx` - New password with token
  - `recovery-phrase-display.tsx` - 24-word BIP39 display
  - `recovery-phrase-confirm.tsx` - Random word verification
  - `verification-pending.tsx` - Email verification screen
  - `change-password-dialog.tsx` - Password change dialog
  - `setup-wizard.tsx` - Multi-step first device setup wizard
- Created barrel export in `components/sync/index.ts`
- All typechecks pass for new code
- **User Story 1 is now 100% complete!**
- Progress: 67 → 81 tasks complete (25% → 30%)

### 2026-01-15 - Phase 3 Client Implementation Complete

- Created `src/main/sync/api-client.ts` - HTTP wrapper for sync server
- Implemented all 9 client IPC handlers in `sync-handlers.ts`:
  - Email signup/login/verify handlers
  - Password forgot/reset/change handlers
  - OAuth start/callback with PKCE support
  - First device setup (key derivation + keychain)
- Added password validation helper function
- Fixed TypeScript errors (SyncStatus import, unused variables)
- All typechecks pass for new code
- Progress: 58 → 67 tasks complete (21% → 25%)

### 2026-01-15 - Phase 3 Server Implementation Complete

- Implemented all 17 server tasks for US1 (T042-T053)
- Created services: user.ts, password.ts, auth.ts, device.ts
- Created auth routes with 12+ endpoints
- Installed argon2-wasm-edge for Cloudflare Workers compatibility
- All typechecks pass
- Progress: 41 → 58 tasks complete (15% → 21%)

### 2026-01-15 - Context Document Created

- Explored full spec and implementation state
- Created SYNC-CONTEXT.md for persistent context
- Verified: Phase 1 & 2 complete (41 tasks)
- Next: Begin Phase 3 (User Story 1)

<!-- Add new sessions above this line -->

---

## Quick Commands

```bash
# Check task status
cat specs/001-sync-e2ee/tasks.md | grep -E "^\- \[.\]"

# Run crypto tests
pnpm test tests/unit/crypto/

# Start sync server dev
cd sync-server && pnpm dev

# Type check all
pnpm typecheck
```

---

## Don't Forget

- **Signatures**: Always use canonical CBOR (RFC 8949 Section 4.2)
- **Nonces**: Never reuse - generate fresh for each encryption
- **Master Key**: Never log, never send over network
- **Error Handling**: Use custom error classes from `sync-server/src/lib/errors.ts`
- **Zod Validation**: All IPC handlers must validate input
- **Tests**: Tests are NOT included by default per tasks.md

---

## Update Protocol

After each session:

1. Update the "Last Updated" date at the top
2. Update task completion counts in Quick Status table
3. Add a new entry to Session History with date and summary
4. Update "Current Focus" if phase changed
