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

  it('does not flag code declarations that contain token-like names', () => {
    const findings = scanTextForSecrets(
      'packages/contracts/src/ipc-channels.ts',
      [
        "SET_API_KEY: 'settings:setApiKey',",
        'refreshToken: () => Promise<{',
        '  success: boolean',
        '}>'
      ].join('\n')
    )

    assert.equal(findings.length, 0)
  })

  it('does not flag generic secret-shaped assignments in test files', () => {
    const findings = scanTextForSecrets(
      'apps/sync-server/src/routes/auth.test.ts',
      [
        "JWT_PRIVATE_KEY: 'mock-private-key'",
        "accessToken: 'mock-access-token'",
        'issueTokens: vi.fn()'
      ].join('\n')
    )

    assert.equal(findings.length, 0)
  })

  it('still flags real token patterns in test files', () => {
    const privateKeyMarker = '-----BEGIN ' + 'PRIVATE KEY-----abc'
    const findings = scanTextForSecrets(
      'apps/sync-server/src/routes/auth.test.ts',
      [`JWT_PRIVATE_KEY="${privateKeyMarker}"`, 'accessToken: "mock-access-token"'].join('\n')
    )

    assert.deepEqual(
      findings.map((finding) => finding.rule),
      ['private-key-block']
    )
  })

  it('does not scan binary asset paths', () => {
    const findings = scanTextForSecrets(
      'apps/landing/public/demos/inbox.mp4',
      'CLOUDFLARE_API_TOKEN=actual-secret-value'
    )

    assert.equal(findings.length, 0)
  })
})
