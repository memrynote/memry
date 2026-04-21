import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SYNC_CERT_HOSTNAME,
  getConfiguredSyncCertHostname,
  getPinnedCertificateHashesForHostname,
  getConfiguredPinnedCertificateHashes
} from './certificate-pins'

describe('certificate-pins', () => {
  it('uses the default hostname when no sync server url is configured', () => {
    expect(getConfiguredSyncCertHostname()).toBe(DEFAULT_SYNC_CERT_HOSTNAME)
  })

  it('uses the sync server hostname from the configured url', () => {
    expect(getConfiguredSyncCertHostname('https://sync-staging.memrynote.com')).toBe(
      'sync-staging.memrynote.com'
    )
  })

  it('returns the staging pin set for the staging sync host', () => {
    expect(getConfiguredPinnedCertificateHashes('https://sync-staging.memrynote.com')).toEqual([
      'sha256/LUkXdP3NZ4aBKbFriRvHtAP2pzTAO9sMqzOnl24KZV4='
    ])
  })

  it('returns the configured host pin set directly', () => {
    expect(getPinnedCertificateHashesForHostname('sync-staging.memrynote.com')).toEqual([
      'sha256/LUkXdP3NZ4aBKbFriRvHtAP2pzTAO9sMqzOnl24KZV4='
    ])
  })

  it('returns an empty pin set for unknown hosts', () => {
    expect(getPinnedCertificateHashesForHostname('example.com')).toEqual([])
  })
})
