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
user picks a plan and pays on the web.

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
- Sync never starts unless the account is paid (`active` or `grace`). An unpaid
  account (free **or** lapsed) makes **no sync-server interaction at all** —
  treated exactly like a signed-out local user.
- An in-app upgrade path: open a **dedicated web plan-selection page** → pick
  plan + cadence → pay on Paddle's hosted checkout → app returns to a synced
  state automatically, with a manual fallback.
- Reuse existing infra: the OAuth loopback pattern, `/auth/billing*` routes,
  `paddle-checkout-config.ts`, the approved pricing matrix.

## Non-Goals

- Re-specifying the server (webhooks, lapse cron, vault/storage/file limits,
  state machine) — all covered by the parent spec.
- Lapse-state UI nuance (separate `grace` vs `read_only` vs `purged` banners).
  This MVP treats entitlement as **binary**: paid (`active`/`grace`) → sync on;
  everything else → free behavior. Richer banners are a follow-up.
- Independent storage selection / new storage Paddle prices — storage stays
  **coupled to plan** per the approved matrix (Decision #9). The plan page shows
  storage as a read-only detail.
- In-app (Electron-embedded) plan selection or Paddle.js overlay — plan is
  picked on the web page; payment runs on Paddle's **hosted** checkout.
- Onboarding changes — first launch is already vault-based, not auth-gated
  (`App.tsx` → `!isVaultOpen` → `VaultOnboarding`); sign-in is already optional.

## Decisions Log (from brainstorming, 2026-06-11)

| #   | Decision                                                              | Rationale                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Gate sync at **one chokepoint** in `startSyncRuntime()`               | All 3 start sites funnel through it; one `isPaid` precheck covers them. No doomed network round-trip, no 402 toast.                                                                       |
| 2   | Sign-in stays **optional**; free = full local app                     | Already the status quo (vault-based onboarding). No nags, no blocking screens.                                                                                                            |
| 3   | Unpaid = identical to free (incl. churn/expiry)                       | Any non-paid entitlement (`canceled`/`purged`/`read_only`/none) → treated exactly as free: **no pull, no push, no sync-server calls**. Pill shows "Renew". No special-casing in this MVP. |
| 4   | Upgrade entry point lives **only** in Settings › Sync (+ return path) | No banner elsewhere.                                                                                                                                                                      |
| 5   | Plan is picked on a **dedicated web page**, not in-app                | Desktop carries identity to the web page; page hosts plan/cadence selection + order summary.                                                                                              |
| 6   | Return-to-app via **loopback redirect**, reusing the OAuth pattern    | OAuth already uses a loopback HTTP server (`http://127.0.0.1:<port>`), not `memry://`. Zero new OS infra. `memry://` is a future upgrade.                                                 |
| 7   | Absorb webhook lag with **reconcile + retry** on return               | `POST /auth/billing/reconcile` (accepts `transactionId`) forces Paddle→D1 sync; return doesn't depend on the webhook landing first.                                                       |
| 8   | Payment via **Paddle Hosted Checkout** (full redirect)                | `Proceed to payment` redirects to Paddle's hosted page; its success URL bounces to the loopback. No Paddle.js embedding.                                                                  |
| 9   | Storage stays **coupled to plan** (read-only on the page)             | Matches the approved matrix + live `SYNC_PLAN_LIMITS`; no new Paddle prices, no server entitlement changes.                                                                               |

## Architecture

```
┌──────────────────────────────┐         ┌────────────────────────────────┐
│ Desktop (Electron)           │         │ Web (landing)                  │
│  main:                       │         │  /upgrade plan-selection page  │
│   - entitlement cache        │         │   - verify upgradeToken        │
│   - startSyncRuntime() gate  │         │   - pick plan + cadence        │
│   - upgrade loopback server  │         │   - live order summary         │
│   (reuses OAuth loopback)    │         │   - Proceed → hosted checkout  │
│  renderer:                   │         └───────────────┬────────────────┘
│   - Settings › Sync (free)   │                         │ redirect
│   - [Upgrade] / [Refresh]    │                         ▼
│   - "Local only" status pill │         ┌────────────────────────────────┐
└──────────────┬───────────────┘         │ Paddle Billing (hosted checkout)│
               │ token-auth              │  pay → success_url = loopback   │
               ▼                         │  webhook → D1 entitlement        │
┌──────────────────────────────────────┐└───────────────┬────────────────┘
│ Sync Server (existing + 2 new)       │                 │ success redirect
│  GET  /auth/billing  (status)        │◀────────────────┘  to 127.0.0.1:PORT
│  POST /auth/billing/reconcile        │   webhook (existing pipeline)
│  POST /auth/billing/upgrade-session  │   NEW: mint upgradeToken
│  POST /auth/billing/hosted-checkout  │   NEW: create Paddle txn, return URL
│  POST /paddle/webhook (existing)     │
└──────────────────────────────────────┘
```

## Component Design

### A. Server (mostly reuse; two new endpoints)

**Reused as-is:**

- `GET /auth/billing` → `getBillingStatus(db, userId)` → entitlement status.
- `POST /auth/billing/reconcile { transactionId? }` → forces Paddle→D1 sync,
  returns fresh status. The post-payment failsafe.
- Paddle webhook pipeline; `paddle-checkout-config.ts` (`priceId` + `customData`
  resolution from the approved matrix).

**New 1 — `POST /auth/billing/upgrade-session` (authed):** returns a short-lived
signed **`upgradeToken`** carrying `{ userId, exp }` (HMAC via the existing
`PADDLE_CHECKOUT_TOKEN_SECRET` family). Lets the desktop hand identity to the web
`/upgrade` page **without** putting the raw access token in a browser URL and
**without** pre-committing a plan (plan is picked on the page).

**New 2 — `POST /auth/billing/hosted-checkout` (token-verified):**
input `{ upgradeToken, plan, cadence, returnUrl }`. Verifies `upgradeToken` →
`userId`; resolves `priceId` via `getPaddleCheckoutConfig({ plan, cadence })`;
creates a Paddle transaction with `customData = { userId, plan, cadence }` and
checkout `success_url = returnUrl` (the desktop loopback); returns
`{ checkoutUrl }`. Believer forces `cadence = 'lifetime'` (one-time SKU), matching
`parsePaddleCheckoutIntent`.

> Why a dedicated mint + create split: the existing checkout-token mint expects
> `plan`+`cadence` up front (Paddle.js flow); the page doesn't know them until the
> user picks. `upgradeToken` is identity-only; `hosted-checkout` commits the plan.

### B. Web — `/upgrade` plan-selection page (landing)

A dedicated page modeled on the reference screenshot (two columns: selectors
left, live order summary right).

- **Entry:** `memrynote.com/upgrade?session=<upgradeToken>&redirect=<loopback>`.
  Verify `upgradeToken` server-side on load (reject expired/tampered → "open this
  from the Memry app" message).
- **Plan** (radio): **Plus**, **Pro**, **Believer**. Each row shows its bundled,
  **read-only** details from the matrix — vault count · version history · storage
  (Plus 1 GiB / Pro 10 GiB / Believer 50 GiB). No storage selector (Decision #9).
- **Renewal frequency** (radio): **Yearly** (SAVE 20%) / **Monthly**.
  **Disabled when Believer** is selected (lifetime → one-time price).
- **Order summary** (right): live line item + total, recomputed on each change.
- **Proceed to payment:** `POST /auth/billing/hosted-checkout` with the chosen
  `{ plan, cadence }`, the carried `upgradeToken`, and `returnUrl = redirect`
  → receive `checkoutUrl` → `window.location = checkoutUrl` (Paddle hosted).
- **After payment:** Paddle redirects the browser to `returnUrl`
  (`http://127.0.0.1:PORT/upgraded?…`); Paddle appends its transaction id.

> Loopback-as-success-URL fallback: if Paddle rejects a raw `127.0.0.1` success
> URL, set `success_url` to a thin landing `/upgrade/success` page that
> JS-redirects to the loopback (carrying the transaction id). Verify at impl time.

### C. Desktop — main process

**Entitlement cache + gate (the bug fix).** A small main-process module owns the
last-known entitlement (`{ isPaid, plan, status }`), **persisted locally**.
`isPaid` is derived from `status ∈ { active, grace }` (server's existing helper).

**Cache-first — unpaid makes zero sync-server calls.** The cache is refreshed by
calling `GET /auth/billing` **only** on: sign-in, an upgrade return, and a manual
`[Refresh plan]`. On app **start**:

- cached `isPaid = false` (or no cache, signed out) → **no server call**; sync
  stays off. This is what guarantees "no server interaction" for free/lapsed users.
- cached `isPaid = true` → re-verify via `GET /auth/billing` (a paying user
  already talks to the server); if still paid, start sync; if it now reports
  unpaid, drop to `local_only`.

`startSyncRuntime()` gains an `isPaid` precheck **after** the existing
refresh-token and recovery-phrase guards:

```
if (!hasRefreshToken) return null                   // existing
if (recoveryPhraseConfirmed === false) return null  // existing
if (!entitlement.isPaid) {                           // NEW
  log.info('Sync runtime skipped: free plan')
  emitToRenderer(sync status = 'local_only')
  return null
}
```

Free → runtime never starts → **no 402, no error**. One chokepoint covers OAuth
success, device registration, and vault open.

**Upgrade loopback handler.** Reuse the OAuth loopback module
(`auth-oauth-handlers.ts` already runs `http.createServer` with a state-keyed
session map + timeout). Add an upgrade variant:

1. Desktop mints `upgradeToken` (`POST /auth/billing/upgrade-session`).
2. Arm a loopback server; `redirect = http://127.0.0.1:<port>/upgraded`.
3. `shell.openExternal('https://memrynote.com/upgrade?session=<token>&redirect=<redirect>')`.
4. On payment, the browser hits `…/upgraded?transactionId=<id>` (via Paddle's
   success URL).
5. Loopback catches it → `POST /auth/billing/reconcile { transactionId }` →
   refresh entitlement cache → if now paid, `startSyncRuntime()` → success HTML.
6. Webhook-lag guard: `reconcile` does the Paddle fetch directly; if still not
   paid (rare), bounded retry, then fall back to the manual refresh affordance.

**Lifetime/teardown.** Loopback session reuses the OAuth timeout window
(~10 min). If the app is closed mid-checkout, the return 404s and the user uses
**Settings › Sync → [Refresh plan]** (manual reconcile).

### D. Desktop — renderer

- **Settings › Sync, signed-in + free:** `Signed in as <email> · Free plan`,
  primary `[Upgrade to sync]` (opens the loopback upgrade flow), secondary
  `[Refresh plan]` (manual reconcile).
- **Settings › Sync, signed-out:** existing `[Sign in to enable sync]`.
- **Sync status pill:** new `local_only` value → "Local only" (free) /
  "Sync paused · Renew" (churned). No nags elsewhere.
- No paywall modal, no blocking screen.

### E. Contracts / IPC

New `packages/contracts/src/ipc-billing.ts` (run `pnpm ipc:generate` +
`pnpm ipc:check` after):

```ts
export interface BillingApi {
  'billing:getStatus': () => Promise<{
    isPaid: boolean
    plan: string | null
    status: string | null
  }>
  'billing:openUpgrade': () => Promise<void> // mint token, open web page, arm loopback
  'billing:refresh': () => Promise<{ isPaid: boolean }> // manual reconcile fallback
}
```

## End-to-End Flow

```
Free user signs in
  → token stored, GET /auth/billing → isPaid=false
  → startSyncRuntime() returns null (gate)   ✓ no error, app fully local
  → Settings › Sync shows Free + [Upgrade to sync]

Clicks [Upgrade]
  → main: POST /auth/billing/upgrade-session → upgradeToken
  → main: arm loopback :PORT, openExternal(memrynote.com/upgrade?session=…&redirect=127.0.0.1:PORT/upgraded)
  → web: verify token → pick plan (Plus/Pro/Believer) + cadence → live summary
  → web: Proceed → POST /auth/billing/hosted-checkout {upgradeToken, plan, cadence, returnUrl}
         → { checkoutUrl } → redirect to Paddle hosted checkout
  → user pays → Paddle webhook → D1 entitlement = active (async)
  → Paddle success_url → browser → 127.0.0.1:PORT/upgraded?transactionId=…
  → main loopback: POST /auth/billing/reconcile { transactionId } → isPaid=true
  → main: refresh cache → startSyncRuntime() → sync starts (as today)
  → renderer: pill flips off "Local only"; toast "Sync enabled"

App closed mid-checkout (loopback gone)
  → user reopens → Settings › Sync → [Refresh plan] → reconcile → isPaid=true → sync starts
```

## Edge Cases

| Case                                 | Handling                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Webhook lags the loopback return     | `reconcile` fetches Paddle state directly; bounded retry; then manual fallback.                                             |
| App closed before return             | Loopback 404; `[Refresh plan]` in Settings reconciles on next launch.                                                       |
| User abandons Paddle hosted checkout | No success redirect; nothing changes; still free.                                                                           |
| Believer selected                    | Frequency toggle disabled; `cadence='lifetime'`, one-time SKU; reconcile same path.                                         |
| Paid user's plan lapses (churn)      | Next `getStatus`/start sees non-paid → sync stops, pill "Sync paused · Renew".                                              |
| Multiple devices, one upgrades       | Cache-first: a free device won't poll on launch. It sees paid on next sign-in or manual `[Refresh plan]`, then starts sync. |
| `upgradeToken` expired/tampered      | `/upgrade` page rejects on load; user retries from Settings.                                                                |
| Paddle rejects loopback success URL  | `success_url` → thin `/upgrade/success` page that JS-redirects to loopback.                                                 |
| Signed-out free user                 | App fully local; no entitlement fetch; `[Sign in to enable sync]`.                                                          |
| Local-admin dev override             | `ensureLocalAdminPaidSyncAccessForUser` grants paid in `development`; gate honors it.                                       |

## Telemetry

Reuse the existing PostHog taxonomy (account-linked identity, env property).
New funnel events:

- `sync_gated_free` (sync skipped because free)
- `upgrade_clicked`
- `upgrade_page_opened`
- `upgrade_checkout_started` (hosted-checkout redirect)
- `entitlement_activated` (reconcile flips to paid)
- `upgrade_return_fallback_used` (manual refresh path)

## Testing Strategy

- **Unit (main):** `startSyncRuntime()` gate — paid starts, free/churned skips
  (TDD: write the skip test first, watch it fail against current code).
- **Unit (main):** upgrade loopback — URL built with `session`+`redirect`;
  `/upgraded` → reconcile called with `transactionId`; paid → `startSyncRuntime`.
- **Unit (server):** `upgrade-session` mints a verifiable, expiring token;
  `hosted-checkout` verifies token, resolves priceId, sets success_url, returns URL;
  Believer → lifetime.
- **Renderer:** Settings › Sync free vs paid vs churned; pill `local_only`.
- **Web:** `/upgrade` page — token gate, plan/cadence selection, live summary,
  Believer disables frequency, Proceed posts correct payload.
- **Integration (server):** reconcile flips D1 entitlement from a sandbox txn.
- **E2E (Playwright):** sign in as free → no error, app usable, Settings shows
  Upgrade; mocked reconcile flips to paid → sync starts.
- **Manual QA:** full Paddle sandbox: free sign-in → upgrade page → hosted
  checkout → loopback return → sync on; app-closed → manual refresh; Believer
  lifetime; two-device activation.

## Phased Implementation

| Phase                  | Scope                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Gate (ship the fix) | Entitlement cache + `getStatus` IPC; `startSyncRuntime()` precheck; `local_only` sync status. **Free sign-in stops erroring.** Independently shippable. |
| 2. Settings UI         | Settings › Sync free/paid/churned states; `[Upgrade]` + `[Refresh plan]`.                                                                               |
| 3. Upgrade round-trip  | `upgrade-session` + `hosted-checkout` endpoints; web `/upgrade` plan-selection page; main loopback upgrade handler; reconcile + restart.                |
| 4. Polish              | Telemetry funnel; toasts; bounded retry + fallback copy; docs (`apps/docs`).                                                                            |

## Open Items (resolve at implementation time)

- Confirm `getBillingStatus` response shape → map to `{ isPaid, plan, status }`
  (derive `isPaid` from `status ∈ {active, grace}`).
- Verify whether landing already has a `/upgrade` or `/pricing` page to extend vs
  build new (`paddle-checkout-config.ts` exists; page status TBD).
- Confirm Paddle Hosted Checkout accepts a `127.0.0.1` `success_url` and appends a
  transaction id; if not, use the `/upgrade/success` bounce-page fallback.
- Decide `upgradeToken` TTL (propose 10 min, matching the OAuth session window).
- Believer one-time SKU wiring in `hosted-checkout` (lifetime cadence).
- Telemetry event names vs. existing taxonomy (reuse, don't fork).

```

```
