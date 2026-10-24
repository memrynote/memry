import { describe, expect, it } from 'vitest'
import { buildFoldedView } from './fold-display'
import { foldedMarkdown } from './fold-copy'
import { layers, paragraph } from './fold-fixtures'

const none = new Set<string>()

describe('foldedMarkdown', () => {
  it('writes each section as a heading and one line per paragraph', () => {
    const view = buildFoldedView(layers(), 'takeaway', none, none)
    expect(foldedMarkdown(view)).toBe(
      [
        '## Where we are',
        'The team plan barely sold',
        'Pro stays at $8',
        'First sentence here. Third sentence here.'
      ].join('\n\n')
    )
  })

  it('keeps the inline Markdown of the author’s Brief', () => {
    const note = layers()
    note.sections[0].paragraphs[0] = paragraph({
      hash: 'p1',
      briefIdx: [0],
      sentencesMd: ['**First** sentence here.', 'Second sentence here.', 'Third sentence here.']
    })
    expect(foldedMarkdown(buildFoldedView(note, 'brief', none, none))).toContain(
      '**First** sentence here.'
    )
  })

  it('writes a Topic card as a heading, its takeaway and a list of its chips', () => {
    const text = foldedMarkdown(buildFoldedView(layers(), 'topic', none, none))
    expect(text).toMatch(/^## Where we are\n\n.+\n\n- .+/)
  })
})
