import { Hono } from 'hono'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createTestChain,
  signAppleJws,
  trustedRoot,
  type TestChain
} from '../__tests__/apple-test-chain'
import { createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { errorHandler } from '../lib/errors'
import { writePaddleGrant } from '../services/billing-grants'
import type { AppContext } from '../types'
import { appStoreBilling } from './app-store-billing'
import { auth } from './auth'
import { webhooks } from './webhooks'

const USER_ID = '6f9d2c1e-3b4a-4c5d-8e7f-0a1b2c3d4e5f'
const OTHER_USER_ID = '11111111-2222-4333-8444-555555555555'
const BUNDLE_ID = 'com.memrynote.app'
const DAY_MS = 86_400_000

vi.mock('../lib/apple-root-ca', async () => {
  const { trustedRoot: root } = await import('../__tests__/apple-test-chain')
  return {
    get APPLE_ROOT_CA_G3_DER() {
      return root.der
    }
  }
})

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<void>
  ) => {
    c.set('userId', USER_ID)
    await next()
  }
}))

const app = new Hono<AppContext>()
app.onError(errorHandler)
app.route('/auth', auth)
app.route('/auth/billing/app-store', appStoreBilling)
app.route('/webhooks', webhooks)

let chain: TestChain
let sqlite: SqliteD1

beforeAll(async () => {
  chain = await createTestChain()
  trustedRoot.der = chain.rootDer
})

beforeEach(() => {
  sqlite = createSqliteD1()
  for (const id of [USER_ID, OTHER_USER_ID]) {
    sqlite.raw
      .prepare(
        `INSERT INTO users (id, email, email_verified, auth_method, created_at, updated_at)
         VALUES (?, ?, 1, 'otp', 0, 0)`
      )
      .run(id, `${id}@example.com`)
  }
})

afterEach(() => {
  sqlite.close()
})

const env = () => ({
  DB: sqlite.db,
  ENVIRONMENT: 'staging',
  APPLE_BUNDLE_ID: BUNDLE_ID,
  APPLE_APP_STORE_ENVIRONMENTS: 'Sandbox,Xcode',
  PADDLE_CHECKOUT_TOKEN_SECRET: 'checkout-secret',
  TELEMETRY_HMAC_KEY: 'telemetry'
})

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {}
} as unknown as ExecutionContext

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: '2000000001',
    originalTransactionId: '2000000000',
    bundleId: BUNDLE_ID,
    productId: 'com.memrynote.app.pro.monthly',
    environment: 'Sandbox',
    appAccountToken: USER_ID,
    purchaseDate: Date.now(),
    expiresDate: Date.now() + 30 * DAY_MS,
    signedDate: Date.now(),
    ...overrides
  }
}

async function postTransaction(payload: Record<string, unknown>, signingChain = chain) {
  const signedTransactionInfo = await signAppleJws(signingChain, payload)
  return app.request(
    '/auth/billing/app-store/transactions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedTransactionInfo })
    },
    env(),
    executionCtx
  )
}

async function postNotification(
  notificationType: string,
  tx: Record<string, unknown> | null,
  options: { uuid?: string; subtype?: string; autoRenewStatus?: number } = {}
) {
  const data: Record<string, unknown> = { bundleId: BUNDLE_ID, environment: 'Sandbox' }
  if (tx) data.signedTransactionInfo = await signAppleJws(chain, tx)
  if (options.autoRenewStatus !== undefined) {
    data.signedRenewalInfo = await signAppleJws(chain, {
      originalTransactionId: tx?.originalTransactionId,
      autoRenewStatus: options.autoRenewStatus,
      signedDate: Date.now()
    })
  }
  const signedPayload = await signAppleJws(chain, {
    notificationType,
    subtype: options.subtype,
    notificationUUID: options.uuid ?? crypto.randomUUID(),
    signedDate: Date.now(),
    data
  })
  return app.request(
    '/webhooks/app-store',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedPayload })
    },
    env(),
    executionCtx
  )
}

const entitlement = (userId = USER_ID) =>
  sqlite.raw.prepare('SELECT * FROM sync_entitlements WHERE user_id = ?').get(userId) as
    | Record<string, unknown>
    | undefined

const grantCount = () =>
  (sqlite.raw.prepare('SELECT COUNT(*) AS n FROM app_store_grants').get() as { n: number }).n

describe('POST /auth/billing/app-store/transactions', () => {
  it('grants the purchased plan and reports the App Store as the billing store', async () => {
    const res = await postTransaction(transaction())

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      plan: 'pro',
      cadence: 'monthly',
      status: 'active',
      source: 'app_store',
      store: 'app_store',
      manageUrl: 'https://apps.apple.com/account/subscriptions',
      willRenew: null,
      canManageBilling: false,
      appAccountToken: USER_ID
    })
  })

  it('is idempotent: replaying the same transaction leaves one grant and the same state', async () => {
    const tx = transaction()
    await postTransaction(tx)
    const first = entitlement()
    const res = await postTransaction(tx)

    expect(res.status).toBe(200)
    expect(grantCount()).toBe(1)
    expect(entitlement()).toMatchObject({
      plan: first?.plan,
      status: first?.status,
      expires_at: first?.expires_at
    })
  })

  it('rejects a transaction whose chain does not end at the pinned root', async () => {
    const rogue = await createTestChain()
    const res = await postTransaction(transaction(), rogue)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'BILLING_APP_STORE_INVALID' }
    })
    expect(grantCount()).toBe(0)
  })

  it('rejects a transaction for another bundle id', async () => {
    const res = await postTransaction(transaction({ bundleId: 'com.example.other' }))
    expect(res.status).toBe(400)
    expect(grantCount()).toBe(0)
  })

  it("rejects a transaction bought under another account's appAccountToken", async () => {
    const res = await postTransaction(transaction({ appAccountToken: OTHER_USER_ID }))
    expect(res.status).toBe(403)
    expect(grantCount()).toBe(0)
  })

  it('rejects Xcode environment transactions even when the env var lists Xcode', async () => {
    const res = await postTransaction(transaction({ environment: 'Xcode' }))
    expect(res.status).toBe(400)
    expect(grantCount()).toBe(0)
  })

  it('grants believer for life from the non-consumable', async () => {
    const res = await postTransaction(
      transaction({ productId: 'com.memrynote.app.believer', expiresDate: undefined })
    )
    await expect(res.json()).resolves.toMatchObject({
      plan: 'believer',
      cadence: 'lifetime',
      status: 'active',
      expiresAt: null
    })
  })
})

describe('POST /webhooks/app-store', () => {
  it('maps a first notification to the user through appAccountToken', async () => {
    const res = await postNotification('SUBSCRIBED', transaction(), { autoRenewStatus: 1 })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ processed: true, userId: USER_ID })
    expect(entitlement()).toMatchObject({
      plan: 'pro',
      status: 'active',
      source: 'app_store',
      will_renew: 1
    })
  })

  it('revokes access on REFUND', async () => {
    await postNotification('SUBSCRIBED', transaction())
    const res = await postNotification(
      'REFUND',
      transaction({ revocationDate: Date.now(), signedDate: Date.now() + 1 })
    )

    expect(res.status).toBe(200)
    expect(entitlement()).toMatchObject({ source: 'app_store', status: 'canceled' })
  })

  it('moves a failed renewal in grace period to past_due', async () => {
    await postNotification('SUBSCRIBED', transaction())
    await postNotification('DID_FAIL_TO_RENEW', transaction({ signedDate: Date.now() + 1 }), {
      subtype: 'GRACE_PERIOD'
    })
    expect(entitlement()).toMatchObject({ status: 'past_due' })
  })

  it('ignores a duplicate notificationUUID', async () => {
    const uuid = crypto.randomUUID()
    await postNotification('SUBSCRIBED', transaction(), { uuid })
    const res = await postNotification(
      'REFUND',
      transaction({ revocationDate: Date.now(), signedDate: Date.now() + 1 }),
      { uuid }
    )

    await expect(res.json()).resolves.toMatchObject({ processed: false })
    expect(entitlement()).toMatchObject({ status: 'active' })
  })

  it('acknowledges TEST notifications without touching billing', async () => {
    const res = await postNotification('TEST', null)
    expect(res.status).toBe(200)
    expect(entitlement()).toBeUndefined()
  })

  it('rejects a notification whose signature chain is not trusted', async () => {
    const rogue = await createTestChain()
    const signedPayload = await signAppleJws(rogue, {
      notificationType: 'TEST',
      notificationUUID: crypto.randomUUID(),
      signedDate: Date.now(),
      data: { bundleId: BUNDLE_ID, environment: 'Sandbox' }
    })
    const res = await app.request(
      '/webhooks/app-store',
      { method: 'POST', body: JSON.stringify({ signedPayload }) },
      env(),
      executionCtx
    )
    expect(res.status).toBe(400)
  })
})

describe('recomputeEntitlement across stores', () => {
  it('keeps the active App Store grant when Paddle cancels', async () => {
    await writePaddleGrant(sqlite.db, {
      userId: USER_ID,
      plan: 'plus',
      cadence: 'monthly',
      status: 'active',
      paddleCustomerId: 'ctm_1',
      paddleSubscriptionId: 'sub_1'
    })
    await postTransaction(transaction())
    await writePaddleGrant(sqlite.db, { userId: USER_ID, plan: 'plus', status: 'canceled' })

    expect(entitlement()).toMatchObject({
      plan: 'pro',
      status: 'active',
      source: 'app_store',
      paddle_subscription_id: 'sub_1'
    })
  })

  it('falls back to the active Paddle grant when the App Store purchase is refunded', async () => {
    await postTransaction(transaction({ productId: 'com.memrynote.app.believer' }))
    await writePaddleGrant(sqlite.db, {
      userId: USER_ID,
      plan: 'plus',
      cadence: 'annual',
      status: 'active',
      paddleSubscriptionId: 'sub_1'
    })
    expect(entitlement()).toMatchObject({ plan: 'believer', source: 'app_store' })

    await postNotification(
      'REFUND',
      transaction({
        productId: 'com.memrynote.app.believer',
        revocationDate: Date.now(),
        signedDate: Date.now() + 1
      })
    )

    expect(entitlement()).toMatchObject({
      plan: 'plus',
      cadence: 'annual',
      status: 'active',
      source: 'paddle'
    })
  })
})

describe('Paddle routes while the App Store bills', () => {
  beforeEach(async () => {
    await postTransaction(transaction())
  })

  it('marks the checkout token as already subscribed', async () => {
    const res = await app.request('/auth/checkout-token', { method: 'POST' }, env(), executionCtx)
    const { checkoutToken } = (await res.json()) as { checkoutToken: string }
    const payload = JSON.parse(Buffer.from(checkoutToken.split('.')[0], 'base64url').toString())
    expect(payload).toMatchObject({ hasSubscription: true, plan: 'pro' })
  })

  it.each([
    ['/auth/billing/change-plan', { plan: 'pro', cadence: 'annual' }],
    ['/auth/billing/change-plan/preview', { plan: 'pro', cadence: 'annual' }],
    ['/auth/billing/portal-session', {}]
  ])('%s answers 409 BILLING_MANAGED_BY_APP_STORE', async (path, body) => {
    const res = await app.request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      },
      env(),
      executionCtx
    )
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'BILLING_MANAGED_BY_APP_STORE' }
    })
  })
})
