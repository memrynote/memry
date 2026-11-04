import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'

const commands = vi.hoisted(() => ({
  journalGetEntry: vi.fn(),
  journalCreateEntry: vi.fn(),
  journalUpdateEntry: vi.fn(),
  journalDeleteEntry: vi.fn()
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
    api.journal.getHeatmap = vi.fn().mockResolvedValue([])
    api.journal.getMonthEntries = vi.fn().mockResolvedValue([])
    api.journal.getYearStats = vi.fn().mockResolvedValue([])
    api.journal.getDayContext = vi
      .fn()
      .mockResolvedValue({ date: '2025-01-01', tasks: [], events: [] })
    api.journal.getAllTags = vi.fn().mockResolvedValue([])
    api.journal.getStreak = vi.fn().mockResolvedValue({ currentStreak: 0, longestStreak: 0 })

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

  it('forwards the calendar, context and tag reads it does not serve yet', async () => {
    await journalService.getHeatmap(2025)
    expect(api.journal.getHeatmap).toHaveBeenCalledWith(2025)

    await journalService.getMonthEntries(2025, 1)
    expect(api.journal.getMonthEntries).toHaveBeenCalledWith(2025, 1)

    await journalService.getYearStats(2025)
    expect(api.journal.getYearStats).toHaveBeenCalledWith(2025)

    await journalService.getDayContext('2025-01-02')
    expect(api.journal.getDayContext).toHaveBeenCalledWith('2025-01-02')

    await journalService.getAllTags()
    expect(api.journal.getAllTags).toHaveBeenCalled()

    await journalService.getStreak()
    expect(api.journal.getStreak).toHaveBeenCalled()
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
