import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { scanFootnotes } from '@memry/shared/footnotes'

/**
 * Footnotes stay plain text in the document (BBF-24): no node, no schema
 * change, so the file and older builds see the same bytes. This plugin only
 * decorates. A reference shows as its number until the caret enters it, and a
 * definition line reads subdued in place.
 */

export interface FootnoteDefinitionView {
  number: number | null
  text: string
}

interface DocFootnotes {
  /** Keyed by lower-cased label. */
  definitions: Map<string, FootnoteDefinitionView>
  references: Array<{ from: number; to: number; number: number; key: string }>
  definitionRanges: Array<{ from: number; to: number }>
}

export interface FootnoteHover {
  number: number
  text: string
  /** Viewport point under the marker's line, where the card opens. */
  anchor: { left: number; top: number }
}

export const FOOTNOTE_PLUGIN_KEY = new PluginKey<DocFootnotes>('footnotes')

const OBJECT_REPLACEMENT = '\uFFFC'
const DEFINITION_MARKER = /^\[\^[^\s\]]+\]:[ \t]*/

/** What an inline node reads as in the hover card: a wiki link as its label. */
function leafText(node: ProseMirrorNode): string {
  if (node.type.name === 'hardBreak') return '\n'
  const { alias, target } = node.attrs as { alias?: string; target?: string }
  return alias || target || node.textContent
}

/**
 * The document as markdown-shaped text for `scanFootnotes`, with the doc
 * position of every character. Blocks are separated by a blank line, inline
 * code is masked, and an inline node is one placeholder character.
 */
function docText(doc: ProseMirrorNode): { text: string; positions: number[] } {
  let text = ''
  const positions: number[] = []
  const append = (chunk: string, pos: number | null): void => {
    text += chunk
    for (let i = 0; i < chunk.length; i++) positions.push(pos === null ? -1 : pos + i)
  }

  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (text) append('\n\n', null)
    if (node.type.spec.code) return false
    node.forEach((child, offset) => {
      const at = pos + 1 + offset
      if (child.isText) {
        const value = child.text ?? ''
        const code = child.marks.some((mark) => mark.type.name === 'code')
        append(code ? ' '.repeat(value.length) : value, at)
      } else {
        append(child.type.name === 'hardBreak' ? '\n' : OBJECT_REPLACEMENT, at)
      }
    })
    return false
  })
  return { text, positions }
}

function collect(doc: ProseMirrorNode): DocFootnotes {
  const { text, positions } = docText(doc)
  const { references, definitions } = scanFootnotes(text)
  const range = (start: number, end: number) => ({
    from: positions[start],
    to: positions[end - 1] + 1
  })

  const byLabel = new Map<string, FootnoteDefinitionView>()
  for (const definition of definitions) {
    const key = definition.label.toLowerCase()
    if (byLabel.has(key)) continue
    const marker = DEFINITION_MARKER.exec(text.slice(definition.start))?.[0].length ?? 0
    const { from, to } = range(definition.start + marker, definition.end)
    byLabel.set(key, {
      number: definition.number,
      text: from < to ? doc.textBetween(from, to, '\n', leafText) : ''
    })
  }
  return {
    definitions: byLabel,
    references: references.map((ref) => ({
      ...range(ref.start, ref.end),
      number: ref.number,
      key: ref.label.toLowerCase()
    })),
    definitionRanges: definitions.map((definition) => range(definition.start, definition.end))
  }
}

export function createFootnotePlugin(onHover?: (hover: FootnoteHover | null) => void): Plugin {
  return new Plugin<DocFootnotes>({
    key: FOOTNOTE_PLUGIN_KEY,
    state: {
      init: (_config, state) => collect(state.doc),
      apply: (tr, value, _old, state) => (tr.docChanged ? collect(state.doc) : value)
    },
    props: {
      decorations(state) {
        const footnotes = FOOTNOTE_PLUGIN_KEY.getState(state)
        if (!footnotes) return null
        const { from: caretFrom, to: caretTo } = state.selection
        const decorations = [
          ...footnotes.definitionRanges.map(({ from, to }) =>
            Decoration.inline(from, to, { class: 'footnote-def' })
          ),
          ...footnotes.references.map(({ from, to, number, key }) => {
            const editing = caretFrom <= to && caretTo >= from
            return Decoration.inline(from, to, {
              class: editing ? 'footnote-ref footnote-ref-editing' : 'footnote-ref',
              'data-footnote-number': String(number),
              'data-footnote-label': key
            })
          })
        ]
        return DecorationSet.create(state.doc, decorations)
      },
      handleDOMEvents: {
        mouseover(view, event) {
          const target = (event.target as HTMLElement | null)?.closest?.<HTMLElement>(
            '.footnote-ref:not(.footnote-ref-editing)'
          )
          const key = target?.dataset.footnoteLabel
          const definition = key
            ? FOOTNOTE_PLUGIN_KEY.getState(view.state)?.definitions.get(key)
            : undefined
          if (target && definition?.number) {
            // The marker's own box is zero-height (its text is font-size 0),
            // so the card opens under the line the text before it sits on.
            const line = view.coordsAtPos(view.posAtDOM(target, 0), -1)
            onHover?.({
              number: definition.number,
              text: definition.text,
              anchor: { left: target.getBoundingClientRect().left, top: line.bottom }
            })
          }
          return false
        },
        mousedown() {
          onHover?.(null)
          return false
        },
        mouseout(_view, event) {
          if ((event.target as HTMLElement | null)?.closest?.('.footnote-ref')) onHover?.(null)
          return false
        }
      }
    }
  })
}
