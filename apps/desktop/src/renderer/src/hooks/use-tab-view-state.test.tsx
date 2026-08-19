import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTabViewState } from './use-tab-view-state'
import type { Tab } from '@/contexts/tabs/types'
import type { TabIdentity } from '@/contexts/tabs/tab-identity'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  getTab: vi.fn(),
  identity: { current: null as TabIdentity | null }
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActionsOptional: () => ({ dispatch: mocks.dispatch, getTab: mocks.getTab })
}))

vi.mock('@/contexts/tabs/tab-identity', () => ({
  useTabIdentity: () => mocks.identity.current
}))

function tabWith(viewState: Record<string, unknown> | undefined): Tab {
  return { id: 'tab-a', viewState } as Tab
}

/** Accepts only the two strings this fixture considers valid. */
const parseMode = (raw: unknown): 'list' | 'board' | undefined =>
  raw === 'list' || raw === 'board' ? raw : undefined

describe('useTabViewState', () => {
  beforeEach(() => {
    mocks.dispatch.mockClear()
    mocks.getTab.mockReset()
    mocks.getTab.mockReturnValue(null)
    mocks.identity.current = { tabId: 'tab-a', groupId: 'group-1', entityId: 'note-1' }
  })

  it('seeds from the tab viewState through parse', () => {
    mocks.getTab.mockReturnValue(tabWith({ mode: 'board' }))

    const { result } = renderHook(() =>
      useTabViewState({ key: 'mode', defaultValue: 'list' as const, parse: parseMode })
    )

    expect(result.current[0]).toBe('board')
  })

  it('falls back to the default when the key is absent', () => {
    mocks.getTab.mockReturnValue(tabWith({ other: 1 }))

    const { result } = renderHook(() =>
      useTabViewState({ key: 'mode', defaultValue: 'list' as const, parse: parseMode })
    )

    expect(result.current[0]).toBe('list')
  })

  it('falls back to the default when parse rejects the stored value', () => {
    mocks.getTab.mockReturnValue(tabWith({ mode: 'gallery' }))

    const { result } = renderHook(() =>
      useTabViewState({ key: 'mode', defaultValue: 'list' as const, parse: parseMode })
    )

    expect(result.current[0]).toBe('list')
  })

  it('falls back to the default instead of throwing when parse throws', () => {
    mocks.getTab.mockReturnValue(tabWith({ mode: 'gallery' }))
    const throwingParse = (): 'list' => {
      throw new Error('unsupported mode')
    }

    const { result } = renderHook(() =>
      useTabViewState({ key: 'mode', defaultValue: 'list' as const, parse: throwingParse })
    )

    expect(result.current[0]).toBe('list')
  })

  it('writes only its own key so other writers are not clobbered', () => {
    mocks.getTab.mockReturnValue(tabWith({ mode: 'list', filter: 'open' }))

    const { result } = renderHook(() =>
      useTabViewState({ key: 'mode', defaultValue: 'list' as const, parse: parseMode })
    )

    act(() => result.current[1]('board'))

    expect(result.current[0]).toBe('board')
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'SAVE_TAB_STATE',
      payload: { tabId: 'tab-a', groupId: 'group-1', viewState: { mode: 'board' } }
    })
  })

  it('supports a functional updater', () => {
    mocks.getTab.mockReturnValue(tabWith({ count: 2 }))

    const { result } = renderHook(() =>
      useTabViewState({
        key: 'count',
        defaultValue: 0,
        parse: (raw) => (typeof raw === 'number' ? raw : undefined)
      })
    )

    act(() => result.current[1]((previous) => previous + 3))

    expect(result.current[0]).toBe(5)
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'SAVE_TAB_STATE',
      payload: { tabId: 'tab-a', groupId: 'group-1', viewState: { count: 5 } }
    })
  })

  it('re-seeds when the tab identity changes under a reused page instance', () => {
    mocks.getTab.mockImplementation((tabId: string) =>
      tabId === 'tab-a' ? tabWith({ mode: 'board' }) : tabWith({ mode: 'list' })
    )

    const { result, rerender } = renderHook(() =>
      useTabViewState({ key: 'mode', defaultValue: 'list' as const, parse: parseMode })
    )
    expect(result.current[0]).toBe('board')

    mocks.identity.current = { tabId: 'tab-b', groupId: 'group-1', entityId: 'note-2' }
    rerender()

    expect(result.current[0]).toBe('list')
  })

  it('reads a legacy alias key when the current key is absent', () => {
    mocks.getTab.mockReturnValue(tabWith({ activeTab: 'board' }))

    const { result } = renderHook(() =>
      useTabViewState({
        key: 'activeInternalTab',
        aliasKeys: ['activeTab'],
        defaultValue: 'list' as const,
        parse: parseMode
      })
    )

    expect(result.current[0]).toBe('board')
  })

  it('prefers the current key over its alias', () => {
    mocks.getTab.mockReturnValue(tabWith({ activeInternalTab: 'board', activeTab: 'list' }))

    const { result } = renderHook(() =>
      useTabViewState({
        key: 'activeInternalTab',
        aliasKeys: ['activeTab'],
        defaultValue: 'list' as const,
        parse: parseMode
      })
    )

    expect(result.current[0]).toBe('board')
  })

  it('writes the alias alongside the current key', () => {
    const { result } = renderHook(() =>
      useTabViewState({
        key: 'activeInternalTab',
        aliasKeys: ['activeTab'],
        defaultValue: 'list' as const,
        parse: parseMode
      })
    )

    act(() => result.current[1]('board'))

    // A session written here still restores on a build that only knows the old
    // name.
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'SAVE_TAB_STATE',
      payload: {
        tabId: 'tab-a',
        groupId: 'group-1',
        viewState: { activeInternalTab: 'board', activeTab: 'board' }
      }
    })
  })

  it('degrades to plain local state outside a tab', () => {
    mocks.identity.current = null

    const { result } = renderHook(() =>
      useTabViewState({ key: 'mode', defaultValue: 'list' as const, parse: parseMode })
    )

    act(() => result.current[1]('board'))

    expect(result.current[0]).toBe('board')
    expect(mocks.dispatch).not.toHaveBeenCalled()
  })
})
