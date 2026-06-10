# Free-Plan Sync Gating — Design Spec

**Date:** 2026-06-11
**Status:** Approved (scope corrected after code audit; awaiting implementation)
**Owner:** Kaan Karaca
**Parent spec:** [`2026-05-09-paid-sync-design.md`](./2026-05-09-paid-sync-design.md)

> **Revision note:** An earlier draft of this spec assumed the desktop billing
> layer did not exist and proposed new loopback servers + `upgrade-session` /
> `hosted-checkout` endpoints + a dedicated web page. A code audit proved that
> wrong: the desktop billing IPC, checkout flow, `memry://` deep-link return, and
> reconcile loop **already exist**. This revision narrows the spec to the **only
> real gap: the sync entitlement gate** (the crash). The plan-selection page is a
> separate, deferred follow-up.

## Summary

A free user who signs in hits a sync error because the desktop **never checks
entitlement before starting sync**: `startSyncRuntime()` only guards on
refresh-token + recovery-phrase, then `SyncEngine` calls a paid-only route and the
server's `402 SYNC_PAYMENT_REQUIRED` surfaces as a sync failure. The fix is a
**cache-first entitlement gate** so an unpaid account (free or lapsed) does **no
sync-server interaction at all** — it behaves exactly like a signed-out local user.

## What already exists (verified in code — do NOT rebuild)

| Capability                                                                          | Location                                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Billing status fetch (`/auth/billing`)                                              | `apps/desktop/src/main/billing/paddle-billing.ts` `getBillingStatus()`                                             |
| Reconcile w/ retry → sync (`/auth/billing/reconcile`)                               | same file, `reconcileBillingAndSync()` (5×/2s; on `active` → `getSyncEngine()?.fullSync()`)                        |
| Checkout (`/auth/checkout-token` → web `pricing#checkout_token`)                    | same file, `startBillingCheckout()`                                                                                |
| Billing portal                                                                      | same file, `openBillingPortal()`                                                                                   |
| `memry://billing/complete?transactionId=…` deep link → reconcile                    | `apps/desktop/src/main/index.ts:514` `handleDeepLink()`                                                            |
| `memry://billing/start?plan=&cadence=` deep link → checkout                         | same handler                                                                                                       |
| Account IPC (get/refresh/checkout/portal)                                           | `apps/desktop/src/main/ipc/account-handlers.ts`, `AccountChannels` in `packages/contracts/src/ipc-channels.ts:452` |
| Preload `accountApi`                                                                | `apps/desktop/src/preload/api/sync-identity.ts`                                                                    |
| Renderer billing UI (plan/status, Upgrade, Refresh)                                 | `apps/desktop/src/renderer/src/pages/settings/account-section.tsx`                                                 |
| Server routes (`/auth/billing`, `/reconcile`, `/checkout-token`, `/portal-session`) | `apps/sync-server/src/routes/auth.ts`                                                                              |

## The gap (this spec)

1. **No entitlement gate.** `startSyncRuntime()`
   (`apps/desktop/src/main/sync/runtime.ts:178`) has no plan check → free sync
   starts → `402` → `sync_error`. **This is the crash.**
2. **Reconcile can't restart a stopped engine.** `reconcileBillingAndSync()` (and
   the manual-refresh path via `SYNC_CHANNELS.TRIGGER_SYNC` →
   `sync-core-handlers.ts:150`) only `fullSync()` an **already-running** engine.
   Once the gate stops a free engine, a free→paid activation must **start** the
   runtime, not just full-sync it.
3. **No `local_only` status.** The sync pill should read "Local only" for unpaid,
   instead of `idle`.

## Decisions (carried from brainstorming, corrected to reality)

| #   | Decision                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Gate at one chokepoint: `startSyncRuntime()`. All 3 start sites funnel through it.                                                      |
| 2   | Unpaid (free **or** lapsed) = identical to free: no pull, no push, **no sync-server calls**.                                            |
| 3   | **Cache-first:** a known-unpaid account makes zero `/auth/billing` calls on launch; only known-paid (or unknown/first-run) re-verifies. |
| 4   | Reuse the existing `memry://` + checkout + reconcile flow. No new endpoints, no loopback.                                               |
| 5   | Sign-in stays optional; onboarding unchanged (vault-based).                                                                             |
| 6   | Dedicated plan-selection page (replacing the hardcoded `plan:'pro'` in `handleStartCheckout`) is a **separate, deferred** spec.         |

## Design

### 1. Entitlement cache (new module)

`apps/desktop/src/main/billing/entitlement-cache.ts`

- Persist last-known `{ isPaid, plan, status }` in the `store` `sync` slice
  (new `entitlement` field on `SyncStoreData`).
- `isPaidBillingStatus(s)` = `s.plan !== 'free' && s.status === 'active'`
  (mirrors server `isPaidSyncEntitlementActive`; lapsed statuses are not `active`).
- `getCachedEntitlement()` → cached object or `null`.
- `setCachedEntitlementFromStatus(BillingStatus)` → writes cache.
- `resolveEntitlementForSyncStart()`:
  - cache `null` (unknown / first run) → `getBillingStatus()`, cache, return.
  - cache `isPaid === true` → re-verify via `getBillingStatus()`, cache, return.
  - cache `isPaid === false` → **return cache, no server call.**

### 2. The gate (`startSyncRuntime`)

After the existing refresh-token + recovery-phrase guards:

```ts
const entitlement = await resolveEntitlementForSyncStart()
if (!entitlement.isPaid) {
  log.info('Sync runtime skipped: not on a paid plan')
  emitSyncStatus('local_only')
  return null
}
```

Free → engine never starts → **no 402, no error**.

### 3. Activation starts the runtime (not just fullSync)

- `reconcileBillingAndSync()`: on `status === 'active'`, call
  `setCachedEntitlementFromStatus(status)` then `startSyncRuntime()` (idempotent —
  returns the running engine if present, starts it if not), then `fullSync()`.
- `getBillingStatus()` / `refreshBillingStatus()`: whenever they return a
  `BillingStatus`, update the cache (so the renderer manual-refresh path leaves a
  paid cache behind before triggering sync).
- `SYNC_CHANNELS.TRIGGER_SYNC` handler (`sync-core-handlers.ts:150`): if no engine,
  `await startSyncRuntime()` before `fullSync()`, so the manual `[Refresh]` →
  active path starts a stopped engine.

### 4. `local_only` status

- Add `'local_only'` to `SyncStatusValue` in
  `packages/contracts/src/ipc-sync-ops.ts`.
- Gate emits a `STATUS_CHANGED` event with `status: 'local_only'` (mirror the
  existing `emitQuotaExceeded()` pattern in `runtime.ts:82`).
- `SYNC_CHANNELS.GET_STATUS` (`sync-core-handlers.ts:144`): when no engine **and**
  cached entitlement is unpaid, return `{ status: 'local_only', pendingCount: 0 }`
  (so a fresh launch shows it).

## Edge Cases

| Case                                                         | Handling                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| First sign-in (no cache yet)                                 | `resolveEntitlementForSyncStart()` fetches once (sign-in is itself a server interaction), caches; thereafter free = no calls. |
| Lapsed paid user                                             | `status` no longer `active` → `isPaid=false` → gate stops sync, pill "Local only / Renew".                                    |
| Paid on another device                                       | Cache-first: free device sees it on next sign-in or manual `[Refresh]` (then starts sync).                                    |
| Upgrade via `memry://billing/complete`                       | reconcile updates cache + `startSyncRuntime()` → sync starts.                                                                 |
| Dev local-admin override                                     | `getBillingStatus()` reflects the dev override (`ensureLocalAdminPaidSyncAccessForUser`); gate honors it.                     |
| `getBillingStatus()` returns an error (offline at first run) | Treat as unpaid for this launch (no sync); retried on next trigger/sign-in.                                                   |

## Testing

- **`runtime.test.ts`** (mirror existing mocks): gate returns `null` + does not
  call `getDatabase()` when cached entitlement is unpaid and makes **no**
  `getBillingStatus` call; starts (calls `getDatabase`) when cached paid (after
  re-verify); first-run (no cache) fetches once.
- **`entitlement-cache.test.ts`**: `isPaidBillingStatus` truth table (free/active,
  plus/active, plus/canceled, plus/active+expired-status); cache read/write.
- **`paddle-billing` test**: `reconcileBillingAndSync` on `active` updates cache +
  calls `startSyncRuntime`.
- **`sync-core-handlers` test**: `TRIGGER_SYNC` with no engine calls
  `startSyncRuntime`; `GET_STATUS` returns `local_only` when no engine + cached free.
- **Manual QA**: free sign-in → no error, app fully local, pill "Local only";
  upgrade (existing flow) → return → sync starts; paid relaunch → re-verify → sync.

## Deferred (separate spec)

- **Dedicated plan-selection page.** Today `handleStartCheckout`
  (`account-section.tsx:190`) hardcodes `plan:'pro', cadence:'annual'`. A real
  Plus/Pro/Believer + cadence selector (in-app dialog or a web page reachable from
  the existing checkout flow) is its own design + plan. Out of scope here.
