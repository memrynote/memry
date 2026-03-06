/**
 * Voice Transcription Service
 *
 * Handles audio transcription using OpenAI's Whisper API.
 * Provides async transcription with status updates and event emission.
 *
 * @module main/inbox/transcription
 */

import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { BrowserWindow } from 'electron'
import { createLogger } from '../lib/logger'
import OpenAI from 'openai'
import { toFile } from 'openai/uploads'
import { eq } from 'drizzle-orm'

import { envConfig } from '../index'
import { getDatabase } from '../database'
import { getStatus } from '../vault'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { InboxChannels } from '@memry/contracts/ipc-channels'

const log = createLogger('Inbox:Transcription')

// ============================================================================
// Types
// ============================================================================

export interface TranscriptionResult {
  success: boolean
  transcription?: string
  error?: string
}

// ============================================================================
// Constants
// ============================================================================

/** Supported audio formats for Whisper API */
const SUPPORTED_FORMATS = ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm']

/** Maximum file size for Whisper API: 25MB */
const MAX_FILE_SIZE = 25 * 1024 * 1024

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if transcription service is available (API key configured)
 */
export function isTranscriptionAvailable(): boolean {
  return !!envConfig.openaiApiKey
}

/**
 * Get the OpenAI client instance
 */
function getOpenAIClient(): OpenAI | null {
  if (!envConfig.openaiApiKey) {
    return null
  }
  return new OpenAI({ apiKey: envConfig.openaiApiKey })
}

/**
 * Emit transcription event to all renderer windows
 */
function emitTranscriptionEvent(
  channel: string,
  data: { id: string; transcription?: string; error?: string }
): void {
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
 * Resolve attachment path to absolute path
 */
function resolveAttachmentPath(relativePath: string): string | null {
  const status = getStatus()
  if (!status.isOpen || !status.path) {
    return null
  }
  return path.join(status.path, relativePath)
}

/**
 * Get file extension from path
 */
function getExtension(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase()
}

// ============================================================================
// Main Transcription Function
// ============================================================================

/**
 * Transcribe an audio file using OpenAI Whisper API
 *
 * This function:
 * 1. Updates the item status to 'processing'
 * 2. Reads the audio file
 * 3. Calls the Whisper API
 * 4. Updates the item with transcription result
 * 5. Emits completion event to renderer
 *
 * @param itemId - The inbox item ID
 * @param attachmentPath - Relative path to the audio file (from vault root)
 */
export async function transcribeAudio(
  itemId: string,
  attachmentPath: string
): Promise<TranscriptionResult> {
  const db = requireDatabase()

  // Update status to processing
  db.update(inboxItems)
    .set({
      transcriptionStatus: 'processing',
      modifiedAt: new Date().toISOString()
    })
    .where(eq(inboxItems.id, itemId))
    .run()

  try {
    // Check if API key is available
    const openai = getOpenAIClient()
    if (!openai) {
      const error = 'OpenAI API key not configured. Set OPENAI_API_KEY environment variable.'
      log.warn(error)

      // Update status to failed
      db.update(inboxItems)
        .set({
          transcriptionStatus: 'failed',
          processingError: error,
          modifiedAt: new Date().toISOString()
        })
        .where(eq(inboxItems.id, itemId))
        .run()

      emitTranscriptionEvent(InboxChannels.events.PROCESSING_ERROR, {
        id: itemId,
        error
      })

      return { success: false, error }
    }

    // Resolve absolute path
    const absolutePath = resolveAttachmentPath(attachmentPath)
    if (!absolutePath || !existsSync(absolutePath)) {
      const error = `Audio file not found: ${attachmentPath}`
      log.error(error)

      db.update(inboxItems)
        .set({
          transcriptionStatus: 'failed',
          processingError: error,
          modifiedAt: new Date().toISOString()
        })
        .where(eq(inboxItems.id, itemId))
        .run()

      emitTranscriptionEvent(InboxChannels.events.PROCESSING_ERROR, {
        id: itemId,
        error
      })

      return { success: false, error }
    }

    // Check file format
    const ext = getExtension(absolutePath)
    if (!SUPPORTED_FORMATS.includes(ext)) {
      const error = `Unsupported audio format: ${ext}. Supported: ${SUPPORTED_FORMATS.join(', ')}`
      log.error(error)

      db.update(inboxItems)
        .set({
          transcriptionStatus: 'failed',
          processingError: error,
          modifiedAt: new Date().toISOString()
        })
        .where(eq(inboxItems.id, itemId))
        .run()

      emitTranscriptionEvent(InboxChannels.events.PROCESSING_ERROR, {
        id: itemId,
        error
      })

      return { success: false, error }
    }

    // Read audio file
    const audioBuffer = await readFile(absolutePath)

    // Check file size
    if (audioBuffer.length > MAX_FILE_SIZE) {
      const sizeMB = Math.round(audioBuffer.length / 1024 / 1024)
      const error = `Audio file too large: ${sizeMB}MB. Maximum size is 25MB.`
      log.error(error)

      db.update(inboxItems)
        .set({
          transcriptionStatus: 'failed',
          processingError: error,
          modifiedAt: new Date().toISOString()
        })
        .where(eq(inboxItems.id, itemId))
        .run()

      emitTranscriptionEvent(InboxChannels.events.PROCESSING_ERROR, {
        id: itemId,
        error
      })

      return { success: false, error }
    }

    log.info(`Starting transcription for item ${itemId} (${ext} format)`)

    // Call Whisper API
    const file = await toFile(audioBuffer, `audio.${ext}`, {
      type: `audio/${ext}`
    })

    const response = await openai.audio.transcriptions.create({
      file,
      model: envConfig.whisperModel || 'whisper-1',
      response_format: 'text'
    })

    // When response_format is 'text', the API returns a string directly
    const transcription = response as unknown as string

    log.info(`Success for item ${itemId}: "${transcription.substring(0, 50)}..."`)

    // Update item with transcription
    db.update(inboxItems)
      .set({
        transcription,
        transcriptionStatus: 'complete',
        processingError: null,
        modifiedAt: new Date().toISOString()
      })
      .where(eq(inboxItems.id, itemId))
      .run()

    // Emit success event
    emitTranscriptionEvent(InboxChannels.events.TRANSCRIPTION_COMPLETE, {
      id: itemId,
      transcription
    })

    return { success: true, transcription }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown transcription error'
    log.error(`Error for item ${itemId}:`, errorMessage)

    // Check for specific OpenAI errors
    let userFriendlyError = errorMessage
    if (errorMessage.includes('rate_limit')) {
      userFriendlyError = 'Rate limit exceeded. Please try again later.'
    } else if (errorMessage.includes('invalid_api_key')) {
      userFriendlyError = 'Invalid OpenAI API key. Please check your settings.'
    } else if (errorMessage.includes('insufficient_quota')) {
      userFriendlyError = 'OpenAI quota exceeded. Please check your billing.'
    }

    // Update status to failed
    db.update(inboxItems)
      .set({
        transcriptionStatus: 'failed',
        processingError: userFriendlyError,
        modifiedAt: new Date().toISOString()
      })
      .where(eq(inboxItems.id, itemId))
      .run()

    // Emit error event
    emitTranscriptionEvent(InboxChannels.events.PROCESSING_ERROR, {
      id: itemId,
      error: userFriendlyError
    })

    return { success: false, error: userFriendlyError }
  }
}

/**
 * Retry transcription for a failed voice item
 *
 * @param itemId - The inbox item ID to retry
 */
export async function retryTranscription(itemId: string): Promise<TranscriptionResult> {
  const db = requireDatabase()

  // Get the item
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

  // Reset status to pending
  db.update(inboxItems)
    .set({
      transcriptionStatus: 'pending',
      processingError: null,
      modifiedAt: new Date().toISOString()
    })
    .where(eq(inboxItems.id, itemId))
    .run()

  // Start transcription (async, don't await here for non-blocking behavior)
  // The caller can await if they want to wait for completion
  return transcribeAudio(itemId, item.attachmentPath)
}
