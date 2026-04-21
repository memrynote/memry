import { describe, expect, it } from 'vitest'

import { parseExtractCertHashArgs } from './cert-hash-cli'

describe('parseExtractCertHashArgs', () => {
  it('uses defaults when no arguments are provided', () => {
    expect(parseExtractCertHashArgs([])).toEqual({
      hostname: 'sync.memrynote.com',
      port: 443
    })
  })

  it('accepts a hostname argument', () => {
    expect(parseExtractCertHashArgs(['sync-staging.memrynote.com'])).toEqual({
      hostname: 'sync-staging.memrynote.com',
      port: 443
    })
  })

  it('ignores pnpm argument separator before the hostname', () => {
    expect(parseExtractCertHashArgs(['--', 'sync-staging.memrynote.com'])).toEqual({
      hostname: 'sync-staging.memrynote.com',
      port: 443
    })
  })

  it('parses an explicit port after the hostname', () => {
    expect(parseExtractCertHashArgs(['--', 'sync-staging.memrynote.com', '8443'])).toEqual({
      hostname: 'sync-staging.memrynote.com',
      port: 8443
    })
  })

  it('rejects non-numeric ports', () => {
    expect(() => parseExtractCertHashArgs(['sync-staging.memrynote.com', 'abc'])).toThrow(
      'Invalid port: abc'
    )
  })
})
