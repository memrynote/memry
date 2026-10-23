/**
 * A portal is never the last block of the host note.
 *
 * The portal's definition (a fence) is shown only while the caret is in it, so
 * a portal at the end of the document leaves the caret nowhere to go but into
 * the JSON: Meta+ArrowDown, then typing, corrupts the fence. A trailing empty
 * paragraph gives the caret a place to land. It serializes to nothing, so a
 * file that ends in a fence is read and written byte for byte as before.
 *
 * @module note/content-area/portal/portal-trailing-paragraph-plugin
 */

import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { PORTAL_BLOCK_LANGUAGE } from '@memry/shared/portal-block'

export const portalTrailingParagraphKey = new PluginKey('portalTrailingParagraph')

function isPortalContainer(node: PMNode): boolean {
  const content = node.firstChild
  return (
    node.type.name === 'blockContainer' &&
    content?.type.name === 'codeBlock' &&
    content.attrs.language === PORTAL_BLOCK_LANGUAGE
  )
}

/**
 * The transaction that puts an empty paragraph after the document's last
 * block, or null when that block is not a portal. A portal that holds child
 * blocks is not last: its last descendant is.
 */
function appendParagraph(state: EditorState): Transaction | null {
  const { blockContainer, blockGroup } = state.schema.nodes
  if (!blockContainer || !blockGroup) return null
  let group = state.doc.lastChild
  let groupPos = 0
  while (group?.type === blockGroup && group.lastChild) {
    const last: PMNode = group.lastChild
    const lastPos = groupPos + 1 + group.content.size - last.nodeSize
    const children = last.lastChild
    if (children?.type === blockGroup) {
      groupPos = lastPos + 1 + last.content.size - children.nodeSize
      group = children
      continue
    }
    if (!isPortalContainer(last)) return null
    const paragraph = blockContainer.createAndFill({ id: crypto.randomUUID() })
    if (!paragraph) return null
    return state.tr.insert(groupPos + 1 + group.content.size, paragraph)
  }
  return null
}

export function createPortalTrailingParagraphPlugin(): Plugin {
  let host: EditorView | null = null
  return new Plugin({
    key: portalTrailingParagraphKey,
    view(view: EditorView) {
      host = view
      let alive = true
      // A document that loads ending in a portal sees no transaction of its own.
      queueMicrotask(() => {
        if (!alive || !view.editable) return
        const tr = appendParagraph(view.state)
        if (tr) view.dispatch(tr)
      })
      return {
        destroy() {
          alive = false
          host = null
        }
      }
    },
    appendTransaction(transactions, _old, newState) {
      if (host && !host.editable) return null
      if (!transactions.some((tr) => tr.docChanged)) return null
      return appendParagraph(newState)
    }
  })
}
