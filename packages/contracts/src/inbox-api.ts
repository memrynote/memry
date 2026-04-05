/**
 * Inbox IPC API Contract
 *
 * Defines the IPC interface for inbox capture operations.
 * Handles capture, filing, snooze, and bulk operations.
 *
 * @module shared/contracts/inbox-api
 */

import { z } from 'zod'
import { InboxChannels } from './ipc-channels'
import type { ReminderTargetType } from './reminder-types'

// Re-export channels for convenience
export { InboxChannels }

// ============================================================================
// Type Definitions
// ============================================================================

export type InboxItemType =
  | 'link'
  | 'note'
  | 'image'
  | 'voice'
  | 'video'
  | 'clip'
  | 'pdf'
  | 'social'
  | 'reminder'
export type ProcessingStatus = 'pending' | 'processing' | 'complete' | 'failed'
export type FilingAction = 'folder' | 'note' | 'linked'
export type CaptureSource = 'quick-capture' | 'inline' | 'browser-extension' | 'api' | 'reminder'

export type TriageAction = 'discard' | 'convert-to-task' | 'expand-to-note' | 'file' | 'defer'

export interface TriageState {
  currentIndex: number
  totalItems: number
  currentItem: InboxItem | null
  completedCount: number
}

// ============================================================================
// Metadata Types
// ============================================================================

export interface LinkMetadata {
  url: string
  siteName?: string
  description?: string
  excerpt?: string
  heroImage?: string | null
  favicon?: string | null
  author?: string
  publishedDate?: string
  fetchedAt: string
  fetchStatus: 'success' | 'partial' | 'failed'
}

export interface ImageMetadata {
  originalFilename: string
  format: string
  width: number
  height: number
  fileSize: number
  hasExif: boolean
  caption?: string
}

export interface VoiceMetadata {
  duration: number
  format: string
  fileSize: number
  sampleRate?: number
}

export interface ClipMetadata {
  sourceUrl: string
  sourceTitle: string
  quotedText: string
  selectionContext?: string
  capturedImages: string[]
  hasFormatting: boolean
}

export interface PdfMetadata {
  originalFilename: string
  pageCount: number
  fileSize: number
  extractedTitle?: string
  author?: string
  creationDate?: string
  textExcerpt?: string
  hasText: boolean
  ocrStatus?: ProcessingStatus | 'skipped'
  isPasswordProtected?: boolean
}

export interface SocialMetadata {
  platform: 'twitter' | 'other'
  tweetId?: string
  postUrl: string
  authorName: string
  authorHandle: string
  authorAvatar?: string
  postContent: string
  timestamp?: string
  mediaUrls: string[]
  metrics?: {
    likes?: number
    reposts?: number
    replies?: number
  }
  isThread?: boolean
  threadId?: string
  extractionStatus: 'full' | 'partial' | 'failed'
}

export interface ReminderMetadata {
  /** The reminder ID from the reminders table */
  reminderId: string
  /** The type of target: note, journal, or highlight */
  targetType: ReminderTargetType
  /** The target ID (noteId or journal date YYYY-MM-DD) */
  targetId: string
  /** The resolved title of the target */
  targetTitle: string | null
  /** When the reminder was set to trigger (ISO datetime) */
  remindAt: string
  /** Highlight text (for highlight reminders) */
  highlightText?: string
  /** Character start position (for highlights) */
  highlightStart?: number
  /** Character end position (for highlights) */
  highlightEnd?: number
  /** User's note/description for the reminder */
  reminderNote?: string
}

export type InboxMetadata =
  | LinkMetadata
  | ImageMetadata
  | VoiceMetadata
  | ClipMetadata
  | PdfMetadata
  | SocialMetadata
  | ReminderMetadata

// ============================================================================
// Entity Types
// ============================================================================

export interface InboxItem {
  id: string
  type: InboxItemType
  title: string
  content: string | null
  createdAt: Date
  modifiedAt: Date

  // Filing
  filedAt: Date | null
  filedTo: string | null
  filedAction: FilingAction | null

  // Snooze
  snoozedUntil: Date | null
  snoozeReason: string | null

  // Viewed (for reminder items)
  viewedAt: Date | null

  // Archive
  archivedAt: Date | null

  // Processing
  processingStatus: ProcessingStatus
  processingError: string | null

  // Metadata
  metadata: InboxMetadata | null

  // Attachments (resolved URLs for renderer)
  attachmentPath: string | null
  attachmentUrl: string | null
  thumbnailPath: string | null
  thumbnailUrl: string | null

  // Transcription (voice only)
  transcription: string | null
  transcriptionStatus: ProcessingStatus | null

  // Source
  sourceUrl: string | null
  sourceTitle: string | null
  captureSource: CaptureSource | null

  // Computed
  tags: string[]
  isStale: boolean
}

export interface InboxItemListItem {
  id: string
  type: InboxItemType
  title: string
  content: string | null
  createdAt: Date
  thumbnailUrl: string | null
  sourceUrl: string | null
  tags: string[]
  isStale: boolean
  processingStatus: ProcessingStatus

  // Type-specific preview fields
  duration?: number // Voice
  excerpt?: string // Link/Clip
  pageCount?: number // PDF

  // Voice transcription fields
  transcription?: string | null // Transcription text (for voice items)
  transcriptionStatus?: ProcessingStatus | null // Transcription status (for voice items)

  // Snooze fields (optional - only present for snoozed items)
  snoozedUntil?: Date // When the snooze expires
  snoozeReason?: string // User-provided reason for snoozing

  // Viewed (for reminder items)
  viewedAt?: Date // When the item was opened/viewed

  // Capture source
  captureSource?: CaptureSource | null

  // Reminder-specific metadata (for reminder items)
  metadata?: ReminderMetadata // Reminder target info
}

export interface FilingDestination {
  type: 'folder' | 'note' | 'new-note'
  path?: string
  noteId?: string
  noteTitle?: string
}

export interface SuggestedNote {
  id: string
  title: string
  snippet: string
  emoji?: string | null
}

export interface FilingSuggestion {
  destination: FilingDestination
  confidence: number
  reason: string
  suggestedTags: string[]
  suggestedNote?: SuggestedNote
}

export interface InboxAgeDistribution {
  fresh: number
  aging: number
  stale: number
}

export interface InboxStats {
  totalItems: number
  itemsByType: Record<InboxItemType, number>
  staleCount: number
  snoozedCount: number
  processedToday: number
  capturedToday: number
  avgTimeToProcess: number // minutes
  capturedThisWeek: number
  processedThisWeek: number
  captureProcessRatio: number
  ageDistribution: InboxAgeDistribution
  oldestItemDays: number
  currentStreak: number
}

export interface CapturePattern {
  timeHeatmap: number[][] // 24x7 grid (hour x day)
  typeDistribution: Array<{
    type: InboxItemType
    count: number
    percentage: number
    trend: 'up' | 'down' | 'stable'
  }>
  topDomains: Array<{ domain: string; count: number }>
  topTags: Array<{ tag: string; count: number }>
}

// ============================================================================
// Request Schemas (Zod v4 compatible)
// ============================================================================

export const CaptureTextSchema = z.object({
  content: z.string().min(1).max(50000),
  title: z.string().min(1).max(200).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  force: z.boolean().optional(),
  source: z.enum(['quick-capture', 'inline', 'browser-extension', 'api', 'reminder']).optional()
})

export const CaptureLinkSchema = z.object({
  url: z.string().max(2000),
  tags: z.array(z.string().max(50)).max(20).optional(),
  force: z.boolean().optional(),
  source: z.enum(['quick-capture', 'inline', 'browser-extension', 'api', 'reminder']).optional()
})

// Custom validator for binary data that may be Buffer, Uint8Array, ArrayBuffer, or serialized object
const binaryDataSchema = z.custom<Buffer | Uint8Array | ArrayBuffer | Record<string, number>>(
  (val) => {
    if (val instanceof Buffer || val instanceof Uint8Array || val instanceof ArrayBuffer) {
      return true
    }
    // Accept plain object with numeric values (serialized buffer from IPC)
    if (typeof val === 'object' && val !== null) {
      const values = Object.values(val)
      return values.length > 0 && values.every((v) => typeof v === 'number')
    }
    return false
  },
  { message: 'Must be binary data (Buffer, Uint8Array, ArrayBuffer, or serialized buffer)' }
)

/**
 * Schema for capturing attachments (images, audio, video, PDF).
 * Accepts all viewable file types in the application.
 */
export const CaptureImageSchema = z.object({
  data: binaryDataSchema,
  filename: z.string().min(1).max(255),
  mimeType: z.enum([
    // Images
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    // Audio
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/ogg',
    'audio/mp4',
    'audio/x-m4a',
    'audio/flac',
    'audio/aac',
    'audio/webm',
    // Video
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'video/x-msvideo',
    'video/x-matroska',
    // Documents
    'application/pdf'
  ]),
  tags: z.array(z.string().max(50)).max(20).optional(),
  source: z.enum(['quick-capture', 'inline', 'browser-extension', 'api', 'reminder']).optional()
})

export const CaptureVoiceSchema = z.object({
  data: z.instanceof(Buffer),
  duration: z.number().min(0).max(300),
  format: z.enum(['webm', 'mp3', 'wav']),
  transcribe: z.boolean().default(true),
  tags: z.array(z.string().max(50)).max(20).optional(),
  source: z.enum(['quick-capture', 'inline', 'browser-extension', 'api', 'reminder']).optional()
})

export const CaptureClipSchema = z.object({
  html: z.string().max(100000),
  text: z.string().max(50000),
  sourceUrl: z.string().max(2000),
  sourceTitle: z.string().max(200),
  tags: z.array(z.string().max(50)).max(20).optional(),
  source: z.enum(['quick-capture', 'inline', 'browser-extension', 'api', 'reminder']).optional()
})

export const CapturePdfSchema = z.object({
  data: z.instanceof(Buffer),
  filename: z.string().min(1).max(255),
  extractText: z.boolean().default(true),
  tags: z.array(z.string().max(50)).max(20).optional()
})

export const InboxListSchema = z.object({
  type: z.enum(['link', 'note', 'image', 'voice', 'clip', 'pdf', 'social', 'reminder']).optional(),
  includeSnoozed: z.boolean().default(false),
  sortBy: z.enum(['created', 'modified', 'title']).default('created'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0)
})

export const InboxUpdateSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(50000).optional()
})

export const FileItemSchema = z.object({
  itemId: z.string(),
  destination: z.object({
    type: z.enum(['folder', 'note', 'new-note']),
    path: z.string().optional(),
    noteId: z.string().optional(), // Single note (backward compat)
    noteIds: z.array(z.string()).optional(), // Multiple notes
    noteTitle: z.string().max(200).optional()
  }),
  tags: z.array(z.string().max(50)).max(20).optional()
})

export const SnoozeSchema = z.object({
  itemId: z.string(),
  snoozeUntil: z.string(),
  reason: z.string().max(200).optional()
})

export const BulkFileSchema = z.object({
  itemIds: z.array(z.string()).min(1).max(100),
  destination: z.object({
    type: z.enum(['folder', 'note', 'new-note']),
    path: z.string().optional(),
    noteId: z.string().optional()
  }),
  tags: z.array(z.string().max(50)).max(20).optional()
})

export const BulkArchiveSchema = z.object({
  itemIds: z.array(z.string()).min(1).max(100)
})

export const BulkTagSchema = z.object({
  itemIds: z.array(z.string()).min(1).max(100),
  tags: z.array(z.string().max(50)).min(1).max(20)
})

export const MarkViewedSchema = z.object({
  itemId: z.string()
})

// ============================================================================
// Archived Items Schemas
// ============================================================================

export const ListArchivedSchema = z.object({
  search: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0)
})

export const GetFilingHistorySchema = z.object({
  limit: z.number().int().min(1).max(100).default(20)
})

// ============================================================================
// Filing History Types
// ============================================================================

export interface FilingHistoryEntry {
  id: string
  itemId: string
  itemType: InboxItemType
  itemTitle: string
  filedTo: string
  filedAction: FilingAction
  filedAt: Date
  tags: string[]
}

// ============================================================================
// Response Types
// ============================================================================

export interface DuplicateMatch {
  id: string
  title: string
  createdAt: string
}

export interface CaptureResponse {
  success: boolean
  item: InboxItem | null
  error?: string
  duplicate?: boolean
  existingItem?: DuplicateMatch
}

export interface InboxListResponse {
  items: InboxItemListItem[]
  total: number
  hasMore: boolean
}

export interface FileResponse {
  success: boolean
  filedTo: string | null
  noteId?: string
  error?: string
}

export interface BulkResponse {
  success: boolean
  processedCount: number
  errors: Array<{ itemId: string; error: string }>
}

export interface ArchivedListResponse {
  items: InboxItemListItem[]
  total: number
  hasMore: boolean
}

export interface FilingHistoryResponse {
  entries: FilingHistoryEntry[]
}

export interface SuggestionsResponse {
  suggestions: FilingSuggestion[]
}

// ============================================================================
// Handler Signatures
// ============================================================================

export interface InboxHandlers {
  // Capture
  [InboxChannels.invoke.CAPTURE_TEXT]: (
    input: z.infer<typeof CaptureTextSchema>
  ) => Promise<CaptureResponse>
  [InboxChannels.invoke.CAPTURE_LINK]: (
    input: z.infer<typeof CaptureLinkSchema>
  ) => Promise<CaptureResponse>
  [InboxChannels.invoke.CAPTURE_IMAGE]: (
    input: z.infer<typeof CaptureImageSchema>
  ) => Promise<CaptureResponse>
  [InboxChannels.invoke.CAPTURE_VOICE]: (
    input: z.infer<typeof CaptureVoiceSchema>
  ) => Promise<CaptureResponse>
  [InboxChannels.invoke.CAPTURE_CLIP]: (
    input: z.infer<typeof CaptureClipSchema>
  ) => Promise<CaptureResponse>
  [InboxChannels.invoke.CAPTURE_PDF]: (
    input: z.infer<typeof CapturePdfSchema>
  ) => Promise<CaptureResponse>

  // CRUD
  [InboxChannels.invoke.GET]: (id: string) => Promise<InboxItem | null>
  [InboxChannels.invoke.LIST]: (
    input: z.infer<typeof InboxListSchema>
  ) => Promise<InboxListResponse>
  [InboxChannels.invoke.UPDATE]: (
    input: z.infer<typeof InboxUpdateSchema>
  ) => Promise<CaptureResponse>
  [InboxChannels.invoke.ARCHIVE]: (id: string) => Promise<{ success: boolean; error?: string }>

  // Filing
  [InboxChannels.invoke.FILE]: (input: z.infer<typeof FileItemSchema>) => Promise<FileResponse>
  [InboxChannels.invoke.GET_SUGGESTIONS]: (itemId: string) => Promise<SuggestionsResponse>
  [InboxChannels.invoke.CONVERT_TO_NOTE]: (itemId: string) => Promise<FileResponse>
  [InboxChannels.invoke.CONVERT_TO_TASK]: (
    itemId: string
  ) => Promise<{ success: boolean; taskId: string | null; error?: string }>
  [InboxChannels.invoke.LINK_TO_NOTE]: (
    itemId: string,
    noteId: string
  ) => Promise<{ success: boolean; error?: string }>

  // Tags
  [InboxChannels.invoke.ADD_TAG]: (
    itemId: string,
    tag: string
  ) => Promise<{ success: boolean; error?: string }>
  [InboxChannels.invoke.REMOVE_TAG]: (
    itemId: string,
    tag: string
  ) => Promise<{ success: boolean; error?: string }>
  [InboxChannels.invoke.GET_TAGS]: () => Promise<Array<{ tag: string; count: number }>>

  // Snooze
  [InboxChannels.invoke.SNOOZE]: (
    input: z.infer<typeof SnoozeSchema>
  ) => Promise<{ success: boolean; error?: string }>
  [InboxChannels.invoke.UNSNOOZE]: (itemId: string) => Promise<{ success: boolean; error?: string }>
  [InboxChannels.invoke.GET_SNOOZED]: () => Promise<InboxItem[]>

  // Viewed (for reminder items)
  [InboxChannels.invoke.MARK_VIEWED]: (
    itemId: string
  ) => Promise<{ success: boolean; error?: string }>

  // Bulk
  [InboxChannels.invoke.BULK_FILE]: (input: z.infer<typeof BulkFileSchema>) => Promise<BulkResponse>
  [InboxChannels.invoke.BULK_ARCHIVE]: (
    input: z.infer<typeof BulkArchiveSchema>
  ) => Promise<BulkResponse>
  [InboxChannels.invoke.BULK_TAG]: (input: z.infer<typeof BulkTagSchema>) => Promise<BulkResponse>
  [InboxChannels.invoke.FILE_ALL_STALE]: () => Promise<BulkResponse>

  // Transcription
  [InboxChannels.invoke.RETRY_TRANSCRIPTION]: (
    itemId: string
  ) => Promise<{ success: boolean; error?: string }>

  // Stats
  [InboxChannels.invoke.GET_STATS]: () => Promise<InboxStats>
  [InboxChannels.invoke.GET_PATTERNS]: () => Promise<CapturePattern>

  // Settings
  [InboxChannels.invoke.GET_STALE_THRESHOLD]: () => Promise<number>
  [InboxChannels.invoke.SET_STALE_THRESHOLD]: (days: number) => Promise<{ success: boolean }>
}

// ============================================================================
// Event Payloads
// ============================================================================

export interface InboxCapturedEvent {
  item: InboxItemListItem
}

export interface InboxUpdatedEvent {
  id: string
  changes: Partial<InboxItem>
}

export interface InboxArchivedEvent {
  id: string
}

export interface InboxFiledEvent {
  id: string
  filedTo: string
  filedAction: FilingAction
}

export interface InboxSnoozedEvent {
  id: string
  snoozeUntil: Date
}

export interface InboxSnoozeDueEvent {
  items: InboxItemListItem[]
}

export interface InboxTranscriptionCompleteEvent {
  id: string
  transcription: string
}

export interface InboxMetadataCompleteEvent {
  id: string
  metadata: InboxMetadata
}

export interface InboxProcessingErrorEvent {
  id: string
  operation: 'transcription' | 'metadata' | 'pdf' | 'ocr'
  error: string
}

// ============================================================================
// Client API
// ============================================================================

/**
 * Inbox service client interface for renderer process
 *
 * @example
 * ```typescript
 * const inbox = window.api.inbox;
 *
 * // Capture a link
 * const result = await inbox.captureLink({
 *   url: 'https://example.com/article',
 *   tags: ['research']
 * });
 *
 * // List items
 * const { items, total } = await inbox.list({
 *   sortBy: 'created',
 *   limit: 50
 * });
 *
 * // File an item
 * await inbox.file({
 *   itemId: item.id,
 *   destination: { type: 'folder', path: 'Work/Research' },
 *   tags: ['important']
 * });
 *
 * // Listen for new captures
 * window.api.on('inbox:captured', ({ item }) => {
 *   addToList(item);
 * });
 * ```
 */
export interface InboxClientAPI {
  // Capture
  captureText(input: z.infer<typeof CaptureTextSchema>): Promise<CaptureResponse>
  captureLink(input: z.infer<typeof CaptureLinkSchema>): Promise<CaptureResponse>
  captureImage(input: z.infer<typeof CaptureImageSchema>): Promise<CaptureResponse>
  captureVoice(input: z.infer<typeof CaptureVoiceSchema>): Promise<CaptureResponse>
  captureClip(input: z.infer<typeof CaptureClipSchema>): Promise<CaptureResponse>
  capturePdf(input: z.infer<typeof CapturePdfSchema>): Promise<CaptureResponse>

  // CRUD
  get(id: string): Promise<InboxItem | null>
  list(options?: z.infer<typeof InboxListSchema>): Promise<InboxListResponse>
  update(input: z.infer<typeof InboxUpdateSchema>): Promise<CaptureResponse>
  archive(id: string): Promise<{ success: boolean; error?: string }>

  // Filing
  file(input: z.infer<typeof FileItemSchema>): Promise<FileResponse>
  getSuggestions(itemId: string): Promise<SuggestionsResponse>
  convertToNote(itemId: string): Promise<FileResponse>
  convertToTask(
    itemId: string
  ): Promise<{ success: boolean; taskId: string | null; error?: string }>
  linkToNote(itemId: string, noteId: string): Promise<{ success: boolean; error?: string }>

  // Tags
  addTag(itemId: string, tag: string): Promise<{ success: boolean; error?: string }>
  removeTag(itemId: string, tag: string): Promise<{ success: boolean; error?: string }>
  getTags(): Promise<Array<{ tag: string; count: number }>>

  // Snooze
  snooze(input: z.infer<typeof SnoozeSchema>): Promise<{ success: boolean; error?: string }>
  unsnooze(itemId: string): Promise<{ success: boolean; error?: string }>
  getSnoozed(): Promise<InboxItem[]>

  // Viewed (for reminder items)
  markViewed(itemId: string): Promise<{ success: boolean; error?: string }>

  // Bulk
  bulkFile(input: z.infer<typeof BulkFileSchema>): Promise<BulkResponse>
  bulkArchive(input: z.infer<typeof BulkArchiveSchema>): Promise<BulkResponse>
  bulkTag(input: z.infer<typeof BulkTagSchema>): Promise<BulkResponse>
  fileAllStale(): Promise<BulkResponse>

  // Transcription
  retryTranscription(itemId: string): Promise<{ success: boolean; error?: string }>

  // Stats
  getStats(): Promise<InboxStats>
  getPatterns(): Promise<CapturePattern>

  // Settings
  getStaleThreshold(): Promise<number>
  setStaleThreshold(days: number): Promise<{ success: boolean }>

  // Archived items
  listArchived(options?: z.infer<typeof ListArchivedSchema>): Promise<ArchivedListResponse>
  unarchive(id: string): Promise<{ success: boolean; error?: string }>
  deletePermanent(id: string): Promise<{ success: boolean; error?: string }>

  // Filing history
  getFilingHistory(options?: z.infer<typeof GetFilingHistorySchema>): Promise<FilingHistoryResponse>
}
