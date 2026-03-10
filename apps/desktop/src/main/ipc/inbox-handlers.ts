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
import { InboxChannels } from '@memry/contracts/ipc-channels'
import {
  CaptureTextSchema,
  CaptureLinkSchema,
  CaptureImageSchema,
  type CaptureResponse,
  type InboxItem,
  type InboxItemListItem,
  type FileResponse,
  type SuggestionsResponse,
  type ImageMetadata,
  type SocialMetadata
} from '@memry/contracts/inbox-api'
import sharp from 'sharp'
import { getDatabase, type DrizzleDb } from '../database'
import { generateId } from '../lib/id'
import { inboxItems, inboxItemTags } from '@memry/db-schema/schema/inbox'
import { eq } from 'drizzle-orm'
import {
  resolveAttachmentUrl,
  getItemAttachmentsDir,
  storeInboxAttachment,
  storeThumbnail,
  ALLOWED_IMAGE_TYPES,
  ALLOWED_AUDIO_TYPES,
  ALLOWED_VIDEO_TYPES,
  ALLOWED_DOCUMENT_TYPES
} from '../inbox/attachments'
import { fetchUrlMetadata, downloadImage } from '../inbox/metadata'
import {
  fileToFolder,
  convertToNote,
  convertToTask,
  linkToNote,
  linkToNotes
} from '../inbox/filing'
import {
  extractSocialPost,
  detectSocialPlatform,
  isSocialPost,
  createFallbackSocialMetadata
} from '../inbox/social'
import { createLogger } from '../lib/logger'
import { captureVoice, type CaptureVoiceInput } from '../inbox/capture'
import { findDuplicateByUrl, findDuplicateByContent } from '../inbox/duplicates'
import { retryTranscription } from '../inbox/transcription'
import { getSuggestions, trackSuggestionFeedback } from '../inbox/suggestions'
import { FileItemSchema } from '@memry/contracts/inbox-api'
import { isStale as checkIsStale } from '../inbox/stats'
import { snoozeItem, unsnoozeItem, getSnoozedItems } from '../inbox/snooze'
import type { SnoozeInput, SnoozedItem } from '../inbox/snooze'
import { getInboxSyncService } from '../sync/inbox-sync'
import { incrementInboxClockOffline } from '../sync/offline-clock'
import {
  createInboxCrudHandlers,
  registerInboxCrudHandlers,
  unregisterInboxCrudHandlers
} from './inbox-crud-handlers'
import {
  createInboxBatchHandlers,
  registerInboxBatchHandlers,
  unregisterInboxBatchHandlers
} from './inbox-batch-handlers'
import {
  createInboxQueryHandlers,
  registerInboxQueryHandlers,
  unregisterInboxQueryHandlers
} from './inbox-query-handlers'

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
    captureSource: row.captureSource as InboxItem['captureSource'],
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
    captureSource: row.captureSource as InboxItemListItem['captureSource'],
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

    if (!parsed.force) {
      const duplicate = findDuplicateByContent(parsed.content)
      if (duplicate) {
        return { success: true, item: null, duplicate: true, existingItem: duplicate }
      }
    }

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
        processingStatus: 'complete',
        captureSource: parsed.source ?? null
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

    if (!parsed.force) {
      const duplicate = findDuplicateByUrl(parsed.url)
      if (duplicate) {
        return { success: true, item: null, duplicate: true, existingItem: duplicate }
      }
    }

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
        captureSource: parsed.source ?? null,
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
        metadata: itemMetadata,
        captureSource: parsed.source ?? null
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
      tags: rawInput.tags as string[] | undefined,
      source: rawInput.source as CaptureVoiceInput['source']
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

async function handleConvertToTask(
  itemId: string
): Promise<{ success: boolean; taskId: string | null; error?: string }> {
  return convertToTask(itemId)
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

  const crudHandlers = createInboxCrudHandlers({
    requireDatabase,
    getItemTags,
    toInboxItem,
    emitInboxEvent,
    syncInboxUpdate,
    logger
  })
  registerInboxCrudHandlers(crudHandlers)

  const queryHandlers = createInboxQueryHandlers({
    requireDatabase,
    getItemTags,
    toListItem
  })
  registerInboxQueryHandlers(queryHandlers)

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
  ipcMain.handle(InboxChannels.invoke.CONVERT_TO_TASK, (_, itemId) => handleConvertToTask(itemId))
  ipcMain.handle(InboxChannels.invoke.LINK_TO_NOTE, (_, itemId, noteId, tags) =>
    handleLinkToNote(itemId, noteId, tags || [])
  )

  // Snooze handlers
  ipcMain.handle(InboxChannels.invoke.SNOOZE, (_, input) => handleSnooze(input))
  ipcMain.handle(InboxChannels.invoke.UNSNOOZE, (_, itemId) => handleUnsnooze(itemId))
  ipcMain.handle(InboxChannels.invoke.GET_SNOOZED, () => handleGetSnoozed())

  const batchHandlers = createInboxBatchHandlers({
    requireDatabase,
    emitInboxEvent,
    archiveItem: crudHandlers.handleArchive
  })
  registerInboxBatchHandlers(batchHandlers)

  // Transcription handlers
  ipcMain.handle(InboxChannels.invoke.RETRY_TRANSCRIPTION, (_, itemId) =>
    handleRetryTranscription(itemId)
  )

  // Metadata handlers
  ipcMain.handle(InboxChannels.invoke.RETRY_METADATA, (_, id) => handleRetryMetadata(id))

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

  unregisterInboxCrudHandlers()
  unregisterInboxQueryHandlers()
  unregisterInboxBatchHandlers()

  // Filing
  ipcMain.removeHandler(InboxChannels.invoke.FILE)
  ipcMain.removeHandler(InboxChannels.invoke.GET_SUGGESTIONS)
  ipcMain.removeHandler(InboxChannels.invoke.TRACK_SUGGESTION)
  ipcMain.removeHandler(InboxChannels.invoke.CONVERT_TO_NOTE)
  ipcMain.removeHandler(InboxChannels.invoke.CONVERT_TO_TASK)
  ipcMain.removeHandler(InboxChannels.invoke.LINK_TO_NOTE)

  // Snooze
  ipcMain.removeHandler(InboxChannels.invoke.SNOOZE)
  ipcMain.removeHandler(InboxChannels.invoke.UNSNOOZE)
  ipcMain.removeHandler(InboxChannels.invoke.GET_SNOOZED)

  // Transcription
  ipcMain.removeHandler(InboxChannels.invoke.RETRY_TRANSCRIPTION)

  // Metadata
  ipcMain.removeHandler(InboxChannels.invoke.RETRY_METADATA)

  logger.info('Inbox handlers unregistered')
}
