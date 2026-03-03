/**
 * Inbox IPC API Contract
 *
 * Defines the IPC interface for inbox capture operations.
 * Handles capture, filing, snooze, and bulk operations.
 *
 * @module contracts/inbox-api
 */

import { z } from 'zod'

// ============================================================================
// IPC Channel Constants
// ============================================================================

export const InboxChannels = {
  invoke: {
    // Capture operations
    /** Capture text content */
    CAPTURE_TEXT: 'inbox:capture-text',
    /** Capture a URL with metadata extraction */
    CAPTURE_LINK: 'inbox:capture-link',
    /** Capture an image (from drag-drop or clipboard) */
    CAPTURE_IMAGE: 'inbox:capture-image',
    /** Capture a voice recording */
    CAPTURE_VOICE: 'inbox:capture-voice',
    /** Capture a web clip (selected text from page) */
    CAPTURE_CLIP: 'inbox:capture-clip',
    /** Capture a PDF file */
    CAPTURE_PDF: 'inbox:capture-pdf',

    // CRUD operations
    /** Get a single inbox item by ID */
    GET: 'inbox:get',
    /** List inbox items with filtering */
    LIST: 'inbox:list',
    /** Update an inbox item */
    UPDATE: 'inbox:update',
    /** Delete an inbox item */
    DELETE: 'inbox:delete',

    // Filing operations
    /** File an item to a folder or note */
    FILE: 'inbox:file',
    /** Get filing suggestions for an item */
    GET_SUGGESTIONS: 'inbox:get-suggestions',
    /** Convert an item to a full note */
    CONVERT_TO_NOTE: 'inbox:convert-to-note',
    /** Link an item to an existing note */
    LINK_TO_NOTE: 'inbox:link-to-note',

    // Tag operations
    /** Add tag to item */
    ADD_TAG: 'inbox:add-tag',
    /** Remove tag from item */
    REMOVE_TAG: 'inbox:remove-tag',
    /** Get all tags used in inbox */
    GET_TAGS: 'inbox:get-tags',

    // Snooze operations
    /** Snooze an item */
    SNOOZE: 'inbox:snooze',
    /** Unsnooze an item */
    UNSNOOZE: 'inbox:unsnooze',
    /** Get all snoozed items */
    GET_SNOOZED: 'inbox:get-snoozed',

    // Bulk operations
    /** Bulk file multiple items */
    BULK_FILE: 'inbox:bulk-file',
    /** Bulk delete multiple items */
    BULK_DELETE: 'inbox:bulk-delete',
    /** Bulk tag multiple items */
    BULK_TAG: 'inbox:bulk-tag',
    /** File all stale items to unsorted */
    FILE_ALL_STALE: 'inbox:file-all-stale',

    // Transcription
    /** Retry transcription for a voice item */
    RETRY_TRANSCRIPTION: 'inbox:retry-transcription',

    // Stats
    /** Get inbox statistics */
    GET_STATS: 'inbox:get-stats',
    /** Get capture patterns/insights */
    GET_PATTERNS: 'inbox:get-patterns',

    // Settings
    /** Get stale threshold setting */
    GET_STALE_THRESHOLD: 'inbox:get-stale-threshold',
    /** Set stale threshold setting */
    SET_STALE_THRESHOLD: 'inbox:set-stale-threshold'
  },
  events: {
    /** Item was captured */
    CAPTURED: 'inbox:captured',
    /** Item was updated */
    UPDATED: 'inbox:updated',
    /** Item was deleted */
    DELETED: 'inbox:deleted',
    /** Item was filed */
    FILED: 'inbox:filed',
    /** Item was snoozed */
    SNOOZED: 'inbox:snoozed',
    /** Snoozed item became due */
    SNOOZE_DUE: 'inbox:snooze-due',
    /** Transcription completed */
    TRANSCRIPTION_COMPLETE: 'inbox:transcription-complete',
    /** Metadata fetch completed */
    METADATA_COMPLETE: 'inbox:metadata-complete',
    /** Processing error occurred */
    PROCESSING_ERROR: 'inbox:processing-error'
  }
} as const

export type InboxInvokeChannel = (typeof InboxChannels.invoke)[keyof typeof InboxChannels.invoke]
export type InboxEventChannel = (typeof InboxChannels.events)[keyof typeof InboxChannels.events]

// ============================================================================
// Type Definitions
// ============================================================================

export type InboxItemType = 'link' | 'note' | 'image' | 'voice' | 'clip' | 'pdf' | 'social'
export type ProcessingStatus = 'pending' | 'processing' | 'complete' | 'failed'
export type FilingAction = 'folder' | 'note' | 'linked'

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
  platform: 'twitter' | 'linkedin' | 'mastodon' | 'bluesky' | 'threads' | 'other'
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

export type InboxMetadata =
  | LinkMetadata
  | ImageMetadata
  | VoiceMetadata
  | ClipMetadata
  | PdfMetadata
  | SocialMetadata

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
}

export interface FilingDestination {
  type: 'folder' | 'note' | 'new-note'
  path?: string
  noteId?: string
  noteTitle?: string
}

export interface FilingSuggestion {
  destination: FilingDestination
  confidence: number
  reason: string
  suggestedTags: string[]
}

export interface InboxStats {
  totalItems: number
  itemsByType: Record<InboxItemType, number>
  staleCount: number
  snoozedCount: number
  processedToday: number
  capturedToday: number
  avgTimeToProcess: number // minutes
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
// Request Schemas
// ============================================================================

export const CaptureTextSchema = z.object({
  content: z.string().min(1).max(50000),
  title: z.string().min(1).max(200).optional(),
  tags: z.array(z.string().max(50)).max(20).optional()
})

export const CaptureLinkSchema = z.object({
  url: z.string().url().max(2000),
  tags: z.array(z.string().max(50)).max(20).optional()
})

export const CaptureImageSchema = z.object({
  data: z.instanceof(Buffer),
  filename: z.string().min(1).max(255),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']),
  tags: z.array(z.string().max(50)).max(20).optional()
})

export const CaptureVoiceSchema = z.object({
  data: z.instanceof(Buffer),
  duration: z.number().min(0).max(300),
  format: z.enum(['webm', 'mp3', 'wav']),
  transcribe: z.boolean().default(true),
  tags: z.array(z.string().max(50)).max(20).optional()
})

export const CaptureClipSchema = z.object({
  html: z.string().max(100000),
  text: z.string().max(50000),
  sourceUrl: z.string().url(),
  sourceTitle: z.string().max(200),
  tags: z.array(z.string().max(50)).max(20).optional()
})

export const CapturePdfSchema = z.object({
  data: z.instanceof(Buffer),
  filename: z.string().min(1).max(255),
  extractText: z.boolean().default(true),
  tags: z.array(z.string().max(50)).max(20).optional()
})

export const InboxListSchema = z.object({
  type: z.enum(['link', 'note', 'image', 'voice', 'clip', 'pdf', 'social']).optional(),
  includeFiled: z.boolean().default(false),
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
    noteId: z.string().optional(),
    noteTitle: z.string().max(200).optional()
  }),
  tags: z.array(z.string().max(50)).max(20).optional()
})

export const SnoozeSchema = z.object({
  itemId: z.string(),
  snoozeUntil: z.string().datetime(),
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

export const BulkDeleteSchema = z.object({
  itemIds: z.array(z.string()).min(1).max(100)
})

export const BulkTagSchema = z.object({
  itemIds: z.array(z.string()).min(1).max(100),
  tags: z.array(z.string().max(50)).min(1).max(20)
})

// ============================================================================
// Response Types
// ============================================================================

export interface CaptureResponse {
  success: boolean
  item: InboxItem | null
  error?: string
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
  [InboxChannels.invoke.DELETE]: (id: string) => Promise<{ success: boolean; error?: string }>

  // Filing
  [InboxChannels.invoke.FILE]: (input: z.infer<typeof FileItemSchema>) => Promise<FileResponse>
  [InboxChannels.invoke.GET_SUGGESTIONS]: (itemId: string) => Promise<SuggestionsResponse>
  [InboxChannels.invoke.CONVERT_TO_NOTE]: (itemId: string) => Promise<FileResponse>
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

  // Bulk
  [InboxChannels.invoke.BULK_FILE]: (input: z.infer<typeof BulkFileSchema>) => Promise<BulkResponse>
  [InboxChannels.invoke.BULK_DELETE]: (
    input: z.infer<typeof BulkDeleteSchema>
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

export interface InboxDeletedEvent {
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
  delete(id: string): Promise<{ success: boolean; error?: string }>

  // Filing
  file(input: z.infer<typeof FileItemSchema>): Promise<FileResponse>
  getSuggestions(itemId: string): Promise<SuggestionsResponse>
  convertToNote(itemId: string): Promise<FileResponse>
  linkToNote(itemId: string, noteId: string): Promise<{ success: boolean; error?: string }>

  // Tags
  addTag(itemId: string, tag: string): Promise<{ success: boolean; error?: string }>
  removeTag(itemId: string, tag: string): Promise<{ success: boolean; error?: string }>
  getTags(): Promise<Array<{ tag: string; count: number }>>

  // Snooze
  snooze(input: z.infer<typeof SnoozeSchema>): Promise<{ success: boolean; error?: string }>
  unsnooze(itemId: string): Promise<{ success: boolean; error?: string }>
  getSnoozed(): Promise<InboxItem[]>

  // Bulk
  bulkFile(input: z.infer<typeof BulkFileSchema>): Promise<BulkResponse>
  bulkDelete(input: z.infer<typeof BulkDeleteSchema>): Promise<BulkResponse>
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
}
