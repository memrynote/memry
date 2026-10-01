import { DOMParser as ProseMirrorDOMParser, DOMSerializer, type Schema } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { normalizeWritingOverflowItem, type WritingOverflowItem } from '@memry/shared'

/**
 * A stashed range as the editor's own clipboard HTML: what a copy would put on
 * the clipboard, which a drop or paste turns back into the same nodes and marks
 * (bold, links, wiki links, mentions).
 */
export function stashHtml(view: EditorView, from: number, to: number): string {
  return view.serializeForClipboard(view.state.doc.slice(from, to)).dom.innerHTML
}

/**
 * Stored overflow HTML rendered for the rail. It is parsed through the editor's
 * schema and serialized back with the schema's own DOM specs, so only nodes and
 * marks the editor knows survive: the same filter a paste goes through, which
 * also keeps synced HTML from running anything.
 */
export function renderOverflowHtml(
  schema: Schema,
  html: string
): HTMLElement | DocumentFragment | null {
  const template = document.createElement('template')
  template.innerHTML = html
  const slice = ProseMirrorDOMParser.fromSchema(schema).parseSlice(template.content)
  if (slice.content.size === 0) return null
  return previewSerializer(schema).serializeFragment(slice.content)
}

/**
 * The schema's serializer, except that a wiki link renders as the editor's
 * chip instead of its on-disk `[[Target]]` text (the node's toDOM is the vault
 * form, which is right for clipboard and files, not for reading).
 */
function previewSerializer(schema: Schema): DOMSerializer {
  const nodes = DOMSerializer.nodesFromSchema(schema)
  if (schema.nodes.wikiLink) {
    nodes.wikiLink = (node) => {
      const target = String(node.attrs.target ?? '')
      const alias = String(node.attrs.alias ?? '')
      const chip = document.createElement('span')
      chip.className = 'wiki-link'
      chip.title = target
      chip.textContent = alias || target
      return chip
    }
  }
  return new DOMSerializer(nodes, DOMSerializer.marksFromSchema(schema))
}

/** A new overflow item, or null when the text is empty. Oversized HTML is dropped to text. */
export function newOverflowItem(
  id: string,
  rawText: string,
  html?: string,
  label?: string
): WritingOverflowItem | null {
  return normalizeWritingOverflowItem({
    id,
    text: rawText.trim(),
    html,
    label,
    createdAt: Date.now()
  })
}
