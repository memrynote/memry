/**
 * Journal IPC handlers.
 * Handles all journal-related IPC communication from renderer.
 *
 * @module ipc/journal-handlers
 */

import { ipcMain, BrowserWindow } from 'electron'
import { JournalChannels } from '@shared/ipc-channels'
import {
  GetEntryInputSchema,
  CreateEntryInputSchema,
  UpdateEntryInputSchema,
  DeleteEntryInputSchema,
  GetHeatmapInputSchema,
  GetMonthEntriesInputSchema,
  GetYearStatsInputSchema,
  GetDayContextInputSchema,
  SearchEntriesInputSchema,
  calculateActivityLevel,
  type JournalEntry,
  type HeatmapEntry,
  type MonthEntryPreview,
  type MonthStats,
  type DayContext,
  type GetAllTagsOutput,
  type SearchResult
} from '@shared/contracts/journal-api'
import { createValidatedHandler, createHandler } from './validate'
import {
  readJournalEntry,
  writeJournalEntry,
  deleteJournalEntryFile,
  getJournalRelativePath,
  extractPreview
} from '../vault/journal'
import {
  insertJournalEntry,
  updateJournalEntry,
  deleteJournalEntry,
  getJournalEntryByDate,
  getHeatmapData,
  getMonthEntries,
  getYearStats,
  setJournalTags,
  getJournalTags,
  getAllJournalTags,
  getJournalStreak
} from '@shared/db/queries/journal'
import { getIndexDatabase } from '../database'

// ============================================================================
// Event Emitters
// ============================================================================

/**
 * Emit journal event to all windows.
 */
function emitJournalEvent(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, payload)
  })
}

// ============================================================================
// IPC Handlers Registration
// ============================================================================

/**
 * Register all journal-related IPC handlers.
 * Call this once during app initialization.
 */
export function registerJournalHandlers(): void {
  // =========================================================================
  // Entry CRUD
  // =========================================================================

  // journal:getEntry - Get a journal entry by date
  ipcMain.handle(
    JournalChannels.invoke.GET_ENTRY,
    createValidatedHandler(GetEntryInputSchema, async (input): Promise<JournalEntry | null> => {
      // Read from file (source of truth)
      const entry = await readJournalEntry(input.date)
      return entry
    })
  )

  // journal:createEntry - Create a new journal entry
  ipcMain.handle(
    JournalChannels.invoke.CREATE_ENTRY,
    createValidatedHandler(CreateEntryInputSchema, async (input): Promise<JournalEntry> => {
      const db = getIndexDatabase()

      // Write to file
      const entry = await writeJournalEntry(input.date, input.content ?? '', input.tags)

      // Insert into cache
      insertJournalEntry(db, {
        id: entry.id,
        date: entry.date,
        path: getJournalRelativePath(entry.date),
        wordCount: entry.wordCount,
        characterCount: entry.characterCount,
        activityLevel: calculateActivityLevel(entry.characterCount),
        createdAt: entry.createdAt,
        modifiedAt: entry.modifiedAt
      })

      // Set tags in cache
      if (entry.tags.length > 0) {
        setJournalTags(db, entry.id, entry.tags)
      }

      // Emit event
      emitJournalEvent(JournalChannels.events.ENTRY_CREATED, {
        date: entry.date,
        entry
      })

      return entry
    })
  )

  // journal:updateEntry - Update an existing journal entry
  ipcMain.handle(
    JournalChannels.invoke.UPDATE_ENTRY,
    createValidatedHandler(UpdateEntryInputSchema, async (input): Promise<JournalEntry> => {
      const db = getIndexDatabase()

      // Get existing entry from cache
      const cached = getJournalEntryByDate(db, input.date)

      // Read current entry to get existing data
      const existing = await readJournalEntry(input.date)
      if (!existing) {
        // If entry doesn't exist, create it
        const entry = await writeJournalEntry(input.date, input.content ?? '', input.tags ?? [])

        insertJournalEntry(db, {
          id: entry.id,
          date: entry.date,
          path: getJournalRelativePath(entry.date),
          wordCount: entry.wordCount,
          characterCount: entry.characterCount,
          activityLevel: calculateActivityLevel(entry.characterCount),
          createdAt: entry.createdAt,
          modifiedAt: entry.modifiedAt
        })

        if (entry.tags.length > 0) {
          setJournalTags(db, entry.id, entry.tags)
        }

        emitJournalEvent(JournalChannels.events.ENTRY_CREATED, {
          date: entry.date,
          entry
        })

        return entry
      }

      // Merge updates
      const newContent = input.content ?? existing.content
      const newTags = input.tags ?? existing.tags

      // Write to file
      const entry = await writeJournalEntry(input.date, newContent, newTags)

      // Update cache
      if (cached) {
        updateJournalEntry(db, cached.id, {
          wordCount: entry.wordCount,
          characterCount: entry.characterCount,
          activityLevel: calculateActivityLevel(entry.characterCount)
        })
        setJournalTags(db, cached.id, entry.tags)
      } else {
        // Entry exists in file but not in cache - insert it
        insertJournalEntry(db, {
          id: entry.id,
          date: entry.date,
          path: getJournalRelativePath(entry.date),
          wordCount: entry.wordCount,
          characterCount: entry.characterCount,
          activityLevel: calculateActivityLevel(entry.characterCount),
          createdAt: entry.createdAt,
          modifiedAt: entry.modifiedAt
        })
        if (entry.tags.length > 0) {
          setJournalTags(db, entry.id, entry.tags)
        }
      }

      // Emit event
      emitJournalEvent(JournalChannels.events.ENTRY_UPDATED, {
        date: entry.date,
        entry
      })

      return entry
    })
  )

  // journal:deleteEntry - Delete a journal entry
  ipcMain.handle(
    JournalChannels.invoke.DELETE_ENTRY,
    createValidatedHandler(DeleteEntryInputSchema, async (input): Promise<{ success: boolean }> => {
      const db = getIndexDatabase()

      // Get cached entry to find the ID
      const cached = getJournalEntryByDate(db, input.date)

      // Delete file
      const deleted = await deleteJournalEntryFile(input.date)

      // Delete from cache
      if (cached) {
        deleteJournalEntry(db, cached.id)
      }

      // Emit event
      if (deleted) {
        emitJournalEvent(JournalChannels.events.ENTRY_DELETED, {
          date: input.date
        })
      }

      return { success: deleted }
    })
  )

  // =========================================================================
  // Calendar & Views
  // =========================================================================

  // journal:getHeatmap - Get heatmap data for a year
  ipcMain.handle(
    JournalChannels.invoke.GET_HEATMAP,
    createValidatedHandler(GetHeatmapInputSchema, async (input): Promise<HeatmapEntry[]> => {
      const db = getIndexDatabase()
      const data = getHeatmapData(db, input.year)
      return data.map((d) => ({
        date: d.date,
        characterCount: d.characterCount,
        level: d.level as 0 | 1 | 2 | 3 | 4
      }))
    })
  )

  // journal:getMonthEntries - Get entries for a specific month
  ipcMain.handle(
    JournalChannels.invoke.GET_MONTH_ENTRIES,
    createValidatedHandler(
      GetMonthEntriesInputSchema,
      async (input): Promise<MonthEntryPreview[]> => {
        const db = getIndexDatabase()
        const entries = getMonthEntries(db, input.year, input.month)

        // For each entry, we need to get the preview from the file
        const previews: MonthEntryPreview[] = await Promise.all(
          entries.map(async (entry) => {
            const tags = getJournalTags(db, entry.id)

            // Try to get preview from file
            let preview = ''
            try {
              const fullEntry = await readJournalEntry(entry.date)
              if (fullEntry) {
                preview = extractPreview(fullEntry.content, 100)
              }
            } catch {
              // Ignore preview errors
            }

            return {
              date: entry.date,
              preview,
              wordCount: entry.wordCount,
              characterCount: entry.characterCount,
              activityLevel: entry.activityLevel as 0 | 1 | 2 | 3 | 4,
              tags
            }
          })
        )

        return previews
      }
    )
  )

  // journal:getYearStats - Get stats for all months in a year
  ipcMain.handle(
    JournalChannels.invoke.GET_YEAR_STATS,
    createValidatedHandler(GetYearStatsInputSchema, async (input): Promise<MonthStats[]> => {
      const db = getIndexDatabase()
      const stats = getYearStats(db, input.year)
      return stats.map((s) => ({
        year: input.year,
        month: s.month,
        entryCount: s.entryCount,
        totalWordCount: s.totalWordCount,
        totalCharacterCount: s.totalCharacterCount,
        averageLevel: s.averageLevel
      }))
    })
  )

  // =========================================================================
  // Context
  // =========================================================================

  // journal:getDayContext - Get tasks and events for a specific date
  ipcMain.handle(
    JournalChannels.invoke.GET_DAY_CONTEXT,
    createValidatedHandler(GetDayContextInputSchema, async (input): Promise<DayContext> => {
      // TODO: Implement task integration in Phase 6 (User Story 6)
      // For now, return empty context
      return {
        date: input.date,
        tasks: [],
        events: [],
        overdueCount: 0
      }
    })
  )

  // =========================================================================
  // Tags & Search
  // =========================================================================

  // journal:getAllTags - Get all tags used in journal entries
  ipcMain.handle(
    JournalChannels.invoke.GET_ALL_TAGS,
    createHandler(async (): Promise<GetAllTagsOutput> => {
      const db = getIndexDatabase()
      return getAllJournalTags(db)
    })
  )

  // journal:searchEntries - Search journal entries
  ipcMain.handle(
    JournalChannels.invoke.SEARCH_ENTRIES,
    createValidatedHandler(SearchEntriesInputSchema, async (_input): Promise<SearchResult[]> => {
      // TODO: Implement FTS search in Phase 13 (User Story 11)
      // For now, return empty results
      return []
    })
  )

  // =========================================================================
  // Streak
  // =========================================================================

  // journal:getStreak - Get current and longest streak
  ipcMain.handle(
    JournalChannels.invoke.GET_STREAK,
    createHandler(
      async (): Promise<{
        currentStreak: number
        longestStreak: number
        lastEntryDate: string | null
      }> => {
        const db = getIndexDatabase()
        return getJournalStreak(db)
      }
    )
  )
}

/**
 * Unregister all journal-related IPC handlers.
 * Useful for cleanup or testing.
 */
export function unregisterJournalHandlers(): void {
  Object.values(JournalChannels.invoke).forEach((channel) => {
    ipcMain.removeHandler(channel)
  })
}
