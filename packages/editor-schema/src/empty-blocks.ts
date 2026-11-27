import { createFenceTracker } from '@memry/shared/markdown-fences'

/**
 * A list item or a heading with nothing on its line, read as that empty block.
 *
 * The writer spells an empty bullet `*`, an empty numbered item `1.`, an empty
 * to-do `- [ ]` and an empty heading `#`, as CommonMark reads them, but
 * BlockNote's parser wants text after the marker and reads each as a
 * paragraph of the marker: a list item holding only an image came back as the
 * text `*` above the image. Each such line gets a placeholder word for the
 * parser to hold, and the repair takes it back out.
 *
 * A to-do box counts after a bullet only. BlockNote reads `1. [ ] x` as a
 * to-do too, but `1. [ ]` alone is a numbered item holding `[ ]`, and the
 * writer never spells a to-do with a number.
 */

// Per process, so note text does not hold the placeholder (as in `emphasis-runs.ts`).
const PROCESS_WORD = String.fromCharCode(
  ...crypto.getRandomValues(new Uint8Array(12)).map((byte) => 65 + (byte % 26))
)
const PLACEHOLDER = `MEMRYEMB${PROCESS_WORD}`

// Flush left: BlockNote reads an indented `#` as paragraph text.
const EMPTY_HEADING = /^#{1,6}[ \t]*$/
const EMPTY_ITEM = /^[ \t]*(?:[-*+](?: \[[ xX]\])?|\d{1,9}[.)])[ \t]*$/
const ANY_EMPTY = /^(?:#{1,6}|[ \t]*(?:[-*+](?: \[[ xX]\])?|\d{1,9}[.)]))[ \t]*$/m
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/

/**
 * `markdown` with a placeholder on each empty item or heading line. An item
 * line counts only where a list item can start without ending a paragraph:
 * after a blank line or another item. After paragraph text, `-` is a setext
 * underline.
 */
export function maskEmptyBlockLines(markdown: string): string {
  if (!ANY_EMPTY.test(markdown)) return markdown
  const fence = createFenceTracker()
  const lines = markdown.split('\n')
  return lines
    .map((line, index) => {
      if (fence.consume(line)) return line
      const previous = lines[index - 1]
      const opens = previous === undefined || previous.trim() === '' || LIST_ITEM.test(previous)
      const empty = EMPTY_HEADING.test(line) || (opens && EMPTY_ITEM.test(line))
      return empty ? `${line.trimEnd()} ${PLACEHOLDER}` : line
    })
    .join('\n')
}

interface Block {
  content?: unknown
  children?: unknown
}

/**
 * `blocks` with every placeholder `maskEmptyBlockLines` added taken back out.
 * One the parser left inside text goes too, as `unmaskHardBreaks` drops a
 * stray token: a placeholder must never reach the vault file.
 */
export function dropEmptyBlockPlaceholders(blocks: Block[]): void {
  for (const block of blocks) {
    if (Array.isArray(block.content)) {
      const runs: Array<{ type?: string; text?: string }> = block.content
      if (runs.length === 1 && runs[0].type === 'text' && runs[0].text?.trim() === PLACEHOLDER) {
        block.content = []
      } else {
        for (const run of runs) {
          if (run.text?.includes(PLACEHOLDER)) run.text = run.text.replaceAll(` ${PLACEHOLDER}`, '')
        }
      }
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- children is `unknown`; a block's children are blocks
    if (Array.isArray(block.children)) dropEmptyBlockPlaceholders(block.children as Block[])
  }
}
