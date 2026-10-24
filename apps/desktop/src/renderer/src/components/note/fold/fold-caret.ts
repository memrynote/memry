import { findEditorContaining } from '@/commands/editor-target'
import { createLogger } from '@/lib/logger'
import { findParagraphBlock, type BlockPosition } from './fold-anchor'

const log = createLogger('NoteFold')

const FLASH_MS = 1200

const editorBlocks = (root: HTMLElement): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('.bn-block-content')
]

/**
 * Puts the caret at the end of the editor block that holds `paragraphText` and
 * scrolls it into view. Returns the block, or null when none matches (the note
 * changed since the snapshot, or the editor is not in `root`). `position`
 * lets a paragraph whose text changed still land on its place in the note.
 */
export function placeCaretInParagraph(
  root: HTMLElement,
  paragraphText: string,
  position?: BlockPosition
): HTMLElement | null {
  const blocks = editorBlocks(root)
  const index = findParagraphBlock(
    blocks.map((block) => block.textContent ?? ''),
    paragraphText,
    position
  )
  return index === -1 ? null : placeCaretInBlock(root, blocks[index])
}

/** Caret at the end of the last editor block, for a return with nothing to anchor to. */
export function placeCaretAtEnd(root: HTMLElement): HTMLElement | null {
  const last = editorBlocks(root).at(-1)
  return last ? placeCaretInBlock(root, last) : null
}

function placeCaretInBlock(root: HTMLElement, block: HTMLElement): HTMLElement | null {
  const editable = root.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]')
  if (!editable) return null

  editable.focus({ preventScroll: true })
  const inline = block.querySelector('.bn-inline-content') ?? block
  const range = document.createRange()
  range.selectNodeContents(inline)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  block.scrollIntoView({ block: 'center' })
  return block
}

/**
 * The paragraph the reader is looking at: the first one on screen. Marked
 * lines and Topic chips carry `data-fold-paragraph`.
 */
export function firstVisibleParagraph(overlay: HTMLElement): string | null {
  for (const element of overlay.querySelectorAll<HTMLElement>('[data-fold-paragraph]')) {
    const rect = element.getBoundingClientRect()
    if (rect.bottom > 0 && rect.top < window.innerHeight)
      return element.dataset.foldParagraph ?? null
  }
  return null
}

/**
 * Types `text` at the caret `placeCaretInParagraph` set in `block`. The
 * editor's own API makes it one transaction at a known place; the DOM
 * selection ProseMirror has not read yet is not trusted. Returns false when
 * nothing was inserted, so the caller can report it.
 */
export function insertTypedText(root: HTMLElement, block: HTMLElement, text: string): boolean {
  const editable = root.querySelector<HTMLElement>('.ProseMirror')
  const editor = findEditorContaining(editable)
  const blockId = block.closest<HTMLElement>('.bn-block[data-id]')?.dataset.id
  if (editor && blockId) {
    editor.setTextCursorPosition(blockId, 'end')
    editor.insertInlineContent([text])
    return true
  }
  // No registered editor to ask (read-only, or not mounted through a tab): the DOM path.
  // oxlint-disable-next-line typescript/no-deprecated -- document.execCommand is the only way to insert text into the focused editable when no editor is registered
  const inserted = document.execCommand('insertText', false, text)
  if (!inserted) log.warn('Typed character could not be inserted after unfolding', { blockId })
  return inserted
}

/** Highlights a block briefly. A static tint, so reduced motion loses nothing but the fade. */
export function flashBlock(block: HTMLElement, reducedMotion: boolean): void {
  block.style.backgroundColor = 'var(--surface-active)'
  block.style.transition = reducedMotion ? 'none' : 'background-color 400ms ease-out'
  window.setTimeout(() => {
    block.style.backgroundColor = ''
    window.setTimeout(() => {
      block.style.transition = ''
    }, 400)
  }, FLASH_MS)
}
