/**
 * Pasting or dropping an image into a table cell (#1640).
 *
 * BlockNote's own file handling always builds an `image` BLOCK, and a table
 * cell holds inline content only — so inside a cell the paste either did
 * nothing or landed the image outside the table. The `inlineImage` node fixes
 * the data model; this is the only way a user actually gets one into a cell.
 *
 * Scoped to table cells on purpose. Everywhere else BlockNote's block image is
 * the right answer and this plugin does not fire, so no existing paste or drop
 * behaviour changes.
 */

import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { ResolvedPos } from '@tiptap/pm/model'

const PLUGIN_KEY = new PluginKey('tableCellImage')

const TABLE_CELL_NODES = new Set(['tableCell', 'tableHeader'])

/** Uploads the file and resolves to the ref to store — note-relative, never absolute. */
export type UploadImage = (file: File) => Promise<string>

export function imageFilesFrom(data: DataTransfer | null | undefined): File[] {
  if (!data?.files?.length) return []
  return Array.from(data.files).filter((file) => file.type.startsWith('image/'))
}

/** Whether a resolved position sits inside a table cell. */
export function isInsideTableCell($pos: ResolvedPos | null | undefined): boolean {
  if (!$pos) return false
  for (let depth = $pos.depth; depth > 0; depth--) {
    if (TABLE_CELL_NODES.has($pos.node(depth).type.name)) return true
  }
  return false
}

function selectionIsInsideTableCell(state: EditorState): boolean {
  return isInsideTableCell(state.selection.$from)
}

/**
 * `alt` is the filename without its extension: it is what a reader sees when
 * the file is missing, and what the markdown carries between `![` and `]`.
 */
export function altTextForFile(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  // Brackets would break `![alt](src)` — the same guard `rewriteWikiImageEmbeds`
  // applies when it invents an alt from a filename.
  return base.replace(/\.[^.]+$/, '').replace(/[[\]]/g, '')
}

/**
 * Insert the uploaded images at the current selection, if it is still in a cell.
 *
 * The upload is a round trip through main, so the position captured before it
 * cannot be trusted afterwards — the document may have moved underneath. The
 * live selection is re-checked instead, which is also where the user expects
 * the image to land: they have not moved the caret in the meantime.
 */
function insertInlineImages(view: EditorView, refs: Array<{ src: string; alt: string }>): void {
  const type = view.state.schema.nodes.inlineImage
  if (!type || !selectionIsInsideTableCell(view.state)) return

  let tr: Transaction = view.state.tr
  for (const { src, alt } of refs) {
    tr = tr.replaceSelectionWith(type.create({ src, alt }), false)
  }
  view.dispatch(tr.scrollIntoView())
}

async function uploadAndInsert(
  view: EditorView,
  files: File[],
  uploadImage: UploadImage
): Promise<void> {
  const refs: Array<{ src: string; alt: string }> = []
  for (const file of files) {
    try {
      const src = await uploadImage(file)
      if (src) refs.push({ src, alt: altTextForFile(file.name) })
    } catch {
      // `uploadFile` already surfaces the reason to the user; a second toast per
      // file would just stack.
    }
  }
  if (refs.length) insertInlineImages(view, refs)
}

export function createTableCellImagePlugin(uploadImage: UploadImage): Plugin {
  return new Plugin({
    key: PLUGIN_KEY,
    props: {
      /**
       * `handleDOMEvents`, not `handlePaste` / `handleDrop`.
       *
       * BlockNote's own file handling lives in `handleDOMEvents` too — its
       * `pasteFromClipboard` extension calls `preventDefault()` on every paste
       * an editable editor gets, and `dropFile` claims any drop carrying Files
       * — and ProseMirror consults that prop BEFORE the one `handlePaste` is
       * reached through. A `handlePaste` here was never called at all:
       * measured, the pasted image still arrived as a block BELOW the table.
       *
       * The plugin is registered at the FRONT of the plugin list so this runs
       * before BlockNote's, which is safe because both handlers below decline
       * everything outside a table cell.
       */
      handleDOMEvents: {
        paste: (view, event) => {
          if (!selectionIsInsideTableCell(view.state)) return false
          const files = imageFilesFrom(event.clipboardData)
          if (files.length === 0) return false

          event.preventDefault()
          void uploadAndInsert(view, files, uploadImage)
          return true
        },

        drop: (view, event) => {
          const files = imageFilesFrom(event.dataTransfer)
          if (files.length === 0) return false

          const dropped = view.posAtCoords({ left: event.clientX, top: event.clientY })
          if (dropped == null) return false
          const $pos = view.state.doc.resolve(dropped.pos)
          if (!isInsideTableCell($pos)) return false

          event.preventDefault()
          // Move the caret to where the file was dropped before the upload
          // starts, so the insert lands in the cell the user aimed at rather
          // than wherever the caret happened to be.
          view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))
          void uploadAndInsert(view, files, uploadImage)
          return true
        }
      }
    }
  })
}
