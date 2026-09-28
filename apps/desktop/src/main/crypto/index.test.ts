import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'

import { constantTimeEqual } from './index'

beforeAll(async () => {
  await sodium.ready
})

describe('constantTimeEqual', () => {
  it('returns true for byte-identical arrays', () => {
    // #given two equal Uint8Arrays
    const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

    // #then comparison is true
    expect(constantTimeEqual(a, b)).toBe(true)
  })

  it('returns false when a single byte differs', () => {
    // #given two arrays differing by exactly one byte
    const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 9])

    // #then comparison is false
    expect(constantTimeEqual(a, b)).toBe(false)
  })

  it('returns false for arrays of different lengths', () => {
    // #given arrays of mismatched lengths
    const a = new Uint8Array([1, 2, 3, 4])
    const b = new Uint8Array([1, 2, 3, 4, 5])

    // #then comparison short-circuits to false
    expect(constantTimeEqual(a, b)).toBe(false)
  })

  it('returns true for two empty arrays', () => {
    // #given two zero-length arrays
    const a = new Uint8Array(0)
    const b = new Uint8Array(0)

    // #then they are considered equal
    expect(constantTimeEqual(a, b)).toBe(true)
  })

  it('returns false when the first byte differs', () => {
    // #given arrays differing only at index 0
    const a = new Uint8Array([0xff, 0, 0, 0])
    const b = new Uint8Array([0x00, 0, 0, 0])

    // #then comparison is false
    expect(constantTimeEqual(a, b)).toBe(false)
  })
})
