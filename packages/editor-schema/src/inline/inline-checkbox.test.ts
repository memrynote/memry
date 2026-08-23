/**
 * `inlineCheckbox`'s `parse` is the half that has to be exactly this narrow,
 * and its DOM is the half that has to be exactly this shape.
 *
 * It shares its element — `<input type="checkbox">` — with BlockNote's own
 * `checkListItem` BLOCK, and the two rules are asked in order until one
 * matches. Claiming a checkbox outside a table cell would silently convert
 * every checklist in every existing note into an inline node ProseMirror then
 * has nowhere to put; claiming none inside a cell leaves the bug.
 *
 * The DOM is asserted here rather than only through the converter because a
 * table cell serializes its inline content through `render`, and the trailing
 * space inside the node's own element is the entire reason `| [ ] task |` comes
 * back with a space in it.
 */

import { describe, expect, it } from 'vitest'
import {
  createInlineCheckboxContent,
  createInlineCheckboxDOM,
  inlineCheckboxConfig,
  inlineCheckboxSerialization,
  toChecked
} from './inline-checkbox'

function inputIn(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  return host.querySelector('input') as HTMLElement
}

describe('inlineCheckbox parse', () => {
  it('claims a checkbox inside a table cell', () => {
    // #given the one place a checklist cannot be a block
    const input = inputIn(
      '<table><tbody><tr><td><input type="checkbox">task</td></tr></tbody></table>'
    )

    // #when / #then
    expect(inlineCheckboxSerialization.parse(input)).toEqual({ checked: false })
  })

  it('reads the ticked state off a checked cell checkbox', () => {
    const input = inputIn(
      '<table><tbody><tr><td><input type="checkbox" checked="">done</td></tr></tbody></table>'
    )
    expect(inlineCheckboxSerialization.parse(input)).toEqual({ checked: true })
  })

  it('claims a checkbox inside a header cell', () => {
    const input = inputIn('<table><thead><tr><th><input type="checkbox"></th></tr></thead></table>')
    expect(inlineCheckboxSerialization.parse(input)).toEqual({ checked: false })
  })

  it('leaves a checkbox in a list item to the checkListItem block', () => {
    // #given the shape every existing note's checklists arrive in
    const input = inputIn('<ul><li><input type="checkbox" checked="">a task</li></ul>')

    // #when / #then undefined is what makes BlockNote skip this rule and fall
    // through to the block spec — returning props here would rewrite the lot
    expect(inlineCheckboxSerialization.parse(input)).toBeUndefined()
  })

  it('leaves a checkbox in a paragraph alone', () => {
    const input = inputIn('<p><input type="checkbox"></p>')
    expect(inlineCheckboxSerialization.parse(input)).toBeUndefined()
  })

  it('ignores a cell input that is not a checkbox', () => {
    // #given a text field, which a pasted HTML form is full of
    const input = inputIn(
      '<table><tbody><tr><td><input type="text" value="x"></td></tr></tbody></table>'
    )
    expect(inlineCheckboxSerialization.parse(input)).toBeUndefined()
  })

  it('ignores a cell element that is not an input', () => {
    const host = document.createElement('div')
    host.innerHTML = '<table><tbody><tr><td><span data-x="1">hi</span></td></tr></tbody></table>'
    expect(
      inlineCheckboxSerialization.parse(host.querySelector('span') as HTMLElement)
    ).toBeUndefined()
  })
})

describe('the DOM both processes emit', () => {
  it('is an input wrapped in a span, followed by a space', () => {
    // #given the shape measured against the real rehype-remark pipeline: a BARE
    // `<input>` serializes to `[ ]task`, because BlockNote's
    // `addSpacesToCheckboxes` only inserts a space when the next sibling is a
    // `<p>` — the checkListItem shape, never this one.
    const dom = createInlineCheckboxDOM(false)

    // #when / #then
    expect(dom.tagName).toBe('SPAN')
    expect(dom.innerHTML).toBe('<input type="checkbox"> ')
  })

  it('carries `checked` as an ATTRIBUTE, not just the property', () => {
    // #given the serializer reads this element's MARKUP. A `.checked` property
    // with no attribute is invisible to it, so `| [x] |` would go back to disk
    // as `| [ ] |` and the tick would be lost on the next save.
    const dom = createInlineCheckboxDOM(true)

    // #when / #then
    expect(dom.innerHTML).toBe('<input type="checkbox" checked=""> ')
  })

  it('round-trips its own DOM back through parse', () => {
    // #given the node's own output, put where it lives
    const host = document.createElement('div')
    const cell = document.createElement('td')
    host.innerHTML = '<table><tbody><tr></tr></tbody></table>'
    host.querySelector('tr')!.appendChild(cell)
    cell.appendChild(createInlineCheckboxDOM(true))

    // #when / #then
    expect(inlineCheckboxSerialization.parse(cell.querySelector('input')!)).toEqual({
      checked: true
    })
  })

  it('toExternalHTML emits exactly what createInlineCheckboxDOM does', () => {
    const external = inlineCheckboxSerialization.toExternalHTML({ props: { checked: true } })
    expect(external.dom.outerHTML).toBe(createInlineCheckboxDOM(true).outerHTML)
  })
})

describe('toChecked', () => {
  // A synced Y.Doc delivers attributes as STRINGS, and `Boolean("false")` is
  // `true` — so an unticked box read naively ticks itself on the second device
  // and replicates that back. Same landmine `toWidth` exists for on inlineImage.
  it.each([
    [true, true],
    ['true', true],
    [false, false],
    ['false', false],
    [undefined, false],
    [null, false],
    ['', false]
  ])('reads %o as %o', (input, expected) => {
    expect(toChecked(input)).toBe(expected)
  })
})

describe('the config', () => {
  it('is an atom with a boolean prop defaulting to unticked', () => {
    // #given `content: 'none'` is what makes BlockNote build this as an atom —
    // the caret cannot land inside it, which is what a checkbox needs
    expect(inlineCheckboxConfig.content).toBe('none')
    expect(inlineCheckboxConfig.propSchema.checked).toEqual({ default: false, type: 'boolean' })
  })

  it('builds content the editor can insert', () => {
    expect(createInlineCheckboxContent()).toEqual({
      type: 'inlineCheckbox',
      props: { checked: false }
    })
    expect(createInlineCheckboxContent(true)).toEqual({
      type: 'inlineCheckbox',
      props: { checked: true }
    })
  })
})
