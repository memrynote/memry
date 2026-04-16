/**
 * useChordShortcuts Hook Tests
 * Verifies that chord key sequences dispatch the right tab-system actions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React, { useEffect } from 'react'

import { useChordShortcuts } from './use-chord-shortcuts'
import { TabProvider, useTabs } from '@/contexts/tabs'
import type { TabSystemState, TabGroup, Tab, SplitLayout } from '@/contexts/tabs/types'

vi.mock('./use-keyboard-shortcuts-base', () => ({
  isMac: true
}))

vi.mock('@/contexts/hint-mode', () => ({
  hintModeActiveRef: { current: false }
}))

vi.mock('./use-pane-navigation', () => ({
  calculateGroupPositions: () => ({})
}))

const mockApi = {
  updateSettings: vi.fn(),
  onSettingsChanged: vi.fn(() => () => {})
}

beforeEach(() => {
  ;(window as unknown as { api: typeof mockApi }).api = mockApi
})

afterEach(() => {
  vi.clearAllMocks()
})

const makeTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: `tab-${Math.random().toString(36).slice(2, 8)}`,
  type: 'note',
  title: 'Test',
  icon: 'file-text',
  path: '/note/test',
  entityId: `entity-${Math.random().toString(36).slice(2, 8)}`,
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: Date.now(),
  lastAccessedAt: Date.now(),
  ...overrides
})

const makeGroup = (tabs: Tab[], isActive = true): TabGroup => ({
  id: `group-${Math.random().toString(36).slice(2, 8)}`,
  tabs,
  activeTabId: tabs[0]?.id ?? null,
  isActive
})

const makeState = (groups: TabGroup[], layout?: SplitLayout): TabSystemState => {
  const tabGroups: Record<string, TabGroup> = {}
  groups.forEach((g) => {
    tabGroups[g.id] = g
  })
  return {
    tabGroups,
    layout: layout ?? { type: 'leaf', tabGroupId: groups[0].id },
    activeGroupId: groups[0].id,
    settings: { previewMode: false, restoreSessionOnStart: true, tabCloseButton: 'hover' }
  }
}

interface CaptureProps {
  onState: (s: TabSystemState) => void
}

const Capture = ({ onState }: CaptureProps): null => {
  const { state } = useTabs()
  useEffect(() => {
    onState(state)
  }, [state, onState])
  return null
}

const HookWithCapture = ({ onState }: CaptureProps): null => {
  useChordShortcuts()
  return <Capture onState={onState} />
}

const renderWithState = (initialState: TabSystemState) => {
  let latest: TabSystemState = initialState
  const { rerender } = renderHook(() => null, {
    wrapper: ({ children }) => (
      <TabProvider initialState={initialState}>
        <HookWithCapture onState={(s) => (latest = s)} />
        {children}
      </TabProvider>
    )
  })
  return {
    rerender,
    getState: () => latest
  }
}

const dispatchKey = (key: string, opts: { meta?: boolean; shift?: boolean } = {}) => {
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      metaKey: opts.meta ?? false,
      shiftKey: opts.shift ?? false,
      bubbles: true
    })
  )
}

describe('useChordShortcuts', () => {
  it('activates chord state on Cmd+K', () => {
    // #given a single pane setup
    const g1 = makeGroup([makeTab()])
    const state = makeState([g1])

    // #when Cmd+K is pressed
    const { result } = renderHook(() => useChordShortcuts(), {
      wrapper: ({ children }) => <TabProvider initialState={state}>{children}</TabProvider>
    })
    act(() => {
      dispatchKey('k', { meta: true })
    })

    // #then chord indicator becomes true
    expect(result.current).toBe(true)
  })

  it('dispatches TOGGLE_MAXIMIZE_GROUP after Cmd+K then m', () => {
    // #given a split layout
    const g1 = makeGroup([makeTab()])
    const g2 = makeGroup([makeTab()], false)
    const layout: SplitLayout = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', tabGroupId: g1.id },
      second: { type: 'leaf', tabGroupId: g2.id }
    }
    const state = makeState([g1, g2], layout)
    const { rerender, getState } = renderWithState(state)

    // #when ⌘K then m is pressed
    act(() => {
      dispatchKey('k', { meta: true })
    })
    act(() => {
      dispatchKey('m', { meta: true })
    })
    rerender()

    // #then maximize state is toggled on and layout collapses to the active group
    const after = getState()
    expect(after.isMaximized).toBe(true)
    expect(after.layout).toEqual({ type: 'leaf', tabGroupId: g1.id })
  })

  it('dispatches RESET_SPLIT_RATIOS after Cmd+K then =', () => {
    // #given a split layout with an uneven ratio
    const g1 = makeGroup([makeTab()])
    const g2 = makeGroup([makeTab()], false)
    const layout: SplitLayout = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.9,
      first: { type: 'leaf', tabGroupId: g1.id },
      second: { type: 'leaf', tabGroupId: g2.id }
    }
    const state = makeState([g1, g2], layout)
    const { rerender, getState } = renderWithState(state)

    // #when ⌘K then = is pressed
    act(() => {
      dispatchKey('k', { meta: true })
    })
    act(() => {
      dispatchKey('=', { meta: true })
    })
    rerender()

    // #then ratio resets to 0.5
    const after = getState()
    expect(after.layout.type).toBe('split')
    if (after.layout.type === 'split') {
      expect(after.layout.ratio).toBe(0.5)
    }
  })

  it('moves the active tab to the next group on ⌘K ⇧→', () => {
    // #given two groups, first group holds a known tab
    const movingTab = makeTab({ title: 'Moving' })
    const g1 = makeGroup([movingTab])
    const g2 = makeGroup([makeTab()], false)
    const layout: SplitLayout = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', tabGroupId: g1.id },
      second: { type: 'leaf', tabGroupId: g2.id }
    }
    const state = makeState([g1, g2], layout)
    const { rerender, getState } = renderWithState(state)

    // #when ⌘K then Shift+ArrowRight fires
    act(() => {
      dispatchKey('k', { meta: true })
    })
    act(() => {
      dispatchKey('ArrowRight', { shift: true })
    })
    rerender()

    // #then the tab is now in the second group and it becomes active
    const after = getState()
    const g2After = after.tabGroups[g2.id]
    expect(g2After.tabs.some((t) => t.title === 'Moving')).toBe(true)
    expect(after.activeGroupId).toBe(g2.id)
  })
})
