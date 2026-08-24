/**
 * Marking wiki links whose target note does not exist.
 *
 * The inline spec's `render()` is synchronous vanilla DOM with no IPC access,
 * so brokenness cannot be painted from inside the chip. Instead the editor
 * mount resolves the document's targets in one batch call
 * (`notes:resolve-titles`, see `use-wiki-link-broken.ts`) and hands the broken
 * set to this plugin, which applies `.wiki-link-broken` as a node decoration.
 *
 * A decoration only adds a class — the chip's span stays mounted through
 * mousedown/mouseup, so click targets never shift (the
 * decoration-hides-atom-between-mousedown-and-mouseup failure mode).
 *
 * The plugin is deliberately dumb: it matches `target` attributes against a
 * set of lowercased raw targets it is given and knows nothing about IPC,
 * headings, or resolution order. On a doc change it rebuilds from the same
 * set, so a freshly typed link to a known-missing title is styled without a
 * round trip; a link to a title never seen before stays unstyled until the
 * next resolve pass refreshes the set.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'

export const WIKI_LINK_BROKEN_PLUGIN_KEY = new PluginKey<WikiLinkBrokenPluginState>(
  'wikiLinkBroken'
)

const SET_BROKEN_TARGETS_META = 'wikiLinkBrokenSet'

interface WikiLinkBrokenPluginState {
  /** Lowercased raw `target` attributes known to resolve to nothing. */
  broken: ReadonlySet<string>
  decorations: DecorationSet
}

/** Every distinct non-empty `target` attribute in the document, in order. */
export function collectWikiLinkTargets(doc: ProseMirrorNode): string[] {
  const targets = new Set<string>()
  doc.descendants((node) => {
    if (node.type.name !== 'wikiLink') return
    const target = typeof node.attrs.target === 'string' ? node.attrs.target.trim() : ''
    if (target) targets.add(target)
  })
  return [...targets]
}

function buildDecorations(doc: ProseMirrorNode, broken: ReadonlySet<string>): DecorationSet {
  if (broken.size === 0) return DecorationSet.empty

  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'wikiLink') return
    const target = typeof node.attrs.target === 'string' ? node.attrs.target.trim() : ''
    if (!target || !broken.has(target.toLowerCase())) return
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'wiki-link-broken' }))
  })
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty
}

/** Hands the plugin a fresh broken set; call after each batch resolve. */
export function setBrokenWikiTargets(view: EditorView, broken: ReadonlySet<string>): void {
  view.dispatch(view.state.tr.setMeta(SET_BROKEN_TARGETS_META, broken))
}

export function createWikiLinkBrokenPlugin(): Plugin {
  return new Plugin<WikiLinkBrokenPluginState>({
    key: WIKI_LINK_BROKEN_PLUGIN_KEY,

    state: {
      init: () => ({ broken: new Set<string>(), decorations: DecorationSet.empty }),

      apply(tr, value, _oldState, newState) {
        const nextBroken = tr.getMeta(SET_BROKEN_TARGETS_META) as ReadonlySet<string> | undefined
        if (nextBroken) {
          return { broken: nextBroken, decorations: buildDecorations(newState.doc, nextBroken) }
        }
        if (tr.docChanged) {
          return { broken: value.broken, decorations: buildDecorations(newState.doc, value.broken) }
        }
        return value
      }
    },

    props: {
      decorations(state) {
        return WIKI_LINK_BROKEN_PLUGIN_KEY.getState(state)?.decorations ?? null
      }
    }
  })
}
