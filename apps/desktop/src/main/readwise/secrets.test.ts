import { afterEach, describe, expect, it } from 'vitest'

import { readwiseTokenAccountKey } from './secrets'

const original = process.env.MEMRY_DEVICE

afterEach(() => {
  if (original === undefined) delete process.env.MEMRY_DEVICE
  else process.env.MEMRY_DEVICE = original
})

describe('readwiseTokenAccountKey', () => {
  it('is scoped to the vault', () => {
    delete process.env.MEMRY_DEVICE
    expect(readwiseTokenAccountKey('/vaults/a')).not.toBe(readwiseTokenAccountKey('/vaults/b'))
    expect(readwiseTokenAccountKey('/vaults/a')).toBe(readwiseTokenAccountKey('/vaults/a'))
  })

  it('carries the MEMRY_DEVICE suffix so two profiles keep separate entries', () => {
    delete process.env.MEMRY_DEVICE
    const plain = readwiseTokenAccountKey('/vaults/a')
    process.env.MEMRY_DEVICE = 'b'
    expect(readwiseTokenAccountKey('/vaults/a')).toBe(`${plain}-b`)
  })

  it('does not put the vault path in the key', () => {
    delete process.env.MEMRY_DEVICE
    expect(readwiseTokenAccountKey('/Users/someone/vault')).not.toContain('someone')
  })
})
