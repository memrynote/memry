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
 *
 * The same pass also hands over the links whose target is an object (a note
 * with a tag with fields in its header): those get `.wiki-link--object` and
 * the attrs `objectChipAttrs` builds, painted by CSS as the object chip. A
 * decoration again, never a node prop: the file keeps `[[Title]]`.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'

export const WIKI_LINK_BROKEN_PLUGIN_KEY = new PluginKey<WikiLinkBrokenPluginState>(
  'wikiLinkBroken'
)

const SET_BROKEN_TARGETS_META = 'wikiLinkBrokenSet'

/** Lowercased raw `target` → decoration attrs of an object link. */
export type ObjectLinkAttrs = ReadonlyMap<string, Record<string, string>>

const NO_OBJECTS: ObjectLinkAttrs = new Map()

interface WikiLinkDecorationTargets {
  /** Lowercased raw `target` attributes known to resolve to nothing. */
  broken: ReadonlySet<string>
  objects: ObjectLinkAttrs
}

interface WikiLinkBrokenPluginState extends WikiLinkDecorationTargets {
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

function buildDecorations(
  doc: ProseMirrorNode,
  { broken, objects }: WikiLinkDecorationTargets
): DecorationSet {
  if (broken.size === 0 && objects.size === 0) return DecorationSet.empty

  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'wikiLink') return
    const target = typeof node.attrs.target === 'string' ? node.attrs.target.trim() : ''
    if (!target) return
    const key = target.toLowerCase()
    if (broken.has(key)) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'wiki-link-broken' }))
      return
    }
    const object = objects.get(key)
    if (object) decorations.push(Decoration.node(pos, pos + node.nodeSize, object))
  })
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty
}

/** Hands the plugin a fresh broken set (and object links); call after each batch resolve. */
export function setBrokenWikiTargets(
  view: EditorView,
  broken: ReadonlySet<string>,
  objects: ObjectLinkAttrs = NO_OBJECTS
): void {
  view.dispatch(view.state.tr.setMeta(SET_BROKEN_TARGETS_META, { broken, objects }))
}

export function createWikiLinkBrokenPlugin(): Plugin {
  return new Plugin<WikiLinkBrokenPluginState>({
    key: WIKI_LINK_BROKEN_PLUGIN_KEY,

    state: {
      init: () => ({
        broken: new Set<string>(),
        objects: NO_OBJECTS,
        decorations: DecorationSet.empty
      }),

      apply(tr, value, _oldState, newState) {
        const next = tr.getMeta(SET_BROKEN_TARGETS_META) as WikiLinkDecorationTargets | undefined
        if (next) return { ...next, decorations: buildDecorations(newState.doc, next) }
        if (tr.docChanged) return { ...value, decorations: buildDecorations(newState.doc, value) }
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
