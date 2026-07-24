/**
 * Search IPC API Contract
 *
 * Shared types and Zod schemas for cross-content search.
 * Used by main process (search orchestrator, IPC handlers)
 * and renderer (search service, UI components).
 *
 * @module shared/contracts/search-types
 */

import { z } from 'zod'
import { SearchChannels } from './ipc-channels'
import type { InboxItemType } from './inbox-api'

export { SearchChannels }

// ============================================================================
// Core Types
// ============================================================================

export type ContentType = 'note' | 'journal' | 'task' | 'inbox'

export type MatchType = 'exact' | 'prefix' | 'fuzzy'

export type DatePreset = 'today' | 'this-week' | 'this-month' | 'custom'

/**
 * Underlying file behind a "note" row. Absent in older index rows, which are
 * always markdown.
 */
export type NoteFileType = 'markdown' | 'pdf' | 'image' | 'audio' | 'video'

// ============================================================================
// Search Result Metadata (per-type)
// ============================================================================

export interface NoteResultMetadata {
  type: 'note'
  path: string
  tags: string[]
  emoji?: string | null
  wordCount?: number | null
  /** Index-row creation time. Absent in responses from older main processes. */
  createdAt?: string | null
  /**
   * Underlying file type. Absent/`'markdown'` = a real note; a binary value
   * (image/pdf/audio/video) means this "note" result is actually a filed file
   * and must be opened via the file viewer, not the markdown editor. See #800.
   */
  fileType?: NoteFileType
}

export interface JournalResultMetadata {
  type: 'journal'
  date: string
  path: string
  tags: string[]
  wordCount?: number | null
}

export interface TaskResultMetadata {
  type: 'task'
  projectId: string
  projectName: string
  projectColor: string
  statusId: string | null
  statusName: string | null
  dueDate: string | null
  priority: number
  completedAt: string | null
  /** Task row creation time. Absent in responses from older main processes. */
  createdAt?: string | null
}

export interface InboxResultMetadata {
  type: 'inbox'
  itemType: InboxItemType
  sourceUrl: string | null
  sourceTitle: string | null
  filedAt: string | null
}

export type SearchResultMetadata =
  | NoteResultMetadata
  | JournalResultMetadata
  | TaskResultMetadata
  | InboxResultMetadata

// ============================================================================
// Search Result Item
// ============================================================================

export interface SearchResultItem {
  id: string
  type: ContentType
  title: string
  snippet: string
  score: number
  normalizedScore: number
  matchType: MatchType
  modifiedAt: string
  metadata: SearchResultMetadata
}

// ============================================================================
// Search Query
// ============================================================================

export interface DateRange {
  from: string
  to: string
}

export interface SearchQuery {
  text: string
  types: ContentType[]
  tags: string[]
  dateRange: DateRange | null
  projectId: string | null
  folderPath: string | null
  limit: number
  offset: number
  /**
   * Restricts note hits to these file types. Applied inside the FTS query so
   * `limit` counts eligible rows only — filtering after the cap would let
   * matching binaries starve the markdown notes out of the results (#874).
   * Omitted = every file type.
   */
  noteFileTypes?: NoteFileType[]
}

// ============================================================================
// Search Response
// ============================================================================

export interface SearchResultGroup {
  type: ContentType
  results: SearchResultItem[]
  totalInGroup: number
}

export interface SearchResponse {
  groups: SearchResultGroup[]
  totalCount: number
  queryTimeMs: number
}

export interface QuickSearchResponse {
  results: SearchResultItem[]
  queryTimeMs: number
}

// ============================================================================
// Search Reasons (visited items from search)
// ============================================================================

export interface SearchReason {
  id: string
  itemId: string
  itemType: ContentType
  itemTitle: string
  itemIcon: string | null
  searchQuery: string
  visitedAt: string
}

// ============================================================================
// Search Stats
// ============================================================================

export interface SearchStats {
  totalNotes: number
  totalJournals: number
  totalTasks: number
  totalInboxItems: number
  totalIndexed: number
  lastIndexedAt: string | null
}

// ============================================================================
// Index Rebuild Events
// ============================================================================

export type IndexRebuildPhase = 'notes' | 'tasks' | 'inbox'

export interface IndexRebuildProgress {
  phase: IndexRebuildPhase
  current: number
  total: number
  percent: number
}

// ============================================================================
// Zod Schemas (for IPC handler validation)
// ============================================================================

export const ContentTypeEnum = z.enum(['note', 'journal', 'task', 'inbox'])

export const NoteFileTypeEnum = z.enum(['markdown', 'pdf', 'image', 'audio', 'video'])

export const DateRangeSchema = z.object({
  from: z.string(),
  to: z.string()
})

export const SearchQuerySchema = z.object({
  text: z.string().max(500),
  types: z.array(ContentTypeEnum).default([]),
  tags: z.array(z.string()).default([]),
  dateRange: DateRangeSchema.nullable().default(null),
  projectId: z.string().nullable().default(null),
  folderPath: z.string().nullable().default(null),
  limit: z.number().min(1).max(100).default(10),
  offset: z.number().min(0).default(0),
  noteFileTypes: z.array(NoteFileTypeEnum).min(1).optional()
})

export type SearchQueryInput = z.infer<typeof SearchQuerySchema>

export const QuickSearchInputSchema = z.object({
  text: z.string(),
  noteFileTypes: z.array(NoteFileTypeEnum).min(1).optional()
})

export type QuickSearchInput = z.infer<typeof QuickSearchInputSchema>

export const AddReasonSchema = z.object({
  itemId: z.string().min(1),
  itemType: ContentTypeEnum,
  itemTitle: z.string().min(1),
  itemIcon: z.string().nullable().default(null),
  searchQuery: z.string().min(1)
})

export type AddReasonInput = z.infer<typeof AddReasonSchema>
