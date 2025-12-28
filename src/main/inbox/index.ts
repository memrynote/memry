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

// Future phases will add exports for:
// - capture.ts: captureText, captureLink, captureImage, captureVoice, capturePdf, captureClip
// - transcription.ts: transcribeAudio
// - filing.ts: fileToFolder, convertToNote, linkToNote
// - suggestions.ts: getFilingSuggestions
// - snooze.ts: snoozeItem, unsnoozeItem
// - stats.ts: getInboxStats, getCapturePatterns
