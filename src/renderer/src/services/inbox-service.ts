/**
 * Inbox Service
 *
 * Thin wrapper around window.api.inbox for the renderer process.
 * Provides typed interface for inbox capture and management operations.
 *
 * @module services/inbox-service
 */

import type {
  InboxItem,
  InboxItemListItem,
  InboxListResponse,
  InboxCaptureResponse as CaptureResponse,
  InboxFileResponse as FileResponse,
  InboxBulkResponse as BulkResponse,
  InboxSuggestionsResponse as SuggestionsResponse,
  InboxStats,
  InboxCapturePattern as CapturePattern
} from '../../../preload/index.d'

// ============================================================================
// Types for service input
// ============================================================================

export interface CaptureTextInput {
  content: string
  title?: string
  tags?: string[]
}

export interface CaptureLinkInput {
  url: string
  tags?: string[]
}

export interface CaptureImageInput {
  data: ArrayBuffer
  filename: string
  mimeType: string
  tags?: string[]
}

export interface CaptureVoiceInput {
  data: ArrayBuffer
  duration: number
  format: string
  transcribe?: boolean
  tags?: string[]
}

export interface CaptureClipInput {
  html: string
  text: string
  sourceUrl: string
  sourceTitle: string
  tags?: string[]
}

export interface CapturePdfInput {
  data: ArrayBuffer
  filename: string
  extractText?: boolean
  tags?: string[]
}

export interface InboxListInput {
  type?: 'link' | 'note' | 'image' | 'voice' | 'clip' | 'pdf' | 'social'
  includeSnoozed?: boolean
  sortBy?: 'created' | 'modified' | 'title'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface InboxUpdateInput {
  id: string
  title?: string
  content?: string
}

export interface FileItemInput {
  itemId: string
  destination: {
    type: 'folder' | 'note' | 'new-note'
    path?: string
    noteId?: string
    noteIds?: string[] // Support multiple notes
    noteTitle?: string
  }
  tags?: string[]
}

export interface SnoozeInput {
  itemId: string
  snoozeUntil: string
  reason?: string
}

export interface BulkFileInput {
  itemIds: string[]
  destination: {
    type: 'folder' | 'note' | 'new-note'
    path?: string
    noteId?: string
  }
  tags?: string[]
}

export interface BulkArchiveInput {
  itemIds: string[]
}

export interface BulkTagInput {
  itemIds: string[]
  tags: string[]
}

// ============================================================================
// Inbox Service
// ============================================================================

export const inboxService = {
  // =========================================================================
  // Capture Operations
  // =========================================================================

  /**
   * Capture text content as a note-type inbox item.
   * @param input - Text capture input
   * @returns Capture response with created item
   */
  captureText: (input: CaptureTextInput): Promise<CaptureResponse> => {
    return window.api.inbox.captureText(input)
  },

  /**
   * Capture a URL as a link-type inbox item.
   * Metadata will be fetched asynchronously.
   * @param input - Link capture input
   * @returns Capture response with created item
   */
  captureLink: (input: CaptureLinkInput): Promise<CaptureResponse> => {
    return window.api.inbox.captureLink(input)
  },

  /**
   * Capture an image as an image-type inbox item.
   * @param input - Image capture input with ArrayBuffer data
   * @returns Capture response with created item
   */
  captureImage: (input: CaptureImageInput): Promise<CaptureResponse> => {
    return window.api.inbox.captureImage(input)
  },

  /**
   * Capture a voice recording as a voice-type inbox item.
   * @param input - Voice capture input with ArrayBuffer data
   * @returns Capture response with created item
   */
  captureVoice: (input: CaptureVoiceInput): Promise<CaptureResponse> => {
    return window.api.inbox.captureVoice(input)
  },

  /**
   * Capture a web clip as a clip-type inbox item.
   * @param input - Clip capture input with HTML and text
   * @returns Capture response with created item
   */
  captureClip: (input: CaptureClipInput): Promise<CaptureResponse> => {
    return window.api.inbox.captureClip(input)
  },

  /**
   * Capture a PDF as a pdf-type inbox item.
   * @param input - PDF capture input with ArrayBuffer data
   * @returns Capture response with created item
   */
  capturePdf: (input: CapturePdfInput): Promise<CaptureResponse> => {
    return window.api.inbox.capturePdf(input)
  },

  // =========================================================================
  // CRUD Operations
  // =========================================================================

  /**
   * Get a single inbox item by ID.
   * @param id - Item ID
   * @returns Full inbox item or null
   */
  get: (id: string): Promise<InboxItem | null> => {
    return window.api.inbox.get(id)
  },

  /**
   * List inbox items with optional filtering.
   * @param options - List options
   * @returns Paginated list of inbox items
   */
  list: (options?: InboxListInput): Promise<InboxListResponse> => {
    return window.api.inbox.list(options)
  },

  /**
   * Update an inbox item.
   * @param input - Update input
   * @returns Updated item
   */
  update: (input: InboxUpdateInput): Promise<CaptureResponse> => {
    return window.api.inbox.update(input)
  },

  /**
   * Archive an inbox item (soft delete).
   * @param id - Item ID
   * @returns Success status
   */
  archive: (id: string): Promise<{ success: boolean; error?: string }> => {
    return window.api.inbox.archive(id)
  },

  // =========================================================================
  // Filing Operations
  // =========================================================================

  /**
   * File an inbox item to a destination.
   * @param input - File input with destination
   * @returns File response
   */
  file: (input: FileItemInput): Promise<FileResponse> => {
    return window.api.inbox.file(input)
  },

  /**
   * Get AI-powered filing suggestions for an item.
   * @param itemId - Item ID
   * @returns Suggestions response
   */
  getSuggestions: (itemId: string): Promise<SuggestionsResponse> => {
    return window.api.inbox.getSuggestions(itemId)
  },

  /**
   * Track whether a suggestion was accepted or rejected.
   * Used to improve future suggestions.
   * @param input - Suggestion tracking input
   * @returns Success status
   */
  trackSuggestion: (input: {
    itemId: string
    itemType: string
    suggestedTo: string
    actualTo: string
    confidence: number
    suggestedTags?: string[]
    actualTags?: string[]
  }): Promise<{ success: boolean; error?: string }> => {
    return window.api.inbox.trackSuggestion(input)
  },

  /**
   * Convert an inbox item directly to a note.
   * @param itemId - Item ID
   * @returns File response with new note ID
   */
  convertToNote: (itemId: string): Promise<FileResponse> => {
    return window.api.inbox.convertToNote(itemId)
  },

  /**
   * Link an inbox item to an existing note.
   * @param itemId - Inbox item ID
   * @param noteId - Target note ID
   * @param tags - Additional tags to add to the created note
   * @returns Success status
   */
  linkToNote: (
    itemId: string,
    noteId: string,
    tags?: string[]
  ): Promise<{ success: boolean; error?: string }> => {
    return window.api.inbox.linkToNote(itemId, noteId, tags)
  },

  // =========================================================================
  // Tag Operations
  // =========================================================================

  /**
   * Add a tag to an inbox item.
   * @param itemId - Item ID
   * @param tag - Tag to add
   * @returns Success status
   */
  addTag: (itemId: string, tag: string): Promise<{ success: boolean; error?: string }> => {
    return window.api.inbox.addTag(itemId, tag)
  },

  /**
   * Remove a tag from an inbox item.
   * @param itemId - Item ID
   * @param tag - Tag to remove
   * @returns Success status
   */
  removeTag: (itemId: string, tag: string): Promise<{ success: boolean; error?: string }> => {
    return window.api.inbox.removeTag(itemId, tag)
  },

  /**
   * Get all tags used in inbox with counts.
   * @returns Array of tags with counts
   */
  getTags: (): Promise<Array<{ tag: string; count: number }>> => {
    return window.api.inbox.getTags()
  },

  // =========================================================================
  // Snooze Operations
  // =========================================================================

  /**
   * Snooze an inbox item until a future date.
   * @param input - Snooze input
   * @returns Success status
   */
  snooze: (input: SnoozeInput): Promise<{ success: boolean; error?: string }> => {
    return window.api.inbox.snooze(input)
  },

  /**
   * Unsnooze an inbox item.
   * @param itemId - Item ID
   * @returns Success status
   */
  unsnooze: (itemId: string): Promise<{ success: boolean; error?: string }> => {
    return window.api.inbox.unsnooze(itemId)
  },

  /**
   * Get all snoozed items.
   * @returns Array of snoozed items
   */
  getSnoozed: (): Promise<InboxItem[]> => {
    return window.api.inbox.getSnoozed()
  },

  // =========================================================================
  // Viewed (for reminder items)
  // =========================================================================

  /**
   * Mark an inbox item as viewed.
   * Used for reminder items when the user opens the target.
   * @param itemId - Item ID to mark as viewed
   * @returns Success status
   */
  markViewed: (itemId: string): Promise<{ success: boolean; error?: string }> => {
    return window.api.inbox.markViewed(itemId)
  },

  // =========================================================================
  // Bulk Operations
  // =========================================================================

  /**
   * File multiple items at once.
   * @param input - Bulk file input
   * @returns Bulk response with results
   */
  bulkFile: (input: BulkFileInput): Promise<BulkResponse> => {
    return window.api.inbox.bulkFile(input)
  },

  /**
   * Archive multiple items at once.
   * @param input - Bulk archive input
   * @returns Bulk response with results
   */
  bulkArchive: (input: BulkArchiveInput): Promise<BulkResponse> => {
    return window.api.inbox.bulkArchive(input)
  },

  /**
   * Add tags to multiple items at once.
   * @param input - Bulk tag input
   * @returns Bulk response with results
   */
  bulkTag: (input: BulkTagInput): Promise<BulkResponse> => {
    return window.api.inbox.bulkTag(input)
  },

  /**
   * File all stale items to a default location.
   * @returns Bulk response with results
   */
  fileAllStale: (): Promise<BulkResponse> => {
    return window.api.inbox.fileAllStale()
  },

  // =========================================================================
  // Transcription
  // =========================================================================

  /**
   * Retry transcription for a voice item.
   * @param itemId - Voice item ID
   * @returns Success status
   */
  retryTranscription: (itemId: string): Promise<{ success: boolean; error?: string }> => {
    return window.api.inbox.retryTranscription(itemId)
  },

  // =========================================================================
  // Metadata
  // =========================================================================

  /**
   * Retry metadata fetch for a link item.
   * @param itemId - Link item ID
   * @returns Success status
   */
  retryMetadata: (itemId: string): Promise<{ success: boolean; error?: string }> => {
    return window.api.inbox.retryMetadata(itemId)
  },

  // =========================================================================
  // Stats & Analytics
  // =========================================================================

  /**
   * Get inbox statistics.
   * @returns Inbox stats
   */
  getStats: (): Promise<InboxStats> => {
    return window.api.inbox.getStats()
  },

  /**
   * Get capture patterns and analytics.
   * @returns Capture patterns data
   */
  getPatterns: (): Promise<CapturePattern> => {
    return window.api.inbox.getPatterns()
  },

  // =========================================================================
  // Settings
  // =========================================================================

  /**
   * Get the current stale threshold in days.
   * @returns Stale threshold in days
   */
  getStaleThreshold: (): Promise<number> => {
    return window.api.inbox.getStaleThreshold()
  },

  /**
   * Set the stale threshold in days.
   * @param days - Number of days
   * @returns Success status
   */
  setStaleThreshold: (days: number): Promise<{ success: boolean }> => {
    return window.api.inbox.setStaleThreshold(days)
  }
}

// ============================================================================
// Event Subscription Helpers
// ============================================================================

/**
 * Subscribe to inbox item captured events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onInboxCaptured(
  callback: (event: { item: InboxItemListItem }) => void
): () => void {
  return window.api.onInboxCaptured(callback as (event: { item: unknown }) => void)
}

/**
 * Subscribe to inbox item updated events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onInboxUpdated(
  callback: (event: { id: string; changes: Partial<InboxItem> }) => void
): () => void {
  return window.api.onInboxUpdated(callback as (event: { id: string; changes: unknown }) => void)
}

/**
 * Subscribe to inbox item archived events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onInboxArchived(callback: (event: { id: string }) => void): () => void {
  return window.api.onInboxArchived(callback)
}

/**
 * Subscribe to inbox item filed events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onInboxFiled(
  callback: (event: { id: string; filedTo: string; filedAction: string }) => void
): () => void {
  return window.api.onInboxFiled(callback)
}

/**
 * Subscribe to inbox item snoozed events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onInboxSnoozed(
  callback: (event: { id: string; snoozeUntil: string }) => void
): () => void {
  return window.api.onInboxSnoozed(callback)
}

/**
 * Subscribe to snooze due events (items becoming active again).
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onInboxSnoozeDue(
  callback: (event: { items: InboxItemListItem[] }) => void
): () => void {
  return window.api.onInboxSnoozeDue(callback as (event: { items: unknown[] }) => void)
}

/**
 * Subscribe to transcription complete events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onInboxTranscriptionComplete(
  callback: (event: { id: string; transcription: string }) => void
): () => void {
  return window.api.onInboxTranscriptionComplete(callback)
}

/**
 * Subscribe to metadata fetch complete events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onInboxMetadataComplete(
  callback: (event: { id: string; metadata: unknown }) => void
): () => void {
  return window.api.onInboxMetadataComplete(callback)
}

/**
 * Subscribe to processing error events.
 * @param callback - Callback function
 * @returns Unsubscribe function
 */
export function onInboxProcessingError(
  callback: (event: { id: string; operation: string; error: string }) => void
): () => void {
  return window.api.onInboxProcessingError(callback)
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get icon name for inbox item type.
 * @param type - Inbox item type
 * @returns Lucide icon name
 */
export function getInboxItemIcon(type: InboxItem['type']): string {
  const icons: Record<InboxItem['type'], string> = {
    link: 'Link',
    note: 'FileText',
    image: 'Image',
    voice: 'Mic',
    clip: 'Scissors',
    pdf: 'FileText',
    social: 'Share2',
    reminder: 'Bell'
  }
  return icons[type] || 'File'
}

/**
 * Get color class for inbox item type.
 * @param type - Inbox item type
 * @returns Tailwind color class
 */
export function getInboxItemColor(type: InboxItem['type']): string {
  const colors: Record<InboxItem['type'], string> = {
    link: 'text-blue-500',
    note: 'text-amber-500',
    image: 'text-purple-500',
    voice: 'text-red-500',
    clip: 'text-green-500',
    pdf: 'text-orange-500',
    social: 'text-cyan-500',
    reminder: 'text-amber-500'
  }
  return colors[type] || 'text-muted-foreground'
}

/**
 * Format relative time for inbox items.
 * @param date - Date to format
 * @returns Relative time string (e.g., "2 hours ago")
 */
export function formatRelativeTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  return d.toLocaleDateString()
}

/**
 * Check if an item is stale based on creation date and threshold.
 * @param createdAt - Creation date
 * @param thresholdDays - Stale threshold in days
 * @returns Whether the item is stale
 */
export function isItemStale(createdAt: Date | string, thresholdDays: number = 7): boolean {
  const d = typeof createdAt === 'string' ? new Date(createdAt) : createdAt
  const now = new Date()
  const diffDays = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24)
  return diffDays > thresholdDays
}
