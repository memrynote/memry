/**
 * The seam under test is the real one: a real `TabProvider`, the real reducer,
 * the real `useHomeBoards` (including the shared active-board store) and the
 * real `updateTabTitle`. Only `window.api.homePages` and the home-page events —
 * the IPC boundary the renderer cannot own — are mocks, so an assertion here is
 * about the tab title a user would read off the tab strip.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TabProvider, useTabs } from '@/contexts/tabs/context'
import type { Tab, TabGroup, TabSystemState } from '@/contexts/tabs/types'
import { useHomeBoards } from '@/hooks/use-home-boards'
import { HomeTabTitleSync } from './home-tab-title-sync'

interface TestBoard {
  id: string
  name: string
  position: number
  widgets: never[]
}

const ACTIVE_KEY = 'memry-home-active-board'

/** Mutable so a test can rename a board between refetches. */
let boards: TestBoard[] = []
/** Resolves the board list; swapped for a never-resolving one in the loading test. */
let listBoards: () => Promise<TestBoard[]> = async () => boards
/** Fires the main-process "a board changed" broadcast the hook refetches on. */
let emitHomePageUpdated: (() => void) | null = null

const board = (id: string, name: string, position: number): TestBoard => ({
  id,
  name,
  position,
  widgets: []
})

const homeTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: 'tab-home',
  type: 'home',
  title: 'Home',
  icon: 'home',
  path: '/home',
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: 1,
  lastAccessedAt: 1,
  ...overrides
})

const noteTab = (overrides: Partial<Tab> = {}): Tab => ({
  id: 'tab-note',
  type: 'note',
  title: 'Some note',
  icon: 'file-text',
  path: '/note/note-1',
  entityId: 'note-1',
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false,
  openedAt: 1,
  lastAccessedAt: 1,
  ...overrides
})

const makeGroup = (id: string, tabs: Tab[], activeTabId?: string): TabGroup => ({
  id,
  tabs,
  activeTabId: activeTabId ?? tabs[0]?.id ?? null,
  isActive: true,
  back: [],
  forward: []
})

const makeState = (groups: TabGroup[]): TabSystemState => ({
  tabGroups: Object.fromEntries(groups.map((group) => [group.id, group])),
  layout: { type: 'leaf', tabGroupId: groups[0].id },
  activeGroupId: groups[0].id,
  settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
  recentlyClosed: []
})

function mount(initialState: TabSystemState) {
  let latestTabs: ReturnType<typeof useTabs> | null = null
  let latestBoards: ReturnType<typeof useHomeBoards> | null = null

  const Probe = (): null => {
    latestTabs = useTabs()
    latestBoards = useHomeBoards()
    return null
  }

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })

  const view = render(
    <QueryClientProvider client={client}>
      <TabProvider initialState={initialState}>
        <HomeTabTitleSync />
        <Probe />
      </TabProvider>
    </QueryClientProvider>
  )

  return {
    ...view,
    titleOf: (groupId: string, tabId: string): string | undefined =>
      latestTabs?.state.tabGroups[groupId]?.tabs.find((tab) => tab.id === tabId)?.title,
    selectBoard: (id: string): void => {
      latestBoards?.setActiveBoardId(id)
    },
    get groups() {
      return latestTabs?.state.tabGroups
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  emitHomePageUpdated = null
  boards = [board('b1', 'Home', 0), board('b2', 'Work', 1)]
  listBoards = async () => boards

  window.api.onSettingsChanged = vi.fn(() => vi.fn())
  window.api.homePages = {
    list: vi.fn(() => listBoards()),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    reorder: vi.fn()
  } as unknown as typeof window.api.homePages
  window.api.onHomePageCreated = vi.fn(
    () => () => {}
  ) as unknown as typeof window.api.onHomePageCreated
  window.api.onHomePageUpdated = vi.fn((callback: (event: { id: string }) => void) => {
    emitHomePageUpdated = () => callback({ id: 'b1' })
    return () => {}
  }) as unknown as typeof window.api.onHomePageUpdated
  window.api.onHomePageDeleted = vi.fn(
    () => () => {}
  ) as unknown as typeof window.api.onHomePageDeleted
})

describe('HomeTabTitleSync', () => {
  it('retitles a restored Home tab to the board it is actually showing', async () => {
    // The reported bug, and the rehydration case in one: a tab persisted by an
    // older build carries the stamped literal "Home" with no board id at all.
    localStorage.setItem(ACTIVE_KEY, 'b2')
    const view = mount(makeState([makeGroup('main', [homeTab()])]))

    await waitFor(() => expect(view.titleOf('main', 'tab-home')).toBe('Work'))
  })

  it('keeps "Home" while the untouched default board is the one open', async () => {
    localStorage.setItem(ACTIVE_KEY, 'b1')
    const view = mount(makeState([makeGroup('main', [homeTab()])]))

    await waitFor(() => expect(window.api.homePages.list).toHaveBeenCalled())
    await Promise.resolve()

    expect(view.titleOf('main', 'tab-home')).toBe('Home')
  })

  it('follows a switch to another board', async () => {
    localStorage.setItem(ACTIVE_KEY, 'b1')
    const view = mount(makeState([makeGroup('main', [homeTab()])]))
    await waitFor(() => expect(view.titleOf('main', 'tab-home')).toBe('Home'))

    act(() => view.selectBoard('b2'))

    await waitFor(() => expect(view.titleOf('main', 'tab-home')).toBe('Work'))
  })

  it('follows a rename of the board that is open', async () => {
    localStorage.setItem(ACTIVE_KEY, 'b2')
    const view = mount(makeState([makeGroup('main', [homeTab()])]))
    await waitFor(() => expect(view.titleOf('main', 'tab-home')).toBe('Work'))

    boards = [board('b1', 'Home', 0), board('b2', 'Planning', 1)]
    act(() => emitHomePageUpdated?.())

    await waitFor(() => expect(view.titleOf('main', 'tab-home')).toBe('Planning'))
  })

  it('retitles a Home tab the user is not looking at', async () => {
    // The reason this component sits above the tab tree: only the ACTIVE tab is
    // mounted, so the Home page itself is not rendered in this scenario.
    localStorage.setItem(ACTIVE_KEY, 'b2')
    const view = mount(makeState([makeGroup('main', [noteTab(), homeTab()], 'tab-note')]))

    await waitFor(() => expect(view.titleOf('main', 'tab-home')).toBe('Work'))
    expect(view.titleOf('main', 'tab-note')).toBe('Some note')
  })

  it('retitles the Home tab in every pane it is open in', async () => {
    localStorage.setItem(ACTIVE_KEY, 'b2')
    const view = mount(
      makeState([
        makeGroup('main', [homeTab({ id: 'tab-left' })]),
        makeGroup('side', [homeTab({ id: 'tab-right' })])
      ])
    )

    await waitFor(() => expect(view.titleOf('main', 'tab-left')).toBe('Work'))
    expect(view.titleOf('side', 'tab-right')).toBe('Work')
  })

  it('follows the selection when the open board is deleted out from under it', async () => {
    localStorage.setItem(ACTIVE_KEY, 'b2')
    const view = mount(makeState([makeGroup('main', [homeTab()])]))
    await waitFor(() => expect(view.titleOf('main', 'tab-home')).toBe('Work'))

    // The stored id survives the delete; `useHomeBoards` resolves it to the
    // first board that still exists, and the title has to follow that.
    boards = [board('b1', 'Home', 0)]
    act(() => emitHomePageUpdated?.())

    await waitFor(() => expect(view.titleOf('main', 'tab-home')).toBe('Home'))
  })

  it('falls back to "Home" when the vault has no boards at all', async () => {
    boards = []
    const view = mount(makeState([makeGroup('main', [homeTab({ title: 'Work' })])]))

    await waitFor(() => expect(view.titleOf('main', 'tab-home')).toBe('Home'))
  })

  it('falls back to "Home" when a board name is blank', async () => {
    localStorage.setItem(ACTIVE_KEY, 'b2')
    boards = [board('b1', 'Home', 0), board('b2', '   ', 1)]
    const view = mount(makeState([makeGroup('main', [homeTab({ title: 'Work' })])]))

    await waitFor(() => expect(view.titleOf('main', 'tab-home')).toBe('Home'))
  })

  it('leaves the restored title alone while the board list is still loading', async () => {
    listBoards = () => new Promise<TestBoard[]>(() => {})
    const view = mount(makeState([makeGroup('main', [homeTab({ title: 'Work' })])]))

    await waitFor(() => expect(window.api.homePages.list).toHaveBeenCalled())

    expect(view.titleOf('main', 'tab-home')).toBe('Work')
  })

  it('leaves tab state untouched when a refetch carries the title the tab already has', async () => {
    // Widget edits invalidate the same query, so this is the common case, not
    // the edge one: it must not churn state the persistence layer writes.
    localStorage.setItem(ACTIVE_KEY, 'b2')
    const view = mount(makeState([makeGroup('main', [homeTab()])]))
    await waitFor(() => expect(view.titleOf('main', 'tab-home')).toBe('Work'))
    const before = view.groups

    act(() => emitHomePageUpdated?.())
    await waitFor(() => expect(window.api.homePages.list).toHaveBeenCalledTimes(2))

    expect(view.groups).toBe(before)
  })

  it('leaves tabs that are not Home alone', async () => {
    localStorage.setItem(ACTIVE_KEY, 'b2')
    const view = mount(makeState([makeGroup('main', [noteTab()])]))

    await waitFor(() => expect(window.api.homePages.list).toHaveBeenCalled())

    expect(view.titleOf('main', 'tab-note')).toBe('Some note')
  })
})
