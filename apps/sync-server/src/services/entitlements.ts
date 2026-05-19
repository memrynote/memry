import { AppError, ErrorCodes } from '../lib/errors'

const MIB = 1024 * 1024
const GIB = 1024 * 1024 * 1024

export type SyncPlan = 'free' | 'plus' | 'pro' | 'believer'
export type SyncEntitlementStatus = 'inactive' | 'active' | 'past_due' | 'paused' | 'canceled'
export type SyncEntitlementSource = 'none' | 'paddle' | 'admin_override' | 'dev_seed'

export interface SyncPlanLimits {
  storageLimit: number
  maxVaults: number | null
  maxFileSize: number
  versionHistoryDays: number
}

export interface SyncEntitlement {
  user_id: string
  storage_used: number
  plan: SyncPlan
  status: SyncEntitlementStatus
  source: SyncEntitlementSource
  storage_limit: number
  max_file_size: number
  max_vaults: number | null
  version_history_days: number
  paddle_customer_id: string | null
  paddle_subscription_id: string | null
  paddle_transaction_id: string | null
  expires_at: number | null
}

export interface UpsertSyncEntitlementParams {
  userId: string
  plan: SyncPlan
  status: SyncEntitlementStatus
  source: Exclude<SyncEntitlementSource, 'none'>
  paddleCustomerId?: string | null
  paddleSubscriptionId?: string | null
  paddleTransactionId?: string | null
  expiresAt?: number | null
}

export const SYNC_PLAN_LIMITS: Record<SyncPlan, SyncPlanLimits> = {
  free: {
    storageLimit: 0,
    maxVaults: 0,
    maxFileSize: 0,
    versionHistoryDays: 0
  },
  plus: {
    storageLimit: 1 * GIB,
    maxVaults: 1,
    maxFileSize: 5 * MIB,
    versionHistoryDays: 30
  },
  pro: {
    storageLimit: 10 * GIB,
    maxVaults: 10,
    maxFileSize: 200 * MIB,
    versionHistoryDays: 365
  },
  believer: {
    storageLimit: 50 * GIB,
    maxVaults: null,
    maxFileSize: 200 * MIB,
    versionHistoryDays: 365
  }
}

export function isPaidSyncEntitlementActive(
  entitlement: SyncEntitlement,
  nowSeconds = Math.floor(Date.now() / 1000)
): boolean {
  if (entitlement.plan === 'free') return false
  if (entitlement.status !== 'active') return false
  if (entitlement.expires_at !== null && entitlement.expires_at <= nowSeconds) return false
  return true
}

export async function getSyncEntitlement(db: D1Database, userId: string): Promise<SyncEntitlement> {
  const row = await db
    .prepare(
      `SELECT
         u.id as user_id,
         u.storage_used,
         COALESCE(e.plan, 'free') as plan,
         COALESCE(e.status, 'inactive') as status,
         COALESCE(e.source, 'none') as source,
         COALESCE(e.storage_limit, 0) as storage_limit,
         COALESCE(e.max_file_size, 0) as max_file_size,
         e.max_vaults,
         COALESCE(e.version_history_days, 0) as version_history_days,
         e.paddle_customer_id,
         e.paddle_subscription_id,
         e.paddle_transaction_id,
         e.expires_at
       FROM users u
       LEFT JOIN sync_entitlements e ON e.user_id = u.id
       WHERE u.id = ?`
    )
    .bind(userId)
    .first<SyncEntitlement>()

  if (!row) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'User not found', 404)
  }

  return row
}

export async function assertPaidSyncAccess(
  db: D1Database,
  userId: string
): Promise<SyncEntitlement> {
  const entitlement = await getSyncEntitlement(db, userId)

  if (!isPaidSyncEntitlementActive(entitlement)) {
    throw new AppError(
      ErrorCodes.SYNC_PAYMENT_REQUIRED,
      'An active paid sync plan is required to use encrypted sync.',
      402
    )
  }

  return entitlement
}

export async function assertFileSizeAllowed(
  db: D1Database,
  userId: string,
  fileSizeBytes: number
): Promise<void> {
  const entitlement = await assertPaidSyncAccess(db, userId)

  if (fileSizeBytes > entitlement.max_file_size) {
    throw new AppError(
      ErrorCodes.STORAGE_FILE_TOO_LARGE,
      `File exceeds the ${entitlement.plan} plan file size limit`,
      413
    )
  }
}

export async function ensureSyncVaultAllowed(
  db: D1Database,
  userId: string,
  vaultId: string,
  entitlement: SyncEntitlement
): Promise<void> {
  const findExistingVault = () =>
    db
      .prepare('SELECT vault_id FROM sync_vaults WHERE user_id = ? AND vault_id = ?')
      .bind(userId, vaultId)
      .first<{ vault_id: string }>()

  const existing = await findExistingVault()

  if (existing) return

  if (entitlement.max_vaults !== null) {
    const count = await db
      .prepare('SELECT COUNT(*) as cnt FROM sync_vaults WHERE user_id = ?')
      .bind(userId)
      .first<{ cnt: number }>()

    if ((count?.cnt ?? 0) >= entitlement.max_vaults) {
      const insertedByRace = await findExistingVault()
      if (insertedByRace) return

      throw new AppError(
        ErrorCodes.SYNC_VAULT_LIMIT_EXCEEDED,
        `${entitlement.plan} allows ${entitlement.max_vaults} synced vaults`,
        402
      )
    }
  }

  const now = Math.floor(Date.now() / 1000)
  let insertResult: D1Result

  if (entitlement.max_vaults === null) {
    insertResult = await db
      .prepare(
        `INSERT INTO sync_vaults (id, user_id, vault_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, vault_id) DO NOTHING`
      )
      .bind(crypto.randomUUID(), userId, vaultId, now, now)
      .run()
  } else {
    insertResult = await db
      .prepare(
        `INSERT INTO sync_vaults (id, user_id, vault_id, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM sync_vaults WHERE user_id = ?) < ?
         ON CONFLICT(user_id, vault_id) DO NOTHING`
      )
      .bind(crypto.randomUUID(), userId, vaultId, now, now, userId, entitlement.max_vaults)
      .run()
  }

  if ((insertResult.meta.changes ?? 0) > 0) return

  const insertedByRace = await findExistingVault()

  if (insertedByRace) return

  throw new AppError(
    ErrorCodes.SYNC_VAULT_LIMIT_EXCEEDED,
    `${entitlement.plan} allows ${entitlement.max_vaults} synced vaults`,
    402
  )
}

export async function upsertSyncEntitlement(
  db: D1Database,
  params: UpsertSyncEntitlementParams
): Promise<void> {
  const limits = SYNC_PLAN_LIMITS[params.plan]
  const now = Math.floor(Date.now() / 1000)

  await db
    .prepare(
      `INSERT INTO sync_entitlements (
         user_id,
         plan,
         status,
         source,
         storage_limit,
         max_file_size,
         max_vaults,
         version_history_days,
         paddle_customer_id,
         paddle_subscription_id,
         paddle_transaction_id,
         expires_at,
         updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         plan = excluded.plan,
         status = excluded.status,
         source = excluded.source,
         storage_limit = excluded.storage_limit,
         max_file_size = excluded.max_file_size,
         max_vaults = excluded.max_vaults,
         version_history_days = excluded.version_history_days,
         paddle_customer_id = COALESCE(excluded.paddle_customer_id, sync_entitlements.paddle_customer_id),
         paddle_subscription_id = COALESCE(excluded.paddle_subscription_id, sync_entitlements.paddle_subscription_id),
         paddle_transaction_id = COALESCE(excluded.paddle_transaction_id, sync_entitlements.paddle_transaction_id),
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`
    )
    .bind(
      params.userId,
      params.plan,
      params.status,
      params.source,
      limits.storageLimit,
      limits.maxFileSize,
      limits.maxVaults,
      limits.versionHistoryDays,
      params.paddleCustomerId ?? null,
      params.paddleSubscriptionId ?? null,
      params.paddleTransactionId ?? null,
      params.expiresAt ?? null,
      now
    )
    .run()

  await db
    .prepare('UPDATE users SET storage_limit = ?, updated_at = ? WHERE id = ?')
    .bind(limits.storageLimit, now, params.userId)
    .run()
}
