import { describe, expect, it } from 'vitest'
import { PORTAL_SEARCH_DEFAULT_LIMIT, PORTAL_SEARCH_MAX_LIMIT } from '@memry/shared/portal-block'
import { draftFromTarget, targetFromDraft } from './portal-search-query'

describe('targetFromDraft', () => {
  it('needs text or a tag', () => {
    expect(targetFromDraft({ text: '  ', tag: '#', limit: '50' })).toBeNull()
  })

  it('trims, strips the tag hash and omits empty fields', () => {
    expect(targetFromDraft({ text: ' exam ', tag: '#bio', limit: '20' })).toEqual({
      kind: 'search',
      text: 'exam',
      tag: 'bio',
      limit: 20
    })
    expect(targetFromDraft({ text: '', tag: 'bio', limit: '20' })).toEqual({
      kind: 'search',
      tag: 'bio',
      limit: 20
    })
  })

  it('clamps the limit and falls back to the default when it is not a number', () => {
    expect(targetFromDraft({ text: 'a', tag: '', limit: '9999' })?.limit).toBe(
      PORTAL_SEARCH_MAX_LIMIT
    )
    expect(targetFromDraft({ text: 'a', tag: '', limit: '0' })?.limit).toBe(1)
    expect(targetFromDraft({ text: 'a', tag: '', limit: '' })?.limit).toBe(
      PORTAL_SEARCH_DEFAULT_LIMIT
    )
  })

  it('round-trips a stored target', () => {
    const target = { kind: 'search' as const, text: 'exam', tag: 'bio', limit: 30 }
    expect(targetFromDraft(draftFromTarget(target))).toEqual(target)
  })
})
