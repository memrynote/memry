import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { resolveSyncServerUrl } from './config.ts'

describe('resolveSyncServerUrl', () => {
  it('defaults to the production sync server in a prod build', () => {
    assert.equal(resolveSyncServerUrl(undefined, true), 'https://sync.memrynote.com')
  })

  it('defaults to localhost in dev', () => {
    assert.equal(resolveSyncServerUrl(undefined, false), 'http://localhost:8787')
  })

  it('honors an explicit override and strips the trailing slash', () => {
    assert.equal(
      resolveSyncServerUrl('https://sync-staging.memrynote.com/', true),
      'https://sync-staging.memrynote.com'
    )
  })

  it('treats a blank override as unset', () => {
    assert.equal(resolveSyncServerUrl('   ', true), 'https://sync.memrynote.com')
  })
})

describe('landing CSP', () => {
  it('allows connecting to the production sync server', () => {
    const vercel = JSON.parse(
      readFileSync(new URL('../../../vercel.json', import.meta.url), 'utf8')
    )
    const cspHeader = vercel.headers
      .flatMap((entry) => entry.headers)
      .find((h) => h.key === 'Content-Security-Policy')

    assert.ok(cspHeader, 'Content-Security-Policy header not found in vercel.json')
    assert.match(
      cspHeader.value,
      /connect-src[^;]*https:\/\/sync\.memrynote\.com/,
      'connect-src must allow the sync server so /auth fetches are not CSP-blocked'
    )
  })
})
