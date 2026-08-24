import { describe, expect, it } from 'vitest'

import { compareVersions, parseClientIdentity } from './client-identity'

describe('parseClientIdentity', () => {
  it('parses platform and version', () => {
    expect(parseClientIdentity('ios/1.0.0')).toEqual({ platform: 'ios', version: '1.0.0' })
  })

  it('parses the optional build suffix without folding it into the version', () => {
    expect(parseClientIdentity('ios/1.0.0+42')).toEqual({
      platform: 'ios',
      version: '1.0.0',
      build: '42'
    })
  })

  it('accepts every declared platform', () => {
    for (const platform of ['ios', 'android', 'desktop'] as const) {
      expect(parseClientIdentity(`${platform}/2.3.4`)?.platform).toBe(platform)
    }
  })

  it('trims surrounding whitespace', () => {
    expect(parseClientIdentity('  ios/1.2.3  ')?.version).toBe('1.2.3')
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace only', '   ']
  ])('returns null when the header is %s', (_label, raw) => {
    expect(parseClientIdentity(raw)).toBeNull()
  })

  // Every one of these must be treated as ABSENT rather than rejected: a header
  // parser bug must not be able to lock a paying user out of their own vault.
  it.each([
    ['no slash', 'ios-1.0.0'],
    ['no version', 'ios/'],
    ['two-part version', 'ios/1.0'],
    ['non-numeric version', 'ios/one.0.0'],
    ['unknown platform', 'windows-phone/1.0.0'],
    ['uppercase platform', 'IOS/1.0.0'],
    ['leading junk', 'x ios/1.0.0'],
    ['pre-release identifier', 'ios/1.0.0-beta.1']
  ])('treats a %s header as absent', (_label, raw) => {
    expect(parseClientIdentity(raw)).toBeNull()
  })
})

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.0.0', '1.0.1', -1],
    ['1.1.0', '1.0.9', 1],
    ['2.0.0', '1.99.99', 1],
    ['1.9.0', '1.10.0', -1]
  ])('compares %s against %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected)
  })

  it('returns null when either side is not a plain triple', () => {
    expect(compareVersions('1.0', '1.0.0')).toBeNull()
    expect(compareVersions('1.0.0', 'latest')).toBeNull()
  })
})
