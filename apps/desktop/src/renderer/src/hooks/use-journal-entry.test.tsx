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
import { useJournalEntry } from './use-journal-entry'

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    language: 'en-US',
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn()
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
})
