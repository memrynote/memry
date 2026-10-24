/**
 * A window never takes a drop into the blocks it hides.
 *
 * Hidden blocks are `display: none`, so a pointer cannot aim at them, but the
 * drop cursor can still resolve to a position inside a hidden block's children
 * (the gap between two visible blocks that a hidden one sits between). A local
 * transaction that inserts content strictly inside a hidden span is refused,
 * which makes ProseMirror drop nothing; the drop at either edge of the span
 * (the nearest visible gap) is untouched.
 *
 * @module note/content-area/portal/portal-drop-guard-plugin
 */

import { Plugin, PluginKey } from '@tiptap/pm/state'
import { ReplaceAroundStep, ReplaceStep, type Step } from '@tiptap/pm/transform'
import { ySyncPluginKey } from 'y-prosemirror'
import { isAnchorRepair } from './anchor-visibility-plugin'
import { portalWindowKey } from './portal-window-plugin'

interface Span {
  from: number
  to: number
}

/** `structure` is set at runtime by prosemirror-transform but is missing from its typings. */
const isStructural = (step: ReplaceAroundStep): boolean =>
  (step as ReplaceAroundStep & { structure?: boolean }).structure === true

/** True when a step puts content strictly inside one of `spans`. */
function insertsInside(tr: { steps: readonly Step[] }, hidden: readonly Span[]): boolean {
  let spans = hidden
  for (const step of tr.steps) {
    // A structural wrap (Tab sinking a block, Shift+Tab lifting one) re-seats
    // closing tokens that sit at the end of a hidden block; it adds no content.
    const insertedAt =
      step instanceof ReplaceStep
        ? step.slice.size > 0
          ? step.from
          : undefined
        : step instanceof ReplaceAroundStep && !isStructural(step) && step.slice.size > 0
          ? step.from
          : undefined
    if (insertedAt !== undefined && spans.some((h) => insertedAt > h.from && insertedAt < h.to))
      return true
    const map = step.getMap()
    spans = spans.map((h) => ({ from: map.map(h.from, 1), to: map.map(h.to, -1) }))
  }
  return false
}

export function createPortalDropGuardPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('portalDropGuard'),
    filterTransaction(tr, state) {
      if (!tr.docChanged || tr.getMeta(ySyncPluginKey)?.isChangeOrigin || isAnchorRepair(tr))
        return true
      const window = portalWindowKey.getState(state)
      return !window || !insertsInside(tr, window.hiddenSpans)
    }
  })
}
