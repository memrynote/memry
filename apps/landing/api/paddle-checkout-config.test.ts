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

  it('takes userId from the identity token and plan/cadence from the request body', async () => {
    const checkoutToken = await signPaddleCheckoutToken(
      { userId: 'user-1', exp: 1_800_000_000 },
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )
    const intent = await parsePaddleCheckoutIntent(
      { checkoutToken, plan: 'pro', cadence: 'annual', userId: 'attacker' },
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

  it('ignores plan/cadence baked into a legacy token and uses the body instead', async () => {
    const legacyToken = await signPaddleCheckoutToken(
      { userId: 'user-1', exp: 1_800_000_000, plan: 'plus', cadence: 'monthly' } as never,
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )
    const intent = await parsePaddleCheckoutIntent(
      { checkoutToken: legacyToken, plan: 'pro', cadence: 'annual' },
      env,
      1_700_000_000
    )

    assert.deepEqual(intent, { plan: 'pro', cadence: 'annual', userId: 'user-1' })
  })

  it('always maps Believer to the lifetime price', async () => {
    const checkoutToken = await signPaddleCheckoutToken(
      { userId: 'user-1', exp: 1_800_000_000 },
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )
    const intent = await parsePaddleCheckoutIntent(
      { checkoutToken, plan: 'believer', cadence: 'monthly' },
      env,
      1_700_000_000
    )

    assert.deepEqual(intent, { plan: 'believer', cadence: 'lifetime', userId: 'user-1' })
    assert.equal(getPaddleCheckoutConfig(intent, env).priceId, 'pri_believer_lifetime')
  })

  it('rejects unsupported or missing checkout fields', async () => {
    const checkoutToken = await signPaddleCheckoutToken(
      { userId: 'user-1', exp: 1_800_000_000 },
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )
    assert.equal(
      await parsePaddleCheckoutIntent(
        { checkoutToken, plan: 'enterprise', cadence: 'monthly' },
        env,
        1_700_000_000
      ),
      null
    )
    assert.equal(
      await parsePaddleCheckoutIntent(
        { checkoutToken, plan: 'plus', cadence: 'lifetime' },
        env,
        1_700_000_000
      ),
      null
    )
    assert.equal(await parsePaddleCheckoutIntent({ plan: 'plus', cadence: 'monthly' }, env), null)
    assert.equal(await parsePaddleCheckoutIntent({ checkoutToken }, env, 1_700_000_000), null)
  })

  it('rejects tampered or expired identity tokens', async () => {
    const checkoutToken = await signPaddleCheckoutToken(
      { userId: 'user-1', exp: 1_700_000_010 },
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )

    assert.equal(
      await parsePaddleCheckoutIntent(
        { checkoutToken, plan: 'plus', cadence: 'monthly' },
        env,
        1_700_000_010
      ),
      null
    )
    assert.equal(
      await parsePaddleCheckoutIntent(
        { checkoutToken: `${checkoutToken}tampered`, plan: 'plus', cadence: 'monthly' },
        env
      ),
      null
    )
  })

  it('rejects a verifiable token that carries no userId', async () => {
    const checkoutToken = await signPaddleCheckoutToken(
      { userId: '', exp: 1_800_000_000 },
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )

    assert.equal(
      await parsePaddleCheckoutIntent(
        { checkoutToken, plan: 'pro', cadence: 'annual' },
        env,
        1_700_000_000
      ),
      null
    )
  })

  it('names the missing price variable for server configuration errors', async () => {
    const checkoutToken = await signPaddleCheckoutToken(
      { userId: 'user-1', exp: 1_800_000_000 },
      env.PADDLE_CHECKOUT_TOKEN_SECRET
    )
    const intent = await parsePaddleCheckoutIntent(
      { checkoutToken, plan: 'plus', cadence: 'monthly' },
      env,
      1_700_000_000
    )

    assert.throws(() => getPaddleCheckoutConfig(intent, {}), /PADDLE_PRICE_PLUS_MONTHLY/)
  })
})
