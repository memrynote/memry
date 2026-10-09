import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { findInlineTags, renamedTag, type TagRename } from '@memry/shared/inline-tags'
import { ORIGIN_LOCAL } from '../sync/crdt-provider'

/**
 * Renames the body `#tags` of an open note inside its live doc, so the editor
 * and its pending edits keep their place and the change merges like typing.
 * A `hashTag` chip gets its `tag` attribute set; a `#tag` still held as text
 * is rewritten in place with its marks. Code blocks and `code`-marked text are
 * left alone, as `rewriteInlineTagsInMarkdown` leaves code in a file. Returns
 * whether anything changed.
 */
export function renameTagsInDoc(doc: Y.Doc, renames: readonly TagRename[]): boolean {
  let changed = false
  const visit = (node: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement) {
        if (child.nodeName === 'codeBlock') continue
        if (child.nodeName === 'hashTag') {
          const tag = child.getAttribute('tag')
          const next = typeof tag === 'string' ? renamedTag(tag, renames) : null
          if (next !== null && next !== tag) {
            child.setAttribute('tag', next)
            changed = true
          }
          continue
        }
        visit(child)
      } else if (child instanceof Y.XmlText) {
        if (renameTagsInText(child, renames)) changed = true
      }
    }
  }
  doc.transact(() => visit(doc.getXmlFragment(CRDT_FRAGMENT_NAME)), ORIGIN_LOCAL)
  return changed
}

type TextOp = { insert?: unknown; attributes?: Record<string, unknown> }

/**
 * Reads the text's runs the way `rewriteInlineTagsInMarkdown` reads markdown:
 * the plain (non-code) runs joined into one string, so a tag split across a
 * bold and a plain run is one tag, and a `#` right after code sees what came
 * before the code. Each joined character maps back to its doc offset; a match
 * whose characters are not contiguous in the doc (code inside it) is skipped.
 */
function renameTagsInText(text: Y.XmlText, renames: readonly TagRename[]): boolean {
  let joined = ''
  const at: number[] = []
  const attrsAt: Array<Record<string, unknown>> = []
  let offset = 0
  for (const op of text.toDelta() as TextOp[]) {
    if (typeof op.insert !== 'string') {
      // An embed is not whitespace: a `#` right after it starts no tag.
      joined += '\uFFFC'
      at.push(offset)
      attrsAt.push({})
      offset += 1
      continue
    }
    if (!op.attributes?.code) {
      for (let i = 0; i < op.insert.length; i += 1) {
        at.push(offset + i)
        attrsAt.push(op.attributes ?? {})
      }
      joined += op.insert
    }
    offset += op.insert.length
  }
  const edits: Array<{ at: number; length: number; next: string; attributes: object }> = []
  for (const { index, tag } of findInlineTags(joined)) {
    const next = renamedTag(tag, renames)
    if (next === null || next === tag) continue
    const first = index + 1
    const last = first + tag.length - 1
    if (at[last] - at[first] !== tag.length - 1) continue
    edits.push({ at: at[first], length: tag.length, next, attributes: attrsAt[first] })
  }
  for (const edit of edits.reverse()) {
    text.delete(edit.at, edit.length)
    text.insert(edit.at, edit.next, edit.attributes)
  }
  return edits.length > 0
}
