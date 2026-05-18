import { upsertSyncEntitlement, type SyncEntitlementStatus, type SyncPlan } from './entitlements'

interface PaddleEvent {
  event_id?: string
  event_type?: string
  eventId?: string
  eventType?: string
  data?: Record<string, unknown>
}

interface ParsedPaddleSignature {
  timestamp: number
  signatures: string[]
}

interface VerifyPaddleWebhookSignatureParams {
  rawBody: string
  header: string | null | undefined
  secret: string
  now?: number
}

interface EntitlementTarget {
  userId: string
  plan: SyncPlan
}

const SIGNATURE_TOLERANCE_SECONDS = 300
const SUPPORTED_EVENTS = new Set([
  'transaction.completed',
  'subscription.created',
  'subscription.updated',
  'subscription.resumed',
  'subscription.paused',
  'subscription.canceled',
  'subscription.past_due'
])

export function parsePaddleSignatureHeader(header: string): ParsedPaddleSignature {
  const parts = header.split(';').map((part) => part.trim())
  const timestamp = Number(parts.find((part) => part.startsWith('ts='))?.slice(3))
  const signatures = parts
    .filter((part) => part.startsWith('h1='))
    .map((part) => part.slice(3))
    .filter(Boolean)

  return { timestamp, signatures }
}

export async function verifyPaddleWebhookSignature({
  rawBody,
  header,
  secret,
  now = Math.floor(Date.now() / 1000)
}: VerifyPaddleWebhookSignatureParams): Promise<void> {
  if (!header || !secret) {
    throw new Error('Invalid Paddle signature')
  }

  const parsed = parsePaddleSignatureHeader(header)
  if (!Number.isFinite(parsed.timestamp) || parsed.signatures.length === 0) {
    throw new Error('Invalid Paddle signature')
  }

  if (Math.abs(now - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new Error('Invalid Paddle signature')
  }

  const expected = await hmacSha256Hex(secret, `${parsed.timestamp}:${rawBody}`)
  if (!parsed.signatures.some((signature) => timingSafeEqualHex(signature, expected))) {
    throw new Error('Invalid Paddle signature')
  }
}

export async function applyPaddleWebhook(
  db: D1Database,
  event: PaddleEvent
): Promise<{ processed: boolean }> {
  const eventType = event.event_type ?? event.eventType
  if (!eventType || !SUPPORTED_EVENTS.has(eventType)) {
    return { processed: false }
  }

  const eventId = event.event_id ?? event.eventId ?? asString(event.data?.id)
  if (eventId) {
    const existing = await db
      .prepare('SELECT id FROM paddle_webhook_events WHERE id = ?')
      .bind(eventId)
      .first<{ id: string }>()

    if (existing) {
      return { processed: false }
    }
  }

  const data = event.data ?? {}
  const target = await resolveEntitlementTarget(db, data)
  if (!target) {
    return { processed: false }
  }

  await upsertSyncEntitlement(db, {
    userId: target.userId,
    plan: target.plan,
    status: normalizeStatus(eventType, asString(data.status)),
    source: 'paddle',
    paddleCustomerId: asString(data.customer_id ?? data.customerId),
    paddleSubscriptionId: asString(data.subscription_id ?? data.subscriptionId ?? data.id),
    paddleTransactionId: eventType.startsWith('transaction.') ? asString(data.id) : null,
    expiresAt: parseTimestamp(readBillingPeriodEndsAt(data))
  })

  if (eventId) {
    await db
      .prepare('INSERT INTO paddle_webhook_events (id, event_type, processed_at) VALUES (?, ?, ?)')
      .bind(eventId, eventType, Math.floor(Date.now() / 1000))
      .run()
  }

  return { processed: true }
}

async function resolveEntitlementTarget(
  db: D1Database,
  data: Record<string, unknown>
): Promise<EntitlementTarget | null> {
  const customData = readCustomData(data)
  const userId = asString(customData.userId ?? customData.user_id ?? customData.memryUserId)
  const customPlan = normalizePlan(customData.plan)

  if (userId && customPlan) {
    const user = await db
      .prepare('SELECT id FROM users WHERE id = ?')
      .bind(userId)
      .first<{ id: string }>()
    if (user) return { userId: user.id, plan: customPlan }
  }

  const subscriptionId = asString(data.subscription_id ?? data.subscriptionId ?? data.id)
  if (subscriptionId) {
    const entitlement = await db
      .prepare('SELECT user_id, plan FROM sync_entitlements WHERE paddle_subscription_id = ?')
      .bind(subscriptionId)
      .first<{ user_id: string; plan: SyncPlan }>()
    const plan = normalizePlan(entitlement?.plan)
    if (entitlement && plan) return { userId: entitlement.user_id, plan }
  }

  return null
}

function readCustomData(data: Record<string, unknown>): Record<string, unknown> {
  const value = data.custom_data ?? data.customData
  if (!value || typeof value !== 'object') return {}

  const customData = value as Record<string, unknown>
  if (customData.app !== 'memry' || customData.entitlement !== 'sync') return {}
  return customData
}

function normalizePlan(value: unknown): SyncPlan | null {
  if (value === 'plus' || value === 'pro' || value === 'believer') return value
  if (value === 'standard') return 'plus'
  return null
}

function normalizeStatus(eventType: string, rawStatus: string | null): SyncEntitlementStatus {
  if (eventType === 'transaction.completed') return 'active'
  if (eventType === 'subscription.paused') return 'paused'
  if (eventType === 'subscription.canceled') return 'canceled'
  if (eventType === 'subscription.past_due') return 'past_due'

  switch (rawStatus) {
    case 'active':
    case 'trialing':
      return 'active'
    case 'past_due':
      return 'past_due'
    case 'paused':
      return 'paused'
    case 'canceled':
    case 'deleted':
      return 'canceled'
    default:
      return 'inactive'
  }
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : Math.floor(timestamp / 1000)
}

function readBillingPeriodEndsAt(data: Record<string, unknown>): unknown {
  const value = data.current_billing_period ?? data.currentBillingPeriod
  if (!value || typeof value !== 'object') return null
  return (value as Record<string, unknown>).ends_at ?? (value as Record<string, unknown>).endsAt
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function timingSafeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false

  let diff = 0
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i)
  }
  return diff === 0
}
