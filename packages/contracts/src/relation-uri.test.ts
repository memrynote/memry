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

  it('rejects malformed URIs', () => {
    expect(parseRelationUri('memry://project/prj_1')).toBeNull()
    expect(parseRelationUri('memry://note/')).toBeNull()
    expect(parseRelationUri('https://example.com')).toBeNull()
    expect(parseRelationUri('memry://note/a b')).toBeNull()
    expect(parseRelationUri(42)).toBeNull()
    expect(parseRelationUri(null)).toBeNull()
  })

  it('treats a value as relation only when every entry parses', () => {
    expect(isRelationValue(['memry://note/nte_1'])).toBe(true)
    expect(isRelationValue(['memry://note/nte_1', 'memry://task/tsk_2'])).toBe(true)
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
