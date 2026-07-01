import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { safeNextPath } from './next-path'

describe('safeNextPath', () => {
  it('keeps same-origin relative paths', () => {
    assert.equal(
      safeNextPath('/checkout?plan=pro&cadence=annual'),
      '/checkout?plan=pro&cadence=annual'
    )
    assert.equal(safeNextPath('/account/billing'), '/account/billing')
  })

  it('falls back for empty or missing values', () => {
    assert.equal(safeNextPath(null), '/account/profile')
    assert.equal(safeNextPath(undefined), '/account/profile')
    assert.equal(safeNextPath(''), '/account/profile')
  })

  it('rejects open-redirect attempts', () => {
    assert.equal(safeNextPath('https://evil.com'), '/account/profile')
    assert.equal(safeNextPath('//evil.com'), '/account/profile')
    assert.equal(safeNextPath('/\\evil.com'), '/account/profile')
    assert.equal(safeNextPath('javascript:alert(1)'), '/account/profile')
  })

  it('honors a custom fallback', () => {
    assert.equal(safeNextPath(null, '/checkout'), '/checkout')
  })
})
