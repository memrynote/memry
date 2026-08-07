import { act, render, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TabProvider,
  useActiveGroup,
  useActiveGroupTabs,
  useActiveTab,
  useIsTabActive,
  useTabActions,
  useTabCounts,
  useTabGroup,
  useTabLayout,
  useTabs,
  useTabSettings
} from './context'
import type { SidebarItem, Tab, TabGroup, TabSystemState } from './types'

const makeTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: overrides.id ?? `tab-${Math.random().toString(36).slice(2)}`,
  type: overrides.type ?? 'note',
  title: overrides.title ?? 'Note',
  icon: overrides.icon ?? 'file-text',
  path: overrides.path ?? '/note/note-1',
  entityId: overrides.entityId ?? 'note-1',
  isPinned: overrides.isPinned ?? false,
  isModified: overrides.isModified ?? false,
  isPreview: overrides.isPreview ?? false,
  isDeleted: overrides.isDeleted ?? false,
  openedAt: overrides.openedAt ?? 1,
  lastAccessedAt: overrides.lastAccessedAt ?? 1,
  ...overrides
})

const makeGroup = (id: string, tabs: Tab[], activeTabId = tabs[0]?.id ?? null): TabGroup => ({
  id,
  tabs,
  activeTabId,
  isActive: true,
  back: [],
  forward: []
})

const makeState = (groups: TabGroup[], activeGroupId = groups[0].id): TabSystemState => ({
  tabGroups: Object.fromEntries(groups.map((group) => [group.id, group])),
  layout: { type: 'leaf', tabGroupId: activeGroupId },
  activeGroupId,
  settings: {
    restoreSessionOnStart: true,
    tabCloseButton: 'hover'
  }
})

const noteTab = (id: string, title = id): Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'> => ({
  type: 'note',
  title,
  icon: 'file-text',
  path: `/note/${id}`,
  entityId: id,
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false
})

function captureContext(
  initialState?: TabSystemState,
  initialSettings?: TabSystemState['settings']
) {
  let latest: ReturnType<typeof useTabs> | null = null

  const Probe = (): null => {
    latest = useTabs()
    return null
  }

  const view = render(
    <TabProvider initialState={initialState} initialSettings={initialSettings}>
      <Probe />
    </TabProvider>
  )

  return {
    ...view,
    get ctx() {
      if (!latest) throw new Error('missing tab context')
      return latest
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  window.api.onSettingsChanged = vi.fn(() => vi.fn())
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TabProvider context', () => {
  it('throws when useTabs is used outside a provider', () => {
    const { result } = renderHook(() => {
      try {
        return useTabs()
      } catch (error) {
        return error
      }
    })

    expect(result.current).toBeInstanceOf(Error)
    expect((result.current as Error).message).toBe('useTabs must be used within a TabProvider')
  })

  it('merges initial settings, handles settings events, and unsubscribes', async () => {
    const unsubscribe = vi.fn()
    let listener: ((event: { key: string; value: unknown }) => void) | undefined
    window.api.onSettingsChanged = vi.fn((callback) => {
      listener = callback
      return unsubscribe
    })

    const rendered = captureContext(undefined, {
      restoreSessionOnStart: false,
      tabCloseButton: 'always'
    })

    expect(rendered.ctx.state.settings).toMatchObject({
      restoreSessionOnStart: false,
      tabCloseButton: 'always'
    })

    act(() => {
      listener?.({ key: 'notes', value: { tabCloseButton: 'hover' } })
    })
    expect(rendered.ctx.state.settings.tabCloseButton).toBe('always')

    act(() => {
      listener?.({ key: 'tabs', value: { tabCloseButton: 'active' } })
    })

    await waitFor(() => {
      expect(rendered.ctx.state.settings.tabCloseButton).toBe('active')
    })

    rendered.unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('opens, updates, selects, and closes tabs through the public actions', async () => {
    const pinned = makeTab({ id: 'pinned', title: 'Pinned', isPinned: true, entityId: 'pinned' })
    const alpha = makeTab({ id: 'alpha', title: 'Alpha', entityId: 'alpha' })
    const beta = makeTab({ id: 'beta', title: 'Beta', entityId: 'beta', isPreview: true })
    const group = makeGroup('main', [pinned, alpha, beta], 'alpha')
    const rendered = captureContext(makeState([group]))

    expect(rendered.ctx.getActiveTab()?.id).toBe('alpha')
    expect(rendered.ctx.getActiveGroup()?.id).toBe('main')
    expect(rendered.ctx.getAllTabs()).toHaveLength(3)
    expect(rendered.ctx.getTabsInGroup('missing')).toEqual([])
    expect(rendered.ctx.hasTabForEntity('beta')).toBe(true)
    expect(rendered.ctx.canNavBack).toBe(false)
    expect(rendered.ctx.canNavForward).toBe(false)

    act(() => {
      rendered.ctx.openTab(noteTab('gamma', 'Gamma'), { background: true })
    })
    expect(rendered.ctx.state.tabGroups.main.activeTabId).toBe('alpha')

    act(() => {
      rendered.ctx.openTab({ ...noteTab('alpha', 'Alpha Renamed'), viewState: { filter: 'today' } })
    })
    expect(rendered.ctx.getActiveTab()?.id).toBe('alpha')
    expect(rendered.ctx.getActiveTab()?.viewState).toEqual({ filter: 'today' })

    act(() => {
      rendered.ctx.setActiveTab('beta')
      rendered.ctx.pinTab('beta')
      rendered.ctx.setTabModified('beta', true)
      rendered.ctx.setTabDeleted('beta', true)
      rendered.ctx.updateTabTitle('beta', 'Beta Updated')
      rendered.ctx.saveTabState('beta', { scrollPosition: 42, viewState: { mode: 'preview' } })
    })

    await waitFor(() => {
      const tab = rendered.ctx.state.tabGroups.main.tabs.find(
        (candidate) => candidate.id === 'beta'
      )
      expect(tab).toMatchObject({
        title: 'Beta Updated',
        isPinned: true,
        isModified: true,
        isDeleted: true,
        isPreview: false,
        scrollPosition: 42,
        viewState: { mode: 'preview' }
      })
    })

    act(() => {
      rendered.ctx.togglePinTab('beta')
      rendered.ctx.togglePinTab('missing')
      rendered.ctx.updateTabTitleByEntityId('beta', 'By Entity')
      rendered.ctx.setTabDeleted('missing', true)
    })

    await waitFor(() => {
      const tab = rendered.ctx.state.tabGroups.main.tabs.find(
        (candidate) => candidate.id === 'beta'
      )
      expect(tab?.isPinned).toBe(false)
      expect(tab?.title).toBe('By Entity')
    })

    act(() => {
      rendered.ctx.goToPreviousTab()
      rendered.ctx.goToNextTab()
      rendered.ctx.goToTabIndex(0)
      rendered.ctx.navBack()
      rendered.ctx.navForward()
      rendered.ctx.closeTabsToRight('alpha')
      rendered.ctx.closeOtherTabs('pinned')
      rendered.ctx.closeTab('pinned')
      rendered.ctx.closeAllTabs()
    })

    expect(rendered.ctx.state.tabGroups.main.tabs).toHaveLength(1)
    expect(rendered.ctx.state.tabGroups.main.tabs[0].type).toBe('home')
  })

  it('opens sidebar tabs, splits panes, moves tabs, restores sessions, and resets', async () => {
    const first = makeTab({ id: 'first', entityId: 'first' })
    const second = makeTab({ id: 'second', entityId: 'second' })
    const group = makeGroup('main', [first, second], 'first')
    const rendered = captureContext(makeState([group]))

    const sidebarItem: SidebarItem = {
      type: 'folder',
      title: 'Projects',
      icon: 'folder',
      path: '/folder/projects',
      entityId: 'folder-projects'
    }

    act(() => {
      rendered.ctx.openFromSidebar(sidebarItem, { position: 1 })
      rendered.ctx.reorderTabs(0, 2)
      rendered.ctx.splitView('horizontal')
    })

    await waitFor(() => {
      expect(Object.keys(rendered.ctx.state.tabGroups)).toHaveLength(2)
    })

    const newGroupId = Object.keys(rendered.ctx.state.tabGroups).find((id) => id !== 'main')
    expect(newGroupId).toBeTruthy()

    act(() => {
      rendered.ctx.setActiveGroup(newGroupId!)
      rendered.ctx.moveTabToGroup('second', 'main', newGroupId!, 0)
      rendered.ctx.moveTabToNewSplit('second', newGroupId!, 'right')
      rendered.ctx.closeSplit(newGroupId!)
      rendered.ctx.updateSettings({ restoreSessionOnStart: false })
    })

    expect(rendered.ctx.state.settings.restoreSessionOnStart).toBe(false)

    const restored = makeState([makeGroup('restored', [makeTab({ id: 'restored' })])], 'restored')
    act(() => {
      rendered.ctx.restoreSession(restored)
    })
    expect(rendered.ctx.state.activeGroupId).toBe('restored')

    act(() => {
      rendered.ctx.resetToDefault()
    })
    expect(rendered.ctx.getActiveTab()?.type).toBe('home')
  })
})

describe('tab selector hooks', () => {
  it('returns derived tab state', () => {
    const active = makeTab({
      id: 'active',
      entityId: 'active',
      isPinned: true,
      isModified: true,
      isPreview: true
    })
    const group = makeGroup('main', [active, makeTab({ id: 'other', entityId: 'other' })], 'active')
    const state = makeState([group])
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TabProvider initialState={state}>{children}</TabProvider>
    )

    expect(renderHook(() => useTabGroup('main'), { wrapper }).result.current?.id).toBe('main')
    expect(renderHook(() => useTabGroup('missing'), { wrapper }).result.current).toBeNull()
    expect(renderHook(() => useActiveTab(), { wrapper }).result.current?.id).toBe('active')
    expect(renderHook(() => useActiveTab('missing'), { wrapper }).result.current).toBeNull()
    expect(renderHook(() => useActiveGroup(), { wrapper }).result.current?.id).toBe('main')
    expect(renderHook(() => useActiveGroupTabs(), { wrapper }).result.current).toHaveLength(2)
    expect(renderHook(() => useTabSettings(), { wrapper }).result.current.tabCloseButton).toBe(
      'hover'
    )
    expect(renderHook(() => useIsTabActive('active'), { wrapper }).result.current).toBe(true)
    expect(renderHook(() => useIsTabActive('other'), { wrapper }).result.current).toBe(false)
    expect(renderHook(() => useTabLayout(), { wrapper }).result.current).toEqual(state.layout)
    expect(renderHook(() => useTabCounts(), { wrapper }).result.current).toEqual({
      total: 2,
      pinned: 1,
      modified: 1,
      preview: 1,
      groups: 1
    })
    expect(renderHook(() => useTabActions(), { wrapper }).result.current.dispatch).toBeTypeOf(
      'function'
    )
  })
})

describe('tab context render scoping', () => {
  const STATE_UPDATES = 200

  function renderScopingHarness() {
    const alpha = makeTab({ id: 'alpha', title: 'Alpha', entityId: 'alpha' })
    const beta = makeTab({ id: 'beta', title: 'Beta', entityId: 'beta' })
    const initialState = makeState([makeGroup('main', [alpha, beta], 'alpha')])

    const renders = { actions: 0, tabState: 0 }
    let capturedActions: ReturnType<typeof useTabActions> | null = null
    let capturedContext: ReturnType<typeof useTabs> | null = null
    let seenTitle = ''

    // Only ever reads actions: must not re-render when tab state changes.
    const ActionsProbe = (): null => {
      renders.actions += 1
      capturedActions = useTabActions()
      return null
    }

    // Reads tab state: must keep re-rendering when tab state changes.
    const StateProbe = (): null => {
      renders.tabState += 1
      seenTitle = useTabs().state.tabGroups.main.tabs.find((t) => t.id === 'alpha')?.title ?? ''
      return null
    }

    // Drives the state changes from outside the two probes above.
    const Driver = (): null => {
      capturedContext = useTabs()
      return null
    }

    const view = render(
      <TabProvider initialState={initialState}>
        <ActionsProbe />
        <StateProbe />
        <Driver />
      </TabProvider>
    )

    return {
      ...view,
      renders,
      get actions() {
        if (!capturedActions) throw new Error('missing tab actions')
        return capturedActions
      },
      get ctx() {
        if (!capturedContext) throw new Error('missing tab context')
        return capturedContext
      },
      get seenTitle() {
        return seenTitle
      },
      tab(id: string) {
        if (!capturedContext) throw new Error('missing tab context')
        return capturedContext.state.tabGroups.main.tabs.find((t) => t.id === id)
      }
    }
  }

  it('keeps useTabActions consumers out of tab state re-renders', () => {
    const harness = renderScopingHarness()

    expect(harness.renders.actions).toBe(1)
    expect(harness.renders.tabState).toBe(1)

    for (let i = 0; i < STATE_UPDATES; i++) {
      act(() => {
        harness.ctx.updateTabTitle('alpha', `Alpha ${i}`)
      })
    }

    // State consumers must still see every change.
    expect(harness.seenTitle).toBe(`Alpha ${STATE_UPDATES - 1}`)
    expect(harness.renders.tabState).toBe(1 + STATE_UPDATES)

    // Action-only consumers must render exactly once.
    expect(harness.renders.actions).toBe(1)
  })

  it('runs actions against current tab state from a consumer that never re-rendered', () => {
    const harness = renderScopingHarness()
    const actions = harness.actions

    act(() => {
      harness.ctx.pinTab('alpha')
    })
    expect(harness.tab('alpha')?.isPinned).toBe(true)

    // togglePinTab must read the committed state, not the render that captured it.
    act(() => {
      actions.togglePinTab('alpha')
    })
    expect(harness.tab('alpha')?.isPinned).toBe(false)

    // ...and it did all of that without the action consumer re-rendering once.
    expect(harness.renders.actions).toBe(1)
  })
})
