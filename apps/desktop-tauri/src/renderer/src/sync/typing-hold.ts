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
 * (`createTypingHoldPlugin`), except those of a composition that ran when the hold began, and
 * says when a composition runs.
 */
export class TypingHold {
  private barrier: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private composing = false
  private composingAtHold = false
  private feeding = false
  private readonly compositionEnds = new Set<() => void>()
  private readonly releases = new Set<() => void>()

  get held(): boolean {
    return this.barrier !== null
  }

  /** True while an outside edit's frame applies: every editor maps its selection through it. */
  get feedingEdit(): boolean {
    return this.feeding
  }

  /**
   * A composition that ran when the hold began goes on: it is never cut. One that begins during
   * the hold is held like typing.
   */
  get takesComposition(): boolean {
    return this.composingAtHold
  }

  /** Holds typing for `barrier` until its release, or `ms` at most. */
  hold(barrier: number, ms: number): void {
    this.clearTimer()
    this.barrier = barrier
    this.composingAtHold = this.composing
    this.timer = setTimeout(() => this.release(barrier), ms)
  }

  /**
   * Ends the hold of `barrier`, or any hold, and tells the editors, which replay the typing they
   * refused. The release of an earlier barrier ends none.
   */
  release(barrier?: number): void {
    if (barrier !== undefined && barrier !== this.barrier) return
    const held = this.held
    this.end()
    if (held) this.released()
  }

  /**
   * Ends any hold without a replay: the document's binding lets go of it, and typing that went in
   * now would reach no host. The editors log what they refused when they go.
   */
  end(): void {
    this.barrier = null
    this.clearTimer()
  }

  /** Runs `listener` after each release, the edit's frame applied first. */
  onRelease(listener: () => void): () => void {
    this.releases.add(listener)
    return () => this.releases.delete(listener)
  }

  /**
   * Resolves once no hold is on: at once, or after the release that ends this one, its replays
   * done.
   */
  settled(): Promise<void> {
    if (!this.held) return Promise.resolve()
    return new Promise((resolve) => {
      const stop = this.onRelease(() => {
        stop()
        resolve()
      })
    })
  }

  /**
   * Applies an outside edit's frame: the hold ends, `apply` runs as the edit's feed, and then the
   * editors replay their refused typing over the edit.
   */
  feed(apply: () => void): void {
    this.end()
    this.feeding = true
    try {
      apply()
    } finally {
      this.feeding = false
    }
    this.released()
  }

  private released(): void {
    for (const listener of this.releases) listener()
  }

  /**
   * A composition that begins after the one that ran at hold start ended is held like typing.
   * That one's end does not clear `composingAtHold`: ProseMirror commits its last text after the
   * plugin hears `compositionend`.
   */
  compositionStarted(): void {
    if (!this.composing) this.composingAtHold = false
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
