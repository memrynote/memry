import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { scanTextForSecrets } from './check-staged-secrets.mjs'

const rules = (text) => scanTextForSecrets('apps/example/Component.tsx', text).map((f) => f.rule)
const envRules = (text) => scanTextForSecrets('deploy/service.env', text).map((f) => f.rule)

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

describe('check-staged-secrets function values', () => {
  it('ignores a token-named key assigned an arrow function with parameters', () => {
    assert.deepEqual(rules('  getAccessToken: (force) => mintToken({ clientId, force }),'), [])
  })

  it('still flags an arrow function body containing a string literal', () => {
    assert.deepEqual(rules("  getAccessToken: (force) => 'hunter2secretvalue'"), [
      'high-risk-secret-assignment'
    ])
  })

  it('ignores an async arrow whose body is a call with string arguments', () => {
    assert.deepEqual(
      rules(
        "  hashToken: async (plaintext) => createHmac('sha256', hmacKey).update(plaintext).digest('hex'),"
      ),
      []
    )
  })

  it('still flags an async arrow returning a bare string literal', () => {
    assert.deepEqual(rules("  hashToken: async () => 'hunter2secretvalue'"), [
      'high-risk-secret-assignment'
    ])
  })
})

describe('check-staged-secrets keyword word boundaries', () => {
  it('ignores an fts5 tokenize= option in a CREATE VIRTUAL TABLE block', () => {
    const ddl = [
      'db.run(sql`',
      '  CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5(',
      '    id UNINDEXED,',
      '    title,',
      '    content,',
      '    tags,',
      "    tokenize='porter unicode61'",
      '  )',
      '`)'
    ].join('\n')

    assert.deepEqual(
      scanTextForSecrets('apps/desktop/src/main/database/fts.ts', ddl).map((f) => f.rule),
      []
    )
  })

  it('ignores identifiers that only contain a sensitive keyword inside a longer word', () => {
    assert.deepEqual(rules("  tokenizer: 'porter unicode61',"), [])
    assert.deepEqual(rules("  passwordless: 'magic-link-flow',"), [])
  })

  it('still flags a snake-case token key assigned a credential literal', () => {
    assert.deepEqual(rules("  API_TOKEN = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'"), [
      'high-risk-secret-assignment'
    ])
  })

  it('still flags a camelCase token key assigned a credential literal', () => {
    assert.deepEqual(rules("  accessToken: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',"), [
      'high-risk-secret-assignment'
    ])
  })

  it('still flags a consecutive-caps token key assigned a credential literal', () => {
    assert.deepEqual(rules("  APIToken: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',"), [
      'high-risk-secret-assignment'
    ])
  })

  it('still flags env-style credential assignments', () => {
    assert.deepEqual(envRules('API_TOKEN=a1b2c3d4e5f67890abcdef'), ['high-risk-secret-assignment'])
    assert.deepEqual(envRules('export DB_PASSWORD=hunter2hunter2'), [
      'high-risk-secret-assignment'
    ])
  })
})

describe('check-staged-secrets fallback chains', () => {
  it('ignores a secret-named key assigned a nullish chain over code references', () => {
    assert.deepEqual(rules('  refreshToken: tokens.refreshToken ?? refreshToken,'), [])
  })

  it('ignores a logical-or chain over code references', () => {
    assert.deepEqual(rules('  apiKeyValue: config.apiKey || fallbackKey,'), [])
  })

  it('still flags a fallback chain ending in a quoted literal', () => {
    assert.deepEqual(rules("  refreshToken: tokens.refreshToken ?? 'hunter2secretvalue'"), [
      'high-risk-secret-assignment'
    ])
  })
})
