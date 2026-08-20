/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Getting an image into a table cell (#1640) — the three ways people try it:
 * `/image` from the slash menu, a paste, and a drop.
 *
 * BlockNote answers all three with an image BLOCK, and a `tableCell` holds
 * inline content only. `/image` was the worst of the three: the block landed
 * AFTER the whole table and took the caret out of the cell with it, so the cell
 * stayed empty and there was no way to put a picture in one at all.
 *
 * Paste and drop are intercepted in the capture phase, before BlockNote sees
 * them, and only when the target really is a cell; everywhere else the event is
 * left completely alone, so the block-image path is untouched. `/image` is
 * handled by `pickImageForCell`, which ContentArea binds to the menu row's
 * `onItemClick` while the caret is in a cell.
 *
 * The `inlineImage` node this inserts is registered in BOTH processes
 * (@memry/editor-schema), which is what stops y-prosemirror from deleting it
 * out of the shared Y.Doc on its next round trip.
 */

import { useCallback, useEffect, useRef } from 'react'
import { TextSelection } from '@tiptap/pm/state'
import { createInlineImageContent } from '@memry/editor-schema/inline'
import { toast } from 'sonner'
import { getI18n } from 'react-i18next'
import { notesService } from '@/services/notes-service'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { isImageFile } from './use-editor-file-upload'
// One definition of "is the caret in a cell", shared with the plain-text paste
// guard (#1641). Two copies of this predicate in one directory is exactly the
// pair that drifts — a header cell is its own node type, and only one copy
// would remember.
import { isSelectionInTableCell } from '../table-cell-paste'

const log = createLogger('Hook:TableCellImage')

interface TableCellImageParams {
  editor: any
  editable?: boolean
  containerRef: React.RefObject<HTMLDivElement | null>
  noteIdRef: React.RefObject<string | undefined>
}

export interface TableCellImageResult {
  /**
   * Opens the file picker and puts the chosen image in the cell the caret is
   * in. Bound to the slash menu's Image row by ContentArea; a no-op when there
   * is no editor view yet.
   */
  pickImageForCell: () => void
}

export function useTableCellImage({
  editor,
  editable,
  containerRef,
  noteIdRef
}: TableCellImageParams): TableCellImageResult {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
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

  /**
   * The picker `/image` opens, kept as one hidden input for the editor's whole
   * life rather than one per invocation: a click has to reach an element that is
   * actually in the document, and building it inside the handler makes that a
   * race with the browser's own user-activation check.
   */
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.multiple = true
    input.style.display = 'none'
    container.appendChild(input)
    fileInputRef.current = input
    return () => {
      input.remove()
      fileInputRef.current = null
    }
  }, [containerRef])

  const pickImageForCell = useCallback(() => {
    const input = fileInputRef.current
    const view = editor?.prosemirrorView
    if (!input || !view) return

    // The caret is remembered rather than read back afterwards: the picker is
    // modal and asynchronous, and by the time a file comes back the editor has
    // been blurred. Without this the image lands wherever the selection drifted
    // to — which is the very bug this row replaces.
    const at = view.state.selection.from

    // Cleared so choosing the SAME file twice still fires `change`.
    input.value = ''
    input.onchange = () => {
      const files = Array.from(input.files ?? []).filter(isImageFile)
      input.onchange = null
      if (files.length === 0) return
      const doc = view.state.doc
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(doc, Math.min(at, doc.content.size)))
      )
      view.focus()
      void insertImages(files)
    }
    input.click()
  }, [editor, insertImages])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !editable) return

    const imageFilesFrom = (data: DataTransfer | null): File[] =>
      Array.from(data?.files ?? []).filter(isImageFile)

    const onPaste = (e: ClipboardEvent): void => {
      const files = imageFilesFrom(e.clipboardData)
      if (files.length === 0) return
      if (!isSelectionInTableCell(editor)) return

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
      // Asked AFTER the dispatch: the pointer landed on a `<td>`, but the
      // position it resolves to is what the image is actually inserted at.
      if (!isSelectionInTableCell(editor)) return
      void insertImages(files)
    }

    container.addEventListener('paste', onPaste, { capture: true })
    container.addEventListener('drop', onDrop, { capture: true })
    return () => {
      container.removeEventListener('paste', onPaste, { capture: true })
      container.removeEventListener('drop', onDrop, { capture: true })
    }
  }, [editor, editable, containerRef, insertImages])

  return { pickImageForCell }
}
