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
export { fileToFolder, convertToNote, convertToTask, linkToNote, bulkFileToFolder } from './filing'
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
  incrementArchivedCount,
  getTodayStats,
  getTodayActivity,
  getAverageTimeToProcess
} from './stats'

// Phase 9: Voice capture and transcription
export { captureVoice } from './capture'
export type { CaptureVoiceInput } from './capture'
export { transcribeAudio, retryTranscription, getVoiceRecordingReadiness } from './transcription'
export type { TranscriptionResult } from './transcription'

// Phase 16: Social media post extraction
export {
  extractSocialPost,
  detectSocialPlatform,
  isSocialPost,
  createFallbackSocialMetadata
} from './social'
export type { SocialExtractionResult } from './social'

// Phase 18: Snooze functionality
export {
  snoozeItem,
  unsnoozeItem,
  getSnoozedItems,
  getDueSnoozeItems,
  bulkSnoozeItems,
  checkDueItemsOnStartup,
  startSnoozeScheduler,
  stopSnoozeScheduler,
  isSchedulerActive
} from './snooze'
export type { SnoozeInput, SnoozeResult, SnoozedItem } from './snooze'

// Future phases will add exports for:
// - capture.ts: captureImage, capturePdf, captureClip
// - suggestions.ts: getFilingSuggestions
