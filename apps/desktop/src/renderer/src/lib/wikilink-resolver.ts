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
import { splitWikiTarget, isBlockReference } from '@memry/shared/wiki-target'

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
  /**
   * The heading `[[Note#Heading]]` addresses, or `null` when the link names no
   * heading — or names one we cannot scroll to (a `#^block-id` reference).
   * Callers use it to position the note they just opened; it never affects
   * WHICH note is opened.
   */
  heading: string | null
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

/** Shapes a resolved metadata row as a resolution, note or file. */
function resolvedRecord(
  resolved: { id: string; title: string; fileType: ResolvedWikiLink['fileType'] },
  heading: string | null
): ResolvedWikiLink {
  const isFile = resolved.fileType !== 'markdown'
  return {
    type: isFile ? 'file' : 'note',
    id: resolved.id,
    title: resolved.title,
    fileType: resolved.fileType,
    icon: FILE_TYPE_ICONS[resolved.fileType] || 'file-text',
    heading
  }
}

/**
 * Resolve a WikiLink target to determine how it should be opened.
 *
 * Resolution strategy:
 * 1. Split `[[Note#Heading]]` and look the NOTE half up first
 * 2. Fall back to the raw string, so a note really called `Sprint #4` wins
 * 3. Check if target has a known file extension
 * 4. Based on fileType, determine if it's a note or file
 * 5. If not found and has file extension, return 'not-found'
 * 6. If not found and no extension, return 'create' to make a new note
 *
 * Step 1 before step 2 is the whole fix for A15, and the order is load-bearing
 * in both directions — see `@memry/shared/wiki-target` for why.
 *
 * @param target - The WikiLink target text (e.g., "My Note" or "photo.png")
 * @returns Resolution result with type, id, title, fileType, icon and heading
 */
export async function resolveWikiLink(target: string): Promise<ResolvedWikiLink> {
  const trimmedTarget = target.trim()
  if (!trimmedTarget) {
    return {
      type: 'not-found',
      id: '',
      title: target,
      fileType: 'markdown',
      icon: 'file-text',
      heading: null
    }
  }

  const { note, heading } = splitWikiTarget(trimmedTarget)
  const hasHeading = heading !== null
  // A block reference names a heading we can never find, so it is carried as
  // "no heading": the note still opens, at the top.
  const anchor = heading !== null && !isBlockReference(heading) && heading !== '' ? heading : null

  // `[[#Heading]]` addresses the note it is written in. The page answers that
  // without a lookup, so there is nothing here to resolve.
  if (hasHeading && !note) {
    return {
      type: 'not-found',
      id: '',
      title: trimmedTarget,
      fileType: 'markdown',
      icon: 'file-text',
      heading: anchor
    }
  }

  // Check if target has a known file extension
  const extension = getExtension(trimmedTarget)
  const hasKnownExtension = extension !== '' && isSupported(extension)

  // Split first: `[[Note#Heading]]` must reach `Note`, never the
  // `Note#Heading.md` this bug used to create.
  if (hasHeading) {
    const bySplit = await notesService.resolveByTitle(note)
    if (bySplit) return resolvedRecord(bySplit, anchor)
  }

  // Raw second: the `#` was part of the name after all, so it names no heading.
  const resolved = await notesService.resolveByTitle(trimmedTarget)
  if (resolved) return resolvedRecord(resolved, null)

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
      icon: FILE_TYPE_ICONS[detectedFileType] || 'file',
      heading: anchor
    }
  }

  // No extension and not found - this will create a new note. It is created
  // under the NOTE half: minting `Note#Heading.md` is the bug itself, and a
  // heading separator has no business in a filename.
  return {
    type: 'create',
    id: '',
    title: hasHeading ? note : trimmedTarget,
    fileType: 'markdown',
    icon: 'file-text',
    heading: anchor
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
