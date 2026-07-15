# Vault Deletion — Design

**Date:** 2026-07-16
**Branch:** `vault-deletion`
**Status:** Approved, pending implementation plan

## Problem

There is no way to delete a vault. Not in the UI, not over IPC, not on the server.

- `routes/sync.ts` exposes only `GET /vaults` (L66) and `POST /vaults` (L103). There is no `DELETE`.
- The only `DELETE FROM sync_vaults` in the repo is `services/account-deletion.ts:37`, scoped `WHERE user_id = ?` — deleting the entire account is the only way to remove a vault row.
- The `X` in the vault switcher (`vault-switcher.tsx:149`) is local-only: `removeVault()` (`main/vault/index.ts:583`) filters an electron-store array and never calls the server. Its own comment and its dialog copy both say the files stay.

### Why this is worse than a missing feature

**The X is a trap.** Removing a local vault nulls `localPath`, which flips the vault into the "In your account" section (`vault-switcher.tsx:44` filters on `!vault.localPath`). Those rows have no remove affordance at all — only Download. So the X converts a removable local entry into a permanently unremovable cloud one.

**Stale rows consume paid slots.** `ensureSyncVaultAllowed` counts with `SELECT COUNT(*) FROM sync_vaults WHERE user_id = ?` (`entitlements.ts:205`) against `max_vaults`. Because rows are never removable, a Plus user (`max_vaults = 1`) can be permanently at their cap with zero usable vaults and no self-serve remedy.

## Scope

In scope: a real vault delete — server purge + local list removal — reachable from the vault switcher and from Settings → Vault, plus test coverage pinning the entitlement limits.

Out of scope: deleting local files (see D1), cross-device delete propagation (see D3), any change to entitlement production code (see "Entitlements" — it already behaves as specified).

## Decisions

### D1 — Delete never touches local files

Delete means: purge the server copy, and drop the vault from the local known-vaults list. The markdown files on disk are never modified.

**Why:** a Memry vault is an Obsidian-compatible folder the user may also open in other tools. Memry does not own those files. Deleting a folder that exists independently of the app is unrecoverable data loss for a benefit ("tidy account list") that does not require it.

**Consequence:** because nothing irreversible happens to user files, the confirm dialog needs no type-to-confirm friction. A plain two-button `AlertDialog` with explicit copy is enough. The dialog must state, positively, that files on disk are kept, and name the path.

### D2 — The existing X stays; Delete is added alongside

Two distinct, honest actions:

| Action                        | Local list | Server row | Files on disk |
| ----------------------------- | ---------- | ---------- | ------------- |
| Remove from list (existing X) | removed    | kept       | kept          |
| Delete from account (new)     | removed    | **purged** | kept          |

**Why:** "get this vault off this machine without touching my account" is a legitimate case, and forcing it through a server purge would be worse. The X stops being a trap the moment the resulting cloud-only entry is itself deletable.

### D3 — Re-registration is allowed; delete is not a tombstone

`sync/vault-directory.ts:79-95` self-registers every local vault via `POST /sync/vaults` on open. A device that still holds the vault locally will therefore re-register it after another device deletes it, re-pushing its local data.

We accept this. Delete purges server state now; it does not prevent a future re-registration.

**Why:** the target case — cloud-only zombies with no local copy anywhere — is fully solved with zero schema change and zero old-client risk. A tombstone (`sync_vaults.deleted_at` + refusing resurrection in `POST /vaults`) would require an additive migration and a decision about what a released client does when its registration is silently refused; released clients cannot be taught to stop asking. YAGNI until someone actually hits it.

**Known rough edge, accepted and documented:** a Plus user (`max_vaults = 1`) who deletes vault A to make room for vault B can have A resurrected by a second device, putting them back at their limit and failing B's sync with a 402.

### D4 — The active vault cannot be deleted

Matches `devices.ts:50` ("Cannot remove the current device") and the existing X, which only renders when `!isActive` (`vault-switcher.tsx:149`). Enforced in the main-process handler, and reflected in the UI as a disabled row.

### D5 — Settings → Vault lists all account vaults

`pages/settings/vault-section.tsx` is currently scoped to the _current_ vault (Storage Usage L50-114, Location L116-128). Since the active vault cannot be deleted (D4), a Danger Zone there would always be disabled and therefore useless.

Instead, the section gains a group listing **all** account vaults with per-row delete, active row disabled. This is also the surface that matches the user complaint ("I see two in my account that I'm not using").

## Architecture

### Server: `DELETE /sync/vaults/:vaultId`

**Mount order is load-bearing.** Register alongside `GET`/`POST /vaults` (`routes/sync.ts:66,103`), **before** `sync.use('*', paidSyncMiddleware)` (L105).

`ensureSyncVaultAllowed` (`entitlements.ts:187-242`) is an **upsert, not an ownership check** — if `(user_id, vault_id)` is absent it _inserts_. Mounted after the middleware, `DELETE` would have its target silently re-created mid-request, and a bogus `:vaultId` would become a create-then-delete no-op returning 200. The existing vault routes already register before the middleware for this reason.

**Auth + ownership:** `authMiddleware`, then the scoped read used by `listUserVaults` / `getDevice`:

```ts
db.prepare('SELECT vault_id FROM sync_vaults WHERE user_id = ? AND vault_id = ?')
  .bind(userId, vaultId)
  .first()
```

404 if absent — a cross-user delete is indistinguishable from a missing vault, so ownership never leaks. Rate limited like the other vault mutations. Response `{ success: true }`, `AppError` for failures, matching `devices.ts:46-76`.

**New service `services/vault-deletion.ts`**, ordered:

1. **Sum the vault's bytes** — `sync_items.size_bytes` + `crdt_snapshots.size_bytes` + `length(crdt_updates.update_data)` + `blob_chunks.size_bytes`, all `WHERE user_id = ? AND vault_id = ?`. Sum the rows actually being deleted, per `cleanup.ts:168-183` — do **not** use `getStorageBreakdown` (`storage.ts:14-61`), which is per-user only and filters `deleted_at IS NULL`, missing tombstoned rows whose bytes were charged.
2. **Purge R2** under prefix `${userId}/vaults/${vaultId}/`. All four key generators embed vaultId (`blob.ts:3-19`), so the prefix is complete and exact.
3. **One `db.batch`** — explicit deletes from all 7 vault-scoped tables + `sync_vaults`, each `WHERE user_id = ? AND vault_id = ?`; plus `UPDATE devices SET vault_id = NULL WHERE user_id = ? AND vault_id = ?`; plus `adjustStorageUsed(-bytes)`.
4. **Notify the `USER_SYNC_STATE` DO** so connected devices drop the vault, mirroring `devices.ts:66-73`.

**There is no referential integrity to lean on.** `sync_vaults.id` is referenced by nothing; every vault-scoped table carries a loose `vault_id TEXT` and FKs only to `users(id)`. Deleting the `sync_vaults` row cascades nothing. All 8 tables must be deleted explicitly:

| Table                                             | `0001_baseline.sql` |
| ------------------------------------------------- | ------------------- |
| `sync_items`                                      | L165                |
| `device_sync_state`                               | L197                |
| `crdt_updates`                                    | L212                |
| `crdt_snapshots`                                  | L226                |
| `upload_sessions`                                 | L241                |
| `blob_chunks`                                     | L260                |
| `devices` (null the column, don't delete the row) | L67                 |
| `sync_vaults`                                     | L99-108             |

**`server_cursor_sequence` must NOT be touched.** It is per-user and shared across vaults (`idx_sync_user_cursor`); deleting it would corrupt every other vault's cursor.

**R2 before D1, deliberately.** A mid-flight failure then leaves D1 rows pointing at missing blobs — retryable — rather than orphaned R2 objects, which are unrecoverable once their rows are gone. This is the existing `account-deletion.ts` ordering and it is intentional.

**Storage accounting is new work here.** `deleteUserData` gets away with skipping it only because it drops the `users` row. A vault-scoped delete must decrement `users.storage_used` or the user permanently loses quota for data they deleted.

**Refactor:** extract the paginated prefix-delete loop from `account-deletion.ts:12-20` into `blob.ts` as a shared helper (`deleteByPrefix`), and have `deleteUserData` reuse it. Honors `truncated`/`cursor`; `deleteBlob` (`blob.ts:77-80`) is single-key only and insufficient.

### IPC: `vault:delete-from-account`

New channel — **not** a reuse of `vault:remove`, which is registry-only and takes a `vaultPath`. A path structurally cannot address a cloud-only vault, which is precisely the case that matters.

- Keyed on **vaultUuid**.
- Contract in `packages/contracts/src/ipc-channels.ts` + `vault-api.ts`; handler registered in `main/ipc/vault-handlers.ts` (pattern at L107).
- Handler: reject if active (D4) → call the server → on success remove the local list entry if one exists. **Both steps, always** — server-only delete resurrects on next launch (D3).
- Not exposed to the agent MCP allowlist, matching `vault:remove` (`agent-mcp-channels.ts:121-124,276-279`).
- Run `pnpm ipc:generate` then `pnpm ipc:check`.

### Renderer

**`components/vault-switcher.tsx`** — the bare X becomes a `⋯` menu:

```
Local vaults
  ✓ Personal              (active: no menu)
    Work                  [⋯] → Remove from list
                                Delete from account…

In your account
  ☁ Old Vault  412 items  [⋯] → Download…
                                Delete from account…
```

The "In your account" rows (L171-199) have no affordance today beyond Download — this is where the reported problem actually lives.

**`pages/settings/vault-section.tsx`** — new group listing all account vaults with per-row delete (D5). Settings has no registry; the section is already wired (import `settings.tsx:26`, nav L145-151, render guard L182), so no new routing.

**Shared confirm dialog** used by both surfaces. No `ConfirmDialog` exists today; the closest destructive pattern is sign-out (`account-section.tsx:499-538`).

**Two drive-by fixes in code being touched anyway:**

- `vault-switcher.tsx:236` emits a literal `&` in the confirm title (`{vaultToRemove?.name}&{tPhaseF(...)}`).
- The switcher's dialog uses raw `<Button>`s where `account-section.tsx:517` uses `AlertDialogCancel`/`AlertDialogAction`. Align to the latter.

### Entitlements — no production change

The limits already behave exactly as specified (`entitlements.ts:44-69`): free `0`, plus `1`, pro `10`, believer `null` (unlimited), enforced in `ensureSyncVaultAllowed` with a race-safe conditional insert (L234-243) throwing `SYNC_VAULT_LIMIT_EXCEEDED` / HTTP 402.

Nothing to build. The limits only _feel_ broken because the count runs over rows that can never be removed. **Deletion is the limits fix.** This work adds tests pinning the behavior, not code.

## Testing

**Server unit (`vault-deletion.ts`):**

- all 8 tables purged for the target vault
- another vault's rows in every one of those tables survive
- another user's rows survive; cross-user delete returns 404
- R2 prefix cleared, including the `truncated`/`cursor` pagination path
- `users.storage_used` decremented by the summed bytes; never below 0
- `server_cursor_sequence` survives (regression — deleting it corrupts other vaults)
- R2 delete is attempted before the D1 batch

**Server route:**

- 404 for unknown and for another user's vault
- **mount-order regression: DELETE must not resurrect the vault via `ensureSyncVaultAllowed`** — the highest-value test here; it fails loudly if someone moves the route below `paidSyncMiddleware`
- rate limiting; `{ success: true }`

**Entitlements (pinning existing behavior):**

- free=0 / plus=1 / pro=10 / believer=unlimited
- Pro at 10 → 11th registration 402s → delete one → 11th succeeds (proves delete frees the slot)

**Renderer:** `vault-switcher.test.tsx` and `vault-section.test.tsx` are both net-new (only an omnibus case at `cold-major-components.test.tsx:764` exists today). Mock per `download-vault-dialog.test.tsx` — identity i18n, spread `window.api.vault`. Add `deleteFromAccount` to the global mock in `tests/setup-dom.ts:97-108`. Cover: menu on local and remote rows, active vault has no delete, confirm cancels cleanly, IPC called with the vaultUuid, list refreshes.

**E2E** (`tests/e2e/`, real `TestSyncServer` with real D1 — `utils/sync-backend.ts`), two scenarios:

1. **Cloud-only vault** — sign in, delete a vault with no local copy, assert it leaves both the switcher list and the server. This is the reported case. There are no local files to check here, by definition.
2. **Local, non-active vault** — the files-survive guarantee (D1) can only be proven on a vault that _has_ files, and D4 forbids deleting the active one. So this scenario needs a second local vault beyond the fixture's `testVaultPath`, which is opened and therefore active. Register it, delete it from the account, then assert its directory and notes are still on disk.

Scenario 2 is the one worth defending — it is the only test that catches a regression turning delete into data loss. Note that the existing `vault.e2e.ts` is `@ts-nocheck` with soft assertions (`.isVisible().catch(() => false)` and no expect); do not model new specs on it.

## Compatibility

- **Server deploys before desktop** — the endpoint must exist before any client offers the button.
- **Additive only.** No schema change, no migration, no change to any existing route, contract, or payload shape.
- **Old clients are unaffected.** They never call `DELETE` and keep re-registering vaults exactly as they do now (D3).
- New IPC channel is additive; older renderers do not reference it.

## Rejected

- **Deleting local files** (always, or via opt-in checkbox) — D1. Unrecoverable loss of data Memry does not own.
- **Replacing the X with Delete** — D2. Removes a legitimate local-only case and forces a server purge on users who wanted a tidier sidebar.
- **Tombstoning** — D3. Additive migration plus an unanswerable question about refused registrations on released clients, to fix a case nobody has reported.
- **Type-to-confirm** — D1. Friction should track irreversibility of _user data_; files survive, so it would be theater. Nothing in the app gates on typed input today.
- **Reusing `vault:remove`** — it is path-keyed and registry-only; it cannot address a cloud-only vault, and its dialog promises files remain, a contract that overloading would break.
