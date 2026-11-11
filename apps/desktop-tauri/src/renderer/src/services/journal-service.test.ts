import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import { answer, current } from '@/lib/permanent-delete-question'

const commands = vi.hoisted(() => ({
  journalGetEntry: vi.fn(),
  journalCreateEntry: vi.fn(),
  journalUpdateEntry: vi.fn(),
  journalDeleteEntry: vi.fn(),
  journalGetHeatmap: vi.fn(),
  journalGetMonthEntries: vi.fn(),
  journalGetYearStats: vi.fn(),
  journalGetStreak: vi.fn(),
  journalGetPropertyRows: vi.fn(),
  journalGetDayContext: vi.fn()
}))

// Each Rust event's last listener, for a test to send a payload through.
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>())
const events = vi.hoisted(() => {
  const event = (name: string) => ({
    listen: async (handler: (event: { payload: unknown }) => void) => {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    }
  })
  return {
    journalEntryCreatedEvent: event('created'),
    journalEntryUpdatedEvent: event('updated'),
    journalEntryDeletedEvent: event('deleted'),
    journalExternalChangeEvent: event('external')
  }
})

vi.mock('../../../generated/bindings', () => ({ commands, events }))

import {
  journalService,
  onJournalEntryCreated,
  onJournalEntryUpdated,
  onJournalEntryDeleted,
  onJournalExternalChange,
  getTodayDate,
  formatJournalDate,
  isToday,
  isPastDate,
  isFutureDate
} from './journal-service'

const view = {
  id: 'j2025-01-01',
  date: '2025-01-01',
  content: 'Hello',
  wordCount: 1,
  characterCount: 5,
  tags: ['mood'],
  aliases: [],
  properties: null,
  createdAt: '2025-01-01T08:00:00.000Z',
  modifiedAt: '2025-01-01T08:00:00.000Z'
}

describe('journal-service', () => {
  let api: any

  beforeEach(() => {
    vi.clearAllMocks()
    listeners.clear()
    api = createMockApi()
    api.journal.getAllTags = vi.fn().mockResolvedValue([])

    ;(window as Window & { api: unknown }).api = api
  })

  it('reads, creates, updates and deletes an entry through the Rust commands', async () => {
    commands.journalGetEntry.mockResolvedValueOnce(null).mockResolvedValueOnce(view)
    expect(await journalService.getEntry('2025-01-01')).toBeNull()
    // A file without properties leaves the key out, as Electron's entry does.
    expect(await journalService.getEntry('2025-01-01')).toEqual({
      id: 'j2025-01-01',
      date: '2025-01-01',
      content: 'Hello',
      wordCount: 1,
      characterCount: 5,
      tags: ['mood'],
      aliases: [],
      createdAt: '2025-01-01T08:00:00.000Z',
      modifiedAt: '2025-01-01T08:00:00.000Z'
    })
    expect(commands.journalGetEntry).toHaveBeenCalledWith('2025-01-01')

    commands.journalCreateEntry.mockResolvedValue({ ...view, properties: { mood: 'calm' } })
    const createInput = {
      date: '2025-01-01',
      content: 'Hello',
      tags: ['mood'],
      properties: { mood: 'calm' }
    }
    expect((await journalService.createEntry(createInput)).properties).toEqual({ mood: 'calm' })
    expect(commands.journalCreateEntry).toHaveBeenCalledWith(createInput)

    commands.journalUpdateEntry.mockResolvedValue({ ...view, content: 'Updated' })
    const updateInput = {
      date: '2025-01-01',
      content: 'Updated',
      inlineTags: { add: ['daily'] },
      properties: { mood: 'tired' }
    }
    const updated = await journalService.updateEntry(updateInput)
    expect(updated.content).toBe('Updated')
    expect(updated).not.toHaveProperty('properties')
    expect(commands.journalUpdateEntry).toHaveBeenCalledWith({ ...updateInput, tags: undefined })

    commands.journalDeleteEntry.mockResolvedValue({ success: true })
    expect(await journalService.deleteEntry('2025-01-01')).toEqual({ success: true })
    expect(commands.journalDeleteEntry).toHaveBeenCalledWith('2025-01-01', null)
  })

  it('asks before a delete the trash refused a kept day for goes for good, and deletes only on yes', async () => {
    const refused = { kind: 'storage', code: 'note_trash_unavailable', message: 'no trash' }
    const ask = async (permanent: boolean) => {
      commands.journalDeleteEntry.mockReset()
      commands.journalDeleteEntry
        .mockRejectedValueOnce(refused)
        .mockResolvedValueOnce({ success: true })
      const deleting = journalService.deleteEntry('2025-01-02')
      await vi.waitFor(() =>
        expect(current()).toMatchObject({ noteId: 'j2025-01-02', title: '2025-01-02' })
      )
      answer(current(), permanent)
      return deleting
    }

    expect(await ask(true)).toEqual({ success: true })
    expect(commands.journalDeleteEntry.mock.calls).toEqual([
      ['2025-01-02', null],
      ['2025-01-02', true]
    ])

    const kept = await ask(false)
    expect(kept.success).toBe(false)
    expect(kept.error).toEqual(expect.any(String))
    expect(commands.journalDeleteEntry.mock.calls).toEqual([['2025-01-02', null]])

    // Any other failure is thrown at once, with no question.
    commands.journalDeleteEntry.mockReset()
    commands.journalDeleteEntry.mockRejectedValueOnce({ ...refused, code: 'note_file_failed' })
    await expect(journalService.deleteEntry('2025-01-02')).rejects.toMatchObject({
      code: 'note_file_failed'
    })
    expect(current()).toBeNull()
  })

  it('reads the calendar through the Rust commands, a level as the contract types it', async () => {
    commands.journalGetHeatmap.mockResolvedValue([
      { date: '2025-01-02', characterCount: 40, level: 1 }
    ])
    expect(await journalService.getHeatmap(2025)).toEqual([
      { date: '2025-01-02', characterCount: 40, level: 1 }
    ])
    expect(commands.journalGetHeatmap).toHaveBeenCalledWith(2025)

    const preview = { date: '2025-01-02', preview: 'Hi', wordCount: 1, characterCount: 2, tags: [] }
    commands.journalGetMonthEntries.mockResolvedValue([{ ...preview, activityLevel: 9 }])
    expect(await journalService.getMonthEntries(2025, 1)).toEqual([
      { ...preview, activityLevel: 0 }
    ])
    expect(commands.journalGetMonthEntries).toHaveBeenCalledWith(2025, 1)

    // Rust's `f64` is typed `number | null`; the contract's `averageLevel` is a number.
    const stats = { year: 2025, month: 1, entryCount: 1, totalWordCount: 1, totalCharacterCount: 2 }
    commands.journalGetYearStats.mockResolvedValue([{ ...stats, averageLevel: null }])
    expect(await journalService.getYearStats(2025)).toEqual([{ ...stats, averageLevel: 0 }])
    expect(commands.journalGetYearStats).toHaveBeenCalledWith(2025)

    const streak = { currentStreak: 2, longestStreak: 5, lastEntryDate: '2025-01-02' }
    commands.journalGetStreak.mockResolvedValue(streak)
    expect(await journalService.getStreak()).toEqual(streak)

    const rows = { rows: [], properties: [{ name: 'mood', type: 'number', count: 3 }] }
    commands.journalGetPropertyRows.mockResolvedValue(rows)
    expect(await journalService.getPropertyRows('2025-01-01', '2025-01-31')).toEqual(rows)
    expect(commands.journalGetPropertyRows).toHaveBeenCalledWith('2025-01-01', '2025-01-31')

    const context = { date: '2025-01-02', tasks: [], events: [], overdueCount: 1 }
    commands.journalGetDayContext.mockResolvedValue(context)
    expect(await journalService.getDayContext('2025-01-02')).toEqual(context)
    expect(commands.journalGetDayContext).toHaveBeenCalledWith('2025-01-02')
  })

  it('forwards the tag read it does not serve', async () => {
    await journalService.getAllTags()
    expect(api.journal.getAllTags).toHaveBeenCalled()
  })

  it('takes every journal event from Rust', async () => {
    const created = vi.fn()
    const updated = vi.fn()
    const deleted = vi.fn()
    onJournalEntryCreated(created)
    onJournalEntryUpdated(updated)
    const external = vi.fn()
    onJournalEntryDeleted(deleted)
    onJournalExternalChange(external)
    await vi.waitFor(() => expect(listeners.size).toBe(4))
    listeners.get('created')?.({ payload: { date: '2025-01-01', entry: view } })
    listeners.get('updated')?.({
      payload: { date: '2025-01-01', entry: view, source: 'external' }
    })
    listeners.get('deleted')?.({ payload: { date: '2025-01-01', source: 'external' } })
    listeners.get('external')?.({ payload: { date: '2025-01-01', type: 'modified' } })
    expect(created).toHaveBeenCalledWith({
      date: '2025-01-01',
      entry: expect.not.objectContaining({ properties: null })
    })
    expect(updated).toHaveBeenCalledWith({
      date: '2025-01-01',
      entry: expect.not.objectContaining({ properties: null }),
      source: 'external'
    })
    expect(deleted).toHaveBeenCalledWith({ date: '2025-01-01', source: 'external' })
    expect(external).toHaveBeenCalledWith({ date: '2025-01-01', type: 'modified' })
  })

  it('formats and compares journal dates', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-12T10:00:00.000Z'))

    expect(getTodayDate()).toBe('2026-05-12')
    expect(formatJournalDate('2026-05-12')).toBe('Tuesday, May 12, 2026')
    expect(isToday('2026-05-12')).toBe(true)
    expect(isToday('2026-05-11')).toBe(false)
    expect(isPastDate('2026-05-11')).toBe(true)
    expect(isPastDate('2026-05-13')).toBe(false)
    expect(isFutureDate('2026-05-13')).toBe(true)
    expect(isFutureDate('2026-05-11')).toBe(false)

    vi.useRealTimers()
  })
})
