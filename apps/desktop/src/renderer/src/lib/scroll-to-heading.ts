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
