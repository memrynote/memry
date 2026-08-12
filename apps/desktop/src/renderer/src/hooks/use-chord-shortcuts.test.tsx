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

const mockPanePositions = vi.hoisted(() => ({
  value: {} as Record<string, { centerX: number; centerY: number }>
}))
const mockHintModeActiveRef = vi.hoisted(() => ({ current: false }))

vi.mock('./use-keyboard-shortcuts-base', () => ({
  isMac: true
}))

vi.mock('@/contexts/hint-mode', () => ({
  hintModeActiveRef: mockHintModeActiveRef
}))

vi.mock('./use-pane-navigation', () => ({
  calculateGroupPositions: () => mockPanePositions.value
}))

const mockApi = {
  updateSettings: vi.fn(),
  onSettingsChanged: vi.fn(() => () => {})
}

beforeEach(() => {
  ;(window as unknown as { api: typeof mockApi }).api = mockApi
  mockPanePositions.value = {}
  mockHintModeActiveRef.current = false
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
  isActive,
  back: [],
  forward: []
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
    settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' }
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

type TabsDispatch = ReturnType<typeof useTabs>['dispatch']

interface ControlProps {
  onState: (s: TabSystemState) => void
  onDispatch: (d: TabsDispatch) => void
}

const HookWithControls = ({ onState, onDispatch }: ControlProps): null => {
  useChordShortcuts()
  const { state, dispatch } = useTabs()
  useEffect(() => {
    onState(state)
    onDispatch(dispatch)
  }, [state, dispatch, onState, onDispatch])
  return null
}

const renderWithControls = (initialState: TabSystemState) => {
  let latest: TabSystemState = initialState
  let dispatch: TabsDispatch = () => {}
  const { unmount } = renderHook(() => null, {
    wrapper: ({ children }) => (
      <TabProvider initialState={initialState}>
        <HookWithControls onState={(s) => (latest = s)} onDispatch={(d) => (dispatch = d)} />
        {children}
      </TabProvider>
    )
  })
  return {
    unmount,
    getState: () => latest,
    dispatch: (action: Parameters<TabsDispatch>[0]) => dispatch(action)
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

  it('focuses adjacent groups, wraps arrows, and moves tabs backward', () => {
    const movingTab = makeTab({ title: 'Moving backward' })
    const g1 = makeGroup([movingTab])
    const g2 = makeGroup([makeTab({ title: 'Side' })], false)
    const g3 = makeGroup([makeTab({ title: 'Below' })], false)
    const layout: SplitLayout = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', tabGroupId: g1.id },
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { type: 'leaf', tabGroupId: g2.id },
        second: { type: 'leaf', tabGroupId: g3.id }
      }
    }
    mockPanePositions.value = {
      [g1.id]: { centerX: 0, centerY: 0 },
      [g2.id]: { centerX: 100, centerY: 0 },
      [g3.id]: { centerX: 0, centerY: 100 }
    }
    const state = makeState([g1, g2, g3], layout)
    const { rerender, getState } = renderWithState(state)

    act(() => {
      dispatchKey('k', { meta: true })
    })
    rerender()
    act(() => {
      dispatchKey('ArrowRight', { meta: true })
    })
    rerender()
    expect(getState().activeGroupId).toBe(g2.id)

    act(() => {
      dispatchKey('k', { meta: true })
    })
    rerender()
    act(() => {
      dispatchKey('ArrowLeft', { meta: true })
    })
    rerender()
    expect(getState().activeGroupId).toBe(g1.id)

    act(() => {
      dispatchKey('k', { meta: true })
    })
    rerender()
    act(() => {
      dispatchKey('ArrowDown', { meta: true })
    })
    rerender()
    expect(getState().activeGroupId).toBe(g3.id)

    act(() => {
      dispatchKey('k', { meta: true })
    })
    rerender()
    act(() => {
      dispatchKey('ArrowUp', { meta: true })
    })
    rerender()
    expect(getState().activeGroupId).toBe(g1.id)

    act(() => {
      dispatchKey('k', { meta: true })
    })
    rerender()
    act(() => {
      dispatchKey('ArrowLeft', { shift: true })
    })
    rerender()
    expect(getState().tabGroups[g3.id].tabs.some((tab) => tab.title === 'Moving backward')).toBe(
      true
    )
  })

  it('binds the window keydown listener once across tab state changes', () => {
    // #given a two-group setup with the listener spies installed
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const g1 = makeGroup([makeTab()])
    const g2 = makeGroup([makeTab()], false)
    const { unmount, dispatch } = renderWithControls(makeState([g1, g2]))

    const keydownAdds = (): unknown[] => addSpy.mock.calls.filter(([type]) => type === 'keydown')
    const keydownRemoves = (): unknown[] =>
      removeSpy.mock.calls.filter(([type]) => type === 'keydown')

    expect(keydownAdds()).toHaveLength(1)

    // #when the active group flips back and forth six times
    for (let i = 0; i < 6; i++) {
      const groupId = i % 2 === 0 ? g2.id : g1.id
      act(() => {
        dispatch({ type: 'SET_ACTIVE_GROUP', payload: { groupId } })
      })
    }

    // #then the listener was never detached and reattached
    expect(keydownAdds()).toHaveLength(1)
    expect(keydownRemoves()).toHaveLength(0)

    // #and unmount still removes it
    unmount()
    expect(keydownRemoves()).toHaveLength(1)

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('completes a chord against the tab state at keypress time', () => {
    // #given three groups with the second one made active after mount
    const g1 = makeGroup([makeTab()])
    const g2 = makeGroup([makeTab()], false)
    const g3 = makeGroup([makeTab()], false)
    const { getState, dispatch } = renderWithControls(makeState([g1, g2, g3]))

    act(() => {
      dispatch({ type: 'SET_ACTIVE_GROUP', payload: { groupId: g2.id } })
    })

    // #when ⌘K then ArrowRight fires
    act(() => {
      dispatchKey('k', { meta: true })
    })
    act(() => {
      dispatchKey('ArrowRight', { meta: true })
    })

    // #then it advances from the new active group, not the one from first render
    expect(getState().activeGroupId).toBe(g3.id)
  })

  it('ignores typing targets, hint mode, unsupported chords, and timeout expiry', () => {
    vi.useFakeTimers()
    const g1 = makeGroup([makeTab()])
    const g2 = makeGroup([makeTab()], false)
    const state = makeState([g1, g2])
    const { result } = renderHook(() => useChordShortcuts(), {
      wrapper: ({ children }) => <TabProvider initialState={state}>{children}</TabProvider>
    })

    const input = document.createElement('input')
    document.body.append(input)
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
    })
    expect(result.current).toBe(false)

    mockHintModeActiveRef.current = true
    act(() => {
      dispatchKey('k', { meta: true })
    })
    expect(result.current).toBe(false)

    mockHintModeActiveRef.current = false
    act(() => {
      dispatchKey('k', { meta: true })
    })
    expect(result.current).toBe(true)

    act(() => {
      dispatchKey('x', { meta: true })
    })
    expect(result.current).toBe(false)

    act(() => {
      dispatchKey('k', { meta: true })
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(false)

    input.remove()
    vi.useRealTimers()
  })
})
