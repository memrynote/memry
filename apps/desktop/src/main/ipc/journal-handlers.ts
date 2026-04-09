/**
 * Journal IPC handlers.
 * Handles all journal-related IPC communication from renderer.
 *
 * @module ipc/journal-handlers
 */

import { ipcMain, BrowserWindow } from 'electron'
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
  type JournalEntry,
  type HeatmapEntry,
  type MonthEntryPreview,
  type MonthStats,
  type DayContext,
  type GetAllTagsOutput
} from '@memry/contracts/journal-api'
import { createLogger } from '../lib/logger'
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
import {
  getNoteCacheByPath,
  getJournalEntryByDate,
  getHeatmapData,
  getJournalMonthEntries,
  getJournalYearStats,
  getJournalStreak,
  getNoteTags,
  getAllTags,
  calculateActivityLevel as calculateActivityLevelFromCharCount
} from '../journal/store'
import { getTasksByDueDate, countOverdueTasksBeforeDate } from '../journal/store'
import { getIndexDatabase, getDatabase } from '../database'
import { getCanonicalJournalByDate } from '@memry/domain-notes'
import {
  enqueueJournalCreate,
  enqueueJournalDelete,
  enqueueJournalUpdate,
  initializeJournalCrdt
} from '../journal/runtime-effects'
import { deleteJournalCache, syncJournalCache } from '../vault/journal-cache-sync'

const logger = createLogger('IPC:Journal')

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
      return readJournalEntry(input.date)
    })
  )

  // journal:createEntry - Create a new journal entry
  ipcMain.handle(
    JournalChannels.invoke.CREATE_ENTRY,
    createValidatedHandler(CreateEntryInputSchema, async (input): Promise<JournalEntry> => {
      const db = getIndexDatabase()
      const dataDb = getDatabase()

      // Write to file (properties are now serialized to frontmatter)
      const { entry, fileContent, frontmatter } = await writeJournalEntryWithContent(
        input.date,
        input.content ?? '',
        input.tags,
        null, // existingEntry
        input.properties // properties serialized to frontmatter
      )

      const journalPath = getJournalRelativePath(entry.date)
      const cached = getJournalEntryByDate(db, entry.date) ?? getNoteCacheByPath(db, journalPath)
      const canonical = getCanonicalJournalByDate(dataDb, entry.date)
      const cacheId = canonical?.id ?? cached?.id ?? entry.id

      syncJournalCache(
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
      enqueueJournalCreate(cacheId, entry.date)
      initializeJournalCrdt(cacheId, entry.date, entry.tags)

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
      const dataDb = getDatabase()

      // Resolve the canonical journal identity from data.db.
      const journalPath = getJournalRelativePath(input.date)
      const cached = getJournalEntryByDate(db, input.date) ?? getNoteCacheByPath(db, journalPath)
      const canonical = getCanonicalJournalByDate(dataDb, input.date)

      // Read current entry to get existing data
      const existing = await readJournalEntry(input.date)
      if (!existing) {
        // If entry doesn't exist, create it (properties serialized to frontmatter)
        const { entry, fileContent, frontmatter } = await writeJournalEntryWithContent(
          input.date,
          input.content ?? '',
          input.tags ?? [],
          null, // existingEntry
          input.properties // properties serialized to frontmatter
        )
        const cacheId = canonical?.id ?? cached?.id ?? entry.id

        syncJournalCache(
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
        enqueueJournalCreate(cacheId, entry.date)
        initializeJournalCrdt(cacheId, entry.date, entry.tags)

        emitJournalEvent(JournalChannels.events.ENTRY_CREATED, {
          date: entry.date,
          entry
        })

        return entry
      }

      // Merge updates
      const newContent = input.content ?? existing.content
      const newTags = input.tags ?? existing.tags
      // Merge properties: use input.properties if provided, otherwise keep existing
      const newProperties = input.properties !== undefined ? input.properties : existing.properties

      // Create snapshot before significant content changes (T111)
      // Use the canonical note ID when available so snapshots stay attached across rebuilds.
      const entryId = canonical?.id ?? cached?.id ?? existing.id
      if (input.content !== undefined && input.content !== existing.content) {
        try {
          // Create the current file content (before save) for snapshot
          // Include existing properties in snapshot frontmatter
          const snapshotFrontmatter: Parameters<typeof serializeJournalEntry>[0] = {
            id: existing.id,
            date: existing.date,
            created: existing.createdAt,
            modified: existing.modifiedAt,
            tags: existing.tags
          }
          if (existing.properties && Object.keys(existing.properties).length > 0) {
            snapshotFrontmatter.properties = existing.properties
          }
          const currentFileContent = serializeJournalEntry(snapshotFrontmatter, existing.content)
          maybeCreateSignificantSnapshot(
            entryId,
            currentFileContent,
            existing.content,
            newContent,
            `Journal - ${input.date}`
          )
        } catch (err) {
          logger.error('Failed to create snapshot:', err)
        }
      }

      // Write to file (properties are now serialized to frontmatter)
      const { entry, fileContent, frontmatter } = await writeJournalEntryWithContent(
        input.date,
        newContent,
        newTags,
        existing,
        newProperties // properties serialized to frontmatter
      )
      const cacheId = canonical?.id ?? cached?.id ?? entry.id

      syncJournalCache(
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
      enqueueJournalUpdate(cacheId, entry.date)

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
      const dataDb = getDatabase()
      const journalPath = getJournalRelativePath(input.date)
      const cached = getJournalEntryByDate(db, input.date) ?? getNoteCacheByPath(db, journalPath)
      const canonical = getCanonicalJournalByDate(dataDb, input.date)
      const noteId = canonical?.id ?? cached?.id

      // Delete file
      const deleted = await deleteJournalEntryFile(input.date)

      // Delete from unified cache
      if (noteId) {
        enqueueJournalDelete(noteId, input.date)
        deleteJournalCache(db, noteId)
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
