/**
 * The precedence rule, tested as a decision rather than as a scroll position:
 * jsdom has no layout, so "did the calendar end up at the current hour" is
 * unobservable here. What IS observable — and what the rule is — is whether the
 * surface is allowed to move itself at all.
 */

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mayAutoPositionFor, useTabAutoPosition } from './use-tab-auto-position'
import type { Tab } from '@/contexts/tabs/types'
import type { TabIdentity } from '@/contexts/tabs/tab-identity'

const mocks = vi.hoisted(() => ({
  getTab: vi.fn(),
  actions: { current: null as { getTab: unknown } | null },
  identity: { current: null as TabIdentity | null }
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActionsOptional: () => mocks.actions.current
}))

vi.mock('@/contexts/tabs/tab-identity', () => ({
  useTabIdentity: () => mocks.identity.current
}))

function tabWith(partial: Partial<Tab>): Tab {
  return { id: 'tab-1', ...partial } as Tab
}

beforeEach(() => {
  mocks.getTab.mockReset()
  mocks.actions.current = { getTab: mocks.getTab }
  mocks.identity.current = { tabId: 'tab-1', groupId: 'group-1' }
})

describe('useTabAutoPosition', () => {
  it('lets a first-open tab position itself', () => {
    mocks.getTab.mockReturnValue(tabWith({ scrollPanes: {} }))
    const { result } = renderHook(() => useTabAutoPosition('calendar-week'))
    expect(result.current()).toBe(true)
  })

  it('stands down once this pane has a stored position', () => {
    mocks.getTab.mockReturnValue(tabWith({ scrollPanes: { 'calendar-week': { offset: 640 } } }))
    const { result } = renderHook(() => useTabAutoPosition('calendar-week'))
    expect(result.current()).toBe(false)
  })

  it('treats a stored `0` as a position, not as "nothing stored"', () => {
    // The user scrolling back to the very top is a choice. Auto-positioning
    // that reads `0` as absence would throw them to the current hour for it.
    mocks.getTab.mockReturnValue(tabWith({ scrollPanes: { 'calendar-day': { offset: 0 } } }))
    const { result } = renderHook(() => useTabAutoPosition('calendar-day'))
    expect(result.current()).toBe(false)
  })

  it('ignores another pane in the same tab', () => {
    // Day and week are different scrollers. Having scrolled the day grid must
    // not stop the week grid opening at the current hour.
    mocks.getTab.mockReturnValue(tabWith({ scrollPanes: { 'calendar-day': { offset: 640 } } }))
    const { result } = renderHook(() => useTabAutoPosition('calendar-week'))
    expect(result.current()).toBe(true)
  })

  it('ignores an entry stamped with an entity the tab has since left', () => {
    // Restore refuses this entry, so the gate must too — otherwise the surface
    // neither restores nor auto-positions and the user lands at the top.
    mocks.identity.current = { tabId: 'tab-1', groupId: 'group-1', entityId: 'file-b' }
    mocks.getTab.mockReturnValue(
      tabWith({ scrollPanes: { 'pdf-page': { offset: 200, entityId: 'file-a' } } })
    )
    const { result } = renderHook(() => useTabAutoPosition('pdf-page'))
    expect(result.current()).toBe(true)
  })

  it('answers live, not as of the render that created it', () => {
    // The components that auto-position do not subscribe to tab state, so a
    // boolean captured at render time would still say "go ahead" after the
    // user's first scroll had been saved.
    mocks.getTab.mockReturnValue(tabWith({ scrollPanes: {} }))
    const { result } = renderHook(() => useTabAutoPosition('calendar-week'))
    expect(result.current()).toBe(true)

    mocks.getTab.mockReturnValue(tabWith({ scrollPanes: { 'calendar-week': { offset: 12 } } }))
    expect(result.current()).toBe(false)
  })

  it('positions freely outside a tab', () => {
    // The agent side pane and previews render the same components with no tab
    // to remember anything.
    mocks.identity.current = null
    const { result } = renderHook(() => useTabAutoPosition('calendar-week'))
    expect(result.current()).toBe(true)
  })

  it('positions freely when there is no tab system at all', () => {
    mocks.actions.current = null
    const { result } = renderHook(() => useTabAutoPosition('calendar-week'))
    expect(result.current()).toBe(true)
  })
})

describe('mayAutoPositionFor', () => {
  it('reads only an explicit null as "nothing stored"', () => {
    expect(mayAutoPositionFor(null)).toBe(true)
    expect(mayAutoPositionFor(1)).toBe(false)
    expect(mayAutoPositionFor(0)).toBe(false)
    expect(mayAutoPositionFor('bottom')).toBe(false)
    // `undefined` is not the sentinel: a surface that forgot to store its
    // default must not silently opt back into auto-positioning.
    expect(mayAutoPositionFor(undefined)).toBe(false)
  })
})
