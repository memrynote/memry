/**
 * WikiLink Resolution Utility
 *
 * Handles format-aware WikiLink resolution, determining whether a link
 * should open a note editor or a specific file viewer (image, video, PDF, audio).
 *
 * @module lib/wikilink-resolver
 */

import { notesService } from '@/services/notes-service'
import { getFileType, getExtension, isSupported } from '@memry/shared/file-types'

// ============================================================================
// Types
// ============================================================================

export type ResolutionType = 'note' | 'file' | 'create' | 'not-found'

export interface ResolvedWikiLink {
  type: ResolutionType
  id: string
  title: string
  fileType: 'markdown' | 'pdf' | 'image' | 'audio' | 'video'
  icon: string
}

// ============================================================================
// Icon Mapping
// ============================================================================

const FILE_TYPE_ICONS: Record<string, string> = {
  markdown: 'file-text',
  pdf: 'file-pdf',
  image: 'file-image',
  audio: 'file-audio',
  video: 'file-video'
}

// ============================================================================
// Main Resolution Function
// ============================================================================

/**
 * Resolve a WikiLink target to determine how it should be opened.
 *
 * Resolution strategy:
 * 1. Check if target has a known file extension
 * 2. Query the database for a matching title
 * 3. Based on fileType, determine if it's a note or file
 * 4. If not found and has file extension, return 'not-found'
 * 5. If not found and no extension, return 'create' to make a new note
 *
 * @param target - The WikiLink target text (e.g., "My Note" or "photo.png")
 * @returns Resolution result with type, id, title, fileType, and icon
 */
export async function resolveWikiLink(target: string): Promise<ResolvedWikiLink> {
  const trimmedTarget = target.trim()
  if (!trimmedTarget) {
    return {
      type: 'not-found',
      id: '',
      title: target,
      fileType: 'markdown',
      icon: 'file-text'
    }
  }

  // Check if target has a known file extension
  const extension = getExtension(trimmedTarget)
  const hasKnownExtension = extension !== '' && isSupported(extension)

  // Query the database for a matching title
  const resolved = await notesService.resolveByTitle(trimmedTarget)

  if (resolved) {
    // Found a match - determine if it's a note or file
    const isFile = resolved.fileType !== 'markdown'
    return {
      type: isFile ? 'file' : 'note',
      id: resolved.id,
      title: resolved.title,
      fileType: resolved.fileType,
      icon: FILE_TYPE_ICONS[resolved.fileType] || 'file-text'
    }
  }

  // Not found in database
  if (hasKnownExtension) {
    // Has a file extension but doesn't exist - return not-found
    // This prevents creating notes with file-like names
    const detectedFileType = getFileType(extension) || 'markdown'
    return {
      type: 'not-found',
      id: '',
      title: trimmedTarget,
      fileType: detectedFileType as ResolvedWikiLink['fileType'],
      icon: FILE_TYPE_ICONS[detectedFileType] || 'file'
    }
  }

  // No extension and not found - this will create a new note
  return {
    type: 'create',
    id: '',
    title: trimmedTarget,
    fileType: 'markdown',
    icon: 'file-text'
  }
}

/**
 * Check if a WikiLink target looks like a file reference.
 * Useful for UI hints or styling.
 */
export function hasFileExtension(target: string): boolean {
  const extension = getExtension(target.trim())
  return extension !== '' && isSupported(extension)
}
