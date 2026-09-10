import { describe, expect, it } from 'vitest'

import {
  bottomChromeOf,
  INITIAL_BOTTOM_CHROME,
  PANEL_ROW,
  reduceBottomChrome,
  type BottomChromeEvent,
  type BottomChromeModel,
  type ToolbarPanel
} from '../toolbar/bottom-chrome'

/**
 * The rules the DOM toolbar enforced with four booleans and a `view`, now a
 * reducer. Each case is one rule the reader can observe: a toolbar that shows
 * for the wrong keyboard, a panel that stacks on the keyboard, a panel that
 * survives a note switch.
 */

function run(events: BottomChromeEvent[], from: BottomChromeModel = INITIAL_BOTTOM_CHROME) {
  return events.reduce(reduceBottomChrome, from)
}

const typing: BottomChromeEvent[] = [
  { type: 'editor-focus', focused: true },
  { type: 'keyboard', up: true }
]

const PANELS: ToolbarPanel[] = ['blocks', 'turn-into', 'table', 'style', 'link-prompt']

describe('bottom chrome visibility', () => {
  it('is hidden until the editor is focused under a raised keyboard', () => {
    expect(bottomChromeOf(INITIAL_BOTTOM_CHROME)).toEqual({ kind: 'hidden' })
    // The title field's keyboard, or a tag sheet's: not the editor's.
    expect(bottomChromeOf(run([{ type: 'keyboard', up: true }]))).toEqual({ kind: 'hidden' })
    expect(bottomChromeOf(run([{ type: 'editor-focus', focused: true }]))).toEqual({
      kind: 'hidden'
    })
    expect(bottomChromeOf(run(typing))).toEqual({ kind: 'toolbar', row: 'main' })
  })

  it('shows in either order the focus and the keyboard arrive', () => {
    expect(bottomChromeOf(run([...typing].reverse()))).toEqual({ kind: 'toolbar', row: 'main' })
  })

  it('goes with the keyboard, and with the editor focus', () => {
    expect(bottomChromeOf(run([...typing, { type: 'keyboard', up: false }]))).toEqual({
      kind: 'hidden'
    })
    expect(bottomChromeOf(run([...typing, { type: 'editor-focus', focused: false }]))).toEqual({
      kind: 'hidden'
    })
  })

  it('remembers the row across a hide', () => {
    const model = run([
      ...typing,
      { type: 'show-row', row: 'formatting' },
      { type: 'keyboard', up: false },
      { type: 'keyboard', up: true }
    ])
    expect(bottomChromeOf(model)).toEqual({ kind: 'toolbar', row: 'formatting' })
  })

  it('steps aside for a guest sheet without forgetting anything', () => {
    const suppressed = run([...typing, { type: 'suppressed', suppressed: true }])
    expect(bottomChromeOf(suppressed)).toEqual({ kind: 'hidden' })
    expect(bottomChromeOf(run([{ type: 'suppressed', suppressed: false }], suppressed))).toEqual({
      kind: 'toolbar',
      row: 'main'
    })
  })

  it('is hidden read-only, and read-only closes an open panel', () => {
    const open = run([...typing, { type: 'open-panel', panel: 'blocks' }])
    const locked = run([{ type: 'read-only', readOnly: true }], open)
    expect(bottomChromeOf(locked)).toEqual({ kind: 'hidden' })
    expect(locked.panel).toBeNull()
    expect(bottomChromeOf(run([{ type: 'read-only', readOnly: false }], locked))).toEqual({
      kind: 'toolbar',
      row: 'main'
    })
    expect(run([{ type: 'open-panel', panel: 'style' }], locked).panel).toBeNull()
  })
})

describe('bottom chrome panels', () => {
  it('opens each panel on the row it belongs to', () => {
    for (const panel of PANELS) {
      const model = run([...typing, { type: 'open-panel', panel }])
      expect(bottomChromeOf(model)).toEqual({ kind: 'panel', panel, row: PANEL_ROW[panel] })
    }
  })

  it('stays open while the keyboard the panel replaced goes away', () => {
    const model = run([
      ...typing,
      { type: 'open-panel', panel: 'blocks' },
      { type: 'editor-focus', focused: false },
      { type: 'keyboard', up: false }
    ])
    expect(bottomChromeOf(model)).toEqual({ kind: 'panel', panel: 'blocks', row: 'main' })
  })

  it('closes when the keyboard comes back, onto the row it came from', () => {
    for (const panel of PANELS.filter((candidate) => candidate !== 'link-prompt')) {
      const model = run([
        ...typing,
        { type: 'open-panel', panel },
        { type: 'keyboard', up: false },
        { type: 'editor-focus', focused: true },
        { type: 'keyboard', up: true }
      ])
      expect(bottomChromeOf(model)).toEqual({ kind: 'toolbar', row: PANEL_ROW[panel] })
    }
  })

  it('keeps the link prompt open when its own field raises the keyboard', () => {
    const model = run([
      ...typing,
      { type: 'open-panel', panel: 'link-prompt' },
      // iOS can drop the keyboard as the tap blurs ProseMirror and raise it
      // again when the URL field takes focus. That is the prompt's own input.
      { type: 'editor-focus', focused: false },
      { type: 'keyboard', up: false },
      { type: 'keyboard', up: true }
    ])
    expect(bottomChromeOf(model)).toEqual({
      kind: 'panel',
      panel: 'link-prompt',
      row: 'formatting'
    })
  })

  it('closes on request and leaves the row where the panel put it', () => {
    const model = run([...typing, { type: 'open-panel', panel: 'style' }, { type: 'close-panel' }])
    expect(bottomChromeOf(model)).toEqual({ kind: 'toolbar', row: 'formatting' })
  })

  it('is hidden after closing with the keyboard down, like a dismissed picker', () => {
    const model = run([
      ...typing,
      { type: 'open-panel', panel: 'blocks' },
      { type: 'editor-focus', focused: false },
      { type: 'keyboard', up: false },
      { type: 'close-panel' }
    ])
    expect(bottomChromeOf(model)).toEqual({ kind: 'hidden' })
  })

  it('closes the panel when a row button above it is pressed', () => {
    const fromBlocks = run([
      ...typing,
      { type: 'open-panel', panel: 'blocks' },
      { type: 'show-row', row: 'formatting' }
    ])
    expect(bottomChromeOf(fromBlocks)).toEqual({ kind: 'toolbar', row: 'formatting' })
    const fromStyle = run([
      ...typing,
      { type: 'open-panel', panel: 'style' },
      { type: 'show-row', row: 'main' }
    ])
    expect(bottomChromeOf(fromStyle)).toEqual({ kind: 'toolbar', row: 'main' })
  })

  it('closes the table panel when the caret leaves the table, and only that panel', () => {
    const table = run([...typing, { type: 'open-panel', panel: 'table' }])
    expect(bottomChromeOf(run([{ type: 'caret', inTable: true }], table)).kind).toBe('panel')
    expect(bottomChromeOf(run([{ type: 'caret', inTable: false }], table))).toEqual({
      kind: 'toolbar',
      row: 'main'
    })
    const blocks = run([...typing, { type: 'open-panel', panel: 'blocks' }])
    expect(bottomChromeOf(run([{ type: 'caret', inTable: false }], blocks)).kind).toBe('panel')
  })

  it('drops the panel, the row and the focus for a new note but keeps the keyboard', () => {
    const model = run([
      ...typing,
      { type: 'open-panel', panel: 'style' },
      { type: 'suppressed', suppressed: true },
      { type: 'reset' }
    ])
    expect(model).toEqual({ ...INITIAL_BOTTOM_CHROME, keyboardUp: true })
  })
})
