import { describe, it, expect } from 'vitest'
import { LEGACY_RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import { resolveSyncTypes, SYNC_TYPES_HEADER } from './sync-types'

describe('resolveSyncTypes', () => {
  const legacy = [...LEGACY_RECORD_SYNC_ITEM_TYPES]

  it('exposes the header name', () => {
    expect(SYNC_TYPES_HEADER).toBe('X-Memry-Sync-Types')
  })

  // THE regression that protects shipped binaries.
  it('falls back to the frozen legacy list when the header is absent', () => {
    expect(resolveSyncTypes(undefined)).toEqual(legacy)
    expect(resolveSyncTypes(null)).toEqual(legacy)
    expect(resolveSyncTypes('')).toEqual(legacy)
  })

  it('returns only the declared types when the header is present', () => {
    expect(resolveSyncTypes('note,task')).toEqual(['note', 'task'])
  })

  it('tolerates whitespace and empty segments', () => {
    expect(resolveSyncTypes(' note , task ,, ')).toEqual(['note', 'task'])
  })

  it('drops types the server does not support', () => {
    expect(resolveSyncTypes('note,bogus,task')).toEqual(['note', 'task'])
  })

  it('falls back to legacy when nothing in the header is recognized', () => {
    expect(resolveSyncTypes('bogus,nonsense')).toEqual(legacy)
  })
})
