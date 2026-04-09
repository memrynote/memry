import { BrowserWindow } from 'electron'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import {
  createInboxCommands,
  createInboxQueries,
  type CaptureImageInput,
  type CaptureTextInput,
  type CaptureVoiceInput,
  type CreateLinkCaptureItemInput,
  type InboxCaptureResponse,
  type InboxItem
} from '@memry/domain-inbox'
import type {
  InboxItem as ContractInboxItem,
  InboxItemListItem as ContractInboxItemListItem
} from '@memry/contracts/inbox-api'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import { inboxItems, inboxItemTags } from '@memry/db-schema/schema/inbox'
import { getDatabase, requireDatabase } from '../database'
import { generateId } from '../lib/id'
import { createLogger } from '../lib/logger'
import {
  resolveAttachmentUrl,
  storeInboxAttachment,
  storeThumbnail,
  ALLOWED_IMAGE_TYPES,
  ALLOWED_AUDIO_TYPES,
  ALLOWED_VIDEO_TYPES,
  ALLOWED_DOCUMENT_TYPES
} from './attachments'
import { titleFromUrl } from './metadata'
import { captureVoice } from './capture'
import { findDuplicateByContent, findDuplicateByUrl } from './duplicates'
import { getSuggestions, trackSuggestionFeedback } from './suggestions'
import { fileToFolder, convertToNote, convertToTask, linkToNote, linkToNotes } from './filing'
import { detectSocialPlatform, extractSocialPost, isSocialPost } from './social'
import { isStale as checkIsStale } from './stats'
import { getSnoozedItems, snoozeItem, unsnoozeItem } from './snooze'
import {
  queueInboxMetadataJob,
  queueInboxTranscriptionJob,
  resumeInboxJobs,
  teardownInboxJobScheduler
} from './jobs'
import { createInboxBatchHandlers, type InboxBatchHandlers } from './batch'
import { createInboxCrudHandlers, type InboxCrudHandlers } from './crud'
import { createInboxQueryHandlers, type InboxQueryHandlers } from './queries'
import { publishInboxUpserted, syncInboxCreate, syncInboxUpdate } from './runtime-effects'

const logger = createLogger('Inbox:Domain')

function emitInboxEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

function getItemTags(db: ReturnType<typeof getDatabase>, itemId: string): string[] {
  const tags = db.select().from(inboxItemTags).where(eq(inboxItemTags.itemId, itemId)).all()
  return tags.map((tag) => tag.tag)
}

function toInboxItem(row: typeof inboxItems.$inferSelect, tags: string[]): ContractInboxItem {
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
    metadata: row.metadata as ContractInboxItem['metadata'],
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
    isStale: checkIsStale(row.createdAt)
  }
}

function toListItem(
  row: typeof inboxItems.$inferSelect,
  tags: string[]
): ContractInboxItemListItem {
  const metadata = row.metadata as Record<string, unknown> | null
  const isReminder = row.type === 'reminder'

  return {
    id: row.id,
    type: row.type as ContractInboxItemListItem['type'],
    title: row.title,
    content: row.content,
    createdAt: new Date(row.createdAt),
    thumbnailUrl: resolveAttachmentUrl(row.thumbnailPath),
    sourceUrl: row.sourceUrl,
    tags,
    isStale: checkIsStale(row.createdAt),
    processingStatus: (row.processingStatus ||
      'complete') as ContractInboxItemListItem['processingStatus'],
    duration: metadata?.duration as number | undefined,
    excerpt: metadata?.excerpt as string | undefined,
    pageCount: metadata?.pageCount as number | undefined,
    transcription: row.transcription,
    transcriptionStatus:
      row.transcriptionStatus as ContractInboxItemListItem['transcriptionStatus'],
    snoozedUntil: row.snoozedUntil ? new Date(row.snoozedUntil) : undefined,
    snoozeReason: row.snoozeReason ?? undefined,
    viewedAt: row.viewedAt ? new Date(row.viewedAt) : undefined,
    captureSource: row.captureSource as ContractInboxItemListItem['captureSource'],
    metadata: isReminder
      ? (metadata as unknown as ContractInboxItemListItem['metadata'])
      : undefined
  }
}

function normalizeBinaryInput(
  data: Buffer | Uint8Array | ArrayBuffer | Record<string, unknown>
): Buffer | null {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (data instanceof ArrayBuffer) return Buffer.from(data)

  if (typeof data === 'object' && data !== null) {
    if (data.type === 'Buffer' && Array.isArray(data.data)) {
      return Buffer.from(data.data as number[])
    }

    const values = Object.values(data).filter((value): value is number => typeof value === 'number')
    if (values.length > 0) {
      return Buffer.from(values)
    }
  }

  return null
}

function getInboxTypeFromMime(mimeType: string): 'image' | 'voice' | 'video' | 'pdf' {
  if (ALLOWED_IMAGE_TYPES.includes(mimeType)) return 'image'
  if (ALLOWED_AUDIO_TYPES.includes(mimeType)) return 'voice'
  if (ALLOWED_VIDEO_TYPES.includes(mimeType)) return 'video'
  if (ALLOWED_DOCUMENT_TYPES.includes(mimeType)) return 'pdf'
  return 'image'
}

function insertItemWithTags(
  db: ReturnType<typeof requireDatabase>,
  values: typeof inboxItems.$inferInsert,
  tags: string[] | undefined
): { row: typeof inboxItems.$inferSelect; tags: string[] } {
  const now = values.createdAt ?? new Date().toISOString()
  const resolvedTags = tags ?? []

  return db.transaction((tx) => {
    tx.insert(inboxItems).values(values).run()

    if (resolvedTags.length > 0) {
      tx.insert(inboxItemTags)
        .values(
          resolvedTags.map((tag) => ({
            id: generateId(),
            itemId: values.id,
            tag,
            createdAt: now
          }))
        )
        .run()
    }

    const created = tx.select().from(inboxItems).where(eq(inboxItems.id, values.id)).get()
    if (!created) throw new Error('Failed to create item')

    return { row: created, tags: resolvedTags }
  })
}

function emitCapturedAndSync(
  row: typeof inboxItems.$inferSelect,
  tags: string[]
): ContractInboxItem {
  const item = toInboxItem(row, tags)
  emitInboxEvent(InboxChannels.events.CAPTURED, { item: toListItem(row, tags) })
  syncInboxCreate(row.id)
  return item
}

async function captureTextItem(input: CaptureTextInput): Promise<InboxCaptureResponse> {
  try {
    const db = requireDatabase()
    const id = generateId()
    const now = new Date().toISOString()

    const { row, tags } = insertItemWithTags(
      db,
      {
        id,
        type: 'note',
        title:
          input.title || input.content.substring(0, 50) + (input.content.length > 50 ? '...' : ''),
        content: input.content,
        createdAt: now,
        modifiedAt: now,
        processingStatus: 'complete',
        captureSource: input.source ?? null
      },
      input.tags
    )

    return { success: true, item: emitCapturedAndSync(row, tags) }
  } catch (error) {
    return {
      success: false,
      item: null,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

async function captureLinkItem(input: CreateLinkCaptureItemInput): Promise<InboxCaptureResponse> {
  try {
    const db = requireDatabase()
    const id = generateId()
    const now = new Date().toISOString()

    const { row, tags } = insertItemWithTags(
      db,
      {
        id,
        type: input.itemType,
        title: titleFromUrl(input.url),
        content: null,
        sourceUrl: input.url,
        createdAt: now,
        modifiedAt: now,
        processingStatus: 'pending',
        captureSource: input.source ?? null,
        metadata: input.metadata
      },
      input.tags
    )

    return { success: true, item: emitCapturedAndSync(row, tags) }
  } catch (error) {
    return {
      success: false,
      item: null,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

async function captureImageItem(input: CaptureImageInput): Promise<InboxCaptureResponse> {
  try {
    const db = requireDatabase()
    const fileBuffer = normalizeBinaryInput(input.data)
    if (!fileBuffer) {
      return { success: false, item: null, error: 'Invalid file data format' }
    }

    if (fileBuffer.length === 0) {
      return { success: false, item: null, error: 'Empty file data' }
    }

    const id = generateId()
    const now = new Date().toISOString()
    const inboxType = getInboxTypeFromMime(input.mimeType)
    const isImage = ALLOWED_IMAGE_TYPES.includes(input.mimeType)

    const storeResult = await storeInboxAttachment(id, fileBuffer, input.filename, input.mimeType)
    if (!storeResult.success) {
      return {
        success: false,
        item: null,
        error: storeResult.error || 'Failed to store file'
      }
    }

    let thumbnailPath: string | null = null
    let itemMetadata: Record<string, unknown> = {
      originalFilename: input.filename,
      fileSize: fileBuffer.length,
      mimeType: input.mimeType
    }

    if (isImage) {
      try {
        const pipeline = sharp(fileBuffer)
        const metadata = await pipeline.metadata()
        if (metadata.width && metadata.height) {
          itemMetadata = {
            originalFilename: input.filename,
            format: metadata.format || 'unknown',
            width: metadata.width,
            height: metadata.height,
            fileSize: fileBuffer.length,
            hasExif: !!(metadata.exif || metadata.icc)
          }

          try {
            const thumbnailBuffer = await pipeline
              .clone()
              .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toBuffer()

            const thumbnailResult = await storeThumbnail(id, thumbnailBuffer, 'jpg')
            if (thumbnailResult.success && thumbnailResult.thumbnailPath) {
              thumbnailPath = thumbnailResult.thumbnailPath
            }
          } catch (thumbnailError) {
            logger.warn('Failed to generate thumbnail', thumbnailError)
          }
        }
      } catch (metadataError) {
        logger.warn('Failed to read image metadata', metadataError)
      }
    }

    const { row, tags } = insertItemWithTags(
      db,
      {
        id,
        type: inboxType,
        title: input.filename.replace(/\.[^.]+$/, ''),
        content: null,
        createdAt: now,
        modifiedAt: now,
        processingStatus: 'complete',
        attachmentPath: storeResult.path || null,
        thumbnailPath,
        metadata: itemMetadata,
        captureSource: input.source ?? null
      },
      input.tags
    )

    logger.info(`Captured ${inboxType}: ${input.filename} (${fileBuffer.length} bytes)`)

    return { success: true, item: emitCapturedAndSync(row, tags) }
  } catch (error) {
    return {
      success: false,
      item: null,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

async function captureVoiceItem(input: CaptureVoiceInput): Promise<InboxCaptureResponse> {
  const audioBuffer = normalizeBinaryInput(input.data)
  if (!audioBuffer) {
    return { success: false, item: null, error: 'Invalid audio data format' }
  }

  if (audioBuffer.length === 0) {
    return { success: false, item: null, error: 'Empty audio data' }
  }

  return captureVoice({
    data: audioBuffer,
    duration: input.duration,
    format: input.format,
    transcribe: input.transcribe,
    tags: input.tags,
    source: input.source
  })
}

async function getInboxItem(itemId: string): Promise<ContractInboxItem | null> {
  const db = requireDatabase()
  const row = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
  if (!row) {
    return null
  }

  return toInboxItem(row, getItemTags(db, itemId))
}

function storeSocialMetadata(itemId: string, url: string): void {
  const db = requireDatabase()
  const result = extractSocialPost(url)
  if (!result.success || !result.metadata) {
    return
  }

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

function markTranscriptionPending(itemId: string): { success: boolean; error?: string } {
  const db = requireDatabase()
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

  return { success: true }
}

function markMetadataPending(itemId: string): { success: boolean; error?: string } {
  const db = requireDatabase()
  const now = new Date().toISOString()

  db.update(inboxItems)
    .set({
      processingStatus: 'pending',
      processingError: null,
      modifiedAt: now
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

  return { success: true }
}

export function createDesktopInboxDomain() {
  const queryHandlers = createDesktopInboxQueryHandlers()

  return {
    ...createInboxCommands({
      findDuplicateByContent,
      findDuplicateByUrl,
      captureTextItem,
      captureLinkItem,
      captureImageItem,
      captureVoiceItem,
      isSocialPost,
      detectSocialPlatform,
      storeSocialMetadata,
      queueMetadataJob: (itemId, url) => {
        queueInboxMetadataJob(itemId, url)
      },
      getSuggestions,
      trackSuggestionFeedback: (input) => {
        trackSuggestionFeedback(
          input.itemId,
          input.itemType,
          input.suggestedTo,
          input.actualTo,
          input.confidence,
          input.suggestedTags,
          input.actualTags
        )
      },
      fileToFolder,
      convertToNote,
      convertToTask,
      linkToNote,
      linkToNotes,
      snoozeItem,
      unsnoozeItem,
      getSnoozedItems: async () => getSnoozedItems(),
      getItem: (itemId) => {
        const db = requireDatabase()
        const row = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
        if (!row) {
          return null
        }

        return toInboxItem(row, getItemTags(db, itemId))
      },
      markTranscriptionPending,
      markMetadataPending,
      queueTranscriptionJob: (itemId, attachmentPath) => {
        queueInboxTranscriptionJob(itemId, attachmentPath)
      },
      reportError: (scope, error) => {
        logger.error(scope, error)
      }
    }),
    ...createInboxQueries({
      getItem: getInboxItem,
      list: async (input = {}) => queryHandlers.handleList(input),
      getJobs: async (input) => queryHandlers.handleGetJobs(input),
      getTags: async () => queryHandlers.handleGetTags(),
      getStats: async () => queryHandlers.handleGetStats(),
      getStaleThreshold: async () => queryHandlers.handleGetStaleThreshold(),
      setStaleThreshold: async (days) => queryHandlers.handleSetStaleThreshold(days),
      listArchived: async (input = {}) => queryHandlers.handleListArchived(input),
      getFilingHistory: async (input = {}) => queryHandlers.handleGetFilingHistory(input),
      getPatterns: async () => queryHandlers.handleGetPatterns()
    })
  }
}

export function createDesktopInboxCrudHandlers(): InboxCrudHandlers {
  return createInboxCrudHandlers({
    requireDatabase,
    getItemTags,
    toInboxItem,
    emitInboxEvent,
    syncInboxUpdate,
    logger
  })
}

export function createDesktopInboxQueryHandlers(): InboxQueryHandlers {
  return createInboxQueryHandlers({
    requireDatabase,
    getItemTags,
    toListItem
  })
}

export function createDesktopInboxBatchHandlers(
  archiveItem: InboxCrudHandlers['handleArchive']
): InboxBatchHandlers {
  return createInboxBatchHandlers({
    requireDatabase,
    emitInboxEvent,
    archiveItem
  })
}

export { resumeInboxJobs, teardownInboxJobScheduler }
