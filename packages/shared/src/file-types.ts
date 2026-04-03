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

export function getExtensionFromMimeType(mimeType: string): string | null {
  for (const [ext, mime] of Object.entries(MIME_TYPES)) {
    if (mime === mimeType) return ext
  }
  return null
}

export function getDefaultExtension(fileType: FileType): string {
  return SUPPORTED_EXTENSIONS[fileType][0]
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
 * Get the tab icon identifier for a file type
 * Used when opening file tabs to set the correct icon
 */
export function getTabIconForFileType(fileType: FileType): string {
  const icons: Record<FileType, string> = {
    markdown: 'file-text',
    pdf: 'file-pdf',
    image: 'file-image',
    audio: 'file-audio',
    video: 'file-video'
  }
  return icons[fileType]
}

// ============================================================================
// Glob Patterns (for file watching)
// ============================================================================

/**
 * Check if a path matches any supported file type
 */
export function isSupportedPath(filePath: string): boolean {
  const ext = getExtension(filePath)
  return ext !== '' && isSupported(ext)
}

/**
 * Check if a file type represents binary content (anything non-markdown)
 */
export function isBinaryFileType(fileType: string): boolean {
  return fileType !== 'markdown'
}
