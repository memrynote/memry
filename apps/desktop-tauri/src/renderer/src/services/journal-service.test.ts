import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'

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
    journalEntryDeletedEvent: event('deleted')
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

    api.onJournalExternalChange = vi.fn().mockReturnValue(() => {})
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
    expect(commands.journalDeleteEntry).toHaveBeenCalledWith('2025-01-01')
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

  it('takes the created, updated and deleted events from Rust and the rest from window.api', async () => {
    const created = vi.fn()
    const updated = vi.fn()
    const deleted = vi.fn()
    onJournalEntryCreated(created)
    onJournalEntryUpdated(updated)
    onJournalEntryDeleted(deleted)
    await vi.waitFor(() => expect(listeners.size).toBe(3))
    listeners.get('created')?.({ payload: { date: '2025-01-01', entry: view } })
    listeners.get('updated')?.({ payload: { date: '2025-01-01', entry: view } })
    listeners.get('deleted')?.({ payload: { date: '2025-01-01' } })
    expect(created).toHaveBeenCalledWith({
      date: '2025-01-01',
      entry: expect.not.objectContaining({ properties: null })
    })
    expect(updated).toHaveBeenCalledWith({
      date: '2025-01-01',
      entry: expect.not.objectContaining({ properties: null })
    })
    expect(deleted).toHaveBeenCalledWith({ date: '2025-01-01' })

    const unsubscribe = vi.fn()
    api.onJournalExternalChange = vi.fn(() => unsubscribe)
    expect(onJournalExternalChange(vi.fn())).toBe(unsubscribe)
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
