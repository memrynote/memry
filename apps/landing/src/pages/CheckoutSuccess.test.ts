import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

describe('checkout success page', () => {
  it('tells paid users payment completed and to sign in in the app for device sync', () => {
    const source = readFileSync(new URL('./CheckoutSuccess.tsx', import.meta.url), 'utf8')

    assert.match(source, /Payment completed/)
    assert.match(source, /Sign in to the app to use sync across all your devices/)
  })
})
