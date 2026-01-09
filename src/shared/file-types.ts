/**
 * File Type Constants and Utilities
 *
 * Central definition for all supported file types in the vault.
 * Used across main process, preload, and renderer.
 *
 * @module shared/file-types
 */

// ============================================================================
// File Type Definitions
// ============================================================================

export type FileType = 'markdown' | 'pdf' | 'image' | 'audio' | 'video'

export const SUPPORTED_EXTENSIONS: Record<FileType, readonly string[]> = {
  markdown: ['md'],
  pdf: ['pdf'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
  audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'],
  video: ['mp4', 'webm', 'mov', 'avi', 'mkv']
} as const

// ============================================================================
// MIME Type Mappings
// ============================================================================

export const MIME_TYPES: Record<string, string> = {
  // Markdown
  md: 'text/markdown',

  // PDF
  pdf: 'application/pdf',

  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',

  // Audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',

  // Video
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska'
} as const

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get all supported file extensions as a flat array
 */
export function getAllSupportedExtensions(): string[] {
  return Object.values(SUPPORTED_EXTENSIONS).flat()
}

/**
 * Check if a file extension is supported
 */
export function isSupported(extension: string): boolean {
  const ext = extension.toLowerCase().replace(/^\./, '')
  return getAllSupportedExtensions().includes(ext)
}

/**
 * Get the FileType for a given extension
 * @returns FileType or null if not supported
 */
export function getFileType(extension: string): FileType | null {
  const ext = extension.toLowerCase().replace(/^\./, '')

  for (const [fileType, extensions] of Object.entries(SUPPORTED_EXTENSIONS)) {
    if (extensions.includes(ext)) {
      return fileType as FileType
    }
  }

  return null
}

/**
 * Get the MIME type for a given extension
 * @returns MIME type string or null if not supported
 */
export function getMimeType(extension: string): string | null {
  const ext = extension.toLowerCase().replace(/^\./, '')
  return MIME_TYPES[ext] ?? null
}

/**
 * Extract extension from a file path or filename
 */
export function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.')
  if (lastDot === -1 || lastDot === filePath.length - 1) {
    return ''
  }
  return filePath.slice(lastDot + 1).toLowerCase()
}

/**
 * Check if a file type is editable in-app (only markdown)
 */
export function isEditable(fileType: FileType): boolean {
  return fileType === 'markdown'
}

/**
 * Check if a file type is a media type (audio or video)
 */
export function isMedia(fileType: FileType): boolean {
  return fileType === 'audio' || fileType === 'video'
}

/**
 * Get a human-readable label for a file type
 */
export function getFileTypeLabel(fileType: FileType): string {
  const labels: Record<FileType, string> = {
    markdown: 'Markdown',
    pdf: 'PDF',
    image: 'Image',
    audio: 'Audio',
    video: 'Video'
  }
  return labels[fileType]
}

// ============================================================================
// File Type Icons (for use with Lucide icons)
// ============================================================================

/**
 * Get the Lucide icon name for a file type
 * Use with: import { FileText, FileType2, Image, Music, Video } from 'lucide-react'
 */
export function getFileTypeIconName(fileType: FileType): string {
  const icons: Record<FileType, string> = {
    markdown: 'FileText',
    pdf: 'FileType2',
    image: 'Image',
    audio: 'Music',
    video: 'Video'
  }
  return icons[fileType]
}

// ============================================================================
// Glob Patterns (for file watching)
// ============================================================================

/**
 * Get glob patterns for all supported file types
 * Used by chokidar file watcher
 */
export function getSupportedGlobPatterns(): string[] {
  const extensions = getAllSupportedExtensions()
  return extensions.map((ext) => `**/*.${ext}`)
}

/**
 * Check if a path matches any supported file type
 */
export function isSupportedPath(filePath: string): boolean {
  const ext = getExtension(filePath)
  return ext !== '' && isSupported(ext)
}
