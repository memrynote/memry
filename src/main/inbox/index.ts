/**
 * Inbox Module
 *
 * Quick capture system for links, text, images, voice memos, PDFs, and clips.
 * Items are stored temporarily until filed to notes or folders.
 *
 * @module main/inbox
 */

// ============================================================================
// Module Exports
// ============================================================================

// Phase 3: URL metadata extraction
export { fetchUrlMetadata, downloadImage, isValidUrl, extractDomain } from './metadata'
export type { UrlMetadata } from './metadata'

// Phase 2: Attachment management
export { resolveAttachmentUrl, getInboxAttachmentsDir, deleteInboxAttachments } from './attachments'

// Phase 5: Filing operations
export { fileToFolder, convertToNote, linkToNote, bulkFileToFolder } from './filing'
export type { FileResponse } from './filing'

// Phase 10: Stats and stale detection
export {
  getStaleThreshold,
  setStaleThreshold,
  isStale,
  getStaleCutoffDate,
  getStaleItemIds,
  countStaleItems,
  incrementCaptureCount,
  incrementProcessedCount,
  incrementDeletedCount,
  getTodayStats,
  getTodayActivity,
  getAverageTimeToProcess
} from './stats'

// Phase 9: Voice capture and transcription
export { captureVoice } from './capture'
export type { CaptureVoiceInput } from './capture'
export { transcribeAudio, retryTranscription, isTranscriptionAvailable } from './transcription'
export type { TranscriptionResult } from './transcription'

// Future phases will add exports for:
// - capture.ts: captureImage, capturePdf, captureClip
// - suggestions.ts: getFilingSuggestions
// - snooze.ts: snoozeItem, unsnoozeItem
