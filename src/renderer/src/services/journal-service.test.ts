import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import {
  journalService,
  onJournalEntryCreated,
  onJournalEntryUpdated,
  onJournalEntryDeleted,
  onJournalExternalChange
} from './journal-service'

describe('journal-service', () => {
  let api: any

  beforeEach(() => {
    api = createMockApi()
    api.journal.getEntry = vi.fn().mockResolvedValue({ id: 'j-1' })
    api.journal.createEntry = vi.fn().mockResolvedValue({ id: 'j-1' })
    api.journal.updateEntry = vi.fn().mockResolvedValue({ id: 'j-1' })
    api.journal.deleteEntry = vi.fn().mockResolvedValue({ success: true })
    api.journal.getHeatmap = vi.fn().mockResolvedValue([])
    api.journal.getMonthEntries = vi.fn().mockResolvedValue([])
    api.journal.getYearStats = vi.fn().mockResolvedValue([])
    api.journal.getDayContext = vi.fn().mockResolvedValue({ date: '2025-01-01', tasks: [], events: [] })
    api.journal.getAllTags = vi.fn().mockResolvedValue([])
    api.journal.getStreak = vi.fn().mockResolvedValue({ currentStreak: 0, longestStreak: 0 })

    api.onJournalEntryCreated = vi.fn().mockReturnValue(() => {})
    api.onJournalEntryUpdated = vi.fn().mockReturnValue(() => {})
    api.onJournalEntryDeleted = vi.fn().mockReturnValue(() => {})
    api.onJournalExternalChange = vi.fn().mockReturnValue(() => {})

    ;(window as Window & { api: unknown }).api = api
  })

  it('forwards journal CRUD and calendar operations', async () => {
    await journalService.getEntry('2025-01-01')
    expect(api.journal.getEntry).toHaveBeenCalledWith('2025-01-01')

    const createInput = { date: '2025-01-01', content: 'Hello', tags: ['mood'] }
    await journalService.createEntry(createInput)
    expect(api.journal.createEntry).toHaveBeenCalledWith(createInput)

    const updateInput = { date: '2025-01-01', content: 'Updated' }
    await journalService.updateEntry(updateInput)
    expect(api.journal.updateEntry).toHaveBeenCalledWith(updateInput)

    await journalService.deleteEntry('2025-01-01')
    expect(api.journal.deleteEntry).toHaveBeenCalledWith('2025-01-01')

    await journalService.getHeatmap(2025)
    expect(api.journal.getHeatmap).toHaveBeenCalledWith(2025)

    await journalService.getMonthEntries(2025, 1)
    expect(api.journal.getMonthEntries).toHaveBeenCalledWith(2025, 1)

    await journalService.getYearStats(2025)
    expect(api.journal.getYearStats).toHaveBeenCalledWith(2025)
  })

  it('forwards context and tag queries', async () => {
    await journalService.getDayContext('2025-01-02')
    expect(api.journal.getDayContext).toHaveBeenCalledWith('2025-01-02')

    await journalService.getAllTags()
    expect(api.journal.getAllTags).toHaveBeenCalled()

    await journalService.getStreak()
    expect(api.journal.getStreak).toHaveBeenCalled()
  })

  it('registers journal event subscriptions', () => {
    const unsubscribe = vi.fn()
    api.onJournalEntryCreated = vi.fn(() => unsubscribe)
    api.onJournalEntryUpdated = vi.fn(() => unsubscribe)
    api.onJournalEntryDeleted = vi.fn(() => unsubscribe)
    api.onJournalExternalChange = vi.fn(() => unsubscribe)

    expect(onJournalEntryCreated(vi.fn())).toBe(unsubscribe)
    expect(onJournalEntryUpdated(vi.fn())).toBe(unsubscribe)
    expect(onJournalEntryDeleted(vi.fn())).toBe(unsubscribe)
    expect(onJournalExternalChange(vi.fn())).toBe(unsubscribe)
  })
})
