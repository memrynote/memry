import type { FoldedView } from './fold-display'

/**
 * The folded view as Markdown, for the clipboard. Pasted into the editor,
 * BlockNote parses it back into headings, paragraphs and lists, so a level can
 * be copied out without ever touching the note. Only what the reader sees: a
 * level's lines and headings, not the markers for skipped blocks.
 */
export function foldedMarkdown(view: FoldedView): string {
  const blocks: string[] = []
  for (const item of view.items) {
    if (item.kind === 'card') {
      const { heading, takeaway, chips } = item.card
      if (heading) blocks.push(`## ${heading}`)
      if (takeaway) blocks.push(takeaway)
      if (chips.length > 0) blocks.push(chips.map((chip) => `- ${chip.label}`).join('\n'))
      continue
    }
    const { heading, paragraphs } = item.section
    if (heading) blocks.push(`## ${heading}`)
    for (const paragraph of paragraphs) blocks.push(paragraph.line.md ?? paragraph.line.text)
  }
  return blocks.join('\n\n')
}
