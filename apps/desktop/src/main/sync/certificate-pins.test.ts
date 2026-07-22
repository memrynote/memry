import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SYNC_CERT_HOSTNAME,
  checkCertificatePinConfig,
  getConfiguredSyncCertHostname,
  getPinnedCertificateHashesForHostname,
  getConfiguredPinnedCertificateHashes
} from './certificate-pins'

const REAL_PIN = 'sha256/LUkXdP3NZ4aBKbFriRvHtAP2pzTAO9sMqzOnl24KZV4='
const PLACEHOLDER_PIN = 'sha256/PLACEHOLDER_PRIMARY_CERT_HASH_BASE64'

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

describe('checkCertificatePinConfig', () => {
  it('accepts a host whose pins are real SPKI hashes', () => {
    const result = checkCertificatePinConfig({
      hostname: 'sync-staging.memrynote.com',
      pins: [REAL_PIN]
    })

    expect(result.level).toBe('ok')
  })

  it('warns instead of failing when a host still has placeholder pins', () => {
    const result = checkCertificatePinConfig({
      hostname: DEFAULT_SYNC_CERT_HOSTNAME,
      pins: [PLACEHOLDER_PIN]
    })

    expect(result.level).toBe('warn')
    expect(result.message).toContain(DEFAULT_SYNC_CERT_HOSTNAME)
  })

  it('fails on placeholder pins in strict mode', () => {
    const result = checkCertificatePinConfig({
      hostname: DEFAULT_SYNC_CERT_HOSTNAME,
      pins: [PLACEHOLDER_PIN],
      strict: true
    })

    expect(result.level).toBe('error')
  })

  it('fails when the host has no pin entry at all', () => {
    const result = checkCertificatePinConfig({ hostname: 'example.com', pins: [] })

    expect(result.level).toBe('error')
    expect(result.message).toContain('example.com')
  })

  it('fails on a malformed pin even outside strict mode', () => {
    const result = checkCertificatePinConfig({
      hostname: 'sync-staging.memrynote.com',
      pins: ['sha256/not-a-real-hash']
    })

    expect(result.level).toBe('error')
  })

  it('fails when a pin is missing the sha256 prefix', () => {
    const result = checkCertificatePinConfig({
      hostname: 'sync-staging.memrynote.com',
      pins: [REAL_PIN.replace('sha256/', '')]
    })

    expect(result.level).toBe('error')
  })
})
