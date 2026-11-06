import type * as Y from 'yjs'

/**
 * ProseMirror commits a composition's last text up to 20 ms after `compositionend`
 * (`scheduleComposeEnd(view, 20)` in prosemirror-view); a wait for the composition to end waits
 * past that, so the text is in the doc when the typing is sent.
 */
const COMPOSITION_SETTLE_MS = 50

/**
 * This window's hold of new typing in one note's document while the host applies an outside
 * edit of its file (`editor/typing.rs`): from the host's barrier until the edit's frame applies,
 * the host's release frame, or the hold's own deadline. Every editor of the document
 * in the window refuses, meanwhile, the transactions that would change it
 * (`createTypingHoldPlugin`), except a composition's, and says when a composition runs.
 */
export class TypingHold {
  private barrier: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private composing = false
  private readonly compositionEnds = new Set<() => void>()

  get held(): boolean {
    return this.barrier !== null
  }

  /** Holds typing for `barrier` until its release, or `ms` at most. */
  hold(barrier: number, ms: number): void {
    this.clearTimer()
    this.barrier = barrier
    this.timer = setTimeout(() => this.release(barrier), ms)
  }

  /** Ends the hold of `barrier`, or any hold. The release of an earlier barrier ends none. */
  release(barrier?: number): void {
    if (barrier !== undefined && barrier !== this.barrier) return
    this.barrier = null
    this.clearTimer()
  }

  compositionStarted(): void {
    this.composing = true
  }

  compositionEnded(): void {
    this.composing = false
    for (const ended of this.compositionEnds) ended()
  }

  /**
   * True once no composition runs and the last one's text is in; false if one still runs after
   * `ms`.
   */
  whenNotComposing(ms: number): Promise<boolean> {
    if (!this.composing) return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (ended: boolean): void => {
        clearTimeout(deadline)
        this.compositionEnds.delete(onEnd)
        resolve(ended)
      }
      const onEnd = (): void => void setTimeout(() => done(true), COMPOSITION_SETTLE_MS)
      const deadline = setTimeout(() => done(false), ms)
      this.compositionEnds.add(onEnd)
    })
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}

const holds = new WeakMap<Y.Doc, TypingHold>()

/** The typing hold of `doc` in this window, shared by its provider and every editor bound to it. */
export function typingHoldOf(doc: Y.Doc): TypingHold {
  let hold = holds.get(doc)
  if (!hold) {
    hold = new TypingHold()
    holds.set(doc, hold)
  }
  return hold
}
