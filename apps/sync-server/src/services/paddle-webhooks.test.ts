import { describe, expect, it } from 'vitest'

import { createSqliteD1 } from '../__tests__/d1-sqlite'

import {
  applyPaddleWebhook,
  parsePaddleSignatureHeader,
  verifyPaddleWebhookSignature
} from './paddle-webhooks'

// Real SQLite over the real migrations: the webhook writes a Paddle grant and recomputes the
// entitlement, so the row the paid-sync gate reads is the thing to assert.
function createDb(options?: {
  existingEntitlement?: { user_id: string; plan: string } | null
  user?: null
}) {
  const { db, raw } = createSqliteD1()
  if (options?.user !== null) {
    raw
      .prepare(
        `INSERT INTO users (id, email, email_verified, auth_method, created_at, updated_at)
         VALUES ('user-1', 'user-1@example.com', 1, 'otp', 0, 0)`
      )
      .run()
  }
  if (options?.existingEntitlement) {
    raw
      .prepare(
        `INSERT INTO sync_entitlements (user_id, plan, status, source, paddle_subscription_id, updated_at)
         VALUES ('user-1', ?, 'active', 'paddle', 'sub_1', 0)`
      )
      .run(options.existingEntitlement.plan)
  }
  const entitlement = () =>
    raw.prepare('SELECT * FROM sync_entitlements WHERE user_id = ?').get('user-1') as
      Record<string, unknown> | undefined
  return { db, entitlement }
}

async function sign(secret: string, timestamp: number, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}:${rawBody}`)
  )
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

describe('Paddle webhook support', () => {
  it('parses Paddle-Signature headers with multiple h1 values', () => {
    expect(parsePaddleSignatureHeader('ts=123;h1=aaa;h1=bbb')).toEqual({
      timestamp: 123,
      signatures: ['aaa', 'bbb']
    })
  })

  it('verifies signed raw webhook bodies', async () => {
    const rawBody = JSON.stringify({ event_type: 'transaction.completed' })
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = await sign('secret', timestamp, rawBody)

    await expect(
      verifyPaddleWebhookSignature({
        rawBody,
        header: `ts=${timestamp};h1=${signature}`,
        secret: 'secret',
        now: timestamp
      })
    ).resolves.toBeUndefined()

    await expect(
      verifyPaddleWebhookSignature({
        rawBody: `${rawBody}\n`,
        header: `ts=${timestamp};h1=${signature}`,
        secret: 'secret',
        now: timestamp
      })
    ).rejects.toThrow(/Invalid Paddle signature/)
  })

  it('provisions Plus limits from an authenticated checkout custom data payload', async () => {
    const { db, entitlement } = createDb()

    await applyPaddleWebhook(db, {
      event_id: 'evt_1',
      event_type: 'transaction.completed',
      data: {
        id: 'txn_1',
        customer_id: 'ctm_1',
        subscription_id: 'sub_1',
        status: 'completed',
        custom_data: {
          app: 'memry',
          entitlement: 'sync',
          plan: 'plus',
          userId: 'user-1'
        }
      }
    })

    expect(entitlement()).toMatchObject({
      user_id: 'user-1',
      plan: 'plus',
      status: 'active',
      source: 'paddle'
    })
  })

  it('pauses sync access when Paddle sends a past_due subscription update', async () => {
    const { db, entitlement } = createDb()

    await applyPaddleWebhook(db, {
      event_id: 'evt_2',
      event_type: 'subscription.updated',
      data: {
        id: 'sub_1',
        customer_id: 'ctm_1',
        status: 'past_due',
        custom_data: {
          app: 'memry',
          entitlement: 'sync',
          plan: 'pro',
          userId: 'user-1'
        }
      }
    })

    expect(entitlement()).toMatchObject({
      user_id: 'user-1',
      plan: 'pro',
      status: 'past_due',
      source: 'paddle'
    })
  })

  it('updates an existing subscription even when Paddle omits checkout custom data', async () => {
    const { db, entitlement } = createDb({
      existingEntitlement: { user_id: 'user-1', plan: 'pro' }
    })

    await applyPaddleWebhook(db, {
      event_id: 'evt_3',
      event_type: 'subscription.canceled',
      data: {
        id: 'sub_1',
        customer_id: 'ctm_1',
        status: 'canceled'
      }
    })

    expect(entitlement()).toMatchObject({
      user_id: 'user-1',
      plan: 'pro',
      status: 'canceled',
      source: 'paddle'
    })
  })

  it('falls back to the existing subscription when Paddle omits the custom data plan', async () => {
    const { db, entitlement } = createDb({
      existingEntitlement: { user_id: 'user-1', plan: 'plus' }
    })

    await applyPaddleWebhook(db, {
      event_id: 'evt_4',
      event_type: 'subscription.paused',
      data: {
        id: 'sub_1',
        customer_id: 'ctm_1',
        status: 'paused',
        custom_data: {
          app: 'memry',
          entitlement: 'sync',
          userId: 'user-1'
        }
      }
    })

    expect(entitlement()).toMatchObject({
      user_id: 'user-1',
      plan: 'plus',
      status: 'paused',
      source: 'paddle'
    })
  })

  it('does not provision an entitlement when the checkout user is missing', async () => {
    const { db, entitlement } = createDb({ user: null })

    await expect(
      applyPaddleWebhook(db, {
        event_id: 'evt_5',
        event_type: 'transaction.completed',
        data: {
          id: 'txn_1',
          customer_id: 'ctm_1',
          subscription_id: 'sub_1',
          status: 'completed',
          custom_data: {
            app: 'memry',
            entitlement: 'sync',
            plan: 'plus',
            userId: 'missing-user'
          }
        }
      })
    ).resolves.toEqual({ processed: false, userId: null })

    expect(entitlement()).toBeUndefined()
  })

  it('does not map stale Standard custom data to a paid entitlement', async () => {
    const { db, entitlement } = createDb()

    await expect(
      applyPaddleWebhook(db, {
        event_id: 'evt_standard',
        event_type: 'transaction.completed',
        data: {
          id: 'txn_standard',
          customer_id: 'ctm_1',
          subscription_id: 'sub_standard',
          status: 'completed',
          custom_data: {
            app: 'memry',
            entitlement: 'sync',
            plan: 'standard',
            userId: 'user-1'
          }
        }
      })
    ).resolves.toEqual({ processed: false, userId: null })

    expect(entitlement()).toBeUndefined()
  })

  it('returns the resolved userId on successful processing', async () => {
    const { db } = createDb()

    const result = await applyPaddleWebhook(db, {
      event_id: 'evt_uid',
      event_type: 'transaction.completed',
      data: {
        id: 'txn_uid',
        customer_id: 'ctm_1',
        subscription_id: 'sub_uid',
        status: 'completed',
        custom_data: {
          app: 'memry',
          entitlement: 'sync',
          plan: 'plus',
          userId: 'user-1'
        }
      }
    })

    expect(result).toEqual({ processed: true, userId: 'user-1' })
  })
})
