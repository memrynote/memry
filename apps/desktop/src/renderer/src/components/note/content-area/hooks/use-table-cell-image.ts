/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Pasting or dropping an image while the caret is inside a table cell (#1640).
 *
 * BlockNote's own handlers answer an image file with an image BLOCK, and a
 * `tableCell` holds inline content only — so the block was pushed out of the
 * table (or dropped entirely) and users could not put a picture in a cell at
 * all. Both gestures are intercepted in the capture phase, before BlockNote
 * sees them, and only when the target really is a cell; everywhere else the
 * event is left completely alone, so the block-image path is untouched.
 *
 * The `inlineImage` node this inserts is registered in BOTH processes
 * (@memry/editor-schema), which is what stops y-prosemirror from deleting it
 * out of the shared Y.Doc on its next round trip.
 */

import { useCallback, useEffect } from 'react'
import { TextSelection } from '@tiptap/pm/state'
import { createInlineImageContent } from '@memry/editor-schema/inline'
import { toast } from 'sonner'
import { getI18n } from 'react-i18next'
import { notesService } from '@/services/notes-service'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { isImageFile } from './use-editor-file-upload'

const log = createLogger('Hook:TableCellImage')

/** The ProseMirror node names a table cell can have in a BlockNote table. */
const CELL_NODE_TYPES = new Set(['tableCell', 'tableHeader'])

/**
 * True when the given ProseMirror selection sits inside a table cell.
 *
 * Walked over the resolved position's ancestors rather than read off the DOM:
 * the caret can be in a cell whose `<td>` is not the event target (a paste
 * fired from the document, a click on padding), and the document is the thing
 * being edited.
 */
export function isSelectionInTableCell(state: any): boolean {
  const $from = state?.selection?.$from
  if (!$from) return false
  for (let depth = $from.depth; depth > 0; depth--) {
    if (CELL_NODE_TYPES.has($from.node(depth).type.name)) return true
  }
  return false
}

interface TableCellImageParams {
  editor: any
  editable?: boolean
  containerRef: React.RefObject<HTMLDivElement | null>
  noteIdRef: React.RefObject<string | undefined>
}

export function useTableCellImage({
  editor,
  editable,
  containerRef,
  noteIdRef
}: TableCellImageParams): void {
  /**
   * Uploads into the note's attachments and inserts the result at the caret.
   * The vault-relative path `uploadAttachment` returns is what goes in the
   * node's `src` — never a resolved absolute URL, which would pin the note to
   * this machine's vault path the moment it is written back to markdown.
   */
  const insertImages = useCallback(
    async (files: File[]): Promise<void> => {
      const noteId = noteIdRef.current
      if (!noteId) return

      for (const file of files) {
        try {
          const result = await notesService.uploadAttachment(noteId, file)
          if (!result.success || !result.path) {
            throw new Error(result.error || 'Upload failed')
          }
          editor.insertInlineContent([
            createInlineImageContent(result.path, result.name || file.name)
          ])
        } catch (error) {
          log.error('Failed to add image to table cell', file.name, error)
          trackRendererError('editor_table_cell_image', error)
          const t = getI18n().getFixedT(null, 'notes')
          toast.error(extractErrorMessage(error, t('editor.upload.failed')))
        }
      }
    },
    [editor, noteIdRef]
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container || !editable) return

    const imageFilesFrom = (data: DataTransfer | null): File[] =>
      Array.from(data?.files ?? []).filter(isImageFile)

    const onPaste = (e: ClipboardEvent): void => {
      const files = imageFilesFrom(e.clipboardData)
      if (files.length === 0) return
      const view = editor?.prosemirrorView
      if (!view || !isSelectionInTableCell(view.state)) return

      e.preventDefault()
      e.stopPropagation()
      void insertImages(files)
    }

    /**
     * A drop carries no caret, so the cell is found from the pointer and the
     * selection is moved there first — otherwise the image would land wherever
     * the caret happened to be, which for a drop onto a table is never right.
     */
    const onDrop = (e: DragEvent): void => {
      const files = imageFilesFrom(e.dataTransfer)
      if (files.length === 0) return
      const target = e.target as HTMLElement | null
      if (!target?.closest?.('td, th')) return

      const view = editor?.prosemirrorView
      if (!view) return
      const at = view.posAtCoords({ left: e.clientX, top: e.clientY })
      if (!at) return

      e.preventDefault()
      e.stopPropagation()

      const selection = TextSelection.create(view.state.doc, at.pos)
      view.dispatch(view.state.tr.setSelection(selection))
      if (!isSelectionInTableCell(view.state)) return
      void insertImages(files)
    }

    container.addEventListener('paste', onPaste, { capture: true })
    container.addEventListener('drop', onDrop, { capture: true })
    return () => {
      container.removeEventListener('paste', onPaste, { capture: true })
      container.removeEventListener('drop', onDrop, { capture: true })
    }
  }, [editor, editable, containerRef, insertImages])
}
