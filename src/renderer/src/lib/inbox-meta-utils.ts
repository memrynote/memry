/**
 * Inbox Meta Utilities
 *
 * Helpers for generating meta lines and preview content for inbox items.
 */

import type {
  InboxItem,
  LinkItem,
  NoteItem,
  ImageItem,
  VoiceItem,
  PdfItem,
  WebclipItem,
  FileItem,
  VideoItem,
} from '@/data/inbox-types'
import { formatRelativeTime, formatDuration } from './inbox-utils'

// ============================================================================
// META LINE GENERATORS
// ============================================================================

/**
 * Get the meta line for an inbox item based on its type
 *
 * Format by type:
 * - link: "fortelabs.com · 2 hours ago"
 * - note: "2 hours ago · 847 words"
 * - image: "2 hours ago · 1920×1080 · 2.4 MB"
 * - voice: "2 hours ago · 2:34 duration"
 * - pdf: "Yesterday · 12 pages · 3.2 MB"
 * - webclip: "medium.com · 3 hours ago · 2 highlights"
 * - file: "2 hours ago · .docx · 156 KB"
 * - video: "1 hour ago · 5:23 · YouTube"
 */
export function getMetaLine(item: InboxItem): string {
  const timestamp = formatRelativeTime(item.createdAt)

  switch (item.type) {
    case 'link': {
      const linkItem = item as LinkItem
      return `${linkItem.domain} · ${timestamp}`
    }

    case 'note': {
      const noteItem = item as NoteItem
      return `${timestamp} · ${noteItem.wordCount} words`
    }

    case 'image': {
      const imageItem = item as ImageItem
      const dims = `${imageItem.dimensions.width}×${imageItem.dimensions.height}`
      return `${timestamp} · ${dims} · ${imageItem.fileSize}`
    }

    case 'voice': {
      const voiceItem = item as VoiceItem
      const duration = formatDuration(voiceItem.duration)
      return `${timestamp} · ${duration} duration`
    }

    case 'pdf': {
      const pdfItem = item as PdfItem
      const pages = pdfItem.pageCount === 1 ? '1 page' : `${pdfItem.pageCount} pages`
      return `${timestamp} · ${pages} · ${pdfItem.fileSize}`
    }

    case 'webclip': {
      const webclipItem = item as WebclipItem
      const highlights = webclipItem.highlights.length
      const highlightText = highlights === 1 ? '1 highlight' : `${highlights} highlights`
      return `${webclipItem.domain} · ${timestamp} · ${highlightText}`
    }

    case 'file': {
      const fileItem = item as FileItem
      return `${timestamp} · .${fileItem.extension} · ${fileItem.fileSize}`
    }

    case 'video': {
      const videoItem = item as VideoItem
      const duration = formatDuration(videoItem.duration)
      const source = videoItem.videoSource === 'local' ? 'Local' : capitalizeFirst(videoItem.videoSource)
      return `${timestamp} · ${duration} · ${source}`
    }

    default:
      return timestamp
  }
}

/**
 * Get a preview placeholder text for an inbox item
 * This will be replaced by type-specific renderers in prompt 06
 */
export function getPreviewPlaceholder(item: InboxItem): string {
  switch (item.type) {
    case 'link': {
      const linkItem = item as LinkItem
      return linkItem.excerpt || 'No preview available'
    }

    case 'note': {
      const noteItem = item as NoteItem
      return noteItem.preview || noteItem.content.slice(0, 150) + '...'
    }

    case 'image': {
      const imageItem = item as ImageItem
      return imageItem.caption || 'Image preview'
    }

    case 'voice': {
      const voiceItem = item as VoiceItem
      if (voiceItem.transcription) {
        return `"${voiceItem.transcription.slice(0, 120)}..."`
      }
      return voiceItem.isAutoTranscribed ? 'Transcription available' : 'No transcription'
    }

    case 'pdf': {
      const pdfItem = item as PdfItem
      return pdfItem.textPreview || 'PDF document'
    }

    case 'webclip': {
      const webclipItem = item as WebclipItem
      if (webclipItem.highlights.length > 0) {
        return `"${webclipItem.highlights[0].text.slice(0, 120)}..."`
      }
      return 'Web clipping'
    }

    case 'file': {
      const fileItem = item as FileItem
      return `${fileItem.fileName}`
    }

    case 'video': {
      const videoItem = item as VideoItem
      const source = videoItem.videoSource === 'local' ? 'Local video' : `${capitalizeFirst(videoItem.videoSource)} video`
      return source
    }

    default:
      return 'Preview not available'
  }
}

/**
 * Get detailed stats for an item (used in expanded view)
 */
export function getDetailedStats(item: InboxItem): string[] {
  const stats: string[] = []
  const timestamp = formatRelativeTime(item.createdAt)
  stats.push(`Captured ${timestamp}`)

  switch (item.type) {
    case 'link': {
      const linkItem = item as LinkItem
      stats.push(`Source: ${linkItem.domain}`)
      if (linkItem.heroImage) stats.push('Has preview image')
      break
    }

    case 'note': {
      const noteItem = item as NoteItem
      stats.push(`${noteItem.wordCount} words`)
      break
    }

    case 'image': {
      const imageItem = item as ImageItem
      stats.push(`${imageItem.dimensions.width} × ${imageItem.dimensions.height}`)
      stats.push(imageItem.fileSize)
      break
    }

    case 'voice': {
      const voiceItem = item as VoiceItem
      stats.push(formatDuration(voiceItem.duration))
      if (voiceItem.transcription) stats.push('Transcribed')
      break
    }

    case 'pdf': {
      const pdfItem = item as PdfItem
      stats.push(`${pdfItem.pageCount} pages`)
      stats.push(pdfItem.fileSize)
      break
    }

    case 'webclip': {
      const webclipItem = item as WebclipItem
      stats.push(`${webclipItem.highlights.length} highlights`)
      stats.push(`From ${webclipItem.domain}`)
      break
    }

    case 'file': {
      const fileItem = item as FileItem
      stats.push(`.${fileItem.extension.toUpperCase()}`)
      stats.push(fileItem.fileSize)
      break
    }

    case 'video': {
      const videoItem = item as VideoItem
      stats.push(formatDuration(videoItem.duration))
      stats.push(capitalizeFirst(videoItem.videoSource))
      break
    }
  }

  return stats
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function capitalizeFirst(str: string): string {
  if (!str) return str
  return str.charAt(0).toUpperCase() + str.slice(1)
}

/**
 * Get source display name for an item
 */
export function getSourceDisplay(source: string): string {
  const sourceMap: Record<string, string> = {
    'paste': 'Pasted',
    'drag-drop': 'Dropped',
    'browser-ext': 'Browser',
    'share-menu': 'Shared',
    'voice-record': 'Recorded',
    'quick-capture': 'Quick Capture',
    'import': 'Imported',
    'api': 'API',
  }
  return sourceMap[source] || source
}
