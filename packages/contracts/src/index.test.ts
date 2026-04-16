/**
 * Contracts Barrel Smoke Test
 *
 * The contracts package exposes its surface through subpath imports, so the
 * root index.ts is intentionally near-empty to avoid duplicate symbol exports
 * across independently named modules. This test pins that design by:
 *  - loading the barrel module without side-effects
 *  - asserting it remains importable and does not add unexpected exports
 */

import { describe, it, expect } from 'vitest'
import * as contracts from './index'

describe('contracts barrel', () => {
  it('loads without error', () => {
    expect(contracts).toBeDefined()
    expect(typeof contracts).toBe('object')
  })

  it('exposes no named exports (subpath imports are the public API)', () => {
    const keys = Object.keys(contracts).filter((key) => key !== 'default')
    expect(keys).toEqual([])
  })
})
