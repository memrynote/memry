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
 *
 * ## Why a `File` is not enough
 *
 * The first cut of this only looked at `clipboardData.files`, which is the ONE
 * gesture that carries a real file — a screenshot, or a copy out of Finder.
 * Every other way people move a picture delivers HTML and no file at all:
 * copying an image inside Memry (BlockNote's own copy handler calls
 * `clearData()` and writes only `blocknote/html` / `text/html` / `text/plain`),
 * and copying from a web page, Google Docs, Notion or Slack (`text/html` with
 * an `<img src>`). Those fell through to BlockNote, whose accepted-MIME order
 * puts `"Files"` LAST, so it read `text/html` and built an image BLOCK — which
 * a `tableCell` cannot hold, so ProseMirror dropped it with no error and no
 * toast. That is what "images still don't paste into a cell" was.
 *
 * `inlineImage.parse` cannot fix it: it decides from the SOURCE dom (a bare
 * clipboard fragment with no `<td>`), not from where the caret is, and relaxing
 * that guard would convert every standalone image in every note. So the HTML is
 * read here instead, where the destination is known.
 */

import { useCallback, useEffect, useRef } from 'react'
import { TextSelection } from '@tiptap/pm/state'
import { createInlineImageContent, parseInlineImageAlt, toWidth } from '@memry/editor-schema/inline'
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

/** One picture on its way into a cell: already addressable, or bytes to save. */
type CellImage =
  | { kind: 'ref'; src: string; alt: string; width: number }
  | { kind: 'file'; file: File; alt: string; width: number }

/** `memry-file://…` names THIS machine's vault path — it must never reach disk. */
const MEMRY_FILE_SCHEME = /^memry-file:/i
/** Addressable from any device, so it can be written into the row as-is. */
const REMOTE_SCHEME = /^https?:/i
/** `https:`, `data:`, `file:` — and `C:` on Windows. Mirrors the resolver. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:/
const DATA_IMAGE = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i

/**
 * Mirrors the vault's own `ALLOWED_IMAGE_EXTENSIONS`. A data URL has no
 * filename, and `saveAttachment` validates by EXTENSION — so an unrecognised
 * MIME type has no filename we could invent that the vault would accept, and
 * the paste is left alone rather than uploaded into a guaranteed rejection.
 */
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
}

/** Zero-width joiners and BOMs survive `trim()`; Google Docs emits both. */
const INVISIBLE = new RegExp('[\\s\\u200B-\\u200D\\uFEFF]', 'g')

function dataUrlToFile(url: string): File | null {
  const match = DATA_IMAGE.exec(url)
  if (!match) return null
  const mimeType = match[1].toLowerCase()
  const extension = EXTENSION_BY_MIME[mimeType]
  if (!extension) return null
  try {
    const binary = atob(match[2].replace(/\s/g, ''))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new File([bytes], `pasted-image.${extension}`, { type: mimeType })
  } catch {
    return null
  }
}

/**
 * Whether a note-relative ref is one of THIS note's own attachments.
 *
 * A ref is relative to the note it was copied FROM. `../attachments/<noteId>/x.png`
 * copied out of note A and pasted into note B would resolve against B and show a
 * broken image — silently, and only on the row nobody looks at again. The owning
 * note's id is in the path (`getAttachmentRef`), so the same-note case is
 * recognisable and safe; anything else is left to the default handler.
 */
function isOwnAttachmentRef(src: string, noteId: string | undefined): boolean {
  if (!noteId) return false
  return src.replace(/\\/g, '/').includes(`attachments/${noteId}/`)
}

function toCellImage(element: Element, noteId: string | undefined): CellImage | null {
  // `getAttribute`, never `.src`: the property resolves against the renderer's
  // base URL, and writing THAT back to disk is how a vault stops being portable.
  const src = element.getAttribute('src')?.trim() ?? ''
  if (!src) return null

  const { alt, width } = parseInlineImageAlt(element.getAttribute('alt') ?? '')
  // Same precedence as `inlineImageSerialization.parse`: a real `width`
  // attribute is a measurement, the alt suffix is our own convention.
  const attribute = toWidth(element.getAttribute('width'))
  const size = attribute > 0 ? attribute : width

  if (MEMRY_FILE_SCHEME.test(src)) return null
  if (DATA_IMAGE.test(src)) {
    // Not written into the row as-is: a screenshot's base64 is megabytes, and it
    // would land in the markdown FILE. Saved as an attachment like any other.
    const file = dataUrlToFile(src)
    return file ? { kind: 'file', file, alt, width: size } : null
  }
  if (REMOTE_SCHEME.test(src)) return { kind: 'ref', src, alt, width: size }
  if (HAS_SCHEME.test(src)) return null
  return isOwnAttachmentRef(src, noteId) ? { kind: 'ref', src, alt, width: size } : null
}

/**
 * The pictures in a clipboard/drag HTML fragment, or null to leave it alone.
 *
 * Only an images-ONLY fragment is claimed. A mixed one (a paragraph with a
 * picture in it) still belongs to BlockNote: re-inserting its text through
 * `insertInlineContent` would flatten links, bold and code back to plain text,
 * which is a worse regression than the missing image — and it would bypass the
 * markdown guard in `table-cell-paste.ts` that keeps a pasted `| a | b |` from
 * splicing a whole table over the row. Mixed fragments are a known follow-up.
 *
 * All-or-nothing: one src we cannot use safely (another note's ref, a
 * `memry-file://` path) abandons the whole paste rather than dropping a picture
 * out of the middle of it without saying so.
 */
function parseClipboardCellImages(html: string, noteId: string | undefined): CellImage[] | null {
  if (!html.trim()) return null

  const doc = new DOMParser().parseFromString(html, 'text/html')
  // Word and Google Docs ship a stylesheet inside the fragment; its rules are
  // `textContent` and would read as "there is text here" forever.
  doc.querySelectorAll('style, script, title').forEach((element) => element.remove())

  const elements = Array.from(doc.querySelectorAll('img'))
  if (elements.length === 0) return null
  if ((doc.body.textContent ?? '').replace(INVISIBLE, '') !== '') return null

  const images: CellImage[] = []
  for (const element of elements) {
    const image = toCellImage(element, noteId)
    if (!image) return null
    images.push(image)
  }
  return images
}

/** A synthetic event can arrive without `getData`; a real clipboard never does. */
function htmlFrom(data: DataTransfer | null): string {
  return typeof data?.getData === 'function' ? data.getData('text/html') : ''
}

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
   * Puts each picture at the caret, in order.
   *
   * Bytes are uploaded into the note's attachments first; the vault-relative
   * path `uploadAttachment` returns is what goes in the node's `src` — never a
   * resolved absolute URL, which would pin the note to this machine's vault
   * path the moment it is written back to markdown. A `ref` already carries a
   * portable src and needs no note at all.
   */
  const insertCellImages = useCallback(
    async (images: CellImage[]): Promise<void> => {
      for (const image of images) {
        if (image.kind === 'ref') {
          editor.insertInlineContent([createInlineImageContent(image.src, image.alt, image.width)])
          continue
        }

        const noteId = noteIdRef.current
        if (!noteId) return

        const { file } = image
        try {
          const result = await notesService.uploadAttachment(noteId, file)
          if (!result.success || !result.path) {
            throw new Error(result.error || 'Upload failed')
          }
          editor.insertInlineContent([
            createInlineImageContent(
              result.path,
              image.alt || result.name || file.name,
              image.width
            )
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

  const insertImages = useCallback(
    (files: File[]): Promise<void> =>
      insertCellImages(files.map((file) => ({ kind: 'file', file, alt: '', width: 0 }))),
    [insertCellImages]
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
      if (files.length > 0) {
        if (!isSelectionInTableCell(editor)) return

        e.preventDefault()
        e.stopPropagation()
        void insertImages(files)
        return
      }

      // Asked before the HTML is parsed: this runs on EVERY paste in the note,
      // and a DOMParser pass on a Word fragment is not free.
      if (!isSelectionInTableCell(editor)) return
      const images = parseClipboardCellImages(htmlFrom(e.clipboardData), noteIdRef.current)
      if (!images) return

      e.preventDefault()
      e.stopPropagation()
      void insertCellImages(images)
    }

    /**
     * A drop carries no caret, so the cell is found from the pointer and the
     * selection is moved there first — otherwise the image would land wherever
     * the caret happened to be, which for a drop onto a table is never right.
     */
    const onDrop = (e: DragEvent): void => {
      const target = e.target as HTMLElement | null
      if (!target?.closest?.('td, th')) return

      // A drag out of a browser window carries the same HTML-and-no-file
      // payload a copy does, so it is read the same way.
      const files = imageFilesFrom(e.dataTransfer)
      const images =
        files.length > 0
          ? files.map((file): CellImage => ({ kind: 'file', file, alt: '', width: 0 }))
          : parseClipboardCellImages(htmlFrom(e.dataTransfer), noteIdRef.current)
      if (!images) return

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
      void insertCellImages(images)
    }

    container.addEventListener('paste', onPaste, { capture: true })
    container.addEventListener('drop', onDrop, { capture: true })
    return () => {
      container.removeEventListener('paste', onPaste, { capture: true })
      container.removeEventListener('drop', onDrop, { capture: true })
    }
  }, [editor, editable, containerRef, noteIdRef, insertImages, insertCellImages])

  return { pickImageForCell }
}
