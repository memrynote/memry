import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAIConnections } from './use-ai-connections'
import { useAIInline } from './use-ai-inline'
import { useActiveHeading } from './use-active-heading'
import { useCalendarPreferences, resolveDayCellClickBehavior } from './use-calendar-preferences'
import { useCountdown } from './use-countdown'
import { useDayContext } from './use-day-context'
import { useEditorSettings } from './use-editor-settings'
import { useExpandedTasks } from './use-expanded-tasks'
import { useFlushOnQuit } from './use-flush-on-quit'
import { useFocusTrap } from './use-focus-trap'
import { useFolderViewEvents } from './use-folder-view-events'
import { useGraphData, useGraphReactivity, useLocalGraphData } from './use-graph-data'
import { useGraphFilters } from './use-graph-filters'
import { useGraphSettings } from './use-graph-settings'
import { useInboxKeyboard } from './use-inbox-keyboard'
import { useJournalSettings } from './use-journal-settings'
import { useKeyboardSettings } from './use-keyboard-settings'
import { useSearchShortcut } from './use-search-shortcut'
import { useSettingsShortcut } from './use-settings-shortcut'
import { useStorageUsage } from './use-storage-usage'
import { useUndoableAction } from './use-undoable-action'
import { AISettingsProvider } from '@/contexts/ai-settings-context'
import { getAIConnections } from '@/services/ai-connections-service'
import { toast } from 'sonner'

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  setActiveTab: vi.fn(),
  tabsDispatch: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  },
  flushAllPendingSaves: vi.fn(),
  hasPendingSaves: vi.fn(),
  inbox: {
    items: [] as Array<Record<string, unknown>>,
    archive: vi.fn(),
    undoArchive: vi.fn(),
    undoFile: vi.fn(),
    convertToNote: vi.fn(),
    convertToTask: vi.fn(),
    file: vi.fn(),
    snooze: vi.fn()
  },
  reminders: {
    reminders: [] as Array<Record<string, unknown>>,
    create: vi.fn(),
    delete: vi.fn(),
    dismiss: vi.fn(),
    snooze: vi.fn()
  },
  notesListeners: {} as Record<string, (...args: any[]) => void>,
  taskListeners: {} as Record<string, (...args: any[]) => void>,
  unsubscribe: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key
  })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn()
  })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => mocks.logger
}))

vi.mock('@/lib/save-registry', () => ({
  flushAllPendingSaves: (...args: unknown[]) => mocks.flushAllPendingSaves(...args),
  hasPendingSaves: (...args: unknown[]) => mocks.hasPendingSaves(...args)
}))

vi.mock('@/services/ai-connections-service', () => ({
  MIN_CONTENT_LENGTH: 20,
  getAIConnections: vi.fn()
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({
    openTab: mocks.openTab,
    setActiveTab: mocks.setActiveTab,
    state: { activeGroupId: 'pane-a' },
    dispatch: mocks.tabsDispatch
  })
}))

vi.mock('@/services/inbox-service', () => ({
  inboxService: {
    archive: (...args: unknown[]) => mocks.inbox.archive(...args),
    undoArchive: (...args: unknown[]) => mocks.inbox.undoArchive(...args),
    undoFile: (...args: unknown[]) => mocks.inbox.undoFile(...args)
  }
}))

vi.mock('./use-inbox', () => ({
  inboxKeys: {
    lists: () => ['inbox', 'lists'],
    stats: () => ['inbox', 'stats']
  },
  useInboxList: () => ({
    items: mocks.inbox.items,
    total: mocks.inbox.items.length,
    isLoading: false
  }),
  useArchiveInboxItem: () => ({ mutateAsync: mocks.inbox.archive }),
  useConvertToNote: () => ({ mutateAsync: mocks.inbox.convertToNote }),
  useConvertToTask: () => ({ mutateAsync: mocks.inbox.convertToTask }),
  useFileInboxItem: () => ({ mutateAsync: mocks.inbox.file }),
  useSnoozeInboxItem: () => ({ mutateAsync: mocks.inbox.snooze })
}))

vi.mock('./use-reminders', () => ({
  useRemindersForTarget: () => ({
    reminders: mocks.reminders.reminders,
    isLoading: false,
    hasReminders: mocks.reminders.reminders.length > 0
  }),
  useCreateReminder: () => ({ mutateAsync: mocks.reminders.create }),
  useDeleteReminder: () => ({ mutateAsync: mocks.reminders.delete }),
  useDismissReminder: () => ({
    mutateAsync: mocks.reminders.dismiss,
    mutate: mocks.reminders.dismiss
  }),
  useSnoozeReminder: () => ({ mutateAsync: mocks.reminders.snooze })
}))

vi.mock('@/hooks/use-keyboard-shortcuts', () => ({
  isInputFocused: vi.fn(() => false)
}))

vi.mock('@/services/notes-service', () => {
  const subscribe = (name: string) =>
    vi.fn((callback: () => void) => {
      mocks.notesListeners[name] = callback
      return mocks.unsubscribe
    })
  return {
    onNoteMoved: subscribe('moved'),
    onNoteDeleted: subscribe('deleted'),
    onNoteCreated: subscribe('created'),
    onNoteUpdated: subscribe('updated'),
    onNoteRenamed: subscribe('renamed'),
    onNoteExternalChange: subscribe('external')
  }
})

vi.mock('@/services/tasks-service', () => {
  const subscribe = (name: string) =>
    vi.fn((callback: () => void) => {
      mocks.taskListeners[name] = callback
      return mocks.unsubscribe
    })
  return {
    onTaskCreated: subscribe('created'),
    onTaskUpdated: subscribe('updated'),
    onTaskDeleted: subscribe('deleted')
  }
})

function queryWrapper(
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

function aiSettingsWrapper() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AISettingsProvider>{children}</AISettingsProvider>
  }
}

function installAnimationFrame() {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
}

function longContent(label = 'content') {
  return `${label} `.repeat(20)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  installAnimationFrame()
  mocks.inbox.items = [
    { id: 'item-1', title: 'First', sourceUrl: 'https://example.com/one' },
    { id: 'item-2', title: 'Second', sourceUrl: 'https://example.com/two' }
  ]
  mocks.inbox.archive.mockResolvedValue({ success: true })
  mocks.inbox.undoArchive.mockResolvedValue({ success: true })
  mocks.inbox.undoFile.mockResolvedValue({ success: true })
  mocks.inbox.convertToNote.mockResolvedValue({ success: true })
  mocks.inbox.convertToTask.mockResolvedValue({ success: true })
  mocks.inbox.file.mockResolvedValue({ success: true })
  mocks.inbox.snooze.mockResolvedValue({ success: true })
  mocks.reminders.reminders = [
    { id: 'later', status: 'pending', remindAt: '2026-05-12T00:00:00.000Z' },
    { id: 'soon', status: 'snoozed', remindAt: '2026-05-11T00:00:00.000Z' },
    { id: 'done', status: 'dismissed', remindAt: '2026-05-10T00:00:00.000Z' }
  ]
  mocks.reminders.create.mockResolvedValue({ success: true })
  mocks.reminders.delete.mockResolvedValue({ success: true })
  mocks.reminders.dismiss.mockResolvedValue({ success: true })
  mocks.reminders.snooze.mockResolvedValue({ success: true })
  const api = window.api as typeof window.api & {
    syncOps?: { getStorageBreakdown?: ReturnType<typeof vi.fn> }
    settings: typeof window.api.settings & { resetKeyboardSettings?: ReturnType<typeof vi.fn> }
  }
  api.syncOps = api.syncOps ?? {}
  api.syncOps.getStorageBreakdown = vi.fn().mockResolvedValue({
    used: 512,
    limit: 1024,
    breakdown: { notes: 256, attachments: 128, crdt: 64, other: 64 }
  })
  api.settings.getJournalSettings = vi.fn().mockResolvedValue({
    defaultTemplate: null,
    showSchedule: true,
    showTasks: true,
    showAIConnections: true,
    showStatsFooter: false
  })
  api.settings.setJournalSettings = vi.fn().mockResolvedValue({ success: true })
  api.settings.getEditorSettings = vi.fn().mockResolvedValue({
    width: 'wide',
    toolbarMode: 'fixed'
  })
  api.settings.setEditorSettings = vi.fn().mockResolvedValue({ success: true })
  api.settings.getCalendarSettings = vi.fn().mockResolvedValue({
    defaultView: 'week',
    firstDayOfWeek: 1,
    showWeekends: true,
    showDeclinedEvents: false,
    dayCellClickBehavior: 'journal',
    calendarPageClickOverride: 'inherit'
  })
  api.settings.setCalendarSettings = vi.fn().mockResolvedValue({ success: true })
  api.settings.getGraphSettings = vi.fn().mockResolvedValue({
    layout: 'force',
    nodeSize: 'connections',
    showLabels: true,
    animationSpeed: 'normal',
    maxNodes: 500,
    physicsEnabled: true
  })
  api.settings.setGraphSettings = vi.fn().mockResolvedValue({ success: true })
  api.settings.getKeyboardSettings = vi
    .fn()
    .mockResolvedValue({ overrides: { save: 'Mod+S' }, globalCapture: 'Mod+Shift+Space' })
  api.settings.setKeyboardSettings = vi.fn().mockResolvedValue({ success: true })
  api.settings.resetKeyboardSettings = vi.fn().mockResolvedValue({ success: true })
  api.graph = {
    getData: vi.fn().mockResolvedValue({ nodes: [{ id: 'note-1' }], edges: [] }),
    getLocal: vi.fn().mockResolvedValue({ nodes: [{ id: 'local-1' }], edges: [] })
  } as never
  api.journal = {
    ...(api.journal ?? {}),
    getDayContext: vi.fn().mockResolvedValue({
      tasks: [{ id: 'task-1', dueDate: '2026-05-10' }],
      events: [{ id: 'event-1' }],
      overdueCount: 2
    })
  } as never
  api.onTaskUpdated = vi.fn((callback) => {
    mocks.taskListeners.apiUpdated = callback as never
    return mocks.unsubscribe
  })
  api.onTaskCreated = vi.fn((callback) => {
    mocks.taskListeners.apiCreated = callback as never
    return mocks.unsubscribe
  })
  api.onTaskDeleted = vi.fn((callback) => {
    mocks.taskListeners.apiDeleted = callback as never
    return mocks.unsubscribe
  })
  api.onTaskCompleted = vi.fn((callback) => {
    mocks.taskListeners.apiCompleted = callback as never
    return mocks.unsubscribe
  })
  api.onFlushRequested = vi.fn((callback) => {
    mocks.taskListeners.flush = callback as never
    return mocks.unsubscribe
  })
  api.notifyFlushDone = vi.fn()
  window.api.onSettingsChanged = vi.fn(() => mocks.unsubscribe)
  mocks.flushAllPendingSaves.mockResolvedValue(undefined)
  mocks.hasPendingSaves.mockReturnValue(false)
})

describe('AI hooks', () => {
  it('debounces AI connection analysis, refreshes, and handles errors', async () => {
    vi.useFakeTimers()
    vi.mocked(getAIConnections).mockResolvedValue([{ id: 'c1', title: 'Connection' }] as never)
    const { result, rerender } = renderHook(({ content }) => useAIConnections(content), {
      initialProps: { content: longContent('first') }
    })

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    await waitFor(() =>
      expect(result.current.connections).toEqual([{ id: 'c1', title: 'Connection' }])
    )

    rerender({ content: 'short' })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    await waitFor(() => expect(result.current.connections).toEqual([]))

    vi.mocked(getAIConnections).mockRejectedValueOnce(new Error('analysis failed'))
    rerender({ content: longContent('second') })
    act(() => {
      vi.advanceTimersByTime(2500)
    })
    await waitFor(() => expect(result.current.error).toBe('analysis failed'))

    vi.mocked(getAIConnections).mockResolvedValueOnce([{ id: 'c2' }] as never)
    act(() => {
      result.current.refresh()
    })
    await waitFor(() => expect(result.current.connections).toEqual([{ id: 'c2' }]))
  })

  it('aborts and clears AI connection analysis when AI is disabled', async () => {
    vi.useFakeTimers()
    let onSettingsChanged: ((event: { key: string; value: unknown }) => void) | undefined
    const api = window.api as typeof window.api & {
      onSettingsChanged: (callback: (event: { key: string; value: unknown }) => void) => () => void
    }
    vi.mocked(api.settings.getAISettings).mockResolvedValue({ enabled: true })
    api.onSettingsChanged = vi.fn((callback) => {
      onSettingsChanged = callback
      return mocks.unsubscribe
    })
    vi.mocked(getAIConnections).mockImplementation(
      (_content, signal) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }) as never
    )

    const { result } = renderHook(() => useAIConnections(longContent('first')), {
      wrapper: aiSettingsWrapper()
    })

    await waitFor(() => expect(api.settings.getAISettings).toHaveBeenCalled())
    await waitFor(() => expect(api.onSettingsChanged).toHaveBeenCalled())
    act(() => {
      onSettingsChanged?.({ key: 'ai', value: { enabled: true } })
    })
    act(() => {
      vi.advanceTimersByTime(2500)
    })
    await waitFor(() => expect(getAIConnections).toHaveBeenCalled())

    act(() => {
      onSettingsChanged?.({ key: 'ai', value: { enabled: false } })
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(result.current.connections).toEqual([])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('initializes AI inline from disabled, healthy, failed, and retry states', async () => {
    const invoke = vi.fn()
    window.electron.ipcRenderer.invoke = invoke
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as never

    const globallyDisabled = renderHook(() => useAIInline(false))
    await waitFor(() => expect(globallyDisabled.result.current.loading).toBe(false))
    expect(globallyDisabled.result.current.port).toBeNull()
    expect(invoke).toHaveBeenCalledWith('ai-inline:stop-server')
    expect(invoke).not.toHaveBeenCalledWith('ai-inline:get-settings')
    expect(invoke).not.toHaveBeenCalledWith('ai-inline:get-server-port')
    expect(invoke).not.toHaveBeenCalledWith('ai-inline:start-server')
    globallyDisabled.unmount()
    invoke.mockClear()

    invoke.mockResolvedValueOnce({ enabled: false, provider: 'ollama' })
    const disabled = renderHook(() => useAIInline())
    await waitFor(() => expect(disabled.result.current.loading).toBe(false))
    expect(disabled.result.current.port).toBeNull()
    disabled.unmount()

    invoke.mockResolvedValueOnce({ enabled: true, provider: 'ollama' }).mockResolvedValueOnce(3210)
    const healthy = renderHook(() => useAIInline())
    await waitFor(() => expect(healthy.result.current.port).toBe(3210))
    healthy.unmount()

    invoke
      .mockResolvedValueOnce({ enabled: true, provider: 'ollama' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ success: false, error: 'ECONNREFUSED' })
      .mockResolvedValueOnce({ enabled: true, provider: 'openai' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ success: false, error: '401 api key' })
    const failed = renderHook(() => useAIInline())
    await waitFor(() => expect(failed.result.current.error).toContain('Ollama is not running'))
    act(() => failed.result.current.retry())
    await waitFor(() => expect(failed.result.current.error).toContain('Invalid API key for openai'))
  })
})

describe('navigation and keyboard hooks', () => {
  it('tracks active headings and supports manual override', async () => {
    document.body.innerHTML = '<h1 data-id="h1">One</h1><h2 data-id="h2">Two</h2>'
    const [h1, h2] = Array.from(document.querySelectorAll('[data-id]')) as HTMLElement[]
    h1.getBoundingClientRect = vi.fn(() => ({ top: 20, bottom: 40 }) as DOMRect)
    h2.getBoundingClientRect = vi.fn(() => ({ top: 80, bottom: 100 }) as DOMRect)
    const headings = [
      { id: 'h1', level: 1, text: 'One', position: 0 },
      { id: 'h2', level: 2, text: 'Two', position: 1 }
    ]
    const { result } = renderHook(() =>
      useActiveHeading({
        headings,
        offset: 90
      })
    )

    await waitFor(() => expect(result.current.activeHeadingId).toBe('h2'))
    act(() => result.current.setActiveHeading('h1'))
    expect(result.current.activeHeadingId).toBe('h1')
  })

  it('handles inbox keyboard refresh, archive, bulk archive, and source opening', () => {
    const callbacks = {
      onRefresh: vi.fn(),
      onArchiveFocusedItem: vi.fn(),
      onOpenBulkArchiveDialog: vi.fn(),
      onOpenSourceUrl: vi.fn()
    }
    const { rerender } = renderHook((props) => useInboxKeyboard(props), {
      initialProps: {
        enabled: true,
        isDetailPanelOpen: false,
        isBulkFilePanelOpen: false,
        isInBulkMode: false,
        focusedItemId: 'item-1',
        items: mocks.inbox.items as never,
        ...callbacks
      }
    })

    fireEvent.keyDown(window, { key: 'r' })
    expect(callbacks.onRefresh).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('phaseI.toasts.inboxRefreshed')

    fireEvent.keyDown(window, { key: 'Delete' })
    expect(callbacks.onArchiveFocusedItem).toHaveBeenCalledWith('item-1', 'item-2')

    fireEvent.keyDown(window, { key: 'o' })
    expect(callbacks.onOpenSourceUrl).toHaveBeenCalledWith('https://example.com/one')

    rerender({
      enabled: true,
      isDetailPanelOpen: false,
      isBulkFilePanelOpen: false,
      isInBulkMode: true,
      focusedItemId: 'item-1',
      items: mocks.inbox.items as never,
      ...callbacks
    })
    fireEvent.keyDown(window, { key: 'Backspace' })
    expect(callbacks.onOpenBulkArchiveDialog).toHaveBeenCalled()
  })

  it('keeps one inbox keydown listener across item churn and reads the latest items', () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const callbacks = {
      onRefresh: vi.fn(),
      onArchiveFocusedItem: vi.fn(),
      onOpenBulkArchiveDialog: vi.fn(),
      onOpenSourceUrl: vi.fn()
    }
    const baseProps = {
      enabled: true,
      isDetailPanelOpen: false,
      isBulkFilePanelOpen: false,
      isInBulkMode: false,
      focusedItemId: 'item-1',
      ...callbacks
    }
    const { rerender, unmount } = renderHook((props) => useInboxKeyboard(props), {
      initialProps: { ...baseProps, items: mocks.inbox.items as never }
    })

    const keydownAdds = (): unknown[] => addSpy.mock.calls.filter(([type]) => type === 'keydown')
    const keydownRemoves = (): unknown[] =>
      removeSpy.mock.calls.filter(([type]) => type === 'keydown')

    expect(keydownAdds()).toHaveLength(1)

    // Every refetch/optimistic update hands the hook a fresh array identity.
    for (let i = 0; i < 5; i++) {
      rerender({ ...baseProps, items: [...mocks.inbox.items] as never })
    }

    expect(keydownAdds()).toHaveLength(1)
    expect(keydownRemoves()).toHaveLength(0)

    // The single listener must still see the newest items array.
    rerender({
      ...baseProps,
      items: [
        { id: 'item-1', title: 'First', sourceUrl: 'https://example.com/one' },
        { id: 'item-9', title: 'Ninth', sourceUrl: 'https://example.com/nine' }
      ] as never
    })
    fireEvent.keyDown(window, { key: 'Delete' })
    expect(callbacks.onArchiveFocusedItem).toHaveBeenCalledWith('item-1', 'item-9')

    unmount()
    expect(keydownRemoves()).toHaveLength(1)

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('handles search, settings, countdown, and flush lifecycle hooks', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'))
    const isMacPlatform = navigator.platform.toUpperCase().includes('MAC')
    const shortcutModifier = isMacPlatform ? { metaKey: true } : { ctrlKey: true }
    const onSearch = vi.fn()
    const onSettings = vi.fn()

    const search = renderHook(() => useSearchShortcut(onSearch))
    fireEvent.keyDown(window, { key: 'k', ...shortcutModifier })
    fireEvent.keyDown(window, { key: 'p', ...shortcutModifier })
    expect(onSearch).toHaveBeenCalledTimes(2)
    search.unmount()

    const settings = renderHook(() => useSettingsShortcut(onSettings))
    fireEvent.keyDown(window, { key: ',', ...shortcutModifier })
    expect(onSettings).toHaveBeenCalled()
    settings.unmount()

    const countdown = renderHook(() =>
      useCountdown(Math.floor(new Date('2026-05-10T12:01:05.000Z').getTime() / 1000))
    )
    expect(countdown.result.current.formattedTime).toBe('1:05')
    act(() => vi.advanceTimersByTime(65_000))
    expect(countdown.result.current.isExpired).toBe(true)
    countdown.unmount()

    const flush = renderHook(() => useFlushOnQuit())
    await act(async () => {
      await mocks.taskListeners.flush('flush-1')
    })
    expect(mocks.flushAllPendingSaves).toHaveBeenCalled()
    // The request id has to survive the round trip or main can't tell which
    // flush was answered and falls back to its timeout.
    expect(window.api.notifyFlushDone).toHaveBeenCalledWith('flush-1')
    mocks.hasPendingSaves.mockReturnValueOnce(true)
    fireEvent(window, new Event('beforeunload'))
    expect(mocks.flushAllPendingSaves).toHaveBeenCalledTimes(2)
    flush.unmount()
  })
})

describe('state and settings hooks', () => {
  it('persists expanded tasks and reloads when storage key changes', () => {
    localStorage.setItem('expandedTasks-a', JSON.stringify(['task-1']))
    const { result, rerender } = renderHook(
      ({ keyName }) => useExpandedTasks({ storageKey: keyName }),
      {
        initialProps: { keyName: 'a' }
      }
    )

    expect(result.current.isExpanded('task-1')).toBe(true)
    act(() => result.current.toggleExpanded('task-2'))
    expect(result.current.isExpanded('task-2')).toBe(true)
    act(() => result.current.collapse('task-1'))
    expect(result.current.isExpanded('task-1')).toBe(false)
    act(() =>
      result.current.expandAll([
        { id: 'parent', subtaskIds: ['child'] },
        { id: 'child', subtaskIds: [] }
      ] as never)
    )
    expect(result.current.expandedIds).toEqual(new Set(['parent']))
    act(() => result.current.collapseAll())
    expect(result.current.expandedIds).toEqual(new Set())

    localStorage.setItem('expandedTasks-b', JSON.stringify(['other']))
    rerender({ keyName: 'b' })
    expect(result.current.expandedIds).toEqual(new Set(['other']))
  })

  it('manages storage usage success and failure states', async () => {
    const { result } = renderHook(() => useStorageUsage())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data?.used).toBe(512)

    window.api.syncOps.getStorageBreakdown = vi
      .fn()
      .mockRejectedValueOnce(new Error('quota failed'))
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.error).toBe('quota failed')
  })

  it('loads, updates, and receives journal and keyboard settings', async () => {
    let settingsChanged: ((event: { key: string; value: unknown }) => void) | null = null
    window.api.onSettingsChanged = vi.fn((callback) => {
      settingsChanged = callback as typeof settingsChanged
      return mocks.unsubscribe
    })

    const journal = renderHook(() => useJournalSettings())
    await waitFor(() => expect(journal.result.current.isLoading).toBe(false))
    await act(async () => {
      await journal.result.current.setDefaultTemplate('daily')
    })
    expect(window.api.settings.setJournalSettings).toHaveBeenCalledWith({
      defaultTemplate: 'daily'
    })
    act(() => settingsChanged?.({ key: 'journal', value: { showStatsFooter: true } }))
    expect(journal.result.current.settings.showStatsFooter).toBe(true)

    const keyboard = renderHook(() => useKeyboardSettings())
    await waitFor(() => expect(keyboard.result.current.isLoading).toBe(false))
    await act(async () => {
      await keyboard.result.current.updateSettings({ globalCapture: 'Mod+K' })
      await keyboard.result.current.resetToDefaults()
    })
    expect(window.api.settings.setKeyboardSettings).toHaveBeenCalledWith({ globalCapture: 'Mod+K' })
    expect(window.api.settings.resetKeyboardSettings).toHaveBeenCalled()
  })

  it('loads and updates editor and calendar preferences', async () => {
    let settingsChanged: ((event: { key: string; value: unknown }) => void) | null = null
    window.api.onSettingsChanged = vi.fn((callback) => {
      settingsChanged = callback as typeof settingsChanged
      return mocks.unsubscribe
    })

    const editor = renderHook(() => useEditorSettings())
    await waitFor(() => expect(editor.result.current.isLoading).toBe(false))
    expect(editor.result.current.settings.width).toBe('wide')
    await act(async () => {
      await editor.result.current.updateSettings({ width: 'narrow' })
    })
    expect(window.api.settings.setEditorSettings).toHaveBeenCalledWith({ width: 'narrow' })
    act(() => settingsChanged?.({ key: 'editor', value: { toolbarMode: 'floating' } }))
    expect(editor.result.current.settings.toolbarMode).toBe('floating')

    window.api.settings.setEditorSettings = vi.fn().mockResolvedValueOnce({
      success: false,
      error: 'editor failed'
    })
    await act(async () => {
      await editor.result.current.updateSettings({ width: 'medium' })
    })
    expect(editor.result.current.error).toBe('editor failed')

    const calendar = renderHook(() => useCalendarPreferences())
    await waitFor(() => expect(calendar.result.current.isLoading).toBe(false))
    expect(calendar.result.current.settings.defaultView).toBe('week')
    await act(async () => {
      await calendar.result.current.updateSettings({ dayCellClickBehavior: 'calendar' })
    })
    expect(window.api.settings.setCalendarSettings).toHaveBeenCalledWith({
      dayCellClickBehavior: 'calendar'
    })
    act(() =>
      settingsChanged?.({ key: 'calendar', value: { calendarPageClickOverride: 'journal' } })
    )
    expect(calendar.result.current.settings.calendarPageClickOverride).toBe('journal')
    expect(resolveDayCellClickBehavior(calendar.result.current.settings, true)).toBe('journal')
    expect(
      resolveDayCellClickBehavior(
        { ...calendar.result.current.settings, calendarPageClickOverride: 'inherit' },
        true
      )
    ).toBe('calendar')
  })

  it('covers graph filters, queries, settings, day context, and undo actions', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = queryWrapper(queryClient)

    const filters = renderHook(() => useGraphFilters())
    expect(filters.result.current.isFiltered).toBe(false)
    act(() => filters.result.current.dispatch({ type: 'TOGGLE_ENTITY_TYPE', entityType: 'note' }))
    expect(filters.result.current.filterState.showNotes).toBe(false)
    act(() => filters.result.current.dispatch({ type: 'TOGGLE_ORPHANS' }))
    act(() => filters.result.current.dispatch({ type: 'SET_SELECTED_TAGS', tags: ['work'] }))
    act(() =>
      filters.result.current.dispatch({ type: 'SET_FOCUS_NODE', nodeId: 'note-1', depth: 3 })
    )
    act(() => filters.result.current.dispatch({ type: 'SET_FOCUS_DEPTH', depth: 4 }))
    act(() => filters.result.current.dispatch({ type: 'SET_SEARCH_QUERY', query: 'alpha' }))
    expect(filters.result.current.isFiltered).toBe(true)
    act(() => filters.result.current.dispatch({ type: 'CLEAR_FOCUS' }))
    act(() => filters.result.current.dispatch({ type: 'RESET_FILTERS' }))
    expect(filters.result.current.isFiltered).toBe(false)

    const graph = renderHook(() => useGraphData(), { wrapper })
    await waitFor(() => expect(graph.result.current.data?.nodes).toEqual([{ id: 'note-1' }]))
    const local = renderHook(({ noteId }) => useLocalGraphData(noteId), {
      initialProps: { noteId: undefined as string | undefined },
      wrapper
    })
    expect(window.api.graph.getLocal).not.toHaveBeenCalled()
    local.rerender({ noteId: 'note-1' })
    await waitFor(() => expect(local.result.current.data?.nodes).toEqual([{ id: 'local-1' }]))

    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    renderHook(() => useGraphReactivity(), { wrapper })
    act(() => {
      mocks.notesListeners.created()
      mocks.taskListeners.updated()
    })
    // The graph refetch is debounced so one save cannot fan out into several.
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['graph'] })
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['graph'] }))

    const graphSettings = renderHook(() => useGraphSettings(), { wrapper })
    await waitFor(() => expect(graphSettings.result.current.settings.layout).toBe('force'))
    act(() => graphSettings.result.current.updateSettings({ physicsEnabled: false }))
    await waitFor(() =>
      expect(queryClient.getQueryData(['settings', 'graph'])).toMatchObject({
        physicsEnabled: false
      })
    )

    const dayContext = renderHook(() => useDayContext('2026-05-10'), { wrapper })
    await waitFor(() => expect(dayContext.result.current.tasks).toHaveLength(1))
    act(() =>
      mocks.taskListeners.apiUpdated({
        task: { dueDate: '2026-05-10' },
        changes: {}
      })
    )
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['journal', 'dayContext', '2026-05-10']
    })
    await act(async () => {
      await dayContext.result.current.reload()
    })

    const undo = renderHook(() => useUndoableAction(), { wrapper })
    await act(async () => {
      await undo.result.current.archiveWithUndo('item-1', 'First')
      await undo.result.current.fileWithUndo('item-2', 'Second')
    })
    expect(mocks.inbox.archive).toHaveBeenCalledWith('item-1')
    const firstToast = vi.mocked(toast.success).mock.calls[0]?.[1] as {
      action?: { onClick: () => void }
    }
    await act(async () => {
      firstToast.action?.onClick()
    })
    expect(mocks.inbox.undoArchive).toHaveBeenCalledWith('item-1')
  })
})

describe('DOM and cache hooks', () => {
  it('traps and restores focus inside a container', () => {
    function Trap({ active }: { active: boolean }) {
      const ref = useFocusTrap({ isActive: active })
      return (
        <div ref={ref}>
          <button>first</button>
          <button>last</button>
        </div>
      )
    }

    render(<button>outside</button>)
    screen.getByText('outside').focus()
    const { rerender } = render(<Trap active />)
    expect(screen.getByText('first')).toHaveFocus()

    screen.getByText('last').focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(screen.getByText('first')).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(screen.getByText('last')).toHaveFocus()

    rerender(<Trap active={false} />)
    expect(screen.getByText('outside')).toHaveFocus()
  })

  it('subscribes folder-view events and invalidates all folder caches', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const { unmount } = renderHook(() => useFolderViewEvents(), {
      wrapper: queryWrapper(queryClient)
    })

    act(() => mocks.notesListeners.created())
    expect(invalidate).toHaveBeenCalled()
    unmount()
    expect(mocks.unsubscribe).toHaveBeenCalled()
  })
})
