import { act, renderHook, waitFor } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { QueryClientProvider } from '@tanstack/react-query'
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
import type { JournalEntry } from '../../../preload/index.d'
import { useJournalEntry } from './use-journal-entry'

const templates = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/services/templates-service', () => ({ getTemplate: templates.get }))
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
    // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
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
    templates.get.mockResolvedValue({
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

  it('seeds {{random-line:Title}} with a line from the named note', async () => {
    ;(window.api.journal.getEntry as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    ;(window.api.settings.getJournalSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      defaultTemplate: 'daily'
    })
    templates.get.mockResolvedValue({
      id: 'daily',
      name: 'Daily',
      isBuiltIn: false,
      tags: [],
      properties: [],
      content: '> {{random-line:Affirmations}}',
      createdAt: '2026-05-01T00:00:00.000Z',
      modifiedAt: '2026-05-01T00:00:00.000Z'
    })
    window.api.notes.resolveByTitle = vi.fn().mockResolvedValue({ id: 'n1' })
    window.api.notes.get = vi.fn().mockResolvedValue({ content: '- I am calm' })
    ;(window.api.journal.createEntry as ReturnType<typeof vi.fn>).mockResolvedValue(
      createMockJournalEntry({ date: '2026-05-10', content: 'created' })
    )

    renderHook(() => useJournalEntry('2026-05-10'), { wrapper })

    await waitFor(() => expect(window.api.journal.createEntry).toHaveBeenCalled())
    expect(window.api.notes.resolveByTitle).toHaveBeenCalledWith('Affirmations')
    expect(window.api.journal.createEntry).toHaveBeenCalledWith(
      expect.objectContaining({ content: '> I am calm' })
    )
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

  it('saves the body #tag changes made during a save, merged, on top of the tags-row list', async () => {
    const { result } = renderHook(() => useJournalEntry('2026-05-10'), { wrapper })
    await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-10'))
    let finishFirstSave: () => void = () => {}
    ;(window.api.journal.updateEntry as ReturnType<typeof vi.fn>).mockImplementationOnce(
      // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
      (input) =>
        new Promise((resolve) => {
          finishFirstSave = () => resolve(createMockJournalEntry({ date: input.date }))
        })
    )

    act(() => result.current.updateTags(['row']))
    await waitFor(() => expect(window.api.journal.updateEntry).toHaveBeenCalledTimes(1))
    act(() => result.current.updateInlineTags({ add: ['car', 'bike'], remove: [] }))
    act(() => result.current.updateInlineTags({ add: [], remove: ['bike', 'old'] }))
    await act(async () => finishFirstSave())
    await waitFor(() => expect(result.current.isSaving).toBe(false))
    act(() => result.current.updateTags(['row', 'later']))

    expect(window.api.journal.updateEntry).toHaveBeenNthCalledWith(1, {
      date: '2026-05-10',
      tags: ['row']
    })
    await waitFor(() =>
      expect(window.api.journal.updateEntry).toHaveBeenLastCalledWith({
        date: '2026-05-10',
        tags: ['row', 'later'],
        inlineTags: { add: ['car'], remove: ['bike', 'old'] }
      })
    )
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

    const externalEntry = createMockJournalEntry({ date: '2026-05-10', content: 'external edit' })
    act(() => {
      updated?.({ date: '2026-05-10', entry: externalEntry, source: 'external' })
    })
    expect(result.current.externalUpdateCount).toBe(1)
    expect(queryClient.getQueryData(['journal', 'entries', '2026-05-10'])).toEqual(externalEntry)

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

  it('shows a dropped-event refetch of the open day in its editor when the text changed', async () => {
    let dropped: (() => void) | null = null
    const api = window.api as unknown as Record<string, ReturnType<typeof vi.fn>>
    api.onJournalEventsDropped.mockImplementation((cb) => {
      dropped = cb
      return vi.fn()
    })
    const getEntry = window.api.journal.getEntry as ReturnType<typeof vi.fn>
    const shown = createMockJournalEntry({ date: '2026-05-10', content: 'shown' })
    getEntry.mockResolvedValue(shown)
    const { result } = renderHook(() => useJournalEntry('2026-05-10'), { wrapper })
    await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-10'))
    const before = result.current.externalUpdateCount
    const reads = () => getEntry.mock.calls.filter(([date]) => date === '2026-05-10').length

    // Nothing changed: the editor keeps its cursor.
    act(() => {
      dropped?.()
    })
    await waitFor(() => expect(reads()).toBe(2))
    expect(result.current.externalUpdateCount).toBe(before)

    getEntry.mockResolvedValue(
      createMockJournalEntry({ date: '2026-05-10', content: 'changed while missed' })
    )
    act(() => {
      dropped?.()
    })
    await waitFor(() => expect(result.current.externalUpdateCount).toBe(before + 1))
    expect(result.current.entry?.content).toBe('changed while missed')
  })

  it('keeps a save that lands while a dropped-event refetch is in flight', async () => {
    let dropped: (() => void) | null = null
    const api = window.api as unknown as Record<string, ReturnType<typeof vi.fn>>
    api.onJournalEventsDropped.mockImplementation((cb) => {
      dropped = cb
      return vi.fn()
    })
    const getEntry = window.api.journal.getEntry as ReturnType<typeof vi.fn>
    const { result } = renderHook(() => useJournalEntry('2026-05-10'), { wrapper })
    await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-10'))
    let answer: (entry: JournalEntry) => void = () => {}
    getEntry.mockReturnValueOnce(
      new Promise<JournalEntry>((resolve) => {
        answer = resolve
      })
    )
    act(() => {
      dropped?.()
    })
    const before = result.current.externalUpdateCount

    act(() => {
      result.current.updateContent('typed and saved')
    })
    await act(async () => {
      await result.current.saveNow()
    })
    // The read began before the save, so it holds the text from before it.
    await act(async () => {
      answer(createMockJournalEntry({ date: '2026-05-10', content: 'Existing' }))
      await Promise.resolve()
    })

    const cached = queryClient.getQueryData<JournalEntry>(['journal', 'entries', '2026-05-10'])
    expect(cached?.content).toBe('typed and saved')
    expect(result.current.externalUpdateCount).toBe(before)
  })

  it('keeps typing not yet rendered when a dropped-event refetch lands', async () => {
    let dropped: (() => void) | null = null
    const api = window.api as unknown as Record<string, ReturnType<typeof vi.fn>>
    api.onJournalEventsDropped.mockImplementation((cb) => {
      dropped = cb
      return vi.fn()
    })
    const getEntry = window.api.journal.getEntry as ReturnType<typeof vi.fn>
    const { result } = renderHook(() => useJournalEntry('2026-05-10'), { wrapper })
    await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-10'))
    let answer: (entry: JournalEntry) => void = () => {}
    getEntry.mockReturnValueOnce(
      new Promise<JournalEntry>((resolve) => {
        answer = resolve
      })
    )
    act(() => {
      dropped?.()
    })
    const before = result.current.externalUpdateCount

    // The keystroke and the read's answer land before React renders the keystroke.
    await act(async () => {
      result.current.updateContent('typed')
      answer(createMockJournalEntry({ date: '2026-05-10', content: 'changed outside' }))
      for (let i = 0; i < 10; i++) await Promise.resolve()
    })

    expect(result.current.externalUpdateCount).toBe(before)
    expect(result.current.isDirty).toBe(true)
  })

  // Typing not saved yet never reached the file, so nothing else holds it. Its save writes over
  // the outside edit, which the core keeps as a version, as a note's save does (#3530).
  it('keeps unsaved typing and a save in flight over an outside edit, and saves them', async () => {
    let updated: ((event: any) => void) | null = null
    ;(window.api.onJournalEntryUpdated as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
      updated = cb
      return vi.fn()
    })
    const updateEntry = window.api.journal.updateEntry as ReturnType<typeof vi.fn>
    const key = ['journal', 'entries', '2026-05-10']
    const { result } = renderHook(() => useJournalEntry('2026-05-10'), { wrapper })
    await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-10'))
    const shown = queryClient.getQueryData(key)
    const outside = createMockJournalEntry({ date: '2026-05-10', content: 'outside edit' })
    const outsideEdit = () => {
      act(() => {
        updated?.({ date: '2026-05-10', entry: outside, source: 'external' })
      })
    }

    act(() => {
      result.current.updateContent('typed, not saved')
    })
    outsideEdit()
    expect(result.current.externalUpdateCount).toBe(0)
    expect(queryClient.getQueryData(key)).toEqual(shown)
    expect(result.current.isDirty).toBe(true)
    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })
    expect(updateEntry).toHaveBeenLastCalledWith({
      date: '2026-05-10',
      content: 'typed, not saved'
    })
    await waitFor(() => expect(result.current.isDirty).toBe(false))

    let finishTagSave: () => void = () => {}
    updateEntry.mockImplementationOnce(
      // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
      (input: { date: string }) =>
        new Promise((resolve) => {
          finishTagSave = () =>
            resolve(createMockJournalEntry({ date: input.date, tags: ['kept'] }))
        })
    )
    act(() => {
      result.current.updateTags(['kept'])
    })
    await waitFor(() =>
      expect(updateEntry).toHaveBeenLastCalledWith({ date: '2026-05-10', tags: ['kept'] })
    )
    outsideEdit()
    expect(result.current.externalUpdateCount).toBe(0)
    await act(async () => finishTagSave())
    await waitFor(() => expect(result.current.isDirty).toBe(false))

    // Nothing unsaved: the outside edit reloads the day.
    outsideEdit()
    expect(result.current.externalUpdateCount).toBe(1)
    expect(queryClient.getQueryData(key)).toEqual(outside)
  })

  it('refetches the open day on dropped journal events, unless it holds unsaved text', async () => {
    let dropped: (() => void) | null = null
    const api = window.api as unknown as Record<string, ReturnType<typeof vi.fn>>
    api.onJournalEventsDropped.mockImplementation((cb) => {
      dropped = cb
      return vi.fn()
    })
    const getEntry = window.api.journal.getEntry as ReturnType<typeof vi.fn>
    const { result } = renderHook(() => useJournalEntry('2026-05-10'), { wrapper })
    await waitFor(() => expect(result.current.loadedForDate).toBe('2026-05-10'))

    const missed = createMockJournalEntry({ date: '2026-05-10', content: 'missed edit' })
    getEntry.mockResolvedValue(missed)
    act(() => {
      dropped?.()
    })
    await waitFor(() =>
      expect(queryClient.getQueryData(['journal', 'entries', '2026-05-10'])).toEqual(missed)
    )

    act(() => {
      result.current.updateContent('typed, not saved')
    })
    getEntry.mockClear()
    act(() => {
      dropped?.()
    })
    expect(getEntry).not.toHaveBeenCalled()
    expect(result.current.isDirty).toBe(true)
  })

  it('reads back the tags a tag delete took off the open day before its next tag edit', async () => {
    let external: ((event: unknown) => void) | null = null
    const api = window.api as unknown as Record<string, ReturnType<typeof vi.fn>>
    api.onJournalExternalChange.mockImplementation((cb) => {
      external = cb
      return vi.fn()
    })
    const getEntry = window.api.journal.getEntry as ReturnType<typeof vi.fn>
    getEntry.mockResolvedValue(createMockJournalEntry({ date: '2026-05-10', tags: ['x'] }))
    const { result } = renderHook(() => useJournalEntry('2026-05-10'), { wrapper })
    await waitFor(() => expect(result.current.entry?.tags).toEqual(['x']))

    // The delete changed the day's record alone (#3931) and told the day so: the page reads
    // the record back, so adding a tag next sends `[y]`, not `[x, y]`.
    getEntry.mockResolvedValue(createMockJournalEntry({ date: '2026-05-10', tags: [] }))
    act(() => {
      external?.({ date: '2026-05-10', type: 'modified' })
    })
    await waitFor(() => expect(result.current.entry?.tags).toEqual([]))
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
        // oxlint-disable-next-line typescript/no-misused-promises -- mockImplementation is typed as a void-returning callback; resolving a Promise is what the mocked IPC method does
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
          return undefined
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
