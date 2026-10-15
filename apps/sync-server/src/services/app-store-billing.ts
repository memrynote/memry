import { AppleJwsError, verifyAppleJws } from '../lib/apple-jws'
import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { appAccountTokenForUser } from './app-store-account-token'
import { recomputeEntitlement } from './billing-grants'
import type { SyncCadence, SyncEntitlementStatus, SyncPlan } from './entitlements'
import type { Bindings } from '../types'

const logger = createLogger('AppStoreBilling')

export const APP_STORE_PRODUCTS: Record<string, { plan: SyncPlan; cadence: SyncCadence }> = {
  'com.memrynote.app.plus.monthly': { plan: 'plus', cadence: 'monthly' },
  'com.memrynote.app.plus.annual': { plan: 'plus', cadence: 'annual' },
  'com.memrynote.app.pro.monthly': { plan: 'pro', cadence: 'monthly' },
  'com.memrynote.app.pro.annual': { plan: 'pro', cadence: 'annual' },
  'com.memrynote.app.believer': { plan: 'believer', cadence: 'lifetime' }
}

// Only environments whose JWS chains to Apple Root CA - G3. `Xcode` (StoreKit testing) is signed
// by a local certificate, so it is refused even when APPLE_APP_STORE_ENVIRONMENTS lists it.
const VERIFIABLE_ENVIRONMENTS = new Set(['Production', 'Sandbox'])

/** JWSTransactionDecodedPayload fields this server reads. Dates are epoch milliseconds. */
export interface AppStoreTransaction {
  transactionId: string
  originalTransactionId: string
  bundleId: string
  productId: string
  environment: string
  signedDate: number
  expiresDate?: number
  revocationDate?: number
  appAccountToken?: string
}

interface AppStoreRenewalInfo {
  originalTransactionId?: string
  autoRenewStatus?: number
  signedDate: number
}

interface AppStoreNotification {
  notificationType: string
  subtype?: string
  notificationUUID: string
  signedDate: number
  data?: {
    bundleId?: string
    environment?: string
    signedTransactionInfo?: string
    signedRenewalInfo?: string
  }
}

interface AppStoreConfig {
  bundleId: string
  environments: Set<string>
}

function readConfig(env: Bindings): AppStoreConfig {
  const bundleId = env.APPLE_BUNDLE_ID?.trim()
  const environments = new Set(
    (env.APPLE_APP_STORE_ENVIRONMENTS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => VERIFIABLE_ENVIRONMENTS.has(value))
  )
  if (!bundleId || environments.size === 0) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'App Store billing is not configured', 503)
  }
  return { bundleId, environments }
}

function invalid(message: string, status: 400 | 403 = 400): AppError {
  return new AppError(ErrorCodes.BILLING_APP_STORE_INVALID, message, status)
}

async function verify<T extends { signedDate?: number }>(jws: string): Promise<T> {
  try {
    return await verifyAppleJws<T>(jws)
  } catch (error) {
    // Anything the chain or DER reader throws means the same thing: not a genuine Apple JWS.
    logger.warn('App Store JWS verification failed', {
      reason: error instanceof AppleJwsError ? error.message : 'malformed'
    })
    throw invalid('App Store signature could not be verified')
  }
}

function checkTransaction(config: AppStoreConfig, transaction: AppStoreTransaction): void {
  if (transaction.bundleId !== config.bundleId) {
    throw invalid('Transaction belongs to another app')
  }
  if (!config.environments.has(transaction.environment)) {
    throw invalid(`App Store environment ${transaction.environment} is not accepted`)
  }
  if (!APP_STORE_PRODUCTS[transaction.productId]) {
    throw invalid('Unknown App Store product')
  }
}

/**
 * Grant status for a transaction. `null` keeps the stored status: a renewal-preference or
 * auto-renew toggle says nothing about whether the current period is paid.
 */
function grantStatus(
  transaction: AppStoreTransaction,
  notificationType: string | null
): SyncEntitlementStatus | null {
  if (transaction.revocationDate) return 'canceled'
  switch (notificationType) {
    case 'REFUND':
    case 'REVOKE':
    case 'EXPIRED':
    case 'GRACE_PERIOD_EXPIRED':
      return 'canceled'
    case 'DID_FAIL_TO_RENEW':
      // GRACE_PERIOD subtype or plain billing retry: payment is failing either way.
      return 'past_due'
    case 'DID_CHANGE_RENEWAL_PREF':
    case 'DID_CHANGE_RENEWAL_STATUS':
      return null
    default:
      return 'active'
  }
}

async function writeAppStoreGrant(
  db: D1Database,
  userId: string,
  transaction: AppStoreTransaction,
  status: SyncEntitlementStatus | null,
  willRenew: boolean | null
): Promise<void> {
  const product = APP_STORE_PRODUCTS[transaction.productId]
  const lifetime = product.cadence === 'lifetime'
  await db
    .prepare(
      `INSERT INTO app_store_grants (
         original_transaction_id, user_id, product_id, plan, cadence, status, expires_at,
         will_renew, environment, last_transaction_id, signed_date, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(original_transaction_id) DO UPDATE SET
         product_id = excluded.product_id,
         plan = excluded.plan,
         cadence = excluded.cadence,
         status = CASE WHEN ? THEN app_store_grants.status ELSE excluded.status END,
         expires_at = excluded.expires_at,
         will_renew = COALESCE(excluded.will_renew, app_store_grants.will_renew),
         environment = excluded.environment,
         last_transaction_id = excluded.last_transaction_id,
         signed_date = excluded.signed_date,
         updated_at = excluded.updated_at
       WHERE app_store_grants.user_id = excluded.user_id
         AND excluded.signed_date >= app_store_grants.signed_date`
    )
    .bind(
      transaction.originalTransactionId,
      userId,
      transaction.productId,
      product.plan,
      product.cadence,
      status ?? 'active',
      lifetime || !transaction.expiresDate ? null : Math.floor(transaction.expiresDate / 1000),
      lifetime || willRenew === null ? null : willRenew ? 1 : 0,
      transaction.environment,
      transaction.transactionId,
      transaction.signedDate,
      Math.floor(Date.now() / 1000),
      status === null ? 1 : 0
    )
    .run()

  await recomputeEntitlement(db, userId)
}

async function grantOwner(db: D1Database, originalTransactionId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT user_id FROM app_store_grants WHERE original_transaction_id = ?')
    .bind(originalTransactionId)
    .first<{ user_id: string }>()
  return row?.user_id ?? null
}

/**
 * `POST /auth/billing/app-store/transactions`: the iOS app reports a StoreKit 2 transaction
 * (`Transaction.jwsRepresentation`). Idempotent: replaying the same JWS rewrites the same grant,
 * and an older JWS never overwrites a newer one.
 */
export async function applyAppStoreTransactionForUser(
  env: Bindings,
  userId: string,
  signedTransactionInfo: string
): Promise<void> {
  const config = readConfig(env)
  const transaction = await verify<AppStoreTransaction>(signedTransactionInfo)
  checkTransaction(config, transaction)

  const expectedToken = await appAccountTokenForUser(userId)
  if (transaction.appAccountToken?.toLowerCase() !== expectedToken) {
    throw invalid('Transaction was purchased by another account', 403)
  }
  const owner = await grantOwner(env.DB, transaction.originalTransactionId)
  if (owner && owner !== userId) {
    throw invalid('Transaction was purchased by another account', 403)
  }

  await writeAppStoreGrant(env.DB, userId, transaction, grantStatus(transaction, null), null)
}

/** `POST /webhooks/app-store`: App Store Server Notifications V2. */
export async function applyAppStoreNotification(
  env: Bindings,
  signedPayload: string
): Promise<{ processed: boolean; userId: string | null }> {
  const config = readConfig(env)
  const notification = await verify<AppStoreNotification>(signedPayload)
  const data = notification.data ?? {}
  if (data.bundleId !== config.bundleId) throw invalid('Notification belongs to another app')
  if (!data.environment || !config.environments.has(data.environment)) {
    // Not ours to act on (e.g. a Sandbox notification on a Production-only server). 200 so
    // Apple does not retry it.
    return { processed: false, userId: null }
  }

  const seen = await env.DB.prepare(
    'SELECT notification_uuid FROM app_store_notifications WHERE notification_uuid = ?'
  )
    .bind(notification.notificationUUID)
    .first<{ notification_uuid: string }>()
  if (seen) return { processed: false, userId: null }

  const userId = await applyNotificationData(env, config, notification)

  await env.DB.prepare(
    `INSERT OR IGNORE INTO app_store_notifications
       (notification_uuid, notification_type, subtype, processed_at)
     VALUES (?, ?, ?, ?)`
  )
    .bind(
      notification.notificationUUID,
      notification.notificationType,
      notification.subtype ?? null,
      Math.floor(Date.now() / 1000)
    )
    .run()

  return { processed: userId !== null, userId }
}

async function applyNotificationData(
  env: Bindings,
  config: AppStoreConfig,
  notification: AppStoreNotification
): Promise<string | null> {
  const data = notification.data ?? {}
  if (notification.notificationType === 'TEST' || !data.signedTransactionInfo) return null

  const transaction = await verify<AppStoreTransaction>(data.signedTransactionInfo)
  checkTransaction(config, transaction)
  const renewal = data.signedRenewalInfo
    ? await verify<AppStoreRenewalInfo>(data.signedRenewalInfo)
    : null

  // The stored grant is authoritative. appAccountToken is the user id (app-store-account-token.ts),
  // so a first notification maps through it.
  const userId =
    (await grantOwner(env.DB, transaction.originalTransactionId)) ??
    (transaction.appAccountToken
      ? ((
          await env.DB.prepare('SELECT id FROM users WHERE id = ?')
            .bind(transaction.appAccountToken.toLowerCase())
            .first<{ id: string }>()
        )?.id ?? null)
      : null)
  if (!userId) {
    logger.warn('App Store notification has no matching user', {
      notificationType: notification.notificationType
    })
    return null
  }

  const willRenew = renewal?.autoRenewStatus === undefined ? null : renewal.autoRenewStatus === 1
  await writeAppStoreGrant(
    env.DB,
    userId,
    transaction,
    grantStatus(transaction, notification.notificationType),
    willRenew
  )
  return userId
}
