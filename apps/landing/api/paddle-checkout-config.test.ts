import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  getPaddleCheckoutConfig,
  normalizePaddleApiKey,
  parsePaddleCheckoutIntent
} from './paddle-checkout-config.ts'

const env = {
  PADDLE_PRICE_PLUS_MONTHLY: 'pri_plus_monthly',
  PADDLE_PRICE_PLUS_ANNUAL: 'pri_plus_annual',
  PADDLE_PRICE_PRO_MONTHLY: 'pri_pro_monthly',
  PADDLE_PRICE_PRO_ANNUAL: 'pri_pro_annual',
  PADDLE_PRICE_BELIEVER_LIFETIME: 'pri_believer_lifetime'
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

  it('maps a recurring plan and cadence to the configured Paddle price', () => {
    const intent = parsePaddleCheckoutIntent({ plan: 'pro', cadence: 'annual' })

    assert.deepEqual(intent, { plan: 'pro', cadence: 'annual' })
    assert.deepEqual(getPaddleCheckoutConfig(intent, env), {
      priceId: 'pri_pro_annual',
      customData: {
        app: 'memry',
        entitlement: 'sync',
        plan: 'pro',
        cadence: 'annual'
      }
    })
  })

  it('always maps Believer to the lifetime price', () => {
    const intent = parsePaddleCheckoutIntent({ plan: 'believer', cadence: 'monthly' })

    assert.deepEqual(intent, { plan: 'believer', cadence: 'lifetime' })
    assert.equal(getPaddleCheckoutConfig(intent, env).priceId, 'pri_believer_lifetime')
  })

  it('rejects unsupported checkout requests', () => {
    assert.equal(parsePaddleCheckoutIntent({ plan: 'enterprise', cadence: 'monthly' }), null)
    assert.equal(parsePaddleCheckoutIntent({ plan: 'plus', cadence: 'lifetime' }), null)
  })

  it('names the missing price variable for server configuration errors', () => {
    const intent = parsePaddleCheckoutIntent({ plan: 'plus', cadence: 'monthly' })

    assert.throws(() => getPaddleCheckoutConfig(intent, {}), /PADDLE_PRICE_PLUS_MONTHLY/)
  })
})
