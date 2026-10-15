-- Apple In-App Purchase billing next to Paddle.
-- sync_entitlements stays the single row the paid-sync gate reads. It now
-- holds whichever store's grant wins (services/billing-grants.ts
-- recomputeEntitlement), so each store keeps its own state here and a losing
-- grant survives the other store winning.
-- Additive only. A Worker still running the previous build ignores these
-- tables and keeps writing sync_entitlements directly, and recompute reads a
-- source = 'paddle' row newer than its paddle_grants row as Paddle state, so
-- writes made during the deploy window are not lost.

CREATE TABLE IF NOT EXISTS paddle_grants (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  cadence TEXT,
  status TEXT NOT NULL,
  expires_at INTEGER,
  paddle_customer_id TEXT,
  paddle_subscription_id TEXT,
  paddle_transaction_id TEXT,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO paddle_grants (
  user_id, plan, cadence, status, expires_at,
  paddle_customer_id, paddle_subscription_id, paddle_transaction_id, updated_at
)
SELECT user_id, plan, cadence, status, expires_at,
  paddle_customer_id, paddle_subscription_id, paddle_transaction_id, updated_at
FROM sync_entitlements
WHERE source = 'paddle';

-- One row per App Store subscription (or the believer purchase), keyed by
-- originalTransactionId. signed_date orders writes so an older JWS never
-- overwrites a newer one.
CREATE TABLE IF NOT EXISTS app_store_grants (
  original_transaction_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  cadence TEXT,
  status TEXT NOT NULL,
  expires_at INTEGER,
  will_renew INTEGER,
  environment TEXT NOT NULL,
  last_transaction_id TEXT NOT NULL,
  signed_date INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_store_grants_user ON app_store_grants(user_id);

-- Idempotency ledger for App Store Server Notifications V2.
CREATE TABLE IF NOT EXISTS app_store_notifications (
  notification_uuid TEXT PRIMARY KEY,
  notification_type TEXT NOT NULL,
  subtype TEXT,
  processed_at INTEGER NOT NULL
);

-- Auto-renew state of the winning grant. NULL = unknown or not applicable.
ALTER TABLE sync_entitlements ADD COLUMN will_renew INTEGER;
