import { describe, expect, it, vi } from 'vitest'

import {
  applyPaddleWebhook,
  parsePaddleSignatureHeader,
  verifyPaddleWebhookSignature
} from './paddle-webhooks'

function createDb(options?: {
  existingEntitlement?: Record<string, unknown> | null
  user?: Record<string, unknown> | null
}) {
  const statements: Array<{ sql: string; bindings: unknown[] }> = []
  const db = {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        bindings: [] as unknown[],
        bind: vi.fn((...args: unknown[]) => {
          stmt.bindings = args
          statements.push({ sql, bindings: args })
          return stmt
        }),
        first: vi.fn(async () => {
          if (sql.includes('FROM paddle_webhook_events')) return null
          if (sql.includes('FROM users')) return options?.user === null ? null : { id: 'user-1' }
          if (sql.includes('FROM sync_entitlements')) return options?.existingEntitlement ?? null
          return null
        }),
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } })
      }
      return stmt
    })
  }
  return { db: db as unknown as D1Database, statements }
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
    const { db, statements } = createDb()

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

    const entitlementWrite = statements.find((entry) =>
      entry.sql.includes('INSERT INTO sync_entitlements')
    )
    expect(entitlementWrite?.bindings).toEqual(
      expect.arrayContaining(['user-1', 'plus', 'active', 'paddle'])
    )
  })

  it('pauses sync access when Paddle sends a past_due subscription update', async () => {
    const { db, statements } = createDb()

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

    const entitlementWrite = statements.find((entry) =>
      entry.sql.includes('INSERT INTO sync_entitlements')
    )
    expect(entitlementWrite?.bindings).toEqual(
      expect.arrayContaining(['user-1', 'pro', 'past_due', 'paddle'])
    )
  })

  it('updates an existing subscription even when Paddle omits checkout custom data', async () => {
    const { db, statements } = createDb({
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

    const entitlementWrite = statements.find((entry) =>
      entry.sql.includes('INSERT INTO sync_entitlements')
    )
    expect(entitlementWrite?.bindings).toEqual(
      expect.arrayContaining(['user-1', 'pro', 'canceled', 'paddle'])
    )
  })

  it('falls back to the existing subscription when Paddle omits the custom data plan', async () => {
    const { db, statements } = createDb({
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

    const entitlementWrite = statements.find((entry) =>
      entry.sql.includes('INSERT INTO sync_entitlements')
    )
    expect(entitlementWrite?.bindings).toEqual(
      expect.arrayContaining(['user-1', 'plus', 'paused', 'paddle'])
    )
  })

  it('does not provision an entitlement when the checkout user is missing', async () => {
    const { db, statements } = createDb({ user: null })

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
    ).resolves.toEqual({ processed: false })

    expect(statements.some((entry) => entry.sql.includes('INSERT INTO sync_entitlements'))).toBe(
      false
    )
  })
})
