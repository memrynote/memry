import { describe, expect, it } from 'vitest'
import {
  formatRelationUri,
  parseRelationUri,
  isRelationValue,
  parseRelationValue
} from './relation-uri'

describe('relation URIs', () => {
  it('formats and parses a round trip', () => {
    const uri = formatRelationUri('note', 'nte_abc123')
    expect(uri).toBe('memry://note/nte_abc123')
    expect(parseRelationUri(uri)).toEqual({ kind: 'note', id: 'nte_abc123' })
  })

  it('parses each supported kind', () => {
    expect(parseRelationUri('memry://task/tsk_1')).toEqual({ kind: 'task', id: 'tsk_1' })
    expect(parseRelationUri('memry://event/evt_1')).toEqual({ kind: 'event', id: 'evt_1' })
  })

  it('parses the kinds added after the first release', () => {
    expect(parseRelationUri('memry://canvas/cnv_1')).toEqual({ kind: 'canvas', id: 'cnv_1' })
    expect(parseRelationUri('memry://journal/2026-05-10')).toEqual({
      kind: 'journal',
      id: '2026-05-10'
    })
  })

  it('round-trips every kind through format and parse', () => {
    for (const [kind, id] of [
      ['note', 'nte_1'],
      ['task', 'tsk_1'],
      ['event', 'evt_1'],
      ['canvas', 'cnv_1'],
      ['journal', '2026-05-10']
    ] as const) {
      expect(parseRelationUri(formatRelationUri(kind, id))).toEqual({ kind, id })
    }
  })

  // A journal is addressed by its day, so anything that is not a date is not a
  // journal reference — rejecting it here keeps an Invalid Date out of the tab.
  it('rejects a journal URI whose id is not an ISO date', () => {
    expect(parseRelationUri('memry://journal/nte_1')).toBeNull()
    expect(parseRelationUri('memry://journal/2026-5-10')).toBeNull()
    expect(parseRelationUri('memry://journal/20260510')).toBeNull()
  })

  it('rejects malformed URIs', () => {
    expect(parseRelationUri('memry://project/prj_1')).toBeNull()
    expect(parseRelationUri('memry://canvas/')).toBeNull()
    expect(parseRelationUri('memry://note/')).toBeNull()
    expect(parseRelationUri('https://example.com')).toBeNull()
    expect(parseRelationUri('memry://note/a b')).toBeNull()
    expect(parseRelationUri(42)).toBeNull()
    expect(parseRelationUri(null)).toBeNull()
  })

  it('treats a value as relation only when every entry parses', () => {
    expect(isRelationValue(['memry://note/nte_1'])).toBe(true)
    expect(isRelationValue(['memry://note/nte_1', 'memry://task/tsk_2'])).toBe(true)
    expect(isRelationValue(['memry://canvas/cnv_1', 'memry://journal/2026-05-10'])).toBe(true)
    expect(isRelationValue([])).toBe(false)
    expect(isRelationValue(['memry://note/nte_1', 'plain text'])).toBe(false)
    expect(isRelationValue('memry://note/nte_1')).toBe(false)
    expect(isRelationValue(null)).toBe(false)
  })

  it('returns parsed refs or an empty array', () => {
    expect(parseRelationValue(['memry://note/nte_1'])).toEqual([{ kind: 'note', id: 'nte_1' }])
    expect(parseRelationValue(['nope'])).toEqual([])
  })
})
