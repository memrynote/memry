import { act, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useManualPersistence,
  useSessionRestore,
  useTabPersistence,
  useTabSessionPersistence
} from './hooks'
import {
  consumeSyncSaveFailure,
  isQuotaExceededError,
  localStorageAdapter,
  saveSync
} from './storage'
import { deserializeTabState, extractPinnedTabs, serializeTabState } from './serialization'
import { STORAGE_KEY, type PersistedTabState, type TabStorage } from './types'
import type { Tab, TabSystemState } from '@/contexts/tabs/types'

const mocks = vi.hoisted(() => ({
  tabsState: null as TabSystemState | null,
  dispatch: vi.fn(),
  pendingSave: null as null | (() => void),
  serializeCalls: 0,
  registerPendingSave: vi.fn((_: string, callback: () => void) => {
    mocks.pendingSave = callback
  }),
  unregisterPendingSave: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  // The restore reads storage only once the flag IPC has answered; holding this
  // true is how a test stands in for a cold start whose main process is busy.
  flagsLoading: false,
  flags: {
    home: true,
    inbox: true,
    journal: true,
    tasks: true,
    calendar: true,
    graph: true,
    spatialCanvas: true
  }
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, warning: mocks.toastWarning }
}))

// Counts full tab-tree serializations so the auto-save tests can assert how many
// times the tree is walked, independently of how long the debounce waits.
vi.mock('./serialization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./serialization')>()
  return {
    ...actual,
    serializeTabState: (state: TabSystemState) => {
      mocks.serializeCalls += 1
      return actual.serializeTabState(state)
    }
  }
})

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({
    state: mocks.tabsState,
    dispatch: mocks.dispatch
  })
}))

vi.mock('@/lib/save-registry', () => ({
  registerPendingSave: mocks.registerPendingSave,
  unregisterPendingSave: mocks.unregisterPendingSave
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => mocks.logger
}))

vi.mock('@/hooks/use-feature-flags', () => ({
  useFeatureFlags: () => ({
    flags: mocks.flags,
    isLoading: mocks.flagsLoading,
    error: null,
    isEnabled: () => true,
    setFlag: vi.fn()
  })
}))

/**
 * Refuse writes to one key, the way a full origin refuses the tab payload while
 * still having room for a handful of bytes.
 */
function refuseWritesTo(key: string, error: unknown) {
  const original = Storage.prototype.setItem
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    name: string,
    value: string
  ) {
    if (name === key) throw error
    original.call(this, name, value)
  })
}

const quotaError = (): DOMException => new DOMException('over quota', 'QuotaExceededError')

const tab = (overrides: Partial<Tab> = {}): Tab =>
  ({
    id: 'tab-1',
    type: 'note',
    title: 'Roadmap',
    icon: 'file-text',
    emoji: null,
    path: '/note/tab-1',
    entityId: 'tab-1',
    isPinned: false,
    isModified: false,
    isPreview: false,
    isDeleted: false,
    openedAt: 1,
    lastAccessedAt: 2,
    scrollPosition: 42,
    viewState: { cursor: 'top' },
    ...overrides
  }) as Tab

const state = (overrides: Partial<TabSystemState> = {}): TabSystemState =>
  ({
    activeGroupId: 'group-1',
    tabGroups: {
      'group-1': {
        id: 'group-1',
        activeTabId: 'tab-1',
        tabs: [
          tab(),
          tab({
            id: 'preview-1',
            title: 'Preview',
            isPreview: true
          }),
          tab({
            id: 'pin-1',
            type: 'inbox',
            title: 'Inbox',
            icon: 'inbox',
            path: '/inbox',
            entityId: undefined,
            isPinned: true
          })
        ],
        isActive: true,
        back: [],
        forward: []
      },
      'empty-group': {
        id: 'empty-group',
        activeTabId: null,
        tabs: [],
        isActive: false,
        back: [],
        forward: []
      }
    },
    layout: { type: 'leaf', tabGroupId: 'group-1' },
    settings: {
      restoreSessionOnStart: true,
      tabCloseButton: 'active',
      maxTabs: 20,
      showTabNumbers: false,
      enableTabHistory: true
    },
    ...overrides
  }) as TabSystemState

const persisted = (overrides: Partial<PersistedTabState> = {}): PersistedTabState => ({
  version: 2,
  tabGroups: {
    'group-1': {
      id: 'group-1',
      activeTabId: 'pin-1',
      tabs: [
        {
          id: 'pin-1',
          type: 'inbox',
          title: 'Inbox',
          icon: 'inbox',
          path: '/inbox',
          isPinned: true,
          viewState: { filter: 'today' }
        },
        {
          id: 'note-1',
          type: 'note',
          title: 'Note',
          icon: 'file-text',
          path: '/note/note-1',
          entityId: 'note-1',
          isPinned: false
        }
      ]
    }
  },
  layout: { type: 'leaf', tabGroupId: 'group-1' },
  activeGroupId: 'group-1',
  settings: state().settings,
  savedAt: 123,
  ...overrides
})

const CLOCK_START = 1_700_000_000_000
const STATE_CHANGES = 20

/** Publishes 20 distinct tab states, re-rendering the probe after each one. */
function applyStateChanges(rerender: () => void): void {
  for (let i = 1; i <= STATE_CHANGES; i++) {
    const next = state()
    next.tabGroups['group-1'].tabs[0] = tab({ title: `Roadmap ${i}` })
    mocks.tabsState = next
    rerender()
  }
}

/** The exact payload the last of those states must serialize to. */
const expectedPersisted = (savedAt: number): PersistedTabState => ({
  version: 2,
  tabGroups: {
    'group-1': {
      id: 'group-1',
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          type: 'note',
          title: `Roadmap ${STATE_CHANGES}`,
          icon: 'file-text',
          emoji: null,
          path: '/note/tab-1',
          entityId: 'tab-1',
          isPinned: false,
          scrollPosition: 42,
          viewState: { cursor: 'top' }
        },
        {
          id: 'pin-1',
          type: 'inbox',
          title: 'Inbox',
          icon: 'inbox',
          emoji: null,
          path: '/inbox',
          isPinned: true,
          scrollPosition: 42,
          viewState: { cursor: 'top' }
        }
      ]
    }
  },
  layout: { type: 'leaf', tabGroupId: 'group-1' },
  activeGroupId: 'group-1',
  settings: state().settings,
  savedAt
})

function withQueryClient(children: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

function TabPersistenceProbe({
  storage,
  debounceMs = 5,
  enabled = true
}: {
  storage: TabStorage
  debounceMs?: number
  enabled?: boolean
}) {
  useTabPersistence({ storage, debounceMs, enabled })
  return null
}

let sessionSnapshot: ReturnType<typeof useSessionRestore> | null = null
function SessionRestoreProbe({
  storage,
  autoRestore = true
}: {
  storage: TabStorage
  autoRestore?: boolean
}) {
  sessionSnapshot = useSessionRestore({ storage, autoRestore })
  return null
}

let manualSnapshot: ReturnType<typeof useManualPersistence> | null = null
function ManualPersistenceProbe({ storage }: { storage: TabStorage }) {
  manualSnapshot = useManualPersistence(storage)
  return null
}

/**
 * What `createInitialState` hands the provider before anything is restored:
 * one Home tab, in a group whose id has nothing to do with the stored session.
 */
const startupState = (): TabSystemState =>
  ({
    activeGroupId: 'startup-group',
    tabGroups: {
      'startup-group': {
        id: 'startup-group',
        activeTabId: 'home-1',
        tabs: [
          {
            id: 'home-1',
            type: 'home',
            title: 'Home',
            icon: 'home',
            path: '/home',
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false,
            openedAt: 1,
            lastAccessedAt: 1
          }
        ],
        isActive: true,
        back: [],
        forward: []
      }
    },
    layout: { type: 'leaf', tabGroupId: 'startup-group' },
    settings: state().settings,
    recentlyClosed: []
  }) as TabSystemState

/** Mounts the pair exactly the way `TabPersistenceManager` does at app start. */
function StartupProbe({ storage, debounceMs }: { storage: TabStorage; debounceMs: number }) {
  sessionSnapshot = useTabSessionPersistence({ storage, debounceMs })
  return null
}

describe('tab persistence serialization and storage', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    localStorage.clear()
    mocks.tabsState = state()
    mocks.pendingSave = null
    sessionSnapshot = null
    manualSnapshot = null
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('serializes durable tabs and deserializes invalid persisted layouts safely', () => {
    const serialized = serializeTabState(state())

    expect(Object.keys(serialized.tabGroups)).toEqual(['group-1'])
    expect(serialized.tabGroups['group-1'].tabs.map((item) => item.id)).toEqual(['tab-1', 'pin-1'])

    const restored = deserializeTabState(
      persisted({
        layout: { type: 'leaf', tabGroupId: 'missing-group' },
        activeGroupId: 'missing-group',
        tabGroups: {
          'group-1': {
            id: 'group-1',
            activeTabId: 'missing-tab',
            tabs: persisted().tabGroups['group-1'].tabs
          }
        }
      })
    )

    expect(restored.activeGroupId).toBe('group-1')
    expect(restored.layout).toEqual({ type: 'leaf', tabGroupId: 'group-1' })
    expect(restored.tabGroups?.['group-1'].activeTabId).toBe('pin-1')
    expect(restored.tabGroups?.['group-1'].tabs[0]).toMatchObject({
      isModified: false,
      isPreview: false,
      isDeleted: false
    })

    const emptyRestore = deserializeTabState(
      persisted({
        tabGroups: {},
        activeGroupId: 'missing'
      })
    )
    expect(Object.keys(emptyRestore.tabGroups ?? {})).toHaveLength(1)
  })

  it('extracts pinned tabs and handles localStorage failures defensively', async () => {
    const pinned = extractPinnedTabs(persisted())
    expect(pinned).toHaveLength(1)
    expect(pinned[0]).toMatchObject({ id: 'pin-1', isPinned: true, isModified: false })

    await localStorageAdapter.save(persisted())
    await expect(localStorageAdapter.load()).resolves.toMatchObject({ version: 2 })
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2 }))
    await expect(localStorageAdapter.load()).resolves.toBeNull()
    localStorage.setItem(STORAGE_KEY, '{')
    await expect(localStorageAdapter.load()).resolves.toBeNull()

    await localStorageAdapter.clear()
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()

    // Every write refused, including the failure marker: the quit path still
    // must not throw, and it must still tell its caller the write was lost.
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    expect(saveSync(persisted())).toMatchObject({ ok: false, reason: 'error' })
    setItem.mockRestore()
    expect(consumeSyncSaveFailure()).toBeNull()
  })

  it('reports a refused synchronous save and leaves a marker for the next launch', () => {
    const setItem = refuseWritesTo(STORAGE_KEY, quotaError())

    expect(saveSync(persisted())).toEqual({ ok: false, reason: 'quota', at: expect.any(Number) })
    setItem.mockRestore()

    // The marker is what the next launch reads; consuming it is one-shot, so a
    // single failed quit cannot nag on every later launch.
    expect(consumeSyncSaveFailure()).toMatchObject({ reason: 'quota', at: expect.any(Number) })
    expect(consumeSyncSaveFailure()).toBeNull()
  })

  it('clears the failure marker once a synchronous save succeeds', () => {
    const setItem = refuseWritesTo(STORAGE_KEY, quotaError())
    saveSync(persisted())
    setItem.mockRestore()

    expect(saveSync(persisted())).toEqual({ ok: true })
    expect(localStorage.getItem(STORAGE_KEY)).toContain('pin-1')
    expect(consumeSyncSaveFailure()).toBeNull()
  })

  it('ignores a corrupt or foreign failure marker', () => {
    localStorage.setItem('memry_tab_state_save_failed', '{')
    expect(consumeSyncSaveFailure()).toBeNull()

    localStorage.setItem('memry_tab_state_save_failed', JSON.stringify({ reason: 'whatever' }))
    expect(consumeSyncSaveFailure()).toBeNull()
  })

  it('recognises quota failures and only quota failures', () => {
    expect(isQuotaExceededError(new DOMException('over quota', 'QuotaExceededError'))).toBe(true)
    expect(isQuotaExceededError(new DOMException('over quota', 'QUOTA_EXCEEDED_ERR'))).toBe(true)
    expect(isQuotaExceededError(new Error('disk on fire'))).toBe(false)
    expect(isQuotaExceededError('QuotaExceededError')).toBe(false)
  })
})

describe('tab persistence hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    localStorage.clear()
    mocks.tabsState = state()
    mocks.pendingSave = null
    mocks.serializeCalls = 0
    sessionSnapshot = null
    manualSnapshot = null
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('debounces auto-save, flushes on demand, and unregisters cleanly', async () => {
    const storage: TabStorage = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(),
      clear: vi.fn()
    }

    const { rerender, unmount } = render(<TabPersistenceProbe storage={storage} debounceMs={25} />)

    expect(mocks.registerPendingSave).toHaveBeenCalledWith('tab-state', expect.any(Function))
    expect(storage.save).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(25))
    await waitFor(() => expect(storage.save).toHaveBeenCalledTimes(1))

    mocks.tabsState = state({ activeGroupId: 'group-1' })
    rerender(<TabPersistenceProbe storage={storage} debounceMs={25} />)
    act(() => window.dispatchEvent(new Event('beforeunload')))
    expect(localStorage.getItem(STORAGE_KEY)).toContain('group-1')

    act(() => mocks.pendingSave?.())
    expect(localStorage.getItem(STORAGE_KEY)).toContain('pin-1')

    unmount()
    expect(mocks.unregisterPendingSave).toHaveBeenCalledWith('tab-state')
  })

  it('serializes once per debounce window, not once per tab-state change', async () => {
    const storage: TabStorage = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(),
      clear: vi.fn()
    }
    vi.setSystemTime(CLOCK_START)

    const { rerender } = render(<TabPersistenceProbe storage={storage} debounceMs={25} />)
    applyStateChanges(() => rerender(<TabPersistenceProbe storage={storage} debounceMs={25} />))

    // Mount plus 20 tab-state changes: the tree must not be walked once per change.
    expect(mocks.serializeCalls).toBe(0)
    expect(storage.save).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(25))

    expect(mocks.serializeCalls).toBe(1)
    await waitFor(() => expect(storage.save).toHaveBeenCalledTimes(1))
    expect(storage.save).toHaveBeenCalledWith(expectedPersisted(CLOCK_START + 25))
  })

  it('skips the write when the persisted payload is unchanged, and stamps writes that happen', async () => {
    const storage: TabStorage = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(),
      clear: vi.fn()
    }
    vi.setSystemTime(CLOCK_START)

    const { rerender } = render(<TabPersistenceProbe storage={storage} debounceMs={25} />)

    act(() => vi.advanceTimersByTime(25))
    await waitFor(() => expect(storage.save).toHaveBeenCalledTimes(1))
    expect(vi.mocked(storage.save).mock.calls[0][0].savedAt).toBe(CLOCK_START + 25)

    // `isModified` flips on every editor dirty/clean transition but is stripped
    // by `serializeTabState`, so this tab-state change projects to a payload
    // byte-identical to the one already in storage. It must not be written:
    // `savedAt: Date.now()` used to make every serialization unique, so the
    // dedupe never matched and the redundant `setItem` ran anyway.
    const unchanged = state()
    unchanged.tabGroups['group-1'].tabs[0] = tab({ isModified: true })
    mocks.tabsState = unchanged
    rerender(<TabPersistenceProbe storage={storage} debounceMs={25} />)

    await act(async () => {
      vi.advanceTimersByTime(25)
    })

    // The tree is still walked — that is how the payload is compared at all —
    // but nothing reaches storage.
    expect(mocks.serializeCalls).toBe(2)
    expect(storage.save).toHaveBeenCalledTimes(1)

    // A change the payload does carry still writes, with the stamp taken at the
    // moment of that write rather than the skipped one.
    const changed = state()
    changed.tabGroups['group-1'].tabs[0] = tab({ title: 'Renamed' })
    mocks.tabsState = changed
    rerender(<TabPersistenceProbe storage={storage} debounceMs={25} />)

    act(() => vi.advanceTimersByTime(25))
    await waitFor(() => expect(storage.save).toHaveBeenCalledTimes(2))

    const written = vi.mocked(storage.save).mock.calls[1][0]
    expect(written.savedAt).toBe(CLOCK_START + 75)
    expect(written.tabGroups['group-1'].tabs[0].title).toBe('Renamed')
  })

  it('reports a quota failure to the user and keeps saving afterwards', async () => {
    const storage: TabStorage = {
      save: vi
        .fn()
        .mockRejectedValueOnce(new DOMException('quota exceeded', 'QuotaExceededError'))
        .mockResolvedValue(undefined),
      load: vi.fn(),
      clear: vi.fn()
    }

    const { rerender } = render(<TabPersistenceProbe storage={storage} debounceMs={25} />)

    act(() => vi.advanceTimersByTime(25))
    await waitFor(() => expect(storage.save).toHaveBeenCalledTimes(1))

    // The rejected save must be handled, not left as an unhandled rejection:
    // the user has to learn their session stopped being saved now, not at the
    // next launch when the restored layout turns out to be stale.
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastError.mock.calls[0][0]).toBe('Your open tabs are no longer being saved')
    expect(mocks.toastError.mock.calls[0][1]).toMatchObject({
      description: expect.stringContaining('too large to store')
    })

    // One failure must not wedge the saver: the next tab-state change is still
    // written, and the payload is the new state rather than the failed one.
    const next = state()
    next.tabGroups['group-1'].tabs[0] = tab({ title: 'After the quota error' })
    mocks.tabsState = next
    rerender(<TabPersistenceProbe storage={storage} debounceMs={25} />)

    act(() => vi.advanceTimersByTime(25))
    await waitFor(() => expect(storage.save).toHaveBeenCalledTimes(2))
    expect(storage.save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tabGroups: expect.objectContaining({
          'group-1': expect.objectContaining({
            tabs: expect.arrayContaining([
              expect.objectContaining({ title: 'After the quota error' })
            ])
          })
        })
      })
    )
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('warns once across a run of failures and falls back to the error message', async () => {
    const storage: TabStorage = {
      save: vi.fn().mockRejectedValue(new Error('storage backend offline')),
      load: vi.fn(),
      clear: vi.fn()
    }

    const { rerender } = render(<TabPersistenceProbe storage={storage} debounceMs={25} />)

    act(() => vi.advanceTimersByTime(25))
    await waitFor(() => expect(storage.save).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastError.mock.calls[0][1]).toMatchObject({
      description: 'storage backend offline'
    })

    applyStateChanges(() => rerender(<TabPersistenceProbe storage={storage} debounceMs={25} />))
    act(() => vi.advanceTimersByTime(25))
    await waitFor(() => expect(storage.save).toHaveBeenCalledTimes(2))

    // Every debounced save keeps failing, but the user is told once, not once
    // per keystroke-sized tab-state change.
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('registers the unload handler once and writes the latest state on unload', () => {
    const storage: TabStorage = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(),
      clear: vi.fn()
    }
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    vi.setSystemTime(CLOCK_START)

    const { rerender } = render(<TabPersistenceProbe storage={storage} debounceMs={25} />)
    applyStateChanges(() => rerender(<TabPersistenceProbe storage={storage} debounceMs={25} />))

    const unloadAdds = addSpy.mock.calls.filter(([type]) => type === 'beforeunload')
    const unloadRemovals = removeSpy.mock.calls.filter(([type]) => type === 'beforeunload')
    expect(unloadAdds).toHaveLength(1)
    expect(unloadRemovals).toHaveLength(0)

    act(() => window.dispatchEvent(new Event('beforeunload')))

    // The one long-lived handler must still write the newest tab tree, not the
    // tree it closed over when it was registered.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(
      expectedPersisted(CLOCK_START)
    )
  })

  it('flushes a normal quit and logs the flush that really happened', () => {
    const storage: TabStorage = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(),
      clear: vi.fn()
    }

    render(<TabPersistenceProbe storage={storage} debounceMs={25} />)

    act(() => mocks.pendingSave?.())

    expect(localStorage.getItem(STORAGE_KEY)).toContain('pin-1')
    expect(mocks.logger.info).toHaveBeenCalledWith('flushed tab state via registry')
    expect(mocks.logger.error).not.toHaveBeenCalled()
    expect(consumeSyncSaveFailure()).toBeNull()
  })

  it('does not claim a flush when the quit-time write is refused', () => {
    const storage: TabStorage = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(),
      clear: vi.fn()
    }

    // What the user would get restored if the last write never lands.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted({ savedAt: 1 })))
    const stale = localStorage.getItem(STORAGE_KEY)

    render(<TabPersistenceProbe storage={storage} debounceMs={25} />)
    const setItem = refuseWritesTo(STORAGE_KEY, quotaError())

    // Neither quit path may throw — an exception here would stop the app closing.
    expect(() => act(() => mocks.pendingSave?.())).not.toThrow()
    expect(() => act(() => window.dispatchEvent(new Event('beforeunload')))).not.toThrow()

    setItem.mockRestore()

    expect(mocks.logger.info).not.toHaveBeenCalledWith('flushed tab state via registry')
    expect(mocks.logger.error).toHaveBeenCalledWith('failed to flush tab state via registry', {
      reason: 'quota'
    })
    expect(mocks.logger.error).toHaveBeenCalledWith('failed to save tab state on unload', {
      reason: 'quota'
    })
    // The stale payload is still what would be restored, and the failure is now
    // recorded so the next launch can say so.
    expect(localStorage.getItem(STORAGE_KEY)).toBe(stale)
    expect(consumeSyncSaveFailure()).toMatchObject({ reason: 'quota' })
  })

  it('tells the user at the next launch that the last session was never saved', async () => {
    const setItem = refuseWritesTo(STORAGE_KEY, quotaError())
    saveSync(serializeTabState(state()))
    setItem.mockRestore()

    const storage: TabStorage = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(persisted()),
      clear: vi.fn()
    }

    render(withQueryClient(<SessionRestoreProbe storage={storage} />))

    await waitFor(() => expect(mocks.toastWarning).toHaveBeenCalledTimes(1))
    expect(mocks.toastWarning.mock.calls[0][0]).toBe(
      'Your last session was not saved when Memry closed'
    )
    expect(mocks.toastWarning.mock.calls[0][1]).toMatchObject({
      description: expect.stringContaining('Storage was full')
    })

    // One failed quit, one warning: the marker is consumed by the launch that
    // reported it, so the launch after that is quiet.
    mocks.dispatch.mockClear()
    render(withQueryClient(<SessionRestoreProbe storage={storage} />))
    await waitFor(() =>
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RESTORE_SESSION' })
      )
    )
    expect(mocks.toastWarning).toHaveBeenCalledTimes(1)

    // A refusal that is not about space explains itself differently.
    const failAgain = refuseWritesTo(STORAGE_KEY, new Error('storage backend offline'))
    saveSync(serializeTabState(state()))
    failAgain.mockRestore()

    render(withQueryClient(<SessionRestoreProbe storage={storage} />))
    await waitFor(() => expect(mocks.toastWarning).toHaveBeenCalledTimes(2))
    expect(mocks.toastWarning.mock.calls[1][1]).toMatchObject({
      description: expect.stringContaining('could not store your tabs on exit')
    })
  })

  it('restores full sessions, pinned-only sessions, errors, and manual operations', async () => {
    const storage: TabStorage = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(persisted()),
      clear: vi.fn().mockResolvedValue(undefined)
    }

    render(withQueryClient(<SessionRestoreProbe storage={storage} />))
    await waitFor(() =>
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RESTORE_SESSION' })
      )
    )
    expect(sessionSnapshot?.isRestoring).toBe(false)

    mocks.dispatch.mockClear()
    mocks.tabsState = state({
      settings: { ...state().settings, restoreSessionOnStart: false }
    })
    render(withQueryClient(<SessionRestoreProbe storage={storage} />))
    await waitFor(() =>
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'OPEN_TAB',
          payload: expect.objectContaining({
            tab: expect.objectContaining({ type: 'inbox', isPinned: true }),
            background: true
          })
        })
      )
    )

    const failingStorage: TabStorage = {
      save: vi.fn(),
      load: vi.fn().mockRejectedValue(new Error('restore failed')),
      clear: vi.fn()
    }
    render(withQueryClient(<SessionRestoreProbe storage={failingStorage} />))
    await waitFor(() => expect(sessionSnapshot?.restoreError?.message).toBe('restore failed'))

    mocks.dispatch.mockClear()
    render(withQueryClient(<ManualPersistenceProbe storage={storage} />))
    await act(async () => manualSnapshot?.save())
    expect(storage.save).toHaveBeenCalled()
    await expect(manualSnapshot?.load()).resolves.toBe(true)
    expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'RESTORE_SESSION' })
    )
    await act(async () => manualSnapshot?.clear())
    expect(storage.clear).toHaveBeenCalled()
  })
})

describe('tab session persistence startup order', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    localStorage.clear()
    mocks.tabsState = startupState()
    mocks.flagsLoading = true
    sessionSnapshot = null

    // Stand in for the reducer: the real provider swaps its default state for
    // the restored one, which is what the first post-restore save must write.
    mocks.dispatch.mockImplementation((action: { type: string; payload?: unknown }) => {
      if (action.type !== 'RESTORE_SESSION') return
      mocks.tabsState = {
        ...(mocks.tabsState as TabSystemState),
        ...(action.payload as Partial<TabSystemState>)
      } as TabSystemState
    })
  })

  afterEach(() => {
    mocks.flagsLoading = false
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not overwrite the stored session while the restore is still gated on feature flags', async () => {
    const stored = persisted()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    const tree = () => (
      <QueryClientProvider client={queryClient}>
        <StartupProbe storage={localStorageAdapter} debounceMs={25} />
      </QueryClientProvider>
    )

    const { rerender } = render(tree())

    // Four debounce windows pass with the flag IPC still unanswered. This gap is
    // the whole bug: auto-save used to fill it with the Home-only default, and
    // the restore then read its own damage back as the user's session.
    act(() => vi.advanceTimersByTime(100))
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(stored)

    // Flags land; the restore finally gets its read.
    mocks.flagsLoading = false
    rerender(tree())

    await waitFor(() =>
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'RESTORE_SESSION' })
      )
    )

    const restoreCall = mocks.dispatch.mock.calls.find(
      (call) => call[0]?.type === 'RESTORE_SESSION'
    )
    const payload = restoreCall?.[0].payload as Partial<TabSystemState> | undefined
    expect(payload?.tabGroups?.['group-1'].tabs.map((item) => item.id)).toEqual(['pin-1', 'note-1'])

    // Saving resumes once the restore has landed, and what it writes is the
    // restored session rather than the default it started from.
    await waitFor(() => expect(sessionSnapshot?.isRestoring).toBe(false))
    act(() => vi.advanceTimersByTime(100))

    const written = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as PersistedTabState
    expect(Object.keys(written.tabGroups)).toEqual(['group-1'])
    expect(written.tabGroups['group-1'].tabs.map((item) => item.id)).toEqual(['pin-1', 'note-1'])
  })
})
