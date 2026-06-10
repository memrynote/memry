import { Hono } from 'hono'
import type { Context } from 'hono'

import { createLogger } from '../lib/logger'
import { applyPaddleWebhook, verifyPaddleWebhookSignature } from '../services/paddle-webhooks'
import { lookupChannel, verifyChannelToken } from '../services/google-webhooks'
import { captureBusinessEvent, captureServerLog, waitUntilWithPostHog } from '../services/posthog'
import type { AppContext } from '../types'

const log = createLogger('Webhooks')

export const webhooks = new Hono<AppContext>()

const captureWebhookLog = (
  c: Context<AppContext>,
  input: {
    level: 'info' | 'warn' | 'error'
    source: string
    action: string
    statusCode: number
  }
): void => {
  if (!c.env.POSTHOG_API_KEY || !c.env.POSTHOG_HOST) return
  try {
    c.executionCtx.waitUntil(
      captureServerLog(c.env, {
        ...input,
        method: c.req.method,
        path: c.req.path
      })
    )
  } catch {
    // Preserve webhook behavior if the runtime cannot schedule background work.
  }
}

webhooks.post('/paddle', async (c) => {
  const rawBody = await c.req.text()
  const signature = c.req.header('Paddle-Signature') ?? c.req.header('paddle-signature')

  try {
    await verifyPaddleWebhookSignature({
      rawBody,
      header: signature,
      secret: c.env.PADDLE_WEBHOOK_SECRET
    })
  } catch {
    log.warn('Invalid Paddle webhook signature')
    captureWebhookLog(c, {
      level: 'warn',
      source: 'PaddleWebhook',
      action: 'invalid_signature',
      statusCode: 401
    })
    return c.json({ error: 'Invalid Paddle signature' }, 401)
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    captureWebhookLog(c, {
      level: 'warn',
      source: 'PaddleWebhook',
      action: 'invalid_json',
      statusCode: 400
    })
    return c.json({ error: 'Invalid JSON payload' }, 400)
  }

  const result = await applyPaddleWebhook(c.env.DB, payload as never)

  if (result.processed && c.env.POSTHOG_API_KEY && c.env.POSTHOG_HOST) {
    const paddlePayload = payload as {
      event_type?: string
      eventType?: string
      data?: { customer_id?: string; customerId?: string }
    }
    const eventType = paddlePayload.event_type ?? paddlePayload.eventType ?? ''
    const customerId = paddlePayload.data?.customer_id ?? paddlePayload.data?.customerId ?? ''
    const subscriptionEvent =
      eventType === 'subscription.canceled'
        ? 'subscription_canceled'
        : eventType === 'subscription.paused'
          ? 'subscription_paused'
          : eventType.startsWith('subscription.') || eventType === 'transaction.completed'
            ? 'subscription_activated'
            : null
    if (subscriptionEvent) {
      try {
        c.executionCtx.waitUntil(
          captureBusinessEvent(
            c.env,
            subscriptionEvent,
            `paddle_customer_${customerId || 'unknown'}`,
            {
              paddle_event_type: eventType
            }
          )
        )
      } catch {
        // ExecutionContext not available in tests
      }
    }
  }

  return c.json({ success: true, ...result })
})

webhooks.post('/google-calendar', async (c) => {
  const channelId = c.req.header('x-goog-channel-id')
  const channelToken = c.req.header('x-goog-channel-token')
  const resourceState = c.req.header('x-goog-resource-state')

  if (!channelId || !channelToken || !resourceState) {
    captureWebhookLog(c, {
      level: 'warn',
      source: 'GoogleWebhook',
      action: 'missing_headers',
      statusCode: 400
    })
    return c.json({ error: 'Missing Google channel headers' }, 400)
  }

  const channel = await lookupChannel(c.env.DB, channelId)
  if (!channel) {
    log.warn('Unknown channel in Google webhook', { channelId })
    captureWebhookLog(c, {
      level: 'warn',
      source: 'GoogleWebhook',
      action: 'unknown_channel',
      statusCode: 401
    })
    return c.json({ error: 'Unknown channel' }, 401)
  }

  const nowSec = Math.floor(Date.now() / 1000)
  if (channel.expires_at <= nowSec) {
    log.info('Expired channel pinged by Google; returning 410 to stop retries', { channelId })
    captureWebhookLog(c, {
      level: 'info',
      source: 'GoogleWebhook',
      action: 'expired_channel',
      statusCode: 410
    })
    return c.json({ error: 'Channel expired' }, 410)
  }

  const ok = await verifyChannelToken(c.env.WEBHOOK_HMAC_KEY, channelToken, channel.token_hash)
  if (!ok) {
    log.warn('Channel token mismatch', { channelId })
    captureWebhookLog(c, {
      level: 'warn',
      source: 'GoogleWebhook',
      action: 'token_mismatch',
      statusCode: 401
    })
    return c.json({ error: 'Token mismatch' }, 401)
  }

  if (resourceState === 'sync') {
    return c.body(null, 200)
  }

  const doId = c.env.USER_SYNC_STATE.idFromName(channel.user_id)
  const stub = c.env.USER_SYNC_STATE.get(doId)
  waitUntilWithPostHog(
    c,
    stub.fetch(
      new Request(new URL('/broadcast', c.req.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          excludeDeviceId: '',
          type: 'calendar_changes_available',
          sourceId: channel.source_id
        })
      })
    ),
    { source: 'UserSyncState', action: 'calendar_webhook_broadcast_failed' }
  )

  return c.body(null, 200)
})
