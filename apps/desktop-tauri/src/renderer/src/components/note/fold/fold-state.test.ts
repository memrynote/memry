import { describe, expect, it } from 'vitest'
import { escapeHasEffect, foldReducer, INITIAL_FOLD_STATE, type FoldAction } from './fold-state'

function run(...actions: FoldAction[]) {
  return actions.reduce(foldReducer, INITIAL_FOLD_STATE)
}

describe('fold state', () => {
  it('opens every note at Full', () => {
    expect(INITIAL_FOLD_STATE.level).toBe('full')
  })

  it('Esc closes opened paragraphs first, then returns to Full', () => {
    const open = run(
      { type: 'setLevel', level: 'takeaway' },
      { type: 'toggleParagraph', hash: 'p1' },
      { type: 'toggleParagraph', hash: 'p2' }
    )
    const afterFirst = foldReducer(open, { type: 'escape' })
    expect(afterFirst.level).toBe('takeaway')
    expect(afterFirst.opened.size).toBe(0)
    expect(foldReducer(afterFirst, { type: 'escape' }).level).toBe('full')
  })

  it('clicking an opened paragraph again folds it', () => {
    const state = run(
      { type: 'setLevel', level: 'key' },
      { type: 'toggleParagraph', hash: 'p1' },
      { type: 'toggleParagraph', hash: 'p1' }
    )
    expect(state.opened.size).toBe(0)
  })

  it('changing level forgets opened paragraphs and sections', () => {
    const state = run(
      { type: 'setLevel', level: 'topic' },
      { type: 'toggleSection', hash: 's1' },
      { type: 'setLevel', level: 'brief' }
    )
    expect(state.unfoldedSections.size).toBe(0)
  })

  it('a chip jump returns to Full anchored on, and flashing, that paragraph', () => {
    const state = run({ type: 'setLevel', level: 'topic' }, { type: 'jump', hash: 'p2' })
    expect(state).toMatchObject({ level: 'full', anchor: 'p2', flash: 'p2' })
    expect(foldReducer(state, { type: 'clearFlash' }).flash).toBeNull()
  })

  it('remembers the last paragraph touched for the caret on return', () => {
    const state = run({ type: 'setLevel', level: 'brief' }, { type: 'toggleParagraph', hash: 'p3' })
    expect(state.anchor).toBe('p3')
  })

  it('Esc does nothing at Full with nothing open', () => {
    expect(escapeHasEffect(INITIAL_FOLD_STATE)).toBe(false)
    expect(foldReducer(INITIAL_FOLD_STATE, { type: 'escape' })).toBe(INITIAL_FOLD_STATE)
  })

  it('forgets everything when another note takes the tab', () => {
    expect(run({ type: 'setLevel', level: 'key' }, { type: 'reset' })).toBe(INITIAL_FOLD_STATE)
  })
})
