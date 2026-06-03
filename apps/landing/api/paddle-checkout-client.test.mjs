import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildCheckoutSuccessUrl,
  buildMemryBillingCompleteUrl,
  buildMemryBillingStartUrl,
  parseCheckoutHash,
  readCheckoutResponse
} from '../src/lib/paddle-checkout.ts'

describe('paddle checkout response parsing', () => {
  it('turns non-JSON server failures into a checkout error', async () => {
    const response = new Response('A server error has occurred', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })

    await assert.rejects(readCheckoutResponse(response), /Could not start checkout/)
  })

  it('parses and strips desktop checkout intents from the URL fragment', () => {
    const href =
      'https://memrynote.com/pricing#checkout_plan=pro&checkout_cadence=annual&checkout_token=tok_123'
    const url = new URL(href)

    assert.deepEqual(parseCheckoutHash(url.hash), {
      plan: 'pro',
      cadence: 'annual',
      checkoutToken: 'tok_123'
    })
  })

  it('builds purchase handoff URLs without leaking checkout tokens into query params', () => {
    assert.equal(
      buildMemryBillingStartUrl('pro', 'annual'),
      'memry://billing/start?plan=pro&cadence=annual'
    )
    assert.equal(
      buildMemryBillingCompleteUrl('txn_123'),
      'memry://billing/complete?transactionId=txn_123'
    )

    const successUrl = buildCheckoutSuccessUrl('https://memrynote.com', 'txn_123')
    assert.equal(successUrl, 'https://memrynote.com/checkout/success?transactionId=txn_123')
    assert.equal(successUrl.includes('checkout_token'), false)
  })
})
