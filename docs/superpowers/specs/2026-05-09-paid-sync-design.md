# Paid Sync — Design Spec

**Date:** 2026-05-09
**Status:** Approved (brainstorming phase complete; awaiting implementation plan)
**Owner:** Kaan Karaca

## Summary

Convert memry from a free local-first app into a freemium product where local-only use stays free and sync requires a paid subscription. Three paid tiers — Plus, Pro, Believer — managed via Paddle Billing (merchant of record). Server-side hard enforcement of vault count, total storage, max file size, and version-history retention. Founder is located in Turkey, which dictates Paddle as the payment processor.

## Goals

- Monetize sync without friction-blocking the local-only experience
- Enforce four per-tier limits server-side so they cannot be bypassed
- Handle subscription lifecycle (grace, read-only, purge) gracefully so paying customers don't lose data on a failed card
- Ship globally-tax-compliant from day one (Paddle MoR handles VAT/sales tax)
- Single source of truth for entitlement (D1) — no JWT-embedded state staleness

## Non-Goals (out of scope)

- Team / shared-vault plans
- Family / multi-user discounts
- Regional purchasing-power pricing (PPP) — possible future Paddle config
- Affiliate / referral program
- Mac App Store distribution (would require IAP, separate model)
- Mobile apps (iOS / Android — not yet built)
- Migration of existing free-tier users (memry is pre-production per CLAUDE.md; existing accounts will be wiped on cutover, tester comps via manual SQL insert)

## Pricing Tiers (final)

| Limit                | Plus                     | Pro                      | Believer         |
| -------------------- | ------------------------ | ------------------------ | ---------------- |
| Monthly price        | $5 / mo                  | $10 / mo                 | —                |
| Annual price         | $48 / yr ($4 / mo equiv) | $96 / yr ($8 / mo equiv) | —                |
| Lifetime price       | —                        | —                        | $500 one-time    |
| Synced vaults        | 1                        | 10                       | unlimited        |
| Total storage        | 1 GiB                    | 10 GiB                   | 50 GiB           |
| Max file size        | 5 MiB                    | 200 MiB                  | 200 MiB          |
| Version history      | 30 days                  | 365 days                 | 365 days         |
| Devices per account  | unlimited                | unlimited                | unlimited        |
| Future paid features | per-tier                 | per-tier                 | included forever |

Believer scope: lifetime access with Pro-or-better limits + automatic inclusion in any future paid feature (AI, future tiers, etc.). Marketed as "pay once, sync forever — founding-supporter narrative."

## Decisions Log (from brainstorming)

| #   | Decision                                                                                                   | Rationale                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Paddle Billing (modern API), MoR                                                                           | Stripe doesn't onboard Turkish business entities; Paddle handles VAT/sales tax in 60+ countries and pays out to a Turkish bank |
| 2   | No free trial; 7-day money-back refund                                                                     | Simpler state machine, indie-friendly framing                                                                                  |
| 3   | Lapse policy: 14 d grace → 30 d read-only → status `purged` at day 44; physical R2 blob deletion at day 90 | Mirrors Obsidian Sync; covers card-failure recovery; 46-day re-subscribe-and-recover window                                    |
| 4   | Believer = lifetime access with Pro-or-better limits + all future paid features                            | Founding-customer narrative; commercial commitment accepted                                                                    |
| 5   | Pricing matrix: Plus $5/mo or $48/yr; Pro $10/mo or $96/yr; Believer $500 lifetime                         | "Save 20% annually" messaging                                                                                                  |
| 6   | Server hard wall on all four limits                                                                        | E2E encryption doesn't preclude server enforcement of size + opaque vault IDs                                                  |
| 7   | Unlimited devices per account                                                                              | Simpler UX; existing devices table already supports per-device tokens + revocation if abuse appears                            |
| 8   | Approach A: D1 lookup per sync request                                                                     | Simplest; ~5–15 ms added latency; can migrate to KV cache later                                                                |
| 9   | Wipe existing users on cutover (no grandfathering)                                                         | Pre-production app; CLAUDE.md explicitly allows schema reset                                                                   |
| 10  | Pricing surfaces: in-app modal + marketing-site /pricing                                                   | In-app for upgrade prompts; marketing for top-of-funnel discovery                                                              |

## High-Level Architecture

```
┌─────────────────────┐                    ┌──────────────────────┐
│  Desktop (Electron) │                    │  marketing site      │
│  - PaywallDialog    │                    │  - /pricing page     │
│  - billing settings │                    │  - links to checkout │
│  - sync gate        │                    └──────────────────────┘
└──────────┬──────────┘                               │
           │ token-auth                               │
           ▼                                          ▼
┌────────────────────────────────────────────────────────────────┐
│  Sync Server (Cloudflare Workers + Hono)                       │
│  ┌────────────┐  ┌──────────────────┐  ┌───────────────────┐   │
│  │ /sync/*    │  │ /vaults          │  │ /paddle/webhook   │   │
│  │ entitlement│  │ vault registr.   │  │ HMAC-verified     │   │
│  │ middleware │  │ (count check)    │  │ idempotent        │   │
│  └─────┬──────┘  └────────┬─────────┘  └─────────┬─────────┘   │
│        │                  │                      │             │
│        ▼                  ▼                      ▼             │
│  ┌───────────────────────────────────────────────────────┐     │
│  │  D1: users, subscriptions, vaults, paddle_events,     │     │
│  │      sync_items (+vault_id), refund_requests,         │     │
│  │      purge_queue                                      │     │
│  └───────────────────────────────────────────────────────┘     │
│                                                                │
│  ┌───────────────────────────────────────────────────────┐     │
│  │  Cron Triggers:                                       │     │
│  │  - hourly: lapse state transitions                    │     │
│  │  - daily:  version-history snapshot purge             │     │
│  │  - daily:  purge_queue worker (R2 deletes)            │     │
│  └───────────────────────────────────────────────────────┘     │
└────────────┬───────────────────────────────────────────────────┘
             │
             ▼
       ┌──────────┐                   ┌──────────────────┐
       │   R2     │                   │  Paddle Billing  │
       │ blobs    │                   │  hosted checkout │
       │ (E2E enc)│                   │  customer portal │
       └──────────┘                   │  webhooks        │
                                      └──────────────────┘
```

## Subscription State Machine

```
                                  webhook: subscription.canceled
                                  (cancel_at_period_end fires after period_end)
  ┌─────────┐                                                    ┌────────┐
  │ active  ├──────────────────────────────────────────────────▶│ grace  │
  └────┬────┘                                                    │ (14 d) │
       │                                                         └───┬────┘
       │ webhook: transaction.refunded                               │
       │                                                             │ +14 d, no renew
       ▼                                                             ▼
  ┌─────────┐                                                  ┌───────────┐
  │ purged  │◀─────────────────────────────────────────────────│ read_only │
  └─────────┘   +30 d  (status flip: day 44 since cancel)      │ (push     │
       │       blobs remain on R2 — re-sub restores access      │  blocked) │
       │                                                       └─────┬─────┘
       │ at day 90: purge_queue worker                               │
       │ deletes R2 + sync_items                                     │ user re-subs
       ▼                                                             ▼
   (blobs gone)                                                ┌──────────┐
                                                               │  active  │
                                                               └──────────┘

  Re-subscribe at any time while blobs are still on R2 (i.e. before day 90)
  flips status back to active and restores sync access. Webhook
  subscription.created/updated handles the transition.
```

**Two distinct purge concepts:**

- **Status `purged` (day 44):** entitlement middleware returns 402 on every request. R2 blobs are still preserved.
- **Physical blob deletion (day 90):** `purge_queue` worker drops R2 objects + `sync_items` rows. Recovery no longer possible after this.

Subscription row keeps `purge_at` set to `cancel_time + 90 d`; the cron only enqueues `purge_queue` once `purge_at` is in the past.

Lifetime (Believer): subscription row created with `current_period_end = NULL`; cron skips. Only `transaction.refunded` (within 7 days) moves it to `purged` — and in that case `purge_at` is set to `now` so blobs are deleted immediately (no recovery window for refunds).

### Status decision matrix

| Status          | Pull (GET) | Push (POST/PUT) | Vault create | New blob |
| --------------- | ---------- | --------------- | ------------ | -------- |
| active          | ✅         | ✅              | ✅           | ✅       |
| grace           | ✅         | ✅              | ✅           | ✅       |
| read_only       | ✅         | ❌              | ❌           | ❌       |
| purged          | ❌         | ❌              | ❌           | ❌       |
| no subscription | ❌         | ❌              | ❌           | ❌       |

## Database Schema (D1)

### New tables

```sql
-- One row per user (one-to-one with users)
CREATE TABLE subscriptions (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL UNIQUE,
  paddle_customer_id       TEXT NOT NULL,
  paddle_subscription_id   TEXT UNIQUE,        -- NULL for lifetime
  paddle_transaction_id    TEXT,               -- one-time txn id (lifetime), nullable
  plan                     TEXT NOT NULL,      -- 'plus' | 'pro' | 'believer'
  status                   TEXT NOT NULL,      -- 'active' | 'grace' | 'read_only' | 'purged' | 'canceled'
  billing_cadence          TEXT NOT NULL,      -- 'monthly' | 'annual' | 'lifetime'
  current_period_start     INTEGER,            -- unix sec, NULL for lifetime
  current_period_end       INTEGER,            -- unix sec, NULL for lifetime
  cancel_at_period_end     INTEGER NOT NULL DEFAULT 0,
  grace_started_at         INTEGER,
  read_only_started_at     INTEGER,
  purge_at                 INTEGER,            -- when blobs get deleted (90 d after cancel)
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_subscriptions_status     ON subscriptions(status);
CREATE INDEX idx_subscriptions_period_end ON subscriptions(current_period_end) WHERE status = 'active';
CREATE INDEX idx_subscriptions_purge_at   ON subscriptions(purge_at) WHERE status IN ('grace', 'read_only');

-- Server-side vault registry; vault_id is opaque, generated client-side
CREATE TABLE vaults (
  id                  TEXT PRIMARY KEY,        -- client-generated UUID
  user_id             TEXT NOT NULL,
  encrypted_metadata  BLOB,                    -- vault name, color, etc., E2E encrypted
  created_at          INTEGER NOT NULL,
  archived_at         INTEGER,                 -- NULL while active; archive frees a slot
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_vaults_user ON vaults(user_id, archived_at);

-- Webhook idempotency
CREATE TABLE paddle_events (
  paddle_event_id TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  raw_payload     TEXT NOT NULL,
  processed_at    INTEGER,
  error           TEXT,
  created_at      INTEGER NOT NULL
);

-- Refund audit trail
CREATE TABLE refund_requests (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL,
  paddle_transaction_id    TEXT NOT NULL,
  reason                   TEXT,
  status                   TEXT NOT NULL,      -- 'requested' | 'approved' | 'denied' | 'completed'
  requested_at             INTEGER NOT NULL,
  resolved_at              INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Async R2 deletion queue
CREATE TABLE purge_queue (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  started_at  INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_purge_queue_pending ON purge_queue(enqueued_at) WHERE completed_at IS NULL;
```

### Schema modifications

```sql
-- Add vault scoping to sync items
ALTER TABLE sync_items ADD COLUMN vault_id TEXT;  -- NOT NULL going forward
CREATE INDEX idx_sync_items_vault ON sync_items(user_id, vault_id);

-- Mirror subscription state on users for fast read paths
-- (subscriptions table is source of truth; users.plan/status is denormalized cache,
--  written inside the same transaction as subscriptions inserts/updates)
ALTER TABLE users ADD COLUMN plan                TEXT;  -- nullable; null = no active sub
ALTER TABLE users ADD COLUMN subscription_status TEXT;  -- mirrors subscriptions.status

-- Drop hardcoded storage limit (now derived from PLAN_LIMITS[plan].maxStorageBytes)
ALTER TABLE users DROP COLUMN storage_limit;
```

## Plan Limits Constant

Single source of truth in `packages/contracts`, imported by both sync-server (enforcement) and desktop (UI gates):

```ts
// packages/contracts/src/billing.ts
export const PLAN_LIMITS = {
  plus: {
    maxVaults: 1,
    maxStorageBytes: 1_073_741_824, //   1 GiB
    maxFileSizeBytes: 5_242_880, //   5 MiB
    versionHistoryDays: 30
  },
  pro: {
    maxVaults: 10,
    maxStorageBytes: 10_737_418_240, //  10 GiB
    maxFileSizeBytes: 209_715_200, // 200 MiB
    versionHistoryDays: 365
  },
  believer: {
    maxVaults: null, // unlimited
    maxStorageBytes: 53_687_091_200, //  50 GiB
    maxFileSizeBytes: 209_715_200,
    versionHistoryDays: 365
  }
} as const

export type PlanTier = keyof typeof PLAN_LIMITS
```

Changing limits never requires a migration; bump the constant and redeploy.

## Entitlement Middleware

New middleware, runs after `auth`, before sync route handlers:

```ts
// apps/sync-server/src/middleware/entitlement.ts
export const entitlement = async (c, next) => {
  const userId = c.get('userId')
  const sub = await getActiveSubscription(c.env.DB, userId)

  if (!sub || sub.status === 'purged' || sub.status === 'canceled') {
    return c.json({ error: 'subscription_required', code: 'PAID_REQUIRED' }, 402)
  }

  c.set('subscription', sub)
  c.set('planLimits', PLAN_LIMITS[sub.plan])

  // Read-only: GET allowed, mutations blocked
  if (sub.status === 'read_only' && c.req.method !== 'GET') {
    return c.json({ error: 'read_only_mode', code: 'READ_ONLY' }, 402)
  }

  return next()
}
```

Mounted on: `/sync/*`, `/vaults/*`, `/blob/*`. Skipped by: `/auth/*`, `/me`, `/billing/*`, `/paddle/webhook`.

## Server-Side Enforcement Points

### 1. Vault count

```
POST /vaults  { vault_id, encrypted_metadata }
  → entitlement middleware (status check)
  → SELECT COUNT(*) FROM vaults WHERE user_id = ? AND archived_at IS NULL
  → if count >= PLAN_LIMITS[plan].maxVaults → 402 VAULT_LIMIT_EXCEEDED
  → else INSERT vault
```

### 2. Total storage

```
PUT /blob/:key
  → entitlement middleware
  → check storage_used + incoming_size <= PLAN_LIMITS[plan].maxStorageBytes
  → if over → 413 STORAGE_QUOTA_EXCEEDED
  → upload to R2, atomically increment users.storage_used
```

### 3. Max file size

```
PUT /blob/:key
  → check Content-Length header first (cheap reject)
  → if Content-Length > PLAN_LIMITS[plan].maxFileSizeBytes → 413 FILE_TOO_LARGE
  → re-check streamed bytes during upload (don't trust headers alone)
```

### 4. Version-history retention

Daily cron purges old snapshots:

```sql
-- For each user, with cutoff = now - PLAN_LIMITS[plan].versionHistoryDays * 86400:
DELETE FROM sync_items
WHERE user_id = ? AND type = 'snapshot' AND created_at < ?
RETURNING blob_key, size_bytes;
-- Then enqueue R2 deletes and decrement users.storage_used by SUM(size_bytes)
```

## Paddle Webhook Pipeline

**Endpoint:** `POST /paddle/webhook` — public, every request HMAC-verified against `PADDLE_WEBHOOK_SECRET`.

**Pipeline:**

1. Verify signature (timing-safe HMAC compare) → 401 if invalid
2. Parse `event_id`; check `paddle_events` table → 200 no-op if duplicate
3. Reject events older than 5 minutes (replay protection)
4. Insert into `paddle_events` with `processed_at = NULL`
5. Switch on `event_type` → handler
6. Update `paddle_events.processed_at = now` (or `.error` on failure)
7. Return 200 fast (Paddle retries on non-2xx)

### Events handled

> Exact event-type strings to be verified against current Paddle Billing v1 docs at implementation time. Names below match Paddle's documented schema as of 2026-Q1.

| Event                                               | Action                                                                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `subscription.created`                              | Insert subscriptions row, `status='active'`, set period dates, mirror to `users.plan/status`                                              |
| `subscription.updated`                              | Update plan / period dates / `cancel_at_period_end`                                                                                       |
| `subscription.canceled`                             | `status='grace'`, `grace_started_at=now`, `purge_at=now + 90d` (day 44 status flips to `purged` via cron; physical R2 deletion at day 90) |
| `subscription.past_due`                             | No state change (Paddle handles dunning); optionally email user                                                                           |
| `subscription.paused`                               | `status='read_only'`                                                                                                                      |
| `subscription.resumed`                              | `status='active'`                                                                                                                         |
| `transaction.completed` for one-time SKU (lifetime) | Create lifetime subscription, `plan='believer'`, `period_end=NULL`                                                                        |
| `transaction.refunded`                              | `status='purged'`, `purge_at=now` (immediate physical deletion on next cron tick — no 90-day recovery window for refunds)                 |
| `customer.created`                                  | Link `paddle_customer_id` to user (matched by email)                                                                                      |

**Idempotency:** every webhook checks `paddle_events.paddle_event_id`. Duplicate → 200 no-op. Failure → keep `processed_at` NULL, log error, return 500 so Paddle retries.

## Checkout Flow

```
1. User clicks "Get Plus" in PaywallDialog
2. App → GET /billing/checkout?plan=plus&cadence=annual
   Server creates Paddle transaction (POST /transactions on Paddle Billing API)
   Returns { checkoutToken }
3. App opens Paddle.js inline overlay with that token
4. User pays in overlay → Paddle fires:
   - customer.created (if new)
   - transaction.completed
   - subscription.created
5. Webhook handler upserts subscriptions row, sets users.plan/status
6. App polls GET /me every 2 s for ~30 s after Paddle's success callback
   → eventually sees plan='plus', status='active'
   → unblocks sync UI
7. If polling times out → show "Payment received, activating..." with manual refresh button
   that calls POST /billing/reconcile (failsafe — fetches Paddle state, upserts)
```

For lifetime: same flow with one-time SKU instead of subscription SKU.

## Cron Triggers (Cloudflare Workers Cron)

### Hourly: lapse state machine

```sql
-- active → grace (period_end passed and user cancelled)
UPDATE subscriptions
SET status='grace', grace_started_at=strftime('%s','now'),
    purge_at=strftime('%s','now') + 90*86400, updated_at=strftime('%s','now')
WHERE status='active'
  AND current_period_end IS NOT NULL
  AND current_period_end < strftime('%s','now')
  AND cancel_at_period_end = 1;

-- grace → read_only (after 14 days)
UPDATE subscriptions
SET status='read_only', read_only_started_at=strftime('%s','now'),
    updated_at=strftime('%s','now')
WHERE status='grace'
  AND grace_started_at + 14*86400 < strftime('%s','now');

-- read_only → purged (30 days after read-only start; day 44 since cancel)
-- This is a status flip only — R2 blobs stay until purge_at (day 90)
UPDATE subscriptions
SET status='purged', updated_at=strftime('%s','now')
WHERE status='read_only'
  AND read_only_started_at + 30*86400 < strftime('%s','now');

-- Mirror status to users for fast reads on entitlement check
UPDATE users
SET subscription_status = (SELECT status FROM subscriptions WHERE subscriptions.user_id = users.id),
    plan = (SELECT plan FROM subscriptions WHERE subscriptions.user_id = users.id)
WHERE id IN (SELECT user_id FROM subscriptions WHERE status IN ('grace', 'read_only', 'purged'));

-- Enqueue physical blob deletion only when purge_at has passed (day 90)
-- Refunds set purge_at = now, so they get enqueued on the next cron tick
INSERT INTO purge_queue (id, user_id, enqueued_at)
SELECT lower(hex(randomblob(16))), user_id, strftime('%s','now')
FROM subscriptions
WHERE purge_at IS NOT NULL
  AND purge_at <= strftime('%s','now')
  AND user_id NOT IN (SELECT user_id FROM purge_queue WHERE completed_at IS NULL);
```

### Daily: version-history retention

For each plan, delete snapshots older than `PLAN_LIMITS[plan].versionHistoryDays`. Decrement `users.storage_used` by reclaimed bytes. Enqueue R2 deletes via per-row blob keys.

### Daily: purge queue worker

Process pending `purge_queue` rows in batches:

1. Delete all R2 blobs for `user_id`
2. Delete `sync_items`, `vaults` rows
3. Reset `users.storage_used = 0`
4. Mark `purge_queue.completed_at = now`

## Error Response Schema (renderer-friendly)

All paid-feature errors return structured codes for the desktop UI:

```json
{ "error": "subscription_required", "code": "PAID_REQUIRED",        "status": 402 }
{ "error": "read_only_mode",        "code": "READ_ONLY",            "status": 402 }
{ "error": "vault_limit",           "code": "VAULT_LIMIT_EXCEEDED", "status": 402, "currentCount": 1, "max": 1 }
{ "error": "file_too_large",        "code": "FILE_TOO_LARGE",       "status": 413, "fileSize": ..., "max": ... }
{ "error": "storage_full",          "code": "STORAGE_QUOTA_EXCEEDED","status": 413, "used": ..., "max": ... }
```

The desktop app maps these codes to specific upgrade prompts (different copy per error).

## Desktop App Changes

### New components

| Component                                       | Purpose                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `components/billing/paywall-dialog.tsx`         | Full-screen tier-selection modal shown after sign-in if no subscription    |
| `components/billing/billing-settings-panel.tsx` | Settings → Subscription page                                               |
| `components/billing/sync-state-banner.tsx`      | Top-of-window banner for grace / read-only / purged states                 |
| `components/billing/upgrade-toast.tsx`          | Inline upgrade prompts on vault count / file size / storage gates          |
| `hooks/use-subscription.ts`                     | Subscribes to `/me`, polls every 5 min when focused, immediately on resume |

### IPC contract additions

```ts
// packages/contracts/src/ipc/billing.ts
export interface BillingApi {
  'billing:getSubscription': () => Promise<{
    plan: PlanTier | null
    status: 'active' | 'grace' | 'read_only' | 'purged' | null
    period_end: number | null // unix sec, null for lifetime
    storage_used: number
    storage_limit: number
    vault_count: number
    vault_limit: number
  }>
  'billing:openCheckout': (input: {
    plan: PlanTier
    cadence: 'monthly' | 'annual' | 'lifetime'
  }) => Promise<void>
  'billing:openCustomerPortal': () => Promise<void>
  'billing:requestRefund': (input: {
    reason?: string
  }) => Promise<{ ok: true } | { ok: false; reason: string }>
  'billing:reconcile': () => Promise<{ updated: boolean }>
}
```

### Integration with existing SyncContext

`SyncContext` checks subscription state before attempting sync; updates UI state accordingly. Existing sync runtime (`apps/desktop/src/main/sync/runtime.ts`) gets:

- Subscription state pre-check before starting engine
- 402-response handling: stop sync, surface state to renderer, show appropriate banner
- Resume hook: when status flips back to active, restart sync

### Paddle.js integration

`@paddle/paddle-js` loaded lazily in renderer. Initialized with `Paddle.Initialize({ token, environment })` from env config. The token is the Paddle client-side token (safe to expose); the secret webhook key stays server-side only.

## Edge Cases

| Case                                                 | Handling                                                                                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------ |
| Webhook arrives before `/me` poll completes          | Polling sees the update on next tick; UI activates within ~5 s                                                                                                                                |
| User pays, webhook never arrives (Paddle outage)     | `POST /billing/reconcile` fetches Paddle subscription state, upserts; triggered by user clicking "Refresh status"                                                                             |
| User refunds outside 7-day window manually via email | Support agent uses Paddle dashboard; webhook fires; user state goes to `purged`                                                                                                               |
| User has multiple subscriptions defensively          | UNIQUE constraint on `subscriptions.user_id`; webhook handler errors loudly if violated                                                                                                       |
| Card declined mid-cycle                              | Paddle's dunning kicks in (4 retries over 14 d); we get `subscription.past_due` (no state change) → eventually `subscription.canceled` → grace                                                |
| User upgrades Plus → Pro mid-cycle                   | Paddle handles proration; webhook `subscription.updated` updates plan; new limits apply immediately                                                                                           |
| User downgrades Pro → Plus with 5 vaults synced      | Downgrade takes effect at `period_end` (Paddle default). At that point, server marks excess vaults as "over limit" — pulls still work, pushes to those vaults blocked. UI prompts to archive. |
| Believer wants to cancel                             | Paddle portal: refund within 7 days possible; outside that, no proration since one-time                                                                                                       |
| Lifetime user, future big paid feature ships         | Per-feature flag check: `plan === 'believer'                                                                                                                                                  |     | feature_in_current_plan` |
| Server clock drift vs Paddle webhook timestamps      | Use Paddle's timestamp for state transitions, not local clock                                                                                                                                 |
| Two devices race to enable sync on the same vault    | `INSERT INTO vaults` with PRIMARY KEY on `id` — second device gets conflict, treats as success (vault already registered)                                                                     |

## Phased Implementation

| Phase                             | Scope                                                                                                                                                                                                                                               | Estimate |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1. Foundation                     | Schema migrations (subscriptions, vaults, paddle_events, refund_requests, purge_queue, sync_items.vault_id, users.plan/status, drop storage_limit). `PLAN_LIMITS` constant in `packages/contracts`. Paddle sandbox account + webhook secret in env. | 3 d      |
| 2. Webhooks + entitlement         | `/paddle/webhook` route w/ HMAC verify + idempotency. All event handlers. Entitlement middleware. `users.plan/status` denorm sync inside webhook txn. Tests against signed sandbox payloads.                                                        | 1 w      |
| 3. Vaults endpoint + tier limits  | `POST /vaults`, `GET /vaults`, `DELETE /vaults/:id` (archive). Vault count enforcement. File size enforcement (Content-Length + streaming). Wire `checkQuota` to `PLAN_LIMITS[plan].maxStorageBytes`.                                               | 1 w      |
| 4. Lapse cron + version retention | Cron triggers in wrangler.toml. State transition SQL. Snapshot purge by tier. Purge queue worker for R2 deletion.                                                                                                                                   | 4 d      |
| 5. Checkout integration           | `/billing/checkout` returns Paddle token. `/billing/reconcile` failsafe. `/me` extended with subscription state. `@paddle/paddle-js` integration, env config.                                                                                       | 4 d      |
| 6. Desktop UI                     | PaywallDialog, billing settings panel, sync state banners, inline gates, `useSubscription` hook, IPC contract, error code mapping.                                                                                                                  | 2 w      |
| 7. Marketing site /pricing        | Static pricing page with deep-link to checkout. Same Paddle flow for non-signed-up users (creates account on payment).                                                                                                                              | 3 d      |
| 8. Polish + GTM                   | Email templates (welcome, expiry warning, lapse, refund). Telemetry funnel events. End-to-end tests with Paddle sandbox. Documentation in `apps/docs`.                                                                                              | 1 w      |

**Total: ~7 weeks** of focused work. Phases 1–4 ship as a server-only milestone; Phases 5–6 ship the user-facing experience.

## Testing Strategy

- **Unit tests** — `PLAN_LIMITS` constants, state transition logic, signature verification, webhook idempotency, entitlement middleware decision matrix
- **Integration tests** (`apps/sync-server`) — Paddle sandbox webhooks → DB state changes → entitlement decisions; all status transitions including refund→purge
- **E2E tests** (Playwright) — paywall flow on first launch, checkout success path (mocked Paddle response), banner display in each lapse state, vault count gate, file size gate, refund request flow
- **Manual QA** — full Paddle sandbox cycle (subscribe → cancel → grace → read_only → purge); Believer one-time purchase; plan upgrade/downgrade; refund within 7 d; refund after 7 d
- **Load test** — webhook handler under burst (Paddle can fire 10s of events per second on bulk operations)

## Open Items (resolve at implementation time)

- Verify exact Paddle Billing webhook event-type strings against current Paddle docs (names in this spec match Paddle Billing v1 as of 2026-Q1)
- Decide marketing-site checkout flow for non-signed-up users (create account on payment vs. require sign-up first)
- Telemetry event names + funnel destinations (PostHog already integrated per memory; reuse existing event taxonomy)
- Email template copy + sender domain
- Pricing page copy (positioning vs. Obsidian Sync, Notion, etc.)
