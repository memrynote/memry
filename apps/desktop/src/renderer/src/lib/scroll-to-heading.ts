/**
 * Scrolling a heading block into view inside ONE editor pane.
 *
 * The lookup is scoped to the pane's own container rather than the document.
 * Split view renders the same note's block ids in both panes, and
 * `document.querySelector` returns whichever comes first in the DOM — so the
 * outline used to scroll the pane the user was not looking at. A heading link
 * lands on exactly the same trap, which is why both now come through here.
 *
 * `scrollIntoView` is guarded: jsdom does not implement it, and a renderer test
 * that merely renders a note should not throw on that account.
 */
export function scrollToHeadingBlock(
  container: HTMLElement | null,
  headingId: string,
  options: { smooth: boolean }
): boolean {
  const root: ParentNode = container ?? document
  const element = root.querySelector(`[data-id="${headingId}"]`)
  if (!element) return false
  element.scrollIntoView?.({
    behavior: options.smooth ? 'smooth' : 'auto',
    block: 'start'
  })
  return true
}

/** Frames the offset must hold still before the jump counts as landed. */
const SETTLE_FRAMES = 3
/** Sub-pixel tolerance when deciding whether the offset stopped moving. */
const OFFSET_EPSILON = 1

/**
 * Scrolls to a heading that does not exist in the DOM yet, and keeps it in view
 * until the page stops moving underneath it.
 *
 * Both halves are load-bearing, and the first one is why the E2E for this failed
 * the first time it ran:
 *
 * - **The block may not be rendered.** `ContentArea` holds its render behind a
 *   placeholder until the CRDT binding settles, while `onHeadingsChange` fires
 *   as soon as the fragment binds. So there is a window where the heading is in
 *   the page's `headings` state and its `[data-id]` node is not in the document.
 *   A single lookup loses that race, and for a note nobody then edits there is
 *   no second heading emission to retry on — the jump simply never happens.
 * - **The page keeps growing after the jump.** Lazy chunks, the note fetch and
 *   the editor mount all land at their own pace, so an offset written early
 *   drifts. Re-applying until it holds still for a few frames is the same shape
 *   `use-tab-scroll-restore` uses, for the same reason.
 *
 * Returns a cancel function. `getHeadingId` is a getter so the caller can hand
 * over a target that only becomes known once the headings arrive.
 */
export function scrollToHeadingWhenReady(options: {
  getContainer: () => HTMLElement | null
  getHeadingId: () => string | null
  smooth: boolean
  timeoutMs: number
  onSettled: () => void
}): () => void {
  const { getContainer, getHeadingId, smooth, timeoutMs, onSettled } = options

  let frame: number | null = null
  let cancelled = false
  let settledFrames = 0
  let lastOffset: number | null = null

  const deadline = setTimeout(() => {
    // The heading never arrived — renamed, deleted, or a target we cannot
    // address. Give up and let the caller drop the anchor, or scroll restore
    // stays suppressed for every later visit to this tab.
    cancel()
    onSettled()
  }, timeoutMs)

  function cancel(): void {
    cancelled = true
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    clearTimeout(deadline)
  }

  function step(): void {
    if (cancelled) return
    frame = null

    const container = getContainer()
    const headingId = getHeadingId()
    if (headingId) {
      const root: ParentNode = container ?? document
      const element = root.querySelector(`[data-id="${headingId}"]`)
      if (element) {
        element.scrollIntoView?.({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })

        const offset = element.getBoundingClientRect().top
        settledFrames =
          lastOffset !== null && Math.abs(offset - lastOffset) <= OFFSET_EPSILON
            ? settledFrames + 1
            : 0
        lastOffset = offset

        if (settledFrames >= SETTLE_FRAMES) {
          cancel()
          onSettled()
          return
        }
      }
    }

    frame = requestAnimationFrame(step)
  }

  frame = requestAnimationFrame(step)
  return cancel
}
