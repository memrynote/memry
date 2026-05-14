import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { readCheckoutResponse } from '../src/lib/paddle-checkout.ts'

describe('paddle checkout response parsing', () => {
  it('turns non-JSON server failures into a checkout error', async () => {
    const response = new Response('A server error has occurred', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })

    await assert.rejects(readCheckoutResponse(response), /Could not start checkout/)
  })
})
