/**
 * Marks the wiki links that may draw as a row or card.
 *
 * Whether a link is alone in its paragraph is a fact about the document, which
 * the chip's own `render()` cannot see. This decorates exactly those links
 * whose settings ask for more than a chip, with `data-wiki-link-sole="<size>"`
 * on the chip itself, and the stylesheet draws the row, card or inline
 * preview from that. Nothing is written to the document, and a link with the
 * default settings gets no decoration at all.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { wikiLinkDisplayProps } from '@memry/shared/wiki-link-props'
import { isSoleWikiLinkAt } from './wiki-link-display'

export const WIKI_LINK_CARD_PLUGIN_KEY = new PluginKey<DecorationSet>('wikiLinkCard')

export const SOLE_LINK_ATTRIBUTE = 'data-wiki-link-sole'

function buildDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const link = node.firstChild
    if (link?.type.name === 'wikiLink' && isSoleWikiLinkAt(doc, pos + 1)) {
      const { size, preview } = wikiLinkDisplayProps(link.attrs)
      if (size !== 'none' || preview) {
        decorations.push(
          Decoration.node(pos + 1, pos + 1 + link.nodeSize, { [SOLE_LINK_ATTRIBUTE]: size })
        )
      }
    }
    return false
  })
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty
}

export function createWikiLinkCardPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: WIKI_LINK_CARD_PLUGIN_KEY,
    state: {
      init: (_config, state) => buildDecorations(state.doc),
      apply: (tr, value, _oldState, newState) =>
        tr.docChanged ? buildDecorations(newState.doc) : value
    },
    props: {
      decorations: (state) => WIKI_LINK_CARD_PLUGIN_KEY.getState(state) ?? null
    }
  })
}
