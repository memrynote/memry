/**
 * Sidebar tab data builders
 *
 * One definition of "what tab does this sidebar row open", so a menu
 * command and a plain click can never drift apart — and so the notes
 * sidebar's two renderers (notes-tree and virtualized-notes-tree) describe the
 * same note the same way.
 */

import { getTabIconForFileType, type FileType } from '@memry/shared/file-types'
import { getDisplayName } from '@/components/notes-tree-utils'
import type { OpenTargetTab } from '@/hooks/use-open-target'

/** The subset of a note row this module needs; both trees carry all of it. */
interface NoteLike {
  id: string
  path: string
  emoji?: string | null
  fileType?: string | null
}

/**
 * Non-markdown files open in the file viewer, not the editor — the type drives
 * both the route and the icon, so it must be decided in one place.
 */
export const noteTabData = (note: NoteLike): OpenTargetTab => {
  const fileType = (note.fileType ?? 'markdown') as FileType
  const isMarkdown = fileType === 'markdown'

  return {
    type: isMarkdown ? 'note' : 'file',
    title: getDisplayName(note.path),
    icon: getTabIconForFileType(fileType),
    emoji: isMarkdown ? note.emoji : undefined,
    path: isMarkdown ? `/notes/${note.id}` : `/file/${note.id}`,
    entityId: note.id,
    isPinned: false,
    isModified: false,
    isPreview: false,
    isDeleted: false
  }
}

/**
 * `untitledLabel` is passed in rather than translated here: this module is not a
 * component, and the canvas tree already holds the `common` namespace.
 */
export const canvasTabData = (
  canvas: { id: string; title?: string | null },
  untitledLabel: string
): OpenTargetTab => ({
  type: 'canvas',
  title: canvas.title || untitledLabel,
  icon: 'pen-tool',
  path: `/canvas/${canvas.id}`,
  entityId: canvas.id,
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false
})

export const folderTabData = (folderPath: string, icon?: string | null): OpenTargetTab => ({
  type: 'folder',
  title: folderPath.split('/').pop() || 'Folder',
  icon: 'folder',
  emoji: icon ?? undefined,
  path: `/folder/${encodeURIComponent(folderPath)}`,
  entityId: folderPath,
  isPinned: false,
  isModified: false,
  isPreview: false,
  isDeleted: false
})
