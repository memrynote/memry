# Free-Plan Sync Gating + Upgrade Return — Design Spec

**Date:** 2026-06-11
**Status:** Approved (brainstorming complete; awaiting implementation plan)
**Owner:** Kaan Karaca
**Parent spec:** [`2026-05-09-paid-sync-design.md`](./2026-05-09-paid-sync-design.md)

## Summary

Sign-in/sign-up currently throws an error for any new (free) user because the
desktop client starts the sync runtime with **no plan awareness** — it slams a
paid-only sync route and surfaces the server's `402 SYNC_PAYMENT_REQUIRED` as a
sync failure. This spec adds the **desktop client half** of paid sync: detect
the plan, gate sync on it (free → no sync, no error, fully-local app unchanged),
and provide an upgrade path that returns the app to a synced state after the
user pays on the web.

This is the MVP slice of the parent paid-sync design. The parent's **server half
is already built** (`/auth/billing`, `/auth/billing/reconcile`, `paddle-billing.ts`,
`entitlements.ts`, `paidSyncMiddleware`); its **desktop half was never
implemented**. This spec fills that gap with the smallest behavior that ships a
correct free→paid experience.

## Problem (the exact bug)

`startSyncRuntime()` (`apps/desktop/src/main/sync/runtime.ts:178`) short-circuits
on a missing refresh token and an unconfirmed recovery phrase, but **never checks
entitlement**. All three sync-start call sites funnel through it:

- `apps/desktop/src/main/ipc/auth-oauth-handlers.ts:277` (after OAuth success)
- `apps/desktop/src/main/sync/device-registration.ts:206` (after device registration)
- `apps/desktop/src/main/vault/index.ts:325` (on vault open)

So a free user who signs in → `startSyncRuntime()` → `SyncEngine.start()` →
first sync request hits `paidSyncMiddleware` → `assertPaidSyncAccess` throws
`402` → renderer shows it as `sync_error`. There is **zero** billing/entitlement
code on the client today (no contracts, no IPC, no UI).

## Goals

- A free user can sign in (or stay signed out) and use the **fully-local app
  with no error** and no behavior change.
- Sync never starts unless the account is paid (`active` or `grace`).
- An in-app upgrade path: open web checkout → pick plan on web → pay → app
  returns to a synced state automatically, with a manual fallback.
- Reuse existing infra: the OAuth loopback pattern, `/auth/billing*` routes,
  `paddle-checkout-config.ts`.

## Non-Goals

- Re-specifying the server (webhooks, lapse cron, vault/storage/file limits,
  state machine) — all covered by the parent spec.
- Lapse-state UI nuance (separate `grace` vs `read_only` vs `purged` banners).
  This MVP treats entitlement as **binary**: paid (`active`/`grace`) → sync on;
  everything else → free behavior. Richer banners are a follow-up against the
  parent spec's status matrix.
- In-app plan selection / Paddle.js inline overlay — plan is picked on the web.
- Onboarding changes — first launch is already vault-based, not auth-gated
  (`App.tsx` → `!isVaultOpen` → `VaultOnboarding`); sign-in is already optional.

## Decisions Log (from brainstorming, 2026-06-11)

| #   | Decision                                                                  | Rationale                                                                                                                                                              |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Gate sync at **one chokepoint** in `startSyncRuntime()`                   | All 3 start sites funnel through it; one `isPaid` precheck covers them. No doomed network round-trip, no 402 toast.                                                    |
| 2   | Sign-in stays **optional**; free = full local app                         | Already the status quo (vault-based onboarding). No nags, no blocking screens.                                                                                         |
| 3   | Churn/expiry = identical to free                                          | Any non-paid entitlement (`canceled`/`purged`/`read_only`/none) → sync stops, "Renew" copy. Same gate, no special-casing in this MVP.                                  |
| 4   | Upgrade entry point lives **only** in Settings › Sync (+ the return path) | No banner elsewhere.                                                                                                                                                   |
| 5   | Plan is picked **on the web**, not in-app                                 | Desktop just carries identity to the web pricing page.                                                                                                                 |
| 6   | Return-to-app via **loopback redirect**, reusing the OAuth pattern        | OAuth already uses a loopback HTTP server (`http://127.0.0.1:<port>`), not a custom `memry://` protocol. Zero new OS infra. `memry://` is a documented future upgrade. |
| 7   | Absorb webhook lag with **reconcile + retry** on return                   | `POST /auth/billing/reconcile` (already accepts `transactionId`) forces Paddle→D1 sync, so the return doesn't depend on the webhook having landed.                     |

## Architecture

```
┌──────────────────────────────┐         ┌───────────────────────────┐
│ Desktop (Electron)           │         │ Web (landing)             │
│  main:                       │         │  /upgrade page            │
│   - entitlement cache        │         │   - verify upgradeToken   │
│   - startSyncRuntime() gate  │         │   - pick plan             │
│   - upgrade loopback server  │         │   - Paddle checkout        │
│   (reuses OAuth loopback)    │         │   - success → redirect to │
│  renderer:                   │         │     127.0.0.1:PORT/upgraded│
│   - Settings › Sync (free)   │         └─────────────┬─────────────┘
│   - [Upgrade] / [Refresh]    │                       │
│   - "Local only" status pill │                       │
└──────────────┬───────────────┘                       │
               │ token-auth                            ▼
               ▼                          ┌───────────────────────────┐
┌──────────────────────────────────────┐ │ Paddle Billing (hosted)   │
│ Sync Server (existing)               │ │  checkout + webhook        │
│  GET  /auth/billing  (status)        │◀┘                            │
│  POST /auth/billing/reconcile        │   webhook → D1 entitlement   │
│  POST /auth/billing/upgrade-session  │   (existing pipeline)        │
│         (NEW: mint upgradeToken)     │                              │
│  POST /paddle/webhook (existing)     │                              │
└──────────────────────────────────────┘
```

## Component Design

### A. Server (mostly reuse; one new endpoint)

**Reused as-is:**

- `GET /auth/billing` → `getBillingStatus(db, userId)` → entitlement status.
- `POST /auth/billing/reconcile { transactionId? }` → forces Paddle→D1 sync,
  returns fresh status. The post-payment failsafe.
- Existing checkout-token mint (signs `{ userId, plan, cadence, exp }`) and the
  Paddle webhook pipeline.

**New:** `POST /auth/billing/upgrade-session` (authed) → returns a short-lived
signed **`upgradeToken`** carrying `{ userId, exp }` (HMAC via the existing
`PADDLE_CHECKOUT_TOKEN_SECRET` family). This lets the desktop hand identity to
the web `/upgrade` page **without** putting the raw access token in a browser URL,
and **without** pre-committing a plan (plan is picked on web). The web page
exchanges `upgradeToken` (server-verified) for a per-plan checkout token once the
user picks a plan.

> Rationale for a dedicated token: the existing checkout-token mint requires
> `plan`+`cadence`, which aren't known until the web step. `upgradeToken` is the
> identity-only carrier.

### B. Client — main process

**Entitlement cache + gate (the bug fix).** A small main-process module owns the
last-known entitlement (`{ isPaid, plan, status }`), fetched from `GET /auth/billing`:

- on app start (if signed in),
- after sign-in,
- after an upgrade return / manual refresh.

`startSyncRuntime()` gains an `isPaid` precheck **after** the existing
refresh-token and recovery-phrase guards:

```
if (!hasRefreshToken) return null            // existing
if (recoveryPhraseConfirmed === false) return null  // existing
if (!entitlement.isPaid) {                   // NEW
  log.info('Sync runtime skipped: free plan')
  emitToRenderer(sync status = 'local_only')
  return null
}
```

Free → runtime never starts → **no 402, no error**. One chokepoint covers OAuth
success, device registration, and vault open.

**Upgrade loopback handler.** Reuse the OAuth loopback module
(`auth-oauth-handlers.ts` already runs `http.createServer` with a state-keyed
session map and timeout). Add an upgrade variant:

1. Desktop mints `upgradeToken` (calls the new endpoint).
2. Spins/uses a loopback server, builds `redirect = http://127.0.0.1:<port>/upgraded`.
3. `shell.openExternal('https://memrynote.com/upgrade?session=<upgradeToken>&redirect=<redirect>')`.
4. On payment, the web success page redirects to `…/upgraded?transactionId=<id>`.
5. Loopback catches it → `POST /auth/billing/reconcile { transactionId }` →
   refresh entitlement cache → if now paid, `startSyncRuntime()` → success HTML.
6. Webhook-lag guard: reconcile already does the Paddle fetch; if status is still
   not paid (rare), retry a short bounded loop, then fall back to the manual
   refresh affordance.

**Lifetime/teardown.** Loopback session reuses the OAuth `OAUTH_SESSION_TIMEOUT_MS`
(~10 min) window; if the app is closed mid-checkout, the return 404s and the user
uses **Settings › Sync → [Refresh plan]** instead (manual reconcile).

### C. Client — renderer

- **Settings › Sync, signed-in + free:** `Signed in as <email> · Free plan`,
  primary `[Upgrade to sync]`, secondary `[Refresh plan]` (manual reconcile).
- **Settings › Sync, signed-out:** existing `[Sign in to enable sync]`.
- **Sync status pill:** new terminal-ish `local_only` state → "Local only" (free)
  / "Sync paused · Renew" (churned). No nags elsewhere.
- No paywall modal, no blocking screen.

### D. Contracts / IPC

New `packages/contracts/src/ipc-billing.ts` (run `pnpm ipc:generate` +
`pnpm ipc:check` after):

```ts
export interface BillingApi {
  'billing:getStatus': () => Promise<{
    isPaid: boolean
    plan: string | null
    status: string | null
  }>
  'billing:openUpgrade': () => Promise<void> // mints token, opens web, arms loopback
  'billing:refresh': () => Promise<{ isPaid: boolean }> // manual reconcile fallback
}
```

Renderer subscribes to a `sync:status` event already emitted by the engine; the
`local_only` value is the only addition there.

## End-to-End Flow

```
Free user signs in
  → token stored, GET /auth/billing → isPaid=false
  → startSyncRuntime() returns null (gate)   ✓ no error, app fully local
  → Settings › Sync shows Free + [Upgrade to sync]

Clicks [Upgrade]
  → main: POST /auth/billing/upgrade-session → upgradeToken
  → main: arm loopback :PORT, shell.openExternal(memrynote.com/upgrade?session=…&redirect=127.0.0.1:PORT)
  → web: verify token → pick plan → checkout-token → Paddle checkout
  → web: pay → Paddle webhook → D1 entitlement = active (async)
  → web success: redirect 127.0.0.1:PORT/upgraded?transactionId=…
  → main loopback: POST /auth/billing/reconcile { transactionId } → isPaid=true
  → main: refresh cache → startSyncRuntime() → sync starts (as today)
  → renderer: pill flips off "Local only"; toast "Sync enabled"

App closed mid-checkout (loopback gone)
  → user reopens → Settings › Sync → [Refresh plan] → reconcile → isPaid=true → sync starts
```

## Edge Cases

| Case                             | Handling                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Webhook lags the loopback return | `reconcile` fetches Paddle state directly; bounded retry; then manual fallback.                               |
| App closed before return         | Loopback 404; `[Refresh plan]` in Settings reconciles on next launch.                                         |
| User cancels checkout on web     | No redirect; nothing changes; still free.                                                                     |
| Paid user's plan lapses (churn)  | Next `getStatus`/start sees non-paid → sync stops, pill "Sync paused · Renew". (Decision #3)                  |
| Multiple devices, one upgrades   | Each device's next `getStatus` (start/refresh) sees paid → starts sync.                                       |
| `upgradeToken` expired/tampered  | Web `/upgrade` rejects; user retries from Settings.                                                           |
| Signed-out free user             | App fully local; no entitlement fetch; `[Sign in to enable sync]`.                                            |
| Local-admin dev override         | `ensureLocalAdminPaidSyncAccessForUser` already grants paid in `development`; gate honors it via `getStatus`. |

## Telemetry

Reuse the existing PostHog taxonomy (per memory: account-linked identity, env
property). New funnel events:

- `sync_gated_free` (sync skipped because free)
- `upgrade_clicked`
- `upgrade_checkout_opened`
- `entitlement_activated` (reconcile flips to paid)
- `upgrade_return_fallback_used` (manual refresh path)

## Testing Strategy

- **Unit (main):** `startSyncRuntime()` gate — paid starts, free/churned skips
  (TDD: write the skip test first, watch it fail against current code).
- **Unit (main):** upgrade loopback — URL built with `session`+`redirect`;
  `/upgraded` → reconcile called with `transactionId`; paid → `startSyncRuntime`.
- **Unit (server):** `POST /auth/billing/upgrade-session` mints a verifiable,
  expiring token; rejects unauthed.
- **Renderer:** Settings › Sync free vs paid vs churned states; pill `local_only`.
- **Integration (server):** reconcile flips D1 entitlement from sandbox txn.
- **E2E (Playwright):** sign in as free → no error, app usable, Settings shows
  Upgrade; mocked reconcile flips to paid → sync starts.
- **Manual QA:** full Paddle sandbox: free sign-in → upgrade → loopback return →
  sync on; app-closed → manual refresh path; two-device activation.

## Phased Implementation

| Phase                  | Scope                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Gate (ship the fix) | Entitlement cache + `getStatus` IPC; `startSyncRuntime()` precheck; `local_only` sync status; **free sign-in stops erroring.**                                                                   |
| 2. Settings UI         | Settings › Sync free/paid/churned states; `[Upgrade]` + `[Refresh plan]`.                                                                                                                        |
| 3. Upgrade round-trip  | `POST /auth/billing/upgrade-session`; main loopback upgrade handler; web `/upgrade` page (new or extend `/pricing`) verifying `upgradeToken`; success redirect to loopback; reconcile + restart. |
| 4. Polish              | Telemetry funnel; toasts; bounded retry + fallback copy; docs (`apps/docs`).                                                                                                                     |

Phase 1 alone removes the crash and is independently shippable.

## Open Items (resolve at implementation time)

- Confirm exact `getBillingStatus` response shape → map to `{ isPaid, plan, status }`
  (derive `isPaid` from `status ∈ {active, grace}` via the server's existing helper).
- Verify whether landing already has a user-facing `/upgrade` or `/pricing` page
  to extend, vs. building new (`paddle-checkout-config.ts` exists; page status TBD).
- Decide `upgradeToken` TTL (propose 10 min, matching OAuth session window).
- Confirm the success-page → loopback redirect carries `transactionId` (Paddle
  passes it on the success/return URL); if not, reconcile without it (status-only).
- Telemetry event names vs. existing taxonomy (reuse, don't fork).

```

```
