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
  type ImageMetadata
} from '@memry/contracts/inbox-api'
import sharp from 'sharp'
import { getDatabase, requireDatabase, type DataDb } from '../database'
import { generateId } from '../lib/id'
import { inboxItems, inboxItemTags } from '@memry/db-schema/schema/inbox'
import { eq } from 'drizzle-orm'
import {
  resolveAttachmentUrl,
  storeInboxAttachment,
  storeThumbnail,
  ALLOWED_IMAGE_TYPES,
  ALLOWED_AUDIO_TYPES,
  ALLOWED_VIDEO_TYPES,
  ALLOWED_DOCUMENT_TYPES
} from '../inbox/attachments'
import { fetchUrlMetadata, titleFromUrl, isBotPageTitle, extractDomain } from '../inbox/metadata'
import {
  fileToFolder,
  convertToNote,
  convertToTask,
  linkToNote,
  linkToNotes
} from '../inbox/filing'
import { extractSocialPost, detectSocialPlatform, isSocialPost } from '../inbox/social'
import { createLogger } from '../lib/logger'
import { captureVoice, type CaptureVoiceInput } from '../inbox/capture'
import { findDuplicateByUrl, findDuplicateByContent } from '../inbox/duplicates'
import { getSuggestions, trackSuggestionFeedback } from '../inbox/suggestions'
import { FileItemSchema } from '@memry/contracts/inbox-api'
import { isStale as checkIsStale } from '../inbox/stats'
import { snoozeItem, unsnoozeItem, getSnoozedItems } from '../inbox/snooze'
import type { SnoozeInput, SnoozedItem } from '../inbox/snooze'
import { withErrorHandler, withDb } from './validate'
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
import {
  queueInboxMetadataJob,
  queueInboxTranscriptionJob,
  resumeInboxJobs,
  teardownInboxJobScheduler
} from '../inbox/jobs'
import { publishInboxUpserted, syncInboxCreate, syncInboxUpdate } from '../inbox/runtime-effects'

// ============================================================================
// Constants
// ============================================================================

const logger = createLogger('IPC:Inbox')

// ============================================================================
// Social Post Metadata (synchronous — react-tweet handles fetching in renderer)
// ============================================================================

function storeSocialMetadata(itemId: string, url: string): void {
  const db = requireDatabase()
  const result = extractSocialPost(url)

  if (!result.success || !result.metadata) return

  const metadata = result.metadata
  const title = metadata.authorHandle ? `Tweet by ${metadata.authorHandle}` : 'Tweet'

  db.update(inboxItems)
    .set({
      title,
      processingStatus: 'complete',
      processingError: null,
      modifiedAt: new Date().toISOString(),
      metadata
    })
    .where(eq(inboxItems.id, itemId))
    .run()

  publishInboxUpserted(itemId)

  emitInboxEvent(InboxChannels.events.METADATA_COMPLETE, { id: itemId, metadata })
  logger.info(`Stored social metadata for ${itemId}: ${title}`)
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
const handleCaptureText = withErrorHandler(async (input: unknown): Promise<CaptureResponse> => {
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

  db.insert(inboxItems)
    .values({
      id,
      type: 'note',
      title:
        parsed.title || parsed.content.substring(0, 50) + (parsed.content.length > 50 ? '...' : ''),
      content: parsed.content,
      createdAt: now,
      modifiedAt: now,
      processingStatus: 'complete',
      captureSource: parsed.source ?? null
    })
    .run()

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

  return { success: true, item }
}, 'Unknown error')

/**
 * Capture a URL with background metadata extraction
 *
 * Automatically detects Twitter/X posts and uses specialized extraction
 * for richer metadata display.
 */
const handleCaptureLink = withErrorHandler(async (input: unknown): Promise<CaptureResponse> => {
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

  const platform = detectSocialPlatform(parsed.url)
  const isSocial = platform !== null && isSocialPost(parsed.url)
  const itemType = isSocial ? 'social' : 'link'

  logger.info(`URL detected as ${itemType}${platform ? ` (${platform})` : ''}: ${parsed.url}`)

  db.insert(inboxItems)
    .values({
      id,
      type: itemType,
      title: titleFromUrl(parsed.url),
      content: null,
      sourceUrl: parsed.url,
      createdAt: now,
      modifiedAt: now,
      processingStatus: 'pending',
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

  if (isSocial) {
    try {
      storeSocialMetadata(id, parsed.url)
    } catch (err) {
      logger.error('Social metadata storage error:', err)
    }
  } else {
    queueInboxMetadataJob(id, parsed.url)
  }

  return { success: true, item }
}, 'Unknown error')

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
const handleCaptureImage = withErrorHandler(async (input: unknown): Promise<CaptureResponse> => {
  const parsed = CaptureImageSchema.parse(input)
  const db = requireDatabase()

  const id = generateId()
  const now = new Date().toISOString()

  const inboxType = getInboxTypeFromMime(parsed.mimeType)
  const isImage = ALLOWED_IMAGE_TYPES.includes(parsed.mimeType)

  let fileBuffer: Buffer
  if (Buffer.isBuffer(parsed.data)) {
    fileBuffer = parsed.data
  } else if (parsed.data instanceof Uint8Array) {
    fileBuffer = Buffer.from(parsed.data)
  } else if (parsed.data instanceof ArrayBuffer) {
    fileBuffer = Buffer.from(parsed.data)
  } else if (typeof parsed.data === 'object' && parsed.data !== null) {
    const data = parsed.data as Record<string, unknown>
    if (data.type === 'Buffer' && Array.isArray(data.data)) {
      fileBuffer = Buffer.from(data.data as number[])
    } else {
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

  if (fileBuffer.length === 0) {
    return {
      success: false,
      item: null,
      error: 'Empty file data'
    }
  }

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

  if (isImage) {
    try {
      const metadata = await sharp(fileBuffer).metadata()

      if (metadata.width && metadata.height) {
        const imageMetadata: ImageMetadata = {
          originalFilename: parsed.filename,
          format: metadata.format || 'unknown',
          width: metadata.width,
          height: metadata.height,
          fileSize: fileBuffer.length,
          hasExif: !!(metadata.exif || metadata.icc)
        }
        itemMetadata = imageMetadata as unknown as Record<string, unknown>

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
          logger.warn('Failed to generate thumbnail:', err)
        }
      }
    } catch (err) {
      logger.warn('Failed to read image metadata:', err)
    }
  }

  db.insert(inboxItems)
    .values({
      id,
      type: inboxType,
      title: parsed.filename.replace(/\.[^.]+$/, ''),
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

  logger.info(`Captured ${inboxType}: ${parsed.filename} (${fileBuffer.length} bytes)`)

  return { success: true, item }
}, 'Unknown error')

/**
 * Capture a voice memo
 *
 * Handles voice recording capture with optional transcription.
 * Audio is stored in vault/attachments/inbox/{itemId}/ and
 * transcription is triggered asynchronously via OpenAI Whisper.
 */
const handleCaptureVoice = withErrorHandler(async (input: unknown): Promise<CaptureResponse> => {
  if (!input || typeof input !== 'object') {
    return { success: false, item: null, error: 'Invalid voice capture input' }
  }

  const rawInput = input as Record<string, unknown>

  let audioBuffer: Buffer
  const rawData = rawInput.data

  if (Buffer.isBuffer(rawData)) {
    audioBuffer = rawData
  } else if (rawData instanceof Uint8Array) {
    audioBuffer = Buffer.from(rawData)
  } else if (rawData instanceof ArrayBuffer) {
    audioBuffer = Buffer.from(rawData)
  } else if (typeof rawData === 'object' && rawData !== null) {
    const data = rawData as Record<string, unknown>
    if (data.type === 'Buffer' && Array.isArray(data.data)) {
      audioBuffer = Buffer.from(data.data as number[])
    } else {
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

  if (audioBuffer.length === 0) {
    return { success: false, item: null, error: 'Empty audio data' }
  }

  return await captureVoice({
    data: audioBuffer,
    duration: rawInput.duration as number,
    format: rawInput.format as 'webm' | 'mp3' | 'wav',
    transcribe: rawInput.transcribe as boolean | undefined,
    tags: rawInput.tags as string[] | undefined,
    source: rawInput.source as CaptureVoiceInput['source']
  })
}, 'Unknown error')

async function stubCaptureClip(): Promise<CaptureResponse> {
  return { success: false, item: null, error: 'Not implemented yet' }
}

async function stubCapturePdf(): Promise<CaptureResponse> {
  return { success: false, item: null, error: 'Not implemented yet' }
}

/**
 * File an inbox item to a destination (folder, new note, or existing note(s))
 */
const handleFile = withErrorHandler(async (input: unknown): Promise<FileResponse> => {
  const parsed = FileItemSchema.parse(input)
  const { itemId, destination, tags } = parsed

  switch (destination.type) {
    case 'folder':
      return fileToFolder(itemId, destination.path || '', tags)
    case 'new-note':
      return convertToNote(itemId)
    case 'note': {
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
}, 'Unknown error')

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
const handleTrackSuggestion = withErrorHandler(
  async (
    itemId: string,
    itemType: string,
    suggestedTo: string,
    actualTo: string,
    confidence: number,
    suggestedTags: string[] = [],
    actualTags: string[] = []
  ): Promise<{ success: boolean; error?: string }> => {
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
  },
  'Failed to track feedback'
)

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
const handleSnooze = withErrorHandler(
  async (input: unknown): Promise<{ success: boolean; error?: string }> => {
    if (!input || typeof input !== 'object') {
      return { success: false, error: 'Invalid snooze input' }
    }

    const snoozeInput = input as SnoozeInput
    if (!snoozeInput.itemId || !snoozeInput.snoozeUntil) {
      return { success: false, error: 'itemId and snoozeUntil are required' }
    }

    const result = snoozeItem(snoozeInput)
    return { success: result.success, error: result.error }
  },
  'Snooze failed'
)

/**
 * Unsnooze an inbox item immediately
 */
const handleUnsnooze = withErrorHandler(
  async (itemId: string): Promise<{ success: boolean; error?: string }> => {
    if (!itemId) {
      return { success: false, error: 'itemId is required' }
    }

    const result = unsnoozeItem(itemId)
    return { success: result.success, error: result.error }
  },
  'Unsnooze failed'
)

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
const handleRetryTranscription = withErrorHandler(
  async (itemId: string): Promise<{ success: boolean; error?: string }> => {
    const db = requireDatabase()
    const item = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()

    if (!item) {
      return { success: false, error: 'Item not found' }
    }

    if (item.type !== 'voice') {
      return { success: false, error: 'Item is not a voice memo' }
    }

    if (!item.attachmentPath) {
      return { success: false, error: 'No audio file attached to this item' }
    }

    const now = new Date().toISOString()
    db.update(inboxItems)
      .set({
        transcriptionStatus: 'pending',
        processingError: null,
        modifiedAt: now
      })
      .where(eq(inboxItems.id, itemId))
      .run()

    publishInboxUpserted(itemId)

    emitInboxEvent(InboxChannels.events.UPDATED, {
      id: itemId,
      changes: {
        transcriptionStatus: 'pending',
        processingError: null
      }
    })

    queueInboxTranscriptionJob(itemId, item.attachmentPath)
    return { success: true }
  },
  'Transcription retry failed'
)

/**
 * Retry metadata fetch for a link item
 */
const handleRetryMetadata = withDb(
  async (db, itemId: string): Promise<{ success: boolean; error?: string }> => {
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

    db.update(inboxItems)
      .set({
        processingStatus: 'pending',
        processingError: null,
        modifiedAt: new Date().toISOString()
      })
      .where(eq(inboxItems.id, itemId))
      .run()

    publishInboxUpserted(itemId)

    emitInboxEvent(InboxChannels.events.UPDATED, {
      id: itemId,
      changes: {
        processingStatus: 'pending',
        processingError: null
      }
    })

    queueInboxMetadataJob(itemId, item.sourceUrl)

    return { success: true }
  },
  'Retry metadata failed'
)

// ============================================================================
// Registration
// ============================================================================

/**
 * Register all inbox IPC handlers
 */
export function registerInboxHandlers(): void {
  resumeInboxJobs()

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

  ipcMain.handle(InboxChannels.invoke.PREVIEW_LINK, async (_, url: string) => {
    try {
      const metadata = await fetchUrlMetadata(url)
      const domain = extractDomain(url)
      const title =
        metadata.title && !isBotPageTitle(metadata.title) ? metadata.title : titleFromUrl(url)
      return {
        title,
        domain,
        favicon: metadata.logo,
        image: metadata.image,
        description: metadata.description
      }
    } catch {
      const domain = extractDomain(url)
      return { title: titleFromUrl(url), domain }
    }
  })

  logger.info('Inbox handlers registered')
}

/**
 * Unregister all inbox IPC handlers
 */
export function unregisterInboxHandlers(): void {
  teardownInboxJobScheduler()

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
