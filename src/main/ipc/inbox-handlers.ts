/**
 * Inbox IPC Handlers
 *
 * Handles all inbox-related IPC communication from renderer.
 * Includes capture, filing, snooze, and bulk operations.
 *
 * @module ipc/inbox-handlers
 */

/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument */
// IPC handlers must be async for Electron compatibility, but use synchronous better-sqlite3 operations
// Electron IPC passes untyped arguments that are validated by Zod schemas in each handler

import { ipcMain, BrowserWindow } from 'electron'
import { InboxChannels } from '@shared/ipc-channels'
import {
  CaptureTextSchema,
  CaptureLinkSchema,
  CaptureImageSchema,
  InboxListSchema,
  InboxUpdateSchema,
  BulkArchiveSchema,
  ListArchivedSchema,
  GetFilingHistorySchema,
  type CaptureResponse,
  type InboxListResponse,
  type InboxItem,
  type InboxItemListItem,
  type FileResponse,
  type BulkResponse,
  type SuggestionsResponse,
  type InboxStats,
  type CapturePattern,
  type ImageMetadata,
  type ArchivedListResponse,
  type FilingHistoryResponse,
  type FilingHistoryEntry
} from '@shared/contracts/inbox-api'
import sharp from 'sharp'
import { getDatabase, type DrizzleDb } from '../database'
import { generateId } from '../lib/id'
import { inboxItems, inboxItemTags } from '@shared/db/schema/inbox'
import { eq, desc, asc, and, isNull, sql } from 'drizzle-orm'
import {
  resolveAttachmentUrl,
  getItemAttachmentsDir,
  storeInboxAttachment,
  storeThumbnail,
  deleteInboxAttachments,
  ALLOWED_IMAGE_TYPES,
  ALLOWED_AUDIO_TYPES,
  ALLOWED_VIDEO_TYPES,
  ALLOWED_DOCUMENT_TYPES
} from '../inbox/attachments'
import { fetchUrlMetadata, downloadImage } from '../inbox/metadata'
import {
  fileToFolder,
  convertToNote,
  linkToNote,
  linkToNotes,
  bulkFileToFolder
} from '../inbox/filing'
import {
  extractSocialPost,
  detectSocialPlatform,
  isSocialPost,
  createFallbackSocialMetadata
} from '../inbox/social'
import type { SocialMetadata } from '@shared/contracts/inbox-api'
import { createLogger } from '../lib/logger'
import { captureVoice } from '../inbox/capture'
import { retryTranscription } from '../inbox/transcription'
import { getSuggestions, trackSuggestionFeedback } from '../inbox/suggestions'
import { FileItemSchema, BulkFileSchema, BulkTagSchema } from '@shared/contracts/inbox-api'
import {
  getStaleThreshold as getStaleThresholdDays,
  setStaleThreshold as setStaleThresholdDays,
  isStale as checkIsStale,
  getStaleItemIds,
  countStaleItems,
  incrementArchivedCount,
  incrementProcessedCount,
  getTodayActivity,
  getAverageTimeToProcess
} from '../inbox/stats'
import { snoozeItem, unsnoozeItem, getSnoozedItems, bulkSnoozeItems } from '../inbox/snooze'
import type { SnoozeInput, SnoozedItem } from '../inbox/snooze'
import { getInboxSyncService } from '../sync/inbox-sync'
import { incrementInboxClockOffline } from '../sync/offline-clock'

// ============================================================================
// Constants
// ============================================================================

const logger = createLogger('IPC:Inbox')

function syncInboxCreate(db: DrizzleDb, itemId: string): void {
  const svc = getInboxSyncService()
  if (svc) {
    svc.enqueueCreate(itemId)
  } else {
    incrementInboxClockOffline(db, itemId)
  }
}

function syncInboxUpdate(db: DrizzleDb, itemId: string): void {
  const svc = getInboxSyncService()
  if (svc) {
    svc.enqueueUpdate(itemId)
  } else {
    incrementInboxClockOffline(db, itemId)
  }
}

/** Retry delay for metadata fetch (5 seconds) */
const METADATA_RETRY_DELAY = 5000

// ============================================================================
// Background Metadata Fetch
// ============================================================================

/**
 * Fetch URL metadata in background and update the inbox item
 *
 * @param itemId - The inbox item ID to update
 * @param url - The URL to fetch metadata from
 * @param retryCount - Current retry count (auto-retry once on failure)
 */
async function fetchAndUpdateMetadata(itemId: string, url: string, retryCount = 0): Promise<void> {
  let db: ReturnType<typeof getDatabase>

  try {
    db = requireDatabase()
  } catch {
    logger.warn('No database available, skipping metadata fetch')
    return
  }

  try {
    // Update status to processing
    db.update(inboxItems)
      .set({
        processingStatus: 'processing',
        modifiedAt: new Date().toISOString()
      })
      .where(eq(inboxItems.id, itemId))
      .run()

    // Fetch metadata
    logger.info(`Fetching metadata for ${url}`)
    const metadata = await fetchUrlMetadata(url)
    logger.debug(`Extracted: title="${metadata.title}", hasImage=${!!metadata.image}`)

    // Download image if available
    let thumbnailPath: string | null = null
    if (metadata.image) {
      const attachmentsDir = getItemAttachmentsDir(itemId)
      const imageName = await downloadImage(metadata.image, attachmentsDir)
      if (imageName) {
        // Store relative path from vault root: attachments/inbox/{itemId}/thumbnail.ext
        thumbnailPath = `attachments/inbox/${itemId}/${imageName}`
        logger.debug(`Downloaded thumbnail: ${thumbnailPath}`)
      }
    }

    // Update item with metadata
    const now = new Date().toISOString()
    db.update(inboxItems)
      .set({
        title: metadata.title || url,
        content: metadata.description || null,
        thumbnailPath,
        processingStatus: 'complete',
        processingError: null,
        modifiedAt: now,
        metadata: {
          url,
          fetchStatus: 'complete',
          ...metadata
        }
      })
      .where(eq(inboxItems.id, itemId))
      .run()

    // Emit success event
    emitInboxEvent(InboxChannels.events.METADATA_COMPLETE, {
      id: itemId,
      metadata: {
        title: metadata.title,
        description: metadata.description,
        image: metadata.image,
        thumbnailPath
      }
    })

    logger.info(`Successfully updated item ${itemId}`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    logger.error(`Error fetching metadata for ${url}: ${errorMessage}`)

    // Auto-retry once after delay
    if (retryCount < 1) {
      logger.info(`Scheduling retry for ${itemId} in ${METADATA_RETRY_DELAY}ms`)
      setTimeout(() => {
        fetchAndUpdateMetadata(itemId, url, retryCount + 1).catch((e) => logger.error(e))
      }, METADATA_RETRY_DELAY)
      return
    }

    // Update item with error status
    try {
      db.update(inboxItems)
        .set({
          processingStatus: 'failed',
          processingError: errorMessage,
          modifiedAt: new Date().toISOString(),
          metadata: {
            url,
            fetchStatus: 'failed',
            error: errorMessage
          }
        })
        .where(eq(inboxItems.id, itemId))
        .run()

      // Emit error event
      emitInboxEvent(InboxChannels.events.PROCESSING_ERROR, {
        id: itemId,
        error: errorMessage
      })
    } catch (dbError) {
      logger.error('Failed to update error status:', dbError)
    }
  }
}

// ============================================================================
// Background Social Post Extraction
// ============================================================================

/**
 * Fetch social post metadata in background and update the inbox item
 *
 * Uses platform-specific extractors (oEmbed for Twitter, API for Bluesky, etc.)
 * Falls back to regular metadata extraction if social extraction fails.
 *
 * @param itemId - The inbox item ID to update
 * @param url - The social media post URL
 * @param retryCount - Current retry count (auto-retry once on failure)
 */
async function fetchAndUpdateSocialMetadata(
  itemId: string,
  url: string,
  retryCount = 0
): Promise<void> {
  let db: ReturnType<typeof getDatabase>

  try {
    db = requireDatabase()
  } catch {
    logger.warn('No database available, skipping social metadata fetch')
    return
  }

  const platform = detectSocialPlatform(url)
  logger.info(`Fetching ${platform} metadata for ${url}`)

  try {
    // Update status to processing
    db.update(inboxItems)
      .set({
        processingStatus: 'processing',
        modifiedAt: new Date().toISOString()
      })
      .where(eq(inboxItems.id, itemId))
      .run()

    // Attempt social extraction
    const result = await extractSocialPost(url)

    if (result.success && result.metadata) {
      const metadata = result.metadata

      // Build title from author and platform
      let title = metadata.authorName || metadata.authorHandle || url
      if (metadata.platform !== 'other') {
        const platformName = metadata.platform.charAt(0).toUpperCase() + metadata.platform.slice(1)
        if (metadata.authorHandle) {
          title = `${platformName} post by ${metadata.authorHandle}`
        } else if (metadata.authorName) {
          title = `${platformName} post by ${metadata.authorName}`
        } else {
          title = `${platformName} post`
        }
      }

      // Use post content as description, truncated
      const content = metadata.postContent
        ? metadata.postContent.substring(0, 500) + (metadata.postContent.length > 500 ? '...' : '')
        : null

      // Update item with social metadata
      const now = new Date().toISOString()
      db.update(inboxItems)
        .set({
          title,
          content,
          processingStatus: 'complete',
          processingError: null,
          modifiedAt: now,
          metadata: metadata
        })
        .where(eq(inboxItems.id, itemId))
        .run()

      // Emit success event
      emitInboxEvent(InboxChannels.events.METADATA_COMPLETE, {
        id: itemId,
        metadata
      })

      logger.info(`Successfully updated social item ${itemId}: ${title}`)
    } else {
      // Social extraction failed, try regular metadata as fallback
      logger.info(`Social extraction failed, falling back to regular metadata: ${result.error}`)

      // Try regular metadata extraction
      try {
        const regularMetadata = await fetchUrlMetadata(url)

        // Use regular metadata with social fallback
        const fallbackSocial = createFallbackSocialMetadata(url, platform || 'other', result.error)

        // Merge regular metadata into social metadata
        const mergedMetadata: SocialMetadata = {
          ...fallbackSocial,
          postContent: regularMetadata.description || '',
          extractionStatus: 'partial'
        }

        const now = new Date().toISOString()
        db.update(inboxItems)
          .set({
            title: regularMetadata.title || url,
            content: regularMetadata.description || null,
            processingStatus: 'complete',
            processingError: null,
            modifiedAt: now,
            metadata: mergedMetadata
          })
          .where(eq(inboxItems.id, itemId))
          .run()

        emitInboxEvent(InboxChannels.events.METADATA_COMPLETE, {
          id: itemId,
          metadata: mergedMetadata
        })

        logger.info(`Used fallback metadata for ${itemId}`)
      } catch (fallbackError) {
        throw new Error(
          `Social extraction failed: ${result.error}; Fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown'}`
        )
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    logger.error(`Error fetching social metadata for ${url}: ${errorMessage}`)

    // Auto-retry once after delay
    if (retryCount < 1) {
      logger.info(`Scheduling retry for ${itemId} in ${METADATA_RETRY_DELAY}ms`)
      setTimeout(() => {
        fetchAndUpdateSocialMetadata(itemId, url, retryCount + 1).catch((e) => logger.error(e))
      }, METADATA_RETRY_DELAY)
      return
    }

    // Update item with error status but still store as social type with fallback metadata
    try {
      const fallbackMetadata = createFallbackSocialMetadata(url, platform || 'other', errorMessage)

      db.update(inboxItems)
        .set({
          processingStatus: 'failed',
          processingError: errorMessage,
          modifiedAt: new Date().toISOString(),
          metadata: fallbackMetadata
        })
        .where(eq(inboxItems.id, itemId))
        .run()

      // Emit error event
      emitInboxEvent(InboxChannels.events.PROCESSING_ERROR, {
        id: itemId,
        operation: 'metadata',
        error: errorMessage
      })
    } catch (dbError) {
      logger.error('Failed to update social error status:', dbError)
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Emit inbox event to all windows
 */
function emitInboxEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

/**
 * Get data database, throwing if not available
 */
function requireDatabase(): DrizzleDb {
  try {
    return getDatabase()
  } catch {
    throw new Error('No vault is open. Please open a vault first.')
  }
}

/**
 * Check if an item is stale (older than threshold)
 * Wrapper around the stats module function
 */
function isStale(createdAt: string): boolean {
  return checkIsStale(createdAt)
}

/**
 * Get tags for an inbox item
 */
function getItemTags(db: ReturnType<typeof getDatabase>, itemId: string): string[] {
  const tags = db.select().from(inboxItemTags).where(eq(inboxItemTags.itemId, itemId)).all()
  return tags.map((t) => t.tag)
}

/**
 * Convert database row to InboxItem with computed fields
 */
function toInboxItem(row: typeof inboxItems.$inferSelect, tags: string[]): InboxItem {
  return {
    id: row.id,
    type: row.type as InboxItem['type'],
    title: row.title,
    content: row.content,
    createdAt: new Date(row.createdAt),
    modifiedAt: new Date(row.modifiedAt),
    filedAt: row.filedAt ? new Date(row.filedAt) : null,
    filedTo: row.filedTo,
    filedAction: row.filedAction as InboxItem['filedAction'],
    snoozedUntil: row.snoozedUntil ? new Date(row.snoozedUntil) : null,
    snoozeReason: row.snoozeReason,
    viewedAt: row.viewedAt ? new Date(row.viewedAt) : null,
    archivedAt: row.archivedAt ? new Date(row.archivedAt) : null,
    processingStatus: (row.processingStatus || 'complete') as InboxItem['processingStatus'],
    processingError: row.processingError,
    metadata: row.metadata as InboxItem['metadata'],
    attachmentPath: row.attachmentPath,
    attachmentUrl: resolveAttachmentUrl(row.attachmentPath),
    thumbnailPath: row.thumbnailPath,
    thumbnailUrl: resolveAttachmentUrl(row.thumbnailPath),
    transcription: row.transcription,
    transcriptionStatus: row.transcriptionStatus as InboxItem['transcriptionStatus'],
    sourceUrl: row.sourceUrl,
    sourceTitle: row.sourceTitle,
    tags,
    isStale: isStale(row.createdAt)
  }
}

/**
 * Convert database row to list item (lighter weight)
 */
function toListItem(row: typeof inboxItems.$inferSelect, tags: string[]): InboxItemListItem {
  const metadata = row.metadata as Record<string, unknown> | null
  const isReminder = row.type === 'reminder'

  return {
    id: row.id,
    type: row.type as InboxItemListItem['type'],
    title: row.title,
    content: row.content,
    createdAt: new Date(row.createdAt),
    thumbnailUrl: resolveAttachmentUrl(row.thumbnailPath),
    sourceUrl: row.sourceUrl,
    tags,
    isStale: isStale(row.createdAt),
    processingStatus: (row.processingStatus || 'complete') as InboxItemListItem['processingStatus'],
    // Type-specific fields
    duration: metadata?.duration as number | undefined,
    excerpt: metadata?.excerpt as string | undefined,
    pageCount: metadata?.pageCount as number | undefined,
    // Voice transcription fields
    transcription: row.transcription,
    transcriptionStatus: row.transcriptionStatus as InboxItemListItem['transcriptionStatus'],
    // Snooze fields
    snoozedUntil: row.snoozedUntil ? new Date(row.snoozedUntil) : undefined,
    snoozeReason: row.snoozeReason ?? undefined,
    // Viewed field (for reminder items)
    viewedAt: row.viewedAt ? new Date(row.viewedAt) : undefined,
    // Metadata (for reminder items - includes target info)
    metadata: isReminder ? (metadata as unknown as InboxItemListItem['metadata']) : undefined
  }
}

// ============================================================================
// Handler Implementations
// ============================================================================

/**
 * Capture text content
 */
async function handleCaptureText(input: unknown): Promise<CaptureResponse> {
  try {
    const parsed = CaptureTextSchema.parse(input)
    const db = requireDatabase()

    const id = generateId()
    const now = new Date().toISOString()

    // Insert inbox item
    db.insert(inboxItems)
      .values({
        id,
        type: 'note',
        title:
          parsed.title ||
          parsed.content.substring(0, 50) + (parsed.content.length > 50 ? '...' : ''),
        content: parsed.content,
        createdAt: now,
        modifiedAt: now,
        processingStatus: 'complete'
      })
      .run()

    // Insert tags if provided
    if (parsed.tags && parsed.tags.length > 0) {
      for (const tag of parsed.tags) {
        db.insert(inboxItemTags)
          .values({
            id: generateId(),
            itemId: id,
            tag,
            createdAt: now
          })
          .run()
      }
    }

    // Fetch the created item
    const created = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
    if (!created) {
      return { success: false, item: null, error: 'Failed to create item' }
    }

    const tags = getItemTags(db, id)
    const item = toInboxItem(created, tags)

    emitInboxEvent(InboxChannels.events.CAPTURED, { item: toListItem(created, tags) })
    syncInboxCreate(db, id)

    return { success: true, item }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, item: null, error: message }
  }
}

/**
 * Capture a URL with background metadata extraction
 *
 * Automatically detects social media posts (Twitter, Bluesky, Mastodon, etc.)
 * and uses specialized extraction for richer metadata display.
 */
async function handleCaptureLink(input: unknown): Promise<CaptureResponse> {
  try {
    const parsed = CaptureLinkSchema.parse(input)
    const db = requireDatabase()

    const id = generateId()
    const now = new Date().toISOString()

    // Detect if this is a social media post
    const platform = detectSocialPlatform(parsed.url)
    const isSocial = platform !== null && isSocialPost(parsed.url)
    const itemType = isSocial ? 'social' : 'link'

    logger.info(`URL detected as ${itemType}${platform ? ` (${platform})` : ''}: ${parsed.url}`)

    // Create item with pending status
    // For social posts, we set type to 'social' for specialized UI handling
    db.insert(inboxItems)
      .values({
        id,
        type: itemType,
        title: parsed.url, // Will be updated when metadata is fetched
        content: null,
        sourceUrl: parsed.url,
        createdAt: now,
        modifiedAt: now,
        processingStatus: 'pending', // Metadata fetch is pending
        metadata: isSocial
          ? {
              platform: platform || 'other',
              postUrl: parsed.url,
              authorName: '',
              authorHandle: '',
              postContent: '',
              mediaUrls: [],
              extractionStatus: 'pending' as const
            }
          : {
              url: parsed.url,
              fetchStatus: 'pending'
            }
      })
      .run()

    // Insert tags if provided
    if (parsed.tags && parsed.tags.length > 0) {
      for (const tag of parsed.tags) {
        db.insert(inboxItemTags)
          .values({
            id: generateId(),
            itemId: id,
            tag,
            createdAt: now
          })
          .run()
      }
    }

    const created = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
    if (!created) {
      return { success: false, item: null, error: 'Failed to create item' }
    }

    const tags = getItemTags(db, id)
    const item = toInboxItem(created, tags)

    emitInboxEvent(InboxChannels.events.CAPTURED, { item: toListItem(created, tags) })
    syncInboxCreate(db, id)

    // Trigger background metadata fetch (don't await - non-blocking)
    // Use specialized social extraction for social posts
    setImmediate(() => {
      if (isSocial) {
        fetchAndUpdateSocialMetadata(id, parsed.url).catch((err) => {
          logger.error('Background social metadata fetch error:', err)
        })
      } else {
        fetchAndUpdateMetadata(id, parsed.url).catch((err) => {
          logger.error('Background metadata fetch error:', err)
        })
      }
    })

    return { success: true, item }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, item: null, error: message }
  }
}

/**
 * Get a single inbox item by ID
 */
async function handleGet(id: string): Promise<InboxItem | null> {
  const db = requireDatabase()
  const row = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()

  if (!row) return null

  const tags = getItemTags(db, id)
  return toInboxItem(row, tags)
}

/**
 * List inbox items with filtering
 */
async function handleList(input: unknown): Promise<InboxListResponse> {
  const options = InboxListSchema.parse(input || {})
  const db = requireDatabase()

  // Build conditions
  const conditions: ReturnType<typeof eq>[] = []

  // Filter by type
  if (options.type) {
    conditions.push(eq(inboxItems.type, options.type))
  }

  // Always exclude filed items (filed items are no longer in the inbox)
  conditions.push(isNull(inboxItems.filedAt))

  // Exclude snoozed items unless requested
  if (!options.includeSnoozed) {
    conditions.push(isNull(inboxItems.snoozedUntil))
  }

  // Always exclude archived items
  conditions.push(isNull(inboxItems.archivedAt))

  // Build query
  let query = db.select().from(inboxItems)

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query
  }

  // Sort
  const sortColumn =
    options.sortBy === 'modified'
      ? inboxItems.modifiedAt
      : options.sortBy === 'title'
        ? inboxItems.title
        : inboxItems.createdAt

  query = query.orderBy(
    options.sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn)
  ) as typeof query

  // Count total
  const countResult = db
    .select({ count: sql<number>`count(*)` })
    .from(inboxItems)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .get()
  const total = countResult?.count || 0

  // Pagination
  query = query.limit(options.limit).offset(options.offset) as typeof query

  const rows = query.all()

  // Convert to list items with tags
  const items: InboxItemListItem[] = rows.map((row) => {
    const tags = getItemTags(db, row.id)
    return toListItem(row, tags)
  })

  return {
    items,
    total,
    hasMore: options.offset + items.length < total
  }
}

/**
 * Update an inbox item
 */
async function handleUpdate(input: unknown): Promise<CaptureResponse> {
  try {
    const parsed = InboxUpdateSchema.parse(input)
    const db = requireDatabase()

    const existing = db.select().from(inboxItems).where(eq(inboxItems.id, parsed.id)).get()
    if (!existing) {
      return { success: false, item: null, error: 'Item not found' }
    }

    const updates: Partial<typeof inboxItems.$inferInsert> = {
      modifiedAt: new Date().toISOString()
    }

    if (parsed.title !== undefined) updates.title = parsed.title
    if (parsed.content !== undefined) updates.content = parsed.content

    db.update(inboxItems).set(updates).where(eq(inboxItems.id, parsed.id)).run()

    const updated = db.select().from(inboxItems).where(eq(inboxItems.id, parsed.id)).get()
    if (!updated) {
      return { success: false, item: null, error: 'Failed to update item' }
    }

    const tags = getItemTags(db, parsed.id)
    const item = toInboxItem(updated, tags)

    emitInboxEvent(InboxChannels.events.UPDATED, { id: parsed.id, changes: updates })
    syncInboxUpdate(db, parsed.id)

    return { success: true, item }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, item: null, error: message }
  }
}

/**
 * Archive an inbox item (soft delete)
 */
async function handleArchive(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    const db = requireDatabase()

    const existing = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
    if (!existing) {
      return { success: false, error: 'Item not found' }
    }

    // Set archivedAt timestamp (soft delete - keep attachments and tags)
    db.update(inboxItems)
      .set({ archivedAt: new Date().toISOString() })
      .where(eq(inboxItems.id, id))
      .run()

    // Update stats
    incrementArchivedCount()

    emitInboxEvent(InboxChannels.events.ARCHIVED, { id })
    syncInboxUpdate(db, id)

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
}

/**
 * Add tag to an item
 */
async function handleAddTag(
  itemId: string,
  tag: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const db = requireDatabase()

    // Check item exists
    const existing = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
    if (!existing) {
      return { success: false, error: 'Item not found' }
    }

    // Check if tag already exists
    const existingTag = db
      .select()
      .from(inboxItemTags)
      .where(and(eq(inboxItemTags.itemId, itemId), eq(inboxItemTags.tag, tag)))
      .get()

    if (existingTag) {
      return { success: true } // Already exists, not an error
    }

    // Add tag
    db.insert(inboxItemTags)
      .values({
        id: generateId(),
        itemId,
        tag,
        createdAt: new Date().toISOString()
      })
      .run()

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
}

/**
 * Remove tag from an item
 */
async function handleRemoveTag(
  itemId: string,
  tag: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const db = requireDatabase()

    db.delete(inboxItemTags)
      .where(and(eq(inboxItemTags.itemId, itemId), eq(inboxItemTags.tag, tag)))
      .run()

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
}

/**
 * Get all tags used in inbox
 */
async function handleGetTags(): Promise<Array<{ tag: string; count: number }>> {
  const db = requireDatabase()

  const result = db
    .select({
      tag: inboxItemTags.tag,
      count: sql<number>`count(*)`
    })
    .from(inboxItemTags)
    .groupBy(inboxItemTags.tag)
    .orderBy(desc(sql`count(*)`))
    .all()

  return result
}

/**
 * Bulk archive items
 */
async function handleBulkArchive(input: unknown): Promise<BulkResponse> {
  const parsed = BulkArchiveSchema.parse(input)
  const errors: Array<{ itemId: string; error: string }> = []
  let processedCount = 0

  for (const itemId of parsed.itemIds) {
    const result = await handleArchive(itemId)
    if (result.success) {
      processedCount++
    } else {
      errors.push({ itemId, error: result.error || 'Unknown error' })
    }
  }

  return {
    success: errors.length === 0,
    processedCount,
    errors
  }
}

/**
 * Get inbox statistics
 */
async function handleGetStats(): Promise<InboxStats> {
  const db = requireDatabase()

  // Total items (not filed, not snoozed, not archived)
  const totalResult = db
    .select({ count: sql<number>`count(*)` })
    .from(inboxItems)
    .where(
      and(
        isNull(inboxItems.filedAt),
        isNull(inboxItems.snoozedUntil),
        isNull(inboxItems.archivedAt)
      )
    )
    .get()

  // Items by type
  const typeResult = db
    .select({
      type: inboxItems.type,
      count: sql<number>`count(*)`
    })
    .from(inboxItems)
    .where(
      and(
        isNull(inboxItems.filedAt),
        isNull(inboxItems.snoozedUntil),
        isNull(inboxItems.archivedAt)
      )
    )
    .groupBy(inboxItems.type)
    .all()

  const itemsByType: Record<string, number> = {
    link: 0,
    note: 0,
    image: 0,
    voice: 0,
    clip: 0,
    pdf: 0,
    social: 0
  }

  for (const row of typeResult) {
    itemsByType[row.type] = row.count
  }

  // Stale count - use stats module
  const staleCount = countStaleItems()

  // Snoozed count (exclude archived)
  const snoozedResult = db
    .select({ count: sql<number>`count(*)` })
    .from(inboxItems)
    .where(and(sql`${inboxItems.snoozedUntil} IS NOT NULL`, isNull(inboxItems.archivedAt)))
    .get()

  // Get today's activity from stats module
  const { capturedToday, processedToday } = getTodayActivity()
  const avgTimeToProcess = getAverageTimeToProcess()

  return {
    totalItems: totalResult?.count || 0,
    itemsByType: itemsByType as InboxStats['itemsByType'],
    staleCount,
    snoozedCount: snoozedResult?.count || 0,
    processedToday,
    capturedToday,
    avgTimeToProcess
  }
}

/**
 * Get stale threshold
 */
async function handleGetStaleThreshold(): Promise<number> {
  return getStaleThresholdDays()
}

/**
 * Set stale threshold
 */
async function handleSetStaleThreshold(days: number): Promise<{ success: boolean }> {
  setStaleThresholdDays(days)
  return { success: true }
}

// ============================================================================
// Stub Handlers (To be implemented in later phases)
// ============================================================================

/**
 * Determine inbox item type from MIME type
 */
function getInboxTypeFromMime(mimeType: string): 'image' | 'voice' | 'video' | 'pdf' {
  if (ALLOWED_IMAGE_TYPES.includes(mimeType)) return 'image'
  if (ALLOWED_AUDIO_TYPES.includes(mimeType)) return 'voice'
  if (ALLOWED_VIDEO_TYPES.includes(mimeType)) return 'video'
  if (ALLOWED_DOCUMENT_TYPES.includes(mimeType)) return 'pdf'
  return 'image' // fallback
}

/**
 * Capture an attachment (image, audio, video, or PDF)
 *
 * For images: validates format, extracts metadata, generates thumbnail
 * For audio/video/PDF: stores file directly without image processing
 */
async function handleCaptureImage(input: unknown): Promise<CaptureResponse> {
  try {
    const parsed = CaptureImageSchema.parse(input)
    const db = requireDatabase()

    const id = generateId()
    const now = new Date().toISOString()

    // Determine file type from MIME
    const inboxType = getInboxTypeFromMime(parsed.mimeType)
    const isImage = ALLOWED_IMAGE_TYPES.includes(parsed.mimeType)

    // Convert data to Buffer
    // IPC serialization may convert Buffer/ArrayBuffer to Uint8Array or plain object with numeric keys
    let fileBuffer: Buffer
    if (Buffer.isBuffer(parsed.data)) {
      fileBuffer = parsed.data
    } else if (parsed.data instanceof Uint8Array) {
      fileBuffer = Buffer.from(parsed.data)
    } else if (parsed.data instanceof ArrayBuffer) {
      fileBuffer = Buffer.from(parsed.data)
    } else if (typeof parsed.data === 'object' && parsed.data !== null) {
      // Handle plain object from IPC serialization (has numeric keys like {0: 255, 1: 216, ...})
      // Check if it looks like a serialized buffer (has 'type' and 'data' properties from Buffer.toJSON())
      const data = parsed.data as Record<string, unknown>
      if (data.type === 'Buffer' && Array.isArray(data.data)) {
        // Electron serializes Buffer as {type: 'Buffer', data: [bytes...]}
        fileBuffer = Buffer.from(data.data as number[])
      } else {
        // Plain object with numeric keys
        const values = Object.values(data).filter((v): v is number => typeof v === 'number')
        if (values.length === 0) {
          return {
            success: false,
            item: null,
            error: 'Invalid file data format: empty or non-numeric data'
          }
        }
        fileBuffer = Buffer.from(values)
      }
    } else {
      return {
        success: false,
        item: null,
        error: 'Invalid file data format'
      }
    }

    // Validate we have actual data
    if (fileBuffer.length === 0) {
      return {
        success: false,
        item: null,
        error: 'Empty file data'
      }
    }

    // Store the file
    const storeResult = await storeInboxAttachment(id, fileBuffer, parsed.filename, parsed.mimeType)

    if (!storeResult.success) {
      return {
        success: false,
        item: null,
        error: storeResult.error || 'Failed to store file'
      }
    }

    let thumbnailPath: string | null = null
    let itemMetadata: Record<string, unknown> = {
      originalFilename: parsed.filename,
      fileSize: fileBuffer.length,
      mimeType: parsed.mimeType
    }

    // For images: extract metadata and generate thumbnail
    if (isImage) {
      try {
        const metadata = await sharp(fileBuffer).metadata()

        if (metadata.width && metadata.height) {
          // Build image metadata
          const imageMetadata: ImageMetadata = {
            originalFilename: parsed.filename,
            format: metadata.format || 'unknown',
            width: metadata.width,
            height: metadata.height,
            fileSize: fileBuffer.length,
            hasExif: !!(metadata.exif || metadata.icc)
          }
          itemMetadata = imageMetadata as unknown as Record<string, unknown>

          // Generate thumbnail (max 400x400, JPEG for smaller size)
          try {
            const thumbnailBuffer = await sharp(fileBuffer)
              .resize(400, 400, {
                fit: 'inside',
                withoutEnlargement: true
              })
              .jpeg({ quality: 80 })
              .toBuffer()

            const thumbnailResult = await storeThumbnail(id, thumbnailBuffer, 'jpg')
            if (thumbnailResult.success && thumbnailResult.thumbnailPath) {
              thumbnailPath = thumbnailResult.thumbnailPath
            }
          } catch (err) {
            // Thumbnail generation failed - not fatal, continue without thumbnail
            logger.warn('Failed to generate thumbnail:', err)
          }
        }
      } catch (err) {
        // Image metadata extraction failed - not fatal for storage
        logger.warn('Failed to read image metadata:', err)
      }
    }

    // Insert inbox item
    db.insert(inboxItems)
      .values({
        id,
        type: inboxType,
        title: parsed.filename.replace(/\.[^.]+$/, ''), // Remove extension for title
        content: null,
        createdAt: now,
        modifiedAt: now,
        processingStatus: 'complete',
        attachmentPath: storeResult.path || null,
        thumbnailPath,
        metadata: itemMetadata
      })
      .run()

    // Insert tags if provided
    if (parsed.tags && parsed.tags.length > 0) {
      for (const tag of parsed.tags) {
        db.insert(inboxItemTags)
          .values({
            id: generateId(),
            itemId: id,
            tag,
            createdAt: now
          })
          .run()
      }
    }

    // Fetch the created item
    const created = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
    if (!created) {
      return { success: false, item: null, error: 'Failed to create item' }
    }

    const tags = getItemTags(db, id)
    const item = toInboxItem(created, tags)

    emitInboxEvent(InboxChannels.events.CAPTURED, { item: toListItem(created, tags) })
    syncInboxCreate(db, id)

    logger.info(`Captured ${inboxType}: ${parsed.filename} (${fileBuffer.length} bytes)`)

    return { success: true, item }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    logger.error('Attachment capture failed:', message)
    return { success: false, item: null, error: message }
  }
}

/**
 * Capture a voice memo
 *
 * Handles voice recording capture with optional transcription.
 * Audio is stored in vault/attachments/inbox/{itemId}/ and
 * transcription is triggered asynchronously via OpenAI Whisper.
 */
async function handleCaptureVoice(input: unknown): Promise<CaptureResponse> {
  try {
    // Input must be an object with data property
    if (!input || typeof input !== 'object') {
      return { success: false, item: null, error: 'Invalid voice capture input' }
    }

    const rawInput = input as Record<string, unknown>

    // Convert data to Buffer - IPC serialization may convert Buffer/ArrayBuffer
    // to Uint8Array or plain object with numeric keys
    let audioBuffer: Buffer
    const rawData = rawInput.data

    if (Buffer.isBuffer(rawData)) {
      audioBuffer = rawData
    } else if (rawData instanceof Uint8Array) {
      audioBuffer = Buffer.from(rawData)
    } else if (rawData instanceof ArrayBuffer) {
      audioBuffer = Buffer.from(rawData)
    } else if (typeof rawData === 'object' && rawData !== null) {
      // Handle plain object from IPC serialization
      const data = rawData as Record<string, unknown>
      if (data.type === 'Buffer' && Array.isArray(data.data)) {
        // Electron serializes Buffer as {type: 'Buffer', data: [bytes...]}
        audioBuffer = Buffer.from(data.data as number[])
      } else {
        // Plain object with numeric keys
        const values = Object.values(data).filter((v): v is number => typeof v === 'number')
        if (values.length === 0) {
          return {
            success: false,
            item: null,
            error: 'Invalid audio data format: empty or non-numeric data'
          }
        }
        audioBuffer = Buffer.from(values)
      }
    } else {
      return { success: false, item: null, error: 'Invalid audio data format' }
    }

    // Validate we have actual audio data
    if (audioBuffer.length === 0) {
      return { success: false, item: null, error: 'Empty audio data' }
    }

    // Call captureVoice with converted Buffer
    return await captureVoice({
      data: audioBuffer,
      duration: rawInput.duration as number,
      format: rawInput.format as 'webm' | 'mp3' | 'wav',
      transcribe: rawInput.transcribe as boolean | undefined,
      tags: rawInput.tags as string[] | undefined
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    logger.error('Voice capture failed:', message)
    return { success: false, item: null, error: message }
  }
}

async function stubCaptureClip(): Promise<CaptureResponse> {
  return { success: false, item: null, error: 'Not implemented yet' }
}

async function stubCapturePdf(): Promise<CaptureResponse> {
  return { success: false, item: null, error: 'Not implemented yet' }
}

/**
 * File an inbox item to a destination (folder, new note, or existing note(s))
 */
async function handleFile(input: unknown): Promise<FileResponse> {
  try {
    const parsed = FileItemSchema.parse(input)
    const { itemId, destination, tags } = parsed

    switch (destination.type) {
      case 'folder':
        return fileToFolder(itemId, destination.path || '', tags)
      case 'new-note':
        return convertToNote(itemId)
      case 'note': {
        // Support both single noteId and multiple noteIds
        const noteIds = destination.noteIds?.length
          ? destination.noteIds
          : destination.noteId
            ? [destination.noteId]
            : []

        if (noteIds.length === 0) {
          return {
            success: false,
            filedTo: null,
            error: 'At least one note ID required for linking'
          }
        }

        // Pass folder path so the inbox note is created in the selected folder
        const result = await linkToNotes(itemId, noteIds, tags, destination.path)
        return {
          success: result.success,
          filedTo: noteIds[0],
          noteId: noteIds[0],
          error: result.error
        }
      }
      default:
        return { success: false, filedTo: null, error: 'Invalid destination type' }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, filedTo: null, error: message }
  }
}

/**
 * Get AI-powered filing suggestions for an inbox item
 */
async function handleGetSuggestions(itemId: string): Promise<SuggestionsResponse> {
  try {
    const suggestions = await getSuggestions(itemId)
    return { suggestions }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    logger.error('Failed to get suggestions:', message)
    return { suggestions: [] } // Empty fallback on error
  }
}

/**
 * Track suggestion feedback (accepted/rejected)
 */
async function handleTrackSuggestion(
  itemId: string,
  itemType: string,
  suggestedTo: string,
  actualTo: string,
  confidence: number,
  suggestedTags: string[] = [],
  actualTags: string[] = []
): Promise<{ success: boolean; error?: string }> {
  try {
    trackSuggestionFeedback(
      itemId,
      itemType,
      suggestedTo,
      actualTo,
      confidence,
      suggestedTags,
      actualTags
    )
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    logger.error('Failed to track feedback:', message)
    return { success: false, error: message }
  }
}

/**
 * Convert an inbox item to a standalone note
 */
async function handleConvertToNote(itemId: string): Promise<FileResponse> {
  return convertToNote(itemId)
}

/**
 * Link an inbox item to an existing note
 */
async function handleLinkToNote(
  itemId: string,
  noteId: string,
  tags: string[] = []
): Promise<{ success: boolean; error?: string }> {
  return linkToNote(itemId, noteId, tags)
}

/**
 * Snooze an inbox item until a specified time
 */
async function handleSnooze(input: unknown): Promise<{ success: boolean; error?: string }> {
  try {
    if (!input || typeof input !== 'object') {
      return { success: false, error: 'Invalid snooze input' }
    }

    const snoozeInput = input as SnoozeInput
    if (!snoozeInput.itemId || !snoozeInput.snoozeUntil) {
      return { success: false, error: 'itemId and snoozeUntil are required' }
    }

    const result = snoozeItem(snoozeInput)
    return { success: result.success, error: result.error }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
}

/**
 * Unsnooze an inbox item immediately
 */
async function handleUnsnooze(itemId: string): Promise<{ success: boolean; error?: string }> {
  try {
    if (!itemId) {
      return { success: false, error: 'itemId is required' }
    }

    const result = unsnoozeItem(itemId)
    return { success: result.success, error: result.error }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
}

/**
 * Mark an inbox item as viewed (for reminder items)
 */
async function handleMarkViewed(itemId: string): Promise<{ success: boolean; error?: string }> {
  try {
    if (!itemId) {
      return { success: false, error: 'itemId is required' }
    }

    const db = requireDatabase()
    const now = new Date().toISOString()

    // Update the viewedAt field
    db.update(inboxItems)
      .set({
        viewedAt: now,
        modifiedAt: now
      })
      .where(eq(inboxItems.id, itemId))
      .run()

    emitInboxEvent(InboxChannels.events.UPDATED, {
      id: itemId,
      changes: { viewedAt: now }
    })
    syncInboxUpdate(db, itemId)

    logger.info(`Marked item ${itemId} as viewed`)
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    logger.error(`Failed to mark item ${itemId} as viewed: ${message}`)
    return { success: false, error: message }
  }
}

/**
 * Get all snoozed items
 */
async function handleGetSnoozed(): Promise<SnoozedItem[]> {
  try {
    return getSnoozedItems()
  } catch (error) {
    logger.error('Error getting snoozed items:', error)
    return []
  }
}

/**
 * Bulk snooze multiple items
 */
async function handleBulkSnooze(input: unknown): Promise<{
  success: boolean
  processedCount: number
  errors: Array<{ itemId: string; error: string }>
}> {
  try {
    if (!input || typeof input !== 'object') {
      return { success: false, processedCount: 0, errors: [{ itemId: '', error: 'Invalid input' }] }
    }

    const { itemIds, snoozeUntil, reason } = input as {
      itemIds: string[]
      snoozeUntil: string
      reason?: string
    }

    if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
      return {
        success: false,
        processedCount: 0,
        errors: [{ itemId: '', error: 'itemIds array is required' }]
      }
    }

    if (!snoozeUntil) {
      return {
        success: false,
        processedCount: 0,
        errors: [{ itemId: '', error: 'snoozeUntil is required' }]
      }
    }

    return bulkSnoozeItems(itemIds, snoozeUntil, reason)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, processedCount: 0, errors: [{ itemId: '', error: message }] }
  }
}

/**
 * Bulk file multiple items to a folder
 */
async function handleBulkFile(input: unknown): Promise<BulkResponse> {
  try {
    const parsed = BulkFileSchema.parse(input)
    const { itemIds, destination, tags } = parsed

    if (destination.type !== 'folder') {
      return {
        success: false,
        processedCount: 0,
        errors: [{ itemId: '', error: 'Bulk filing only supports folder destination' }]
      }
    }

    return bulkFileToFolder(itemIds, destination.path || '', tags)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      success: false,
      processedCount: 0,
      errors: [{ itemId: '', error: message }]
    }
  }
}

/**
 * Bulk add tags to multiple items
 */
async function handleBulkTag(input: unknown): Promise<BulkResponse> {
  try {
    const parsed = BulkTagSchema.parse(input)
    const { itemIds, tags } = parsed
    const db = requireDatabase()

    let processedCount = 0
    const errors: Array<{ itemId: string; error: string }> = []

    for (const itemId of itemIds) {
      try {
        // Check if item exists
        const item = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
        if (!item) {
          errors.push({ itemId, error: 'Item not found' })
          continue
        }

        // Add each tag (skip if already exists)
        for (const tag of tags) {
          const normalizedTag = tag.trim().toLowerCase()
          if (!normalizedTag) continue

          const existing = db
            .select()
            .from(inboxItemTags)
            .where(and(eq(inboxItemTags.itemId, itemId), eq(inboxItemTags.tag, normalizedTag)))
            .get()

          if (!existing) {
            db.insert(inboxItemTags)
              .values({
                id: generateId(),
                itemId,
                tag: normalizedTag
              })
              .run()
          }
        }
        processedCount++
      } catch (error) {
        errors.push({
          itemId,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }

    // Emit update events for each item
    for (const itemId of itemIds) {
      emitInboxEvent(InboxChannels.events.UPDATED, { id: itemId, changes: { tags } })
    }

    return {
      success: errors.length === 0,
      processedCount,
      errors
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      success: false,
      processedCount: 0,
      errors: [{ itemId: '', error: message }]
    }
  }
}

/**
 * File all stale items to Unsorted folder
 */
async function handleFileAllStale(): Promise<BulkResponse> {
  try {
    const staleIds = getStaleItemIds()

    if (staleIds.length === 0) {
      return {
        success: true,
        processedCount: 0,
        errors: []
      }
    }

    // Use bulk file to folder (Unsorted)
    const result = await bulkFileToFolder(staleIds, 'Unsorted', [])

    // Update stats for processed items
    if (result.processedCount > 0) {
      incrementProcessedCount(result.processedCount)
    }

    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      success: false,
      processedCount: 0,
      errors: [{ itemId: '', error: message }]
    }
  }
}

/**
 * Retry transcription for a failed voice memo
 *
 * Resets the transcription status and triggers a new transcription attempt.
 */
async function handleRetryTranscription(
  itemId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await retryTranscription(itemId)
    return {
      success: result.success,
      error: result.error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    logger.error('Transcription retry failed:', message)
    return { success: false, error: message }
  }
}

/**
 * Retry metadata fetch for a link item
 */
async function handleRetryMetadata(itemId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const db = requireDatabase()

    const item = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
    if (!item) {
      return { success: false, error: 'Item not found' }
    }

    if (item.type !== 'link') {
      return { success: false, error: 'Item is not a link' }
    }

    if (!item.sourceUrl) {
      return { success: false, error: 'Item has no source URL' }
    }

    // Reset status to pending
    db.update(inboxItems)
      .set({
        processingStatus: 'pending',
        processingError: null,
        modifiedAt: new Date().toISOString()
      })
      .where(eq(inboxItems.id, itemId))
      .run()

    // Trigger background fetch (start fresh with retryCount = 0)
    setImmediate(() => {
      fetchAndUpdateMetadata(itemId, item.sourceUrl!, 0).catch((err) => {
        logger.error('Retry metadata fetch error:', err)
      })
    })

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
}

async function handleListArchived(input: unknown): Promise<ArchivedListResponse> {
  const options = ListArchivedSchema.parse(input || {})
  const db = requireDatabase()

  const conditions: ReturnType<typeof sql>[] = []
  conditions.push(sql`${inboxItems.archivedAt} IS NOT NULL`)

  if (options.search) {
    conditions.push(
      sql`(${inboxItems.title} LIKE ${'%' + options.search + '%'} OR ${inboxItems.content} LIKE ${'%' + options.search + '%'})`
    )
  }

  const countResult = db
    .select({ count: sql<number>`count(*)` })
    .from(inboxItems)
    .where(and(...conditions))
    .get()

  const total = countResult?.count || 0

  const rows = db
    .select()
    .from(inboxItems)
    .where(and(...conditions))
    .orderBy(desc(inboxItems.archivedAt))
    .limit(options.limit)
    .offset(options.offset)
    .all()

  const items: InboxItemListItem[] = rows.map((row) => {
    const tags = getItemTags(db, row.id)
    return toListItem(row, tags)
  })

  return {
    items,
    total,
    hasMore: options.offset + items.length < total
  }
}

async function handleUnarchive(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    const db = requireDatabase()

    const existing = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
    if (!existing) {
      return { success: false, error: 'Item not found' }
    }

    if (!existing.archivedAt) {
      return { success: false, error: 'Item is not archived' }
    }

    db.update(inboxItems)
      .set({
        archivedAt: null,
        modifiedAt: new Date().toISOString()
      })
      .where(eq(inboxItems.id, id))
      .run()

    emitInboxEvent(InboxChannels.events.UPDATED, { id, changes: { archivedAt: null } })
    syncInboxUpdate(db, id)

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
}

async function handleDeletePermanent(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    const db = requireDatabase()

    const existing = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
    if (!existing) {
      return { success: false, error: 'Item not found' }
    }

    await deleteInboxAttachments(id)

    db.delete(inboxItemTags).where(eq(inboxItemTags.itemId, id)).run()

    const snapshot = JSON.stringify(existing)
    db.delete(inboxItems).where(eq(inboxItems.id, id)).run()
    getInboxSyncService()?.enqueueDelete(id, snapshot)

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
}

async function handleGetFilingHistory(input: unknown): Promise<FilingHistoryResponse> {
  const options = GetFilingHistorySchema.parse(input || {})
  const db = requireDatabase()

  const rows = db
    .select()
    .from(inboxItems)
    .where(sql`${inboxItems.filedAt} IS NOT NULL`)
    .orderBy(desc(inboxItems.filedAt))
    .limit(options.limit)
    .all()

  const entries: FilingHistoryEntry[] = rows.map((row) => {
    const tags = getItemTags(db, row.id)
    return {
      id: row.id,
      itemId: row.id,
      itemType: row.type as FilingHistoryEntry['itemType'],
      itemTitle: row.title,
      filedTo: row.filedTo || '',
      filedAction: (row.filedAction || 'folder') as FilingHistoryEntry['filedAction'],
      filedAt: new Date(row.filedAt!),
      tags
    }
  })

  return { entries }
}

async function stubGetPatterns(): Promise<CapturePattern> {
  return {
    timeHeatmap: [],
    typeDistribution: [],
    topDomains: [],
    topTags: []
  }
}

// ============================================================================
// Registration
// ============================================================================

/**
 * Register all inbox IPC handlers
 */
export function registerInboxHandlers(): void {
  // Capture handlers
  ipcMain.handle(InboxChannels.invoke.CAPTURE_TEXT, (_, input) => handleCaptureText(input))
  ipcMain.handle(InboxChannels.invoke.CAPTURE_LINK, (_, input) => handleCaptureLink(input))
  ipcMain.handle(InboxChannels.invoke.CAPTURE_IMAGE, (_, input) => handleCaptureImage(input))
  ipcMain.handle(InboxChannels.invoke.CAPTURE_VOICE, (_, input) => handleCaptureVoice(input))
  ipcMain.handle(InboxChannels.invoke.CAPTURE_CLIP, (_event, _input) => stubCaptureClip())
  ipcMain.handle(InboxChannels.invoke.CAPTURE_PDF, (_event, _input) => stubCapturePdf())

  // CRUD handlers
  ipcMain.handle(InboxChannels.invoke.GET, (_, id) => handleGet(id))
  ipcMain.handle(InboxChannels.invoke.LIST, (_, input) => handleList(input))
  ipcMain.handle(InboxChannels.invoke.UPDATE, (_, input) => handleUpdate(input))
  ipcMain.handle(InboxChannels.invoke.ARCHIVE, (_, id) => handleArchive(id))

  // Filing handlers
  ipcMain.handle(InboxChannels.invoke.FILE, (_, input) => handleFile(input))
  ipcMain.handle(InboxChannels.invoke.GET_SUGGESTIONS, (_, itemId) => handleGetSuggestions(itemId))
  ipcMain.handle(
    InboxChannels.invoke.TRACK_SUGGESTION,
    (_, itemId, itemType, suggestedTo, actualTo, confidence, suggestedTags, actualTags) =>
      handleTrackSuggestion(
        itemId,
        itemType,
        suggestedTo,
        actualTo,
        confidence,
        suggestedTags,
        actualTags
      )
  )
  ipcMain.handle(InboxChannels.invoke.CONVERT_TO_NOTE, (_, itemId) => handleConvertToNote(itemId))
  ipcMain.handle(InboxChannels.invoke.LINK_TO_NOTE, (_, itemId, noteId, tags) =>
    handleLinkToNote(itemId, noteId, tags || [])
  )

  // Tag handlers
  ipcMain.handle(InboxChannels.invoke.ADD_TAG, (_, itemId, tag) => handleAddTag(itemId, tag))
  ipcMain.handle(InboxChannels.invoke.REMOVE_TAG, (_, itemId, tag) => handleRemoveTag(itemId, tag))
  ipcMain.handle(InboxChannels.invoke.GET_TAGS, () => handleGetTags())

  // Snooze handlers
  ipcMain.handle(InboxChannels.invoke.SNOOZE, (_, input) => handleSnooze(input))
  ipcMain.handle(InboxChannels.invoke.UNSNOOZE, (_, itemId) => handleUnsnooze(itemId))
  ipcMain.handle(InboxChannels.invoke.GET_SNOOZED, () => handleGetSnoozed())
  ipcMain.handle(InboxChannels.invoke.BULK_SNOOZE, (_, input) => handleBulkSnooze(input))

  // Viewed handlers (for reminder items)
  ipcMain.handle(InboxChannels.invoke.MARK_VIEWED, (_, itemId) => handleMarkViewed(itemId))

  // Bulk handlers
  ipcMain.handle(InboxChannels.invoke.BULK_FILE, (_, input) => handleBulkFile(input))
  ipcMain.handle(InboxChannels.invoke.BULK_ARCHIVE, (_, input) => handleBulkArchive(input))
  ipcMain.handle(InboxChannels.invoke.BULK_TAG, (_, input) => handleBulkTag(input))
  ipcMain.handle(InboxChannels.invoke.FILE_ALL_STALE, () => handleFileAllStale())

  // Transcription handlers
  ipcMain.handle(InboxChannels.invoke.RETRY_TRANSCRIPTION, (_, itemId) =>
    handleRetryTranscription(itemId)
  )

  // Metadata handlers
  ipcMain.handle(InboxChannels.invoke.RETRY_METADATA, (_, id) => handleRetryMetadata(id))

  // Stats handlers
  ipcMain.handle(InboxChannels.invoke.GET_STATS, () => handleGetStats())
  ipcMain.handle(InboxChannels.invoke.GET_PATTERNS, () => stubGetPatterns())

  // Settings handlers
  ipcMain.handle(InboxChannels.invoke.GET_STALE_THRESHOLD, () => handleGetStaleThreshold())
  ipcMain.handle(InboxChannels.invoke.SET_STALE_THRESHOLD, (_, days) =>
    handleSetStaleThreshold(days)
  )

  // Archived items handlers
  ipcMain.handle(InboxChannels.invoke.LIST_ARCHIVED, (_, input) => handleListArchived(input))
  ipcMain.handle(InboxChannels.invoke.UNARCHIVE, (_, id) => handleUnarchive(id))
  ipcMain.handle(InboxChannels.invoke.DELETE_PERMANENT, (_, id) => handleDeletePermanent(id))

  // Filing history handler
  ipcMain.handle(InboxChannels.invoke.GET_FILING_HISTORY, (_, input) =>
    handleGetFilingHistory(input)
  )

  logger.info('Inbox handlers registered')
}

/**
 * Unregister all inbox IPC handlers
 */
export function unregisterInboxHandlers(): void {
  // Capture
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_TEXT)
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_LINK)
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_IMAGE)
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_VOICE)
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_CLIP)
  ipcMain.removeHandler(InboxChannels.invoke.CAPTURE_PDF)

  // CRUD
  ipcMain.removeHandler(InboxChannels.invoke.GET)
  ipcMain.removeHandler(InboxChannels.invoke.LIST)
  ipcMain.removeHandler(InboxChannels.invoke.UPDATE)
  ipcMain.removeHandler(InboxChannels.invoke.ARCHIVE)

  // Filing
  ipcMain.removeHandler(InboxChannels.invoke.FILE)
  ipcMain.removeHandler(InboxChannels.invoke.GET_SUGGESTIONS)
  ipcMain.removeHandler(InboxChannels.invoke.TRACK_SUGGESTION)
  ipcMain.removeHandler(InboxChannels.invoke.CONVERT_TO_NOTE)
  ipcMain.removeHandler(InboxChannels.invoke.LINK_TO_NOTE)

  // Tags
  ipcMain.removeHandler(InboxChannels.invoke.ADD_TAG)
  ipcMain.removeHandler(InboxChannels.invoke.REMOVE_TAG)
  ipcMain.removeHandler(InboxChannels.invoke.GET_TAGS)

  // Snooze
  ipcMain.removeHandler(InboxChannels.invoke.SNOOZE)
  ipcMain.removeHandler(InboxChannels.invoke.UNSNOOZE)
  ipcMain.removeHandler(InboxChannels.invoke.GET_SNOOZED)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_SNOOZE)

  // Viewed
  ipcMain.removeHandler(InboxChannels.invoke.MARK_VIEWED)

  // Bulk
  ipcMain.removeHandler(InboxChannels.invoke.BULK_FILE)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_ARCHIVE)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_TAG)
  ipcMain.removeHandler(InboxChannels.invoke.FILE_ALL_STALE)

  // Transcription
  ipcMain.removeHandler(InboxChannels.invoke.RETRY_TRANSCRIPTION)

  // Metadata
  ipcMain.removeHandler(InboxChannels.invoke.RETRY_METADATA)

  // Stats
  ipcMain.removeHandler(InboxChannels.invoke.GET_STATS)
  ipcMain.removeHandler(InboxChannels.invoke.GET_PATTERNS)

  // Settings
  ipcMain.removeHandler(InboxChannels.invoke.GET_STALE_THRESHOLD)
  ipcMain.removeHandler(InboxChannels.invoke.SET_STALE_THRESHOLD)

  // Archived items
  ipcMain.removeHandler(InboxChannels.invoke.LIST_ARCHIVED)
  ipcMain.removeHandler(InboxChannels.invoke.UNARCHIVE)
  ipcMain.removeHandler(InboxChannels.invoke.DELETE_PERMANENT)

  // Filing history
  ipcMain.removeHandler(InboxChannels.invoke.GET_FILING_HISTORY)

  logger.info('Inbox handlers unregistered')
}
