/**
 * Inbox IPC Handlers
 *
 * Handles all inbox-related IPC communication from renderer.
 * Includes capture, filing, snooze, and bulk operations.
 *
 * @module ipc/inbox-handlers
 */

import { ipcMain, BrowserWindow } from 'electron'
import { InboxChannels } from '@shared/ipc-channels'
import {
  CaptureTextSchema,
  CaptureLinkSchema,
  InboxListSchema,
  InboxUpdateSchema,
  BulkDeleteSchema,
  type CaptureResponse,
  type InboxListResponse,
  type InboxItem,
  type InboxItemListItem,
  type FileResponse,
  type BulkResponse,
  type SuggestionsResponse,
  type InboxStats,
  type CapturePattern
} from '@shared/contracts/inbox-api'
import { getDatabase } from '../database'
import { generateId } from '../lib/id'
import { inboxItems, inboxItemTags } from '@shared/db/schema/inbox'
import { eq, desc, asc, and, isNull, sql } from 'drizzle-orm'
import {
  resolveAttachmentUrl,
  deleteInboxAttachments,
  getItemAttachmentsDir
} from '../inbox/attachments'
import { fetchUrlMetadata, downloadImage } from '../inbox/metadata'
import { fileToFolder, convertToNote, linkToNote, bulkFileToFolder } from '../inbox/filing'
import { FileItemSchema, BulkFileSchema } from '@shared/contracts/inbox-api'

// ============================================================================
// Constants
// ============================================================================

/** Default stale threshold in days */
const DEFAULT_STALE_DAYS = 7

/** Current stale threshold (can be changed via settings) */
let staleThresholdDays = DEFAULT_STALE_DAYS

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
    console.warn('[Metadata] No database available, skipping metadata fetch')
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
    console.log(`[Metadata] Fetching metadata for ${url}`)
    const metadata = await fetchUrlMetadata(url)
    console.log(`[Metadata] Extracted: title="${metadata.title}", hasImage=${!!metadata.image}`)

    // Download image if available
    let thumbnailPath: string | null = null
    if (metadata.image) {
      const attachmentsDir = getItemAttachmentsDir(itemId)
      const imageName = await downloadImage(metadata.image, attachmentsDir)
      if (imageName) {
        // Store relative path: inbox/{itemId}/thumbnail.ext
        thumbnailPath = `inbox/${itemId}/${imageName}`
        console.log(`[Metadata] Downloaded thumbnail: ${thumbnailPath}`)
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

    console.log(`[Metadata] Successfully updated item ${itemId}`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[Metadata] Error fetching metadata for ${url}:`, errorMessage)

    // Auto-retry once after delay
    if (retryCount < 1) {
      console.log(`[Metadata] Scheduling retry for ${itemId} in ${METADATA_RETRY_DELAY}ms`)
      setTimeout(() => {
        fetchAndUpdateMetadata(itemId, url, retryCount + 1).catch(console.error)
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
      console.error('[Metadata] Failed to update error status:', dbError)
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
function requireDatabase() {
  try {
    return getDatabase()
  } catch {
    throw new Error('No vault is open. Please open a vault first.')
  }
}

/**
 * Check if an item is stale (older than threshold)
 */
function isStale(createdAt: string): boolean {
  const created = new Date(createdAt)
  const now = new Date()
  const diffDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24)
  return diffDays > staleThresholdDays
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
    pageCount: metadata?.pageCount as number | undefined
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

    // Emit event
    emitInboxEvent(InboxChannels.events.CAPTURED, { item: toListItem(created, tags) })

    return { success: true, item }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, item: null, error: message }
  }
}

/**
 * Capture a URL with background metadata extraction
 */
async function handleCaptureLink(input: unknown): Promise<CaptureResponse> {
  try {
    const parsed = CaptureLinkSchema.parse(input)
    const db = requireDatabase()

    const id = generateId()
    const now = new Date().toISOString()

    // Create link item with pending status
    db.insert(inboxItems)
      .values({
        id,
        type: 'link',
        title: parsed.url, // Will be updated when metadata is fetched
        content: null,
        sourceUrl: parsed.url,
        createdAt: now,
        modifiedAt: now,
        processingStatus: 'pending', // Metadata fetch is pending
        metadata: {
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

    // Emit captured event immediately (UI shows pending state)
    emitInboxEvent(InboxChannels.events.CAPTURED, { item: toListItem(created, tags) })

    // Trigger background metadata fetch (don't await - non-blocking)
    setImmediate(() => {
      fetchAndUpdateMetadata(id, parsed.url).catch((err) => {
        console.error('[Inbox] Background metadata fetch error:', err)
      })
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

  // Exclude filed items unless requested
  if (!options.includeFiled) {
    conditions.push(isNull(inboxItems.filedAt))
  }

  // Exclude snoozed items unless requested
  if (!options.includeSnoozed) {
    conditions.push(isNull(inboxItems.snoozedUntil))
  }

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

    return { success: true, item }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, item: null, error: message }
  }
}

/**
 * Delete an inbox item
 */
async function handleDelete(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    const db = requireDatabase()

    const existing = db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()
    if (!existing) {
      return { success: false, error: 'Item not found' }
    }

    // Delete attachments
    await deleteInboxAttachments(id)

    // Delete tags (cascade should handle this, but be explicit)
    db.delete(inboxItemTags).where(eq(inboxItemTags.itemId, id)).run()

    // Delete item
    db.delete(inboxItems).where(eq(inboxItems.id, id)).run()

    emitInboxEvent(InboxChannels.events.DELETED, { id })

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
 * Bulk delete items
 */
async function handleBulkDelete(input: unknown): Promise<BulkResponse> {
  const parsed = BulkDeleteSchema.parse(input)
  const errors: Array<{ itemId: string; error: string }> = []
  let processedCount = 0

  for (const itemId of parsed.itemIds) {
    const result = await handleDelete(itemId)
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

  // Total items (not filed, not snoozed)
  const totalResult = db
    .select({ count: sql<number>`count(*)` })
    .from(inboxItems)
    .where(and(isNull(inboxItems.filedAt), isNull(inboxItems.snoozedUntil)))
    .get()

  // Items by type
  const typeResult = db
    .select({
      type: inboxItems.type,
      count: sql<number>`count(*)`
    })
    .from(inboxItems)
    .where(and(isNull(inboxItems.filedAt), isNull(inboxItems.snoozedUntil)))
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

  // Stale count
  const staleDate = new Date()
  staleDate.setDate(staleDate.getDate() - staleThresholdDays)
  const staleDateStr = staleDate.toISOString()

  const staleResult = db
    .select({ count: sql<number>`count(*)` })
    .from(inboxItems)
    .where(
      and(
        isNull(inboxItems.filedAt),
        isNull(inboxItems.snoozedUntil),
        sql`${inboxItems.createdAt} < ${staleDateStr}`
      )
    )
    .get()

  // Snoozed count
  const snoozedResult = db
    .select({ count: sql<number>`count(*)` })
    .from(inboxItems)
    .where(sql`${inboxItems.snoozedUntil} IS NOT NULL`)
    .get()

  return {
    totalItems: totalResult?.count || 0,
    itemsByType: itemsByType as InboxStats['itemsByType'],
    staleCount: staleResult?.count || 0,
    snoozedCount: snoozedResult?.count || 0,
    processedToday: 0, // TODO: Implement with inbox_stats table
    capturedToday: 0, // TODO: Implement with inbox_stats table
    avgTimeToProcess: 0 // TODO: Implement with filing_history table
  }
}

/**
 * Get stale threshold
 */
async function handleGetStaleThreshold(): Promise<number> {
  return staleThresholdDays
}

/**
 * Set stale threshold
 */
async function handleSetStaleThreshold(days: number): Promise<{ success: boolean }> {
  staleThresholdDays = Math.max(1, Math.min(365, days))
  return { success: true }
}

// ============================================================================
// Stub Handlers (To be implemented in later phases)
// ============================================================================

async function stubCaptureImage(): Promise<CaptureResponse> {
  return { success: false, item: null, error: 'Not implemented yet' }
}

async function stubCaptureVoice(): Promise<CaptureResponse> {
  return { success: false, item: null, error: 'Not implemented yet' }
}

async function stubCaptureClip(): Promise<CaptureResponse> {
  return { success: false, item: null, error: 'Not implemented yet' }
}

async function stubCapturePdf(): Promise<CaptureResponse> {
  return { success: false, item: null, error: 'Not implemented yet' }
}

/**
 * File an inbox item to a destination (folder, new note, or existing note)
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
      case 'note':
        if (!destination.noteId) {
          return { success: false, filedTo: null, error: 'Note ID required for linking' }
        }
        const result = await linkToNote(itemId, destination.noteId)
        return {
          success: result.success,
          filedTo: destination.noteId,
          noteId: destination.noteId,
          error: result.error
        }
      default:
        return { success: false, filedTo: null, error: 'Invalid destination type' }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, filedTo: null, error: message }
  }
}

async function stubGetSuggestions(): Promise<SuggestionsResponse> {
  // TODO: Implement AI-powered suggestions in Phase 17
  return { suggestions: [] }
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
  noteId: string
): Promise<{ success: boolean; error?: string }> {
  return linkToNote(itemId, noteId)
}

async function stubSnooze(): Promise<{ success: boolean; error?: string }> {
  return { success: false, error: 'Not implemented yet' }
}

async function stubUnsnooze(): Promise<{ success: boolean; error?: string }> {
  return { success: false, error: 'Not implemented yet' }
}

async function stubGetSnoozed(): Promise<InboxItem[]> {
  return []
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

async function stubBulkTag(): Promise<BulkResponse> {
  return {
    success: false,
    processedCount: 0,
    errors: [{ itemId: '', error: 'Not implemented yet' }]
  }
}

async function stubFileAllStale(): Promise<BulkResponse> {
  return {
    success: false,
    processedCount: 0,
    errors: [{ itemId: '', error: 'Not implemented yet' }]
  }
}

async function stubRetryTranscription(): Promise<{ success: boolean; error?: string }> {
  return { success: false, error: 'Not implemented yet' }
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
        console.error('[Inbox] Retry metadata fetch error:', err)
      })
    })

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return { success: false, error: message }
  }
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
  ipcMain.handle(InboxChannels.invoke.CAPTURE_IMAGE, () => stubCaptureImage())
  ipcMain.handle(InboxChannels.invoke.CAPTURE_VOICE, () => stubCaptureVoice())
  ipcMain.handle(InboxChannels.invoke.CAPTURE_CLIP, () => stubCaptureClip())
  ipcMain.handle(InboxChannels.invoke.CAPTURE_PDF, () => stubCapturePdf())

  // CRUD handlers
  ipcMain.handle(InboxChannels.invoke.GET, (_, id) => handleGet(id))
  ipcMain.handle(InboxChannels.invoke.LIST, (_, input) => handleList(input))
  ipcMain.handle(InboxChannels.invoke.UPDATE, (_, input) => handleUpdate(input))
  ipcMain.handle(InboxChannels.invoke.DELETE, (_, id) => handleDelete(id))

  // Filing handlers
  ipcMain.handle(InboxChannels.invoke.FILE, (_, input) => handleFile(input))
  ipcMain.handle(InboxChannels.invoke.GET_SUGGESTIONS, () => stubGetSuggestions())
  ipcMain.handle(InboxChannels.invoke.CONVERT_TO_NOTE, (_, itemId) => handleConvertToNote(itemId))
  ipcMain.handle(InboxChannels.invoke.LINK_TO_NOTE, (_, itemId, noteId) =>
    handleLinkToNote(itemId, noteId)
  )

  // Tag handlers
  ipcMain.handle(InboxChannels.invoke.ADD_TAG, (_, itemId, tag) => handleAddTag(itemId, tag))
  ipcMain.handle(InboxChannels.invoke.REMOVE_TAG, (_, itemId, tag) => handleRemoveTag(itemId, tag))
  ipcMain.handle(InboxChannels.invoke.GET_TAGS, () => handleGetTags())

  // Snooze handlers
  ipcMain.handle(InboxChannels.invoke.SNOOZE, () => stubSnooze())
  ipcMain.handle(InboxChannels.invoke.UNSNOOZE, () => stubUnsnooze())
  ipcMain.handle(InboxChannels.invoke.GET_SNOOZED, () => stubGetSnoozed())

  // Bulk handlers
  ipcMain.handle(InboxChannels.invoke.BULK_FILE, (_, input) => handleBulkFile(input))
  ipcMain.handle(InboxChannels.invoke.BULK_DELETE, (_, input) => handleBulkDelete(input))
  ipcMain.handle(InboxChannels.invoke.BULK_TAG, () => stubBulkTag())
  ipcMain.handle(InboxChannels.invoke.FILE_ALL_STALE, () => stubFileAllStale())

  // Transcription handlers
  ipcMain.handle(InboxChannels.invoke.RETRY_TRANSCRIPTION, () => stubRetryTranscription())

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

  console.log('[IPC] Inbox handlers registered')
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
  ipcMain.removeHandler(InboxChannels.invoke.DELETE)

  // Filing
  ipcMain.removeHandler(InboxChannels.invoke.FILE)
  ipcMain.removeHandler(InboxChannels.invoke.GET_SUGGESTIONS)
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

  // Bulk
  ipcMain.removeHandler(InboxChannels.invoke.BULK_FILE)
  ipcMain.removeHandler(InboxChannels.invoke.BULK_DELETE)
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

  console.log('[IPC] Inbox handlers unregistered')
}
