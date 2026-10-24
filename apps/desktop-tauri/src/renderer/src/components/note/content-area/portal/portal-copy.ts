/**
 * What the toolbar's "Copy contents" and "Copy link" put on the clipboard.
 *
 * @module note/content-area/portal/portal-copy
 */

import { stripAnchor, type PortalTarget } from '@memry/shared/portal-block'
import type { PortalWindowBlock } from './portal-window-plugin'

/** The visible slice as a plain markdown outline, nesting as indent. */
export function portalContentsMarkdown(visible: readonly PortalWindowBlock[]): string {
  if (visible.length === 0) return ''
  const base = Math.min(...visible.map((block) => block.depth))
  return visible
    .map((block) => `${'  '.repeat(block.depth - base)}- ${stripAnchor(block.text)}`)
    .join('\n')
}

/** `[[Note#^anchor]]` for a portal on one or more blocks, `[[Note]]` for the whole note. */
export function portalLinkText(title: string, target: PortalTarget): string {
  const first = target.kind === 'blocks' ? target.blocks[0] : undefined
  return first ? `[[${title}#^${first}]]` : `[[${title}]]`
}
