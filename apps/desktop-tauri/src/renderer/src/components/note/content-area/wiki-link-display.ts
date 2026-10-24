/**
 * Per-link display settings of a wiki link (#2845): where they may be set and
 * how a change is written.
 *
 * A link draws as a row or a card only when it is the whole of its paragraph,
 * which is the same shape the `<!-- link-card:… -->` marker is written for
 * (`@memry/shared/link-card-marker`). Inside running text the chip stays a chip
 * and the props are ignored, so the menu offers no setting there.
 */

import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { wikiLinkDisplayProps, type WikiLinkDisplayProps } from '@memry/shared/wiki-link-props'

/**
 * Whether the wiki link at `pos` is the only content of a paragraph. Whitespace
 * beside it does not count: the `[[` picker inserts the link followed by a
 * space, and the same rule decides whether the marker is written
 * (`@memry/shared/link-card-marker`).
 */
export function isSoleWikiLinkAt(doc: ProseMirrorNode, pos: number): boolean {
  const parent = doc.resolve(pos).parent
  if (parent.type.name !== 'paragraph') return false
  let links = 0
  let other = false
  parent.forEach((child) => {
    if (child.type.name === 'wikiLink') links++
    else if (!child.isText || child.text?.trim()) other = true
  })
  return links === 1 && !other
}

/** The settings of the link at `pos`, or null when it is not alone in its paragraph. */
export function wikiLinkDisplayAt(doc: ProseMirrorNode, pos: number): WikiLinkDisplayProps | null {
  if (!isSoleWikiLinkAt(doc, pos)) return null
  const node = doc.nodeAt(pos)
  return node ? wikiLinkDisplayProps(node.attrs) : null
}

/**
 * Writes display settings onto the link at `pos` through the editor's own view,
 * so the change reaches the Y.Doc and the vault file like any other edit.
 *
 * The menu was opened on a link as it was then; `target` pins it, because a
 * remote edit since may have moved or replaced the node.
 */
export function setWikiLinkDisplayAt(
  view: EditorView,
  pos: number,
  target: string,
  patch: Partial<WikiLinkDisplayProps>
): boolean {
  const node = view.state.doc.nodeAt(pos)
  if (node?.type.name !== 'wikiLink' || String(node.attrs.target ?? '').trim() !== target) {
    return false
  }
  if (!isSoleWikiLinkAt(view.state.doc, pos)) return false

  view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch }))
  return true
}
