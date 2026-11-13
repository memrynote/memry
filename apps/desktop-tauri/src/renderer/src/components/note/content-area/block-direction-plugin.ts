import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

/**
 * A bilingual note has Persian or Arabic blocks next to English ones, and the UI
 * language owns only one of them. Each text block takes the direction of its first
 * strong character, and so does the block container around it, so alignment, list
 * marker side and nested indent follow the text a block holds. A block holding lines
 * in both directions keeps its first line's direction; editor-rtl.css then gives each
 * line its own. Decoration only: the
 * document, the markdown file and synced data are unchanged.
 *
 * It sets an explicit `dir` instead of `dir="auto"` because auto skips descendants
 * that carry their own `dir`, so a container could never resolve from its content.
 */

const FIRST_LETTER = /\p{L}/u
const RTL_SCRIPT = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/

/** Direction of the first letter in `text`, or null when it has none. */
export function firstStrongDirection(text: string): 'ltr' | 'rtl' | null {
  for (const char of text) {
    if (FIRST_LETTER.test(char)) return RTL_SCRIPT.test(char) ? 'rtl' : 'ltr'
  }
  return null
}

/** A block whose own text sets its direction. Code always reads left to right. */
function isTextBlock(node: ProseMirrorNode): boolean {
  return node.type.spec.group === 'blockContent' && node.inlineContent && !node.type.spec.code
}

/**
 * The text a block's direction comes from. A task block has no inline content: its
 * row renders the `title` prop, so the title is what decides.
 */
function blockText(content: ProseMirrorNode): string | null {
  if (isTextBlock(content)) return content.textContent
  if (content.type.name === 'taskBlock') {
    const title: unknown = content.attrs.title
    return typeof title === 'string' ? title : null
  }
  return null
}

export function buildBlockDirectionDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'blockContainer') {
      const text = node.firstChild ? blockText(node.firstChild) : null
      const dir = text === null ? null : firstStrongDirection(text)
      if (dir) decorations.push(Decoration.node(pos, pos + node.nodeSize, { dir }))
    } else if (isTextBlock(node)) {
      const dir = firstStrongDirection(node.textContent)
      if (dir) decorations.push(Decoration.node(pos, pos + node.nodeSize, { dir }))
    }
  })
  return DecorationSet.create(doc, decorations)
}

export function createBlockDirectionPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('blockDirection'),
    props: {
      decorations: (state) => buildBlockDirectionDecorations(state.doc)
    }
  })
}
