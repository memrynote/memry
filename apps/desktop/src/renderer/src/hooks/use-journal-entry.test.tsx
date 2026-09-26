import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  cleanupHookTestEnvironment,
  createMockJournalEntry,
  createTestQueryClient,
  setupHookTestEnvironment
} from '@tests/utils/hook-test-wrapper'
import { VaultScopeProvider } from '@/contexts/vault-scope'
import { flushAllPendingSaves } from '@/lib/save-registry'
import { setCachedVaultStatus } from '@/lib/vault-status-cache'
import {
  VaultWorkspaceLifecycleContext,
  createVaultWorkspaceLifecycle,
  type VaultWorkspaceLifecycle
} from '@/lib/vault-workspace-lifecycle'
import { useJournalEntry } from './use-journal-entry'

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    language: 'en-US',
    getFixedT: () => (key: string) => key
  })
}))

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: logWarn,
    info: vi.fn()
  })
}))

describe('useJournalEntry dedicated hook', () => {
  let queryClient: QueryClient

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T08:30:00.000Z'))
    queryClient = createTestQueryClient()
    setupHookTestEnvironment()
    ;(window.api.journal.getEntry as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockJournalEntry({ date: '2026-05-10', content: 'Existing' })
    )
    ;(window.api.journal.updateEntry as ReturnType<typeof vi.fn>).mockImplementation((input) =>
      Promise.resolve(createMockJournalEntry({ date: input.date, content: input.content ?? '' }))
    )
    ;(window.api.journal.deleteEntry as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true
    })
  })

  afterEach(() => {
    queryClient.clear()
    cleanupHookTestEnvironment()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('seeds a missing entry from the default template and applies date tokens', async () => {
    ;(window.api.journal.getEntry as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(window.api.settings.getJournalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      defaultTemplate: 'daily',
      showSchedule: true,
      showTasks: true,
      showAIConnections: true,
      showStatsFooter: false
    })
    ;(window.api.templates.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'daily',
      name: 'Daily',
      isBuiltIn: false,
      tags: ['daily'],
      properties: [{ name: 'mood', type: 'text', value: 'focused' }],
      content: '# {{title}}\n{{date:YYYY/MM/DD}}\n{{date}}\n{{time}}\n{{day-of-week}}',
      createdAt: '2026-05-01T00:00:00.000Z',
      modifiedAt: '2026-05-01T00:00:00.000Z'
    })
    ;(window.api.journal.createEntry as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockJournalEntry({ date: '2026-05-10', content: 'created' })
    )

    const { result } = renderHook(() => useJournalEntry('2026-05-10'), { wrapper })

    await waitFor(() => expect(window.api.journal.createEntry).toHaveBeenCalled())
    expect(window.api.journal.createEntry).toHaveBeenCalledWith({
      date: '2026-05-10',
      content: expect.stringContaining('2026/05/10'),
      tags: ['daily'],
      properties: { mood: 'focused' }
    })
    await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-10'))
  })

  it('flushes pending changes across date changes, retry, reload, delete failure, and unmount', async () => {
    const { result, rerender, unmount } = renderHook(({ date }) => useJournalEntry(date), {
      wrapper,
      initialProps: { date: '2026-05-10' }
    })

    await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-10'))

    act(() => {
      result.current.updateContent('Pending old date')
    })
    rerender({ date: '2026-05-11' })
    expect(window.api.journal.updateEntry).toHaveBeenCalledWith({
      date: '2026-05-10',
      content: 'Pending old date'
    })

    await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-11'))
    ;(window.api.journal.updateEntry as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ENOSPC write failed')
    )
    act(() => {
      result.current.updateContent('Will fail')
    })
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    await waitFor(() => expect(result.current.saveError).toBe('Unable to save: disk may be full'))
    ;(window.api.journal.updateEntry as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      createMockJournalEntry({ date: '2026-05-11', content: 'Recovered' })
    )
    await act(async () => {
      await result.current.retrySave()
    })
    await waitFor(() => expect(result.current.saveError).toBeNull())

    act(() => {
      result.current.updateTags(['tagged'])
    })
    await waitFor(() =>
      expect(window.api.journal.updateEntry).toHaveBeenCalledWith({
        date: '2026-05-11',
        tags: ['tagged']
      })
    )

    act(() => {
      result.current.updateContent('Dirty before reload')
    })
    await act(async () => {
      await result.current.reload()
    })
    expect(window.api.journal.getEntry).toHaveBeenCalledWith('2026-05-11')

    act(() => {
      result.current.updateContent('Discard me')
    })
    await act(async () => {
      await result.current.forceReload()
    })
    expect(result.current.isDirty).toBe(false)
    ;(window.api.journal.deleteEntry as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('delete failed')
    )
    await act(async () => {
      expect(await result.current.deleteEntry()).toBe(false)
    })

    act(() => {
      result.current.updateContent('Save on unmount')
    })
    unmount()
    await act(async () => {
      await Promise.resolve()
    })
    expect(window.api.journal.updateEntry).toHaveBeenCalledWith({
      date: '2026-05-11',
      content: 'Save on unmount'
    })
  })

  // The editor flushes its last debounced edit only after it has unmounted, and
  // serializing is async, so that edit reaches `updateContent` after this hook
  // has already switched dates and flushed the old one (#1900).
  it('saves a late edit to the date it was typed on, not the date now open', async () => {
    const updateEntry = window.api.journal.updateEntry as ReturnType<typeof vi.fn>
    const { result, rerender } = renderHook(({ date }) => useJournalEntry(date), {
      wrapper,
      initialProps: { date: '2026-05-10' }
    })
    await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-10'))
    const updateTenth = result.current.updateContent

    rerender({ date: '2026-05-11' })
    await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-11'))
    updateEntry.mockClear()

    act(() => {
      updateTenth('Typed on the tenth')
    })
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })

    expect(updateEntry).toHaveBeenCalledWith({ date: '2026-05-10', content: 'Typed on the tenth' })
    expect(updateEntry).not.toHaveBeenCalledWith(expect.objectContaining({ date: '2026-05-11' }))
    expect(result.current.isDirty).toBe(false)
  })

  it('saves a late edit straight away once the journal has unmounted', async () => {
    const updateEntry = window.api.journal.updateEntry as ReturnType<typeof vi.fn>
    const { result, unmount } = renderHook(() => useJournalEntry('2026-05-10'), { wrapper })
    await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-10'))
    const updateTenth = result.current.updateContent

    unmount()
    updateEntry.mockClear()
    updateTenth('Typed while closing')
    await act(async () => {
      await Promise.resolve()
    })

    // No timer advanced: the unmount flush and the save registry are both gone,
    // so a debounce parked now would be invisible to quit.
    expect(updateEntry).toHaveBeenCalledWith({ date: '2026-05-10', content: 'Typed while closing' })
  })

  it('handles created, updated, deleted, and external journal events', async () => {
    let created: ((event: any) => void) | null = null
    let updated: ((event: any) => void) | null = null
    let deleted: ((event: any) => void) | null = null
    let external: ((event: any) => void) | null = null

    ;(window.api.onJournalEntryCreated as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
      created = cb
      return vi.fn()
    })
    ;(window.api.onJournalEntryUpdated as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
      updated = cb
      return vi.fn()
    })
    ;(window.api.onJournalEntryDeleted as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
      deleted = cb
      return vi.fn()
    })
    ;(window.api.onJournalExternalChange as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
      external = cb
      return vi.fn()
    })

    const { result } = renderHook(() => useJournalEntry('2026-05-10'), { wrapper })
    await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-10'))

    const createdEntry = createMockJournalEntry({ date: '2026-05-10', content: 'created event' })
    act(() => {
      created?.({ date: '2026-05-10', entry: createdEntry })
    })
    expect(queryClient.getQueryData(['journal', 'entries', '2026-05-10'])).toEqual(createdEntry)

    act(() => {
      result.current.updateContent('local dirty')
    })
    const externalEntry = createMockJournalEntry({ date: '2026-05-10', content: 'external edit' })
    act(() => {
      updated?.({ date: '2026-05-10', entry: externalEntry, source: 'external' })
    })
    expect(result.current.externalUpdateCount).toBe(1)
    expect(result.current.isDirty).toBe(false)

    const localEntry = createMockJournalEntry({ date: '2026-05-10', content: 'local clean edit' })
    act(() => {
      updated?.({ date: '2026-05-10', entry: localEntry })
    })
    expect(queryClient.getQueryData(['journal', 'entries', '2026-05-10'])).toEqual(localEntry)

    act(() => {
      deleted?.({ date: '2026-05-10' })
    })
    expect(queryClient.getQueryData(['journal', 'entries', '2026-05-10'])).toBeNull()

    act(() => {
      external?.({ date: '2026-05-10', type: 'modified' })
      external?.({ date: '2026-05-10', type: 'deleted' })
    })
    expect(queryClient.getQueryData(['journal', 'entries', '2026-05-10'])).toBeNull()
  })

  describe('leaving the vault', () => {
    const VAULT_A = '/vaults/a'
    const VAULT_B = '/vaults/b'
    let lifecycle: VaultWorkspaceLifecycle

    const vaultWrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <VaultWorkspaceLifecycleContext.Provider value={lifecycle}>
          <VaultScopeProvider vaultPath={VAULT_A}>{children}</VaultScopeProvider>
        </VaultWorkspaceLifecycleContext.Provider>
      </QueryClientProvider>
    )

    const openVault = (path: string): void =>
      setCachedVaultStatus({
        isOpen: true,
        path,
        isIndexing: false,
        indexProgress: 0,
        error: null
      })

    beforeEach(() => {
      lifecycle = createVaultWorkspaceLifecycle()
      openVault(VAULT_A)
    })

    // Hiding a workspace runs its cleanups after main has opened the next
    // vault; a date-addressed save would overwrite that vault's entry.
    it('does not save pending edits from a hidden workspace cleanup', async () => {
      const updateEntry = window.api.journal.updateEntry as ReturnType<typeof vi.fn>
      const { result, unmount } = renderHook(() => useJournalEntry('2026-05-10'), {
        wrapper: vaultWrapper
      })
      await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-10'))

      act(() => {
        result.current.updateContent('Typed in vault A')
      })
      updateEntry.mockClear()
      openVault(VAULT_B)
      lifecycle.hidden = true
      unmount()
      await act(async () => {
        await vi.runOnlyPendingTimersAsync()
      })

      expect(updateEntry).not.toHaveBeenCalled()
      expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('2026-05-10'))
    })

    it('does not save pending edits once another vault is open', async () => {
      const updateEntry = window.api.journal.updateEntry as ReturnType<typeof vi.fn>
      const { result, unmount } = renderHook(() => useJournalEntry('2026-05-10'), {
        wrapper: vaultWrapper
      })
      await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-10'))

      act(() => {
        result.current.updateContent('Typed in vault A')
      })
      updateEntry.mockClear()
      openVault(VAULT_B)
      unmount()
      await act(async () => {
        await vi.runOnlyPendingTimersAsync()
      })

      expect(updateEntry).not.toHaveBeenCalled()
    })

    it('still saves pending edits on unmount while its vault is open', async () => {
      const updateEntry = window.api.journal.updateEntry as ReturnType<typeof vi.fn>
      const { result, unmount } = renderHook(() => useJournalEntry('2026-05-10'), {
        wrapper: vaultWrapper
      })
      await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-10'))

      act(() => {
        result.current.updateContent('Closing the tab')
      })
      unmount()
      await act(async () => {
        await Promise.resolve()
      })

      expect(updateEntry).toHaveBeenCalledWith({ date: '2026-05-10', content: 'Closing the tab' })
    })

    // The switch flushes the registry before main closes the vault. A save
    // already in flight used to make that flush return early, leaving the
    // edits typed during it unsaved.
    it('pre-switch flush waits for an in-flight save and saves the remainder', async () => {
      const updateEntry = window.api.journal.updateEntry as ReturnType<typeof vi.fn>
      const { result } = renderHook(() => useJournalEntry('2026-05-10'), {
        wrapper: vaultWrapper
      })
      await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-10'))

      let finishFirstSave: () => void = () => {}
      updateEntry.mockClear()
      updateEntry.mockImplementationOnce(
        (input: { date: string; content?: string }) =>
          new Promise((resolve) => {
            finishFirstSave = () =>
              resolve(createMockJournalEntry({ date: input.date, content: input.content ?? '' }))
          })
      )

      act(() => {
        result.current.updateContent('First')
      })
      await act(async () => {
        await vi.runOnlyPendingTimersAsync()
      })
      expect(updateEntry).toHaveBeenCalledTimes(1)

      act(() => {
        result.current.updateContent('First and second')
      })

      let flushed = false
      let flush: Promise<void> = Promise.resolve()
      act(() => {
        flush = flushAllPendingSaves().then(() => {
          flushed = true
        })
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(flushed).toBe(false)

      await act(async () => {
        finishFirstSave()
        await flush
      })

      expect(updateEntry).toHaveBeenCalledTimes(2)
      expect(updateEntry).toHaveBeenLastCalledWith({
        date: '2026-05-10',
        content: 'First and second'
      })
      expect(result.current.isDirty).toBe(false)
    })
  })
})
