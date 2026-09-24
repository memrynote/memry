import { describe, it, expect } from 'vitest'
import { LEGACY_RECORD_SYNC_ITEM_TYPES } from '@memry/contracts/sync-api'
import { LEGACY_SYNC_SUBSCRIPTION, resolveSyncSubscription, SYNC_TYPES_HEADER } from './sync-types'

describe('resolveSyncSubscription', () => {
  const legacy = [...LEGACY_RECORD_SYNC_ITEM_TYPES]
  const recordTypes = (header: string | null | undefined) =>
    resolveSyncSubscription(header).recordTypes

  it('exposes the header name', () => {
    expect(SYNC_TYPES_HEADER).toBe('X-Memry-Sync-Types')
  })

  // THE regression that protects shipped binaries.
  it('falls back to the frozen legacy list when the header is absent', () => {
    expect(resolveSyncSubscription(undefined)).toEqual({ recordTypes: legacy, noteBodies: false })
    expect(resolveSyncSubscription(null)).toEqual({ recordTypes: legacy, noteBodies: false })
    expect(resolveSyncSubscription('')).toEqual({ recordTypes: legacy, noteBodies: false })
    expect(LEGACY_SYNC_SUBSCRIPTION).toEqual({ recordTypes: legacy, noteBodies: false })
  })

  it('returns only the declared types when the header is present', () => {
    expect(recordTypes('note,task')).toEqual(['note', 'task'])
  })

  it('tolerates whitespace and empty segments', () => {
    expect(recordTypes(' note , task ,, ')).toEqual(['note', 'task'])
  })

  it('drops types the server does not support', () => {
    expect(recordTypes('note,bogus,task')).toEqual(['note', 'task'])
  })

  // A header IS present here — the client declared types, we just couldn't
  // parse any of them. That must resolve to empty (serve nothing), never to
  // the legacy list: falling back to legacy would hand a declaring client 15
  // types it never asked for, which is the exact bug negotiation prevents.
  it('resolves to empty when the header is present but nothing in it is recognized', () => {
    expect(resolveSyncSubscription('bogus,nonsense')).toEqual({
      recordTypes: [],
      noteBodies: false
    })
  })

  it('dedupes repeated types while preserving first-seen order', () => {
    expect(recordTypes('note,note,task')).toEqual(['note', 'task'])
  })

  it('bounds the resolved list length even under a long duplicate header', () => {
    const result = recordTypes('note,'.repeat(100))
    expect(result.length).toBeLessThanOrEqual(15)
  })

  // #2295
  it('recognises note_body as a body subscription and never as a record type', () => {
    expect(resolveSyncSubscription('note,note_body,task')).toEqual({
      recordTypes: ['note', 'task'],
      noteBodies: true
    })
    expect(resolveSyncSubscription('note_body')).toEqual({ recordTypes: [], noteBodies: true })
    expect(resolveSyncSubscription('note,task').noteBodies).toBe(false)
  })
})
