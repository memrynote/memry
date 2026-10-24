/**
 * Journal IPC handlers.
 * Handles all journal-related IPC communication from renderer.
 *
 * @module ipc/journal-handlers
 */

import { ipcMain } from 'electron'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { JournalChannels } from '@memry/contracts/ipc-channels'
import {
  GetEntryInputSchema,
  CreateEntryInputSchema,
  UpdateEntryInputSchema,
  DeleteEntryInputSchema,
  GetHeatmapInputSchema,
  GetMonthEntriesInputSchema,
  GetYearStatsInputSchema,
  GetDayContextInputSchema,
  GetPropertyRowsInputSchema,
  type GetPropertyRowsOutput,
  type JournalEntry,
  type HeatmapEntry,
  type MonthEntryPreview,
  type MonthStats,
  type DayContext,
  type GetAllTagsOutput
} from '@memry/contracts/journal-api'
import { createValidatedHandler, createHandler } from './validate'
import { createJournalEntry, findStoredJournalEntry } from '../journal/create-entry'
import { updateJournalEntry } from '../journal/update-entry'
import {
  readJournalEntry,
  deleteJournalEntryFile,
  getJournalRelativePath,
  extractPreview
} from '../vault/journal'
import {
  getNoteCacheByPath,
  getJournalEntryByDate,
  getHeatmapData,
  getJournalMonthEntries,
  getJournalYearStats,
  getJournalStreak,
  getJournalPropertyRows,
  getNoteTags,
  getAllTags,
  calculateActivityLevel as calculateActivityLevelFromCharCount,
  getTasksByDueDate,
  countOverdueTasksBeforeDate
} from '../journal/store'
import { getIndexDatabase, getDatabase } from '../database'
import { getCanonicalJournalByDate } from '@memry/domain-notes'
import { enqueueJournalDelete } from '../journal/runtime-effects'
import { unlinkTasksFromDeletedNote } from '../notes/runtime-effects'
import { deleteJournalCache } from '../vault/journal-cache-sync'
import { trackMainEvent } from '../telemetry/track'

// ============================================================================
// Event Emitters
// ============================================================================

/**
 * Emit journal event to all windows.
 */
function emitJournalEvent(channel: string, payload: unknown): void {
  broadcastToAllWindows(channel, payload)
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
      const entry = await readJournalEntry(input.date)
      if (!entry) return null

      trackMainEvent('journal_opened', {
        surface: 'journal',
        action: 'opened',
        objectType: 'journal',
        result: 'success'
      })

      // `readJournalEntry` only reads the file, so its id is always the
      // deterministic `j<date>` — but that is not necessarily the id the vault
      // holds for the same file. A journal file that reached the index through
      // the vault scanner or the watcher (a pre-existing vault, a file synced in
      // by Dropbox/iCloud, an entry written by another editor) was given a fresh
      // note id instead. Everything the renderer keys off this id resolves
      // through note_cache: the `linkedNoteIds` of a task created inside the
      // entry, bookmarks, backlinks, the CRDT doc. Hand back the id the cache
      // actually holds — the same one create/update settle on.
      // Timestamps come from the same row: the file carries no created time,
      // so `readJournalEntry` fills in "now", which the Home widget showed as
      // the entry's time (#2977).
      const stored = findStoredJournalEntry(input.date)
      if (!stored) return entry
      return { ...entry, id: stored.id, createdAt: stored.createdAt, modifiedAt: stored.modifiedAt }
    })
  )

  // journal:createEntry - Create a new journal entry
  ipcMain.handle(
    JournalChannels.invoke.CREATE_ENTRY,
    createValidatedHandler(CreateEntryInputSchema, async (input): Promise<JournalEntry> => {
      return createJournalEntry({
        date: input.date,
        content: input.content ?? '',
        tags: input.tags,
        properties: input.properties
      })
    })
  )

  // journal:updateEntry - Update an existing journal entry
  ipcMain.handle(
    JournalChannels.invoke.UPDATE_ENTRY,
    createValidatedHandler(UpdateEntryInputSchema, (input): Promise<JournalEntry> =>
      updateJournalEntry(input)
    )
  )

  // journal:deleteEntry - Delete a journal entry
  ipcMain.handle(
    JournalChannels.invoke.DELETE_ENTRY,
    createValidatedHandler(DeleteEntryInputSchema, async (input): Promise<{ success: boolean }> => {
      const db = getIndexDatabase()
      const dataDb = getDatabase()
      const journalPath = getJournalRelativePath(input.date)
      const cached = getJournalEntryByDate(db, input.date) ?? getNoteCacheByPath(db, journalPath)
      const canonical = getCanonicalJournalByDate(dataDb, input.date)
      const noteId = canonical?.id ?? cached?.id

      // Delete file
      const deleted = await deleteJournalEntryFile(input.date)

      // Delete from unified cache
      if (noteId) {
        await enqueueJournalDelete(noteId, input.date)
        deleteJournalCache(db, noteId)
        await unlinkTasksFromDeletedNote(noteId)
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
    createValidatedHandler(GetHeatmapInputSchema, (input): HeatmapEntry[] => {
      const db = getIndexDatabase()
      const data = getHeatmapData(db, input.year)
      return data.map((d) => ({
        date: d.date,
        characterCount: d.characterCount,
        level: d.level
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
        const entries = getJournalMonthEntries(db, input.year, input.month)

        // For each entry, we need to get the preview from the file
        const previews: MonthEntryPreview[] = await Promise.all(
          entries.map(async (entry) => {
            const tags = getNoteTags(db, entry.id)

            // Try to get preview from file
            let preview = ''
            try {
              if (entry.date) {
                const fullEntry = await readJournalEntry(entry.date)
                if (fullEntry) {
                  preview = extractPreview(fullEntry.content, 100)
                }
              }
            } catch {
              // Ignore preview errors
            }

            return {
              date: entry.date!,
              preview,
              wordCount: entry.wordCount ?? 0,
              characterCount: entry.characterCount ?? 0,
              activityLevel: calculateActivityLevelFromCharCount(entry.characterCount ?? 0),
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
    createValidatedHandler(GetYearStatsInputSchema, (input): MonthStats[] => {
      const db = getIndexDatabase()
      const stats = getJournalYearStats(db, input.year)
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
    createValidatedHandler(GetDayContextInputSchema, (input): DayContext => {
      const dataDb = getDatabase()

      // Get tasks due on the specified date (including completed)
      const dueTasks = getTasksByDueDate(dataDb, input.date, true)

      // Count overdue tasks (due before this date and not completed)
      const overdueCount = countOverdueTasksBeforeDate(dataDb, input.date)

      // Map tasks to DayTask format
      const tasks = dueTasks.map((task) => ({
        id: task.id,
        title: task.title,
        completed: task.completedAt !== null,
        priority: mapPriority(task.priority),
        isOverdue: false // Tasks due on this specific date are not overdue for this date
      }))

      // Calendar events are not yet implemented (spec mentions "can be mocked initially")
      // Return empty events array for now
      return {
        date: input.date,
        tasks,
        events: [],
        overdueCount
      }
    })
  )

  // =========================================================================
  // Tags & Search
  // =========================================================================

  // journal:getAllTags - Get all tags used in journal entries
  // Note: Uses note_tags in index.db for counts.
  ipcMain.handle(
    JournalChannels.invoke.GET_ALL_TAGS,
    createHandler((): GetAllTagsOutput => {
      const db = getIndexDatabase()
      const tagsWithCounts = getAllTags(db)
      return tagsWithCounts.map((t) => ({ tag: t.tag, count: t.count }))
    })
  )

  // =========================================================================
  // Charts
  // =========================================================================

  // journal:getPropertyRows - Entries' days and property values in a range
  ipcMain.handle(
    JournalChannels.invoke.GET_PROPERTY_ROWS,
    createValidatedHandler(GetPropertyRowsInputSchema, (input): GetPropertyRowsOutput => {
      const db = getIndexDatabase()
      return getJournalPropertyRows(db, input.from, input.to)
    })
  )

  // =========================================================================
  // Streak
  // =========================================================================

  // journal:getStreak - Get current and longest streak
  ipcMain.handle(
    JournalChannels.invoke.GET_STREAK,
    createHandler(
      (): {
        currentStreak: number
        longestStreak: number
        lastEntryDate: string | null
      } => {
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

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map numeric priority (0-4) to string priority for DayTask.
 * 0 = none (undefined), 1 = low, 2 = medium, 3 = high, 4 = urgent
 */
function mapPriority(priority: number): 'low' | 'medium' | 'high' | 'urgent' | undefined {
  switch (priority) {
    case 1:
      return 'low'
    case 2:
      return 'medium'
    case 3:
      return 'high'
    case 4:
      return 'urgent'
    default:
      return undefined
  }
}
