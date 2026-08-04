/**
 * Inbox Capture Handlers
 *
 * Handles capturing various content types to the inbox:
 * - Voice memos with optional transcription
 * - (Future: images, PDFs, clips)
 *
 * @module main/inbox/capture
 */

import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { createLogger } from '../lib/logger'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { getDatabase, requireDatabase } from '../database'
import { generateId } from '../lib/id'
import { inboxItems, inboxItemTags } from '@memry/db-schema/schema/inbox'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import {
  type CaptureResponse,
  type InboxItem,
  type InboxItemListItem,
  type VoiceMetadata
} from '@memry/contracts/inbox-api'
import { storeInboxAttachment, resolveAttachmentUrl } from './attachments'
import { publishProjectionEvent } from '../projections'
import { trackMainEvent } from '../telemetry/track'
import { getVoiceRecordingReadiness } from './transcription'
import { markInboxJobFailed, queueInboxTranscriptionJob } from './jobs'

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
  waveform?: number[]
}

const CaptureVoiceStorageSchema = z.object({
  data: z.instanceof(Buffer),
  duration: z.number().min(0).max(300),
  format: z.enum(['webm', 'mp3', 'wav']),
  transcribe: z.boolean().default(true),
  tags: z.array(z.string().max(50)).max(20).optional(),
  source: z.enum(['quick-capture', 'inline', 'browser-extension', 'api', 'reminder']).optional(),
  waveform: z.array(z.number().min(0).max(1)).max(120).optional()
})

// ============================================================================
// Helpers
// ============================================================================

/**
 * Emit inbox event to all windows
 */
function emitInboxEvent(channel: string, data: unknown): void {
  broadcastToAllWindows(channel, data)
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
    const parsed = CaptureVoiceStorageSchema.parse(input)
    const db = requireDatabase()

    const id = generateId()
    const now = new Date().toISOString()

    let transcriptionReadiness:
      | Awaited<ReturnType<typeof getVoiceRecordingReadiness>>
      | {
          ready: false
          provider: 'local'
          message: string
        }
      | null = null

    if (parsed.transcribe !== false) {
      try {
        transcriptionReadiness = await getVoiceRecordingReadiness()
      } catch (error) {
        transcriptionReadiness = {
          ready: false,
          provider: 'local',
          message:
            error instanceof Error ? error.message : 'Selected transcription provider is not ready.'
        }
      }
    }

    const shouldTranscribe = parsed.transcribe !== false && transcriptionReadiness?.ready === true

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
      fileSize: parsed.data.length,
      waveform: parsed.waveform
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
      if (transcriptionReadiness?.ready) {
        transcriptionStatus = 'pending'
      } else {
        transcriptionStatus = 'failed'
        processingError =
          transcriptionReadiness?.message ?? 'Selected transcription provider is not ready.'
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
    publishProjectionEvent({
      type: 'inbox.upserted',
      itemId: id
    })

    trackMainEvent('voice_recording_completed', {
      surface: 'voice',
      action: 'completed',
      source: parsed.source ?? 'app',
      result: 'success',
      metrics: { durationMs: parsed.duration * 1000, byteCount: parsed.data.length }
    })

    // Persist a durable transcription job instead of relying on in-memory timers.
    if (shouldTranscribe && storageResult.path) {
      log.info(`Queueing transcription for voice memo ${id}`)
      queueInboxTranscriptionJob(id, storageResult.path)
    } else if (parsed.transcribe !== false && storageResult.path && processingError) {
      markInboxJobFailed(
        id,
        'transcription',
        { attachmentPath: storageResult.path },
        processingError
      )
    }

    return { success: true, item }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Voice capture error:', message)
    return { success: false, item: null, error: message }
  }
}
