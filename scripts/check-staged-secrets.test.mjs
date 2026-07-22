import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { scanTextForSecrets } from './check-staged-secrets.mjs'

const rules = (text) => scanTextForSecrets('apps/example/Component.tsx', text).map((f) => f.rule)

describe('check-staged-secrets JSX handling', () => {
  it('ignores token-named JSX props whose value is a code reference', () => {
    const jsx = [
      '<CheckoutPanel',
      '  token={webToken}',
      '  onTokenMissing={NO_TOKEN_NOTICE}',
      '/>'
    ].join('\n')
    assert.deepEqual(rules(jsx), [])
  })

  it('still flags a token-named prop assigned a quoted string literal', () => {
    assert.deepEqual(rules('  token={"supersecretvalue123"}'), ['high-risk-secret-assignment'])
  })
})

describe('check-staged-secrets numeric values', () => {
  it('ignores a token-named variable reset to a number', () => {
    assert.deepEqual(rules('  tokenIssuedAt = 0'), [])
  })

  it('still flags a token-named prop assigned a long quoted number-like string', () => {
    assert.deepEqual(rules('  token={"01234567890123456789"}'), ['high-risk-secret-assignment'])
  })
})

describe('check-staged-secrets constructor values', () => {
  it('ignores a secret-named key assigned a constructor call over a code reference', () => {
    assert.deepEqual(rules('  signingSecretKey: new Uint8Array(signingSecretKey),'), [])
  })

  it('still flags a constructor call containing a string literal', () => {
    assert.deepEqual(rules("  signingSecretKey: new Buffer('hunter2secretvalue')"), [
      'high-risk-secret-assignment'
    ])
  })
})
