import { describe, expect, it } from 'vitest'
import {
  editorOffsetToMarkdownSourceOffset,
  markdownSourceOffsetToEditorOffset
} from './critic-markup-offset-map'

const sample = `## Why I keep at it

Three reasons, in increasing order of importance:

1. **Information** — useful, but Wikipedia handles this

2. **Empathy** — fiction is a flight simulator for other lives`

describe('CriticMarkup offset map', () => {
  it('maps a repeated deletion character to the target source offset', () => {
    const firstLowercaseI = sample.indexOf('i')
    const flightI = sample.indexOf('flight') + 2
    const flightEditorOffset = markdownSourceOffsetToEditorOffset(sample, flightI)

    expect(flightEditorOffset).not.toBeNull()
    expect(flightI).not.toBe(firstLowercaseI)
    expect(editorOffsetToMarkdownSourceOffset(sample, flightEditorOffset!)).toBe(flightI)
  })

  it('maps an insertion boundary inside Wikipedia instead of the heading', () => {
    const firstP = sample.indexOf('p')
    const wikipediaExtraP = sample.indexOf('Wikipedia') + 'Wikip'.length
    const wikipediaEditorOffset = markdownSourceOffsetToEditorOffset(sample, wikipediaExtraP)

    expect(wikipediaEditorOffset).not.toBeNull()
    expect(wikipediaExtraP).not.toBe(firstP)
    expect(editorOffsetToMarkdownSourceOffset(sample, wikipediaEditorOffset!)).toBe(wikipediaExtraP)
  })

  it('keeps common markdown syntax out of editor offsets', () => {
    const markdown =
      '> Quote **bold** `code` [label](https://example.com) [[Target|Alias]]\n\n- item'
    const bold = markdown.indexOf('bold')
    const code = markdown.indexOf('code')
    const label = markdown.indexOf('label')
    const alias = markdown.indexOf('Alias')
    const item = markdown.indexOf('item')

    expect(markdownSourceOffsetToEditorOffset(markdown, bold)).toBe('Quote '.length)
    expect(markdownSourceOffsetToEditorOffset(markdown, code)).toBe('Quote bold '.length)
    expect(markdownSourceOffsetToEditorOffset(markdown, label)).toBe('Quote bold code '.length)
    expect(markdownSourceOffsetToEditorOffset(markdown, alias)).toBe(
      'Quote bold code label '.length
    )
    expect(markdownSourceOffsetToEditorOffset(markdown, item)).toBe(
      'Quote bold code label Alias\n'.length
    )
  })

  it('maps editor-end insertions before trailing block separators', () => {
    const markdown = 'addition anchor\n\n\n\n'
    const editorEnd = 'addition anchor'.length

    expect(editorOffsetToMarkdownSourceOffset(markdown, editorEnd)).toBe(editorEnd)
  })
})
