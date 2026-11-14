import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { FOLD_MIN_WORDS, type FoldLayers, type FoldLevel } from '@memry/contracts/note-fold'
import { useTabCommands } from '@/commands'
import type { FoldLevelControlProps } from './fold-level-control'
import { createLogger } from '@/lib/logger'
import { commands, events } from '../../../../../generated/bindings'
import {
  buildFoldedView,
  effectiveLevel,
  isFoldable,
  stepLevel,
  type FoldedView
} from './fold-display'
import { foldReducer, INITIAL_FOLD_STATE, type FoldAction, type FoldState } from './fold-state'
import { prefersReducedMotion } from './fold-morph'
import { FOLD_CROSSFADE_MS, surfacesFor, type FoldSurfaces } from './fold-surfaces'

const log = createLogger('NoteFold')

export interface NoteFold {
  layers: FoldLayers | null
  /** The note is long enough to fold; the level control and shortcuts exist only then. */
  foldable: boolean
  state: FoldState
  /** What shows: the requested level, or Brief while that level is still being written. */
  level: FoldLevel
  folded: boolean
  surfaces: FoldSurfaces
  view: FoldedView | null
  /** Props for the chrome fold control; absent while the note cannot fold. */
  control: FoldLevelControlProps | undefined
  dispatch: (action: FoldAction) => void
  setLevel: (level: FoldLevel) => void
  /** One level toward Full (-1) or Topic (1), skipping levels not written. */
  step: (delta: 1 | -1) => void
  retry: () => void
}

/**
 * Fold state for one note or journal day entry. The fold service owns the
 * layers (`commands.foldRun`); this holds the reader's choices and the
 * crossfade phase. The level is never persisted: every note opens at Full.
 */
export function useNoteFold(noteId: string | null | undefined, wordCount: number): NoteFold {
  const [layers, setLayers] = useState<FoldLayers | null>(null)
  const [state, dispatchState] = useReducer(foldReducer, INITIAL_FOLD_STATE)
  const long = wordCount > FOLD_MIN_WORDS
  // The journal keeps one hook across days, and a long note folds slower than a short one:
  // only the latest request's answer is shown, so an older note's or day's never replaces it.
  const latestRequest = useRef(0)

  const refresh = useCallback(
    async (level: FoldLevel = 'full'): Promise<void> => {
      const request = ++latestRequest.current
      if (!noteId) return
      try {
        const next = await commands.foldRun(noteId, level)
        if (request === latestRequest.current && next.noteId === noteId) setLayers(next)
      } catch (error) {
        log.error('Failed to load fold layers', { noteId, error })
      }
    },
    [noteId]
  )

  // A different note resets everything.
  const [trackedNoteId, setTrackedNoteId] = useState(noteId)
  if (trackedNoteId !== noteId) {
    setTrackedNoteId(noteId)
    setLayers(null)
    dispatchState({ type: 'reset' })
  }

  // Crossing the length threshold refetches, so a note that grows past it gains
  // the control without reopening.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react-you-might-not-need-an-effect/no-pass-ref-to-parent -- fetches the fold on this trigger; the ref is this hook's own request counter, nothing crosses a component boundary
    void refresh()
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- effect re-runs on this trigger by design; the value is not read in the effect
  }, [refresh, long])

  useEffect(() => {
    if (!noteId) return undefined
    let active = true
    const registered = events.noteFoldUpdatedEvent.listen(({ payload }) => {
      if (active && payload.noteId === noteId) void refresh()
    })
    void registered.catch((error: unknown) =>
      log.warn('Fold update subscription failed', { noteId, error })
    )
    return () => {
      active = false
      // A subscription that failed was logged when it failed; there is nothing to undo.
      void registered
        .then(
          (unlisten) => unlisten(),
          () => undefined
        )
        .catch((error: unknown) =>
          log.warn('Unsubscribing from fold updates failed', { noteId, error })
        )
    }
  }, [noteId, refresh])

  const foldable = isFoldable(layers)
  const level = effectiveLevel(state.level, layers)
  const folded = foldable && level !== 'full'

  const setLevel = useCallback(
    (next: FoldLevel): void => {
      // Fold from the text as it is now, not as it was when the note opened.
      if (next !== 'full') void refresh(next)
      dispatchState({ type: 'setLevel', level: next })
    },
    [refresh]
  )

  const step = useCallback(
    (delta: 1 | -1): void => {
      if (layers) setLevel(stepLevel(state.level, delta, layers))
    },
    [layers, setLevel, state.level]
  )

  const retry = useCallback((): void => {
    if (!noteId) return
    const request = ++latestRequest.current
    void commands
      .foldRetry(noteId)
      .then((retried) => {
        if (request !== latestRequest.current) return
        if (retried?.noteId === noteId) setLayers(retried)
        else void refresh()
      })
      .catch((error: unknown) => log.error('Failed to retry fold', { noteId, error }))
  }, [noteId, refresh])

  // Crossfade: when `folded` flips, both surfaces show for a moment. Set during
  // render so the first frame after the flip already has both mounted.
  const [phase, setPhase] = useState({ folded, settling: false })
  let settling = phase.settling
  if (phase.folded !== folded) {
    settling = !prefersReducedMotion()
    setPhase({ folded, settling })
  }
  useEffect(() => {
    if (!phase.settling) return undefined
    const timer = setTimeout(() => setPhase((p) => ({ ...p, settling: false })), FOLD_CROSSFADE_MS)
    return () => clearTimeout(timer)
  }, [phase])

  const view = useMemo(
    () =>
      layers && folded
        ? buildFoldedView(layers, level, state.opened, state.unfoldedSections)
        : null,
    [layers, folded, level, state.opened, state.unfoldedSections]
  )

  const foldedTo = useCallback(
    (target: FoldLevel) => ({
      enabled: foldable,
      run: () => setLevel(target)
    }),
    [foldable, setLevel]
  )
  useTabCommands('fold', {
    'fold.full': foldedTo('full'),
    'fold.brief': foldedTo('brief'),
    'fold.key': foldedTo('key'),
    'fold.takeaway': foldedTo('takeaway'),
    'fold.topic': foldedTo('topic')
  })

  return {
    layers,
    foldable,
    state,
    level,
    folded,
    surfaces: surfacesFor(folded, settling),
    view,
    control:
      foldable && layers
        ? { layers, requested: state.level, level, onSelectLevel: setLevel }
        : undefined,
    dispatch: dispatchState,
    setLevel,
    step,
    retry
  }
}
