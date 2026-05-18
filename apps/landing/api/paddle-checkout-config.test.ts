import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  getPaddleCheckoutConfig,
  normalizePaddleApiKey,
  parsePaddleCheckoutIntent,
  signPaddleCheckoutToken
} from './paddle-checkout-config.ts'

const env = {
  PADDLE_PRICE_PLUS_MONTHLY: 'pri_plus_monthly',
  PADDLE_PRICE_PLUS_ANNUAL: 'pri_plus_annual',
  PADDLE_PRICE_PRO_MONTHLY: 'pri_pro_monthly',
  PADDLE_PRICE_PRO_ANNUAL: 'pri_pro_annual',
  PADDLE_PRICE_BELIEVER_LIFETIME: 'pri_believer_lifetime',
  PADDLE_CHECKOUT_TOKEN_SECRET: 'checkout-secret'
}

describe('paddle checkout config', () => {
  it('normalizes common Paddle API key paste formats', () => {
    assert.equal(normalizePaddleApiKey('  "pdl_live_apikey_example"  '), 'pdl_live_apikey_example')
    assert.equal(normalizePaddleApiKey('Bearer pdl_live_apikey_example'), 'pdl_live_apikey_example')
    assert.equal(
      normalizePaddleApiKey('Authorization: Bearer pdl_live_apikey_example'),
      'pdl_live_apikey_example'
    )
    assert.equal(normalizePaddleApiKey(''), undefined)
  })

  it('uses an emitted JavaScript helper import for Vercel functions', () => {
    const source = readFileSync(new URL('./paddle-checkout.ts', import.meta.url), 'utf8')

    assert.doesNotMatch(source, /from ['"]\.\/paddle-checkout-config\.ts['"]/)
    assert.match(source, /from ['"]\.\/paddle-checkout-config\.js['"]/)
  })

  it('maps a recurring plan, cadence, and signed checkout token to the configured Paddle price', async () => {
    const checkoutToken = await signPaddleCheckoutToken(
      {
        plan: 'pro',
        cadence: 'annual',
        userId: 'user-1',
        exp: 1_800_000_000
      },
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )
    const intent = await parsePaddleCheckoutIntent(
      {
        checkoutToken,
        plan: 'pro',
        cadence: 'annual',
        userId: 'attacker'
      },
      env,
      1_700_000_000
    )

    assert.deepEqual(intent, { plan: 'pro', cadence: 'annual', userId: 'user-1' })
    assert.deepEqual(getPaddleCheckoutConfig(intent, env), {
      priceId: 'pri_pro_annual',
      customData: {
        app: 'memry',
        entitlement: 'sync',
        plan: 'pro',
        cadence: 'annual',
        userId: 'user-1'
      }
    })
  })

  it('always maps Believer to the lifetime price', async () => {
    const checkoutToken = await signPaddleCheckoutToken(
      {
        plan: 'believer',
        cadence: 'monthly',
        userId: 'user-1',
        exp: 1_800_000_000
      },
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )
    const intent = await parsePaddleCheckoutIntent({ checkoutToken }, env, 1_700_000_000)

    assert.deepEqual(intent, { plan: 'believer', cadence: 'lifetime', userId: 'user-1' })
    assert.equal(getPaddleCheckoutConfig(intent, env).priceId, 'pri_believer_lifetime')
  })

  it('rejects unsupported checkout requests', async () => {
    assert.equal(
      await parsePaddleCheckoutIntent(
        {
          plan: 'enterprise',
          cadence: 'monthly',
          userId: 'user-1'
        },
        env
      ),
      null
    )
    assert.equal(
      await parsePaddleCheckoutIntent({ plan: 'plus', cadence: 'lifetime', userId: 'user-1' }, env),
      null
    )
    assert.equal(await parsePaddleCheckoutIntent({ plan: 'plus', cadence: 'monthly' }, env), null)
  })

  it('rejects tampered or expired checkout tokens', async () => {
    const checkoutToken = await signPaddleCheckoutToken(
      {
        plan: 'plus',
        cadence: 'monthly',
        userId: 'user-1',
        exp: 1_700_000_010
      },
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )

    assert.equal(await parsePaddleCheckoutIntent({ checkoutToken }, env, 1_700_000_010), null)
    assert.equal(
      await parsePaddleCheckoutIntent({ checkoutToken: `${checkoutToken}tampered` }, env),
      null
    )
  })

  it('names the missing price variable for server configuration errors', async () => {
    const checkoutToken = await signPaddleCheckoutToken(
      {
        plan: 'plus',
        cadence: 'monthly',
        userId: 'user-1',
        exp: 1_800_000_000
      },
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )
    const intent = await parsePaddleCheckoutIntent({ checkoutToken }, env, 1_700_000_000)

    assert.throws(() => getPaddleCheckoutConfig(intent, {}), /PADDLE_PRICE_PLUS_MONTHLY/)
  })
})
