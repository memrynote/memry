import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  getCheckoutSummary,
  getSelectableCadences,
  normalizeCadenceForPlan,
  parseCheckoutToken
} from './checkout-summary.ts'

describe('checkout summary', () => {
  it('lists selectable cadences per plan', () => {
    assert.deepEqual(getSelectableCadences('plus'), ['monthly', 'annual'])
    assert.deepEqual(getSelectableCadences('pro'), ['monthly', 'annual'])
    assert.deepEqual(getSelectableCadences('believer'), ['lifetime'])
  })

  it('forces believer to lifetime and recurring plans away from lifetime', () => {
    assert.equal(normalizeCadenceForPlan('believer', 'monthly'), 'lifetime')
    assert.equal(normalizeCadenceForPlan('plus', 'lifetime'), 'annual')
    assert.equal(normalizeCadenceForPlan('pro', 'monthly'), 'monthly')
  })

  it('builds a summary for a recurring annual plan', () => {
    assert.deepEqual(getCheckoutSummary('pro', 'annual'), {
      planName: 'Pro',
      amount: 96,
      currency: 'USD',
      billingFrequencyLabel: 'Yearly',
      lineItemLabel: 'Pro yearly subscription'
    })
  })

  it('builds a summary for a monthly plan', () => {
    assert.deepEqual(getCheckoutSummary('plus', 'monthly'), {
      planName: 'Plus',
      amount: 5,
      currency: 'USD',
      billingFrequencyLabel: 'Monthly',
      lineItemLabel: 'Plus monthly subscription'
    })
  })

  it('builds a lifetime summary for believer regardless of requested cadence', () => {
    assert.deepEqual(getCheckoutSummary('believer', 'monthly'), {
      planName: 'Believer',
      amount: 500,
      currency: 'USD',
      billingFrequencyLabel: 'One-time',
      lineItemLabel: 'Believer lifetime'
    })
  })

  it('parses the identity token from the URL hash', () => {
    assert.equal(parseCheckoutToken('#token=abc.def'), 'abc.def')
    assert.equal(parseCheckoutToken('#'), null)
    assert.equal(parseCheckoutToken('#token='), null)
    assert.equal(parseCheckoutToken(''), null)
  })
})
