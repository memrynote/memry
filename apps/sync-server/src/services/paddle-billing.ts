import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'
import {
  getSyncEntitlement,
  upsertSyncEntitlement,
  type SyncCadence,
  type SyncEntitlement,
  type SyncPlan
} from './entitlements'
import {
  isPlanUpgrade,
  resolveSubscriptionPriceId,
  type SubscriptionCadence,
  type SubscriptionPlan
} from './paddle-prices'
import { getUserById } from './user'
import type { Bindings } from '../types'

const logger = createLogger('PaddleBilling')

export interface BillingStatusResponse {
  plan: SyncEntitlement['plan']
  cadence: SyncEntitlement['cadence']
  status: SyncEntitlement['status']
  source: SyncEntitlement['source']
  email: string | null
  limits: {
    storageLimit: number
    maxFileSize: number
    maxVaults: number | null
    versionHistoryDays: number
  }
  usage: {
    storageUsed: number
  }
  expiresAt: number | null
  canManageBilling: boolean
}

interface PaddleTransaction {
  id?: string
  status?: string
  customer_id?: string | null
  customerId?: string | null
  subscription_id?: string | null
  subscriptionId?: string | null
  custom_data?: Record<string, unknown> | null
  customData?: Record<string, unknown> | null
  billing_period?: { ends_at?: string | null; endsAt?: string | null } | null
  billingPeriod?: { ends_at?: string | null; endsAt?: string | null } | null
}

interface PaddleResponse<T> {
  data?: T
}

export function formatBillingStatus(
  entitlement: SyncEntitlement,
  email: string | null = null
): BillingStatusResponse {
  return {
    plan: entitlement.plan,
    cadence: entitlement.cadence ?? null,
    status: entitlement.status,
    source: entitlement.source,
    email,
    limits: {
      storageLimit: entitlement.storage_limit,
      maxFileSize: entitlement.max_file_size,
      maxVaults: entitlement.max_vaults,
      versionHistoryDays: entitlement.version_history_days
    },
    usage: {
      storageUsed: entitlement.storage_used
    },
    expiresAt: entitlement.expires_at,
    canManageBilling: Boolean(entitlement.paddle_customer_id)
  }
}

export async function getBillingStatus(
  db: D1Database,
  userId: string
): Promise<BillingStatusResponse> {
  const [entitlement, user] = await Promise.all([
    getSyncEntitlement(db, userId),
    getUserById(db, userId)
  ])
  return formatBillingStatus(entitlement, user?.email ?? null)
}

export async function reconcilePaddleTransaction(
  env: Bindings,
  userId: string,
  transactionId: string
): Promise<void> {
  const transaction = await fetchPaddleTransaction(env, transactionId)
  if (transaction.status !== 'completed') {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Transaction is not completed yet', 409)
  }

  const customData = readCustomData(transaction)
  const transactionUserId = asString(customData.userId ?? customData.user_id)
  const plan = normalizePlan(customData.plan)

  if (!transactionUserId || !plan) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Transaction is not a Memry sync checkout', 400)
  }
  if (transactionUserId !== userId) {
    throw new AppError(ErrorCodes.STORAGE_UNAUTHORIZED, 'Transaction belongs to another user', 403)
  }

  await upsertSyncEntitlement(env.DB, {
    userId,
    plan,
    cadence: normalizeCadence(customData.cadence),
    status: 'active',
    source: 'paddle',
    paddleCustomerId: asString(transaction.customer_id ?? transaction.customerId),
    paddleSubscriptionId: asString(transaction.subscription_id ?? transaction.subscriptionId),
    paddleTransactionId: asString(transaction.id) ?? transactionId,
    expiresAt: parseTimestamp(readBillingPeriodEndsAt(transaction))
  })
}

export async function createPaddlePortalSession(
  env: Bindings,
  userId: string
): Promise<{ portalUrl: string }> {
  const entitlement = await env.DB.prepare(
    `SELECT paddle_customer_id, paddle_subscription_id
     FROM sync_entitlements
     WHERE user_id = ?`
  )
    .bind(userId)
    .first<{ paddle_customer_id: string | null; paddle_subscription_id: string | null }>()

  if (!entitlement?.paddle_customer_id) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'Billing portal is not available until Paddle creates a customer',
      409
    )
  }

  const apiKey = normalizePaddleApiKey(env.PADDLE_API_KEY)
  if (!apiKey) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Paddle API key is not configured', 503)
  }

  const body =
    entitlement.paddle_subscription_id != null
      ? { subscription_ids: [entitlement.paddle_subscription_id] }
      : {}
  const response = await (env.fetch ?? fetch)(
    `${getPaddleBaseUrl(env)}/customers/${encodeURIComponent(
      entitlement.paddle_customer_id
    )}/portal-sessions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body)
    }
  )

  if (!response.ok) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Could not create billing portal session', 502)
  }

  const payload = (await response.json()) as PaddleResponse<{
    urls?: { general?: { overview?: string } }
  }>
  const portalUrl = payload.data?.urls?.general?.overview
  if (!portalUrl) {
    throw new AppError(
      ErrorCodes.INTERNAL_ERROR,
      'Paddle portal session did not include a URL',
      502
    )
  }

  return { portalUrl }
}

export interface PlanChangePreview {
  plan: SubscriptionPlan
  cadence: SubscriptionCadence
  isUpgrade: boolean
  /** `immediate` bills the prorated difference now; `next_billing_period` defers to renewal. */
  effective: 'immediate' | 'next_billing_period'
  /** Minor units (cents), as Paddle reports them. `null` when nothing is charged today. */
  immediateChargeAmount: string | null
  recurringAmount: string
  currencyCode: string
  nextBilledAt: string | null
}

interface PaddleSubscriptionItemPrice {
  id?: string
}

interface PaddleSubscription {
  id?: string
  status?: string
  custom_data?: Record<string, unknown> | null
  billing_cycle?: { interval?: string; frequency?: number } | null
  next_billed_at?: string | null
  items?: Array<{ price?: PaddleSubscriptionItemPrice | null }> | null
}

interface PaddlePreviewTotals {
  grand_total?: string
  currency_code?: string
}

interface PaddleSubscriptionPreview {
  next_billed_at?: string | null
  immediate_transaction?: { details?: { totals?: PaddlePreviewTotals } } | null
  recurring_transaction_details?: { totals?: PaddlePreviewTotals } | null
}

// Paddle subscription statuses that accept an items/price change. `canceled` and `paused` ones
// must not be patched — Paddle rejects some and silently resurrects others.
const CHANGEABLE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due'])

interface PlanChangeContext {
  subscriptionId: string
  currentPlan: SubscriptionPlan
  currentCadence: SubscriptionCadence
  currentPriceId: string | null
  targetPriceId: string
  isUpgrade: boolean
  prorationBillingMode: 'prorated_immediately' | 'prorated_next_billing_period'
  body: Record<string, unknown>
}

/**
 * Resolves everything needed to move an existing subscription onto a different plan/cadence, and
 * rejects every state where that is not a legal move. Shared by preview and apply so the two can
 * never disagree about the price, the proration mode, or the guards.
 */
async function buildPlanChange(
  env: Bindings,
  userId: string,
  plan: SubscriptionPlan,
  cadence: SubscriptionCadence
): Promise<PlanChangeContext> {
  const entitlement = await env.DB.prepare(
    'SELECT plan, paddle_subscription_id FROM sync_entitlements WHERE user_id = ?'
  )
    .bind(userId)
    .first<{ plan: SyncPlan; paddle_subscription_id: string | null }>()

  if (!entitlement?.paddle_subscription_id) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'No active subscription to change. Start a checkout instead.',
      409
    )
  }
  if (entitlement.plan === 'believer') {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'Believer is a one-time purchase and has no recurring plan to change.',
      409
    )
  }

  const subscriptionId = entitlement.paddle_subscription_id
  const subscription = await fetchPaddleSubscription(env, subscriptionId)
  if (!CHANGEABLE_SUBSCRIPTION_STATUSES.has(subscription.status ?? '')) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Subscription is ${subscription.status ?? 'unavailable'} and cannot change plan.`,
      409
    )
  }

  // Paddle is the source of truth for what is billing today: the entitlement row may predate the
  // cadence column, and its plan can lag a webhook.
  const currentPriceId = asString(subscription.items?.[0]?.price?.id)
  const currentCadence: SubscriptionCadence =
    subscription.billing_cycle?.interval === 'year' ? 'annual' : 'monthly'
  const currentPlan: SubscriptionPlan = entitlement.plan === 'pro' ? 'pro' : 'plus'

  const targetPriceId = resolveSubscriptionPriceId(env, plan, cadence)
  if (currentPriceId && currentPriceId === targetPriceId) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Already on this plan.', 409)
  }

  const isUpgrade = isPlanUpgrade({ plan: currentPlan, cadence: currentCadence }, { plan, cadence })

  return {
    subscriptionId,
    currentPlan,
    currentCadence,
    currentPriceId,
    targetPriceId,
    isUpgrade,
    prorationBillingMode: isUpgrade ? 'prorated_immediately' : 'prorated_next_billing_period',
    body: {
      items: [{ price_id: targetPriceId, quantity: 1 }],
      proration_billing_mode: isUpgrade ? 'prorated_immediately' : 'prorated_next_billing_period',
      // Paddle keeps the old custom_data unless it is resent, so an un-resent switch would leave
      // `cadence: 'monthly'` on an annual subscription and the webhook would write it back.
      custom_data: {
        app: 'memry',
        entitlement: 'sync',
        plan,
        cadence,
        userId
      }
    }
  }
}

export async function previewPlanChange(
  env: Bindings,
  userId: string,
  plan: SubscriptionPlan,
  cadence: SubscriptionCadence
): Promise<PlanChangePreview> {
  const change = await buildPlanChange(env, userId, plan, cadence)
  const preview = await paddleFetch<PaddleSubscriptionPreview>(
    env,
    // Paddle's preview mirrors the update operation, so it is PATCH, not POST. POST answers 405.
    `/subscriptions/${encodeURIComponent(change.subscriptionId)}/preview`,
    { method: 'PATCH', body: change.body },
    'Could not preview the plan change'
  )

  const immediate = preview.immediate_transaction?.details?.totals
  const recurring = preview.recurring_transaction_details?.totals

  return {
    plan,
    cadence,
    isUpgrade: change.isUpgrade,
    effective: change.isUpgrade ? 'immediate' : 'next_billing_period',
    immediateChargeAmount: immediate?.grand_total ?? null,
    recurringAmount: recurring?.grand_total ?? '0',
    currencyCode: recurring?.currency_code ?? immediate?.currency_code ?? 'USD',
    nextBilledAt: preview.next_billed_at ?? null
  }
}

/**
 * Applies the plan change. The webhook (`subscription.updated`) is what finally writes the
 * entitlement, but we write it here too so the response the user sees is already correct instead
 * of racing a webhook that can take seconds.
 */
export async function applyPlanChange(
  env: Bindings,
  userId: string,
  plan: SubscriptionPlan,
  cadence: SubscriptionCadence
): Promise<void> {
  const change = await buildPlanChange(env, userId, plan, cadence)
  const updated = await paddleFetch<PaddleSubscription>(
    env,
    `/subscriptions/${encodeURIComponent(change.subscriptionId)}`,
    { method: 'PATCH', body: change.body },
    'Could not change the plan'
  )

  // A downgrade only takes effect at renewal, so the entitlement keeps today's plan until the
  // subscription actually rolls over and Paddle sends the webhook.
  if (!change.isUpgrade) return

  await upsertSyncEntitlement(env.DB, {
    userId,
    plan,
    cadence,
    status: 'active',
    source: 'paddle',
    paddleSubscriptionId: change.subscriptionId,
    expiresAt: parseTimestamp(updated.next_billed_at)
  })
}

async function fetchPaddleSubscription(
  env: Bindings,
  subscriptionId: string
): Promise<PaddleSubscription> {
  return paddleFetch<PaddleSubscription>(
    env,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: 'GET' },
    'Could not fetch the subscription'
  )
}

async function paddleFetch<T>(
  env: Bindings,
  path: string,
  init: { method: string; body?: Record<string, unknown> },
  failureMessage: string
): Promise<T> {
  const apiKey = normalizePaddleApiKey(env.PADDLE_API_KEY)
  if (!apiKey) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Paddle API key is not configured', 503)
  }

  const response = await (env.fetch ?? fetch)(`${getPaddleBaseUrl(env)}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {})
  })

  if (response.status === 404) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'Subscription not found', 404)
  }
  if (!response.ok) {
    // The client only ever sees `failureMessage`, so a wrong API key and a rejected plan change
    // are indistinguishable without this. Paddle's error body carries neither key nor PII.
    const errorBody = await response.text()
    logger.error('Paddle API call failed', {
      path,
      method: init.method,
      status: response.status,
      body: errorBody.slice(0, 500)
    })
    throw new AppError(ErrorCodes.INTERNAL_ERROR, failureMessage, 502)
  }

  const payload = (await response.json()) as PaddleResponse<T>
  if (!payload.data) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, failureMessage, 502)
  }
  return payload.data
}

export interface InvoiceRow {
  id: string
  status: string
  billedAt: string | null
  amount: string
  currency: string
}

interface PaddleTransactionListItem {
  id: string
  status: string
  billed_at: string | null
  currency_code: string
  details?: { totals?: { grand_total?: string } }
}

export async function listPaddleInvoices(env: Bindings, userId: string): Promise<InvoiceRow[]> {
  const entitlement = await env.DB.prepare(
    'SELECT paddle_customer_id FROM sync_entitlements WHERE user_id = ?'
  )
    .bind(userId)
    .first<{ paddle_customer_id: string | null }>()
  if (!entitlement?.paddle_customer_id) {
    return []
  }
  const apiKey = normalizePaddleApiKey(env.PADDLE_API_KEY)
  if (!apiKey) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Paddle API key is not configured', 503)
  }
  const url =
    `${getPaddleBaseUrl(env)}/transactions` +
    `?customer_id=${encodeURIComponent(entitlement.paddle_customer_id)}` +
    `&per_page=30&order_by=billed_at[DESC]`
  const response = await (env.fetch ?? fetch)(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
  })
  if (!response.ok) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Could not list Paddle invoices', 502)
  }
  const payload = (await response.json()) as PaddleResponse<PaddleTransactionListItem[]>
  const items = payload.data ?? []
  return items.map((t) => ({
    id: t.id,
    status: t.status,
    billedAt: t.billed_at,
    amount: t.details?.totals?.grand_total ?? '0',
    currency: t.currency_code
  }))
}

export async function getPaddleInvoicePdfUrl(
  env: Bindings,
  userId: string,
  transactionId: string
): Promise<string> {
  // Verify the transaction belongs to this user's Paddle customer before
  // handing back a signed PDF URL — otherwise any authenticated user could
  // read another customer's invoice (name, address, amount) by guessing its
  // transaction id.
  const entitlement = await env.DB.prepare(
    'SELECT paddle_customer_id FROM sync_entitlements WHERE user_id = ?'
  )
    .bind(userId)
    .first<{ paddle_customer_id: string | null }>()
  if (!entitlement?.paddle_customer_id) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'Invoice not found', 404)
  }
  const transaction = await fetchPaddleTransaction(env, transactionId)
  const transactionCustomerId = transaction.customer_id ?? transaction.customerId ?? null
  if (transactionCustomerId !== entitlement.paddle_customer_id) {
    throw new AppError(ErrorCodes.STORAGE_UNAUTHORIZED, 'Invoice belongs to another account', 403)
  }

  const apiKey = normalizePaddleApiKey(env.PADDLE_API_KEY)
  if (!apiKey) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Paddle API key is not configured', 503)
  }
  const response = await (env.fetch ?? fetch)(
    `${getPaddleBaseUrl(env)}/transactions/${encodeURIComponent(transactionId)}/invoice`,
    { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } }
  )
  if (!response.ok) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Could not fetch invoice PDF', 502)
  }
  const payload = (await response.json()) as PaddleResponse<{ url?: string }>
  const url = payload.data?.url
  if (!url) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Invoice PDF URL missing', 502)
  }
  return url
}

async function fetchPaddleTransaction(
  env: Bindings,
  transactionId: string
): Promise<PaddleTransaction> {
  const apiKey = normalizePaddleApiKey(env.PADDLE_API_KEY)
  if (!apiKey) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Paddle API key is not configured', 503)
  }

  const response = await (env.fetch ?? fetch)(
    `${getPaddleBaseUrl(env)}/transactions/${encodeURIComponent(transactionId)}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      }
    }
  )

  if (response.status === 404) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'Paddle transaction not found', 404)
  }
  if (!response.ok) {
    throw new AppError(ErrorCodes.INTERNAL_ERROR, 'Could not fetch Paddle transaction', 502)
  }

  const payload = (await response.json()) as PaddleResponse<PaddleTransaction>
  if (!payload.data) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'Paddle transaction not found', 404)
  }
  return payload.data
}

function getPaddleBaseUrl(env: Pick<Bindings, 'PADDLE_ENVIRONMENT'>): string {
  return env.PADDLE_ENVIRONMENT === 'production'
    ? 'https://api.paddle.com'
    : 'https://sandbox-api.paddle.com'
}

function readCustomData(transaction: PaddleTransaction): Record<string, unknown> {
  const value = transaction.custom_data ?? transaction.customData
  if (!value || typeof value !== 'object') return {}
  if (value.app !== 'memry' || value.entitlement !== 'sync') return {}
  return value
}

function normalizePlan(value: unknown): SyncPlan | null {
  if (value === 'plus' || value === 'pro' || value === 'believer') return value
  return null
}

function normalizeCadence(value: unknown): SyncCadence | null {
  if (value === 'monthly' || value === 'annual' || value === 'lifetime') return value
  return null
}

function readBillingPeriodEndsAt(transaction: PaddleTransaction): string | null {
  const value = transaction.billing_period ?? transaction.billingPeriod
  if (!value || typeof value !== 'object') return null
  return asString(value.ends_at ?? value.endsAt)
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : Math.floor(timestamp / 1000)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function normalizePaddleApiKey(value: string | undefined): string | undefined {
  const trimmed = value
    ?.trim()
    .replace(/^Authorization:\s*/i, '')
    .replace(/^Bearer\s+/i, '')
  if (!trimmed) return undefined
  return trimmed.replace(/^["']|["']$/g, '')
}
