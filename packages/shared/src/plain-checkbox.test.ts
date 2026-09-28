import { describe, expect, it } from 'vitest'
import {
  hasPlainCheckboxMarker,
  normalizePlainCheckboxes,
  withPlainCheckboxMarkers,
  type PlainCheckboxBlock
} from './plain-checkbox'

const text = (value: string, styles: Record<string, unknown> = {}) => ({
  type: 'text',
  text: value,
  styles
})

describe('plain checkbox marker', () => {
  it('turns a `{check}` line into a plain checkbox without the marker', () => {
    const blocks = [
      {
        type: 'checkListItem',
        props: { checked: true },
        content: [text('Pack '), text('passport', { bold: true }), text(' {check}  ')]
      }
    ]

    const { blocks: out, didChange } = normalizePlainCheckboxes(blocks)

    expect(didChange).toBe(true)
    expect(out[0].props).toEqual({ checked: true, plain: true })
    expect(out[0].content).toEqual([text('Pack '), text('passport', { bold: true })])
  })

  it('handles an empty plain checkbox and the marker glued to the text', () => {
    const input: PlainCheckboxBlock[] = [
      { type: 'checkListItem', props: {}, content: [text('{check}')] },
      { type: 'checkListItem', props: {}, content: [text('Milk{check}')] }
    ]
    const [empty, glued] = normalizePlainCheckboxes(input).blocks

    expect(empty.content).toEqual([])
    expect(empty.props?.plain).toBe(true)
    expect(glued.content).toEqual([text('Milk')])
  })

  it('reaches nested checkboxes', () => {
    const blocks: PlainCheckboxBlock[] = [
      {
        type: 'bulletListItem',
        props: {},
        content: [text('Trip')],
        children: [{ type: 'checkListItem', props: {}, content: [text('Socks {check}')] }]
      }
    ]
    const nested = normalizePlainCheckboxes(blocks).blocks[0].children?.[0]
    expect(nested?.props?.plain).toBe(true)
  })

  it('leaves other lines alone, down to object identity', () => {
    const blocks = [
      { type: 'checkListItem', props: {}, content: [text('Buy milk')] },
      // Mid-line, it is the user's text.
      { type: 'checkListItem', props: {}, content: [text('{check} the oven')] },
      // Not a checkbox: a paragraph about the syntax.
      { type: 'paragraph', props: {}, content: [text('Type {check}')] },
      // A marker inside a link or a styled run is not ours either.
      { type: 'checkListItem', props: {}, content: [{ type: 'link', content: [] }] }
    ]
    const result = normalizePlainCheckboxes(blocks)
    expect(result.didChange).toBe(false)
    expect(result.blocks).toBe(blocks)
  })

  it('writes the marker back as its own last run, and nothing for other blocks', () => {
    const blocks = [
      { type: 'checkListItem', props: { plain: true }, content: [text('Passport')] },
      { type: 'checkListItem', props: { plain: true }, content: [] },
      { type: 'checkListItem', props: { plain: false }, content: [text('Buy milk')] }
    ]

    const out = withPlainCheckboxMarkers(blocks)

    expect(out[0].content).toEqual([text('Passport'), text(' {check}')])
    expect(out[1].content).toEqual([text('{check}')])
    expect(out[2]).toBe(blocks[2])
    // The input is never mutated: it is the live editor's document.
    expect(blocks[0].content).toEqual([text('Passport')])
  })

  it('round-trips through both directions', () => {
    const plain = [{ type: 'checkListItem', props: { plain: true }, content: [text('Passport')] }]
    const back = normalizePlainCheckboxes(withPlainCheckboxMarkers(plain)).blocks
    expect(back[0].content).toEqual([text('Passport')])
    expect(back[0].props?.plain).toBe(true)
  })

  it('reads the marker off raw line text', () => {
    expect(hasPlainCheckboxMarker('Passport {check} ')).toBe(true)
    expect(hasPlainCheckboxMarker('{check} the oven')).toBe(false)
  })
})
