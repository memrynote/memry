import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { scanTextForSecrets } from './check-staged-secrets.mjs'

describe('staged secret scanner', () => {
  it('flags PEM private keys and high-risk assignment names', () => {
    const privateKeyMarker = '-----BEGIN ' + 'PRIVATE KEY-----abc'
    const findings = scanTextForSecrets(
      'apps/sync-server/.dev.vars.example',
      [
        `JWT_PRIVATE_KEY="${privateKeyMarker}"`,
        'CLOUDFLARE_API_TOKEN=cf_token_value_1234567890'
      ].join('\n')
    )

    assert.deepEqual(
      findings.map((finding) => finding.rule),
      ['private-key-block', 'high-risk-secret-assignment']
    )
  })

  it('does not flag documented placeholders', () => {
    const findings = scanTextForSecrets(
      'apps/sync-server/.dev.vars.example',
      [
        'JWT_PRIVATE_KEY="replace-me-with-local-private-key"',
        'GOOGLE_CLIENT_SECRET="your-google-client-secret"'
      ].join('\n')
    )

    assert.equal(findings.length, 0)
  })
})
