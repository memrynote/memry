import { AppError, ErrorCodes } from '../lib/errors'
import {
  getSyncEntitlement,
  upsertSyncEntitlement,
  type SyncEntitlement,
  type SyncPlan
} from './entitlements'
import { getUserById } from './user'
import type { Bindings } from '../types'

export interface BillingStatusResponse {
  plan: SyncEntitlement['plan']
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
  transactionId: string
): Promise<string> {
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

function readBillingPeriodEndsAt(transaction: PaddleTransaction): unknown {
  const value = transaction.billing_period ?? transaction.billingPeriod
  if (!value || typeof value !== 'object') return null
  return value.ends_at ?? value.endsAt
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
