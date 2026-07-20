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

  // A header IS present here — the client declared types, we just couldn't
  // parse any of them. That must resolve to empty (serve nothing), never to
  // the legacy list: falling back to legacy would hand a declaring client 15
  // types it never asked for, which is the exact bug negotiation prevents.
  it('resolves to empty when the header is present but nothing in it is recognized', () => {
    expect(resolveSyncTypes('bogus,nonsense')).toEqual([])
  })

  it('dedupes repeated types while preserving first-seen order', () => {
    expect(resolveSyncTypes('note,note,task')).toEqual(['note', 'task'])
  })

  it('bounds the resolved list length even under a long duplicate header', () => {
    const result = resolveSyncTypes('note,'.repeat(100))
    expect(result.length).toBeLessThanOrEqual(15)
  })
})
