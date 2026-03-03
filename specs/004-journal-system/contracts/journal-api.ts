/**
 * Journal API Contracts
 *
 * Defines the IPC interface between renderer and main process
 * for journal operations.
 *
 * @module specs/004-journal-system/contracts/journal-api
 */

import { z } from 'zod'

// =============================================================================
// Core Types
// =============================================================================

/**
 * Activity level for heatmap display (0-4 based on character count)
 */
export const ActivityLevelSchema = z.union([
  z.literal(0), // Empty
  z.literal(1), // 1-100 chars
  z.literal(2), // 101-500 chars
  z.literal(3), // 501-1000 chars
  z.literal(4) // 1001+ chars
])

export type ActivityLevel = z.infer<typeof ActivityLevelSchema>

/**
 * Full journal entry with content
 */
export const JournalEntrySchema = z.object({
  id: z.string(), // j{YYYY-MM-DD}
  date: z.string(), // YYYY-MM-DD
  content: z.string(), // Markdown content (without frontmatter)
  wordCount: z.number().int().nonnegative(),
  characterCount: z.number().int().nonnegative(),
  tags: z.array(z.string()),
  createdAt: z.string(), // ISO timestamp
  modifiedAt: z.string() // ISO timestamp
})

export type JournalEntry = z.infer<typeof JournalEntrySchema>

/**
 * Journal metadata (cache entry without content)
 */
export const JournalMetadataSchema = z.object({
  id: z.string(),
  date: z.string(),
  path: z.string(),
  wordCount: z.number().int().nonnegative(),
  characterCount: z.number().int().nonnegative(),
  activityLevel: ActivityLevelSchema,
  tags: z.array(z.string()),
  createdAt: z.string(),
  modifiedAt: z.string()
})

export type JournalMetadata = z.infer<typeof JournalMetadataSchema>

/**
 * Heatmap entry for calendar display
 */
export const HeatmapEntrySchema = z.object({
  date: z.string(), // YYYY-MM-DD
  characterCount: z.number().int().nonnegative(),
  level: ActivityLevelSchema
})

export type HeatmapEntry = z.infer<typeof HeatmapEntrySchema>

/**
 * Monthly statistics for year view
 */
export const MonthStatsSchema = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  entryCount: z.number().int().nonnegative(),
  totalWordCount: z.number().int().nonnegative(),
  totalCharacterCount: z.number().int().nonnegative(),
  averageLevel: z.number().min(0).max(4)
})

export type MonthStats = z.infer<typeof MonthStatsSchema>

/**
 * Month entry preview for month view
 */
export const MonthEntryPreviewSchema = z.object({
  date: z.string(),
  preview: z.string(), // First ~100 chars of content
  wordCount: z.number().int().nonnegative(),
  characterCount: z.number().int().nonnegative(),
  activityLevel: ActivityLevelSchema,
  tags: z.array(z.string())
})

export type MonthEntryPreview = z.infer<typeof MonthEntryPreviewSchema>

// =============================================================================
// Day Context Types
// =============================================================================

/**
 * Task displayed in day context sidebar
 */
export const DayTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  completed: z.boolean(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  isOverdue: z.boolean().optional()
})

export type DayTask = z.infer<typeof DayTaskSchema>

/**
 * Event displayed in day context sidebar
 */
export const ScheduleEventSchema = z.object({
  id: z.string(),
  time: z.string(), // HH:MM format
  title: z.string(),
  type: z.enum(['meeting', 'focus', 'event']),
  attendeeCount: z.number().int().nonnegative().optional()
})

export type ScheduleEvent = z.infer<typeof ScheduleEventSchema>

/**
 * Full day context for sidebar
 */
export const DayContextSchema = z.object({
  date: z.string(),
  tasks: z.array(DayTaskSchema),
  events: z.array(ScheduleEventSchema),
  overdueCount: z.number().int().nonnegative()
})

export type DayContext = z.infer<typeof DayContextSchema>

// =============================================================================
// AI Connection Types (for future integration)
// =============================================================================

/**
 * AI-suggested connection to past content
 */
export const AIConnectionSchema = z.object({
  id: z.string(),
  type: z.enum(['journal', 'note']),
  date: z.string().optional(), // For journal type
  title: z.string().optional(), // For note type
  preview: z.string(),
  score: z.number().min(0).max(1),
  matchedKeywords: z.array(z.string())
})

export type AIConnection = z.infer<typeof AIConnectionSchema>

// =============================================================================
// IPC Request/Response Schemas
// =============================================================================

// --- Get Entry ---

export const GetEntryInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
})

export type GetEntryInput = z.infer<typeof GetEntryInputSchema>

export const GetEntryOutputSchema = JournalEntrySchema.nullable()

export type GetEntryOutput = z.infer<typeof GetEntryOutputSchema>

// --- Create Entry ---

export const CreateEntryInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  content: z.string().default(''),
  tags: z.array(z.string()).default([])
})

export type CreateEntryInput = z.infer<typeof CreateEntryInputSchema>

export const CreateEntryOutputSchema = JournalEntrySchema

export type CreateEntryOutput = z.infer<typeof CreateEntryOutputSchema>

// --- Update Entry ---

export const UpdateEntryInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  content: z.string().optional(),
  tags: z.array(z.string()).optional()
})

export type UpdateEntryInput = z.infer<typeof UpdateEntryInputSchema>

export const UpdateEntryOutputSchema = JournalEntrySchema

export type UpdateEntryOutput = z.infer<typeof UpdateEntryOutputSchema>

// --- Delete Entry ---

export const DeleteEntryInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
})

export type DeleteEntryInput = z.infer<typeof DeleteEntryInputSchema>

export const DeleteEntryOutputSchema = z.object({
  success: z.boolean()
})

export type DeleteEntryOutput = z.infer<typeof DeleteEntryOutputSchema>

// --- Get Heatmap Data ---

export const GetHeatmapInputSchema = z.object({
  year: z.number().int().min(1970).max(2100)
})

export type GetHeatmapInput = z.infer<typeof GetHeatmapInputSchema>

export const GetHeatmapOutputSchema = z.array(HeatmapEntrySchema)

export type GetHeatmapOutput = z.infer<typeof GetHeatmapOutputSchema>

// --- Get Month Entries ---

export const GetMonthEntriesInputSchema = z.object({
  year: z.number().int().min(1970).max(2100),
  month: z.number().int().min(1).max(12)
})

export type GetMonthEntriesInput = z.infer<typeof GetMonthEntriesInputSchema>

export const GetMonthEntriesOutputSchema = z.array(MonthEntryPreviewSchema)

export type GetMonthEntriesOutput = z.infer<typeof GetMonthEntriesOutputSchema>

// --- Get Year Stats ---

export const GetYearStatsInputSchema = z.object({
  year: z.number().int().min(1970).max(2100)
})

export type GetYearStatsInput = z.infer<typeof GetYearStatsInputSchema>

export const GetYearStatsOutputSchema = z.array(MonthStatsSchema)

export type GetYearStatsOutput = z.infer<typeof GetYearStatsOutputSchema>

// --- Get Day Context ---

export const GetDayContextInputSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
})

export type GetDayContextInput = z.infer<typeof GetDayContextInputSchema>

export const GetDayContextOutputSchema = DayContextSchema

export type GetDayContextOutput = z.infer<typeof GetDayContextOutputSchema>

// --- Get All Tags ---

export const GetAllTagsOutputSchema = z.array(
  z.object({
    tag: z.string(),
    count: z.number().int().nonnegative()
  })
)

export type GetAllTagsOutput = z.infer<typeof GetAllTagsOutputSchema>

// --- Search Entries ---

export const SearchEntriesInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().default(20)
})

export type SearchEntriesInput = z.infer<typeof SearchEntriesInputSchema>

export const SearchResultSchema = z.object({
  date: z.string(),
  snippet: z.string(),
  matchCount: z.number().int().nonnegative()
})

export type SearchResult = z.infer<typeof SearchResultSchema>

export const SearchEntriesOutputSchema = z.array(SearchResultSchema)

export type SearchEntriesOutput = z.infer<typeof SearchEntriesOutputSchema>

// =============================================================================
// IPC Channel Names
// =============================================================================

export const JOURNAL_IPC_CHANNELS = {
  // Entry CRUD
  GET_ENTRY: 'journal:getEntry',
  CREATE_ENTRY: 'journal:createEntry',
  UPDATE_ENTRY: 'journal:updateEntry',
  DELETE_ENTRY: 'journal:deleteEntry',

  // Calendar & Views
  GET_HEATMAP: 'journal:getHeatmap',
  GET_MONTH_ENTRIES: 'journal:getMonthEntries',
  GET_YEAR_STATS: 'journal:getYearStats',

  // Context
  GET_DAY_CONTEXT: 'journal:getDayContext',

  // Tags & Search
  GET_ALL_TAGS: 'journal:getAllTags',
  SEARCH_ENTRIES: 'journal:searchEntries',

  // Events (main → renderer)
  ENTRY_UPDATED: 'journal:entryUpdated',
  ENTRY_CREATED: 'journal:entryCreated',
  ENTRY_DELETED: 'journal:entryDeleted',
  EXTERNAL_CHANGE: 'journal:externalChange'
} as const

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Calculate activity level from character count
 */
export function calculateActivityLevel(characterCount: number): ActivityLevel {
  if (characterCount === 0) return 0
  if (characterCount <= 100) return 1
  if (characterCount <= 500) return 2
  if (characterCount <= 1000) return 3
  return 4
}

/**
 * Generate journal entry ID from date
 */
export function generateJournalId(date: string): string {
  return `j${date}`
}

/**
 * Validate journal date format
 */
export function isValidJournalDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const parsed = new Date(date + 'T00:00:00.000Z')
  if (isNaN(parsed.getTime())) return false
  const year = parsed.getFullYear()
  return year >= 1970 && year <= 2100
}

/**
 * Extract date from journal ID
 */
export function dateFromJournalId(id: string): string | null {
  if (!/^j\d{4}-\d{2}-\d{2}$/.test(id)) return null
  return id.slice(1)
}

/**
 * Count words in text
 */
export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length
}
