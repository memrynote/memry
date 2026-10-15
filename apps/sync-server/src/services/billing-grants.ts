import {
  upsertSyncEntitlement,
  type SyncCadence,
  type SyncEntitlementSource,
  type SyncEntitlementStatus,
  type SyncPlan
} from './entitlements'

/**
 * Each store keeps its own grant (`paddle_grants`, `app_store_grants`), and `sync_entitlements`
 * mirrors whichever grant wins. Every billing writer stores its grant, then calls
 * `recomputeEntitlement`, so neither store can overwrite the other's state.
 */

interface Grant {
  source: Exclude<SyncEntitlementSource, 'none'>
  plan: SyncPlan
  cadence: SyncCadence | null
  status: SyncEntitlementStatus
  expiresAt: number | null
  willRenew: boolean | null
  updatedAt: number
}

interface EntitlementRow {
  plan: SyncPlan
  cadence: SyncCadence | null
  status: SyncEntitlementStatus
  source: SyncEntitlementSource
  expires_at: number | null
  updated_at: number
}

interface PaddleGrantRow {
  plan: SyncPlan
  cadence: SyncCadence | null
  status: SyncEntitlementStatus
  expires_at: number | null
  updated_at: number
}

interface AppStoreGrantRow extends PaddleGrantRow {
  will_renew: number | null
}

export interface PaddleGrantParams {
  userId: string
  plan: SyncPlan
  /** `null` keeps the stored cadence. */
  cadence?: SyncCadence | null
  status: SyncEntitlementStatus
  expiresAt?: number | null
  paddleCustomerId?: string | null
  paddleSubscriptionId?: string | null
  paddleTransactionId?: string | null
}

const PLAN_RANK: Record<SyncPlan, number> = { free: 0, plus: 1, pro: 2, believer: 3 }

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

function isActive(grant: Grant, now: number): boolean {
  return (
    grant.plan !== 'free' &&
    grant.status === 'active' &&
    (grant.expiresAt === null || grant.expiresAt > now)
  )
}

/** Best active grant: believer > pro > plus, then the later expiry (`null` never expires). */
export function pickWinningGrant(grants: Grant[], now = nowSeconds()): Grant | null {
  const active = grants.filter((grant) => isActive(grant, now))
  if (active.length > 0) {
    return active.reduce((best, grant) => {
      const rank = PLAN_RANK[grant.plan] - PLAN_RANK[best.plan]
      if (rank !== 0) return rank > 0 ? grant : best
      const bestExpiry = best.expiresAt ?? Number.POSITIVE_INFINITY
      const expiry = grant.expiresAt ?? Number.POSITIVE_INFINITY
      return expiry > bestExpiry ? grant : best
    })
  }
  // Nothing active: show the most recent lapsed grant so the user sees why (canceled, past_due).
  if (grants.length === 0) return null
  return grants.reduce((latest, grant) => (grant.updatedAt > latest.updatedAt ? grant : latest))
}

export async function recomputeEntitlement(db: D1Database, userId: string): Promise<void> {
  const [current, paddle, appStore] = await Promise.all([
    db
      .prepare(
        'SELECT plan, cadence, status, source, expires_at, updated_at FROM sync_entitlements WHERE user_id = ?'
      )
      .bind(userId)
      .first<EntitlementRow>(),
    db
      .prepare(
        'SELECT plan, cadence, status, expires_at, updated_at FROM paddle_grants WHERE user_id = ?'
      )
      .bind(userId)
      .first<PaddleGrantRow>(),
    db
      .prepare(
        'SELECT plan, cadence, status, expires_at, will_renew, updated_at FROM app_store_grants WHERE user_id = ?'
      )
      .bind(userId)
      .all<AppStoreGrantRow>()
  ])

  const grants: Grant[] = []
  // A Worker from before migration 0019 writes Paddle state to sync_entitlements only. A paddle
  // row newer than paddle_grants is that write, so it stands in for the Paddle grant.
  const paddleRow =
    current?.source === 'paddle' && (!paddle || current.updated_at > paddle.updated_at)
      ? current
      : paddle
  if (paddleRow) grants.push(toGrant('paddle', paddleRow, null))
  for (const row of appStore.results ?? []) {
    grants.push(toGrant('app_store', row, row.will_renew === null ? null : row.will_renew === 1))
  }
  // Manual grants have no store behind them, so the stored row is their only record.
  const override =
    current && (current.source === 'admin_override' || current.source === 'dev_seed')
      ? toGrant(current.source, current, null)
      : null
  if (override) grants.push(override)

  const winner = pickWinningGrant(grants)
  if (!winner || winner === override) return

  await upsertSyncEntitlement(db, {
    userId,
    plan: winner.plan,
    cadence: winner.cadence,
    status: winner.status,
    source: winner.source,
    expiresAt: winner.expiresAt,
    willRenew: winner.willRenew
  })
}

function toGrant(source: Grant['source'], row: PaddleGrantRow, willRenew: boolean | null): Grant {
  return {
    source,
    plan: row.plan,
    cadence: row.cadence ?? null,
    status: row.status,
    expiresAt: row.expires_at ?? null,
    willRenew,
    updatedAt: row.updated_at
  }
}

/**
 * Stores Paddle's view of the user's billing, then recomputes the entitlement. The Paddle ids
 * also land on `sync_entitlements`, where the portal, invoices, and webhook lookup read them.
 */
export async function writePaddleGrant(db: D1Database, params: PaddleGrantParams): Promise<void> {
  const now = nowSeconds()
  await db
    .prepare(
      `INSERT INTO paddle_grants (
         user_id, plan, cadence, status, expires_at,
         paddle_customer_id, paddle_subscription_id, paddle_transaction_id, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         plan = excluded.plan,
         cadence = COALESCE(excluded.cadence, paddle_grants.cadence),
         status = excluded.status,
         expires_at = excluded.expires_at,
         paddle_customer_id = COALESCE(excluded.paddle_customer_id, paddle_grants.paddle_customer_id),
         paddle_subscription_id = COALESCE(excluded.paddle_subscription_id, paddle_grants.paddle_subscription_id),
         paddle_transaction_id = COALESCE(excluded.paddle_transaction_id, paddle_grants.paddle_transaction_id),
         updated_at = excluded.updated_at`
    )
    .bind(
      params.userId,
      params.plan,
      params.cadence ?? null,
      params.status,
      params.expiresAt ?? null,
      params.paddleCustomerId ?? null,
      params.paddleSubscriptionId ?? null,
      params.paddleTransactionId ?? null,
      now
    )
    .run()

  await db
    .prepare(
      `INSERT INTO sync_entitlements (
         user_id, paddle_customer_id, paddle_subscription_id, paddle_transaction_id, updated_at
       )
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         paddle_customer_id = COALESCE(excluded.paddle_customer_id, sync_entitlements.paddle_customer_id),
         paddle_subscription_id = COALESCE(excluded.paddle_subscription_id, sync_entitlements.paddle_subscription_id),
         paddle_transaction_id = COALESCE(excluded.paddle_transaction_id, sync_entitlements.paddle_transaction_id)`
    )
    .bind(
      params.userId,
      params.paddleCustomerId ?? null,
      params.paddleSubscriptionId ?? null,
      params.paddleTransactionId ?? null,
      now - 1
    )
    .run()

  await recomputeEntitlement(db, params.userId)
}
