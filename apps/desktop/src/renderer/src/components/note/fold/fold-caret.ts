import { findParagraphBlock } from './fold-anchor'

const FLASH_MS = 1200

/**
 * Puts the caret at the end of the editor block that holds `paragraphText` and
 * scrolls it into view. Returns the block, or null when none matches (the note
 * changed since the snapshot, or the editor is not in `root`).
 */
export function placeCaretInParagraph(
  root: HTMLElement,
  paragraphText: string
): HTMLElement | null {
  const blocks = [...root.querySelectorAll<HTMLElement>('.bn-block-content')]
  const index = findParagraphBlock(
    blocks.map((block) => block.textContent ?? ''),
    paragraphText
  )
  const block = index === -1 ? null : blocks[index]
  const editable = root.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]')
  if (!block || !editable) return null

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
