import type { FoldLevel } from '@memry/contracts/note-fold'

/**
 * What the reader has done to the folded view. The level is never saved: every
 * note opens at Full, and this state lives only as long as the note is open.
 */
export interface FoldState {
  /** The level the reader asked for; a level not written yet displays as Brief. */
  level: FoldLevel
  /** Paragraphs opened to Full in place, by hash. */
  opened: ReadonlySet<string>
  /** Topic sections unfolded from their card, by hash. */
  unfoldedSections: ReadonlySet<string>
  /** The paragraph last touched. Returning to Full puts the caret there. */
  anchor: string | null
  /** A paragraph to flash once Full shows it (chip jump). */
  flash: string | null
}

export type FoldAction =
  | { type: 'setLevel'; level: FoldLevel }
  | { type: 'toggleParagraph'; hash: string }
  | { type: 'toggleSection'; hash: string }
  /** Topic chip: Full, with that paragraph in view and flashed. */
  | { type: 'jump'; hash: string }
  | { type: 'clearFlash' }
  /** A different note took the tab. */
  | { type: 'reset' }
  /** Esc: opened paragraphs and sections first, then Full. */
  | { type: 'escape' }

const EMPTY: ReadonlySet<string> = new Set()

export const INITIAL_FOLD_STATE: FoldState = {
  level: 'full',
  opened: EMPTY,
  unfoldedSections: EMPTY,
  anchor: null,
  flash: null
}

function toggled(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  const next = new Set(set)
  if (!next.delete(value)) next.add(value)
  return next
}

export function foldReducer(state: FoldState, action: FoldAction): FoldState {
  switch (action.type) {
    case 'setLevel':
      if (action.level === state.level) return state
      return { ...state, level: action.level, opened: EMPTY, unfoldedSections: EMPTY, flash: null }
    case 'toggleParagraph':
      return { ...state, opened: toggled(state.opened, action.hash), anchor: action.hash }
    case 'toggleSection':
      return { ...state, unfoldedSections: toggled(state.unfoldedSections, action.hash) }
    case 'jump':
      return {
        ...state,
        level: 'full',
        opened: EMPTY,
        unfoldedSections: EMPTY,
        anchor: action.hash,
        flash: action.hash
      }
    case 'reset':
      return INITIAL_FOLD_STATE
    case 'clearFlash':
      return state.flash === null ? state : { ...state, flash: null }
    case 'escape':
      if (state.opened.size > 0 || state.unfoldedSections.size > 0) {
        return { ...state, opened: EMPTY, unfoldedSections: EMPTY }
      }
      return state.level === 'full' ? state : { ...state, level: 'full', flash: null }
  }
}

/** Esc closes opened paragraphs first, then returns to Full. Nothing to do at Full with nothing open. */
export function escapeHasEffect(state: FoldState): boolean {
  return state.level !== 'full' || state.opened.size > 0 || state.unfoldedSections.size > 0
}
