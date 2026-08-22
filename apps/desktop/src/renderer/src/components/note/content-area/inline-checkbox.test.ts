/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The editor's `inlineCheckbox` render has one job the main process's must not
 * do — carry the click that flips it — and one rule about when: never while
 * BlockNote is serializing.
 *
 * BlockNote reaches this same function with `renderType: 'dom'` to serialize a
 * table cell and reads the element it returns, so a listener or an extra
 * wrapper leaking into that path is how a cell's markdown stops being
 * `| [ ] task |`. The toggle itself is asserted here because it is the whole
 * feature: a box that cannot be ticked is a picture of a box.
 */

import { describe, expect, it, vi } from 'vitest'
import { InlineCheckbox, renderInlineCheckbox } from './inline-checkbox'

function renderDom(
  renderType: 'dom' | 'nodeView',
  props: Record<string, unknown> = {},
  update: (content: unknown) => void = () => {},
  editor: unknown = { isEditable: true }
): HTMLElement {
  const node = { type: 'inlineCheckbox', props: { checked: false, ...props } }
  return renderInlineCheckbox.call({ renderType }, node, update, editor).dom
}

const inputOf = (dom: HTMLElement): HTMLInputElement =>
  dom.querySelector('input') as HTMLInputElement

describe('the serialization render', () => {
  it('is the shared span-wrapped input, with nothing added', () => {
    // #given the path a table cell's markdown comes out of
    const dom = renderDom('dom')

    // #then exactly what `toExternalHTML` emits — the trailing space included,
    // since a bare `<input>` serializes to `[ ]task` with no gap
    expect(dom.tagName).toBe('SPAN')
    expect(dom.innerHTML).toBe('<input type="checkbox"> ')
    // #and no editing affordances leak in: `contentEditable` on this path would
    // be serialized markup, and `disabled` would be a state the vault records
    expect(dom.getAttribute('contenteditable')).toBeNull()
    expect(inputOf(dom).disabled).toBe(false)
  })

  it('carries the tick as an attribute', () => {
    expect(renderDom('dom', { checked: true }).innerHTML).toBe(
      '<input type="checkbox" checked=""> '
    )
  })

  it('does not tick a box whose `checked` arrived as the string "false"', () => {
    // #given exactly what a synced Y.Doc delivers — attributes are STRINGS
    expect(renderDom('dom', { checked: 'false' }).innerHTML).toBe('<input type="checkbox"> ')
  })

  it('ticks one whose `checked` arrived as the string "true"', () => {
    expect(renderDom('dom', { checked: 'true' }).innerHTML).toBe(
      '<input type="checkbox" checked=""> '
    )
  })

  it('is what BlockNote reaches through the spec, which passes no `this`', () => {
    // #given the exporter calls the wrapped implementation with no `this`, so
    // `renderType` is undefined and the nodeView branch must not be taken
    const dom = (InlineCheckbox as any).implementation.render(
      { type: 'inlineCheckbox', props: { checked: true } },
      () => {},
      {}
    ).dom

    // #then
    expect(dom.querySelector('input').getAttribute('checked')).toBe('')
    expect(dom.getAttribute('contenteditable')).toBeNull()
  })
})

describe('the editing render', () => {
  it('is not editable, so the caret cannot land inside the box', () => {
    expect(renderDom('nodeView').getAttribute('contenteditable')).toBe('false')
  })

  it('flips `checked` when the box is clicked', () => {
    // #given an unticked box in an editable note
    const update = vi.fn()
    const dom = renderDom('nodeView', { checked: false }, update)

    // #when the user clicks it. The listener is on the input's OWN element
    // rather than delegated over the editor surface: a delegated listener keyed
    // on `closest(...)` is what silently died for the wiki-link chip when the
    // browser retargeted the click away from it.
    inputOf(dom).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    // #then
    expect(update).toHaveBeenCalledWith({ type: 'inlineCheckbox', props: { checked: true } })
  })

  it('flips a ticked box back to unticked', () => {
    const update = vi.fn()
    const dom = renderDom('nodeView', { checked: true }, update)
    inputOf(dom).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(update).toHaveBeenCalledWith({ type: 'inlineCheckbox', props: { checked: false } })
  })

  it('reads a string `checked` before flipping it', () => {
    // #given the synced-doc shape again: `!"false"` is `false`, so a naive flip
    // would send `checked: false` for a box that is already unticked and the
    // click would do nothing at all
    const update = vi.fn()
    const dom = renderDom('nodeView', { checked: 'false' }, update)
    inputOf(dom).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(update).toHaveBeenCalledWith({ type: 'inlineCheckbox', props: { checked: true } })
  })

  it('suppresses the native toggle so the prop is the only truth', () => {
    // #given letting the DOM and the document both move means one undo can
    // leave them disagreeing — a box that looks ticked and serializes unticked
    const dom = renderDom('nodeView', { checked: false })
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })

    // #when
    inputOf(dom).dispatchEvent(event)

    // #then
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not park the caret beside the box on mousedown', () => {
    // #given mousedown's default is what starts a selection and moves the
    // cursor into the cell. A tick should be a tick.
    const dom = renderDom('nodeView')
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    inputOf(dom).dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('is disabled and inert in a read-only note', () => {
    // #given a canvas card or a shared read-only surface
    const update = vi.fn()
    const dom = renderDom('nodeView', { checked: false }, update, { isEditable: false })

    // #when
    inputOf(dom).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    // #then
    expect(inputOf(dom).disabled).toBe(true)
    expect(update).not.toHaveBeenCalled()
  })
})
