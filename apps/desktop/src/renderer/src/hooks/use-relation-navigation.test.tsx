import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ResolvedRelationRef } from '@memry/contracts/properties-api'
import { useRelationNavigation } from './use-relation-navigation'

const mocks = vi.hoisted(() => ({ openTab: vi.fn() }))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab: mocks.openTab })
}))
vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

function navigate(ref: ResolvedRelationRef): void {
  const { result } = renderHook(() => useRelationNavigation())
  result.current(ref)
}

const base = { uri: '', title: 'Target', exists: true } as const

describe('useRelationNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens a canvas tab for a canvas target', () => {
    navigate({ ...base, uri: 'memry://canvas/cnv_1', targetType: 'canvas', targetId: 'cnv_1' })
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'canvas',
        title: 'Target',
        path: '/canvas/cnv_1',
        entityId: 'cnv_1'
      })
    )
  })

  // The date is the whole point of a journal relation: opening "Journal" on
  // today instead of the target day is the bug this guards.
  it('opens the journal tab on the target date', () => {
    navigate({
      ...base,
      uri: 'memry://journal/2026-05-10',
      targetType: 'journal',
      targetId: '2026-05-10',
      title: 'Sprint retro',
      date: '2026-05-10'
    })
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'journal',
        path: '/journal/2026-05-10',
        entityId: '2026-05-10',
        viewState: { date: '2026-05-10' }
      })
    )
  })

  it('opens a note tab for a note target', () => {
    navigate({ ...base, uri: 'memry://note/nte_1', targetType: 'note', targetId: 'nte_1' })
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', path: '/notes/nte_1', entityId: 'nte_1' })
    )
  })

  it('ignores a dangling target of any kind', () => {
    navigate({
      ...base,
      uri: 'memry://canvas/cnv_gone',
      targetType: 'canvas',
      targetId: 'cnv_gone',
      exists: false
    })
    navigate({
      ...base,
      uri: 'memry://journal/2026-05-11',
      targetType: 'journal',
      targetId: '2026-05-11',
      exists: false
    })
    expect(mocks.openTab).not.toHaveBeenCalled()
  })
})
