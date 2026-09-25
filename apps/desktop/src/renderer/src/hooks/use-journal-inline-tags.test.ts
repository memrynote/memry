import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { diffInlineTags, useJournalInlineTags } from './use-journal-inline-tags'

describe('diffInlineTags', () => {
  it('adds a newly typed tag once', () => {
    expect(diffInlineTags(['work'], new Set(), ['idea'])).toEqual(['work', 'idea'])
    expect(diffInlineTags(['work'], new Set(), ['work'])).toBeNull()
  })

  it('removes only a tag the body used to carry', () => {
    expect(diffInlineTags(['work', 'idea'], new Set(['idea']), [])).toEqual(['work'])
    expect(diffInlineTags(['work'], new Set(), [])).toBeNull()
  })
})

describe('useJournalInlineTags', () => {
  it('seeds the baseline on load without writing, then writes typed changes', () => {
    const updateTags = vi.fn()
    const { result } = renderHook(() => useJournalInlineTags(['work'], updateTags))

    act(() => result.current(['work', 'body-only'], 'load'))
    expect(updateTags).not.toHaveBeenCalled()

    act(() => result.current(['work'], 'edit'))
    expect(updateTags).not.toHaveBeenCalled()

    act(() => result.current(['work', 'idea'], 'edit'))
    expect(updateTags).toHaveBeenCalledWith(['work', 'idea'])
  })
})
