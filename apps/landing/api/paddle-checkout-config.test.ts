import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getPaddleCheckoutConfig, parsePaddleCheckoutIntent } from './paddle-checkout-config.ts'

const env = {
  PADDLE_PRICE_STANDARD_MONTHLY: 'pri_standard_monthly',
  PADDLE_PRICE_STANDARD_ANNUAL: 'pri_standard_annual',
  PADDLE_PRICE_PLUS_MONTHLY: 'pri_plus_monthly',
  PADDLE_PRICE_PLUS_ANNUAL: 'pri_plus_annual',
  PADDLE_PRICE_BELIEVER_LIFETIME: 'pri_believer_lifetime'
}

describe('paddle checkout config', () => {
  it('maps a recurring plan and cadence to the configured Paddle price', () => {
    const intent = parsePaddleCheckoutIntent({ plan: 'plus', cadence: 'annual' })

    assert.deepEqual(intent, { plan: 'plus', cadence: 'annual' })
    assert.deepEqual(getPaddleCheckoutConfig(intent, env), {
      priceId: 'pri_plus_annual',
      customData: {
        app: 'memry',
        entitlement: 'sync',
        plan: 'plus',
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
    assert.equal(parsePaddleCheckoutIntent({ plan: 'standard', cadence: 'lifetime' }), null)
  })

  it('names the missing price variable for server configuration errors', () => {
    const intent = parsePaddleCheckoutIntent({ plan: 'standard', cadence: 'monthly' })

    assert.throws(() => getPaddleCheckoutConfig(intent, {}), /PADDLE_PRICE_STANDARD_MONTHLY/)
  })
})
