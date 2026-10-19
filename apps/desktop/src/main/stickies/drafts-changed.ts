/**
 * Main-side signal that the sticky draft list changed, from a local write or
 * an applied peer change. The window code listens to show or hide the edge
 * tab. Kept apart from the window code so the sync handler does not load it.
 *
 * @module main/stickies/drafts-changed
 */

type Listener = () => void

let listener: Listener | null = null
let scheduled = false

export function setStickyDraftsChangedListener(next: Listener | null): void {
  listener = next
}

/**
 * Coalesces a burst into one call on the next tick, which also lands after a
 * pull page's transaction commits.
 */
export function notifyStickyDraftsChanged(): void {
  if (scheduled) return
  scheduled = true
  setTimeout(() => {
    scheduled = false
    listener?.()
  }, 0)
}
