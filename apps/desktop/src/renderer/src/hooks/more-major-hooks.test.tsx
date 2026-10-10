import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activeItem: vi.fn(),
  getMonthEntries: vi.fn(),
  getYearStats: vi.fn(),
  invalidatePredicate: vi.fn(),
  listProjects: vi.fn(),
  logger: {
    error: vi.fn()
  },
  onInboxSnoozeDue: vi.fn(),
  openTab: vi.fn(),
  requestPermission: vi.fn(),
  setActiveTab: vi.fn(),
  splitView: vi.fn(() => 'group-split'),
  tabsDispatch: vi.fn(),
  toastInfo: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('sonner', () => ({
  toast: {
    info: mocks.toastInfo
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => mocks.logger
}))

vi.mock('@/services/inbox-service', () => ({
  onInboxSnoozeDue: mocks.onInboxSnoozeDue
}))

vi.mock('./use-inbox', () => ({
  inboxKeys: {
    lists: () => ['inbox', 'lists']
  }
}))

vi.mock('@/services/journal-service', () => ({
  journalService: {
    getMonthEntries: mocks.getMonthEntries,
    getYearStats: mocks.getYearStats
  }
}))

vi.mock('./use-journal-invalidation', () => ({
  useJournalChangeInvalidation: (_key: unknown, predicate: (date: string) => boolean) => {
    mocks.invalidatePredicate = vi.fn(predicate)
  }
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    listProjects: mocks.listProjects
  }
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({
    dispatch: mocks.tabsDispatch,
    openTab: mocks.openTab,
    setActiveTab: mocks.setActiveTab,
    splitView: mocks.splitView
  }),
  useTabSettings: () => ({ restoreSessionOnStart: true, tabCloseButton: 'hover' }),
  useTabs: () => ({
    state: {
      // useOpenTarget reads the layout to find the pane beside this one.
      layout: { type: 'leaf', tabGroupId: 'group-1' },
      activeGroupId: 'group-1',
      tabGroups: {
        'group-1': {
          id: 'group-1',
          activeTabId: 'tab-note',
          tabs: [
            {
              id: 'tab-note',
              type: 'note',
              path: '/notes/a.md',
              entityId: 'note-a',
              isPreview: true
            },
            { id: 'tab-tasks', type: 'tasks', path: '/tasks', isPreview: false }
          ]
        },
        'group-2': {
          id: 'group-2',
          activeTabId: null,
          tabs: [{ id: 'tab-folder', type: 'folder', path: '/folder', entityId: 'folder-1' }]
        }
      }
    }
  })
}))

vi.mock('./use-is-item-active', () => ({
  useIsItemActive: () => mocks.activeItem
}))

vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ open: vi.fn() })
}))

import { DENSITY_CONFIG, densityClasses, useDisplayDensity } from './use-display-density'
import { useInboxNotifications } from './use-inbox-notifications'
import { useMonthEntries } from './use-journal-month'
import { useYearStats } from './use-journal-stats'
import { useNewNoteShortcut } from './use-new-note-shortcut'
import { useProject } from './use-project'
import {
  findExistingTabForItem,
  isItemActiveTab,
  isItemOpenInTab,
  useSidebarNavigation
} from './use-sidebar-navigation'

function queryWrapper(
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

describe('more major hooks coverage', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    localStorage.clear()
    mocks.getMonthEntries.mockResolvedValue([{ date: '2026-05-10', title: 'Today' }])
    mocks.getYearStats.mockResolvedValue([{ month: 5, count: 3 }])
    mocks.listProjects.mockResolvedValue({
      projects: [
        { id: 'project-1', name: 'Work' },
        { id: 'project-2', name: 'Home' }
      ]
    })
    mocks.onInboxSnoozeDue.mockReturnValue(vi.fn())
    vi.stubGlobal(
      'Notification',
      Object.assign(vi.fn(), {
        permission: 'default',
        requestPermission: mocks.requestPermission
      })
    )
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn() }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('persists display density and exposes density helpers', () => {
    localStorage.setItem('memry-display-density', 'compact')
    const { result } = renderHook(() => useDisplayDensity())

    expect(result.current.density).toBe('compact')
    expect(result.current.isCompact).toBe(true)
    expect(densityClasses(result.current.density, 'roomy', 'tight')).toBe('tight')
    expect(DENSITY_CONFIG.compact.rowHeight).toBeLessThan(DENSITY_CONFIG.comfortable.rowHeight)

    act(() => result.current.toggleDensity())
    expect(result.current.density).toBe('comfortable')
    expect(localStorage.getItem('memry-display-density')).toBe('comfortable')

    act(() => result.current.setDensity('compact'))
    expect(result.current.isComfortable).toBe(false)
  })

  it('handles platform new-note shortcuts and cleanup', () => {
    const onNewNote = vi.fn()
    const { unmount } = renderHook(() => useNewNoteShortcut(onNewNote))
    const isMac = navigator.platform.toUpperCase().includes('MAC')

    fireEvent.keyDown(window, { key: 'n', ...(isMac ? { metaKey: true } : { ctrlKey: true }) })
    fireEvent.keyDown(window, { key: 'n' })
    expect(onNewNote).toHaveBeenCalledTimes(1)

    unmount()
    fireEvent.keyDown(window, { key: 'n', ...(isMac ? { metaKey: true } : { ctrlKey: true }) })
    expect(onNewNote).toHaveBeenCalledTimes(1)
  })

  it('opens sidebar items through existing tabs, split panes, pins, and copied links', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useSidebarNavigation())
    const noteItem = {
      type: 'note',
      title: 'A',
      path: '/notes/a.md',
      entityId: 'note-a'
    } as never

    result.current.openSidebarItem(noteItem)
    expect(mocks.setActiveTab).toHaveBeenCalledWith('tab-note', 'group-1')

    expect(mocks.tabsDispatch).not.toHaveBeenCalled()

    result.current.openSidebarItem(
      { type: 'note', title: 'B', path: '/notes/b.md', entityId: 'note-b' } as never,
      {}
    )
    // A plain open must never force a duplicate: `forceNew: false` is what keeps
    // the reducer free to focus a tab this item already has.
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'note-b', isPreview: false }),
      { background: undefined, forceNew: false, reuseActiveTab: true }
    )

    result.current.openSidebarItem(
      { type: 'note', title: 'C', path: '/notes/c.md', entityId: 'note-c' } as never,
      { inNewTab: true, inBackground: true }
    )
    // `inNewTab` on a non-singleton reaches the reducer as `forceNew`, which is
    // what makes it skip entity dedup and mint a genuinely new tab.
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'note-c', isPreview: false }),
      { background: true, forceNew: true, reuseActiveTab: true }
    )

    result.current.openSidebarItem(
      { type: 'collection', title: 'Folder', path: '/folder/new' } as never,
      { toTheSide: true }
    )
    expect(mocks.splitView).toHaveBeenCalledWith('horizontal', 'group-1', {
      cloneActiveTab: false
    })
    // The open targets the pane splitView reports creating, in the same turn —
    // no timer to flush, and no dependence on which pane is active by then.
    expect(mocks.openTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: '/folder/new' }),
      { groupId: 'group-split', background: undefined }
    )

    result.current.openAsPin({ type: 'tasks', title: 'Tasks', path: '/tasks' } as never)
    expect(mocks.openTab).toHaveBeenLastCalledWith(expect.objectContaining({ isPinned: true }))

    result.current.copyItemLink({ type: 'note', title: 'A', path: '/notes/a.md' } as never)
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('memry:///notes/a.md')
    expect(result.current.isOpenInTab(noteItem)).toBe(true)
    expect(result.current.isActiveItem).toBe(mocks.activeItem)
  })

  it('finds and matches existing tabs by singleton, entity, and path', () => {
    const state = {
      activeGroupId: 'g',
      tabGroups: {
        g: {
          activeTabId: 'settings',
          tabs: [
            { id: 'settings', type: 'settings', path: '/settings' },
            { id: 'note', type: 'note', path: '/notes/a.md', entityId: 'note-a' }
          ]
        }
      }
    } as never

    expect(
      findExistingTabForItem(state, { type: 'settings', path: '/settings' } as never)?.tab.id
    ).toBe('settings')
    expect(
      findExistingTabForItem(state, { type: 'note', path: '/other', entityId: 'note-a' } as never)
        ?.tab.id
    ).toBe('note')
    expect(isItemOpenInTab(state, { type: 'note', path: '/notes/a.md' } as never)).toBe(true)
    expect(isItemActiveTab(state, { type: 'settings', path: '/settings' } as never)).toBe(true)
    expect(
      isItemActiveTab(state, { type: 'note', path: '/notes/a.md', entityId: 'note-a' } as never)
    ).toBe(false)
  })

  it('fires inbox snooze notifications with query invalidation, desktop notification, and permission request', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    renderHook(() => useInboxNotifications(), { wrapper: queryWrapper(queryClient) })
    expect(mocks.requestPermission).toHaveBeenCalled()

    const callback = mocks.onInboxSnoozeDue.mock.calls[0][0] as (event: {
      items: Array<{ id: string; title: string }>
    }) => void
    ;(Notification as unknown as { permission: string }).permission = 'granted'
    callback({ items: [{ id: 'item-a', title: 'Read paper' }] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['inbox', 'lists'] })
    // `t` is stubbed to echo its key here, so these assert the wiring; the
    // rendered copy is covered in use-inbox-notifications.test.tsx.
    expect(Notification).toHaveBeenCalledWith('Read paper', {
      body: 'snoozeDue.notificationBody',
      icon: '/icon.png',
      tag: 'inbox-snooze-due:item-a'
    })
    expect(mocks.toastInfo).toHaveBeenCalledWith('snoozeDue.toast')

    callback({
      items: [
        { id: 'item-b', title: 'One' },
        { id: 'item-c', title: 'Two' }
      ]
    })
    expect(Notification).toHaveBeenCalledWith('snoozeDue.notificationTitle', {
      body: 'snoozeDue.notificationBody',
      icon: '/icon.png',
      tag: 'inbox-snooze-due:item-b,item-c'
    })
    expect(mocks.toastInfo).toHaveBeenCalledWith('snoozeDue.toast')

    callback({ items: [] })
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it('tags snooze notifications by resurfaced item id so concurrent mounts collapse to one banner', () => {
    // Split view (or a second window) mounts the inbox page twice, and the
    // snooze-due event is delivered to every subscriber.
    renderHook(() => useInboxNotifications(), { wrapper: queryWrapper() })
    renderHook(() => useInboxNotifications(), { wrapper: queryWrapper() })

    type SnoozeCallback = (event: { items: Array<{ id: string; title: string }> }) => void
    const first = mocks.onInboxSnoozeDue.mock.calls[0][0] as SnoozeCallback
    const second = mocks.onInboxSnoozeDue.mock.calls[1][0] as SnoozeCallback
    ;(Notification as unknown as { permission: string }).permission = 'granted'

    // Same resurface, different sources, and item order is not guaranteed.
    const dueItems = [
      { id: 'item-2', title: 'Read paper' },
      { id: 'item-1', title: 'Read paper' }
    ]
    first({ items: dueItems })
    second({ items: [...dueItems].reverse() })

    const tags = (
      Notification as unknown as { mock: { calls: [string, { tag: string }][] } }
    ).mock.calls.map(([, options]) => options.tag)
    expect(tags).toEqual(['inbox-snooze-due:item-1,item-2', 'inbox-snooze-due:item-1,item-2'])

    // A genuinely new resurface sharing the same title is still its own banner.
    first({ items: [{ id: 'item-3', title: 'Read paper' }] })
    expect(Notification).toHaveBeenLastCalledWith('Read paper', {
      body: 'snoozeDue.notificationBody',
      icon: '/icon.png',
      tag: 'inbox-snooze-due:item-3'
    })
  })

  it('loads project, month entries, and year stats query hooks', async () => {
    const wrapper = queryWrapper()

    const disabledProject = renderHook(() => useProject(null), { wrapper })
    expect(disabledProject.result.current.fetchStatus).toBe('idle')
    const project = renderHook(() => useProject('project-2'), { wrapper })
    await waitFor(() => expect(project.result.current.data?.name).toBe('Home'))

    const month = renderHook(() => useMonthEntries(2026, 5), { wrapper })
    await waitFor(() => expect(month.result.current.data).toHaveLength(1))
    expect(mocks.invalidatePredicate('2026-05-12')).toBe(true)
    expect(mocks.invalidatePredicate('2026-06-01')).toBe(false)
    await act(async () => month.result.current.reload())

    mocks.getYearStats.mockRejectedValueOnce(new Error('stats failed'))
    const stats = renderHook(() => useYearStats(2026), { wrapper })
    await waitFor(() => expect(stats.result.current.error).toBe('stats failed'))
    expect(mocks.invalidatePredicate('2026-12-31')).toBe(true)
    expect(mocks.invalidatePredicate('2025-12-31')).toBe(false)
    await act(async () => stats.result.current.reload())
  })
})
