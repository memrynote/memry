/**
 * Scroll an inline date pill (`<span data-date-mention data-anchor-id="...">`)
 * into view by its stable anchor id. Used when opening a fired `note_date`
 * reminder so navigation lands on the exact pill.
 *
 * Pure DOM helper (no React) so it stays trivially unit-testable.
 *
 * @returns true if a matching pill was found and scrolled to, false otherwise.
 */
export function scrollToAnchor(container: HTMLElement, anchorId: string): boolean {
  const el = container.querySelector(`[data-anchor-id="${CSS.escape(anchorId)}"]`)
  if (!el) return false
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  return true
}
