import { describe, expect, it } from 'vitest'

import type { KeychainEntry } from '@memry/contracts/crypto'

import { normalizeDeviceSuffix, resolveKeychainAccount } from './keychain-account'

const MASTER_KEY: KeychainEntry = { service: 'com.memry.test', account: 'master-key' }

describe('normalizeDeviceSuffix', () => {
  it('collapses a per-worktree plain-dev hash to a stable "dev"', () => {
    expect(normalizeDeviceSuffix('dev-1a2b3c4d')).toBe('dev')
    expect(normalizeDeviceSuffix('dev-deadbeef')).toBe('dev')
  })

  it('leaves explicit dev devices A/B/C untouched', () => {
    expect(normalizeDeviceSuffix('A')).toBe('A')
    expect(normalizeDeviceSuffix('B')).toBe('B')
    expect(normalizeDeviceSuffix('C')).toBe('C')
  })

  it('leaves e2e device ids untouched', () => {
    expect(normalizeDeviceSuffix('e2e-3f9c1a2b-A')).toBe('e2e-3f9c1a2b-A')
  })

  it('treats missing/empty as no suffix (production)', () => {
    expect(normalizeDeviceSuffix(undefined)).toBeUndefined()
    expect(normalizeDeviceSuffix('')).toBeUndefined()
  })

  it('does not collapse non-hex or wrong-length dev-* values', () => {
    expect(normalizeDeviceSuffix('dev-XYZ')).toBe('dev-XYZ')
    expect(normalizeDeviceSuffix('dev-1a2b')).toBe('dev-1a2b')
    expect(normalizeDeviceSuffix('dev')).toBe('dev')
  })
})

describe('resolveKeychainAccount', () => {
  it('returns the bare account in production (no MEMRY_DEVICE)', () => {
    expect(resolveKeychainAccount(MASTER_KEY, undefined)).toBe('master-key')
  })

  it('gives every plain-dev worktree the SAME account', () => {
    const a = resolveKeychainAccount(MASTER_KEY, 'dev-1a2b3c4d')
    const b = resolveKeychainAccount(MASTER_KEY, 'dev-99887766')
    expect(a).toBe('master-key-dev')
    expect(b).toBe('master-key-dev')
    expect(a).toBe(b)
  })

  it('keeps explicit devices on their own account', () => {
    expect(resolveKeychainAccount(MASTER_KEY, 'A')).toBe('master-key-A')
  })
})
