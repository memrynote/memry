/**
 * Inbox Capture Handlers
 *
 * Handles capturing various content types to the inbox:
 * - Voice memos with optional transcription
 * - (Future: images, PDFs, clips)
 *
 * @module main/inbox/capture
 */

import { BrowserWindow } from 'electron'
import { eq } from 'drizzle-orm'

import { createLogger } from '../lib/logger'
import { getDatabase, type DrizzleDb } from '../database'
import { generateId } from '../lib/id'
import { inboxItems, inboxItemTags } from '@memry/db-schema/schema/inbox'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import {
  CaptureVoiceSchema,
  type CaptureResponse,
  type InboxItem,
  type InboxItemListItem,
  type VoiceMetadata
} from '@memry/contracts/inbox-api'
import { storeInboxAttachment, resolveAttachmentUrl } from './attachments'
import { transcribeAudio, isTranscriptionAvailable } from './transcription'

const log = createLogger('Inbox:Capture')

// ============================================================================
// Types
// ============================================================================

export interface CaptureVoiceInput {
  data: Buffer
  duration: number
  format: 'webm' | 'mp3' | 'wav'
  transcribe?: boolean
  tags?: string[]
  source?: 'quick-capture' | 'inline' | 'browser-extension' | 'api' | 'reminder'
}

// ============================================================================
// Helpers
// ============================================================================

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
 * Emit inbox event to all windows
 */
function emitInboxEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

/**
 * Get tags for an inbox item
 */
function getItemTags(db: ReturnType<typeof getDatabase>, itemId: string): string[] {
  const tags = db.select().from(inboxItemTags).where(eq(inboxItemTags.itemId, itemId)).all()
  return tags.map((t) => t.tag)
}

/**
 * Check if an item is stale (older than threshold)
 */
function isStale(createdAt: string, thresholdDays = 7): boolean {
  const created = new Date(createdAt)
  const now = new Date()
  const diffDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24)
  return diffDays > thresholdDays
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
    transcriptionStatus: row.transcriptionStatus as InboxItemListItem['transcriptionStatus']
  }
}

/**
 * Get MIME type for audio format
 */
function getAudioMimeType(format: string): string {
  const mimeTypes: Record<string, string> = {
    webm: 'audio/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav'
  }
  return mimeTypes[format] || 'audio/webm'
}

// ============================================================================
// Voice Capture
// ============================================================================

/**
 * Capture a voice memo to the inbox
 *
 * Flow:
 * 1. Validate input
 * 2. Generate unique ID
 * 3. Store audio file to vault/attachments/inbox/{itemId}/
 * 4. Create inbox item in database
 * 5. Optionally trigger async transcription
 * 6. Return created item
 *
 * @param input - Voice capture input with audio data, duration, format
 * @returns CaptureResponse with created item or error
 */
export async function captureVoice(input: CaptureVoiceInput): Promise<CaptureResponse> {
  try {
    // Validate input
    const parsed = CaptureVoiceSchema.parse(input)
    const db = requireDatabase()

    const id = generateId()
    const now = new Date().toISOString()

    // Determine if we should transcribe
    const shouldTranscribe = parsed.transcribe !== false && isTranscriptionAvailable()

    // Store audio file
    const filename = `voice-memo.${parsed.format}`
    const mimeType = getAudioMimeType(parsed.format)

    const storageResult = await storeInboxAttachment(id, parsed.data, filename, mimeType)

    if (!storageResult.success) {
      return {
        success: false,
        item: null,
        error: storageResult.error || 'Failed to store audio file'
      }
    }

    // Create metadata
    const metadata: VoiceMetadata = {
      duration: parsed.duration,
      format: parsed.format,
      fileSize: parsed.data.length
    }

    // Format title with duration
    const minutes = Math.floor(parsed.duration / 60)
    const seconds = Math.round(parsed.duration % 60)
    const durationStr = `${minutes}:${seconds.toString().padStart(2, '0')}`
    const title = `Voice memo (${durationStr})`

    // Determine initial transcription status
    let transcriptionStatus: string | null = null
    let processingError: string | null = null

    if (parsed.transcribe !== false) {
      if (isTranscriptionAvailable()) {
        transcriptionStatus = 'pending'
      } else {
        transcriptionStatus = 'failed'
        processingError = 'OpenAI API key not configured'
      }
    }

    // Insert inbox item
    db.insert(inboxItems)
      .values({
        id,
        type: 'voice',
        title,
        content: null,
        createdAt: now,
        modifiedAt: now,
        processingStatus: 'complete',
        processingError,
        metadata,
        attachmentPath: storageResult.path,
        transcription: null,
        transcriptionStatus,
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

    // Emit captured event
    emitInboxEvent(InboxChannels.events.CAPTURED, { item: toListItem(created, tags) })

    // Trigger async transcription if enabled and available
    if (shouldTranscribe && storageResult.path) {
      log.info(`Triggering transcription for voice memo ${id}`)

      // Run transcription asynchronously (don't await)
      setImmediate(() => {
        transcribeAudio(id, storageResult.path!).catch((err) => {
          log.error('Background transcription error:', err)
        })
      })
    }

    return { success: true, item }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Voice capture error:', message)
    return { success: false, item: null, error: message }
  }
}
