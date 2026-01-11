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
  type JournalEntry,
  type HeatmapEntry,
  type MonthEntryPreview,
  type MonthStats,
  type DayContext,
  type GetAllTagsOutput
} from '@shared/contracts/journal-api'
import { createValidatedHandler, createHandler } from './validate'
import {
  readJournalEntry,
  writeJournalEntryWithContent,
  deleteJournalEntryFile,
  getJournalRelativePath,
  extractPreview,
  serializeJournalEntry
} from '../vault/journal'
import { maybeCreateSignificantSnapshot } from '../vault/notes'
import { syncNoteToCache } from '../vault/note-sync'
import { queueEmbeddingUpdate } from '../inbox/embedding-queue'
import {
  // Unified CRUD operations (using note_cache)
  deleteNoteCache,
  getNoteCacheByPath,
  // Journal-specific queries
  getJournalEntryByDate,
  getHeatmapData,
  getJournalMonthEntries,
  getJournalYearStats,
  getJournalStreak,
  // Tag operations (using note_tags)
  getNoteTags,
  getAllTagsWithColors,
  // Property operations (using note_properties)
  getNotePropertiesAsRecord,
  setNoteProperties,
  inferPropertyType,
  // Utilities
  calculateActivityLevel as calculateActivityLevelFromCharCount
} from '@shared/db/queries/notes'
import { getTasksByDueDate, countOverdueTasksBeforeDate } from '@shared/db/queries/tasks'
import { getIndexDatabase, getDatabase } from '../database'

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
      if (!entry) return null

      // Load properties from cache (using unified note_properties)
      const db = getIndexDatabase()
      const cached = getJournalEntryByDate(db, input.date)
      if (cached) {
        const properties = getNotePropertiesAsRecord(db, cached.id)
        if (Object.keys(properties).length > 0) {
          entry.properties = properties
        }
      }

      return entry
    })
  )

  // journal:createEntry - Create a new journal entry
  ipcMain.handle(
    JournalChannels.invoke.CREATE_ENTRY,
    createValidatedHandler(CreateEntryInputSchema, async (input): Promise<JournalEntry> => {
      const db = getIndexDatabase()

      // Write to file
      const { entry, fileContent, frontmatter } = await writeJournalEntryWithContent(
        input.date,
        input.content ?? '',
        input.tags
      )

      const journalPath = getJournalRelativePath(entry.date)
      const cached = getJournalEntryByDate(db, entry.date)
      const cacheId = cached?.id ?? entry.id

      syncNoteToCache(
        db,
        {
          id: cacheId,
          path: journalPath,
          fileContent,
          frontmatter,
          parsedContent: entry.content
        },
        { isNew: !cached }
      )
      queueEmbeddingUpdate(cacheId)

      // Set properties using unified note_properties
      if (input.properties && Object.keys(input.properties).length > 0) {
        setNoteProperties(db, cacheId, input.properties, inferPropertyType)
        entry.properties = input.properties
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

      // Get existing entry from unified cache (try by date first, then by path as fallback)
      const journalPath = getJournalRelativePath(input.date)
      let cached = getJournalEntryByDate(db, input.date)
      if (!cached) {
        // Fallback: check by path (for entries indexed before migration)
        cached = getNoteCacheByPath(db, journalPath)
      }

      // Read current entry to get existing data
      const existing = await readJournalEntry(input.date)
      if (!existing) {
        // If entry doesn't exist, create it
        const { entry, fileContent, frontmatter } = await writeJournalEntryWithContent(
          input.date,
          input.content ?? '',
          input.tags ?? []
        )
        const cacheId = cached?.id ?? entry.id

        syncNoteToCache(
          db,
          {
            id: cacheId,
            path: journalPath,
            fileContent,
            frontmatter,
            parsedContent: entry.content
          },
          { isNew: !cached }
        )
        queueEmbeddingUpdate(cacheId)

        // Set properties if provided
        if (input.properties && Object.keys(input.properties).length > 0) {
          setNoteProperties(db, cacheId, input.properties, inferPropertyType)
          entry.properties = input.properties
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

      // Create snapshot before significant content changes (T111)
      // Use the entry ID from cache or existing entry
      const entryId = cached?.id ?? existing.id
      if (input.content !== undefined && input.content !== existing.content) {
        try {
          // Create the current file content (before save) for snapshot
          const currentFileContent = serializeJournalEntry(
            {
              id: existing.id,
              date: existing.date,
              created: existing.createdAt,
              modified: existing.modifiedAt,
              tags: existing.tags
            },
            existing.content
          )
          maybeCreateSignificantSnapshot(
            entryId,
            currentFileContent,
            existing.content,
            newContent,
            `Journal - ${input.date}`
          )
        } catch (err) {
          console.error('[Journal Snapshot] Failed to create snapshot:', err)
        }
      }

      // Write to file
      const { entry, fileContent, frontmatter } = await writeJournalEntryWithContent(
        input.date,
        newContent,
        newTags,
        existing
      )
      const cacheId = cached?.id ?? entry.id

      syncNoteToCache(
        db,
        {
          id: cacheId,
          path: journalPath,
          fileContent,
          frontmatter,
          parsedContent: entry.content
        },
        { isNew: !cached }
      )
      queueEmbeddingUpdate(cacheId)

      // Update properties if provided
      if (input.properties !== undefined) {
        setNoteProperties(db, cacheId, input.properties, inferPropertyType)
        entry.properties = input.properties
      } else if (existing.properties) {
        // Keep existing properties if not updating
        entry.properties = existing.properties
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

      // Delete from unified cache
      if (cached) {
        deleteNoteCache(db, cached.id)
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
  // Note: Now uses unified tag system (note_tags + tag_definitions)
  ipcMain.handle(
    JournalChannels.invoke.GET_ALL_TAGS,
    createHandler((): GetAllTagsOutput => {
      const db = getIndexDatabase()
      // Get all tags with colors from unified system
      const tagsWithColors = getAllTagsWithColors(db)
      // Return in expected format (tag + count, without color for backward compat)
      return tagsWithColors.map((t) => ({ tag: t.tag, count: t.count }))
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
