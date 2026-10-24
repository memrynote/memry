/**
 * Where, inside a note, another note refers to one of its blocks: a portal or a
 * `[[Note#^anchor]]` link. The where-used popover opens the referring note with
 * one of these in the tab's view state, and the note scrolls to it.
 *
 * A portal is found by its position among the note's portal fences (the index
 * records the same order), a link by the `#^anchor` its target ends in. Both
 * lookups stay out of nested portal windows: those draw OTHER notes' blocks.
 */
export type BlockRef = { kind: 'portal'; ordinal: number } | { kind: 'link'; anchor: string }

const insideWindow = (element: Element): boolean => element.closest('.portal-window') !== null

function decoded(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const blockIdOf = (element: Element | undefined): string | null =>
  element?.closest('[data-id]')?.getAttribute('data-id') ?? null

/** The id of the block holding the reference, or null while it is not on screen yet. */
export function findBlockRefBlockId(container: ParentNode | null, ref: BlockRef): string | null {
  const root = container ?? document
  if (ref.kind === 'portal') {
    const portals = [...root.querySelectorAll('[data-memry-portal]')].filter(
      (el) => !insideWindow(el)
    )
    return blockIdOf(portals[ref.ordinal])
  }
  const suffix = `#^${ref.anchor}`.toLowerCase()
  const link = [...root.querySelectorAll('[data-wiki-link], a[href]')].find((el) => {
    if (insideWindow(el)) return false
    const target = el.getAttribute('data-target') ?? el.getAttribute('href') ?? ''
    return decoded(target).toLowerCase().endsWith(suffix)
  })
  return blockIdOf(link)
}
