/**
 * Journal IPC handlers tests
 *
 * @module ipc/journal-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { JournalChannels } from '@memry/contracts/ipc-channels'
import type { JournalEntry } from '@memry/contracts/journal-api'

const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      handleCalls.push([channel, handler])
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      removeHandlerCalls.push(channel)
      mockIpcMain.removeHandler(channel)
    })
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ webContents: { send: vi.fn() } }])
  }
}))

vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn()
}))

vi.mock('../vault/journal', () => ({
  readJournalEntry: vi.fn(),
  writeJournalEntry: vi.fn(),
  writeJournalEntryWithContent: vi.fn(),
  deleteJournalEntryFile: vi.fn(),
  getJournalRelativePath: vi.fn(),
  extractPreview: vi.fn(),
  serializeJournalEntry: vi.fn()
}))

vi.mock('../vault/notes', () => ({
  maybeCreateSignificantSnapshot: vi.fn()
}))

vi.mock('../vault/note-sync', () => ({
  syncNoteToCache: vi.fn()
}))

vi.mock('../inbox/embedding-queue', () => ({
  queueEmbeddingUpdate: vi.fn()
}))

vi.mock('@main/database/queries/notes', () => ({
  insertNoteCache: vi.fn(),
  updateNoteCache: vi.fn(),
  deleteNoteCache: vi.fn(),
  getNoteCacheByPath: vi.fn(),
  getJournalEntryByDate: vi.fn(),
  getHeatmapData: vi.fn(),
  getJournalMonthEntries: vi.fn(),
  getJournalYearStats: vi.fn(),
  getJournalStreak: vi.fn(),
  setNoteTags: vi.fn(),
  getNoteTags: vi.fn(),
  getAllTags: vi.fn(),
  getNotePropertiesAsRecord: vi.fn(),
  setNoteProperties: vi.fn(),
  inferPropertyType: vi.fn(),
  calculateActivityLevel: vi.fn()
}))

vi.mock('@main/database/queries/tasks', () => ({
  getTasksByDueDate: vi.fn(),
  countOverdueTasksBeforeDate: vi.fn()
}))

import { registerJournalHandlers, unregisterJournalHandlers } from './journal-handlers'
import { getIndexDatabase, getDatabase } from '../database'
import * as journalVault from '../vault/journal'
import * as noteSync from '../vault/note-sync'
import * as notesQueries from '@main/database/queries/notes'
import * as tasksQueries from '@main/database/queries/tasks'

describe('journal-handlers', () => {
  const baseEntry: JournalEntry = {
    id: 'j2025-01-01',
    date: '2025-01-01',
    content: 'Hello journal',
    wordCount: 2,
    characterCount: 13,
    tags: ['focus'],
    createdAt: '2025-01-01T00:00:00.000Z',
    modifiedAt: '2025-01-01T00:00:00.000Z'
  }

  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    ;(getIndexDatabase as Mock).mockReturnValue({})
    ;(getDatabase as Mock).mockReturnValue({})
  })

  afterEach(() => {
    unregisterJournalHandlers()
  })

  it('registers all journal handlers', () => {
    registerJournalHandlers()
    expect(handleCalls.length).toBe(Object.values(JournalChannels.invoke).length)
  })

  it('gets an entry and merges cached properties', async () => {
    registerJournalHandlers()
    ;(journalVault.readJournalEntry as Mock).mockResolvedValue({ ...baseEntry })
    ;(notesQueries.getJournalEntryByDate as Mock).mockReturnValue({ id: 'cache-1' })
    ;(notesQueries.getNotePropertiesAsRecord as Mock).mockReturnValue({ mood: 'good' })

    const result = await invokeHandler(JournalChannels.invoke.GET_ENTRY, { date: '2025-01-01' })

    expect(result).toEqual(
      expect.objectContaining({ date: '2025-01-01', properties: { mood: 'good' } })
    )
  })

  it('creates a journal entry and emits event', async () => {
    registerJournalHandlers()
    // Properties are now passed to writeJournalEntryWithContent and serialized to frontmatter
    ;(journalVault.writeJournalEntryWithContent as Mock).mockResolvedValue({
      entry: { ...baseEntry, properties: { mood: 'good' } },
      fileContent: 'serialized',
      frontmatter: {
        id: baseEntry.id,
        date: baseEntry.date,
        created: baseEntry.createdAt,
        modified: baseEntry.modifiedAt,
        tags: baseEntry.tags,
        properties: { mood: 'good' }
      }
    })
    ;(journalVault.getJournalRelativePath as Mock).mockReturnValue('journal/2025-01-01.md')

    const result = await invokeHandler(JournalChannels.invoke.CREATE_ENTRY, {
      date: '2025-01-01',
      content: 'Hello journal',
      tags: ['focus'],
      properties: { mood: 'good' }
    })

    expect(result).toEqual(
      expect.objectContaining({ id: 'j2025-01-01', properties: { mood: 'good' } })
    )
    expect(noteSync.syncNoteToCache).toHaveBeenCalled()
    // Properties are now serialized to frontmatter and synced via syncNoteToCache
    // instead of being set separately via setNoteProperties
    expect(journalVault.writeJournalEntryWithContent).toHaveBeenCalledWith(
      '2025-01-01',
      'Hello journal',
      ['focus'],
      null, // existingEntry
      { mood: 'good' } // properties
    )
  })

  it('updates a journal entry and emits update event', async () => {
    registerJournalHandlers()

    const updatedEntry = {
      ...baseEntry,
      content: 'Updated content',
      wordCount: 2,
      characterCount: 15,
      modifiedAt: '2025-01-01T01:00:00.000Z'
    }

    ;(journalVault.readJournalEntry as Mock).mockResolvedValue({ ...baseEntry })
    ;(journalVault.writeJournalEntryWithContent as Mock).mockResolvedValue({
      entry: updatedEntry,
      fileContent: 'serialized',
      frontmatter: {
        id: updatedEntry.id,
        date: updatedEntry.date,
        created: updatedEntry.createdAt,
        modified: updatedEntry.modifiedAt,
        tags: updatedEntry.tags
      }
    })
    ;(journalVault.getJournalRelativePath as Mock).mockReturnValue('journal/2025-01-01.md')
    ;(journalVault.serializeJournalEntry as Mock).mockReturnValue('serialized')
    ;(notesQueries.getJournalEntryByDate as Mock).mockReturnValue({ id: 'cache-1' })

    const result = await invokeHandler(JournalChannels.invoke.UPDATE_ENTRY, {
      date: '2025-01-01',
      content: 'Updated content',
      tags: ['focus']
    })

    expect(result).toEqual(expect.objectContaining({ content: 'Updated content' }))
    expect(noteSync.syncNoteToCache).toHaveBeenCalled()
  })

  it('deletes a journal entry and emits delete event', async () => {
    registerJournalHandlers()
    ;(journalVault.deleteJournalEntryFile as Mock).mockResolvedValue(true)
    ;(notesQueries.getJournalEntryByDate as Mock).mockReturnValue({ id: 'cache-1' })

    const result = await invokeHandler(JournalChannels.invoke.DELETE_ENTRY, { date: '2025-01-01' })

    expect(result).toEqual({ success: true })
    expect(notesQueries.deleteNoteCache).toHaveBeenCalledWith({}, 'cache-1')
  })

  it('lists month entries with previews', async () => {
    registerJournalHandlers()
    ;(notesQueries.getJournalMonthEntries as Mock).mockReturnValue([
      { id: 'cache-1', date: '2025-01-01', wordCount: 2, characterCount: 13 }
    ])
    ;(notesQueries.getNoteTags as Mock).mockReturnValue(['focus'])
    ;(journalVault.readJournalEntry as Mock).mockResolvedValue({ ...baseEntry })
    ;(journalVault.extractPreview as Mock).mockReturnValue('Preview text')
    ;(notesQueries.calculateActivityLevel as Mock).mockReturnValue(1)

    const result = await invokeHandler(JournalChannels.invoke.GET_MONTH_ENTRIES, {
      year: 2025,
      month: 1
    })

    expect(result).toEqual([
      expect.objectContaining({
        date: '2025-01-01',
        preview: 'Preview text',
        tags: ['focus']
      })
    ])
  })

  it('returns heatmap and year stats', async () => {
    registerJournalHandlers()
    ;(notesQueries.getHeatmapData as Mock).mockReturnValue([
      { date: '2025-01-01', characterCount: 50, level: 2 }
    ])
    const heatmap = await invokeHandler(JournalChannels.invoke.GET_HEATMAP, { year: 2025 })
    expect(heatmap).toEqual([{ date: '2025-01-01', characterCount: 50, level: 2 }])
    ;(notesQueries.getJournalYearStats as Mock).mockReturnValue([
      {
        month: 1,
        entryCount: 3,
        totalWordCount: 120,
        totalCharacterCount: 600,
        averageLevel: 2
      }
    ])
    const stats = await invokeHandler(JournalChannels.invoke.GET_YEAR_STATS, { year: 2025 })
    expect(stats).toEqual([
      {
        year: 2025,
        month: 1,
        entryCount: 3,
        totalWordCount: 120,
        totalCharacterCount: 600,
        averageLevel: 2
      }
    ])
  })

  it('returns day context with mapped task priorities', async () => {
    registerJournalHandlers()
    ;(tasksQueries.getTasksByDueDate as Mock).mockReturnValue([
      {
        id: 'task-1',
        title: 'Low priority',
        completedAt: null,
        priority: 1
      },
      {
        id: 'task-2',
        title: 'Urgent task',
        completedAt: '2025-01-01T00:00:00.000Z',
        priority: 4
      }
    ])
    ;(tasksQueries.countOverdueTasksBeforeDate as Mock).mockReturnValue(2)

    const result = await invokeHandler(JournalChannels.invoke.GET_DAY_CONTEXT, {
      date: '2025-01-01'
    })

    expect(result).toEqual({
      date: '2025-01-01',
      events: [],
      overdueCount: 2,
      tasks: [
        expect.objectContaining({
          id: 'task-1',
          priority: 'low',
          completed: false,
          isOverdue: false
        }),
        expect.objectContaining({
          id: 'task-2',
          priority: 'urgent',
          completed: true,
          isOverdue: false
        })
      ]
    })
  })

  it('returns tag summary and streak data', async () => {
    registerJournalHandlers()
    ;(notesQueries.getAllTags as Mock).mockReturnValue([{ tag: 'focus', count: 2 }])
    const tags = await invokeHandler(JournalChannels.invoke.GET_ALL_TAGS)
    expect(tags).toEqual([{ tag: 'focus', count: 2 }])
    ;(notesQueries.getJournalStreak as Mock).mockReturnValue({
      currentStreak: 3,
      longestStreak: 7,
      lastEntryDate: '2025-01-01'
    })
    const streak = await invokeHandler(JournalChannels.invoke.GET_STREAK)
    expect(streak).toEqual({
      currentStreak: 3,
      longestStreak: 7,
      lastEntryDate: '2025-01-01'
    })
  })
})
