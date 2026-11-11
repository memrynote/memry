/**
 * The typing an editor refused while the window held it for an outside edit
 * (`typing-hold-plugin.ts`), kept to replay once the hold ends. Every refused transaction was made
 * against the document the editor showed, which never took the ones before it, so each one is
 * mapped over those queued before it, as concurrent changes are: two keystrokes at one caret
 * replay in the order they were typed. When the document changed meanwhile (the outside edit,
 * another window's frame), the queue moves onto it through the content diff of the two documents
 * (`outsideEditMap`), since y-prosemirror replaces the whole body for every frame. A change that
 * touches text the other change touched does not apply as typed: its typed text goes in at the
 * nearest edge of that change (after it, from inside it), so it stays in the note, and the
 * deletion or formatting it carried is left out. Either outcome is logged, without the text.
 *
 * @module note/content-area/refused-typing
 */

import type { Node } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import {
  AddMarkStep,
  Mapping,
  RemoveMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
  type Step,
  type StepMap,
  Transform
} from '@tiptap/pm/transform'
import { createLogger } from '@/lib/logger'
import { outsideEditMap } from './outside-edit-selection'

const log = createLogger('TypingHold')

/** What a move of the queue did with its steps that touched the other change. */
interface Outcome {
  /** Steps whose typed text went in after the other change instead of where it was typed. */
  moved: number
  /** Steps that carried no text and were left out (a deletion, a mark, a wrap). */
  skipped: number
}

export class RefusedTyping {
  /** The document the queue applies to: the editor's, unless it changed since the last move. */
  private base: Node | null = null
  private steps: Step[] = []

  get size(): number {
    return this.steps.length
  }

  /** Queues the steps of `tr`, which the editor refused. */
  add(tr: Transaction): void {
    if (this.base === null) this.base = tr.before
    this.moveTo(tr.before)
    const queued = new Mapping(this.steps.map((step) => step.getMap()))
    const onto = new Transform(this.base)
    for (const step of this.steps) onto.step(step)
    report('A refused change touched one refused before it', rebase(tr.steps, queued, null, onto))
    this.steps.push(...onto.steps.slice(this.steps.length))
  }

  /** The transaction that applies the queue to `state`'s document, or null; empties the queue. */
  replay(state: EditorState): Transaction | null {
    if (this.base === null) return null
    this.moveTo(state.doc)
    const tr = state.tr
    for (const step of this.steps) tr.step(step)
    this.clear()
    return tr.docChanged ? tr : null
  }

  /** Empties the queue; returns how many steps it held. */
  clear(): number {
    const size = this.steps.length
    this.base = null
    this.steps = []
    return size
  }

  /** Moves the queue onto `doc`, the document its base became. */
  private moveTo(doc: Node): void {
    const base = this.base
    if (base === null || base === doc) return
    this.base = doc
    if (this.steps.length === 0) return
    const map = outsideEditMap(base, doc)
    const onto = new Transform(doc)
    const outcome = rebase(this.steps, new Mapping([map]), map, onto)
    report('Typing held for an outside edit touched what the edit changed', outcome)
    this.steps = onto.steps
  }
}

/**
 * Applies to `onto` the `steps`, made in order against a document that `over` maps to `onto`'s,
 * as prosemirror-collab rebases: each step is mapped back over the steps before it, then through
 * `over`, then forward over their rebased copies. A step that touches a range of `outside` (in the
 * positions of the steps' document) goes through `keepText` instead.
 */
function rebase(
  steps: readonly Step[],
  over: Mapping,
  outside: StepMap | null,
  onto: Transform
): Outcome {
  const outcome: Outcome = { moved: 0, skipped: 0 }
  const mapping = new Mapping()
  for (let i = steps.length - 1; i >= 0; i--) mapping.appendMap(steps[i].getMap().invert())
  mapping.appendMapping(over)
  steps.forEach((step, i) => {
    const through = mapping.slice(steps.length - i)
    const back = mapping.slice(steps.length - i, steps.length)
    const range = rangeOf(step)
    const clashes =
      outside !== null &&
      range !== null &&
      touches(outside, back.map(range.from, -1), back.map(range.to, 1))
    const mapped = clashes ? null : step.map(through)
    if (mapped && !onto.maybeStep(mapped).failed) {
      mapping.appendMap(mapped.getMap(), steps.length - 1 - i)
      return
    }
    const added = onto.steps.length
    if (keepText(step, through, onto)) outcome.moved++
    else outcome.skipped++
    for (const kept of onto.steps.slice(added)) mapping.appendMap(kept.getMap())
  })
  return outcome
}

/** Puts the text `step` typed where its end maps to; false if it typed none. */
function keepText(step: Step, through: Mapping, onto: Transform): boolean {
  if (!(step instanceof ReplaceStep) || step.slice.size === 0) return false
  const pos = Math.min(through.map(step.to, 1), onto.doc.content.size)
  const before = onto.steps.length
  onto.replace(pos, pos, step.slice)
  return onto.steps.length > before
}

/** Whether a range of `map` meets `from`..`to`, its ends included. */
function touches(map: StepMap, from: number, to: number): boolean {
  let hit = false
  map.forEach((oldStart, oldEnd) => {
    if (oldStart <= to && oldEnd >= from) hit = true
  })
  return hit
}

function rangeOf(step: Step): { from: number; to: number } | null {
  if (
    step instanceof ReplaceStep ||
    step instanceof ReplaceAroundStep ||
    step instanceof AddMarkStep ||
    step instanceof RemoveMarkStep
  ) {
    return { from: step.from, to: step.to }
  }
  return null
}

function report(message: string, { moved, skipped }: Outcome): void {
  if (moved + skipped > 0) log.warn(message, { moved, skipped })
}
